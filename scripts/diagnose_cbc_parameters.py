#!/usr/bin/env python3
"""
Read-only diagnostic for the CBC test's TestParameterTemplate rows — lists every parameter
(id, name, category, parent, display_order, absolute_count_formula) and flags any name that
appears more than once for this test, together with how many historical TestResult rows exist
under that name.

Why this matters: apply_cbc_categorization.py (the script that tags/creates CBC's report
categories) deliberately refuses to touch a name that appears more than once, since it can't
tell which duplicate row a given historical result was meant for — TestResult.parameter_name is
a plain string match, not a foreign key to a specific template id. This script tells you exactly
which names are duplicated and whether either one has real result history, so a merge/delete can
be done by hand with actual information instead of a guess.

Never writes anything — no --in-place flag exists because there's nothing to opt out of. Safe
to run directly against a real, live database.

Usage:
    lab_app/bin/python scripts/diagnose_cbc_parameters.py
    lab_app/bin/python scripts/diagnose_cbc_parameters.py --db database/app.db
"""
import os
import sys
import argparse
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CBC_TEST_NAME_CANDIDATES = ['Complete Blood Count (CBC)', 'CBC', 'Complete Blood Count']


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--db', default='database/app.db', help='Database file to inspect (read-only)')
    args = parser.parse_args()

    db_path = os.path.abspath(args.db)
    if not os.path.exists(db_path):
        print(f"ERROR: database not found: {db_path}")
        sys.exit(1)

    os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"

    from src.main import app
    from src.models.user import LabTest
    from src.models.test_parameter import TestParameterTemplate
    from src.models.test_result import TestResult

    with app.app_context():
        print(f"Inspecting (read-only): {db_path}\n")

        cbc = None
        for name in CBC_TEST_NAME_CANDIDATES:
            cbc = LabTest.query.filter(LabTest.name == name).first()
            if cbc:
                break
        if not cbc:
            candidates = LabTest.query.filter(LabTest.name.ilike('%CBC%')).all()
            if len(candidates) == 1:
                cbc = candidates[0]
            elif candidates:
                print("Multiple possible CBC tests found — pass the right one via CBC_TEST_NAME_CANDIDATES:")
                for c in candidates:
                    print(f'  - "{c.name}" (id={c.id})')
                sys.exit(1)
        if not cbc:
            print("No LabTest matching CBC found in this database.")
            sys.exit(1)

        print(f'CBC test: "{cbc.name}" (id={cbc.id})\n')

        params = (TestParameterTemplate.query.filter_by(lab_test_id=cbc.id)
                  .order_by(TestParameterTemplate.display_order).all())
        name_counts = Counter(p.name for p in params)

        print(f"{'id':>5}  {'name':<28} {'category':<20} {'parent_id':<10} {'order':<6} formula")
        print('-' * 100)
        for p in params:
            flag = '  <-- DUPLICATE NAME' if name_counts[p.name] > 1 else ''
            print(f"{p.id:>5}  {p.name:<28} {(p.category or '-'):<20} "
                  f"{str(p.parent_parameter_id or '-'):<10} {p.display_order:<6} "
                  f"{p.absolute_count_formula or '-'}{flag}")

        duplicates = [name for name, count in name_counts.items() if count > 1]
        if not duplicates:
            print("\nNo duplicate names found — nothing needs manual merging.")
            return

        print(f"\n{len(duplicates)} duplicate name(s) found:")
        for name in duplicates:
            result_count = TestResult.query.filter_by(lab_test_id=cbc.id, parameter_name=name).count()
            ids = [p.id for p in params if p.name == name]
            if result_count == 0:
                print(f'  - "{name}" (ids {ids}): 0 historical results ever saved under this name — '
                      f'safe to keep any one of these rows and delete the rest.')
            else:
                print(f'  - "{name}" (ids {ids}): {result_count} historical result(s) saved under this name. '
                      f'TestResult stores the name as text only, not a specific template id, so that '
                      f'history stays intact regardless of which of these rows you keep — but review '
                      f'the rows\' other fields (reference ranges, formulas) before deleting one, in case '
                      f'they were configured differently for a reason.')


if __name__ == '__main__':
    main()
