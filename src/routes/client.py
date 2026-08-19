from flask import Blueprint, request, jsonify
from sqlalchemy import or_
from src.models.client import Client
from src.models.test_result import TestResult
from src.models.user import db, PatientVisit
from src.utils.validators import validate_client_data
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
from reportlab.lib import colors
from io import BytesIO
from flask import send_file
from src.utils.arabic_text import register_arabic_font, paragraph_text

client_bp = Blueprint('client_bp', __name__)

register_arabic_font()

# --- CLIENT CRUD ---

@client_bp.route('/clients', methods=['GET'])
def get_clients():
    """Retrieve clients. Supports optional pagination + filtering via ?page=&per_page=&
    date_from=&date_to=&gender=&status=&search= — omit `page` to get the full unfiltered
    list exactly as before (still used by loadInitialData() for the booking modal's patient
    picker, per-client lookups, and the Dashboard's unbooked-clients calculation, all of
    which need the complete dataset)."""
    try:
        query = Client.query

        gender = request.args.get('gender')
        if gender:
            query = query.filter(Client.gender == gender)

        date_from = request.args.get('date_from')
        date_to = request.args.get('date_to')
        if date_from:
            query = query.filter(Client.created_at >= date_from)
        if date_to:
            query = query.filter(Client.created_at <= date_to + ' 23:59:59')

        # Mirrors the frontend's "registered if no test assigned yet" rule (searchClients()
        # in script_lab.js): a client only has a real sample_status once test_type is set.
        status = request.args.get('status')
        if status == 'registered':
            query = query.filter(or_(Client.test_type.is_(None), Client.test_type == ''))
        elif status:
            query = query.filter(
                Client.sample_status == status,
                Client.test_type.isnot(None), Client.test_type != '',
            )

        search = request.args.get('search')
        if search:
            like = f'%{search}%'
            conditions = [
                Client.first_name.ilike(like),
                Client.last_name.ilike(like),
                Client.phone.ilike(like),
            ]
            if search.isdigit():
                conditions.append(Client.id == int(search))
            query = query.filter(or_(*conditions))

        query = query.order_by(Client.created_at.desc())

        page = request.args.get('page', type=int)
        if page is not None:
            per_page = max(1, min(request.args.get('per_page', 100, type=int), 500))
            total = query.count()
            clients = query.offset((page - 1) * per_page).limit(per_page).all()
            return jsonify({
                'items': [c.to_dict() for c in clients],
                'page': page,
                'per_page': per_page,
                'total': total,
                'total_pages': max(1, (total + per_page - 1) // per_page),
            }), 200

        clients = query.all()
        return jsonify([c.to_dict() for c in clients]), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@client_bp.route('/clients/<int:client_id>', methods=['GET'])
def get_client(client_id):
    """Retrieve a specific client."""
    try:
        client = Client.query.get(client_id)
        if not client:
            return jsonify({'error': 'Client not found'}), 404
        return jsonify(client.to_dict()), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@client_bp.route('/clients', methods=['POST'])
def create_client():
    """Create a new client."""
    try:
        data = request.get_json()
        
        # Validate client data
        errors = validate_client_data(data)
        if errors:
            return jsonify({'errors': errors}), 400
        
        client = Client(
            first_name=data['first_name'],
            last_name=data['last_name'],
            date_of_birth=datetime.fromisoformat(data['date_of_birth']).date(),
            gender=data['gender'],
            contact_person=data['contact_person'],
            phone=data['phone'],
            client_phone=data.get('client_phone'),
            city=data.get('city'),
            area=data.get('area'),
            street=data.get('street'),
            apartment=data.get('apartment'),
            blood_type=data.get('blood_type'),
            allergies=data.get('allergies'),
            clinical_indications=data.get('clinical_indications'),
            temperature=data.get('temperature'),
            blood_pressure_systolic=data.get('blood_pressure_systolic'),
            blood_pressure_diastolic=data.get('blood_pressure_diastolic'),
            weight=data.get('weight'),
            height=data.get('height')
        )
        
        db.session.add(client)
        db.session.commit()
        
        return jsonify(client.to_dict()), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@client_bp.route('/clients/<int:client_id>', methods=['PUT'])
def update_client(client_id):
    """Update a client."""
    try:
        client = Client.query.get(client_id)
        if not client:
            return jsonify({'error': 'Client not found'}), 404
        
        data = request.get_json()
        
        # Update fields
        if 'first_name' in data:
            client.first_name = data['first_name']
        if 'last_name' in data:
            client.last_name = data['last_name']
        if 'date_of_birth' in data:
            client.date_of_birth = datetime.fromisoformat(data['date_of_birth']).date()
        if 'gender' in data:
            client.gender = data['gender']
        if 'contact_person' in data:
            client.contact_person = data['contact_person']
        if 'phone' in data:
            client.phone = data['phone']
        if 'client_phone' in data:
            client.client_phone = data['client_phone']
        if 'city' in data:
            client.city = data['city']
        if 'area' in data:
            client.area = data['area']
        if 'street' in data:
            client.street = data['street']
        if 'apartment' in data:
            client.apartment = data['apartment']
        if 'blood_type' in data:
            client.blood_type = data['blood_type']
        if 'allergies' in data:
            client.allergies = data['allergies']
        if 'clinical_indications' in data:
            client.clinical_indications = data['clinical_indications']
        if 'temperature' in data:
            client.temperature = data['temperature']
        if 'blood_pressure_systolic' in data:
            client.blood_pressure_systolic = data['blood_pressure_systolic']
        if 'blood_pressure_diastolic' in data:
            client.blood_pressure_diastolic = data['blood_pressure_diastolic']
        if 'weight' in data:
            client.weight = data['weight']
        if 'height' in data:
            client.height = data['height']
        if 'test_date' in data and 'test_time' in data:
            test_date = datetime.fromisoformat(data['test_date']).date() if data['test_date'] else None
            test_time = datetime.fromisoformat(data['test_time']).time() if data['test_time'] else None
            client.set_test_datetime(test_date, test_time)
        if 'test_type' in data:
            client.test_type = data['test_type']
        if 'sample_status' in data:
            client.sample_status = data['sample_status']
        if 'technician_notes' in data:
            client.technician_notes = data['technician_notes']
        if 'status' in data:
            client.status = data['status']
        
        db.session.commit()
        return jsonify(client.to_dict()), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@client_bp.route('/clients/<int:client_id>', methods=['DELETE'])
def delete_client(client_id):
    """Delete a client."""
    try:
        client = Client.query.get(client_id)
        if not client:
            return jsonify({'error': 'Client not found'}), 404
        
        # Delete associated test results not tied to a visit (visit-linked ones cascade
        # below via PatientVisit's own ON DELETE CASCADE — see junctions.py/test_result.py).
        TestResult.query.filter_by(client_id=client_id).delete()

        # PatientVisit.patient_id has no ON DELETE CASCADE of its own, so a client with any
        # booked visit would otherwise fail this delete with a foreign-key constraint error
        # (caught below as a 500, but the client — and everything blocking it — stays put).
        # Each visit's own children (VisitTest/VisitReport/TestResult.visit_id) DO cascade
        # from the visit delete itself, so deleting the visits here is enough.
        PatientVisit.query.filter_by(patient_id=client_id).delete()

        db.session.delete(client)
        db.session.commit()
        
        return jsonify({'message': 'Client deleted successfully'}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

# --- DASHBOARD STATISTICS ---

@client_bp.route('/dashboard/stats', methods=['GET'])
def get_dashboard_stats():
    """Get dashboard statistics for the lab."""
    try:
        total_clients = Client.query.count()
        
        # New clients this month
        from datetime import datetime, timedelta
        now = datetime.utcnow()
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        new_clients_this_month = Client.query.filter(Client.created_at >= month_start).count()
        
        # Tests pending
        pending_tests = Client.query.filter_by(sample_status='pending').count()
        
        # Tests completed today
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        completed_today = Client.query.filter(
            Client.sample_status == 'completed',
            Client.updated_at >= today_start
        ).count()
        
        # Average client age
        clients = Client.query.all()
        if clients:
            total_age = sum((now.date() - c.date_of_birth).days // 365 for c in clients if c.date_of_birth)
            avg_age = round(total_age / len(clients)) if clients else 0
        else:
            avg_age = 0
        
        return jsonify({
            'total_clients': total_clients,
            'new_this_month': new_clients_this_month,
            'pending_tests': pending_tests,
            'completed_today': completed_today,
            'average_age': avg_age
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# --- LAB REPORT GENERATION ---

@client_bp.route('/clients/<int:client_id>/lab-report', methods=['GET'])
def generate_lab_report(client_id):
    """Generate a laboratory report for a client."""
    try:
        client = Client.query.get(client_id)
        if not client:
            return jsonify({'error': 'Client not found'}), 404
        
        # Get test results for this client
        test_results = TestResult.query.filter_by(client_id=client_id).all()
        
        # Create PDF
        buffer = BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=letter)
        elements = []
        styles = getSampleStyleSheet()
        
        # Title
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=styles['Heading1'],
            fontSize=16,
            textColor=colors.HexColor('#2d3748'),
            spaceAfter=6,
            alignment=1  # Center
        )
        elements.append(Paragraph("LABORATORY TEST REPORT", title_style))
        elements.append(Spacer(1, 0.2*inch))
        
        # Client Information
        client_info = f"""
        <b>Client Name:</b> {paragraph_text(f'{client.first_name} {client.last_name}')}<br/>
        <b>Date of Birth:</b> {client.date_of_birth.isoformat() if client.date_of_birth else 'N/A'}<br/>
        <b>Gender:</b> {client.gender}<br/>
        <b>Contact Person:</b> {paragraph_text(client.contact_person)}<br/>
        <b>Phone:</b> {client.phone}<br/>
        <b>Blood Type:</b> {client.blood_type or 'N/A'}<br/>
        <b>Clinical Indications:</b> {paragraph_text(client.clinical_indications) or 'N/A'}<br/>
        """
        elements.append(Paragraph(client_info, styles['Normal']))
        elements.append(Spacer(1, 0.2*inch))
        
        # Test Results Table
        if test_results:
            elements.append(Paragraph("<b>Test Results:</b>", styles['Heading2']))
            elements.append(Spacer(1, 0.1*inch))
            
            cell_style = ParagraphStyle('LabReportCell', parent=styles['Normal'], fontSize=10, alignment=1)
            data = [['Test Name', 'Parameter', 'Result', 'Unit', 'Reference Range', 'Status']]
            for result in test_results:
                data.append([
                    Paragraph(paragraph_text(result.test_name), cell_style),
                    Paragraph(paragraph_text(result.parameter_name), cell_style),
                    Paragraph(paragraph_text(result.result_value), cell_style),
                    Paragraph(paragraph_text(result.unit), cell_style),
                    Paragraph(paragraph_text(result.reference_range), cell_style),
                    Paragraph(paragraph_text(result.status), cell_style),
                ])
            
            table = Table(data, colWidths=[1.5*inch, 1*inch, 0.8*inch, 0.6*inch, 1*inch, 0.8*inch])
            table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#667eea')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, 0), 10),
                ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
                ('BACKGROUND', (0, 1), (-1, -1), colors.beige),
                ('GRID', (0, 0), (-1, -1), 1, colors.black)
            ]))
            elements.append(table)
        else:
            elements.append(Paragraph("<i>No test results available yet.</i>", styles['Normal']))
        
        # Build PDF
        doc.build(elements)
        buffer.seek(0)
        
        return send_file(
            buffer,
            mimetype='application/pdf',
            as_attachment=True,
            download_name=f'lab_report_{client.id}_{datetime.utcnow().strftime("%Y%m%d")}.pdf'
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# --- CLIENT HISTORY REPORT ---

@client_bp.route('/clients/history/report', methods=['GET'])
def get_client_history_report():
    """Get a report of all clients and their test history."""
    try:
        clients = Client.query.all()
        report_data = []
        
        for client in clients:
            test_count = TestResult.query.filter_by(client_id=client.id).count()
            report_data.append({
                'id': client.id,
                'name': f"{client.first_name} {client.last_name}",
                'date_of_birth': client.date_of_birth.isoformat() if client.date_of_birth else None,
                'phone': client.phone,
                'test_count': test_count,
                'last_test': max(
                    (tr.test_completion_date for tr in TestResult.query.filter_by(client_id=client.id).all() if tr.test_completion_date),
                    default=None
                ),
                'status': client.status
            })
        
        return jsonify(report_data), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500
