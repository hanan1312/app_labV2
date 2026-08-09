#!/usr/bin/env python3
"""
Phase 3 one-off migration (docs/schema_migration_plan.md): adds visit_tests.position and
backfills it from patient_visits.test_names' original JSON order, before that column is
dropped. visit_tests has no other ordering column (composite PK only) — without this, a
join-based read can't reproduce the original test-selection order the UI displays.

Idempotent: safe to re-run (ADD COLUMN is skipped if it already exists; backfill just
recomputes the same positions from test_names, which isn't touched).

Usage:
    python scripts/add_visit_tests_position.py [path/to/db]
"""
import json
import sys
from pathlib import Path

from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.main import app
from src.models.user import db, LabTest
from src.models.junctions import VisitTest


def main():
    with app.app_context():
        db.session.bind = app.lab_engine  # both engines = database/app.db today

        try:
            db.session.execute(text("ALTER TABLE visit_tests ADD COLUMN position INTEGER DEFAULT 0"))
            db.session.commit()
            print("Added visit_tests.position")
        except Exception:
            db.session.rollback()
            print("visit_tests.position already exists, skipping ADD COLUMN")

        # Read test_names via raw SQL: the PatientVisit model no longer maps that column
        # (it's mid-removal in Phase 3), but the physical column is still there for now.
        visits = db.session.execute(text("SELECT id, test_names FROM patient_visits")).fetchall()

        tests_by_name = {t.name: t.id for t in LabTest.query.all()}
        updated = 0
        for visit_id, test_names_raw in visits:
            try:
                names = json.loads(test_names_raw) if test_names_raw else []
            except (json.JSONDecodeError, TypeError):
                names = []
            for position, name in enumerate(names):
                test_id = tests_by_name.get(name)
                if test_id is None:
                    continue
                row = VisitTest.query.filter_by(visit_id=visit_id, lab_test_id=test_id).first()
                if row is not None:
                    row.position = position
                    updated += 1
        db.session.commit()
        print(f"Backfilled position for {updated} visit_tests rows")


if __name__ == '__main__':
    main()
