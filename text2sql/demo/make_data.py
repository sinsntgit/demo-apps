"""Sample data sets for the predictive scenes of the demo video (synthetic, deterministic).

  monthly_revenue.csv  45 months with growth and a yearly season      -> forecast
  daily_revenue.csv    one year of daily revenue with a few shocks    -> anomaly detection
  customer_rfm.csv     320 customers from four behaviour archetypes   -> segmentation
"""
import csv
import datetime as dt
from pathlib import Path

import numpy as np

OUT = Path(__file__).parent / "out" / "data_sets"


def write(name, header, rows):
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / name, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def main():
    rng = np.random.default_rng(42)
    season = np.array([0.82, 0.80, 0.90, 0.95, 1.00, 0.98, 0.95, 1.00, 1.05, 1.12, 1.25, 1.38])
    season /= season.mean()
    rows = []
    for t in range(45):                                   # 2023-01 .. 2026-09
        d = dt.date(2023 + t // 12, t % 12 + 1, 1)
        rev = 180_000 * 1.011 ** t * season[d.month - 1] * rng.normal(1, 0.025)
        rows.append([d.isoformat(), round(rev)])
    write("monthly_revenue.csv", ["month", "revenue"], rows)

    weekday = [1.05, 1.08, 1.06, 1.04, 1.12, 0.78, 0.62]
    shocks = {"2025-11-28": 3.4, "2026-02-14": 2.7, "2026-04-09": 0.10, "2026-07-04": 2.3, "2026-09-17": 0.30}
    rows = []
    d0 = dt.date(2025, 11, 1)
    for i in range(365):
        d = d0 + dt.timedelta(days=i)
        v = 8200 * weekday[d.weekday()] * (1 + 0.0004 * i) * rng.normal(1, 0.05) * shocks.get(d.isoformat(), 1)
        rows.append([d.isoformat(), round(v)])
    write("daily_revenue.csv", ["day", "revenue"], rows)

    arche = [  # recency (days), orders in 12 months, average order value, share
        ((6, 30), (20, 6), (310, 60), 0.18),     # champions
        ((35, 20), (11, 3), (190, 40), 0.30),    # loyal
        ((190, 50), (5, 2), (150, 35), 0.22),    # at risk
        ((25, 15), (2, 0.8), (95, 25), 0.30),    # new / occasional
    ]
    rows, cid = [], 1000
    for (rec, orders, aov, share) in arche:
        for _ in range(round(320 * share)):
            cid += 1
            r = max(1, int(rng.normal(*rec)))
            n = max(1, int(round(rng.normal(*orders))))
            a = max(30, rng.normal(*aov))
            rows.append([cid, r, n, round(n * a), round(a), rng.choice(["North", "South", "East", "West"])])
    rng.shuffle(rows)
    write("customer_rfm.csv", ["customer_id", "recency_days", "orders_12m", "revenue_12m", "avg_order_value", "region"], rows)


if __name__ == "__main__":
    main()
