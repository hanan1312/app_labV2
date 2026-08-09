from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = 'users'
    
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default='user')  # 'admin' or 'user'
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime)
    # permissions used to live here as a comma-separated string; now in user_permissions
    # (see src/models/junctions.py) — DEFAULT_PERMISSIONS there replaces this column's default=.

    def set_password(self, password):
        """Set password hash"""
        self.password_hash = generate_password_hash(password)
    
    def check_password(self, password):
        """Check if provided password matches hash"""
        return check_password_hash(self.password_hash, password)
    
    def is_admin(self):
        """Check if user is admin"""
        return self.role == 'admin'

    def __repr__(self):
        return f'<User {self.username}>'

    def to_dict(self):
        return {
            'id': self.id,
            'username': self.username,
            'email': self.email,
            'role': self.role,
            'is_active': self.is_active,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'last_login': self.last_login.isoformat() if self.last_login else None
        }
    

class LabTest(db.Model):
    __tablename__ = 'lab_tests'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    sample_type = db.Column(db.String(100), default="Unspecified")
    price = db.Column(db.Float, nullable=False)
    

class TransactionList(db.Model):
    __tablename__ = 'transactions_list'
    id = db.Column(db.Integer, primary_key=True)
    transaction_id = db.Column(db.String(100), unique=True, nullable=False)
    patient_id = db.Column(db.Integer, nullable=False)
    patient_name = db.Column(db.String(255))
    patient_phone = db.Column(db.String(50))
    date = db.Column(db.String(100))
    # tests/prices used to live here as JSON strings; now in transaction_line_items
    # (see src/models/junctions.py, get_transaction_test_names())
    total_price = db.Column(db.Float)
    discount_percentage = db.Column(db.Integer)
    payment_method = db.Column(db.String(50))
    final_payment = db.Column(db.Float)


class PatientVisit(db.Model):
    __tablename__ = 'patient_visits'
    id = db.Column(db.Integer, primary_key=True)
    patient_id = db.Column(db.Integer, db.ForeignKey('clients.id'))
    patient_name = db.Column(db.String(255))
    visit_id = db.Column(db.String(100), unique=True) # Date+Time+PID
    date = db.Column(db.String(100))
    status = db.Column(db.String(50), default='pending') # pending, collected, delivered_link, delivered_hard
    referred_by = db.Column(db.String(200), default='Self')  # shown on the generated report
    # test_names/report_url used to live here (JSON string / comma-separated paths); now in
    # visit_tests/visit_reports (see src/models/junctions.py, get_visit_test_names()/get_visit_report_url())


class WarehouseItem(db.Model):
    __tablename__ = 'warehouse_items'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(150), nullable=False)
    category = db.Column(db.String(50), nullable=False)
    quantity = db.Column(db.Integer, default=0)
    critical_level = db.Column(db.Integer, default=5) # <--- NEW FIELD
    unit = db.Column(db.String(50), nullable=True)
    updated_at = db.Column(db.DateTime, default=db.func.current_timestamp(), onupdate=db.func.current_timestamp())

# NEW TABLE FOR BILLS
class WarehouseBill(db.Model):
    __tablename__ = 'warehouse_bills'
    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.String(50), unique=True, nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey('warehouse_items.id'), nullable=False)
    item_name = db.Column(db.String(150))
    present_stock = db.Column(db.Integer)
    ordered_stock = db.Column(db.Integer)
    unit = db.Column(db.String(50))
    price_per_unit = db.Column(db.Float)
    total_price = db.Column(db.Float)
    category = db.Column(db.String(50))
    user = db.Column(db.String(100))
    date_time = db.Column(db.String(50))
    status = db.Column(db.String(20), default='demanded') # demanded, ordered, delivered
    # Groups multiple bills created together via the "New Bill" bulk-ordering flow so
    # they display/print as one record; NULL for the older single-item quick-order flow
    # (openNewBillModal), which still creates a single standalone bill.
    work_order_id = db.Column(db.String(50), nullable=True)


# Warehouse "Work Order": issuing/using up stock (as opposed to WarehouseBill, which is
# stock coming IN via purchase). One row per item, grouped by a shared work_order_id — same
# flat, no-separate-header-row shape as WarehouseBill's bulk-order grouping. Quantities are
# deducted from WarehouseItem.quantity immediately on creation (see create_work_order() in
# main.py); there's no pending/delivered lifecycle like bills have.
class WarehouseWorkOrder(db.Model):
    __tablename__ = 'warehouse_work_orders'
    id = db.Column(db.Integer, primary_key=True)
    work_order_id = db.Column(db.String(50), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey('warehouse_items.id'), nullable=False)
    item_name = db.Column(db.String(150))
    quantity = db.Column(db.Integer)
    unit = db.Column(db.String(50))
    category = db.Column(db.String(50))
    user = db.Column(db.String(100))
    date_time = db.Column(db.String(50))


class Employee(db.Model):
    __tablename__ = 'employees'
    
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    role = db.Column(db.String(50), nullable=False) # e.g., Pathologist, Phlebotomist, Secretary
    phone = db.Column(db.String(20))
    email = db.Column(db.String(100), nullable=True)
    salary = db.Column(db.Float, default=0.0)
    status = db.Column(db.String(20), default='Active') # Active, On Leave, Terminated
    join_date = db.Column(db.DateTime, nullable=True)
    username = db.Column(db.String(80), nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'role': self.role,
            'phone': self.phone,
            'email': self.email,
            'salary': self.salary,
            'status': self.status,
            'join_date': self.join_date.strftime("%Y-%m-%d") if self.join_date else "",
            'username': self.username
        }
    


