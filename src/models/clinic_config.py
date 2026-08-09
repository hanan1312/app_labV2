from src.models.user import db
from datetime import datetime
import json

class ClinicConfig(db.Model):
    __tablename__ = 'clinic_config'
    
    id = db.Column(db.Integer, primary_key=True)
    doctor_name = db.Column(db.String(200), nullable=False, default='Dr. [Name]')
    clinic_name = db.Column(db.String(200), nullable=False, default='Pediatric Clinic')
    clinic_phone = db.Column(db.String(50), nullable=False, default='[Phone]')
    clinic_address = db.Column(db.Text)
    logo_path = db.Column(db.String(500))
    
    # NEW: Store active features as a JSON string
    # By default, all standard features are turned ON
    active_features = db.Column(db.Text, default=json.dumps([
        "dashboard", "new-reservation", "patients", "add-patient", 
        "awaiting-hall", "finished-reservations", "patient-history", 
        "hall-status-manager", "reports", "financial"
    ]))
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    @classmethod
    def get_config(cls):
        """Get the clinic configuration, create default if doesn't exist"""
        config = cls.query.first()
        if not config:
            config = cls()
            db.session.add(config)
            db.session.commit()
        return config
    
    def to_dict(self):
        # Safely parse the features string back into a list
        try:
            features_list = json.loads(self.active_features) if self.active_features else []
        except:
            features_list = []
            
        return {
            'id': self.id,
            'doctor_name': self.doctor_name,
            'clinic_name': self.clinic_name,
            'clinic_phone': self.clinic_phone,
            'clinic_address': self.clinic_address,
            'logo_path': self.logo_path,
            'active_features': features_list, # Send to frontend as an array
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }