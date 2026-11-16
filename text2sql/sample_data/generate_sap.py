"""Regenerates the SAP-style sample (Sales & Distribution + Finance) as CSV files - deterministic.

    python sample_data/generate_sap.py

The tables and fields copy SAP ECC / S/4HANA names and conventions (KNA1, VBAK, VBRK, BKPF, BSEG ...):
leading-zero keys, language-dependent text tables (E and D), positive amounts with a debit/credit
indicator, billing cancellations and credit memos, document flow through reference fields, and an
FI document for every billing document. The numbers are invented. Data is "extracted" on KEY_DATE.
"""
import csv
import math
import random
from datetime import date, timedelta
from pathlib import Path

random.seed(42)
OUT = Path(__file__).parent / "sap"
OUT.mkdir(exist_ok=True)
START, KEY_DATE = date(2024, 1, 1), date(2026, 11, 15)


def write(name, header, rows):
    with open(OUT / f"{name}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def d(x):                       # dates are exported as ISO dates (the replication converts SAP's YYYYMMDD)
    return x.isoformat() if x else ""


def r2(x):
    return round(x + 1e-9, 2)


# ---- organisation ---------------------------------------------------------------------------
CC = {  # company code: name, country, currency, city, tax rate, sales org, plant(s), bank account
    "1000": ("Acme Industrial GmbH", "DE", "EUR", "Berlin", 0.19),
    "2000": ("Acme Industrial Inc.", "US", "USD", "Houston", 0.0),
    "3000": ("Acme Industrial Ltd", "GB", "GBP", "Manchester", 0.20),
}
FX = {"EUR": 1.0, "USD": 1.08, "GBP": 0.86}          # price multipliers vs EUR list prices
write("T001", ["BUKRS", "BUTXT", "ORT01", "LAND1", "WAERS", "KTOPL", "PERIV"],
      [[k, v[0], v[3], v[1], v[2], "INT", "K4"] for k, v in CC.items()])
write("TVKO", ["VKORG", "BUKRS", "WAERS"], [[k, k, v[2]] for k, v in CC.items()])
write("TVKOT", ["VKORG", "SPRAS", "VTEXT"],
      [r for k, v in CC.items() for r in ([k, "E", f"Sales Org {['Germany', 'USA', 'UK'][int(k[0]) - 1]}"],
                                          [k, "D", f"Verkaufsorg. {['Deutschland', 'USA', 'Großbritannien'][int(k[0]) - 1]}"])])
CHANNELS = {"10": ("Direct sales", "Direktvertrieb"), "20": ("Distributors", "Händler"), "30": ("Online shop", "Onlineshop")}
write("TVTWT", ["VTWEG", "SPRAS", "VTEXT"], [r for k, (e, g) in CHANNELS.items() for r in ([k, "E", e], [k, "D", g])])
PLANTS = {"1010": ("Berlin Plant", "1000", "DE"), "1020": ("Hamburg DC", "1000", "DE"),
          "2010": ("Houston Plant", "2000", "US"), "3010": ("Manchester DC", "3000", "GB")}
write("T001W", ["WERKS", "NAME1", "BWKEY", "BUKRS", "LAND1"], [[k, n, k, b, l] for k, (n, b, l) in PLANTS.items()])
ORDER_TYPES = {"QT": ("Quotation", "Angebot", "B"), "OR": ("Standard Order", "Terminauftrag", "C"),
               "RE": ("Returns", "Retoure", "H"), "CR": ("Credit Memo Request", "Gutschriftsanforderung", "K")}
write("TVAKT", ["AUART", "SPRAS", "BEZEI"], [r for k, (e, g, _) in ORDER_TYPES.items() for r in ([k, "E", e], [k, "D", g])])
REJECT = {"02": ("Price too high", "Preis zu hoch"), "05": ("Delivery date too late", "Liefertermin zu spät"),
          "10": ("Customer cancelled", "Kunde storniert")}
write("TVAGT", ["ABGRU", "SPRAS", "BEZEI"], [r for k, (e, g) in REJECT.items() for r in ([k, "E", e], [k, "D", g])])
INDUSTRY = {"CHEM": ("Chemicals", "Chemie"), "OILG": ("Oil & gas", "Öl und Gas"), "WATR": ("Water utilities", "Wasserversorgung"),
            "FOOD": ("Food & beverage", "Lebensmittel"), "MINE": ("Mining", "Bergbau"), "BLDG": ("Building services", "Gebäudetechnik")}
write("T016T", ["BRSCH", "SPRAS", "BRTXT"], [r for k, (e, g) in INDUSTRY.items() for r in ([k, "E", e], [k, "D", g])])

# ---- materials --------------------------------------------------------------------------------
GROUPS = {  # MATKL: (text E, text D, profit centre, material type, base price EUR, models)
    "PUMPS": ("Pumps", "Pumpen", "PC-PUMPS", "FERT", 4200, ["Centrifugal pump CP-50", "Centrifugal pump CP-80", "Submersible pump SP-30",
                                                             "Dosing pump DP-10", "Diaphragm pump DM-25", "Booster set BS-200",
                                                             "Multistage pump MS-120", "Sewage pump SW-40", "Fire pump FP-500", "Inline pump IL-65"]),
    "VALVES": ("Valves", "Ventile", "PC-VALVES", "FERT", 900, ["Ball valve BV-50", "Butterfly valve BF-150", "Gate valve GV-100",
                                                                "Check valve CV-80", "Control valve CTL-40", "Pressure relief valve PR-25",
                                                                "Solenoid valve SV-15", "Globe valve GL-65"]),
    "MOTORS": ("Motors & drives", "Motoren & Antriebe", "PC-MOTORS", "FERT", 2600, ["IE3 motor 7.5 kW", "IE3 motor 15 kW", "IE4 motor 22 kW",
                                                                                      "Frequency drive FD-11", "Frequency drive FD-30", "Soft starter SS-45",
                                                                                      "Gear motor GM-4"]),
    "SPARES": ("Spare parts", "Ersatzteile", "PC-SPARES", "HAWA", 85, ["Mechanical seal kit", "Impeller CP-50", "Bearing set 6308", "O-ring kit",
                                                                       "Coupling insert", "Valve seat BV-50", "Gasket set", "Pressure gauge 0-16 bar",
                                                                       "Filter cartridge", "Shaft sleeve"]),
    "SERVICE": ("Services", "Dienstleistungen", "PC-SERVICE", "DIEN", 650, ["Commissioning (day)", "Annual maintenance contract",
                                                                           "Pump overhaul", "Energy audit", "On-site repair (hour)"]),
}
write("T023T", ["MATKL", "SPRAS", "WGBEZ"], [r for k, g in GROUPS.items() for r in ([k, "E", g[0]], [k, "D", g[1]])])
write("CEPCT", ["PRCTR", "SPRAS", "KTEXT"], [r for g in GROUPS.values() for r in ([g[2], "E", f"{g[0]} profit centre"], [g[2], "D", f"Profitcenter {g[1]}"])])
MATS = []           # (MATNR, MATKL, desc, list price EUR, cost ratio, unit)
prefix = {"PUMPS": "PMP", "VALVES": "VLV", "MOTORS": "MOT", "SPARES": "SPR", "SERVICE": "SRV"}
for grp, (_, _, _, mtart, base, names) in GROUPS.items():
    for i, name in enumerate(names):
        price = round(base * random.uniform(0.45, 1.9), -1 if base > 200 else 0)
        unit = "H" if "hour" in name else "DAY" if "day" in name else "EA"
        MATS.append((f"{prefix[grp]}-{1001 + i}", grp, name, price, random.uniform(0.48, 0.7) if grp != "SERVICE" else random.uniform(0.35, 0.5), unit, mtart))
write("MARA", ["MATNR", "MTART", "MATKL", "MEINS", "BRGEW", "GEWEI", "ERSDA", "LVORM"],
      [[m, t, g, u, (0 if t == "DIEN" else round(p / 60 + random.uniform(0.2, 4), 1)), "KG", d(date(2019, 1, 1) + timedelta(days=random.randint(0, 1500))), ""]
       for m, g, _, p, _, u, t in MATS])
GERMAN = {"pump": "Pumpe", "valve": "Ventil", "motor": "Motor", "kit": "Satz", "set": "Satz", "drive": "Umrichter"}
write("MAKT", ["MATNR", "SPRAS", "MAKTX"],
      [r for m, _, n, *_ in MATS for r in ([m, "E", n], [m, "D", " ".join(GERMAN.get(w.lower(), w) for w in n.split())])])
write("MBEW", ["MATNR", "BWKEY", "VPRSV", "STPRS", "PEINH", "WAERS"],
      [[m, w, "S", r2(p * c * FX[CC[b][2]]), 1, CC[b][2]] for m, _, _, p, c, *_ in MATS for w, (_, b, _) in PLANTS.items()])
PRICE = {m: (p, c, g, n, u) for m, g, n, p, c, u, _ in MATS}

# ---- customers --------------------------------------------------------------------------------
PRE = {"1000": "Nordwerk Rhein Elbe Alpen Hansa Atlas Delta Vector Meridian Orion Isar Weser".split(),
       "2000": "Summit Gulf Pioneer Union Granite Harbor Prairie Cascade Lone-Star Liberty Redwood Keystone".split(),
       "3000": "Thames Pennine Severn Mersey Kestrel Albion Clyde Avon Cotswold Humber".split()}
pre = [w for v in PRE.values() for w in v]
suf = {"CHEM": ["Chemie", "Chemicals", "Polymers"], "OILG": ["Energy", "Petroleum", "Offshore"], "WATR": ["Water", "Wasserwerke", "Utilities"],
       "FOOD": ["Foods", "Brewing", "Dairy"], "MINE": ["Mining", "Minerals", "Quarries"], "BLDG": ["Facility Services", "Building Systems", "HVAC"]}
legal = {"DE": "GmbH", "AT": "GmbH", "NL": "B.V.", "FR": "SAS", "US": "Inc.", "CA": "Ltd.", "MX": "S.A. de C.V.", "GB": "Ltd", "IE": "Ltd"}
cities = {"DE": ["Hamburg", "Munich", "Cologne", "Frankfurt", "Stuttgart", "Leipzig", "Dortmund"], "AT": ["Vienna", "Linz"], "NL": ["Rotterdam", "Utrecht"],
          "FR": ["Lyon", "Lille"], "US": ["Houston", "Chicago", "Denver", "Atlanta", "Phoenix", "Pittsburgh"], "CA": ["Calgary", "Toronto"],
          "MX": ["Monterrey"], "GB": ["Manchester", "Leeds", "Glasgow", "Bristol", "Birmingham"], "IE": ["Dublin", "Cork"]}
countries = {"1000": [("DE", 70), ("AT", 12), ("NL", 10), ("FR", 8)], "2000": [("US", 82), ("CA", 12), ("MX", 6)], "3000": [("GB", 85), ("IE", 15)]}
CUSTS = []          # dicts
used = set()
for i in range(160):
    vk = random.choices(list(CC), [50, 30, 20])[0]
    land = random.choices(*zip(*countries[vk]))[0]
    br = random.choice(list(INDUSTRY))
    while True:
        name = f"{random.choice(PRE[vk])} {random.choice(suf[br])} {legal[land]}"
        if name not in used:
            used.add(name)
            break
    size = min(4.0, random.lognormvariate(0, 0.6))                     # how much this customer buys
    CUSTS.append({"KUNNR": f"{100001 + i:010d}", "NAME1": name, "LAND1": land, "ORT01": random.choice(cities[land]), "BRSCH": br,
                  "VKORG": vk, "VTWEG": random.choices(list(CHANNELS), [55, 35, 10])[0], "size": size,
                  "KDGRP": "01" if size > 2.2 else "02" if size > 0.6 else "03",
                  "ZTERM": random.choices(["ZB30", "ZB45", "ZB60"], [60, 25, 15])[0],
                  "late": random.choices([0, 1, 2], [70, 22, 8])[0],    # payment behaviour: on time / a bit late / very late
                  "ERDAT": date(2015, 1, 1) + timedelta(days=random.randint(0, 3200)),
                  "BZIRK": {"DE": random.choice(["NORD", "SUED", "WEST", "OST"]), "US": random.choice(["USE", "USW", "USC"]),
                            "GB": random.choice(["UKN", "UKS"])}.get(land, "EXP")})
TERMS = {"ZB30": 30, "ZB45": 45, "ZB60": 60}
write("KNA1", ["KUNNR", "NAME1", "LAND1", "ORT01", "PSTLZ", "BRSCH", "KTOKD", "ERDAT", "LOEVM"],
      [[c["KUNNR"], c["NAME1"], c["LAND1"], c["ORT01"], f"{random.randint(10000, 99999)}", c["BRSCH"], "KUNA", d(c["ERDAT"]), ""] for c in CUSTS])
write("KNVV", ["KUNNR", "VKORG", "VTWEG", "SPART", "KDGRP", "BZIRK", "ZTERM", "WAERS"],
      [[c["KUNNR"], c["VKORG"], c["VTWEG"], "00", c["KDGRP"], c["BZIRK"], c["ZTERM"], CC[c["VKORG"]][2]] for c in CUSTS])
write("TVZBT", ["ZTERM", "SPRAS", "VTEXT"], [[k, "E", f"Net {v} days"] for k, v in TERMS.items()] + [[k, "D", f"{v} Tage netto"] for k, v in TERMS.items()])
write("T151T", ["KDGRP", "SPRAS", "KTEXT"], [["01", "E", "Key account"], ["02", "E", "Standard"], ["03", "E", "Small customer"],
                                              ["01", "D", "Großkunde"], ["02", "D", "Standard"], ["03", "D", "Kleinkunde"]])

# ---- G/L accounts, cost centres, vendors --------------------------------------------------------
GL = {  # SAKNR: (E, D, balance sheet?, group)
    "113100": ("Bank - current account", "Bank - Girokonto", "X", "ASSETS"), "121000": ("Receivables - domestic", "Forderungen Inland", "X", "ASSETS"),
    "154000": ("Input tax", "Vorsteuer", "X", "ASSETS"), "790000": ("Finished goods inventory", "Fertigerzeugnisse", "X", "ASSETS"),
    "160000": ("Payables - domestic", "Verbindlichkeiten Inland", "X", "LIABILITIES"), "175000": ("Output tax", "Umsatzsteuer", "X", "LIABILITIES"),
    "400000": ("Sales revenue - domestic", "Umsatzerlöse Inland", "", "REVENUE"), "410000": ("Sales revenue - export", "Umsatzerlöse Ausland", "", "REVENUE"),
    "500000": ("Cost of goods sold", "Herstellkosten des Umsatzes", "", "COGS"), "610000": ("Rent and facilities", "Miete und Gebäude", "", "OPEX"),
    "620000": ("Utilities", "Energie", "", "OPEX"), "630000": ("Travel expenses", "Reisekosten", "", "OPEX"),
    "640000": ("IT and software", "IT und Software", "", "OPEX"), "650000": ("Marketing", "Marketing", "", "OPEX"),
    "660000": ("Salaries and wages", "Löhne und Gehälter", "", "OPEX"), "670000": ("Professional services", "Beratung", "", "OPEX"),
    "680000": ("Freight out", "Ausgangsfracht", "", "OPEX"),
}
acct = lambda s: f"{int(s):010d}"                       # noqa: E731 - G/L accounts carry leading zeros, like SAP
write("SKA1", ["KTOPL", "SAKNR", "XBILK", "GVTYP", "KTOKS"],
      [["INT", acct(k), b, "" if b else "X", g] for k, (_, _, b, g) in GL.items()])
write("SKAT", ["SPRAS", "KTOPL", "SAKNR", "TXT20", "TXT50"],
      [r for k, (e, g, *_) in GL.items() for r in (["E", "INT", acct(k), e[:20], e], ["D", "INT", acct(k), g[:20], g])])
CC_FUNCS = [("10", "Sales", "Vertrieb", "V"), ("20", "Marketing", "Marketing", "V"), ("30", "Administration", "Verwaltung", "W"),
            ("40", "IT", "IT", "W"), ("50", "Logistics", "Logistik", "L"), ("60", "Service delivery", "Kundendienst", "F")]
COSTC = {b: [(f"{b[0]}{f}00", e, g, k) for f, e, g, k in CC_FUNCS] for b in CC}      # 11000 = company 1, function 10 (Sales)
managers = "Anna Weber,Jonas Becker,Lea Fischer,Paul Wagner,Mia Schulz,Tim Hoffmann,Emily Carter,James Miller,Olivia Brown,Noah Davis,Ava Wilson,Liam Moore,Grace Evans,Harry Clarke,Sophie Hughes,Jack Turner,Amelia Wright,Oscar Hall".split(",")
write("CSKS", ["KOKRS", "KOSTL", "BUKRS", "KOSAR", "VERAK", "PRCTR", "DATAB", "DATBI"],
      [["A000", k, b, cat, managers[i * 6 + j], "PC-SERVICE" if e == "Service delivery" else "PC-CORP", "2020-01-01", "9999-12-31"]
       for i, b in enumerate(CC) for j, (k, e, _, cat) in enumerate(COSTC[b])])
write("CSKT", ["KOKRS", "KOSTL", "SPRAS", "KTEXT"],
      [r for b in CC for k, e, g, _ in COSTC[b] for r in (["A000", k, "E", f"{e} {CC[b][1]}"], ["A000", k, "D", f"{g} {CC[b][1]}"])])
VEND_KIND = {"610000": ["Property", "Estates", "Real Estate"], "620000": ["Energy", "Power", "Utilities"], "630000": ["Travel", "Airlines", "Hotels"],
             "640000": ["Software", "Cloud", "IT Services"], "650000": ["Media", "Events", "Advertising"], "670000": ["Consulting", "Legal", "Audit"],
             "680000": ["Logistics", "Freight", "Haulage"]}
VENDS = []
for b in CC:                                            # every company buys every kind of service, from 1-3 vendors
    for acc in VEND_KIND:
        for _ in range(random.choice([1, 2, 2, 3])):
            VENDS.append({"BUKRS": b, "acc": acc})
for i, v in enumerate(VENDS):
    b, acc = v["BUKRS"], v["acc"]
    land = CC[b][1]
    v.update({"LIFNR": f"{300001 + i:010d}", "NAME1": f"{random.choice(PRE[b])} {random.choice(VEND_KIND[acc])} {legal[land]}", "LAND1": land,
                  "ORT01": random.choice(cities[land]), "amt": random.lognormvariate(7.2, 0.6) * {"1000": 1.0, "2000": 0.9, "3000": 0.45}[b]})
write("LFA1", ["LIFNR", "NAME1", "LAND1", "ORT01", "KTOKK", "ERDAT"],
      [[v["LIFNR"], v["NAME1"], v["LAND1"], v["ORT01"], "LIEF", d(date(2016, 1, 1) + timedelta(days=random.randint(0, 2500)))] for v in VENDS])

# ---- sales: quotations, orders, deliveries, billing -------------------------------------------------
VBAK, VBAP, LIKP, LIPS, VBRK, VBRP = [], [], [], [], [], []
BKPF, BSEG = [], []
num = {"so": 10000000, "qt": 20000000, "dl": 80000000, "bi": 90000000}
fi_num = {}


def nxt(k):
    num[k] += 1
    return f"{num[k]:010d}"


def fi_doc(bukrs, blart, budat, waers, lines, xblnr="", awtyp="BKPF", awkey="", usnam="BATCH"):
    """Post one balanced FI document. lines: (bschl, koart, shkzg, amount, hkont, extra dict)."""
    gjahr = budat.year
    base = {"RV": 90000000, "DZ": 1400000000, "WL": 4900000000, "KR": 5100000000, "KZ": 1500000000, "SA": 100000000, "DG": 1600000000}[blart]
    key = (bukrs, gjahr, blart)
    fi_num[key] = fi_num.get(key, base) + 1
    belnr = f"{fi_num[key]:010d}"
    BKPF.append([bukrs, belnr, gjahr, blart, d(budat), d(budat), budat.month, waers, xblnr, awtyp, awkey, usnam, ""])
    deb = sum(a for _, _, s, a, _, _ in lines if s == "S")
    cre = sum(a for _, _, s, a, _, _ in lines if s == "H")
    assert abs(deb - cre) < 0.02, (blart, deb, cre)
    rows = []
    for i, (bschl, koart, shkzg, amt, hkont, x) in enumerate(lines, 1):
        row = {"BUKRS": bukrs, "BELNR": belnr, "GJAHR": gjahr, "BUZEI": f"{i:03d}", "BSCHL": bschl, "KOART": koart, "SHKZG": shkzg,
               "DMBTR": r2(amt), "WRBTR": r2(amt), "HKONT": acct(hkont), "KUNNR": "", "LIFNR": "", "KOSTL": "", "PRCTR": "", "MATNR": "",
               "ZFBDT": "", "ZTERM": "", "ZBD1T": "", "AUGDT": "", "AUGBL": "", "VBELN": "", "SGTXT": ""}
        row.update(x)
        BSEG.append(row)
        rows.append(row)
    return belnr, rows


def season(day):
    m = day.month
    s = {1: 0.85, 2: 0.9, 3: 1.05, 4: 1.0, 5: 1.0, 6: 1.08, 7: 0.92, 8: 0.8, 9: 1.05, 10: 1.08, 11: 1.12, 12: 1.15}[m]
    trend = 1 + 0.13 * (day - START).days / 365                # ~13% a year growth
    return s * trend


POOLS = {b: ([c for c in CUSTS if c["VKORG"] == b], [c["size"] for c in CUSTS if c["VKORG"] == b]) for b in CC}
open_ar = []                     # customer lines of invoices to clear later
day = START
while day <= KEY_DATE - timedelta(days=1):
    if day.weekday() < 5:
        n = sum(random.random() < 0.55 * season(day) for _ in range(10))
        for _ in range(n):
            c = random.choices(*POOLS[random.choices(list(CC), [45, 37, 18])[0]])[0]
            vk, cur = c["VKORG"], CC[c["VKORG"]][2]
            fx = FX[cur]
            plant = {"1000": random.choice(["1010", "1020"]), "2000": "2010", "3000": "3010"}[vk]
            # items: a main product line, often spares/service alongside
            grp_main = random.choices(["PUMPS", "VALVES", "MOTORS", "SPARES", "SERVICE"], [30, 25, 15, 20, 10])[0]
            picks = [random.choice([m for m in MATS if m[1] == grp_main])]
            for _ in range(random.choices([0, 1, 2, 3], [35, 35, 20, 10])[0]):
                picks.append(random.choice(MATS))
            items = []
            for k, m in enumerate(dict.fromkeys(picks), 1):
                matnr = m[0]
                p, cost, grp, desc, unit = PRICE[matnr]
                qty = max(1, int(random.lognormvariate(0.6 if grp in ("PUMPS", "MOTORS") else 1.4 if grp == "SPARES" else 0.8, 0.45) * (1 + c["size"] / 4)))
                disc = {"01": 0.12, "02": 0.05, "03": 0.0}[c["KDGRP"]] + random.uniform(-0.03, 0.03)
                net = r2(qty * p * fx * (1 - max(0, disc)) * (1 + 0.03 * (day.year - 2024)))
                items.append([f"{k * 10:06d}", matnr, desc, qty, unit, net, r2(qty * p * fx * cost), grp])
            # some orders come from a quotation; some quotations never convert
            quote = None
            if random.random() < 0.35:
                quote = nxt("qt")
                qday = day - timedelta(days=random.randint(5, 40))
                VBAK.append([quote, d(qday), "QT", "B", vk, c["VTWEG"], "00", c["KUNNR"], r2(sum(i[5] for i in items) * 1.04), cur, d(qday + timedelta(days=30)), "", "C", f"RFQ-{random.randint(1000, 9999)}", "SALES01"])
                for it in items:
                    VBAP.append([quote, it[0], it[1], it[3], it[4], it[2], r2(it[5] * 1.04), cur, plant, "", "AGN", "", "", it[7]])
            if random.random() < 0.18:      # an extra quotation that is lost
                lq = nxt("qt")
                VBAK.append([lq, d(day), "QT", "B", vk, c["VTWEG"], "00", c["KUNNR"], r2(sum(i[5] for i in items) * 1.1), cur, d(day + timedelta(days=30)), "", "A", "", "SALES01"])
                for it in items:
                    VBAP.append([lq, it[0], it[1], it[3], it[4], it[2], r2(it[5] * 1.1), cur, plant, "", "AGN", "", "", it[7]])
            so = nxt("so")
            req = day + timedelta(days=random.randint(7, 35))
            rejected = set()
            for it in items:
                if len(items) > 1 and random.random() < 0.05:
                    rejected.add(it[0])
            lead_late = random.random() < (0.22 if day.year == 2025 and 5 <= day.month <= 8 else 0.1)   # summer 2025 supply issue
            gi = req + timedelta(days=random.randint(1, 18) if lead_late else -random.randint(0, 4))
            delivered = gi < KEY_DATE - timedelta(days=1)
            status = "C" if delivered else ("A" if day > KEY_DATE - timedelta(days=20) else "B")
            net_order = r2(sum(i[5] for i in items if i[0] not in rejected))
            VBAK.append([so, d(day), "OR", "C", vk, c["VTWEG"], "00", c["KUNNR"], net_order, cur, d(req), quote or "", status,
                         f"PO-{random.randint(100000, 999999)}", random.choice(["SALES01", "SALES02", "WEBSHOP" if c["VTWEG"] == "30" else "SALES03"])])
            for it in items:
                ab = random.choice(list(REJECT)) if it[0] in rejected else ""
                VBAP.append([so, it[0], it[1], it[3], it[4], it[2], it[5], cur, plant, ab, "TAN" if it[7] != "SERVICE" else "TAD",
                             quote or "", it[0] if quote else "", it[7]])
            if not delivered:
                continue
            live = [it for it in items if it[0] not in rejected]
            dl = nxt("dl")
            LIKP.append([dl, d(gi - timedelta(days=2)), "LF", vk, plant, c["KUNNR"], d(req), d(req), d(gi), "C"])
            for i, it in enumerate(live, 1):
                LIPS.append([dl, f"{i * 10:06d}", it[1], it[3], it[4], so, it[0], plant])
            # goods issue posts cost of sales
            cogs = r2(sum(it[6] for it in live if it[7] != "SERVICE"))
            if cogs:
                fi_doc(vk, "WL", gi, cur, [("81", "S", "S", cogs, "500000", {}), ("99", "S", "H", cogs, "790000", {})], dl, "MKPF", dl)
            bday = gi + timedelta(days=random.randint(0, 2))
            if bday >= KEY_DATE:
                continue
            bi = nxt("bi")
            net = r2(sum(it[5] for it in live))
            export = c["LAND1"] != CC[vk][1]
            tax = 0.0 if export else r2(net * CC[vk][4])
            VBRK.append([bi, "F2", "M", d(bday), d(bday), vk, c["VTWEG"], vk, c["KUNNR"], c["KUNNR"], net, tax, cur, c["ZTERM"], "", ""])
            for i, it in enumerate(live, 1):
                VBRP.append([bi, f"{i * 10:06d}", it[1], it[2], it[3], it[4], it[5], it[6], so, it[0], dl, f"{i * 10:06d}", plant, it[7], GROUPS[it[7]][2]])
            due = bday + timedelta(days=TERMS[c["ZTERM"]])
            rev = {}
            for it in live:
                rev[GROUPS[it[7]][2]] = rev.get(GROUPS[it[7]][2], 0) + it[5]
            lines = [("01", "D", "S", net + tax, "121000", {"KUNNR": c["KUNNR"], "ZFBDT": d(bday), "ZTERM": c["ZTERM"], "ZBD1T": TERMS[c["ZTERM"]], "VBELN": bi})]
            lines += [("50", "S", "H", r2(v), "410000" if export else "400000", {"PRCTR": pc, "VBELN": bi}) for pc, v in rev.items()]
            if tax:
                lines.append(("50", "S", "H", tax, "175000", {"VBELN": bi}))
            # rounding: make the revenue lines add up exactly to the net value
            diff = r2(net - sum(r2(v) for v in rev.values()))
            if diff:
                lines[1] = lines[1][:3] + (r2(lines[1][3] + diff),) + lines[1][4:]
            belnr, rows = fi_doc(vk, "RV", bday, cur, lines, bi, "VBRK", bi)
            # ~1.2% of invoices are cancelled (S1) and re-billed; ~2% get a credit memo for a complaint
            if random.random() < 0.012:
                VBRK[-1][14] = "X"
                cday = bday + timedelta(days=random.randint(1, 6))
                if cday < KEY_DATE:
                    s1 = nxt("bi")
                    VBRK.append([s1, "S1", "N", d(cday), d(cday), vk, c["VTWEG"], vk, c["KUNNR"], c["KUNNR"], net, tax, cur, c["ZTERM"], "", bi])
                    for i, it in enumerate(live, 1):
                        VBRP.append([s1, f"{i * 10:06d}", it[1], it[2], it[3], it[4], it[5], it[6], so, it[0], dl, f"{i * 10:06d}", plant, it[7], GROUPS[it[7]][2]])
                    rlines = [(("11" if l[0] == "01" else "40"), l[1], "H" if l[2] == "S" else "S", l[3], l[4], {**l[5], "VBELN": s1}) for l in lines]
                    rb, rrows = fi_doc(vk, "RV", cday, cur, rlines, s1, "VBRK", s1)
                    for b in BKPF:              # mark the original FI document as reversed
                        if b[0] == vk and b[1] == belnr and b[2] == bday.year:
                            b[12] = rb
                    for row in rows[:1] + rrows[:1]:
                        row["AUGDT"], row["AUGBL"] = d(cday), rb
                    continue
            if random.random() < 0.02 and bday + timedelta(days=20) < KEY_DATE:
                cday = bday + timedelta(days=random.randint(5, 20))
                g2 = nxt("bi")
                it = random.choice(live)
                cm = r2(it[5] * random.choice([0.1, 0.2, 0.5, 1.0]))
                ctax = 0.0 if export else r2(cm * CC[vk][4])
                VBRK.append([g2, "G2", "O", d(cday), d(cday), vk, c["VTWEG"], vk, c["KUNNR"], c["KUNNR"], cm, ctax, cur, c["ZTERM"], "", ""])
                VBRP.append([g2, "000010", it[1], it[2], 0, it[4], cm, 0, so, it[0], "", "", plant, it[7], GROUPS[it[7]][2]])
                cl = [("11", "D", "H", cm + ctax, "121000", {"KUNNR": c["KUNNR"], "ZFBDT": d(cday), "VBELN": g2}),
                      ("40", "S", "S", cm, "410000" if export else "400000", {"PRCTR": GROUPS[it[7]][2], "VBELN": g2})]
                if ctax:
                    cl.append(("40", "S", "S", ctax, "175000", {"VBELN": g2}))
                cb, crows = fi_doc(vk, "RV", cday, cur, cl, g2, "VBRK", g2)
                open_ar.append((crows[0], cday, cday, c))
            open_ar.append((rows[0], bday, due, c))
    day += timedelta(days=1)

# returns (RE) - a handful of orders with a return and credit memo already covered by G2; keep a few RE orders without billing
for _ in range(25):
    c = random.choice(CUSTS)
    vk, cur = c["VKORG"], CC[c["VKORG"]][2]
    m = random.choice([x for x in MATS if x[1] in ("PUMPS", "VALVES", "SPARES")])
    rday = START + timedelta(days=random.randint(30, (KEY_DATE - START).days - 5))
    re_ = nxt("so")
    val = r2(m[3] * FX[cur])
    VBAK.append([re_, d(rday), "RE", "H", vk, c["VTWEG"], "00", c["KUNNR"], val, cur, d(rday), "", "A", f"RMA-{random.randint(1000, 9999)}", "SALES02"])
    VBAP.append([re_, "000010", m[0], 1, m[5], m[2], val, cur, {"1000": "1010", "2000": "2010", "3000": "3010"}[vk], "", "REN", "", "", m[1]])

# ---- payments: clear customer items (DZ) ----------------------------------------------------------
by_cust = {}
for row, bday, due, c in open_ar:
    by_cust.setdefault(c["KUNNR"], []).append((row, bday, due, c))
for kunnr, lst in by_cust.items():
    for row, bday, due, c in lst:
        if row["AUGDT"]:
            continue
        delay = {0: random.randint(-8, 4), 1: random.randint(3, 30), 2: random.randint(20, 95)}[c["late"]]
        pay = due + timedelta(days=delay)
        if row["SHKZG"] == "H":            # credit memo: offset with the next payment day of the customer
            pay = bday + timedelta(days=random.randint(10, 40))
        if pay >= KEY_DATE or (c["late"] == 2 and random.random() < 0.08):
            continue                        # still open on the key date (some very late payers never paid)
        if pay.weekday() > 4:
            pay += timedelta(days=7 - pay.weekday())
        if pay >= KEY_DATE:
            continue
        amt = row["DMBTR"]
        vk, cur = c["VKORG"], CC[c["VKORG"]][2]
        if row["SHKZG"] == "S":
            lines = [("40", "S", "S", amt, "113100", {}), ("15", "D", "H", amt, "121000", {"KUNNR": kunnr, "ZFBDT": d(pay)})]
        else:
            lines = [("50", "S", "H", amt, "113100", {}), ("05", "D", "S", amt, "121000", {"KUNNR": kunnr, "ZFBDT": d(pay)})]
        pb, prows = fi_doc(vk, "DZ", pay, cur, lines, row["VBELN"], "BKPF", "", "BANKIMPORT")
        for r in (row, prows[1]):
            r["AUGDT"], r["AUGBL"] = d(pay), pb

# ---- vendor invoices (KR), payments (KZ), payroll (SA) --------------------------------------------
m = date(2024, 1, 1)
while m <= KEY_DATE:
    for v in VENDS:
        b, cur = v["BUKRS"], CC[v["BUKRS"]][2]
        for _ in range(random.choice([1, 1, 1, 2])):
            inv = m + timedelta(days=random.randint(0, 27))
            if inv >= KEY_DATE:
                continue
            net = r2(v["amt"] * FX[cur] * random.uniform(0.6, 1.5) * (1.4 if v["acc"] == "650000" and m.month in (3, 9, 10) else 1))
            tax = r2(net * CC[b][4])
            kostl = {"610000": "30", "620000": "50", "630000": "10", "640000": "40", "650000": "20", "670000": "30", "680000": "50"}[v["acc"]]
            kostl = f"{b[0]}{kostl}00"
            lines = [("31", "K", "H", net + tax, "160000", {"LIFNR": v["LIFNR"], "ZFBDT": d(inv), "ZTERM": "ZB30", "ZBD1T": 30}),
                     ("40", "S", "S", net, v["acc"], {"KOSTL": kostl, "SGTXT": f"{GL[v['acc']][0]} {inv:%b %Y}"})]
            if tax:
                lines.append(("40", "S", "S", tax, "154000", {}))
            kb, krows = fi_doc(b, "KR", inv, cur, lines, f"INV-{random.randint(10000, 99999)}", "BKPF", "", "AP_CLERK")
            pay = inv + timedelta(days=random.randint(20, 40))
            if pay < KEY_DATE:
                pb, prows = fi_doc(b, "KZ", pay, cur, [("25", "K", "S", net + tax, "160000", {"LIFNR": v["LIFNR"]}), ("50", "S", "H", net + tax, "113100", {})],
                                   "", "BKPF", "", "PAYRUN")
                for r in (krows[0], prows[0]):
                    r["AUGDT"], r["AUGBL"] = d(pay), pb
    # payroll at month end per cost centre
    last = (m.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    if last < KEY_DATE:
        for b in CC:
            cur = CC[b][2]
            heads = {"10": 9, "20": 4, "30": 5, "40": 4, "50": 7, "60": 8}
            scale = {"1000": 0.55, "2000": 0.5, "3000": 0.22}[b]
            lines, total = [], 0.0
            for f, n in heads.items():
                amt = r2(n * scale * 6200 * FX[cur] * (1 + 0.035 * (m.year - 2024)) * (1.5 if m.month == 12 else 1))
                total += amt
                lines.append(("40", "S", "S", amt, "660000", {"KOSTL": f"{b[0]}{f}00", "SGTXT": f"Payroll {m:%b %Y}"}))
            lines.append(("50", "S", "H", r2(total), "113100", {"SGTXT": f"Payroll {m:%b %Y}"}))
            fi_doc(b, "SA", last, cur, lines, f"PAY{m:%Y%m}", "BKPF", "", "HR_PAYROLL")
    m = (m.replace(day=28) + timedelta(days=4)).replace(day=1)

# ---- write -------------------------------------------------------------------------------------
write("VBAK", ["VBELN", "ERDAT", "AUART", "VBTYP", "VKORG", "VTWEG", "SPART", "KUNNR", "NETWR", "WAERK", "VDATU", "VGBEL", "GBSTK", "BSTNK", "ERNAM"], VBAK)
write("VBAP", ["VBELN", "POSNR", "MATNR", "KWMENG", "VRKME", "ARKTX", "NETWR", "WAERK", "WERKS", "ABGRU", "PSTYV", "VGBEL", "VGPOS", "MATKL"], VBAP)
write("LIKP", ["VBELN", "ERDAT", "LFART", "VKORG", "VSTEL", "KUNNR", "LFDAT", "WADAT", "WADAT_IST", "WBSTK"], LIKP)
write("LIPS", ["VBELN", "POSNR", "MATNR", "LFIMG", "VRKME", "VGBEL", "VGPOS", "WERKS"], LIPS)
write("VBRK", ["VBELN", "FKART", "VBTYP", "FKDAT", "ERDAT", "VKORG", "VTWEG", "BUKRS", "KUNAG", "KUNRG", "NETWR", "MWSBK", "WAERK", "ZTERM", "FKSTO", "SFAKN"], VBRK)
write("VBRP", ["VBELN", "POSNR", "MATNR", "ARKTX", "FKIMG", "VRKME", "NETWR", "WAVWR", "AUBEL", "AUPOS", "VGBEL", "VGPOS", "WERKS", "MATKL", "PRCTR"], VBRP)
write("BKPF", ["BUKRS", "BELNR", "GJAHR", "BLART", "BLDAT", "BUDAT", "MONAT", "WAERS", "XBLNR", "AWTYP", "AWKEY", "USNAM", "STBLG"], BKPF)
cols = ["BUKRS", "BELNR", "GJAHR", "BUZEI", "BSCHL", "KOART", "SHKZG", "DMBTR", "WRBTR", "HKONT", "KUNNR", "LIFNR", "KOSTL", "PRCTR",
        "MATNR", "ZFBDT", "ZTERM", "ZBD1T", "AUGDT", "AUGBL", "VBELN", "SGTXT"]
write("BSEG", cols, [[r[k] for k in cols] for r in BSEG])
print({p.stem: sum(1 for _ in open(p)) - 1 for p in sorted(OUT.glob("*.csv"))})
