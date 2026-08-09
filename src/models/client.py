from src.models.user import db
from datetime import datetime, date, time

class Client(db.Model):
    """Represents a client/patient in the laboratory management system."""
    __tablename__ = 'clients'
    
    id = db.Column(db.Integer, primary_key=True)
    first_name = db.Column(db.String(100), nullable=False)
    last_name = db.Column(db.String(100), nullable=False)
    date_of_birth = db.Column(db.Date, nullable=False)
    gender = db.Column(db.String(20), nullable=False)
    contact_person = db.Column(db.String(200), nullable=False)  # Changed from parent_name
    phone = db.Column(db.String(20), nullable=False)
    client_phone = db.Column(db.String(20))  # Client's own phone number
    
    # Address components
    city = db.Column(db.String(100))
    area = db.Column(db.String(100))
    street = db.Column(db.String(100))
    apartment = db.Column(db.String(50))
    
    # Lab-specific fields
    blood_type = db.Column(db.String(5))
    allergies = db.Column(db.Text)  # JSON string for multiple allergies
    clinical_indications = db.Column(db.Text)  # Changed from medical_history
    
    # Vital signs (current/latest measurements)
    temperature = db.Column(db.Float)  # in Celsius
    blood_pressure_systolic = db.Column(db.Integer)
    blood_pressure_diastolic = db.Column(db.Integer)
    weight = db.Column(db.Float)  # in kg
    height = db.Column(db.Float)  # in cm
    
    # Lab appointment/test management
    test_date = db.Column(db.Date)  # Date of test
    test_time = db.Column(db.Time)  # Time of test
    test_datetime = db.Column(db.DateTime)  # Combined datetime
    test_type = db.Column(db.String(100))  # e.g., blood test, urine test, etc.
    sample_status = db.Column(db.String(20), default='pending')  # pending, collected, processing, completed
    technician_notes = db.Column(db.Text)
    status = db.Column(db.String(50), default='scheduled')  # scheduled, in_progress, completed, cancelled
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def set_test_datetime(self, test_date_val, test_time_val):
        """Set test date and time, and update the combined datetime field"""
        self.test_date = test_date_val
        self.test_time = test_time_val
        
        if test_date_val and test_time_val:
            self.test_datetime = datetime.combine(test_date_val, test_time_val)
        elif test_date_val:
            # If only date is provided, set time to 00:00
            self.test_datetime = datetime.combine(test_date_val, time(0, 0))
        else:
            self.test_datetime = None
    
    def get_test_datetime_combined(self):
        """Get the combined test datetime"""
        if self.test_date and self.test_time:
            return datetime.combine(self.test_date, self.test_time)
        elif self.test_datetime:
            return self.test_datetime
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
        combined_datetime = self.get_test_datetime_combined()
        
        return {
            'id': self.id,
            'first_name': self.first_name,
            'last_name': self.last_name,
            'date_of_birth': self.date_of_birth.isoformat() if self.date_of_birth else None,
            'gender': self.gender,
            'contact_person': self.contact_person,
            'phone': self.phone,
            'client_phone': self.client_phone,
            'city': self.city,
            'area': self.area,
            'street': self.street,
            'apartment': self.apartment,
            'full_address': self.get_full_address(),
            'blood_type': self.blood_type,
            'allergies': self.allergies,
            'clinical_indications': self.clinical_indications,
            'temperature': self.temperature,
            'blood_pressure_systolic': self.blood_pressure_systolic,
            'blood_pressure_diastolic': self.blood_pressure_diastolic,
            'weight': self.weight,
            'height': self.height,
            'test_date': self.test_date.isoformat() if self.test_date else None,
            'test_time': self.test_time.isoformat() if self.test_time else None,
            'test_datetime': combined_datetime.isoformat() if combined_datetime else None,
            'test_type': self.test_type,
            'sample_status': self.sample_status,
            'technician_notes': self.technician_notes,
            'status': self.status,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }
    
    def __repr__(self):
        return f'<Client {self.first_name} {self.last_name}>'
