from src.models.user import db


class TestParameterTemplate(db.Model):
    """Reusable per-LabTest template of expected result parameters (e.g. CBC always has
    WBC, RBC, Hemoglobin...). Drives the results-entry schema and the generated report."""
    __tablename__ = 'test_parameter_templates'

    id = db.Column(db.Integer, primary_key=True)
    lab_test_id = db.Column(db.Integer, db.ForeignKey('lab_tests.id', ondelete='CASCADE'), nullable=False)
    name = db.Column(db.String(200), nullable=False)  # e.g. "WBC", "S. Bilirubin (Total)"
    unit = db.Column(db.String(50))  # e.g. "g/dl", "IU/L"
    method = db.Column(db.String(100))  # e.g. "Diazo Method" — shown under the name on the report
    ref_low = db.Column(db.Float)  # nullable: non-numeric ranges (e.g. "Negative") set this to None
    ref_high = db.Column(db.Float)
    reference_range_text = db.Column(db.String(100))  # display value, e.g. "0 - 1.2" or "Negative"
    display_order = db.Column(db.Integer, nullable=False, default=0)
    abnormal_note = db.Column(db.Text)  # shown in the report's Interpretation box when out of range

    def to_dict(self):
        return {
            'id': self.id,
            'lab_test_id': self.lab_test_id,
            'name': self.name,
            'unit': self.unit,
            'method': self.method,
            'ref_low': self.ref_low,
            'ref_high': self.ref_high,
            'reference_range_text': self.reference_range_text,
            'display_order': self.display_order,
            'abnormal_note': self.abnormal_note,
        }
