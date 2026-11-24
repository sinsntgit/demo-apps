"""Regenerates the CRM sample (accounts, contacts, support tickets) as CSV files - deterministic.

    python sample_data/generate_crm.py

The CRM's accounts are the SAP sample's customers (sap/KNA1.csv), as a CRM would hold them: about 85% of SAP customers
have a CRM account, the account keeps the SAP customer number WITHOUT the leading zeros (sap_no 100001 for KUNNR
'0000100001'), names are sometimes written differently, and there are prospects with no SAP number at all. That is
the situation the combined "SAP + CRM" sample shows: a match on customer number with the "strip leading zeros" rule,
and accounts on either side that have no partner. Data is "extracted" on the SAP sample's key date.
"""
import csv
import random
from datetime import date, timedelta
from pathlib import Path

random.seed(7)
HERE = Path(__file__).parent
OUT = HERE / "crm"
OUT.mkdir(exist_ok=True)
KEY_DATE, START = date(2026, 11, 15), date(2025, 1, 1)
INDUSTRY = {"OILG": "Oil & gas", "MINE": "Mining", "CHEM": "Chemicals", "WATR": "Water", "FOOD": "Food & beverage",
            "MACH": "Machinery", "POWR": "Power", "PHAR": "Pharma"}
OWNERS = ["Ana Lopez", "Ben Carter", "Chloe Martin", "David Okafor", "Elena Rossi", "Farid Khan"]
FIRST = ["Anna", "Ben", "Carla", "Daniel", "Eva", "Felix", "Grace", "Hugo", "Ines", "Jonas", "Kate", "Lars", "Maya", "Nils",
         "Olivia", "Paul", "Rosa", "Sam", "Tara", "Victor"]
LAST = ["Becker", "Clarke", "Dubois", "Evans", "Fischer", "Garcia", "Hughes", "Jensen", "Klein", "Lambert", "Meyer", "Novak",
        "Owens", "Patel", "Quinn", "Richter", "Smith", "Turner", "Vogel", "Walsh"]
TITLES = ["Procurement Manager", "Plant Manager", "Maintenance Lead", "Purchasing Agent", "Operations Director", "Finance Controller"]
CATEGORIES = [("Delivery delay", 22), ("Invoice question", 20), ("Product defect", 14), ("Spare parts", 18), ("Installation", 10),
              ("Account change", 8), ("Warranty claim", 8)]
PRIORITIES = [("Low", 35), ("Medium", 40), ("High", 20), ("Urgent", 5)]
SUFFIX = (" GmbH", " Inc.", " Ltd", " AG", " SE", " plc", " LLC", " B.V.", " S.A.")


def pick(weighted):
    return random.choices([x for x, _ in weighted], [w for _, w in weighted])[0]


def write(name, header, rows):
    with open(OUT / f"{name}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def short(name):
    for s in SUFFIX:
        if name.endswith(s):
            return name[: -len(s)]
    return name


customers = list(csv.DictReader(open(HERE / "sap" / "KNA1.csv", encoding="utf-8")))
accounts, contacts, tickets = [], [], []
n_acc = n_con = n_tic = 0


def add_account(name, sap_no, country, industry, created):
    global n_acc
    n_acc += 1
    acc = f"ACC-{n_acc:05d}"
    segment = random.choices(["Enterprise", "Mid-market", "Small business"], [25, 45, 30])[0]
    accounts.append([acc, name, sap_no, country, industry, segment, random.choice(OWNERS), created.isoformat()])
    return acc, segment


for c in customers:
    if random.random() > 0.85:                     # not every SAP customer is in the CRM
        continue
    name = short(c["NAME1"]) if random.random() < 0.35 else c["NAME1"]          # CRMs often drop the legal form
    created = date.fromisoformat(c["ERDAT"]) + timedelta(days=random.randint(0, 400)) if c["ERDAT"] else START
    acc, segment = add_account(name, int(c["KUNNR"]), c["LAND1"], INDUSTRY.get(c["BRSCH"], "Other"), min(created, KEY_DATE))
    for _ in range(random.randint(1, 3)):
        n_con += 1
        fn, ln = random.choice(FIRST), random.choice(LAST)
        dom = "".join(ch for ch in short(c["NAME1"]).lower() if ch.isalnum())[:18] or "customer"
        contacts.append([f"CON-{n_con:05d}", acc, f"{fn} {ln}", random.choice(TITLES), f"{fn.lower()}.{ln.lower()}@{dom}.example"])
    busy = {"Enterprise": 9, "Mid-market": 5, "Small business": 2}[segment]
    for _ in range(max(0, int(random.gauss(busy, busy / 2)))):
        n_tic += 1
        opened = START + timedelta(days=random.randint(0, (KEY_DATE - START).days - 1))
        prio = pick(PRIORITIES)
        age = (KEY_DATE - opened).days
        if age > 30 and random.random() < 0.93 or age > 10 and random.random() < 0.55:
            closed = min(KEY_DATE, opened + timedelta(days=random.randint(0, {"Urgent": 3, "High": 8, "Medium": 15, "Low": 25}[prio])))
            status, sat = "Closed", random.choices([1, 2, 3, 4, 5], [4, 8, 18, 40, 30])[0]
        else:
            closed, status, sat = None, random.choices(["Open", "In progress", "Waiting on customer"], [40, 40, 20])[0], None
        tickets.append([f"T-{n_tic:06d}", acc, opened.isoformat(), pick(CATEGORIES), prio, status,
                        closed.isoformat() if closed else "", sat if sat is not None else ""])

for i in range(25):                                # prospects: in the CRM, not (yet) customers in SAP
    nm = f"{random.choice(['Nordic', 'Atlas', 'Summit', 'Harbor', 'Crest', 'Pioneer', 'Vertex', 'Granite'])} " \
         f"{random.choice(['Pumps', 'Utilities', 'Process', 'Energy', 'Water Systems', 'Foods', 'Minerals'])}{random.choice(SUFFIX)}"
    add_account(nm, "", random.choice(["DE", "US", "GB", "NL", "FR"]), random.choice(list(INDUSTRY.values())),
                START + timedelta(days=random.randint(0, 600)))

write("accounts", ["account_id", "account_name", "sap_no", "country", "industry", "segment", "account_owner", "created_on"], accounts)
write("contacts", ["contact_id", "account_id", "full_name", "job_title", "email"], contacts)
write("tickets", ["ticket_id", "account_id", "opened_on", "category", "priority", "status", "closed_on", "satisfaction"], tickets)
print(f"crm sample: {len(accounts)} accounts ({sum(1 for a in accounts if a[2])} with an SAP number), {len(contacts)} contacts, {len(tickets)} tickets")
