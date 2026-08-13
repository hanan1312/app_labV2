from src.models.user import db
from datetime import datetime, date, time
from src.utils.timezone import utc_to_cairo

class Patient(db.Model):
    __tablename__ = 'patients'
    
    id = db.Column(db.Integer, primary_key=True)
    first_name = db.Column(db.String(100), nullable=False)
    last_name = db.Column(db.String(100), nullable=False)
    date_of_birth = db.Column(db.Date, nullable=False)
    gender = db.Column(db.String(20), nullable=False)
    parent_name = db.Column(db.String(200), nullable=False)
    phone = db.Column(db.String(20), nullable=False)
    patient_phone = db.Column(db.String(20))  # Patient's own phone number
    
    # Address components
    city = db.Column(db.String(100))
    area = db.Column(db.String(100))
    street = db.Column(db.String(100))
    apartment = db.Column(db.String(50))
    
    blood_type = db.Column(db.String(5))
    allergies = db.Column(db.Text)  # JSON string for multiple allergies
    medical_history = db.Column(db.Text)
    
    # Vital signs (current/latest measurements)
    temperature = db.Column(db.Float)  # in Celsius
    blood_pressure_systolic = db.Column(db.Integer)
    blood_pressure_diastolic = db.Column(db.Integer)
    weight = db.Column(db.Float)  # in kg
    height = db.Column(db.Float)  # in cm
    
    # New fields for visit management - SPLIT DATE AND TIME
    visit_date = db.Column(db.Date)  # Date of visit
    visit_time = db.Column(db.Time)  # Time of visit
    visit_datetime = db.Column(db.DateTime)  # Combined datetime (for backward compatibility)
    visit_type = db.Column(db.String(50))  # examination, fast examination, consultation
    hall_status = db.Column(db.String(20), default='Out')  # In, Out
    doctor_comments = db.Column(db.Text)
    status = db.Column(db.String(50), default='waiting')  # waiting, in_hall, finished
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def set_visit_datetime(self, visit_date_val, visit_time_val):
        """Set visit date and time, and update the combined datetime field"""
        self.visit_date = visit_date_val
        self.visit_time = visit_time_val
        
        if visit_date_val and visit_time_val:
            self.visit_datetime = datetime.combine(visit_date_val, visit_time_val)
        elif visit_date_val:
            # If only date is provided, set time to 00:00
            self.visit_datetime = datetime.combine(visit_date_val, time(0, 0))
        else:
            self.visit_datetime = None
    
    def get_visit_datetime_combined(self):
        """Get the combined visit datetime"""
        if self.visit_date and self.visit_time:
            return datetime.combine(self.visit_date, self.visit_time)
        elif self.visit_datetime:
            return self.visit_datetime
        return None
    
    def get_full_address(self):
        """Return address as a sentence"""
        address_parts = []
        if self.apartment:
            address_parts.append(f"Apartment {self.apartment}")
        if self.street:
            address_parts.append(self.street)
        if self.area:
            address_parts.append(self.area)
        if self.city:
            address_parts.append(self.city)
        return ", ".join(address_parts) if address_parts else ""
    
    def to_dict(self):
        # Get the combined datetime for backward compatibility
        combined_datetime = self.get_visit_datetime_combined()
        
        return {
            'id': self.id,
            'first_name': self.first_name,
            'last_name': self.last_name,
            'date_of_birth': self.date_of_birth.isoformat() if self.date_of_birth else None,
            'gender': self.gender,
            'parent_name': self.parent_name,
            'phone': self.phone,
            'patient_phone': self.patient_phone,
            'city': self.city,
            'area': self.area,
            'street': self.street,
            'apartment': self.apartment,
            'full_address': self.get_full_address(),
            'blood_type': self.blood_type,
            'allergies': self.allergies,
            'medical_history': self.medical_history,
            'temperature': self.temperature,
            'blood_pressure_systolic': self.blood_pressure_systolic,
            'blood_pressure_diastolic': self.blood_pressure_diastolic,
            'weight': self.weight,
            'height': self.height,
            'visit_date': self.visit_date.isoformat() if self.visit_date else None,
            'visit_time': self.visit_time.isoformat() if self.visit_time else None,
            'visit_datetime': combined_datetime.isoformat() if combined_datetime else None,
            'visit_type': self.visit_type,
            'hall_status': self.hall_status,
            'doctor_comments': self.doctor_comments,
            'status': self.status,
            'created_at': utc_to_cairo(self.created_at).isoformat() if self.created_at else None,
            'updated_at': utc_to_cairo(self.updated_at).isoformat() if self.updated_at else None
        }
    
    def __repr__(self):
        return f'<Patient {self.first_name} {self.last_name}>'

