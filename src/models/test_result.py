from src.models.user import db
from datetime import datetime

class TestResult(db.Model):
    """Represents a laboratory test result."""
    __tablename__ = 'test_results'

    id = db.Column(db.Integer, primary_key=True)
    client_id = db.Column(db.Integer, db.ForeignKey('clients.id'), nullable=False)
    # Scopes a result to the specific booking it came from (structured results-entry feature).
    # Nullable: pre-existing rows (there are none in production) and any future ad-hoc row
    # created outside that flow won't have one.
    visit_id = db.Column(db.Integer, db.ForeignKey('patient_visits.id', ondelete='CASCADE'), nullable=True)
    lab_test_id = db.Column(db.Integer, db.ForeignKey('lab_tests.id', ondelete='RESTRICT'), nullable=True)
    test_name = db.Column(db.String(200), nullable=False)  # e.g., "Complete Blood Count", "Blood Glucose"
    test_category = db.Column(db.String(100))  # e.g., "Hematology", "Chemistry", "Serology"
    sample_type = db.Column(db.String(100))  # e.g., "Blood", "Urine", "Serum"
    
    # Test parameters and results
    parameter_name = db.Column(db.String(200))  # e.g., "WBC", "RBC", "Hemoglobin"
    result_value = db.Column(db.String(100))  # The actual result value
    unit = db.Column(db.String(50))  # e.g., "cells/µL", "g/dL"
    reference_range = db.Column(db.String(100))  # e.g., "4.5-11.0"
    status = db.Column(db.String(50), default='pending')  # pending, completed, abnormal, normal
    
    # Dates
    sample_collection_date = db.Column(db.DateTime)
    test_completion_date = db.Column(db.DateTime)
    
    # Additional notes
    technician_notes = db.Column(db.Text)
    pathologist_notes = db.Column(db.Text)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'client_id': self.client_id,
            'visit_id': self.visit_id,
            'lab_test_id': self.lab_test_id,
            'test_name': self.test_name,
            'test_category': self.test_category,
            'sample_type': self.sample_type,
            'parameter_name': self.parameter_name,
            'result_value': self.result_value,
            'unit': self.unit,
            'reference_range': self.reference_range,
            'status': self.status,
            'sample_collection_date': self.sample_collection_date.isoformat() if self.sample_collection_date else None,
            'test_completion_date': self.test_completion_date.isoformat() if self.test_completion_date else None,
            'technician_notes': self.technician_notes,
            'pathologist_notes': self.pathologist_notes,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }
