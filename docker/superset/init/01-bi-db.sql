-- The Superset stack's metadata database is `superset`. Uploaded CSVs live in a
-- separate database so a BI table cannot collide with a Superset migration table.
-- This file runs once, when the Postgres volume is first created.
CREATE DATABASE inicio_bi;
