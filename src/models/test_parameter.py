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

    # Optional gender-specific ranges — some parameters (e.g. Hemoglobin, Creatinine) differ
    # between male/female. When gender_specific is False, ref_low/ref_high above are used for
    # everyone (unchanged legacy behavior).
    gender_specific = db.Column(db.Boolean, default=False)
    ref_low_male = db.Column(db.Float)
    ref_high_male = db.Column(db.Float)
    ref_low_female = db.Column(db.Float)
    ref_high_female = db.Column(db.Float)

    # Optional auto-calculation: this parameter's value can be derived from one or more other
    # parameters of the same LabTest (e.g. MCV derived from HCT and RBC). relation_formula is
    # an arithmetic expression where each referenced parameter appears as a stable "{id}"
    # token, e.g. "{55} / {56} * 10" — see _validate_relation_formula in src/routes/reports.py
    # for how it's built/validated, and the Result Parameters modal (script_lab.js) for the
    # Excel-like "[Name]" editing form the {id} tokens are translated to/from. Purely a
    # results-entry auto-fill convenience (see results_entry.js) — never evaluated or enforced
    # server-side against a saved TestResult, so a technician can always override the
    # auto-filled value by hand.
    #
    # An earlier version of this feature supported only a single dependency via a
    # related_template_id FK column (still physically present in the database — SQLite can't
    # cheaply drop a column, and it's harmless left unused) plus a formula using a bare "X"
    # placeholder; main.py's startup migration rewrites any such old-format row into the
    # {id}-token form the first time it runs against a given database.
    relation_formula = db.Column(db.String(300))

    # Optional "Absolute Count" — a second, independently-tracked derived value alongside the
    # main result (e.g. Absolute Neutrophil Count computed from Neutrophils% and WBC). Same
    # {id}-token formula grammar/validation as relation_formula (_validate_absolute_count_formula
    # in src/routes/reports.py), but — unlike relation_formula — self-reference is expected and
    # allowed: an absolute count is very often computed from the parameter's own percentage
    # value, and since it's never fed back in as another formula's input there's no cycle to
    # guard against. Carries its own unit and (non-gender-specific) reference range, since an
    # absolute count's normal range is numerically unrelated to the percentage's.
    absolute_count_formula = db.Column(db.String(300))
    absolute_count_unit = db.Column(db.String(50))
    absolute_ref_low = db.Column(db.Float)
    absolute_ref_high = db.Column(db.Float)

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
            'gender_specific': bool(self.gender_specific),
            'ref_low_male': self.ref_low_male,
            'ref_high_male': self.ref_high_male,
            'ref_low_female': self.ref_low_female,
            'ref_high_female': self.ref_high_female,
            'relation_formula': self.relation_formula,
            'absolute_count_formula': self.absolute_count_formula,
            'absolute_count_unit': self.absolute_count_unit,
            'absolute_ref_low': self.absolute_ref_low,
            'absolute_ref_high': self.absolute_ref_high,
        }
