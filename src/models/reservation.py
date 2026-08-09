from src.models.user import db
from datetime import datetime

class Reservation(db.Model):
    __tablename__ = 'reservations'

    id = db.Column(db.Integer, primary_key=True)
    patient_id = db.Column(db.Integer, db.ForeignKey('patients.id'), nullable=False)
    visit_datetime = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    visit_type = db.Column(db.String(100))
    status = db.Column(db.String(50), default='scheduled') # e.g., 'finished'
    doctor_notes = db.Column(db.Text) # For the comments you requested

    def to_dict(self):
        return {
            'id': self.id,
            'patient_id': self.patient_id,
            'visit_datetime': self.visit_datetime.isoformat(),
            'visit_type': self.visit_type,
            'status': self.status,
            'doctor_notes': self.doctor_notes
        }