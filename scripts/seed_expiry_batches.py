#!/usr/bin/env python3
"""
Adds expiry-dated WarehouseBatch rows to already-seeded warehouse data, so the expiry-flag /
red-flag filter / Item Batches / FEFO-ordering features have something realistic to show —
without ever touching the database you actually use.

Safe by default: this script NEVER opens your real database file directly. It always makes a
throwaway copy first and points itself at that copy (see --source/--dest below), the same
"never the live file" convention already used by seed_synthetic_data.py.

For each existing WarehouseBill with status='delivered' that has no WarehouseBatch yet (same
"already received" check the real /receive endpoint uses), creates one batch with a
randomized expiry date — a mix of already-expired, expiring-soon, and comfortably-valid, so
every new UI state (the red flag, "Expired Only" filter, oldest-first sorting, the admin
disposal-review list) has real data to exercise. Does NOT touch WarehouseItem.quantity — this
is purely additive test metadata, not a simulation of the real receiving workflow.

Usage:
    lab_app/bin/python scripts/seed_expiry_batches.py
    lab_app/bin/python scripts/seed_expiry_batches.py --source database/app.db --dest /tmp/app_test.db

Then point a throwaway server at the copy to click through it in the browser:
    DATABASE_URL=sqlite:////absolute/path/to/the/dest/file BACKEND_PORT=9052 lab_app/bin/python -m src.main

--in-place opts out of the copy-first safety net and edits --source directly. Only use this
once you've verified the results against a copy and are sure you want them for real.
"""
import os
import sys
import shutil
import random
import secrets
import argparse
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def mint_barcode(batch_id):
    return f"WB-{batch_id:06d}-{secrets.token_hex(3)}"


def random_expiry_date(today):
    """15% already expired, 20% expiring soon (still valid, good for FEFO warnings), 65%
    comfortably valid — enough spread to see every new UI state on realistic-looking data."""
    roll = random.random()
    if roll < 0.15:
        return today - timedelta(days=random.randint(1, 60))
    elif roll < 0.35:
        return today + timedelta(days=random.randint(1, 30))
    else:
        return today + timedelta(days=random.randint(60, 500))


def seed_expiry_batches():
    from src.models.user import db, WarehouseBill, WarehouseBatch

    today = datetime.now().date()
    candidates = [
        b for b in WarehouseBill.query.filter_by(status='delivered').all()
        if not WarehouseBatch.query.filter_by(bill_id=b.id).first()
    ]

    if not candidates:
        print("No delivered-but-unreceived bills found — nothing to do "
              "(run seed_synthetic_data.py first, or seed_warehouse_batches --clear already ran).")
        return

    print(f"Creating batches for {len(candidates)} delivered bill(s)...")
    expired_count = 0
    for bill in candidates:
        expiry_date = random_expiry_date(today)
        if expiry_date < today:
            expired_count += 1

        batch = WarehouseBatch(
            item_id=bill.item_id, bill_id=bill.id, item_name=bill.item_name,
            unit=bill.unit, category=bill.category,
            barcode='PENDING', expiry_date=expiry_date,
            quantity_received=bill.ordered_stock, quantity_remaining=bill.ordered_stock,
            status='active', received_by=bill.user,
            received_at=datetime.now() - timedelta(days=random.randint(0, 30)),
        )
        db.session.add(batch)
        db.session.flush()  # populate batch.id for the barcode
        batch.barcode = mint_barcode(batch.id)

    db.session.commit()
    print(f"  -> {len(candidates)} batches created, {expired_count} already expired "
          f"(exercises the red-flag/Expired-Only/disposal-review flows).")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", default="database/app.db", help="Database file to copy from (never edited directly unless --in-place)")
    parser.add_argument("--dest", default=None, help="Where to write the copy (default: <source>.expirytest.db next to --source)")
    parser.add_argument("--in-place", action="store_true", help="Edit --source directly instead of a copy. Only use once you're sure.")
    parser.add_argument("--seed", type=int, default=None, help="Random seed for reproducibility")
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    if args.in_place:
        target_path = os.path.abspath(args.source)
        print(f"--in-place set: editing {target_path} directly.")
    else:
        source_path = os.path.abspath(args.source)
        if not os.path.exists(source_path):
            print(f"ERROR: source database not found: {source_path}")
            sys.exit(1)
        dest_path = os.path.abspath(args.dest) if args.dest else source_path + ".expirytest.db"
        shutil.copy2(source_path, dest_path)
        target_path = dest_path
        print(f"Copied {source_path} -> {target_path} (original left untouched).")

    os.environ["DATABASE_URL"] = f"sqlite:///{target_path}"

    from src.main import app
    with app.app_context():
        print(f"Target database: {app.config.get('SQLALCHEMY_DATABASE_URI')}")
        seed_expiry_batches()

    if not args.in_place:
        print()
        print("Done. Your real database was never touched. To browse the results:")
        print(f"  DATABASE_URL=sqlite:///{target_path} BACKEND_PORT=9052 lab_app/bin/python -m src.main")
        print(f"Then open http://localhost:9052 — once you're happy, discard the copy: rm {target_path}")


if __name__ == "__main__":
    main()
