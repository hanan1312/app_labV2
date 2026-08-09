import json
import io
from flask import Blueprint, request, jsonify, send_file
from datetime import datetime, date
from sqlalchemy import func

# --- PDF Reporting ---
# Using reportlab to generate PDF files on the fly
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER

# --- Local Imports ---
from src.models.patient import Patient
from src.models.user import db
from src.utils.validators import validate_patient_data, ValidationError
from src.models.reservation import Reservation    


# Initialize the Blueprint for patient routes
patient_bp = Blueprint('patient', __name__)

# === CRUD OPERATIONS ===

@patient_bp.route('/patients', methods=['GET'])
def get_all_patients():
    """Get all patients, ordered by most recently created."""
    try:
        patients = Patient.query.order_by(Patient.created_at.desc()).all()
        return jsonify([patient.to_dict() for patient in patients]), 200
    except Exception as e:
        print(f"ERROR in get_all_patients: {e}")
        return jsonify({'error': 'An internal server error occurred'}), 500

@patient_bp.route('/patients/<int:patient_id>', methods=['GET'])
def get_patient(patient_id):
    """Get a specific patient by their unique ID."""
    try:
        patient = Patient.query.get_or_404(patient_id)
        return jsonify(patient.to_dict()), 200
    except Exception as e:
        print(f"ERROR in get_patient: {e}")
        return jsonify({'error': 'An internal server error occurred'}), 500

@patient_bp.route('/patients', methods=['POST'])

def create_patient():
    """Create a new patient with robust validation."""
    data = request.get_json()
    if not data:
        raise ValidationError('Invalid JSON payload provided')

    # Validate patient data
    validated_data = validate_patient_data(data, is_update=False)
    
    # Handle allergies: convert list to a JSON string for database storage
    allergies_data = validated_data.get('allergies')
    if isinstance(allergies_data, list):
        validated_data['allergies'] = json.dumps(allergies_data)

    new_patient = Patient(
        first_name=validated_data['first_name'],
        last_name=validated_data['last_name'],
        date_of_birth=validated_data['date_of_birth'],
        gender=validated_data['gender'],
        parent_name=validated_data['parent_name'],
        phone=validated_data['phone'],
        patient_phone=validated_data.get('patient_phone'),
        city=validated_data.get('city'),
        area=validated_data.get('area'),
        street=validated_data.get('street'),
        apartment=validated_data.get('apartment'),
        blood_type=validated_data.get('blood_type'),
        allergies=validated_data.get('allergies'),
        medical_history=validated_data.get('medical_history'),
        hall_status='Out',  # Default status for a new patient
        status='registered'
    )
    
    db.session.add(new_patient)
    db.session.commit()
    
    return jsonify(new_patient.to_dict()), 201

# === OTHER PATIENT MANAGEMENT ROUTES ===

@patient_bp.route('/patients/<int:patient_id>/reservation', methods=['POST'])
def create_reservation(patient_id):
    """Create a reservation for an existing patient."""
    try:
        patient = Patient.query.get_or_404(patient_id)
        data = request.get_json()

        # Handle the new separate date and time fields
        visit_date_str = data.get('visit_date')
        visit_time_str = data.get('visit_time')
        visit_datetime_str = data.get('visit_datetime')  # For backward compatibility
        
        if visit_date_str and visit_time_str:
            # Parse separate date and time
            visit_date = datetime.strptime(visit_date_str, '%Y-%m-%d').date()
            visit_time = datetime.strptime(visit_time_str, '%H:%M').time()
            patient.set_visit_datetime(visit_date, visit_time)
        elif visit_datetime_str:
            # Handle legacy datetime format
            visit_datetime = datetime.fromisoformat(visit_datetime_str.replace('Z', '+00:00'))
            patient.set_visit_datetime(visit_datetime.date(), visit_datetime.time())
        
        patient.visit_type = data.get('visit_type')
        patient.hall_status = data.get('hall_status', 'Out')
        patient.status = 'scheduled'
        
        db.session.commit()
        return jsonify({'message': 'Reservation created successfully.'}), 201

    except Exception as e:
        db.session.rollback()
        print(f"ERROR in create_reservation: {e}")
        return jsonify({'error': 'Failed to create reservation.'}), 500
        
# === DASHBOARD & STATISTICS ===

@patient_bp.route('/statistics', methods=['GET'])
def get_statistics():
    """Get comprehensive statistics for the dashboard using efficient queries."""
    try:
        # today = date.today()
        today = datetime.now().strftime('%Y-%m-%d')
        start_of_month = today.replace(day=1)

        total_patients = db.session.query(func.count(Patient.id)).scalar()
        
        new_this_month = db.session.query(func.count(Patient.id)).filter(
            Patient.created_at >= start_of_month
        ).scalar()
        
        # today_patients_count = db.session.query(func.count(Patient.id)).filter(
        #     func.date(Patient.visit_datetime) == today
        # ).scalar()
        today_patients_count = Patient.query.filter(Patient.visit_date == today).count()
        
        # Efficiently calculate average age in years using SQL functions
        # This is more performant than fetching all patients and calculating in Python
        avg_age_result = db.session.query(func.avg(
            (func.julianday('now') - func.julianday(Patient.date_of_birth)) / 365.25
        )).scalar()
        average_age = int(avg_age_result) if avg_age_result else 0
        
        return jsonify({
            'total_patients': total_patients or 0,
            'new_this_month': new_this_month or 0,
            'today_patients': today_patients_count,
            'average_age': average_age
        }), 200
        
    except Exception as e:
        print(f"ERROR in get_statistics: {e}")
        return jsonify({'error': 'An internal server error occurred while fetching statistics.'}), 500

# === PDF REPORTING ===

@patient_bp.route('/patients/<int:patient_id>/report', methods=['POST'])
def generate_patient_report(patient_id):
    """Generate a comprehensive PDF report for a specific patient with accumulated visit data."""

   
    try:
        patient = Patient.query.get_or_404(patient_id)
        
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=A4, rightMargin=72, leftMargin=72, topMargin=72, bottomMargin=18)
        
        story = []
        styles = getSampleStyleSheet()
        
        # --- PDF Styles ---
        title_style = ParagraphStyle('CustomTitle', parent=styles['h1'], fontSize=22, alignment=TA_CENTER, spaceAfter=24)
        header_style = ParagraphStyle('CustomHeader', parent=styles['h2'], fontSize=14, spaceAfter=12, textColor=colors.HexColor('#667eea'), spaceBefore=12)
        normal_style = styles['Normal']
        
        # --- PDF Content ---
        story.append(Paragraph("Patient Medical Report", title_style))
        story.append(Spacer(1, 0.15 * inch))
        
        # Patient Basic Information
        story.append(Paragraph("Patient Information", header_style))
        patient_info_data = [
            ['Name: ', f"{patient.first_name} {patient.last_name}"],
            ['Date of Birth: ', patient.date_of_birth.strftime('%B %d, %Y') if patient.date_of_birth else 'N/A'],
            ['Gender: ', patient.gender or 'N/A'],
            ['Blood Type: ', patient.blood_type or 'N/A'],
            ['Parent/Guardian: ', patient.parent_name or 'N/A'],
            ['Phone: ', patient.phone or 'N/A'],
        ]
        patient_info_table = Table(patient_info_data, colWidths=[2*inch, 4*inch])
        patient_info_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f0f0f0')),
            ('TEXTCOLOR', (0, 0), (-1, -1), colors.black),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('GRID', (0, 0), (-1, -1), 1, colors.grey),
        ]))
        story.append(patient_info_table)
        story.append(Spacer(1, 0.25 * inch))
        
        # Medical History
        if patient.medical_history or patient.allergies:
            story.append(Paragraph("Medical History", header_style))
            if patient.medical_history:
                story.append(Paragraph(f"History:  {patient.medical_history}", normal_style))
            if patient.allergies:
                story.append(Paragraph(f"Allergies: {patient.allergies}", normal_style))
            story.append(Spacer(1, 0.15 * inch))
        

        
        
        # Visit Information
        visits = Reservation.query.filter_by(patient_id=patient.id).order_by(Reservation.visit_datetime.desc()).all()

        if visits:
            story.append(Paragraph("FULL VISIT HISTORY", header_style))
            
            # Define table headers
            visit_history_data = [["Date", "Time", "Visit Type", "Status"]]
            
            # Loop through every visit found in the database
            for v in visits:
                visit_history_data.append([
                    v.visit_datetime.strftime('%Y-%m-%d'),
                    v.visit_datetime.strftime('%I:%M %p'),
                    v.visit_type or 'N/A',
                    v.status or 'N/A'
                ])
            
            # Create the history table
            history_table = Table(visit_history_data, colWidths=[1.5*inch, 1.5*inch, 1.5*inch, 1.5*inch])
            history_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#667eea')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ]))
            story.append(history_table)
            story.append(Spacer(1, 0.2 * inch))

        if patient.visit_datetime or patient.visit_date:
            story.append(Paragraph("Latest Visit Information", header_style))
            visit_datetime = patient.get_visit_datetime_combined()
            visit_info_data = [
                ['Visit Date: ', visit_datetime.strftime('%B %d, %Y') if visit_datetime else 'N/A'],
                ['Visit Time: ', visit_datetime.strftime('%I:%M %p') if visit_datetime else 'N/A'],
                ['Visit Type: ', patient.visit_type or 'N/A'],
                ['Status: ', patient.status or 'N/A'],
            ]
            visit_info_table = Table(visit_info_data, colWidths=[2*inch, 4*inch])
            visit_info_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f0f0f0')),
                ('TEXTCOLOR', (0, 0), (-1, -1), colors.black),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 10),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                ('GRID', (0, 0), (-1, -1), 1, colors.grey),
            ]))
            story.append(visit_info_table)
            story.append(Spacer(1, 0.25 * inch))
        
        # Doctor Comments
        if patient.doctor_comments:
            story.append(Paragraph("Doctor's Comments", header_style))
            story.append(Paragraph(patient.doctor_comments, normal_style))
            story.append(Spacer(1, 0.15 * inch))
        
        # Vital Signs
        if patient.temperature or patient.weight or patient.height or patient.blood_pressure_systolic:
            story.append(Paragraph("Vital Signs", header_style))
            vitals_data = [
                ['Temperature: ', f"{patient.temperature}°C" if patient.temperature else 'N/A'],
                ['Blood Pressure: ', f"{patient.blood_pressure_systolic}/{patient.blood_pressure_diastolic}" if patient.blood_pressure_systolic else 'N/A'],
                ['Weight: ', f"{patient.weight} kg" if patient.weight else 'N/A'],
                ['Height: ', f"{patient.height} cm" if patient.height else 'N/A'],
            ]
            vitals_table = Table(vitals_data, colWidths=[2*inch, 4*inch])
            vitals_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f0f0f0')),
                ('TEXTCOLOR', (0, 0), (-1, -1), colors.black),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 10),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                ('GRID', (0, 0), (-1, -1), 1, colors.grey),
            ]))
            story.append(vitals_table)

        doc.build(story)
        buffer.seek(0)
        
        return send_file(
            buffer,
            as_attachment=True,
            download_name=f'patient_{patient.id}_report.pdf',
            mimetype='application/pdf'
        )
        
    except Exception as e:
        print(f"ERROR in generate_patient_report: {e}")
        return jsonify({'error': 'Failed to generate PDF report.'}), 500

# === REPORT ENDPOINTS ===

@patient_bp.route('/report/patient-statistics', methods=['GET'])
def get_patient_statistics_report():
    """Generate comprehensive patient statistics report"""
    try:
        total_patients = Patient.query.count()
        today = date.today()
        today_patients = Patient.query.filter(
            func.date(Patient.visit_datetime) == today
        ).count()
        
        scheduled_patients = Patient.query.filter(
            Patient.status == 'scheduled'
        ).count()
        
        finished_patients = Patient.query.filter(
            Patient.status == 'finished'
        ).count()
        
        return jsonify({
            'total_patients': total_patients,
            'today_patients': today_patients,
            'scheduled_patients': scheduled_patients,
            'finished_patients': finished_patients
        }), 200
    except Exception as e:
        print(f"ERROR in get_patient_statistics_report: {e}")
        return jsonify({'error': 'Failed to generate patient report.'}), 500

@patient_bp.route('/report/visit-statistics', methods=['GET'])
def get_visit_statistics_report():
    """Generate visit statistics and trends report"""
    try:
        # Get visit type breakdown
        visit_types = db.session.query(
            Patient.visit_type,
            func.count(Patient.id).label('count')
        ).filter(Patient.visit_type.isnot(None)).group_by(Patient.visit_type).all()
        
        # Get visits by status
        statuses = db.session.query(
            Patient.status,
            func.count(Patient.id).label('count')
        ).filter(Patient.status.isnot(None)).group_by(Patient.status).all()
        
        # Get hall status breakdown
        hall_statuses = db.session.query(
            Patient.hall_status,
            func.count(Patient.id).label('count')
        ).filter(Patient.hall_status.isnot(None)).group_by(Patient.hall_status).all()
        
        return jsonify({
            'visit_types': [{'type': vt[0], 'count': vt[1]} for vt in visit_types],
            'statuses': [{'status': s[0], 'count': s[1]} for s in statuses],
            'hall_statuses': [{'status': hs[0], 'count': hs[1]} for hs in hall_statuses]
        }), 200
    except Exception as e:
        print(f"ERROR in get_visit_statistics_report: {e}")
        return jsonify({'error': 'Failed to generate visit report.'}), 500


@patient_bp.route('/patients/<int:patient_id>', methods=['PUT'])

def update_patient(patient_id):
    """Update patient information"""
    patient = Patient.query.get_or_404(patient_id)
    data = request.get_json()
    
    if not data:
        raise ValidationError('Invalid JSON payload provided')
    
    # Validate patient data for update
    validated_data = validate_patient_data(data, is_update=True)
    
    # Update fields if provided in validated data
    for field, value in validated_data.items():
        if hasattr(patient, field):
            setattr(patient, field, value)
    
    # Handle visit date and time updates
    visit_date_str = data.get('visit_date')
    visit_time_str = data.get('visit_time')
    visit_datetime_str = data.get('visit_datetime')
    
    if visit_date_str is not None or visit_time_str is not None:
        # Update separate date and time fields
        visit_date = validated_data.get('visit_date') or patient.visit_date
        visit_time = validated_data.get('visit_time') or patient.visit_time
        patient.set_visit_datetime(visit_date, visit_time)
    elif visit_datetime_str:
        # Handle legacy datetime format
        visit_datetime = datetime.fromisoformat(visit_datetime_str.replace('Z', '+00:00'))
        patient.set_visit_datetime(visit_datetime.date(), visit_datetime.time())
    
    patient.updated_at = datetime.utcnow()
    db.session.commit()
    
    return jsonify(patient.to_dict()), 200

@patient_bp.route('/patients/<int:patient_id>', methods=['DELETE'])
def delete_patient(patient_id):
    """Delete a patient"""
    try:
        patient = Patient.query.get_or_404(patient_id)
        db.session.delete(patient)
        db.session.commit()
        
        return jsonify({'message': 'Patient deleted successfully'}), 200
        
    except Exception as e:
        db.session.rollback()
        print(f"ERROR in delete_patient: {e}")
        return jsonify({'error': 'An internal server error occurred while deleting the patient.'}), 500

@patient_bp.route('/patients/search', methods=['GET'])
def search_patients():
    """Search patients by name, parent name, or phone"""
    try:
        query = request.args.get('q', '').strip()
        if not query:
            return jsonify([]), 200
        
        patients = Patient.query.filter(
            (Patient.first_name.ilike(f'%{query}%')) |
            (Patient.last_name.ilike(f'%{query}%')) |
            (Patient.parent_name.ilike(f'%{query}%')) |
            (Patient.phone.ilike(f'%{query}%'))
        ).limit(10).all()
        
        return jsonify([patient.to_dict() for patient in patients]), 200
        
    except Exception as e:
        print(f"ERROR in search_patients: {e}")
        return jsonify({'error': 'An internal server error occurred while searching patients.'}), 500

@patient_bp.route('/patients/today', methods=['GET'])
def get_today_patients():
    """Get patients scheduled for today"""
    try:
        today = date.today()
        
        today_patients = Patient.query.filter(
            func.date(Patient.visit_datetime) == today
        ).order_by(Patient.visit_datetime.asc()).all()
        
        return jsonify([patient.to_dict() for patient in today_patients]), 200
        
    except Exception as e:
        print(f"ERROR in get_today_patients: {e}")
        return jsonify({'error': 'An internal server error occurred while fetching today\'s patients.'}), 500

@patient_bp.route('/patients/awaiting', methods=['GET'])
def get_awaiting_patients():
    """Get patients currently awaiting in hall"""
    try:
        awaiting_patients = Patient.query.filter(
            Patient.hall_status == 'In',
            Patient.status != 'finished'
        ).order_by(Patient.visit_datetime.asc()).all()
        
        return jsonify([patient.to_dict() for patient in awaiting_patients]), 200
        
    except Exception as e:
        print(f"ERROR in get_awaiting_patients: {e}")
        return jsonify({'error': 'An internal server error occurred while fetching awaiting patients.'}), 500

@patient_bp.route('/patients/finished', methods=['GET'])
def get_finished_patients():
    """Get patients with finished status"""
    try:
        finished_patients = Patient.query.filter(
            Patient.status == 'finished'
        ).order_by(Patient.updated_at.desc()).all()
        
        return jsonify([patient.to_dict() for patient in finished_patients]), 200
        
    except Exception as e:
        print(f"ERROR in get_finished_patients: {e}")
        return jsonify({'error': 'An internal server error occurred while fetching finished patients.'}), 500

