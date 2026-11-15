#!/usr/bin/env bash
# Brings up everything the demo video needs, on throwaway ports and a throwaway data folder:
#   app :8010 · stand-in AI model :8765 (answers in ~1.5 s) · mail sink :2525 · PostgreSQL :5544
#   demo/stack.sh start | stop
set -u
cd "$(dirname "$0")/.."
OUT="$PWD/demo/out"; PGDIR=/tmp/pgdemo; PGBIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1)
stop() {
  pkill -f "uvicorn app.main:app --port 8010" 2>/dev/null; pkill -f "tests.fake_llm" 2>/dev/null; pkill -f smtp_sink.py 2>/dev/null
  [ -d "$PGDIR/data" ] && su postgres -c "$PGBIN/pg_ctl -D $PGDIR/data stop -m fast" >/dev/null 2>&1; sleep 1
}
[ "${1:-}" = stop ] && { stop; exit 0; }
stop; mkdir -p "$OUT"; rm -rf "$OUT/data" "$OUT/mail.jsonl"; : > "$OUT/mail.jsonl"
grep -q "smtp.demo-mail.test" /etc/hosts || echo "127.0.0.1 smtp.demo-mail.test" >> /etc/hosts

# --- PostgreSQL with the retail demo data and a read-only role
rm -rf "$PGDIR"; mkdir -p "$PGDIR"; chown postgres "$PGDIR"
su postgres -c "$PGBIN/initdb -D $PGDIR/data -A trust >/dev/null && $PGBIN/pg_ctl -D $PGDIR/data -o '-p 5544 -c unix_socket_directories=$PGDIR' -l $PGDIR/log start >/dev/null"
for _ in $(seq 30); do psql -h 127.0.0.1 -p 5544 -U postgres -c "select 1" >/dev/null 2>&1 && break; sleep 0.5; done
P="psql -q -h 127.0.0.1 -p 5544 -U postgres"
$P -c "create database warehouse" -c "create role askdata_ro login password 'readonly-demo'"
$P -d warehouse <<'SQL'
create table customers(customer_id int primary key, customer_name text, email text, segment text, region text, city text, signup_date date);
create table products(product_id int primary key, product_name text, category text, unit_cost numeric(10,2), list_price numeric(10,2));
create table orders(order_id int primary key, customer_id int references customers(customer_id), order_date date, status text, channel text);
create table order_items(order_id int references orders(order_id), product_id int references products(product_id), quantity int, unit_price numeric(10,2), discount numeric(4,2));
comment on table orders is 'One row per customer order';
comment on column orders.status is 'completed, cancelled, returned or pending';
comment on column customers.segment is 'Consumer, Small Business or Enterprise';
comment on column order_items.discount is 'Fraction of the list price given away, 0.10 = 10%';
SQL
for t in customers products orders order_items; do $P -d warehouse -c "\copy $t from 'sample_data/retail/$t.csv' csv header"; done
$P -d warehouse -c "grant select on all tables in schema public to askdata_ro"

# --- stand-in model, mail sink, app
FAKE_LLM_DELAY=1.5 nohup python3 -m tests.fake_llm > "$OUT/fake.log" 2>&1 &
nohup python3 tests/e2e/smtp_sink.py "$OUT/mail.jsonl" > "$OUT/smtp.log" 2>&1 &
T2S_DATA_DIR="$OUT/data" T2S_ADMIN_EMAIL=admin@acme.example T2S_ADMIN_PASSWORD='Demo-Passw0rd!' T2S_SCHEDULER=0 \
  nohup python3 -m uvicorn app.main:app --port 8010 > "$OUT/app.log" 2>&1 &
for _ in $(seq 60); do curl -sf localhost:8010/api/health >/dev/null && { echo "stack up"; exit 0; }; sleep 0.5; done
echo "app did not start"; tail -5 "$OUT/app.log"; exit 1
