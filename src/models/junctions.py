"""
Junction tables from docs/schema_migration_plan.md.

Phase 1 (done): these sit alongside the existing TEXT/JSON columns they're derived from
(users.permissions, clients.allergies, patient_visits.test_names/report_url,
transactions_list.tests). One-time backfill: scripts/backfill_junction_tables.py.

Phase 2 (done): the write sites in src/main.py and src/routes/user.py call the sync_*/
add_* helpers below on every write, so these tables stay live instead of being a stale
one-time snapshot. client_allergies is excluded throughout: clients.allergies is free
text typed into a textarea, not a real repeating value, so splitting it on commas would
silently corrupt any entry containing a comma that isn't meant as a separator (see
docs/schema_migration_plan.md).

Phase 3 (in progress): read sites are cutting over to these tables too, and the old
TEXT/JSON columns are being dropped once nothing reads them. sync_user_permissions() no
longer reads users.permissions (that column is going away) — callers pass the permission
string directly; DEFAULT_PERMISSIONS replaces what used to be the column's default=.
"""
from src.models.user import db, LabTest

# Was users.permissions' db.Column(default=...) — kept here now that new-user creation no
# longer sets that column directly.
DEFAULT_PERMISSIONS = 'dashboard,patients,tests,samples,reports,financial'


def sync_user_permissions(user, permissions):
    """Rebuild user_permissions for `user` from a comma-separated permissions string. Call
    after every permissions change, once user.id exists. Caller commits."""
    UserPermission.query.filter_by(user_id=user.id).delete()
    for perm in (permissions or '').split(','):
        perm = perm.strip()
        if perm:
            db.session.add(UserPermission(user_id=user.id, permission=perm))


def sync_visit_tests(visit, test_names):
    """Rebuild visit_tests for `visit` from a list of lab_tests.name strings, preserving
    selection order via `position` (visit_tests has no other ordering column). Names with
    no matching lab_tests row are skipped (e.g. a test renamed/deleted after the form
    loaded). Caller commits."""
    VisitTest.query.filter_by(visit_id=visit.id).delete()
    tests_by_name = {t.name: t.id for t in LabTest.query.all()}
    for position, name in enumerate(test_names or []):
        test_id = tests_by_name.get(name)
        if test_id is not None:
            db.session.add(VisitTest(visit_id=visit.id, lab_test_id=test_id, position=position))


def add_visit_reports(visit, file_paths):
    """Append visit_reports rows for newly-uploaded PDFs (upload_report() appends to the
    existing report_url string rather than replacing it, so this appends too). Caller
    commits."""
    for path in file_paths or []:
        path = (path or '').strip()
        if path:
            db.session.add(VisitReport(visit_id=visit.id, file_path=path))


def sync_transaction_line_items(transaction, test_names, prices):
    """Rebuild transaction_line_items for `transaction` from parallel test-name/price lists
    (the real per-test prices selected at booking time — see save_transaction() in
    src/main.py). Names with no matching lab_tests row are skipped. Caller commits."""
    TransactionLineItem.query.filter_by(transaction_id=transaction.id).delete()
    tests_by_name = {t.name: t.id for t in LabTest.query.all()}
    for name, price in zip(test_names or [], prices or []):
        test_id = tests_by_name.get(name)
        if test_id is not None:
            db.session.add(TransactionLineItem(
                transaction_id=transaction.id,
                lab_test_id=test_id,
                price_at_sale=price,
            ))


def get_visit_test_names(visit_id):
    """Ordered list of test names for a visit — replaces json.loads(patient_visits.test_names)."""
    rows = (db.session.query(LabTest.name)
            .join(VisitTest, VisitTest.lab_test_id == LabTest.id)
            .filter(VisitTest.visit_id == visit_id)
            .order_by(VisitTest.position)
            .all())
    return [r[0] for r in rows]


def get_completed_test_names(visit_id):
    """Ordered list of booked test names for a visit that have at least one saved
    TestResult row — used to render partial-delivery status text (e.g. "CBC delivered")
    while other booked tests are still pending. Lazy-imports TestResult to avoid a
    circular import (test_result.py -> user.py, this module -> user.py)."""
    from src.models.test_result import TestResult
    rows = (db.session.query(LabTest.name)
            .join(VisitTest, VisitTest.lab_test_id == LabTest.id)
            .filter(VisitTest.visit_id == visit_id)
            .filter(VisitTest.lab_test_id.in_(
                db.session.query(TestResult.lab_test_id)
                .filter(TestResult.visit_id == visit_id, TestResult.lab_test_id.isnot(None))
            ))
            .order_by(VisitTest.position)
            .all())
    return [r[0] for r in rows]


def get_visit_report_url(visit_id):
    """Comma-joined report paths for a visit, or None if there are none — same shape the
    frontend already expects from patient_visits.report_url (it does report_url.split(','))."""
    rows = VisitReport.query.filter_by(visit_id=visit_id).order_by(VisitReport.id).all()
    return ','.join(r.file_path for r in rows) or None


def get_transaction_test_names(transaction_id):
    """Ordered list of test names for a transaction — replaces json.loads(transactions_list.tests)."""
    rows = (db.session.query(LabTest.name)
            .join(TransactionLineItem, TransactionLineItem.lab_test_id == LabTest.id)
            .filter(TransactionLineItem.transaction_id == transaction_id)
            .order_by(TransactionLineItem.id)
            .all())
    return [r[0] for r in rows]


class UserPermission(db.Model):
    __tablename__ = 'user_permissions'
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    permission = db.Column(db.String(50), primary_key=True)


class ClientAllergy(db.Model):
    __tablename__ = 'client_allergies'
    client_id = db.Column(db.Integer, db.ForeignKey('clients.id', ondelete='CASCADE'), primary_key=True)
    allergen = db.Column(db.String(100), primary_key=True)


class VisitTest(db.Model):
    __tablename__ = 'visit_tests'
    visit_id = db.Column(db.Integer, db.ForeignKey('patient_visits.id', ondelete='CASCADE'), primary_key=True)
    lab_test_id = db.Column(db.Integer, db.ForeignKey('lab_tests.id', ondelete='RESTRICT'), primary_key=True)
    position = db.Column(db.Integer, nullable=False, default=0)
    comment = db.Column(db.Text)  # technician's note for this test, entered at results-entry time; shown in the report footer
    page_number = db.Column(db.Integer)  # which custom report page this test is assigned to; NULL = default single-flow layout


class VisitReportPage(db.Model):
    """A user-defined report page grouping for one visit (per-visit, one-off — not a
    reusable template). Presence of any row for a visit switches build_report_context()
    from the default single-flow layout to this page-grouped one."""
    __tablename__ = 'visit_report_pages'
    id = db.Column(db.Integer, primary_key=True)
    visit_id = db.Column(db.Integer, db.ForeignKey('patient_visits.id', ondelete='CASCADE'), nullable=False)
    page_number = db.Column(db.Integer, nullable=False)
    title = db.Column(db.String(200))
    subtitle = db.Column(db.String(200))


class VisitReport(db.Model):
    __tablename__ = 'visit_reports'
    id = db.Column(db.Integer, primary_key=True)
    visit_id = db.Column(db.Integer, db.ForeignKey('patient_visits.id', ondelete='CASCADE'), nullable=False)
    file_path = db.Column(db.String(500), nullable=False)
    uploaded_at = db.Column(db.DateTime)


class TransactionLineItem(db.Model):
    __tablename__ = 'transaction_line_items'
    id = db.Column(db.Integer, primary_key=True)
    transaction_id = db.Column(db.Integer, db.ForeignKey('transactions_list.id', ondelete='CASCADE'), nullable=False)
    lab_test_id = db.Column(db.Integer, db.ForeignKey('lab_tests.id', ondelete='RESTRICT'), nullable=False)
    price_at_sale = db.Column(db.Float, nullable=False)
