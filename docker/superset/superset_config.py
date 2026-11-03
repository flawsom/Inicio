"""Superset configuration for the self-hosted Inicio BI stack.

Everything secret comes from the container environment; nothing is written into
the image or this file. The local stack speaks HTTP on port 8088, so Talisman is
off here and the operator is responsible for putting a TLS reverse proxy in front
of it before exposing it beyond localhost.
"""
import os

SECRET_KEY = os.environ['SUPERSET_SECRET_KEY']
SQLALCHEMY_DATABASE_URI = os.environ['SUPERSET_METADATA_DATABASE_URI']
SQLALCHEMY_TRACK_MODIFICATIONS = False

# Superset's cache and Celery broker both use the Redis service. The stack does
# not run a Celery worker, so this is a cache configuration, not a promise that
# alerts or scheduled reports are active.
REDIS_URL = 'redis://redis:6379/1'
CACHE_CONFIG = {
    'CACHE_TYPE': 'RedisCache',
    'CACHE_DEFAULT_TIMEOUT': 300,
    'CACHE_KEY_PREFIX': 'superset_',
    'CACHE_REDIS_URL': REDIS_URL,
}
DATA_CACHE_CONFIG = {
    'CACHE_TYPE': 'RedisCache',
    'CACHE_DEFAULT_TIMEOUT': 300,
    'CACHE_KEY_PREFIX': 'superset_data_',
    'CACHE_REDIS_URL': 'redis://redis:6379/2',
}
CELERY_CONFIG = {
    'broker_url': 'redis://redis:6379/0',
    'result_backend': 'redis://redis:6379/0',
}

# The metadata database is Postgres, and uploaded CSVs are written to the
# separate `inicio_bi` database created by init/01-bi-db.sql. The connection is
# seeded by bootstrap.py with file uploads enabled and `public` allowed.
PREVENT_UNSAFE_DB_CONNECTIONS = True
ROW_LIMIT = 5000
ENABLE_PROXY_FIX = True
WTF_CSRF_ENABLED = True
SESSION_COOKIE_SAMESITE = 'Lax'

# Local HTTP. Set SUPERSET_COOKIE_SECURE=true after adding TLS.
SESSION_COOKIE_SECURE = os.environ.get('SUPERSET_COOKIE_SECURE', 'false').lower() == 'true'
TALISMAN_ENABLED = os.environ.get('SUPERSET_TALISMAN_ENABLED', 'false').lower() == 'true'

# Embedding is part of the Apache-2.0 build, not a paid feature, but it is not
# configured here: doing it securely needs a guest role and token secret, and
# this stack is a reporting destination rather than an embedded product.
