import base64
import os
from datetime import datetime
from io import BytesIO

from flask import Blueprint, request, jsonify, current_app

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image as RLImage
from reportlab.graphics.barcode import createBarcodeDrawing
import qrcode
from PIL import Image as PILImage

from src.models.user import db, LabTest, PatientVisit
from src.models.client import Client
from src.models.test_result import TestResult
from src.models.test_parameter import TestParameterTemplate
from src.models.lab_config import LabConfig
from src.models.junctions import VisitTest, add_visit_reports, get_visit_test_names, get_completed_test_names

reports_bp = Blueprint('reports_bp', __name__)

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'static')

# --- PARAMETER TEMPLATE CRUD (per LabTest — Settings > Test List > "Parameters") ---


@reports_bp.route('/lab-tests/<int:lab_test_id>/parameters', methods=['GET'])
def get_test_parameters(lab_test_id):
    rows = (TestParameterTemplate.query
            .filter_by(lab_test_id=lab_test_id)
            .order_by(TestParameterTemplate.display_order)
            .all())
    return jsonify([r.to_dict() for r in rows]), 200


@reports_bp.route('/lab-tests/<int:lab_test_id>/parameters', methods=['POST'])
def create_test_parameter(lab_test_id):
    if not LabTest.query.get(lab_test_id):
        return jsonify({'error': 'Lab test not found'}), 404

    data = request.json or {}
    if not data.get('name'):
        return jsonify({'error': 'Missing required field: name'}), 400

    max_order = db.session.query(db.func.max(TestParameterTemplate.display_order)) \
        .filter_by(lab_test_id=lab_test_id).scalar()

    row = TestParameterTemplate(
        lab_test_id=lab_test_id,
        name=data['name'],
        unit=data.get('unit'),
        method=data.get('method'),
        ref_low=data.get('ref_low'),
        ref_high=data.get('ref_high'),
        reference_range_text=data.get('reference_range_text'),
        abnormal_note=data.get('abnormal_note'),
        display_order=(max_order + 1) if max_order is not None else 0,
    )
    db.session.add(row)
    db.session.commit()
    return jsonify(row.to_dict()), 201


@reports_bp.route('/parameters/<int:param_id>', methods=['PUT'])
def update_test_parameter(param_id):
    row = TestParameterTemplate.query.get(param_id)
    if not row:
        return jsonify({'error': 'Parameter not found'}), 404

    data = request.json or {}
    for field in ('name', 'unit', 'method', 'ref_low', 'ref_high',
                  'reference_range_text', 'abnormal_note', 'display_order'):
        if field in data:
            setattr(row, field, data[field])

    db.session.commit()
    return jsonify(row.to_dict()), 200


@reports_bp.route('/parameters/<int:param_id>', methods=['DELETE'])
def delete_test_parameter(param_id):
    row = TestParameterTemplate.query.get(param_id)
    if not row:
        return jsonify({'error': 'Parameter not found'}), 404

    db.session.delete(row)
    db.session.commit()
    return jsonify({'success': True}), 200


# --- RESULTS ENTRY (the "🧪 Enter Results" window) ---

def _booked_tests(visit_id):
    """Booked tests for a visit, in booking order, as LabTest rows."""
    visit_tests = VisitTest.query.filter_by(visit_id=visit_id).order_by(VisitTest.position).all()
    lab_test_ids = [vt.lab_test_id for vt in visit_tests]
    if not lab_test_ids:
        return []
    tests_by_id = {t.id: t for t in LabTest.query.filter(LabTest.id.in_(lab_test_ids)).all()}
    return [tests_by_id[vt.lab_test_id] for vt in visit_tests if vt.lab_test_id in tests_by_id]


@reports_bp.route('/visits/<int:visit_id>/results-schema', methods=['GET'])
def get_results_schema(visit_id):
    visit = PatientVisit.query.get(visit_id)
    if not visit:
        return jsonify({'error': 'Visit not found'}), 404
    patient = Client.query.get(visit.patient_id)

    existing_results = {
        (r.lab_test_id, r.parameter_name): r
        for r in TestResult.query.filter_by(visit_id=visit.id).all()
    }

    tests_payload = []
    for test in _booked_tests(visit.id):
        templates = (TestParameterTemplate.query
                     .filter_by(lab_test_id=test.id)
                     .order_by(TestParameterTemplate.display_order)
                     .all())
        params_payload = []
        for tpl in templates:
            existing = existing_results.get((test.id, tpl.name))
            params_payload.append({
                'template_id': tpl.id,
                'name': tpl.name,
                'unit': tpl.unit,
                'method': tpl.method,
                'ref_low': tpl.ref_low,
                'ref_high': tpl.ref_high,
                'reference_range_text': tpl.reference_range_text,
                'result_value': existing.result_value if existing else '',
            })
        tests_payload.append({
            'lab_test_id': test.id,
            'test_name': test.name,
            'parameters': params_payload,
        })

    all_tests = get_visit_test_names(visit.id)
    completed_tests = get_completed_test_names(visit.id)

    return jsonify({
        'visit_id': visit.id,
        'visit_code': visit.visit_id,
        'status': visit.status,
        'patient_name': patient.first_name + ' ' + patient.last_name if patient else visit.patient_name,
        'referred_by': visit.referred_by,
        'date': visit.date,
        'tests': tests_payload,
        'all_tests': all_tests,
        'completed_tests': completed_tests,
    }), 200


@reports_bp.route('/visits/<int:visit_id>/results', methods=['POST'])
def save_results(visit_id):
    visit = PatientVisit.query.get(visit_id)
    if not visit:
        return jsonify({'error': 'Visit not found'}), 404

    data = request.json or {}
    entries = data.get('results', [])

    # The results-entry form always submits the visit's full schema, so a fresh save fully
    # replaces any prior one rather than trying to diff/merge.
    TestResult.query.filter_by(visit_id=visit.id).delete()

    for entry in entries:
        result_value = (entry.get('result_value') or '').strip()
        if not result_value:
            continue  # blank parameter — technician didn't fill this one in

        template = TestParameterTemplate.query.get(entry['template_id']) if entry.get('template_id') else None
        status = 'completed'
        reference_range = entry.get('reference_range_text')
        if template:
            reference_range = reference_range or template.reference_range_text
            if template.ref_low is not None and template.ref_high is not None:
                try:
                    numeric = float(result_value)
                    status = 'normal' if template.ref_low <= numeric <= template.ref_high else 'abnormal'
                except ValueError:
                    pass

        db.session.add(TestResult(
            client_id=visit.patient_id,
            visit_id=visit.id,
            lab_test_id=entry.get('lab_test_id'),
            test_name=entry.get('test_name', ''),
            parameter_name=entry.get('name', ''),
            result_value=result_value,
            unit=entry.get('unit'),
            reference_range=reference_range,
            status=status,
            test_completion_date=datetime.utcnow(),
        ))

    db.session.commit()

    # A visit is only "delivered" once every booked test has at least one saved result —
    # otherwise it's "partially_delivered" and the UI surfaces which specific test(s) are
    # done instead of a generic status. Uploading a whole PDF (upload_report() in main.py)
    # is treated as covering the entire visit and is unaffected by this per-test tracking.
    all_tests = get_visit_test_names(visit.id)
    completed_tests = get_completed_test_names(visit.id)
    is_complete = bool(all_tests) and len(completed_tests) == len(all_tests)
    visit.status = 'results_delivered_by_link' if is_complete else 'partially_delivered'
    db.session.commit()

    base_url = request.host_url
    pdf_bytes, filename = generate_visit_report_pdf(visit.id, base_url)
    if pdf_bytes:
        upload_dir = os.path.join(STATIC_DIR, 'reports')
        os.makedirs(upload_dir, exist_ok=True)
        with open(os.path.join(upload_dir, filename), 'wb') as f:
            f.write(pdf_bytes)
        add_visit_reports(visit, [f'static/reports/{filename}'])
        db.session.commit()

    # Only a fully-delivered visit gets auto-messaged — a partial save just updates the
    # status text (see is_complete above) so the client isn't notified about incomplete
    # results. The frontend (results_entry.js) sends via the Node WhatsApp/SMS bot itself,
    # same as the "Upload PDF Report" flow — this only tells it whether/how to.
    messaging = None
    if is_complete:
        config = LabConfig.get_config()
        patient = Client.query.get(visit.patient_id)
        messaging = {
            'enabled': bool(config.msg_enabled),
            'method': config.msg_method,
            'phone': patient.phone if patient else None,
            'patient_name': f'{patient.first_name} {patient.last_name}' if patient else visit.patient_name,
            'patient_id': visit.patient_id,
        }

    return jsonify({
        'success': True,
        'report_url': f'static/reports/{filename}' if pdf_bytes else None,
        'is_complete': is_complete,
        'completed_tests': completed_tests,
        'all_tests': all_tests,
        'messaging': messaging,
    }), 200


# --- VIEW RESULTS (read-only per-visit results, for the Dashboard's "click a record" popup) ---

@reports_bp.route('/visits/<int:visit_id>/results-view', methods=['GET'])
def get_results_view(visit_id):
    visit = PatientVisit.query.get(visit_id)
    if not visit:
        return jsonify({'error': 'Visit not found'}), 404
    patient = Client.query.get(visit.patient_id)

    existing_results = {
        (r.lab_test_id, r.parameter_name): r
        for r in TestResult.query.filter_by(visit_id=visit.id).all()
    }

    tests_payload = []
    for test in _booked_tests(visit.id):
        templates = (TestParameterTemplate.query
                     .filter_by(lab_test_id=test.id)
                     .order_by(TestParameterTemplate.display_order)
                     .all())
        params_payload = []
        for tpl in templates:
            existing = existing_results.get((test.id, tpl.name))
            params_payload.append({
                'name': tpl.name,
                'unit': tpl.unit,
                'method': tpl.method,
                'reference_range_text': tpl.reference_range_text,
                'result_value': existing.result_value if existing else '',
                'status': _param_status(existing, tpl),
            })
        # A test counts as delivered once any of its parameters has a saved result — same
        # "at least one result" rule get_completed_test_names() uses for the visit-level
        # partially_delivered/delivered status, so this card-level indicator agrees with it.
        has_any_result = any(p['status'] != 'pending' for p in params_payload)
        tests_payload.append({
            'test_name': test.name,
            'status': 'delivered' if has_any_result else 'pending',
            'parameters': params_payload,
        })

    return jsonify({
        'visit_id': visit.id,
        'visit_code': visit.visit_id,
        'patient_id': visit.patient_id,
        'patient_name': patient.first_name + ' ' + patient.last_name if patient else visit.patient_name,
        'date': visit.date,
        'tests': tests_payload,
    }), 200


# --- PATIENT TEST HISTORY (trend charts shown above the test cards in the results popup) ---

@reports_bp.route('/clients/<int:client_id>/test-history', methods=['GET'])
def get_client_test_history(client_id):
    """One series per test the patient has ever had, across every one of their visits —
    one line per numeric parameter, so the frontend can chart trends (e.g. CBC's WBC/RBC
    over time) before drilling into a single visit. Non-numeric results (e.g. "Negative")
    can't be plotted on a line chart and are skipped. A single visit still renders as a
    one-point series (rather than waiting for a second visit to show anything at all) and
    naturally grows into a real trend line as more visits come in."""
    visits = (PatientVisit.query
              .filter_by(patient_id=client_id)
              .order_by(PatientVisit.date)
              .all())
    if not visits:
        return jsonify({'tests': []}), 200

    visit_ids = [v.id for v in visits]  # already chronological (query ordered by date)
    visit_dates = {v.id: (v.date or '') for v in visits}

    results = TestResult.query.filter(TestResult.visit_id.in_(visit_ids)).all()

    test_visit_ids = {}  # test_name -> set of visit_ids where that test was done at all
    values = {}  # test_name -> parameter_name -> {visit_id: numeric value}
    units = {}  # (test_name, parameter_name) -> unit
    for r in results:
        if r.visit_id is None:
            continue
        test_visit_ids.setdefault(r.test_name, set()).add(r.visit_id)
        if not r.result_value:
            continue
        try:
            numeric = float(r.result_value)
        except ValueError:
            continue
        values.setdefault(r.test_name, {}).setdefault(r.parameter_name, {})[r.visit_id] = numeric
        units[(r.test_name, r.parameter_name)] = r.unit

    tests_payload = []
    for test_name, vids in test_visit_ids.items():
        ordered_vids = [vid for vid in visit_ids if vid in vids]

        series = []
        for param_name, by_visit in values.get(test_name, {}).items():
            data = [by_visit.get(vid) for vid in ordered_vids]
            if not any(v is not None for v in data):
                continue
            series.append({'name': param_name, 'unit': units.get((test_name, param_name)), 'data': data})

        if series:
            tests_payload.append({
                'test_name': test_name,
                'labels': [visit_dates[vid] for vid in ordered_vids],
                'series': series,
            })

    return jsonify({'tests': tests_payload}), 200


def _param_status(result, template):
    """normal / high / low / abnormal / entered / pending — derived at read time so it
    always reflects the current parameter template's reference range, even if that range
    was edited after the result was saved."""
    if not result or not result.result_value:
        return 'pending'
    if template and template.ref_low is not None and template.ref_high is not None:
        try:
            numeric = float(result.result_value)
            if numeric < template.ref_low:
                return 'low'
            if numeric > template.ref_high:
                return 'high'
            return 'normal'
        except ValueError:
            pass
    return 'abnormal' if result.status == 'abnormal' else 'entered'


# --- STATISTICS (flattened per-parameter results across every visit, for the Statistics tab) ---

@reports_bp.route('/statistics/test-results', methods=['GET'])
def get_statistics_results():
    """Supports optional pagination + filtering via ?page=&per_page=&date_from=&date_to=&
    gender=&search=&status= — omit `page` to get the full unfiltered list exactly as before.

    `status` (normal/high/low/abnormal/entered/pending) is computed per row against each
    parameter's reference range, not a raw column, so it's applied in Python after the
    date/gender/search filters (which ARE applied at the SQL level) have already shrunk the
    candidate set — same total DB work as before for the unfiltered case, less for any
    filtered one.
    """
    query = (db.session.query(TestResult, PatientVisit, Client)
             .join(PatientVisit, TestResult.visit_id == PatientVisit.id)
             .outerjoin(Client, PatientVisit.patient_id == Client.id)
             .filter(TestResult.result_value.isnot(None), TestResult.result_value != ''))

    date_from = request.args.get('date_from')
    date_to = request.args.get('date_to')
    if date_from:
        query = query.filter(PatientVisit.date >= date_from)
    if date_to:
        query = query.filter(PatientVisit.date <= date_to + ' 23:59:59')

    gender = request.args.get('gender')
    if gender:
        query = query.filter(Client.gender == gender)

    search = request.args.get('search')
    if search:
        like = f'%{search}%'
        query = query.filter(db.or_(
            PatientVisit.patient_name.ilike(like),
            TestResult.test_name.ilike(like),
            TestResult.parameter_name.ilike(like),
            Client.phone.ilike(like),
        ))

    rows = query.all()

    templates_cache = {}
    payload = []
    for result, visit, patient in rows:
        key = (result.lab_test_id, result.parameter_name)
        if result.lab_test_id is not None and key not in templates_cache:
            templates_cache[key] = (TestParameterTemplate.query
                                     .filter_by(lab_test_id=result.lab_test_id, name=result.parameter_name)
                                     .first())
        tpl = templates_cache.get(key)

        payload.append({
            'visit_id': visit.id,
            'patient_id': visit.patient_id,
            'patient_name': f'{patient.first_name} {patient.last_name}' if patient else visit.patient_name,
            'gender': patient.gender if patient else None,
            'phone': patient.phone if patient else None,
            'date': visit.date,
            'test_name': result.test_name,
            'parameter_name': result.parameter_name,
            'result_value': result.result_value,
            'unit': result.unit,
            'reference_range': result.reference_range,
            'status': _param_status(result, tpl),
        })

    status = request.args.get('status')
    if status:
        payload = [r for r in payload if r['status'] == status]

    payload.sort(key=lambda r: r['date'] or '', reverse=True)

    page = request.args.get('page', type=int)
    if page is not None:
        per_page = max(1, min(request.args.get('per_page', 100, type=int), 500))
        total = len(payload)
        start = (page - 1) * per_page
        return jsonify({
            'items': payload[start:start + per_page],
            'page': page,
            'per_page': per_page,
            'total': total,
            'total_pages': max(1, (total + per_page - 1) // per_page),
        }), 200

    return jsonify(payload), 200


# --- REPORT CONTEXT + PDF GENERATION ---

def build_report_context(visit_id):
    """Data needed by both the generated PDF and the public /report/<id> page."""
    visit = PatientVisit.query.get(visit_id)
    if not visit:
        return None
    patient = Client.query.get(visit.patient_id)
    config = LabConfig.get_config()

    results = TestResult.query.filter_by(visit_id=visit.id).all()
    results_by_test = {}
    for r in results:
        results_by_test.setdefault(r.lab_test_id, []).append(r)

    booked = _booked_tests(visit.id)
    templates_by_key = {}
    for test in booked:
        for tpl in TestParameterTemplate.query.filter_by(lab_test_id=test.id).all():
            templates_by_key[(test.id, tpl.name)] = tpl

    tests = []
    interpretations = []
    for test in booked:
        rows = []
        for r in results_by_test.get(test.id, []):
            tpl = templates_by_key.get((test.id, r.parameter_name))
            rows.append({
                'name': r.parameter_name,
                'method': tpl.method if tpl else None,
                'result_value': r.result_value,
                'unit': r.unit,
                'reference_range': r.reference_range,
                'abnormal': r.status == 'abnormal',
            })
            if r.status == 'abnormal' and tpl and tpl.abnormal_note:
                interpretations.append({'parameter': r.parameter_name, 'note': tpl.abnormal_note})
        if rows:
            tests.append({'name': test.name, 'rows': rows})

    age = None
    if patient and patient.date_of_birth:
        today = datetime.utcnow().date()
        dob = patient.date_of_birth
        age = today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))

    return {
        'config': config,
        'visit': visit,
        'patient': patient,
        'age': age,
        'tests': tests,
        'interpretations': interpretations,
        'report_date': datetime.utcnow(),
    }


def _load_image_flowable(image_ref, max_width):
    """LabConfig.logo_path/cover_path is either a data: URI (uploaded via Settings) or a
    static-relative path (the shipped defaults). Returns None rather than raising if it
    can't be loaded — a missing logo shouldn't block report generation."""
    if not image_ref:
        return None
    try:
        if image_ref.startswith('data:'):
            _, b64data = image_ref.split(',', 1)
            img_bytes = base64.b64decode(b64data)
        else:
            path = os.path.join(STATIC_DIR, image_ref.lstrip('/'))
            if not os.path.exists(path):
                return None
            with open(path, 'rb') as f:
                img_bytes = f.read()

        pil_img = PILImage.open(BytesIO(img_bytes)).convert('RGBA')
        ratio = (pil_img.height / pil_img.width) if pil_img.width else 1
        out_buffer = BytesIO()
        pil_img.save(out_buffer, format='PNG')
        out_buffer.seek(0)
        return RLImage(out_buffer, width=max_width, height=max_width * ratio)
    except Exception:
        return None


def _make_qr_flowable(url, size=1.2 * inch):
    try:
        qr_img = qrcode.make(url)
        buffer = BytesIO()
        qr_img.save(buffer, format='PNG')
        buffer.seek(0)
        return RLImage(buffer, width=size, height=size)
    except Exception:
        return None


def generate_visit_report_pdf(visit_id, base_url):
    """Returns (pdf_bytes, filename) or (None, None) if the visit doesn't exist."""
    ctx = build_report_context(visit_id)
    if not ctx:
        return None, None

    config, visit, patient = ctx['config'], ctx['visit'], ctx['patient']
    styles = getSampleStyleSheet()
    small = ParagraphStyle('Small', parent=styles['Normal'], fontSize=8, textColor=colors.HexColor('#555555'))
    title_style = ParagraphStyle('LabTitle', parent=styles['Heading1'], fontSize=18, textColor=colors.HexColor('#2d3748'))
    sub_style = ParagraphStyle('LabSub', parent=styles['Normal'], fontSize=10, textColor=colors.HexColor('#667eea'))

    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter, topMargin=0.5 * inch, bottomMargin=0.5 * inch)
    elements = []

    # --- Header: logo + name/subtitle, doctor/tech credentials, contact ---
    logo = _load_image_flowable(config.logo_path, max_width=0.8 * inch)
    name_block = [Paragraph(config.lab_name or 'Laboratory', title_style)]
    if config.lab_subtitle:
        name_block.append(Paragraph(config.lab_subtitle, sub_style))
    header_table = Table([[logo or '', name_block]], colWidths=[1 * inch, 5.9 * inch])
    header_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE')]))
    elements.append(header_table)

    doctor_lines = filter(None, [config.lab_director, config.doctor_qualification,
                                  f'Reg. No. {config.doctor_reg_no}' if config.doctor_reg_no else None])
    tech_lines = filter(None, [config.tech_name, config.tech_qualification, config.tech_institute])
    elements.append(Table(
        [[Paragraph('<br/>'.join(doctor_lines), small), Paragraph('<br/>'.join(tech_lines), small)]],
        colWidths=[3.45 * inch, 3.45 * inch],
    ))

    contact = ' | '.join(filter(None, [config.lab_address, config.lab_phone, config.lab_email]))
    if contact:
        elements.append(Paragraph(contact, small))
    social = ' | '.join(filter(None, [config.social_facebook, config.social_instagram, config.social_twitter]))
    if social:
        elements.append(Paragraph(social, small))
    elements.append(Spacer(1, 10))

    # --- Patient info box + QR ---
    qr = _make_qr_flowable(f"{base_url.rstrip('/')}/report/{visit.id}")
    patient_name = f'{patient.first_name} {patient.last_name}' if patient else (visit.patient_name or '')
    info_lines = [
        f'<b>Patient:</b> {patient_name}',
        f'<b>Report ID:</b> {visit.visit_id}',
        f"<b>Age/Sex:</b> {ctx['age'] if ctx['age'] is not None else '-'} / {patient.gender if patient else '-'}",
        f'<b>Referred By:</b> {visit.referred_by or "Self"}',
        f'<b>Collection Date:</b> {visit.date}',
        f"<b>Report Date:</b> {ctx['report_date'].strftime('%Y-%m-%d %H:%M')}",
    ]
    info_table = Table(
        [[Paragraph('<br/>'.join(info_lines), styles['Normal']), qr or '']],
        colWidths=[5.5 * inch, 1.4 * inch],
    )
    info_table.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 1, colors.HexColor('#cccccc')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
    ]))
    elements.append(info_table)
    elements.append(Spacer(1, 15))

    # --- Per-test result tables ---
    for test in ctx['tests']:
        elements.append(Paragraph(test['name'].upper(), ParagraphStyle(
            'TestTitle', parent=styles['Heading3'], textColor=colors.HexColor('#2d3748'))))
        table_data = [['Investigation', 'Result', 'Ref. Range', 'Unit']]
        style_commands = [
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#667eea')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#dddddd')),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('PADDING', (0, 0), (-1, -1), 6),
        ]
        for i, row in enumerate(test['rows'], start=1):
            name_cell = row['name'] + (f"\n{row['method']}" if row['method'] else '')
            table_data.append([name_cell, row['result_value'] or '-', row['reference_range'] or '-', row['unit'] or '-'])
            if row['abnormal']:
                style_commands.append(('FONTNAME', (1, i), (1, i), 'Helvetica-Bold'))
                style_commands.append(('TEXTCOLOR', (1, i), (1, i), colors.HexColor('#c0392b')))
        t = Table(table_data, colWidths=[2.6 * inch, 1.5 * inch, 1.5 * inch, 1.2 * inch])
        t.setStyle(TableStyle(style_commands))
        elements.append(t)
        elements.append(Spacer(1, 10))

    # --- Interpretation ---
    if ctx['interpretations']:
        lines = [f"<b>{i['parameter']}:</b> {i['note']}" for i in ctx['interpretations']]
        interp_table = Table([[Paragraph(
            '<b>Interpretation:</b><br/>' + '<br/>'.join(lines), styles['Normal'])]],
            colWidths=[6.9 * inch])
        interp_table.setStyle(TableStyle([
            ('BOX', (0, 0), (-1, -1), 1, colors.HexColor('#cccccc')),
            ('PADDING', (0, 0), (-1, -1), 10),
        ]))
        elements.append(interp_table)
        elements.append(Spacer(1, 15))

    # --- Barcode + footer ---
    barcode = createBarcodeDrawing('Code128', value=visit.visit_id, humanReadable=True, barHeight=12)
    elements.append(barcode)
    elements.append(Spacer(1, 10))

    footer = config.report_footer_note or 'This report is not valid for medical legal purposes.'
    elements.append(Paragraph(footer, small))

    doc.build(elements)
    buffer.seek(0)
    filename = f"report_{visit.visit_id}.pdf".replace('/', '-')
    return buffer.read(), filename
