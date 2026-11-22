#!/usr/bin/env python3
"""Writes the sample shop exports used in the demo (fictional customers and products)."""
import csv, random
from datetime import date, timedelta
from pathlib import Path
A = Path(__file__).resolve().parent / "assets"; A.mkdir(exist_ok=True)
random.seed(42)
first = "Aarav Ananya Arjun Diya Ishaan Kavya Meera Neha Rohan Saanvi Tara Vikram Zoya Aditi Karan Naina Rahul Sneha Varun Isha".split()
last = "Nair Sharma Iyer Mehta Rao Kapoor Das Singh Joshi Menon Reddy Bose Shah Gupta Patel".split()
products = [("Brew Master kettle", "SKU-1001"), ("Everyday mug set", "SKU-1002"), ("Ceramic dinner plate", "SKU-1003"), ("Steel water bottle", "SKU-1004"),
            ("Cotton bath towel", "SKU-2001"), ("Linen bed sheet", "SKU-2002"), ("Desk lamp", "SKU-3001"), ("Wireless speaker", "SKU-3002"),
            ("Yoga mat", "SKU-4001"), ("Running shoes", "SKU-4002"), ("Non-stick pan", "SKU-1005"), ("Cutlery set", "SKU-1006")]
prices = [1899, 649, 399, 549, 799, 1499, 1199, 2799, 899, 3499, 1299, 999]
with open(A / "customers.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(["customer_id", "full_name", "email", "since", "tier"])
    for i in range(1, 31):
        n = f"{random.choice(first)} {random.choice(last)}"
        w.writerow([i, n, n.lower().replace(" ", ".") + "@example.com", date(2022, 1, 10) + timedelta(days=random.randint(0, 900)), random.choice(["Gold", "Silver", "Silver", "Bronze"])])
with open(A / "products.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(["product_id", "sku", "product_name"])
    for i, (n, s) in enumerate(products, 1): w.writerow([i, s, n])
status = ["Placed", "Paid", "Paid", "Shipped", "Delivered", "Delivered", "Delivered", "Cancelled"]
orders = []
with open(A / "orders.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(["order_id", "order_no", "customer_id", "order_date", "total", "status"])
    for i in range(1, 81):
        d = date(2025, 1, 1) + timedelta(days=random.randint(0, 120)); orders.append(i)
        w.writerow([i, f"BM-{10000 + i}", random.randint(1, 30), d.isoformat() + " 11:20", 0, random.choice(status)])
tot = {o: 0 for o in orders}
lines = []
for i in range(1, 201):
    o = (i - 1) % 80 + 1; p = random.randint(1, 12); q = random.randint(1, 3)
    lines.append([i, o, p, q, prices[p - 1]]); tot[o] += q * prices[p - 1]
with open(A / "order_lines.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(["line_id", "order_id", "product_id", "qty", "price"]); w.writerows(lines)
rows = list(csv.reader(open(A / "orders.csv")))
with open(A / "orders.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(rows[0])
    for r in rows[1:]: r[4] = tot[int(r[0])]; w.writerow(r)
(A / "shop-glossary.md").write_text("""# BrightMart shop data - glossary

- **Customer**: a person with an account. `tier` is the loyalty level: Gold, Silver or Bronze.
- **Order**: one purchase. `status` moves through Placed, Paid, Shipped, Delivered. A Cancelled order was stopped before shipment.
- **Order line**: one product on an order, with a quantity (`qty`) and the unit `price` in rupees.
- **Product**: something we sell, identified by its `sku`.
- An order's `total` is the sum of its lines.
""")
print("assets written")
