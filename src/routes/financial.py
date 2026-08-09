from flask import Blueprint, jsonify, request, session
from src.models.user import User, db
from src.models.financial import Transaction, ServiceType, PAYMENT_METHODS, TRANSACTION_STATUSES
from src.models.patient import Patient
from src.routes.user import admin_required, login_required
from datetime import datetime, timedelta
from sqlalchemy import func, extract, desc
from decimal import Decimal

financial_bp = Blueprint('financial', __name__)

@financial_bp.route('/dashboard', methods=['GET'])
@admin_required
def get_dashboard_data():
    """Get financial dashboard overview data"""
    try:
        now = datetime.utcnow()
        today = now.date()
        week_start = today - timedelta(days=today.weekday())
        month_start = today.replace(day=1)
        year_start = today.replace(month=1, day=1)
        
        # Total revenue calculations
        total_revenue_today = db.session.query(func.sum(Transaction.amount)).filter(
            func.date(Transaction.transaction_date) == today,
            Transaction.status == 'completed'
        ).scalar() or 0
        
        total_revenue_week = db.session.query(func.sum(Transaction.amount)).filter(
            func.date(Transaction.transaction_date) >= week_start,
            Transaction.status == 'completed'
        ).scalar() or 0
        
        total_revenue_month = db.session.query(func.sum(Transaction.amount)).filter(
            func.date(Transaction.transaction_date) >= month_start,
            Transaction.status == 'completed'
        ).scalar() or 0
        
        total_revenue_year = db.session.query(func.sum(Transaction.amount)).filter(
            func.date(Transaction.transaction_date) >= year_start,
            Transaction.status == 'completed'
        ).scalar() or 0
        
        # Transaction counts
        transactions_today = Transaction.query.filter(
            func.date(Transaction.transaction_date) == today
        ).count()
        
        transactions_month = Transaction.query.filter(
            func.date(Transaction.transaction_date) >= month_start
        ).count()
        
        # Average transaction value
        avg_transaction = db.session.query(func.avg(Transaction.amount)).filter(
            Transaction.status == 'completed'
        ).scalar() or 0
        
        # Most popular service type
        popular_service = db.session.query(
            ServiceType.name,
            func.count(Transaction.id).label('count')
        ).join(Transaction).filter(
            Transaction.status == 'completed'
        ).group_by(ServiceType.id).order_by(desc('count')).first()
        
        return jsonify({
            'revenue': {
                'today': float(total_revenue_today),
                'week': float(total_revenue_week),
                'month': float(total_revenue_month),
                'year': float(total_revenue_year)
            },
            'transactions': {
                'today': transactions_today,
                'month': transactions_month
            },
            'average_transaction': float(avg_transaction),
            'popular_service': popular_service[0] if popular_service else 'N/A'
        }), 200
        
    except Exception as e:
        print(f"Error in get_dashboard_data: {e}")
        return jsonify({'error': str(e)}), 500

@financial_bp.route('/analytics/revenue', methods=['GET'])
@admin_required
def get_revenue_analytics():
    """Get revenue analytics data for charts"""
    try:
        period = request.args.get('period', 'month')  # day, week, month, year
        
        if period == 'day':
            # Last 30 days
            start_date = datetime.utcnow() - timedelta(days=30)
            revenue_data = db.session.query(
                func.date(Transaction.transaction_date).label('date'),
                func.sum(Transaction.amount).label('revenue')
            ).filter(
                Transaction.transaction_date >= start_date,
                Transaction.status == 'completed'
            ).group_by(func.date(Transaction.transaction_date)).all()
            
        elif period == 'month':
            # Last 12 months
            start_date = datetime.utcnow() - timedelta(days=365)
            revenue_data = db.session.query(
                extract('year', Transaction.transaction_date).label('year'),
                extract('month', Transaction.transaction_date).label('month'),
                func.sum(Transaction.amount).label('revenue')
            ).filter(
                Transaction.transaction_date >= start_date,
                Transaction.status == 'completed'
            ).group_by(
                extract('year', Transaction.transaction_date),
                extract('month', Transaction.transaction_date)
            ).all()
        
        # Revenue by service type
        service_revenue = db.session.query(
            ServiceType.name,
            func.sum(Transaction.amount).label('revenue')
        ).join(Transaction).filter(
            Transaction.status == 'completed'
        ).group_by(ServiceType.id).all()
        
        # Revenue by payment method
        payment_revenue = db.session.query(
            Transaction.payment_method,
            func.sum(Transaction.amount).label('revenue')
        ).filter(
            Transaction.status == 'completed'
        ).group_by(Transaction.payment_method).all()
        
        return jsonify({
            'revenue_trend': [
                {
                    'date': str(item[0]) if period == 'day' else f"{int(item[0])}-{int(item[1]):02d}",
                    'revenue': float(item[-1])
                } for item in revenue_data
            ],
            'service_revenue': [
                {
                    'service': item[0],
                    'revenue': float(item[1])
                } for item in service_revenue
            ],
            'payment_revenue': [
                {
                    'method': item[0],
                    'revenue': float(item[1])
                } for item in payment_revenue
            ]
        }), 200
        
    except Exception as e:
        print(f"Error in get_revenue_analytics: {e}")
        return jsonify({'error': str(e)}), 500

@financial_bp.route('/transactions', methods=['GET'])
@admin_required
def get_transactions():
    """Get transactions with pagination and filters"""
    try:
        page = int(request.args.get('page', 1))
        per_page = int(request.args.get('per_page', 20))
        status = request.args.get('status')
        payment_method = request.args.get('payment_method')
        service_type_id = request.args.get('service_type_id')
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        
        query = Transaction.query
        
        # Apply filters
        if status:
            query = query.filter(Transaction.status == status)
        if payment_method:
            query = query.filter(Transaction.payment_method == payment_method)
        if service_type_id:
            query = query.filter(Transaction.service_type_id == service_type_id)
        if start_date:
            query = query.filter(Transaction.transaction_date >= datetime.fromisoformat(start_date))
        if end_date:
            query = query.filter(Transaction.transaction_date <= datetime.fromisoformat(end_date))
        
        # Order by most recent first
        query = query.order_by(desc(Transaction.transaction_date))
        
        # Paginate
        transactions = query.paginate(
            page=page, per_page=per_page, error_out=False
        )
        
        return jsonify({
            'transactions': [t.to_dict() for t in transactions.items],
            'total': transactions.total,
            'pages': transactions.pages,
            'current_page': page,
            'per_page': per_page
        }), 200
        
    except Exception as e:
        print(f"Error in get_transactions: {e}")
        return jsonify({'error': str(e)}), 500




@financial_bp.route('/transactions', methods=['POST'])
@login_required
def create_transaction():
    """Create new transaction - available to all authenticated users"""
    try:
        data = request.get_json()
        
        # Validate required fields
        required_fields = ['patient_id', 'service_type_id', 'amount', 'payment_method']
        for field in required_fields:
            if field not in data or data[field] is None:
                return jsonify({'error': f'Missing required field: {field}'}), 400
        
        # Validate payment method
        if data['payment_method'] not in PAYMENT_METHODS:
            return jsonify({'error': f'Invalid payment method. Must be one of: {PAYMENT_METHODS}'}), 400
        
        # Validate patient exists
        patient = Patient.query.get(data['patient_id'])
        if not patient:
            return jsonify({'error': 'Patient not found'}), 404
        
        # Validate service type exists
        # service_type = ServiceType.query.get(data['service_type_id'])
        # if not service_type:
        #     return jsonify({'error': 'Service type not found'}), 404
        service_input = data['service_type_id']
        service_type = None

        # Try ID lookup first, then Name lookup as fallback
        print("service_type: ", service_type)
        service_input = str(data.get('service_type_id', '')).strip()

# 2. Try ID lookup first
        if service_input.isdigit():
            service_type = ServiceType.query.get(int(service_input))

        # 3. Try Name lookup fallback
        if not service_type and service_input:
            service_type = ServiceType.query.filter(ServiceType.name.ilike(service_input)).first()

        # 4. Final check
        if not service_type:
            return jsonify({'error': f'Service type "{service_input}" not found'}), 404
        
        # Calculate remaining balance
        default_price = Decimal(str(service_type.default_price))
        paid_amount = Decimal(str(data['amount']))
        remaining_balance = Decimal('0.00')
        price_comment = data.get('price_comment', '')

        if paid_amount < default_price:
            remaining_balance = Decimal(default_price - paid_amount)
            print("remaining_balance: ", remaining_balance)
            # Ensure a comment exists if there is a remaining balance
            if not price_comment:
                return jsonify({'error': 'A comment is required for underpayments.'}), 400

        transaction = Transaction(
            patient_id=data['patient_id'],
            service_type_id=service_type.id,
            amount=paid_amount,
            remaining=remaining_balance, # New Field
            price_comment=price_comment, # New Field
            payment_method=data['payment_method'],
            transaction_date=datetime.utcnow(),
            created_by=session['user_id']
        )
        
        db.session.add(transaction)
        db.session.commit()
        
        return jsonify(transaction.to_dict()), 201
        
    except Exception as e:
        db.session.rollback()
        print(f"Error in create_transaction: {e}")
        return jsonify({'error': str(e)}), 500

@financial_bp.route('/transactions/<int:transaction_id>', methods=['PUT'])
@admin_required
def update_transaction(transaction_id):
    """Update transaction"""
    try:
        transaction = Transaction.query.get_or_404(transaction_id)
        data = request.get_json()
        
        # Update fields if provided
        if 'amount' in data:
            transaction.amount = Decimal(str(data['amount']))
        if 'payment_method' in data:
            if data['payment_method'] not in PAYMENT_METHODS:
                return jsonify({'error': f'Invalid payment method. Must be one of: {PAYMENT_METHODS}'}), 400
            transaction.payment_method = data['payment_method']
        if 'transaction_date' in data:
            transaction.transaction_date = datetime.fromisoformat(data['transaction_date'])
        if 'description' in data:
            transaction.description = data['description']
        if 'status' in data:
            if data['status'] not in TRANSACTION_STATUSES:
                return jsonify({'error': f'Invalid status. Must be one of: {TRANSACTION_STATUSES}'}), 400
            transaction.status = data['status']
        
        transaction.updated_at = datetime.utcnow()
        db.session.commit()
        
        return jsonify(transaction.to_dict()), 200
        
    except Exception as e:
        db.session.rollback()
        print(f"Error in update_transaction: {e}")
        return jsonify({'error': str(e)}), 500

@financial_bp.route('/transactions/<int:transaction_id>', methods=['DELETE'])
@admin_required
def delete_transaction(transaction_id):
    """Delete transaction"""
    try:
        transaction = Transaction.query.get_or_404(transaction_id)
        db.session.delete(transaction)
        db.session.commit()
        
        return jsonify({'message': 'Transaction deleted successfully'}), 200
        
    except Exception as e:
        db.session.rollback()
        print(f"Error in delete_transaction: {e}")
        return jsonify({'error': str(e)}), 500

@financial_bp.route('/service-types', methods=['GET'])
@login_required
def get_service_types():
    """Get all service types - available to all authenticated users"""
    try:
        service_types = ServiceType.query.filter_by(is_active=True).all()
        return jsonify([st.to_dict() for st in service_types]), 200
    except Exception as e:
        print(f"Error in get_service_types: {e}")
        return jsonify({'error': str(e)}), 500

@financial_bp.route('/service-types', methods=['POST'])
@admin_required
def create_service_type():
    """Create new service type"""
    try:
        data = request.get_json()
        
        # Validate required fields
        required_fields = ['name', 'default_price']
        for field in required_fields:
            if field not in data or data[field] is None:
                return jsonify({'error': f'Missing required field: {field}'}), 400
        
        # Check if service type name already exists
        existing = ServiceType.query.filter_by(name=data['name']).first()
        if existing:
            return jsonify({'error': 'Service type name already exists'}), 400
        
        service_type = ServiceType(
            name=data['name'],
            description=data.get('description', ''),
            default_price=Decimal(str(data['default_price']))
        )
        
        db.session.add(service_type)
        db.session.commit()
        
        return jsonify(service_type.to_dict()), 201
        
    except Exception as e:
        db.session.rollback()
        print(f"Error in create_service_type: {e}")
        return jsonify({'error': str(e)}), 500

@financial_bp.route('/service-types/<int:service_type_id>', methods=['PUT'])
@admin_required
def update_service_type(service_type_id):
    """Update service type"""
    try:
        service_type = ServiceType.query.get_or_404(service_type_id)
        data = request.get_json()
        
        # Update fields if provided
        if 'name' in data:
            # Check if new name already exists
            existing = ServiceType.query.filter(
                ServiceType.name == data['name'],
                ServiceType.id != service_type_id
            ).first()
            if existing:
                return jsonify({'error': 'Service type name already exists'}), 400
            service_type.name = data['name']
        
        if 'description' in data:
            service_type.description = data['description']
        if 'default_price' in data:
            service_type.default_price = Decimal(str(data['default_price']))
        if 'is_active' in data:
            service_type.is_active = data['is_active']
        
        db.session.commit()
        
        return jsonify(service_type.to_dict()), 200
        
    except Exception as e:
        db.session.rollback()
        print(f"Error in update_service_type: {e}")
        return jsonify({'error': str(e)}), 500

@financial_bp.route('/patients/search', methods=['GET'])
@login_required
def search_patients():
    """Search patients for transaction creation - available to all authenticated users"""
    try:
        query = request.args.get('q', '').strip()
        if not query:
            return jsonify([]), 200
        
        patients = Patient.query.filter(
            (Patient.first_name.ilike(f'%{query}%')) |
            (Patient.last_name.ilike(f'%{query}%')) |
            (Patient.parent_name.ilike(f'%{query}%'))
        ).limit(10).all()
        
        return jsonify([
            {
                'id': p.id,
                'name': f"{p.first_name} {p.last_name}",
                'parent_name': p.parent_name,
                'phone': p.phone
            } for p in patients
        ]), 200
        
    except Exception as e:
        print(f"Error in search_patients: {e}")
        return jsonify({'error': str(e)}), 500

