#!/usr/bin/env python3
"""
Phase 3 final step (docs/schema_migration_plan.md): drops the 5 legacy TEXT/JSON columns
now that every read and write site has been cut over to the junction tables in
src/models/junctions.py. Run scripts/backfill_junction_tables.py and
scripts/add_visit_tests_position.py first if you haven't already — this script does not
migrate any data, it only removes columns nothing reads anymore.

SQLite 3.35+ supports ALTER TABLE ... DROP COLUMN directly (no copy-table dance needed).
Idempotent: a column that's already gone is skipped, not an error.

Usage:
    python scripts/drop_legacy_columns.py [path/to/db]
"""
import sys
from pathlib import Path

from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.main import app
from src.models.user import db

DROPS = [
    ("users", "permissions"),
    ("patient_visits", "test_names"),
    ("patient_visits", "report_url"),
    ("transactions_list", "tests"),
    ("transactions_list", "prices"),
]


def main():
    with app.app_context():
        db.session.bind = app.lab_engine  # both engines = database/app.db today
        for table, column in DROPS:
            try:
                db.session.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
                db.session.commit()
                print(f"Dropped {table}.{column}")
            except Exception as e:
                db.session.rollback()
                print(f"Skipped {table}.{column}: {e}")


if __name__ == '__main__':
    main()
