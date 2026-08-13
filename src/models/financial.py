from src.models.user import db
from datetime import datetime
from decimal import Decimal

# class ServiceType(db.Model):
#     __tablename__ = 'service_types'
    
#     id = db.Column(db.Integer, primary_key=True)
#     name = db.Column(db.String(100), unique=True, nullable=False)
#     description = db.Column(db.Text)
#     default_price = db.Column(db.Numeric(10, 2), nullable=False)
#     is_active = db.Column(db.Boolean, default=True)
#     created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
#     # Relationship with transactions
#     # transactions = db.relationship('Transaction', backref='service_type_ref', lazy=True)
    
#     def to_dict(self):
#         return {
#             'id': self.id,
#             'name': self.name,
#             'description': self.description,
#             'default_price': float(self.default_price) if self.default_price else 0,
#             'is_active': self.is_active,
#             'created_at': self.created_at.isoformat() if self.created_at else None
#         }
    
#     def __repr__(self):
#         return f'<ServiceType {self.name}>'

# class Transaction(db.Model):
#     __tablename__ = 'transactions'
    
#     id = db.Column(db.Integer, primary_key=True)
#     patient_id = db.Column(db.Integer, db.ForeignKey('patients.id'), nullable=False)
#     service_type_id = db.Column(db.Integer, db.ForeignKey('service_types.id'), nullable=False)
#     amount = db.Column(db.Numeric(10, 2), nullable=False)
#     payment_method = db.Column(db.String(50), nullable=False)  # cash, card, insurance, bank_transfer
#     transaction_date = db.Column(db.DateTime, default=datetime.utcnow)
#     description = db.Column(db.Text)
#     status = db.Column(db.String(20), default='completed')  # completed, pending, cancelled, refunded
#     created_by = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
#     created_at = db.Column(db.DateTime, default=datetime.utcnow)
#     updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
#     # Relationships
#     patient = db.relationship('Patient', backref='transactions', lazy=True)
#     # service_type = db.relationship('ServiceType', backref='service_transactions', lazy=True)
#     service_type = db.relationship('ServiceType', backref='transactions', lazy=True)
#     created_by_user = db.relationship('User', backref='created_transactions', lazy=True)
    
#     def to_dict(self):
#         return {
#             'id': self.id,
#             'patient_id': self.patient_id,
#             'patient_name': f"{self.patient.first_name} {self.patient.last_name}" if self.patient else None,
#             'service_type_id': self.service_type_id,
#             'service_type_name': self.service_type.name if self.service_type else None,
#             'amount': float(self.amount) if self.amount else 0,
#             'payment_method': self.payment_method,
#             'transaction_date': self.transaction_date.isoformat() if self.transaction_date else None,
#             'description': self.description,
#             'status': self.status,
#             'created_by': self.created_by,
#             'created_by_username': self.created_by_user.username if self.created_by_user else None,
#             'created_at': self.created_at.isoformat() if self.created_at else None,
#             'updated_at': self.updated_at.isoformat() if self.updated_at else None
#         }
    
#     def __repr__(self):
#         return f'<Transaction {self.id}: {self.amount} - {self.payment_method}>'

# # Payment method choices for validation
# PAYMENT_METHODS = ['cash', 'card', 'insurance', 'bank_transfer']
# TRANSACTION_STATUSES = ['completed', 'pending', 'cancelled', 'refunded']
from src.models.user import db
from datetime import datetime
from decimal import Decimal
from src.utils.timezone import utc_to_cairo

class ServiceType(db.Model):
    __tablename__ = 'service_types'
    
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), unique=True, nullable=False)
    description = db.Column(db.Text)
    default_price = db.Column(db.Numeric(10, 2), nullable=False)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    # 1. Replaced backref with explicit back_populates
    transactions = db.relationship(
        'Transaction', 
        back_populates='service_type', 
        overlaps="service_transactions,service_type_ref", 
        lazy=True
    )
    
    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'default_price': float(self.default_price) if self.default_price else 0,
            'is_active': self.is_active,
            'created_at': utc_to_cairo(self.created_at).isoformat() if self.created_at else None
        }

    def __repr__(self):
        return f'<ServiceType {self.name}>'

class Transaction(db.Model):
    __tablename__ = 'transactions'
    
    id = db.Column(db.Integer, primary_key=True)
    patient_id = db.Column(db.Integer, db.ForeignKey('patients.id'), nullable=False)
    service_type_id = db.Column(db.Integer, db.ForeignKey('service_types.id'), nullable=False)
    amount = db.Column(db.Numeric(10, 2), nullable=False)
    remaining = db.Column(db.Numeric(10, 2), default=0.00)
    price_comment = db.Column(db.Text, nullable=True)
    payment_method = db.Column(db.String(50), nullable=False)  # cash, card, insurance, bank_transfer
    transaction_date = db.Column(db.DateTime, default=datetime.utcnow)
    description = db.Column(db.Text)
    status = db.Column(db.String(20), default='completed')  # completed, pending, cancelled, refunded
    created_by = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    patient = db.relationship('Patient', backref='transactions', lazy=True)
    created_by_user = db.relationship('User', backref='created_transactions', lazy=True)
    
    # 2. Replaced backref with explicit back_populates pointing back to ServiceType
    service_type = db.relationship(
        'ServiceType', 
        back_populates='transactions', 
        overlaps="service_transactions,service_type_ref", 
        lazy=True
    )
    
    def to_dict(self):
        return {
            'id': self.id,
            'patient_id': self.patient_id,
            'patient_name': f"{self.patient.first_name} {self.patient.last_name}" if self.patient else None,
            'service_type_id': self.service_type_id,
            'service_type_name': self.service_type.name if self.service_type else None,
            'amount': float(self.amount) if self.amount else 0,
            'payment_method': self.payment_method,
            'transaction_date': utc_to_cairo(self.transaction_date).isoformat() if self.transaction_date else None,
            'description': self.description,
            'status': self.status,
            'created_by': self.created_by,
            'created_by_username': self.created_by_user.username if self.created_by_user else None,
            'created_at': utc_to_cairo(self.created_at).isoformat() if self.created_at else None,
            'updated_at': utc_to_cairo(self.updated_at).isoformat() if self.updated_at else None
        }

    def __repr__(self):
        return f'<Transaction {self.id}: {self.amount} - {self.payment_method}>'

# Payment method choices for validation
PAYMENT_METHODS = ['cash', 'card', 'insurance', 'bank_transfer']
TRANSACTION_STATUSES = ['completed', 'pending', 'cancelled', 'refunded']

