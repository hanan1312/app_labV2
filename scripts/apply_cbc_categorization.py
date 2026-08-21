#!/usr/bin/env python3
"""
Applies the CBC (Complete Blood Count) report redesign's parameter setup to any database that
already has a "Complete Blood Count (CBC)" LabTest — matched by test/parameter NAME, not id,
so it's safe to run against a database whose row ids differ from wherever this was developed
(e.g. a production server with real patients already booked against the existing CBC test,
where lab_tests.id / test_parameter_templates.id will not match a dev machine's numbering).

Splits CBC's report into the two sections added by that redesign — "Blood Picture" and
"Differential Count" (see TestParameterTemplate.category / parent_parameter_id and
_render_categorized_test in src/routes/reports.py) — by tagging parameters with the right
category and, for Neutrophils' Segmented/Band sub-rows, the right parent_parameter_id.

Conservative on purpose, given this is meant to run against a real lab's live data:
  - An EXISTING parameter (matched by name) only gets its category/parent_parameter_id set —
    its name/unit/reference ranges/existing formulas are left exactly as configured, since a
    live lab's own clinical values should never be silently overwritten by this script.
  - A MISSING parameter (e.g. this lab never had WBC/MCV/MCHC/RDW/Monocytes/Eosinophils/
    Basophils/Segmented/Band as tracked parameters yet) is created fresh, using the reference
    values from the original redesign work (see docs/waiting_app.md) — printed clearly so
    they can be reviewed/adjusted afterward in the Test Directory's Parameters editor.
  - display_order for new parameters is appended after whatever already exists in that
    category (existing rows' display_order is never renumbered) — safe regardless of this
    lab's own existing numbering scheme. Report section grouping doesn't depend on exact
    ordering across categories, only on it being consistent within each one.
  - absolute_count_formula/unit/range is only set on a parameter that doesn't already have a
    formula — an existing customized formula is left untouched.
  - One specific existing-value exception, called out explicitly when it fires: Neutrophils'
    relative reference range is corrected to "30 - 75" if (and only if) it's still the
    original seed value "40 - 75" — this matches the reference report image the redesign was
    built against. If this lab's Neutrophils range is anything else, it's left alone.

Also recognizes common name variants for a handful of parameters (e.g. a lab that already
tracks "WBC" rather than "WBCs (Leukocytes)", or "Monocyte"/"Eosinophile"/"Basophile" instead
of the plural English forms) — see NAME_SYNONYMS below — so an existing differently-named
parameter gets tagged in place rather than sitting alongside a newly-created duplicate. If this
script already ran on a database *before* a given synonym was added here, re-running it won't
retroactively merge any duplicate it already created — see scripts/diagnose_cbc_parameters.py
to check for that and decide how to merge by hand.

Idempotent — safe to re-run; matches existing rows by name (or known synonym) rather than
creating duplicates. Also warns (without changing anything) if it finds more than one existing
parameter sharing the exact same name for this test — a pre-existing data-quality issue no
name-matching logic can safely resolve on its own, since either row could have real historical
results tied to it.

Safe by default: this script NEVER opens your real database file directly. It always makes a
throwaway copy first and points itself at that copy (see --source/--dest below), the same
"never the live file" convention already used by seed_synthetic_data.py / seed_expiry_batches.py.

Usage:
    lab_app/bin/python scripts/apply_cbc_categorization.py
    lab_app/bin/python scripts/apply_cbc_categorization.py --source database/app.db --dest /tmp/app_test.db

Then point a throwaway server at the copy to click through it in the browser:
    DATABASE_URL=sqlite:////absolute/path/to/the/dest/file BACKEND_PORT=9052 lab_app/bin/python -m src.main

--in-place opts out of the copy-first safety net and edits --source directly. Only use this
once you've verified the results against a copy and are sure you want them for real.
"""
import os
import sys
import shutil
import argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CBC_TEST_NAME_CANDIDATES = ['Complete Blood Count (CBC)', 'CBC', 'Complete Blood Count']

# canonical name (as used in BLOOD_PICTURE/DIFFERENTIAL below) -> other names a lab might
# already be using for the same parameter. Checked case-insensitively. Extend this if another
# environment turns out to use yet another spelling — cheaper than a database cleanup.
NAME_SYNONYMS = {
    'WBCs (Leukocytes)': ['WBC', 'WBCs', 'Leukocytes', 'WBC Count', 'Total Leukocyte Count'],
    'Monocytes': ['Monocyte'],
    'Eosinophils': ['Eosinophile', 'Eosinophil'],
    'Basophils': ['Basophile', 'Basophil'],
}

# name, unit, ref_low, ref_high, reference_range_text, category
BLOOD_PICTURE = [
    ('Hemoglobin (Hb)', 'g/dL', 12.0, 17.0, '12.0 - 17.0'),
    ('RBC', '10^6/uL', 4.2, 5.9, '4.2 - 5.9'),
    ('Hematocrit (HCT)', '%', 36.0, 52.0, '36 - 52'),
    ('MCV', 'fL/cell', 83.0, 101.0, '83 - 101'),
    ('MCH', 'pg', 27.0, 33.0, '27 - 33'),
    ('MCHC', 'g/dL', 31.5, 37.5, '31.5 - 37.5'),
    ('RDW', '%', 11.6, 14.0, '11.6 - 14.0'),
    ('Platelet Count', '10^3/uL', 150.0, 450.0, '150 - 450'),
    ('WBCs (Leukocytes)', 'x10³/mm³', 4.0, 10.0, '4.0 - 10.0'),
]

# name, ref_low, ref_high, reference_range_text, parent_name (or None),
# absolute_unit, absolute_ref_low, absolute_ref_high
DIFFERENTIAL = [
    ('Neutrophils', 30.0, 75.0, '30 - 75', None, 'K/uL', 2.0, 7.0),
    ('Segmented', 30.0, 75.0, '30 - 75', 'Neutrophils', 'K/uL', 2.0, 7.0),
    ('Band', 0.0, 3.0, '0 - 3', 'Neutrophils', 'K/uL', 0.0, 1.2),
    ('Lymphocytes', 20.0, 45.0, '20 - 45', None, 'K/uL', 1.0, 3.5),
    ('Monocytes', 2.0, 10.0, '2 - 10', None, 'K/uL', 0.2, 1.0),
    ('Eosinophils', 1.0, 6.0, '1 - 6', None, 'K/uL', 0.02, 0.5),
    ('Basophils', 0.0, 1.0, '0 - 1', None, 'K/uL', 0.02, 0.1),
]


def find_cbc_test(LabTest):
    for name in CBC_TEST_NAME_CANDIDATES:
        test = LabTest.query.filter(LabTest.name == name).first()
        if test:
            return test
    candidates = LabTest.query.filter(LabTest.name.ilike('%CBC%')).all() \
        or LabTest.query.filter(LabTest.name.ilike('%complete blood count%')).all()
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        names = ', '.join(f'"{c.name}" (id={c.id})' for c in candidates)
        print(f"ERROR: multiple possible CBC tests found, ambiguous: {names}")
        print("Rename one to an exact match or edit CBC_TEST_NAME_CANDIDATES in this script.")
        sys.exit(1)
    return None


def apply_cbc_categorization():
    from collections import Counter
    from src.models.user import db, LabTest
    from src.models.test_parameter import TestParameterTemplate

    cbc = find_cbc_test(LabTest)
    if not cbc:
        print("ERROR: no LabTest matching CBC was found in this database — nothing to do.")
        print(f"Looked for exact names: {CBC_TEST_NAME_CANDIDATES}, then a case-insensitive '%CBC%' match.")
        sys.exit(1)
    print(f'Found CBC test: "{cbc.name}" (id={cbc.id})')

    all_params = TestParameterTemplate.query.filter_by(lab_test_id=cbc.id).all()

    # A pre-existing duplicate name is structurally ambiguous for this script (and for the
    # report renderer's own (test_id, parameter_name) template lookup) — either row could be
    # the one with real historical TestResult data tied to it, so this only warns rather than
    # guessing which to tag/merge. See scripts/diagnose_cbc_parameters.py to investigate.
    name_counts = Counter(p.name for p in all_params)
    duplicate_names = [name for name, count in name_counts.items() if count > 1]
    if duplicate_names:
        print(f'\nWARNING: {len(duplicate_names)} parameter name(s) appear more than once for this test — '
              f'not safe to auto-tag, left entirely untouched:')
        for name in duplicate_names:
            print(f'  - "{name}" ({name_counts[name]} rows)')
        print('  Resolve manually in Test Directory > CBC > Parameters (merge/rename/delete the extra '
              'row) — run scripts/diagnose_cbc_parameters.py first if you need to see which one has real results.\n')

    existing_by_name = {p.name: p for p in all_params if name_counts[p.name] == 1}

    def resolve_existing(canonical_name):
        """Finds a pre-existing row for `canonical_name`, also checking NAME_SYNONYMS (e.g. a
        lab that already tracks "WBC" rather than "WBCs (Leukocytes)") — returns the row under
        whatever name it's ACTUALLY stored as (never renames it). Caches the result under the
        canonical name too, so later lookups-by-canonical-name (e.g. the WBC id used to build
        every differential parameter's absolute_count_formula) work regardless of which real
        name matched."""
        if canonical_name in existing_by_name:
            return existing_by_name[canonical_name]
        for alt in NAME_SYNONYMS.get(canonical_name, []):
            match = next((p for p in all_params if p.name.strip().lower() == alt.lower()
                          and name_counts[p.name] == 1), None)
            if match:
                existing_by_name[canonical_name] = match
                return match
        return None

    next_order = (max((p.display_order or 0) for p in existing_by_name.values()) + 10) \
        if existing_by_name else 10

    created, tagged, skipped_existing_values = [], [], []

    def next_display_order():
        nonlocal next_order
        value = next_order
        next_order += 10
        return value

    # --- Blood Picture ---
    for name, unit, ref_low, ref_high, ref_text in BLOOD_PICTURE:
        row = resolve_existing(name)
        if row:
            if row.category != 'Blood Picture':
                row.category = 'Blood Picture'
                tagged.append(name if row.name == name else f'{row.name} (matched "{name}")')
        else:
            row = TestParameterTemplate(
                lab_test_id=cbc.id, name=name, unit=unit, ref_low=ref_low, ref_high=ref_high,
                reference_range_text=ref_text, display_order=next_display_order(),
                category='Blood Picture',
            )
            db.session.add(row)
            db.session.flush()
            existing_by_name[name] = row
            created.append(name)

    # --- Differential Count (two passes: create/tag parents before resolving children's
    # parent_parameter_id, since a just-created parent needs its real id first) ---
    for name, ref_low, ref_high, ref_text, parent_name, abs_unit, abs_low, abs_high in DIFFERENTIAL:
        row = resolve_existing(name)
        if row:
            if row.category != 'Differential Count':
                row.category = 'Differential Count'
                tagged.append(name if row.name == name else f'{row.name} (matched "{name}")')
            if name == 'Neutrophils' and row.reference_range_text == '40 - 75' \
                    and row.ref_low == 40 and row.ref_high == 75:
                row.ref_low, row.ref_high, row.reference_range_text = 30.0, 75.0, '30 - 75'
                print('  -> Corrected Neutrophils relative range 40-75 -> 30-75 (matches the reference report image).')
            elif name == 'Neutrophils' and row.reference_range_text != '30 - 75':
                skipped_existing_values.append(
                    f'Neutrophils (existing range "{row.reference_range_text}" left as-is — neither the original seed value nor the reference-image value, so not touched)')
        else:
            row = TestParameterTemplate(
                lab_test_id=cbc.id, name=name, ref_low=ref_low, ref_high=ref_high,
                reference_range_text=ref_text, display_order=next_display_order(),
                category='Differential Count',
            )
            db.session.add(row)
            db.session.flush()
            existing_by_name[name] = row
            created.append(name)

        if not row.absolute_count_formula:
            row.absolute_count_unit = abs_unit
            row.absolute_ref_low = abs_low
            row.absolute_ref_high = abs_high
            db.session.flush()
            row.absolute_count_formula = f'{{{row.id}}} / 100 * {{{existing_by_name["WBCs (Leukocytes)"].id}}}'
        else:
            skipped_existing_values.append(f'{name} (existing absolute_count_formula left as-is)')

    for name, _ref_low, _ref_high, _ref_text, parent_name, *_ in DIFFERENTIAL:
        if parent_name:
            child = existing_by_name[name]
            parent = existing_by_name[parent_name]
            if child.parent_parameter_id != parent.id:
                child.parent_parameter_id = parent.id
                tagged.append(f'{name} (parent -> {parent_name})')

    db.session.commit()

    print(f'\nCreated {len(created)} new parameter(s): {created or "none"}')
    print(f'Tagged {len(tagged)} existing parameter(s) with category/parent: {tagged or "none"}')
    if skipped_existing_values:
        print(f'Left untouched (already customized on this database):')
        for note in skipped_existing_values:
            print(f'  - {note}')
    print('\nReview the new/changed parameters in Test Directory > CBC > Parameters before relying on them.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", default="database/app.db", help="Database file to copy from (never edited directly unless --in-place)")
    parser.add_argument("--dest", default=None, help="Where to write the copy (default: <source>.cbctest.db next to --source)")
    parser.add_argument("--in-place", action="store_true", help="Edit --source directly instead of a copy. Only use once you're sure.")
    args = parser.parse_args()

    if args.in_place:
        target_path = os.path.abspath(args.source)
        print(f"--in-place set: editing {target_path} directly.")
    else:
        source_path = os.path.abspath(args.source)
        if not os.path.exists(source_path):
            print(f"ERROR: source database not found: {source_path}")
            sys.exit(1)
        dest_path = os.path.abspath(args.dest) if args.dest else source_path + ".cbctest.db"
        shutil.copy2(source_path, dest_path)
        target_path = dest_path
        print(f"Copied {source_path} -> {target_path} (original left untouched).")

    os.environ["DATABASE_URL"] = f"sqlite:///{target_path}"

    from src.main import app
    with app.app_context():
        print(f"Target database: {app.config.get('SQLALCHEMY_DATABASE_URI')}")
        apply_cbc_categorization()

    if not args.in_place:
        print()
        print("Done. Your real database was never touched. To browse the results:")
        print(f"  DATABASE_URL=sqlite:///{target_path} BACKEND_PORT=9052 lab_app/bin/python -m src.main")
        print(f"Then open http://localhost:9052 — once you're happy, re-run with --in-place, or: rm {target_path}")


if __name__ == '__main__':
    main()
