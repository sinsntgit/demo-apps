"""Predictive analysis on query results: forecasting, classification / regression, key drivers,
segmentation, anomaly detection.

How it works
- The AI model never writes analysis code and never sees data. It only names a method and the
  columns to use (`spec`); everything here runs on the server on the rows the SQL returned.
- Each method is a Python script *template* kept in this file. `run()` fills in the column
  names and settings (always through `repr()`, after checking them against the real result
  columns), executes that script, and returns the exact script alongside the outputs - so the
  "code" shown to the user is the code that ran, feature engineering included.
- Nothing user- or model-written is ever interpolated into a script unvalidated.
"""
import math
import re
import warnings

TYPES = ("forecast", "classification", "regression", "drivers", "clustering", "anomaly")
LABEL = {"forecast": "Forecast", "classification": "Classification", "regression": "Prediction",
         "drivers": "Key drivers", "clustering": "Segmentation", "anomaly": "Anomaly detection"}
MAX_TRAIN_ROWS = 20_000        # models are fitted on at most this many rows (random sample)
MAX_TABLE_ROWS = 2_000         # rows of any output table kept / shown


class AnalysisError(Exception):
    """A problem the user can act on (too little data, unsuitable columns...)."""


# =============================================================================================
#  Script templates. __NAME__ tokens are replaced with repr(value).
# =============================================================================================
_SERIES_PREP = '''
# 1. Prepare the series ------------------------------------------------------------------
s = df[[DATE, TARGET]].copy()
s[DATE] = pd.to_datetime(s[DATE].astype(str), errors="coerce")       # '2025-03', dates and timestamps all parse
s[TARGET] = pd.to_numeric(s[TARGET], errors="coerce")
s = s.dropna(subset=[DATE]).groupby(DATE)[TARGET].sum().sort_index()  # one value per date

# 2. Feature engineering: put the series on a regular time grid ---------------------------
gap = s.index.to_series().diff().dt.days.median()                    # typical days between points
if gap <= 1.5:   FREQ, SEASON = "D", 7                               # daily data, weekly pattern
elif gap <= 8:   FREQ, SEASON = "W-" + s.index[0].strftime("%a").upper(), 52
elif gap <= 35:  FREQ, SEASON = "MS", 12                             # monthly data, yearly pattern
elif gap <= 100: FREQ, SEASON = "QS", 4
else:            FREQ, SEASON = "YS", 1
y = s.resample(FREQ).sum(min_count=1)
missing = int(y.isna().sum())                                        # periods with no data at all
y = y.interpolate(limit_direction="both")                            # fill gaps by straight line
'''

FORECAST = '''import numpy as np
import pandas as pd
from statsmodels.tsa.holtwinters import ExponentialSmoothing

# df = the rows returned by the SQL query above
DATE, TARGET, HORIZON = __DATE__, __TARGET__, __HORIZON__
''' + _SERIES_PREP + '''
# 3. Three candidate methods, from richest to simplest ------------------------------------
future = lambda steps, start: pd.date_range(start, periods=steps + 1, freq=FREQ)[1:]

def holt_winters(train, steps):          # level + damped trend + repeating seasonal pattern
    seasonal = SEASON > 1 and len(train) >= 2 * SEASON               # needs two full cycles to learn a season
    fit = ExponentialSmoothing(
        train, trend="add", damped_trend=len(train) >= 10,
        seasonal=("mul" if (train > 0).all() else "add") if seasonal else None,
        seasonal_periods=SEASON if seasonal else None, initialization_method="estimated").fit()
    return fit.forecast(steps), fit.fittedvalues

def smoothed_level(train, steps):        # recent average level, no trend
    fit = ExponentialSmoothing(train, initialization_method="estimated").fit()
    return fit.forecast(steps), fit.fittedvalues

def naive(train, steps):                 # same period last cycle (given two full cycles), else the last value
    lag = SEASON if SEASON > 1 and len(train) >= 2 * SEASON else 1
    values = [train.iloc[-lag + (i % lag)] for i in range(steps)]
    return pd.Series(values, index=future(steps, train.index[-1])), train.shift(lag)

MODELS = {"Holt-Winters (trend + seasonality)": holt_winters, "Exponential smoothing (level only)": smoothed_level,
          "Naive (repeat the last value / cycle)": naive}

# 4. Back-test: hide the most recent periods, forecast them with each method, compare -----
TEST = max(1, min(HORIZON, len(y) // 5))
train, test = y[:-TEST], y[-TEST:]
errors, backtests = {}, {}
for name, method in MODELS.items():
    backtests[name] = method(train, TEST)[0]
    errors[name] = float(np.abs(test.values - backtests[name].values).mean())      # mean absolute error
best = min(errors, key=errors.get)                                   # keep whichever was closest
backtest, mae, naive_mae = backtests[best], errors[best], errors["Naive (repeat the last value / cycle)"]
nonzero = test.values != 0
mape = float((np.abs(test.values - backtest.values)[nonzero] / np.abs(test.values[nonzero])).mean()) if nonzero.any() else None

# 5. Forecast with the winning method on all history, with an approximate 95% range --------
forecast, fitted = MODELS[best](y, HORIZON)
sigma = float((y - fitted).std())                                    # typical one-step error
if not np.isfinite(sigma):
    sigma = float(y.diff().std())
spread = 1.96 * sigma * np.sqrt(np.arange(1, HORIZON + 1))           # widens the further ahead we look
lower, upper = forecast - spread, forecast + spread
if (y >= 0).all():                                                   # a quantity that is never negative
    forecast, lower = forecast.clip(lower=0), lower.clip(lower=0)
'''

ANOMALY_SERIES = '''import numpy as np
import pandas as pd

# df = the rows returned by the SQL query above
DATE, TARGET, THRESHOLD = __DATE__, __TARGET__, 3.5
''' + _SERIES_PREP + '''
# 3. Expected level: rolling median (robust to the very outliers we are looking for) ------
window = min(max(5, SEASON if SEASON <= 12 else 9), max(3, len(y) // 2)) | 1   # odd-length window
expected = y.rolling(window, center=True, min_periods=2).median()
residual = y - expected

# 4. Robust z-score: distance from expected in units of typical deviation (MAD) -----------
mad = float((residual - residual.median()).abs().median())
if mad == 0:
    mad = float(residual.abs().mean()) or 1.0
score = 0.6745 * (residual - residual.median()) / mad
flagged = score.abs() > THRESHOLD
'''

_FEATURES = '''
# 1. Feature engineering -------------------------------------------------------------------
X = df[NUMERIC + CATEGORICAL + DATES].copy()
for c in NUMERIC:
    X[c] = pd.to_numeric(X[c], errors="coerce")
for c in CATEGORICAL:
    X[c] = X[c].astype(str).where(X[c].notna(), "(blank)")           # text / category columns
for c in DATES:                                                      # dates become year, month, weekday
    d = pd.to_datetime(X.pop(c).astype(str), errors="coerce")
    X[c + "_year"], X[c + "_month"], X[c + "_weekday"] = d.dt.year, d.dt.month, d.dt.dayofweek
numeric = [c for c in X.columns if c not in CATEGORICAL]

prepare = ColumnTransformer([
    ("numbers", make_pipeline(SimpleImputer(strategy="median"), StandardScaler()), numeric),   # fill gaps, same scale
    ("categories", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=0.01,     # one column per value;
                                 max_categories=20), CATEGORICAL),                            # rare values grouped
], sparse_threshold=0)
'''

CLASSIFY = '''import numpy as np
import pandas as pd
from sklearn import metrics
from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

# df = the rows returned by the SQL query above
TARGET, POSITIVE = __TARGET__, __POSITIVE__
NUMERIC, CATEGORICAL, DATES = __NUMERIC__, __CATEGORICAL__, __DATES__
''' + _FEATURES + '''
# 2. Rows with a known outcome are used to learn; rows without one are scored at the end ---
known = df[TARGET].notna().values
y = df.loc[known, TARGET].astype(str)
counts = y.value_counts()
keep = y.isin(counts[counts >= 2].index).values                      # an outcome seen once cannot be tested
Xk, y = X[known][keep], y[keep]
if len(Xk) > __MAX_ROWS__:                                           # large data: learn from a random sample
    Xk = Xk.sample(__MAX_ROWS__, random_state=0); y = y.loc[Xk.index]
classes = np.unique(y)
FOLDS = int(min(5, y.value_counts().min()))

# 3. Two candidate models, each judged on rows it has NOT seen (cross-validation) ----------
candidates = {
    "Logistic regression": make_pipeline(clone(prepare), LogisticRegression(max_iter=1000, class_weight="balanced")),
    "Random forest": make_pipeline(clone(prepare), RandomForestClassifier(
        n_estimators=200, min_samples_leaf=3, class_weight="balanced", random_state=0, n_jobs=-1)),
}
cv = StratifiedKFold(n_splits=FOLDS, shuffle=True, random_state=0)
proba, scores = {}, {}
for name, model in candidates.items():
    proba[name] = cross_val_predict(model, Xk, y, cv=cv, method="predict_proba")
    scores[name] = metrics.balanced_accuracy_score(y, classes[proba[name].argmax(axis=1)])
best = max(scores, key=scores.get)                                   # keep the better one
predicted = classes[proba[best].argmax(axis=1)]

# 4. How good is it? ------------------------------------------------------------------------
accuracy = metrics.accuracy_score(y, predicted)
baseline = float(y.value_counts(normalize=True).max())               # always guessing the commonest outcome
report = metrics.classification_report(y, predicted, output_dict=True, zero_division=0)
confusion = metrics.confusion_matrix(y, predicted, labels=classes)
auc = None
if len(classes) == 2:
    auc = metrics.roc_auc_score((y == classes[1]).astype(int), proba[best][:, 1])

# 5. Which columns matter? Shuffle one column at a time on held-back rows and see how much
#    the score drops (permutation importance) ------------------------------------------------
X_tr, X_te, y_tr, y_te = train_test_split(Xk, y, test_size=0.25, random_state=0, stratify=y)
importance = permutation_importance(clone(candidates[best]).fit(X_tr, y_tr), X_te, y_te,
                                    n_repeats=5, random_state=0, scoring="balanced_accuracy")
direction = {}
if POSITIVE is not None:                                             # does more of X go with the outcome?
    hit = (y == POSITIVE).astype(float)
    for c in numeric:
        if Xk[c].nunique() > 1:
            direction[c] = float(Xk[c].corr(hit, method="spearman"))

# 6. Final model on all known rows; score every row, including those with no outcome yet ----
final = clone(candidates[best]).fit(Xk, y)
all_proba = final.predict_proba(X)
all_pred = final.classes_[all_proba.argmax(axis=1)]
'''

REGRESS = '''import numpy as np
import pandas as pd
from sklearn import metrics
from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import Ridge
from sklearn.model_selection import KFold, cross_val_predict, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

# df = the rows returned by the SQL query above
TARGET = __TARGET__
NUMERIC, CATEGORICAL, DATES = __NUMERIC__, __CATEGORICAL__, __DATES__
''' + _FEATURES + '''
# 2. Rows with a known value are used to learn; rows without one are scored at the end -----
target = pd.to_numeric(df[TARGET], errors="coerce")
known = target.notna().values
Xk, y = X[known], target[known]
if len(Xk) > __MAX_ROWS__:                                           # large data: learn from a random sample
    Xk = Xk.sample(__MAX_ROWS__, random_state=0); y = y.loc[Xk.index]

# 3. Two candidate models, each judged on rows it has NOT seen (cross-validation) ----------
candidates = {
    "Linear regression (ridge)": make_pipeline(clone(prepare), Ridge(alpha=1.0)),
    "Random forest": make_pipeline(clone(prepare), RandomForestRegressor(
        n_estimators=200, min_samples_leaf=3, random_state=0, n_jobs=-1)),
}
cv = KFold(n_splits=min(5, len(Xk)), shuffle=True, random_state=0)
oof, scores = {}, {}
for name, model in candidates.items():
    oof[name] = cross_val_predict(model, Xk, y, cv=cv)
    scores[name] = metrics.r2_score(y, oof[name])
best = max(scores, key=scores.get)                                   # keep the better one
predicted = oof[best]

# 4. How good is it? ------------------------------------------------------------------------
r2 = metrics.r2_score(y, predicted)
mae = metrics.mean_absolute_error(y, predicted)
rmse = float(np.sqrt(metrics.mean_squared_error(y, predicted)))
baseline_mae = float((y - y.mean()).abs().mean())                    # always guessing the average

# 5. Which columns matter? Shuffle one column at a time on held-back rows and see how much
#    the score drops (permutation importance) ------------------------------------------------
X_tr, X_te, y_tr, y_te = train_test_split(Xk, y, test_size=0.25, random_state=0)
importance = permutation_importance(clone(candidates[best]).fit(X_tr, y_tr), X_te, y_te,
                                    n_repeats=5, random_state=0, scoring="r2")
direction = {c: float(Xk[c].corr(y, method="spearman")) for c in numeric if Xk[c].nunique() > 1}

# 6. Final model on all known rows; score every row, including those with no value yet -----
final = clone(candidates[best]).fit(Xk, y)
all_pred = final.predict(X)
'''

CLUSTER = '''import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.compose import ColumnTransformer
from sklearn.decomposition import PCA
from sklearn.impute import SimpleImputer
from sklearn.metrics import silhouette_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

# df = the rows returned by the SQL query above
K = __K__                                                            # None = choose automatically
NUMERIC, CATEGORICAL, DATES = __NUMERIC__, __CATEGORICAL__, __DATES__
''' + _FEATURES + '''
Z = prepare.fit_transform(X)                                         # every row as comparable numbers

# 2. How many segments? Try 2..8 and keep the split whose groups are most distinct ----------
sample = np.random.RandomState(0).choice(len(Z), min(len(Z), 3000), replace=False)
tried = {}
if K is None:
    for k in range(2, min(8, len(Z) - 1) + 1):
        labels_k = KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(Z)
        if len(set(labels_k[sample])) > 1:
            tried[k] = float(silhouette_score(Z[sample], labels_k[sample]))
    K = max(tried, key=tried.get)

# 3. K-means clustering ----------------------------------------------------------------------
raw = KMeans(n_clusters=K, n_init=10, random_state=0).fit_predict(Z)
order = pd.Series(raw).value_counts().index                          # number segments from largest to smallest
segment = pd.Series(raw).map({old: new + 1 for new, old in enumerate(order)}).values
silhouette = float(silhouette_score(Z[sample], segment[sample])) if len(set(segment[sample])) > 1 else 0.0

# 4. Describe each segment: averages of the numeric columns, commonest value of the others --
profile = X[numeric].groupby(segment).mean()
overall = X[numeric].mean()
spread = X[numeric].std().replace(0, 1)
distinct = (profile - overall) / spread                              # how far each segment sits from the average
top_category = {c: X[c].groupby(segment).agg(lambda v: v.value_counts().index[0]) for c in CATEGORICAL}

# 5. A 2-D picture of the segments (principal components) -----------------------------------
xy = PCA(n_components=2, random_state=0).fit_transform(Z) if Z.shape[1] >= 2 else np.c_[Z[:, 0], np.zeros(len(Z))]
'''

ANOMALY_ROWS = '''import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

# df = the rows returned by the SQL query above
NUMERIC, CATEGORICAL, DATES = __NUMERIC__, __CATEGORICAL__, __DATES__
''' + _FEATURES + '''
Z = prepare.fit_transform(X)                                         # every row as comparable numbers

# 2. Isolation forest: rows that are easy to separate from the rest are unusual -------------
forest = IsolationForest(n_estimators=200, random_state=0).fit(Z)
score = -forest.score_samples(Z)                                     # higher = more unusual
q1, q3 = np.quantile(score, [0.25, 0.75])
cut = q3 + 3 * (q3 - q1)                                             # "far outlier" rule on the scores
cut = max(cut, np.quantile(score, 0.95))                             # ...and never flag more than 5% of rows
flagged = score > cut

# 3. For each row, which numeric column is furthest from normal? ----------------------------
z = (X[numeric] - X[numeric].mean()) / X[numeric].std().replace(0, 1)
most_unusual = z.abs().idxmax(axis=1) if numeric else pd.Series("", index=X.index)
'''


# =============================================================================================
#  Helpers
# =============================================================================================
def _script(template: str, **values) -> str:
    code = template
    for key, value in values.items():
        code = code.replace(f"__{key}__", repr(value))
    left = re.findall(r"__[A-Z_]+__", code)
    assert not left, f"unfilled template tokens: {left}"
    return code.strip() + "\n"


def _execute(code: str, df) -> dict:
    """Run a filled-in template. The namespace holds only the data frame."""
    scope = {"df": df}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        exec(compile(code, "<analysis>", "exec"), scope)      # noqa: S102 - our own template, repr()-filled
    return scope


def _num(v, digits=4):
    if v is None:
        return None
    v = float(v)
    if math.isnan(v) or math.isinf(v):
        return None
    return round(v, digits) if abs(v) < 1e6 else round(v, 2)


def _fmt(v) -> str:
    if v is None:
        return "n/a"
    a = abs(v)
    if a >= 1e9:
        return f"{v / 1e9:,.2f}B"
    if a >= 1e6:
        return f"{v / 1e6:,.2f}M"
    if a >= 1e4:
        return f"{v / 1e3:,.1f}K"
    return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}" if a >= 1 else f"{v:.3g}"


def _pct(v) -> str:
    return "n/a" if v is None else f"{v:.0%}"


def _table(key, title, names, rows, numeric=()):
    return {"key": key, "title": title,
            "columns": [{"name": n, "type": "number" if n in numeric else "string",
                         "role": "measure" if n in numeric else "dimension", "additive": False} for n in names],
            "rows": [list(r) for r in rows[:MAX_TABLE_ROWS]], "row_count": len(rows)}


def _period(ts, freq: str) -> str:
    if freq.startswith(("MS", "QS")):
        return ts.strftime("%Y-%m")
    if freq.startswith("YS"):
        return ts.strftime("%Y")
    return ts.strftime("%Y-%m-%d")


def _unit(freq: str) -> str:
    return {"D": "day", "W": "week", "M": "month", "Q": "quarter", "Y": "year"}[freq[0]]


_ID_HINT = re.compile(r"(?:^|[_\s.])(id|ids|key|uuid|guid|code|no|nr|number|sku|email|phone|name)$", re.I)
_POSITIVE = ("1", "true", "yes", "y", "churned", "won", "converted", "returned", "cancelled", "default", "fraud")


def _split_features(columns, rows, wanted, exclude):
    """Sort usable columns into numeric / categorical / date features; say why others were left out."""
    idx = {c["name"]: i for i, c in enumerate(columns)}
    n = len(rows)
    numeric, categorical, dates, dropped = [], [], [], []
    pool = [c for c in columns if c["name"] not in exclude and (not wanted or c["name"] in wanted)]
    for c in pool:
        name = c["name"]
        vals = [r[idx[name]] for r in rows if r[idx[name]] is not None]
        distinct = len(set(map(str, vals)))
        blanks = len(vals) < n                          # "is it filled in at all" can itself be informative
        if c.get("masked"):
            dropped.append((name, "masked by policy"))
        elif not vals or distinct + blanks <= 1:
            dropped.append((name, "same value in every row"))
        elif c["type"] == "date":
            dates.append(name)
        elif c["type"] == "number" and c.get("role", "measure") == "measure" and distinct > 1:
            numeric.append(name)
        elif c["type"] == "number" and distinct <= 1:   # one value or blank: keep it as present / blank
            categorical.append(name)
        elif c["type"] == "number":                     # numeric identifier / code / period
            if distinct > max(20, 0.5 * n) or _ID_HINT.search(name):
                dropped.append((name, "identifier"))
            else:
                categorical.append(name)
        elif distinct > 50 or distinct > 0.5 * n or _ID_HINT.search(name):
            dropped.append((name, "identifier or free text (too many distinct values)"))
        else:
            categorical.append(name)
    return numeric, categorical, dates, dropped


def _features_note(numeric, categorical, dates, dropped) -> list[str]:
    used = numeric + categorical + dates
    out = [f"Inputs used ({len(used)}): {', '.join(used)}."]
    if dates:
        out.append(f"Dates ({', '.join(dates)}) were turned into year, month and weekday.")
    if dropped:
        out.append("Left out: " + "; ".join(f"{n} ({why})" for n, why in dropped) + ".")
    return out


def _col(columns, name, kind=None):
    for c in columns:
        if c["name"] == name:
            return c
    lowered = {c["name"].lower(): c for c in columns}
    if name and str(name).lower() in lowered:
        return lowered[str(name).lower()]
    raise AnalysisError(f"The query result has no column called '{name}'"
                        + (f" to use as the {kind}." if kind else ".") + " Columns: "
                        + ", ".join(c["name"] for c in columns) + ".")


def _frame(columns, rows):
    import pandas as pd
    return pd.DataFrame(rows, columns=[c["name"] for c in columns])


# =============================================================================================
#  Methods
# =============================================================================================
def _forecast(spec, columns, rows):
    import pandas as pd
    dates = [c["name"] for c in columns if c["type"] == "date"]
    measures = [c["name"] for c in columns if c["type"] == "number" and c.get("role", "measure") == "measure"]
    date = _col(columns, spec.get("date") or (dates[0] if dates else columns[0]["name"]), "time column")["name"]
    target = _col(columns, spec.get("target") or next((m for m in measures if m != date), None), "measure to forecast")["name"]
    horizon = int(min(max(int(spec.get("horizon") or 0) or 0, 0), 120))
    df = _frame(columns, rows)
    parsed = pd.to_datetime(df[date].astype(str), errors="coerce")
    if parsed.notna().sum() < 6 or parsed.nunique() < 6:
        raise AnalysisError(f"A forecast needs at least 6 time periods; '{date}' has {parsed.nunique()} usable dates. "
                            "Ask for the measure by month, week or day over a longer history.")
    if not horizon:
        horizon = max(3, min(12, parsed.nunique() // 3))
    code = _script(FORECAST, DATE=date, TARGET=target, HORIZON=horizon)
    o = _execute(code, df)
    y, fc, lo, up, freq = o["y"], o["forecast"], o["lower"], o["upper"], o["FREQ"]
    unit, name = _unit(freq), target.replace("_", " ")
    labels = [_period(t, freq) for t in list(y.index) + list(fc.index)]
    pad = [None] * (len(y) - 1)
    plots = [{"title": f"{name.capitalize()} — history and forecast", "kind": "line", "labels": labels,
              "x_title": date, "y_title": target, "datasets": [
                  {"label": "Actual", "role": "actual", "data": [_num(v) for v in y] + [None] * horizon},
                  {"label": "Forecast", "role": "forecast", "data": pad + [_num(y.iloc[-1])] + [_num(v) for v in fc]},
                  {"label": "Likely range (95%)", "role": "upper", "data": pad + [_num(y.iloc[-1])] + [_num(v) for v in up]},
                  {"label": "Likely range (low)", "role": "lower", "data": pad + [_num(y.iloc[-1])] + [_num(v) for v in lo]}]}]
    total, last = float(fc.sum()), float(y.iloc[-len(fc):].sum()) if len(y) >= len(fc) else None
    mape, mae, naive, best = o["mape"], o["mae"], o["naive_mae"], o["best"]
    seasonal = best.startswith("Holt") and o["SEASON"] > 1 and len(y) >= 2 * o["SEASON"]
    is_naive = best.startswith("Naive")
    narrative = [
        f"Forecast of {name} for the next {horizon} {unit}s ({labels[len(y)]} to {labels[-1]}): "
        f"{_fmt(total)} in total, {_fmt(total / horizon)} per {unit} on average.",
        (f"That is {'up' if total >= last else 'down'} {abs(total - last) / abs(last):.0%} on the previous {horizon} {unit}s ({_fmt(last)})."
         if last else f"History covers {len(y)} {unit}s."),
        f"Method: {best}. Three methods were tried on hidden history and the closest was kept."
        + (f" It uses a repeating {o['SEASON']}-{unit} seasonal pattern." if seasonal else ""),
        f"Accuracy check: the last {o['TEST']} {unit}s were hidden and re-forecast. Average error was {_fmt(mae)}"
        + (f" ({_pct(mape)} of the actual value)" if mape is not None else "")
        + (". The simple “repeat the last value” guess matched or beat the statistical models, which means this series has no "
           "trend or pattern they could use — treat the forecast as a rough guide only." if is_naive else
           f", versus {_fmt(naive)} for a naive guess — "
           + ("clearly better than the naive guess." if mae < 0.9 * naive else
              "about the same as a naive guess, so treat the forecast as a rough guide.")),
        "The shaded range is where the value is expected to fall about 95% of the time; it widens the further ahead it looks.",
    ]
    warn = []
    if o["missing"]:
        warn.append(f"{o['missing']} {unit}s had no data and were filled in by straight-line interpolation.")
    if len(y) >= 3 and y.iloc[-2] and y.iloc[-1] < 0.6 * y.iloc[-2]:
        warn.append(f"The latest {unit} ({labels[len(y) - 1]}) is far below the one before. If it is incomplete, "
                    "exclude it in the question (e.g. “up to last month”) — an unfinished period drags the forecast down.")
    if len(y) < 2 * o["SEASON"] and o["SEASON"] > 1:
        warn.append(f"Only {len(y)} {unit}s of history: seasonality cannot be learned until there are {2 * o['SEASON']}.")
    table = _table("forecast", "Forecast values", [date, f"forecast_{target}", "low", "high"],
                   [[labels[len(y) + i], _num(fc.iloc[i], 2), _num(lo.iloc[i], 2), _num(up.iloc[i], 2)] for i in range(horizon)],
                   numeric=(f"forecast_{target}", "low", "high"))
    bt = _table("backtest", f"Accuracy check — the last {o['TEST']} {unit}s, forecast without seeing them",
                [date, "actual", "forecast", "error"],
                [[_period(t, freq), _num(a, 2), _num(p, 2), _num(p - a, 2)] for t, a, p in zip(o["test"].index, o["test"], o["backtest"])],
                numeric=("actual", "forecast", "error"))
    stats = [bt, _table("models", "Methods compared (average error on the hidden periods — lower is better)",
                        ["method", "error", "chosen"], [[m, _num(e, 2), "✓" if m == best else ""] for m, e in o["errors"].items()],
                        numeric=("error",))]
    metrics = [{"label": f"Next {horizon} {unit}s", "value": _fmt(total), "hint": "forecast total"},
               {"label": "Typical error", "value": _pct(mape) if mape is not None else _fmt(mae), "hint": f"on the last {o['TEST']} {unit}s (back-test)"},
               {"label": "vs naive guess", "value": f"{mae / naive:.2f}×" if naive else "n/a", "hint": "below 1 = better than naive"},
               {"label": "History used", "value": f"{len(y)} {unit}s", "hint": f"{labels[0]} to {labels[len(y) - 1]}"}]
    return {"method": best, "narrative": narrative, "metrics": metrics, "plots": plots,
            "tables": [table], "stats": stats, "warnings": warn, "code": code, "params": {"horizon": horizon}}


def _target_kind(col, values) -> str:
    present = [v for v in values if v is not None]
    distinct = len(set(map(str, present)))
    if col["type"] == "number" and col.get("role", "measure") == "measure" and distinct > 10:
        return "regression"
    return "classification"


def _predict(spec, columns, rows, focus):
    idx = {c["name"]: i for i, c in enumerate(columns)}
    target = _col(columns, spec.get("target"), "outcome to predict")
    tname = target["name"]
    values = [r[idx[tname]] for r in rows]
    kind = spec.get("type") if spec.get("type") in ("classification", "regression") else _target_kind(target, values)
    if kind == "regression" and target["type"] != "number":
        kind = "classification"
    wanted = {_col(columns, f)["name"] for f in spec.get("features") or []}
    ident = spec.get("id") and _col(columns, spec["id"])["name"]
    numeric, categorical, dates, dropped = _split_features(columns, rows, wanted, {tname, ident})
    if not (numeric or categorical or dates):
        raise AnalysisError("None of the columns in the result can be used as an input. Ask for the outcome together "
                            "with the attributes that might explain it, one row per item.")
    known = [v for v in values if v is not None]
    if len(known) < 30:
        raise AnalysisError(f"Only {len(known)} rows have a value for '{tname}'; at least 30 are needed to learn from.")
    df = _frame(columns, rows)
    label = tname.replace("_", " ")
    note = _features_note(numeric, categorical, dates, dropped)

    if kind == "classification":
        classes = sorted(set(map(str, known)))
        if len(classes) < 2:
            raise AnalysisError(f"'{tname}' has the same value in every row, so there is nothing to predict.")
        if len(classes) > 20:
            raise AnalysisError(f"'{tname}' has {len(classes)} different values — too many to treat as categories. "
                                "Choose an outcome with a handful of values, or a numeric one.")
        positive = None
        if len(classes) == 2:
            positive = next((c for c in classes if c.lower() in _POSITIVE), None) or \
                min(classes, key=lambda c: sum(str(v) == c for v in known))
        code = _script(CLASSIFY, TARGET=tname, POSITIVE=positive, NUMERIC=numeric, CATEGORICAL=categorical,
                       DATES=dates, MAX_ROWS=MAX_TRAIN_ROWS)
        o = _execute(code, df)
        cls, best, acc, base = list(o["classes"]), o["best"], float(o["accuracy"]), o["baseline"]
        bal = o["scores"][best]
        metrics = [{"label": "Accuracy", "value": _pct(acc), "hint": "on rows the model had not seen"},
                   {"label": "Baseline", "value": _pct(base), "hint": "always guessing the commonest outcome"},
                   {"label": "Balanced accuracy", "value": _pct(bal), "hint": "average across outcomes; 50% = coin-toss for two"}]
        if o["auc"] is not None:
            metrics.append({"label": "ROC AUC", "value": f"{o['auc']:.2f}", "hint": "0.5 = no skill, 1.0 = perfect ranking"})
        quality = ("The model is no better than always guessing the commonest outcome — these inputs do not predict it."
                   if bal < 1 / len(cls) + 0.05 else
                   "It is only slightly better than chance, so use the predictions with caution." if bal < 1 / len(cls) + 0.15 else
                   "It predicts meaningfully better than chance.")
        narrative = [f"Predicting {label} ({', '.join(cls[:6])}{'…' if len(cls) > 6 else ''}) from {len(numeric + categorical + dates)} inputs, "
                     f"learned from {len(o['y']):,} rows with a known outcome.",
                     f"Best model: {best}. It gets {_pct(acc)} right on rows it had not seen, against {_pct(base)} for always "
                     f"guessing the commonest outcome. {quality}"]
        report = o["report"]
        per_class = _table("classes", "Quality by outcome", ["outcome", "precision", "recall", "f1", "rows"],
                           [[c, _num(report[c]["precision"], 3), _num(report[c]["recall"], 3), _num(report[c]["f1-score"], 3),
                             int(report[c]["support"])] for c in cls], numeric=("precision", "recall", "f1", "rows"))
        conf = _table("confusion", "Confusion matrix — rows: actual, columns: predicted", ["actual"] + [f"predicted {c}" for c in cls],
                      [[c] + [int(v) for v in o["confusion"][i]] for i, c in enumerate(cls)], numeric=[f"predicted {c}" for c in cls])
        compare = _table("models", "Models compared (balanced accuracy on unseen rows)", ["model", "score", "chosen"],
                         [[m, _num(s, 3), "✓" if m == best else ""] for m, s in o["scores"].items()], numeric=("score",))
        pred_cols = ([ident] if ident else []) + [tname, f"predicted_{tname}", "confidence"]
        allp, allpred = o["all_proba"], o["all_pred"]
        order = sorted(range(len(rows)), key=lambda i: (values[i] is not None, -float(allp[i].max())))
        pred_rows = [([rows[i][idx[ident]]] if ident else []) + [values[i], str(allpred[i]), _num(allp[i].max(), 3)] for i in order]
        unknown = sum(v is None for v in values)
        if unknown:
            narrative.append(f"{unknown:,} rows have no {label} yet; their predictions are listed first in the table.")
        tables = [_table("predictions", "Predictions per row", pred_cols, pred_rows, numeric=("confidence",))]
        stats = [per_class, conf, compare]
        score_name = "balanced accuracy"
    else:
        code = _script(REGRESS, TARGET=tname, NUMERIC=numeric, CATEGORICAL=categorical, DATES=dates, MAX_ROWS=MAX_TRAIN_ROWS)
        o = _execute(code, df)
        best, r2, mae, base = o["best"], float(o["r2"]), float(o["mae"]), o["baseline_mae"]
        metrics = [{"label": "R²", "value": f"{r2:.2f}", "hint": "share of the variation explained; 1.0 = perfect"},
                   {"label": "Typical error (MAE)", "value": _fmt(mae), "hint": "on rows the model had not seen"},
                   {"label": "Baseline error", "value": _fmt(base), "hint": "always guessing the average"},
                   {"label": "RMSE", "value": _fmt(o["rmse"]), "hint": "penalises large misses more"}]
        quality = ("These inputs explain almost none of the variation — predictions will be close to the average." if r2 < 0.1 else
                   "These inputs explain some of the variation; expect sizeable errors on individual rows." if r2 < 0.5 else
                   "These inputs explain most of the variation.")
        narrative = [f"Predicting {label} from {len(numeric + categorical + dates)} inputs, learned from {len(o['y']):,} rows.",
                     f"Best model: {best}. On rows it had not seen, the typical error is {_fmt(mae)} against {_fmt(base)} for "
                     f"always guessing the average (R² = {r2:.2f}). {quality}"]
        compare = _table("models", "Models compared (R² on unseen rows)", ["model", "score", "chosen"],
                         [[m, _num(s, 3), "✓" if m == best else ""] for m, s in o["scores"].items()], numeric=("score",))
        allpred = o["all_pred"]
        pred_cols = ([ident] if ident else []) + [tname, f"predicted_{tname}", "difference"]
        order = sorted(range(len(rows)), key=lambda i: values[i] is not None)
        pred_rows = [([rows[i][idx[ident]]] if ident else []) + [values[i], _num(allpred[i], 2),
                     _num(allpred[i] - float(values[i]), 2) if values[i] is not None else None] for i in order]
        tables = [_table("predictions", "Predictions per row", pred_cols, pred_rows, numeric=(tname, f"predicted_{tname}", "difference"))]
        stats = [compare]
        score_name = "R²"
        yk, pk = list(o["y"]), list(o["predicted"])
        step = max(1, len(yk) // 800)

    imp = o["importance"]
    feats = list(o["X"].columns)
    ranked = sorted(zip(feats, imp.importances_mean, imp.importances_std), key=lambda t: -t[1])
    direction = o["direction"]

    def way(f):
        d = direction.get(f)
        if d is None or abs(d) < 0.05:
            return ""
        if kind == "classification":
            return f"higher → more likely {o['POSITIVE']}" if d > 0 else f"higher → less likely {o['POSITIVE']}"
        return f"higher → higher {label}" if d > 0 else f"higher → lower {label}"
    importance = _table("importance", f"What drives {label} — drop in {score_name} when the column is shuffled",
                        ["input", "importance", "± spread", "direction"],
                        [[f, _num(m, 4), _num(s, 4), way(f)] for f, m, s in ranked], numeric=("importance", "± spread"))
    top = [f for f, m, _ in ranked if m > 0.002][:3]
    narrative.append(f"Most influential inputs: {', '.join(top)}." if top else
                     "No single input stands out: shuffling any one of them barely changes the result.")
    shown = ranked[:12]
    plots = [{"title": f"What drives {label}", "kind": "hbar", "labels": [f for f, _, _ in shown], "x_title": f"importance (drop in {score_name})",
              "y_title": "", "datasets": [{"label": "Importance", "role": "actual", "data": [_num(max(m, 0), 4) for _, m, _ in shown]}]}]
    if kind == "regression":
        lo_, hi_ = min(yk + pk), max(yk + pk)
        plots.append({"title": "Predicted vs actual (rows the model had not seen)", "kind": "scatter", "x_title": f"actual {tname}",
                      "y_title": f"predicted {tname}", "datasets": [
                          {"label": "Rows", "role": "actual", "points": [[_num(a), _num(p)] for a, p in list(zip(yk, pk))[::step]]},
                          {"label": "Perfect prediction", "role": "forecast", "points": [[_num(lo_), _num(lo_)], [_num(hi_), _num(hi_)]]}]})
    else:
        plots.append({"title": "Actual vs predicted outcome", "kind": "bar", "labels": cls, "x_title": tname, "y_title": "rows",
                      "datasets": [{"label": "Actual", "role": "actual", "data": [int(o["confusion"][i].sum()) for i in range(len(cls))]},
                                   {"label": "Predicted", "role": "forecast", "data": [int(o["confusion"][:, i].sum()) for i in range(len(cls))]}]})
    warn = []
    lead = ranked[0]
    if (kind == "classification" and bal > 0.98) or (kind == "regression" and r2 > 0.98):
        warn.append(f"The result is almost perfect, which usually means an input contains the answer (look at '{lead[0]}'). "
                    "Remove columns that are only known after the outcome and ask again.")
    if len(rows) > MAX_TRAIN_ROWS:
        warn.append(f"The model learned from a random sample of {MAX_TRAIN_ROWS:,} of the {len(rows):,} rows.")
    if focus == "drivers":
        plots, stats, tables = plots[:1], [importance] + stats, tables
        narrative.insert(0, f"Which factors explain {label}? Each input is shuffled in turn; the more the prediction suffers, the more it matters.")
    else:
        stats = stats + [importance]
    narrative += note
    narrative.append("Importance shows association, not proof of cause.")
    return {"method": f"{best} ({'classification' if kind == 'classification' else 'regression'})", "narrative": narrative,
            "metrics": metrics, "plots": plots, "tables": tables, "stats": stats, "warnings": warn, "code": code, "params": {}}


def _clustering(spec, columns, rows):
    idx = {c["name"]: i for i, c in enumerate(columns)}
    wanted = {_col(columns, f)["name"] for f in spec.get("features") or []}
    ident = spec.get("id") and _col(columns, spec["id"])["name"]
    if not ident:
        ident = next((c["name"] for c in columns if _ID_HINT.search(c["name"]) and len({r[idx[c["name"]]] for r in rows}) == len(rows)), None)
    numeric, categorical, dates, dropped = _split_features(columns, rows, wanted, {ident})
    if not (numeric or categorical or dates):
        raise AnalysisError("Segmentation needs descriptive columns (amounts, counts, categories), one row per item to group.")
    if len(rows) < 10:
        raise AnalysisError(f"Only {len(rows)} rows — segmentation needs at least 10 items to group.")
    k = spec.get("k")
    k = int(min(max(int(k), 2), min(12, len(rows) - 1))) if k else None
    code = _script(CLUSTER, K=k, NUMERIC=numeric, CATEGORICAL=categorical, DATES=dates)
    o = _execute(code, _frame(columns, rows))
    K, seg, prof, dist, sil = o["K"], o["segment"], o["profile"], o["distinct"], o["silhouette"]
    sizes = {s: int((seg == s).sum()) for s in range(1, K + 1)}
    head = "segment" if "segment" not in [c["name"] for c in columns] else "group"
    names = {}
    for s in range(1, K + 1):
        traits = []
        if len(dist.columns):
            row = dist.loc[s][[c for c in dist.columns if c in numeric] or list(dist.columns)].sort_values(key=abs, ascending=False)
            traits = [f"{'high' if v > 0 else 'low'} {c.replace('_', ' ')}" for c, v in row.items() if abs(v) >= 0.4][:2]
        if not traits and categorical:
            traits = [f"mostly {o['top_category'][categorical[0]].loc[s]}"]
        names[s] = f"Segment {s}" + (f" — {', '.join(traits)}" if traits else "")
    num_cols = list(prof.columns)
    profile = _table("profile", "Segment profiles — average of each numeric input, commonest value of the others",
                     [head, "rows", "share"] + num_cols + categorical,
                     [[names[s], sizes[s], f"{sizes[s] / len(rows):.0%}"] + [_num(prof.loc[s, c], 2) for c in num_cols]
                      + [str(o["top_category"][c].loc[s]) for c in categorical] for s in range(1, K + 1)]
                     + [["All rows", len(rows), "100%"] + [_num(o["overall"][c], 2) for c in num_cols] + [""] * len(categorical)],
                     numeric=["rows"] + num_cols)
    xy = o["xy"]
    step = max(1, len(rows) // 1500)
    plots = [{"title": "Segments on a 2-D map (similar items sit close together)", "kind": "scatter", "x_title": "component 1",
              "y_title": "component 2", "datasets": [{"label": names[s], "role": "actual", "points": [
                  [_num(xy[i, 0], 3), _num(xy[i, 1], 3)] for i in range(0, len(rows), step) if seg[i] == s]} for s in range(1, K + 1)]},
             {"title": "Segment sizes", "kind": "hbar", "labels": [names[s] for s in range(1, K + 1)], "x_title": "rows", "y_title": "",
              "datasets": [{"label": "Rows", "role": "actual", "data": [sizes[s] for s in range(1, K + 1)]}]}]
    quality = "well separated" if sil >= 0.5 else "reasonably distinct" if sil >= 0.25 else "overlapping — the groups blend into each other"
    narrative = [f"{len(rows):,} rows were grouped into {K} segments by similarity across {len(numeric + categorical + dates)} inputs.",
                 *[f"{names[s]}: {sizes[s]:,} rows ({sizes[s] / len(rows):.0%})." for s in range(1, K + 1)],
                 f"The segments are {quality} (silhouette score {sil:.2f}; 1 = perfectly separate, 0 = overlapping)."
                 + (" The number of segments was chosen automatically as the split with the most distinct groups."
                    if spec.get("k") is None else " The number of segments was set by you."),
                 *_features_note(numeric, categorical, dates, dropped)]
    assign_cols = ([ident] if ident else ["row"]) + [head]
    assign = [[rows[i][idx[ident]] if ident else i + 1, names[int(seg[i])]] for i in range(len(rows))]
    stats = [profile]
    if o["tried"]:
        stats.append(_table("k", "Number of segments tried (silhouette score — higher is more distinct)", ["segments", "score", "chosen"],
                            [[kk, _num(v, 3), "✓" if kk == K else ""] for kk, v in o["tried"].items()], numeric=("segments", "score")))
    metrics = [{"label": "Segments", "value": str(K), "hint": "chosen automatically" if spec.get("k") is None else "set by you"},
               {"label": "Separation", "value": f"{sil:.2f}", "hint": "silhouette score; above 0.5 is strong"},
               {"label": "Largest", "value": f"{sizes[1] / len(rows):.0%}", "hint": names[1]},
               {"label": "Smallest", "value": f"{sizes[K] / len(rows):.0%}", "hint": names[K]}]
    warn = ["Only one input was usable, so the segments are simply ranges of that column."] if len(numeric + categorical + dates) == 1 else []
    return {"method": "K-means clustering", "narrative": narrative, "metrics": metrics, "plots": plots,
            "tables": [_table("segments", "Segment of each row", assign_cols, assign)], "stats": stats, "warnings": warn,
            "code": code, "params": {"k": K}}


def _anomaly(spec, columns, rows):
    import pandas as pd
    idx = {c["name"]: i for i, c in enumerate(columns)}
    dates = [c["name"] for c in columns if c["type"] == "date"]
    date = spec.get("date") or (dates[0] if dates and not spec.get("features") else None)
    df = _frame(columns, rows)
    if date:
        date = _col(columns, date, "time column")["name"]
        measures = [c["name"] for c in columns if c["type"] == "number" and c.get("role", "measure") == "measure"]
        target = _col(columns, spec.get("target") or next((m for m in measures if m != date), None), "measure to check")["name"]
        if pd.to_datetime(df[date].astype(str), errors="coerce").nunique() < 8:
            raise AnalysisError("Finding unusual periods needs at least 8 time periods of history.")
        code = _script(ANOMALY_SERIES, DATE=date, TARGET=target)
        o = _execute(code, df)
        y, exp, score, flag, freq = o["y"], o["expected"], o["score"], o["flagged"], o["FREQ"]
        unit, labels = _unit(freq), [_period(t, freq) for t in y.index]
        hits = [(labels[i], float(y.iloc[i]), float(exp.iloc[i]), float(score.iloc[i])) for i in range(len(y)) if bool(flag.iloc[i])]
        hits.sort(key=lambda h: -abs(h[3]))
        plots = [{"title": f"{target.replace('_', ' ').capitalize()} with unusual {unit}s marked", "kind": "line", "labels": labels,
                  "x_title": date, "y_title": target, "datasets": [
                      {"label": "Actual", "role": "actual", "data": [_num(v) for v in y]},
                      {"label": "Expected level", "role": "forecast", "data": [_num(v) for v in exp]},
                      {"label": "Unusual", "role": "flag", "data": [_num(y.iloc[i]) if bool(flag.iloc[i]) else None for i in range(len(y))]}]}]
        narrative = [f"{len(hits)} of {len(y)} {unit}s look unusual for {target.replace('_', ' ')}." if hits else
                     f"No unusual {unit}s were found in {len(y)} {unit}s of {target.replace('_', ' ')}.",
                     *[f"{lbl}: {_fmt(v)} against an expected {_fmt(e)} ({'above' if v > e else 'below'} by {_fmt(abs(v - e))})." for lbl, v, e, _ in hits[:5]],
                     f"Method: each {unit} is compared with the median of its neighbours; a point is flagged when it is more than 3.5 "
                     "robust standard deviations away (modified z-score)."]
        table = _table("anomalies", f"Unusual {unit}s", [date, target, "expected", "difference", "score"],
                       [[lbl, _num(v, 2), _num(e, 2), _num(v - e, 2), _num(s, 2)] for lbl, v, e, s in hits],
                       numeric=(target, "expected", "difference", "score"))
        every = _table("scores", f"Every {unit} with its score", [date, target, "expected", "score", "unusual"],
                       [[labels[i], _num(y.iloc[i], 2), _num(exp.iloc[i], 2), _num(score.iloc[i], 2), "yes" if bool(flag.iloc[i]) else ""]
                        for i in range(len(y))], numeric=(target, "expected", "score"))
        metrics = [{"label": f"Unusual {unit}s", "value": str(len(hits)), "hint": f"of {len(y)}"},
                   {"label": "Largest deviation", "value": f"{abs(hits[0][3]):.1f}σ" if hits else "–", "hint": hits[0][0] if hits else "none found"},
                   {"label": "Threshold", "value": "3.5σ", "hint": "robust z-score"}]
        warn = [f"{o['missing']} {unit}s had no data and were filled in before checking."] if o["missing"] else []
        return {"method": "Rolling median + robust z-score", "narrative": narrative, "metrics": metrics, "plots": plots,
                "tables": [table], "stats": [every], "warnings": warn, "code": code, "params": {}}

    wanted = {_col(columns, f)["name"] for f in spec.get("features") or []}
    ident = spec.get("id") and _col(columns, spec["id"])["name"]
    if not ident:
        ident = next((c["name"] for c in columns if _ID_HINT.search(c["name"]) and len({r[idx[c["name"]]] for r in rows}) == len(rows)), None)
    numeric, categorical, dates_, dropped = _split_features(columns, rows, wanted, {ident})
    if not (numeric or categorical or dates_):
        raise AnalysisError("Finding unusual rows needs descriptive columns (amounts, counts, categories).")
    if len(rows) < 20:
        raise AnalysisError(f"Only {len(rows)} rows — at least 20 are needed to judge what is unusual.")
    code = _script(ANOMALY_ROWS, NUMERIC=numeric, CATEGORICAL=categorical, DATES=dates_)
    o = _execute(code, df)
    score, flag, why, X = o["score"], o["flagged"], o["most_unusual"], o["X"]
    order = sorted((i for i in range(len(rows)) if flag[i]), key=lambda i: -score[i])
    num_cols = [c for c in o["numeric"]]
    head = ([ident] if ident else ["row"]) + ["score", "stands out on"] + num_cols[:6]
    table = _table("anomalies", "Most unusual rows", head,
                   [[rows[i][idx[ident]] if ident else i + 1, _num(score[i], 3), str(why.iloc[i])] + [_num(X[c].iloc[i], 2) for c in num_cols[:6]]
                    for i in order], numeric=["score"] + num_cols[:6])
    plots = []
    if len(num_cols) >= 2:
        a, b = num_cols[0], num_cols[1]
        step = max(1, len(rows) // 1500)
        pt = lambda i: [_num(X[a].iloc[i]), _num(X[b].iloc[i])]      # noqa: E731
        plots.append({"title": f"Unusual rows — {a} against {b}", "kind": "scatter", "x_title": a, "y_title": b, "datasets": [
            {"label": "Typical", "role": "actual", "points": [pt(i) for i in range(0, len(rows), step) if not flag[i]]},
            {"label": "Unusual", "role": "flag", "points": [pt(i) for i in order[:300]]}]})
    top = order[:15]
    plots.append({"title": "Most unusual rows by score", "kind": "hbar", "labels": [str(rows[i][idx[ident]] if ident else f"row {i + 1}") for i in top],
                  "x_title": "unusualness score", "y_title": "", "datasets": [{"label": "Score", "role": "flag", "data": [_num(score[i], 3) for i in top]}]})
    narrative = [f"{len(order):,} of {len(rows):,} rows ({len(order) / len(rows):.1%}) stand out as unusual across {len(numeric + categorical + dates_)} inputs."
                 if order else f"No row stands out as unusual among {len(rows):,}.",
                 "Method: an isolation forest — rows that can be separated from the rest with very few splits are unusual. "
                 "“Stands out on” names the numeric column where the row is furthest from average.",
                 *_features_note(numeric, categorical, dates_, dropped), "Unusual does not mean wrong: check the flagged rows against what you know."]
    metrics = [{"label": "Unusual rows", "value": f"{len(order):,}", "hint": f"of {len(rows):,}"},
               {"label": "Share", "value": f"{len(order) / len(rows):.1%}", "hint": "flagged"}]
    return {"method": "Isolation forest", "narrative": narrative, "metrics": metrics, "plots": plots, "tables": [table], "stats": [],
            "warnings": [], "code": code, "params": {}}


# =============================================================================================
#  Entry points
# =============================================================================================
def clean_spec(raw) -> dict | None:
    """Keep only known keys and sane values from what the model (or the UI) sent."""
    if not isinstance(raw, dict) or raw.get("type") not in TYPES:
        return None
    spec = {"type": raw["type"]}
    for key in ("date", "target", "id"):
        if isinstance(raw.get(key), str) and raw[key].strip():
            spec[key] = raw[key].strip()[:200]
    if isinstance(raw.get("features"), list):
        spec["features"] = [str(f).strip()[:200] for f in raw["features"] if str(f).strip()][:60]
    for key, lo, hi in (("horizon", 1, 120), ("k", 2, 12)):
        try:
            if raw.get(key) is not None:
                spec[key] = min(max(int(raw[key]), lo), hi)
        except (TypeError, ValueError):
            pass
    return spec


def run(spec: dict, columns: list[dict], rows: list[list]) -> dict:
    """Run one analysis. Raises AnalysisError with a message for the user."""
    try:
        import sklearn  # noqa: F401
        import statsmodels  # noqa: F401
    except ImportError:
        raise AnalysisError("The statistics libraries are not installed on the server. "
                            "Run: pip install -r requirements.txt, then restart.")
    kind = spec["type"]
    if not rows:
        raise AnalysisError("The query returned no rows, so there is nothing to analyse.")
    try:
        if kind == "forecast":
            out = _forecast(spec, columns, rows)
        elif kind == "clustering":
            out = _clustering(spec, columns, rows)
        elif kind == "anomaly":
            out = _anomaly(spec, columns, rows)
        else:
            out = _predict(spec, columns, rows, focus=kind)
    except AnalysisError:
        raise
    except Exception as e:      # a statistical routine rejected the data
        raise AnalysisError(f"The analysis could not be completed on this data ({type(e).__name__}: {str(e)[:200]}). "
                            "Try asking for a simpler or longer set of data.")
    out.update(type=kind, title=LABEL[kind], rows_used=len(rows))
    return out
