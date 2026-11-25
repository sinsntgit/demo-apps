-- Test database for tests/test_postgres.py (run as a superuser):
--   createdb shop && psql -d shop -f tests/fixtures/pg_shop.sql
--   T2S_TEST_PG=reader:r3ader@127.0.0.1:5432/shop T2S_TEST_PG_OWNER=writer:wr1ter python -m pytest tests/test_postgres.py
-- "reader" may only SELECT; "writer" owns the tables (it could change them, so AskData must stop it).
CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, customer_name TEXT NOT NULL, email TEXT, region TEXT);
CREATE TABLE orders (order_id SERIAL PRIMARY KEY, customer_id INTEGER REFERENCES customers(customer_id),
                     amount NUMERIC(12, 2), status TEXT, channel TEXT, placed_at TIMESTAMP);
COMMENT ON COLUMN orders.amount IS 'Order value in GBP';
INSERT INTO customers SELECT i, 'Cust ' || i, 'c' || i || '@x.com', (ARRAY['North', 'South'])[1 + i % 2] FROM generate_series(1, 20) i;
INSERT INTO orders (customer_id, amount, status, channel, placed_at)
SELECT 1 + i % 20, 10 + i, (ARRAY['completed', 'cancelled', 'pending'])[1 + i % 3], 'web',
       TIMESTAMP '2025-01-01 09:00' + (i || ' hours')::interval FROM generate_series(1, 60) i;
-- a function that writes when called from a SELECT: only the database's read-only session can stop it
CREATE FUNCTION touch() RETURNS integer LANGUAGE sql AS $$ INSERT INTO orders (customer_id, amount, status) VALUES (1, 0, 'x') RETURNING 1 $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reader') THEN CREATE ROLE reader LOGIN PASSWORD 'r3ader'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writer') THEN CREATE ROLE writer LOGIN PASSWORD 'wr1ter'; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO reader;
GRANT SELECT ON customers, orders TO reader;
ALTER TABLE customers OWNER TO writer;
ALTER TABLE orders OWNER TO writer;
ALTER SEQUENCE orders_order_id_seq OWNER TO writer;
ALTER FUNCTION touch() OWNER TO writer;
