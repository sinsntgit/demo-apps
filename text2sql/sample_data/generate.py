"""Regenerates the demo retail CSVs (deterministic)."""
import csv
import random
from datetime import date, timedelta
from pathlib import Path

random.seed(7)
out = Path(__file__).parent / "retail"
out.mkdir(exist_ok=True)
regions = {"North": ["Leeds", "Manchester", "Newcastle"], "South": ["London", "Brighton", "Bristol"],
           "East": ["Norwich", "Cambridge"], "West": ["Cardiff", "Bath"]}
first = "Ava Noah Mia Liam Zoe Ethan Ivy Lucas Nora Owen Ruby Felix Elsa Hugo Iris Jude Lena Milo Tara Reid".split()
last = "Shaw Patel Kim Okafor Lind Moreau Hale Novak Reyes Adler Brandt Costa Dunn Egan Frost".split()
cats = {"Laptops": (650, 1900), "Monitors": (120, 700), "Accessories": (9, 140), "Audio": (25, 380), "Networking": (30, 420)}
names = {"Laptops": ["AeroBook 13", "AeroBook 15", "WorkPro 14", "WorkPro 16", "Featherlite 12"],
         "Monitors": ["ViewMax 24", "ViewMax 27", "UltraWide 34", "ColorPro 27", "Compact 22"],
         "Accessories": ["USB-C Hub", "Laptop Sleeve", "Wireless Mouse", "Mech Keyboard", "Webcam HD"],
         "Audio": ["Studio Headphones", "Earbuds Pro", "Desk Speaker", "Conference Mic", "Soundbar Mini"],
         "Networking": ["Mesh Router", "8-Port Switch", "WiFi Extender", "Travel Router", "PoE Injector"]}

def w(name, header, rows):
    with open(out / name, "w", newline="") as f:
        cw = csv.writer(f); cw.writerow(header); cw.writerows(rows)

customers = []
for i in range(1, 81):
    region = random.choice(list(regions))
    n = f"{random.choice(first)} {random.choice(last)}"
    customers.append([i, n, n.lower().replace(" ", ".") + f"{i}@example.com", random.choice(["Consumer", "Small Business", "Enterprise"]),
                      region, random.choice(regions[region]), date(2022, 1, 1) + timedelta(days=random.randint(0, 900))])
w("customers.csv", ["customer_id", "customer_name", "email", "segment", "region", "city", "signup_date"], customers)

products, pid = [], 100
for cat, (lo, hi) in cats.items():
    for nm in names[cat]:
        pid += 1
        price = round(random.uniform(lo, hi), 2)
        products.append([pid, nm, cat, round(price * random.uniform(0.5, 0.75), 2), price])
w("products.csv", ["product_id", "product_name", "category", "unit_cost", "list_price"], products)

orders, items = [], []
start = date(2024, 1, 1)
for oid in range(5001, 6201):
    d = start + timedelta(days=int(random.triangular(0, 669, 520)))
    status = random.choices(["completed", "cancelled", "returned", "pending"], [84, 6, 5, 5])[0]
    orders.append([oid, random.randint(1, 80), d, status, random.choice(["Online", "Store", "Partner"])])
    for p in random.sample(products, random.randint(1, 4)):
        items.append([oid, p[0], random.randint(1, 5), p[4], random.choice([0, 0, 0, 0.05, 0.1, 0.15])])
w("orders.csv", ["order_id", "customer_id", "order_date", "status", "channel"], orders)
w("order_items.csv", ["order_id", "product_id", "quantity", "unit_price", "discount"], items)
