"""Idempotently create the Superset admin and the CSV-upload database.

`superset init` creates the roles and permissions. This script then does the two
things a fresh install needs for Inicio:

1. one admin account, if it does not already exist; and
2. a Postgres connection named "Inicio BI" pointing at the separate `inicio_bi`
   database, with file uploads enabled and the `public` schema allowed.

No password is written to a file or printed. The values arrive from the compose
environment, which is loaded from the gitignored `.env`.
"""
import json
import os

from superset import db, security_manager
from superset.app import create_app
from superset.models.core import Database


def main() -> None:
    app = create_app()
    with app.app_context():
        username = os.environ['SUPERSET_ADMIN_USER']
        if security_manager.find_user(username=username) is None:
            role = security_manager.find_role('Admin')
            if role is None:
                raise RuntimeError('the Admin role is missing; run `superset init` first')
            security_manager.add_user(
                username=username,
                first_name='Inicio',
                last_name='Admin',
                email=os.environ['SUPERSET_ADMIN_EMAIL'],
                role=role,
                password=os.environ['SUPERSET_ADMIN_PASSWORD'],
            )
            db.session.commit()

        name = os.environ.get('SUPERSET_BI_DATABASE_NAME', 'Inicio BI')
        uri = os.environ['SUPERSET_BI_DATABASE_URI']
        extra = json.dumps({'schemas_allowed_for_file_upload': ['public']})
        database = db.session.query(Database).filter_by(database_name=name).one_or_none()
        if database is None:
            db.session.add(
                Database(
                    database_name=name,
                    sqlalchemy_uri=uri,
                    expose_in_sqllab=True,
                    allow_file_upload=True,
                    extra=extra,
                )
            )
            db.session.commit()
        else:
            # A stack that was started before uploads were enabled should be
            # repaired in place rather than requiring a fresh volume.
            database.allow_file_upload = True
            database.extra = extra
            db.session.commit()


if __name__ == '__main__':
    main()
