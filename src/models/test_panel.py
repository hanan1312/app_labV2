from src.models.user import db


class TestPanel(db.Model):
    """A named bundle of LabTests (e.g. "Lipid Profile") for quick-select while booking.
    Purely a UI convenience — member tests are still individual VisitTest rows, no different
    from being checked one at a time. Starts empty; admin creates/edits/deletes freely."""
    __tablename__ = 'test_panels'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)


class TestPanelItem(db.Model):
    __tablename__ = 'test_panel_items'
    id = db.Column(db.Integer, primary_key=True)
    panel_id = db.Column(db.Integer, db.ForeignKey('test_panels.id', ondelete='CASCADE'), nullable=False)
    lab_test_id = db.Column(db.Integer, db.ForeignKey('lab_tests.id', ondelete='RESTRICT'), nullable=False)
    position = db.Column(db.Integer, default=0)
