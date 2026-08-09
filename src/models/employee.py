from .user import db
from datetime import datetime

class Employee(db.Model):
    __tablename__ = 'employees'
    
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    role = db.Column(db.String(50), nullable=False) # e.g., Pathologist, Phlebotomist, Secretary
    phone = db.Column(db.String(20))
    email = db.Column(db.String(100))
    salary = db.Column(db.Float, default=0.0)
    status = db.Column(db.String(20), default='Active') # Active, On Leave, Terminated
    join_date = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'role': self.role,
            'phone': self.phone,
            'email': self.email,
            'salary': self.salary,
            'status': self.status,
            'join_date': self.join_date.strftime("%Y-%m-%d") if self.join_date else ""
        }