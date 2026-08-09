#!/usr/bin/env python3
"""
Adds warehouse_bills.work_order_id — groups multiple bills created together via the new
"Work Order" bulk-ordering flow (src/main.py: create_work_order()) so they display/print as
one record in Bills History. NULL for the older single-item quick-order flow
(openNewBillModal / create_warehouse_bill()), which still creates a single standalone bill.

Idempotent: safe to re-run (ADD COLUMN is skipped if it already exists).

Usage:
    python scripts/add_warehouse_bill_work_order_id.py
"""
import sys
from pathlib import Path

from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.main import app
from src.models.user import db


def main():
    with app.app_context():
        try:
            db.session.execute(text("ALTER TABLE warehouse_bills ADD COLUMN work_order_id VARCHAR(50)"))
            db.session.commit()
            print("Added warehouse_bills.work_order_id")
        except Exception:
            db.session.rollback()
            print("warehouse_bills.work_order_id already exists, skipping ADD COLUMN")


if __name__ == '__main__':
    main()
