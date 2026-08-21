import ast
import base64
import os
import re
from datetime import datetime
from io import BytesIO

from flask import Blueprint, request, jsonify, current_app, Response

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch, cm
from reportlab.lib.enums import TA_CENTER
from reportlab.lib import colors
from reportlab.lib.utils import ImageReader
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
from reportlab.graphics.barcode import createBarcodeDrawing
from reportlab.graphics import renderPDF
import qrcode
from PIL import Image as PILImage

from src.models.user import db, LabTest, PatientVisit
from src.models.client import Client
from src.models.test_result import TestResult
from src.models.test_parameter import TestParameterTemplate
from src.models.lab_config import LabConfig
from src.models.junctions import VisitTest, VisitReportPage, add_visit_reports, get_visit_test_names, get_completed_test_names
from src.utils.timezone import now_cairo
from src.utils.arabic_text import register_arabic_font, paragraph_text, draw_string_auto

reports_bp = Blueprint('reports_bp', __name__)

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'static')

register_arabic_font()

# --- PARAMETER TEMPLATE CRUD (per LabTest — Settings > Test List > "Parameters") ---

# Auto-calculation formulas can reference any number of sibling parameters, each embedded as
# a stable "{id}" token (e.g. "{55} / {56} * 10" — see relation_formula's docstring on the
# model; the Result Parameters modal shows/edits these as Excel-like "[Name]" references and
# converts to/from {id} client-side). Restricted to this tiny arithmetic grammar rather than
# eval()'d directly — no attribute access, no function calls, no name other than a reference
# token. Validated at save time (_validate_relation_formula) and (identically, in JS)
# evaluated live during results entry; never evaluated server-side against a real result,
# since the auto-fill is a convenience the technician can always override by hand.
_ALLOWED_BIN_OPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)
_ALLOWED_UNARY_OPS = (ast.UAdd, ast.USub)
_REF_TOKEN_RE = re.compile(r'\{(\d+)\}')


def _validate_formula_syntax(formula, referenced_ids):
    # {id} isn't valid Python syntax on its own, so swap each token for a plain identifier
    # (P<id>) before parsing — the set of ids that were actually swapped in is exactly the
    # set of Names the walk below is allowed to accept.
    substituted = _REF_TOKEN_RE.sub(lambda m: f'P{m.group(1)}', formula)
    try:
        tree = ast.parse(substituted, mode='eval')
    except SyntaxError:
        raise ValueError('Formula is not a valid arithmetic expression')

    allowed_names = {f'P{i}' for i in referenced_ids}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Expression, ast.Load)):
            continue  # ast.walk also visits a Name's ctx (Load()) as a separate node
        if isinstance(node, _ALLOWED_BIN_OPS + _ALLOWED_UNARY_OPS):
            continue  # BinOp/UnaryOp's .op is itself walked as a standalone node (e.g. Add())
        if isinstance(node, ast.BinOp) and isinstance(node.op, _ALLOWED_BIN_OPS):
            continue
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, _ALLOWED_UNARY_OPS):
            continue
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            continue
        if isinstance(node, ast.Name) and node.id in allowed_names:
            continue
        raise ValueError('Formula may only reference this test\'s parameters, numbers, + - * / ** and parentheses')


def _validate_relation_formula(row_id, lab_test_id, formula):
    """Validates a parameter's auto-calculation formula — e.g. "{55} / {56} * 10", where each
    {id} references another TestParameterTemplate row (see relation_formula on the model).
    Returns the cleaned formula string to persist ('' clears any existing formula). Raises
    ValueError with a user-facing message on anything invalid: no referenced parameters,
    self-reference, a reference outside this test, a circular chain, or a formula that
    doesn't parse under the restricted grammar above."""
    formula = (formula or '').strip()
    if formula.startswith('='):
        formula = formula[1:].strip()  # "=" is just familiar Excel styling, not part of the grammar
    if not formula:
        return ''

    referenced_ids = {int(m) for m in _REF_TOKEN_RE.findall(formula)}
    if not referenced_ids:
        raise ValueError('Formula must reference at least one other parameter')
    if row_id is not None and row_id in referenced_ids:
        raise ValueError('A parameter cannot depend on itself')

    referenced_rows = {r.id: r for r in TestParameterTemplate.query.filter(
        TestParameterTemplate.id.in_(referenced_ids)).all()}
    for referenced_id in referenced_ids:
        related = referenced_rows.get(referenced_id)
        if not related or related.lab_test_id != lab_test_id:
            raise ValueError('Formula references a parameter outside this test')

    # Follow every referenced parameter's own formula outward — if that chain ever leads back
    # to this row, the relation would make the auto-fill recompute forever.
    seen = set()
    queue = list(referenced_ids)
    while queue:
        current_id = queue.pop()
        if row_id is not None and current_id == row_id:
            raise ValueError('This relation would create a circular reference')
        if current_id in seen:
            continue
        seen.add(current_id)
        current_row = referenced_rows.get(current_id) or TestParameterTemplate.query.get(current_id)
        if current_row and current_row.relation_formula:
            queue.extend(int(m) for m in _REF_TOKEN_RE.findall(current_row.relation_formula))

    _validate_formula_syntax(formula, referenced_ids)
    return formula


def _validate_absolute_count_formula(row_id, lab_test_id, formula):
    """Validates a parameter's "Absolute Count" formula — same {id}-token grammar as
    relation_formula, but self-reference is expected and allowed here: an absolute count is
    very often computed from the parameter's own percentage value (e.g. Absolute Neutrophil
    Count = Neutrophils% / 100 * WBC), and since it produces a value nothing else ever reads
    as an input, there's no circular-reference chain to guard against either."""
    formula = (formula or '').strip()
    if formula.startswith('='):
        formula = formula[1:].strip()
    if not formula:
        return ''

    referenced_ids = {int(m) for m in _REF_TOKEN_RE.findall(formula)}
    if not referenced_ids:
        raise ValueError('Formula must reference at least one parameter')

    referenced_rows = {r.id: r for r in TestParameterTemplate.query.filter(
        TestParameterTemplate.id.in_(referenced_ids)).all()}
    for referenced_id in referenced_ids:
        related = referenced_rows.get(referenced_id)
        if not related or related.lab_test_id != lab_test_id:
            raise ValueError('Formula references a parameter outside this test')

    _validate_formula_syntax(formula, referenced_ids)
    return formula


def _validate_parent_parameter(row_id, lab_test_id, parent_id):
    """Validates a parameter's optional parent (e.g. "Segmented"/"Band" nested under
    "Neutrophil" — see parent_parameter_id on the model). None/'' clears it. Nesting is
    capped at one level — the parent itself must not already have a parent — matching the
    only shape the categorized report layout (_render_relative_absolute_table) knows how to
    draw: a root row followed by its direct children, never grandchildren."""
    if parent_id in (None, ''):
        return None
    parent_id = int(parent_id)
    parent = TestParameterTemplate.query.get(parent_id)
    if not parent or parent.lab_test_id != lab_test_id:
        raise ValueError('Parent parameter must belong to the same test')
    if row_id is not None and parent.id == row_id:
        raise ValueError('A parameter cannot be its own parent')
    if parent.parent_parameter_id is not None:
        raise ValueError('A sub-parameter cannot itself have sub-parameters')
    return parent.id


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

    try:
        relation_formula = _validate_relation_formula(None, lab_test_id, data.get('relation_formula'))
        absolute_count_formula = _validate_absolute_count_formula(None, lab_test_id, data.get('absolute_count_formula'))
        parent_parameter_id = _validate_parent_parameter(None, lab_test_id, data.get('parent_parameter_id'))
    except ValueError as error:
        return jsonify({'error': str(error)}), 400

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
        gender_specific=bool(data.get('gender_specific')),
        ref_low_male=data.get('ref_low_male'),
        ref_high_male=data.get('ref_high_male'),
        ref_low_female=data.get('ref_low_female'),
        ref_high_female=data.get('ref_high_female'),
        relation_formula=relation_formula or None,
        absolute_count_formula=absolute_count_formula or None,
        absolute_count_unit=data.get('absolute_count_unit'),
        absolute_ref_low=data.get('absolute_ref_low'),
        absolute_ref_high=data.get('absolute_ref_high'),
        category=data.get('category') or None,
        parent_parameter_id=parent_parameter_id,
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

    if 'relation_formula' in data:
        try:
            relation_formula = _validate_relation_formula(row.id, row.lab_test_id, data.get('relation_formula'))
        except ValueError as error:
            return jsonify({'error': str(error)}), 400
        row.relation_formula = relation_formula or None

    if 'absolute_count_formula' in data:
        try:
            absolute_count_formula = _validate_absolute_count_formula(
                row.id, row.lab_test_id, data.get('absolute_count_formula'))
        except ValueError as error:
            return jsonify({'error': str(error)}), 400
        row.absolute_count_formula = absolute_count_formula or None

    if 'parent_parameter_id' in data:
        try:
            row.parent_parameter_id = _validate_parent_parameter(
                row.id, row.lab_test_id, data.get('parent_parameter_id'))
        except ValueError as error:
            return jsonify({'error': str(error)}), 400

    for field in ('name', 'unit', 'method', 'ref_low', 'ref_high',
                  'reference_range_text', 'abnormal_note', 'display_order',
                  'gender_specific', 'ref_low_male', 'ref_high_male',
                  'ref_low_female', 'ref_high_female',
                  'absolute_count_unit', 'absolute_ref_low', 'absolute_ref_high',
                  'category'):
        if field in data:
            setattr(row, field, data[field])

    db.session.commit()
    return jsonify(row.to_dict()), 200


@reports_bp.route('/parameters/<int:param_id>', methods=['DELETE'])
def delete_test_parameter(param_id):
    row = TestParameterTemplate.query.get(param_id)
    if not row:
        return jsonify({'error': 'Parameter not found'}), 404

    # Note: any child parameter's parent_parameter_id pointing at this row needs no cleanup
    # here — it's a real FK with ON DELETE SET NULL (see the model), so the DB demotes the
    # child back to top-level on its own, unlike the two dangling-token cases below (plain
    # strings, not real FKs, so SQLite can't clean them up for us).
    #
    # Any other parameter in the same test whose formula references this one is left with a
    # dangling {id} token once it's gone — clearing the whole formula (rather than trying to
    # surgically remove just that token, which could leave a malformed expression like
    # "/{56}") is the safe choice; the technician can rebuild it via the click-to-insert UI.
    # relation_formula and absolute_count_formula are independent columns, so both need
    # scanning separately.
    token = f'{{{row.id}}}'
    dependents = TestParameterTemplate.query.filter(
        TestParameterTemplate.lab_test_id == row.lab_test_id,
        db.or_(
            TestParameterTemplate.relation_formula.like(f'%{token}%'),
            TestParameterTemplate.absolute_count_formula.like(f'%{token}%'),
        )
    ).all()
    for dependent in dependents:
        if dependent.relation_formula and token in dependent.relation_formula:
            dependent.relation_formula = None
        if dependent.absolute_count_formula and token in dependent.absolute_count_formula:
            dependent.absolute_count_formula = None

    db.session.delete(row)
    db.session.commit()
    return jsonify({'success': True}), 200


# --- RESULTS ENTRY (the "🧪 Enter Results" window) ---

def _booked_visit_tests(visit_id):
    """(LabTest, VisitTest) pairs for a visit, in booking order."""
    return (db.session.query(LabTest, VisitTest)
            .join(VisitTest, VisitTest.lab_test_id == LabTest.id)
            .filter(VisitTest.visit_id == visit_id)
            .order_by(VisitTest.position)
            .all())


def _booked_tests(visit_id):
    """Booked tests for a visit, in booking order, as LabTest rows."""
    return [lt for lt, vt in _booked_visit_tests(visit_id)]


def _effective_ref_range(template, gender):
    """(ref_low, ref_high, display_text) resolved against a client's gender when the
    template has separate male/female ranges configured. Falls back to the generic
    ref_low/ref_high/reference_range_text if gender is missing/unrecognized or that
    side isn't configured."""
    if not template:
        return None, None, None
    if template.gender_specific:
        if gender == 'Female' and template.ref_low_female is not None:
            lo, hi = template.ref_low_female, template.ref_high_female
        elif gender == 'Male' and template.ref_low_male is not None:
            lo, hi = template.ref_low_male, template.ref_high_male
        else:
            lo, hi = template.ref_low, template.ref_high
        text = f'{lo:g} - {hi:g}' if lo is not None and hi is not None else template.reference_range_text
        return lo, hi, text
    return template.ref_low, template.ref_high, template.reference_range_text


@reports_bp.route('/visits/<int:visit_id>/results-schema', methods=['GET'])
def get_results_schema(visit_id):
    visit = PatientVisit.query.get(visit_id)
    if not visit:
        return jsonify({'error': 'Visit not found'}), 404
    patient = Client.query.get(visit.patient_id)
    gender = patient.gender if patient else None

    existing_results = {
        (r.lab_test_id, r.parameter_name): r
        for r in TestResult.query.filter_by(visit_id=visit.id).all()
    }

    tests_payload = []
    for test, visit_test in _booked_visit_tests(visit.id):
        templates = (TestParameterTemplate.query
                     .filter_by(lab_test_id=test.id)
                     .order_by(TestParameterTemplate.display_order)
                     .all())
        params_payload = []
        for tpl in templates:
            existing = existing_results.get((test.id, tpl.name))
            ref_low, ref_high, ref_text = _effective_ref_range(tpl, gender)
            params_payload.append({
                'template_id': tpl.id,
                'name': tpl.name,
                'unit': tpl.unit,
                'method': tpl.method,
                'ref_low': ref_low,
                'ref_high': ref_high,
                'reference_range_text': ref_text,
                'result_value': existing.result_value if existing else '',
                'relation_formula': tpl.relation_formula,
                'absolute_count_formula': tpl.absolute_count_formula,
                'absolute_count_unit': tpl.absolute_count_unit,
                'absolute_ref_low': tpl.absolute_ref_low,
                'absolute_ref_high': tpl.absolute_ref_high,
                'absolute_count': existing.absolute_count if existing else '',
            })
        tests_payload.append({
            'lab_test_id': test.id,
            'test_name': test.name,
            'comment': visit_test.comment or '',
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
    patient = Client.query.get(visit.patient_id)
    gender = patient.gender if patient else None

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
        ref_low, ref_high, ref_text = _effective_ref_range(template, gender)
        reference_range = entry.get('reference_range_text') or ref_text
        if ref_low is not None and ref_high is not None:
            try:
                numeric = float(result_value)
                status = 'normal' if ref_low <= numeric <= ref_high else 'abnormal'
            except ValueError:
                pass

        # Absolute Count — computed client-side (evaluateFormula in results_entry.js) and
        # submitted as-is, same trust model as result_value; stored alongside it. unit/
        # reference_range are a snapshot of the template at save time, mirroring how the main
        # value's own unit/reference_range are captured (non-gender-specific by design — see
        # absolute_count_formula's docstring).
        absolute_count = (entry.get('absolute_count') or '').strip()
        absolute_unit = None
        absolute_reference_range = None
        if absolute_count and template:
            absolute_unit = template.absolute_count_unit
            if template.absolute_ref_low is not None and template.absolute_ref_high is not None:
                absolute_reference_range = f'{template.absolute_ref_low:g} - {template.absolute_ref_high:g}'

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
            absolute_count=absolute_count or None,
            absolute_unit=absolute_unit,
            absolute_reference_range=absolute_reference_range,
        ))

    # Per-test technician comments (shown in the report footer) — independent of whether
    # that test has any saved numeric results this round, so a standalone comment sticks.
    for lab_test_id_str, comment_text in (data.get('comments') or {}).items():
        try:
            lab_test_id = int(lab_test_id_str)
        except (TypeError, ValueError):
            continue
        visit_test = VisitTest.query.filter_by(visit_id=visit.id, lab_test_id=lab_test_id).first()
        if visit_test:
            visit_test.comment = (comment_text or '').strip() or None

    db.session.commit()

    # A visit is only "delivered" once every booked test has at least one saved result —
    # otherwise it's "partially_delivered" and the UI surfaces which specific test(s) are
    # done instead of a generic status. Uploading a whole PDF (upload_report() in main.py)
    # is treated as covering the entire visit and is unaffected by this per-test tracking.
    #
    # A complete visit doesn't go straight to "delivered" when approval is required — it sits
    # at "awaiting_approval" (a distinct status, not just approval_status) so it reads
    # correctly everywhere visit.status is shown (Dashboard, Patient Directory, Test Results)
    # and, critically, so it does NOT show up in Test Results' "Delivered" history or trigger
    # delivery-looking UI until a permitted user actually approves it via Test Results > Check.
    all_tests = get_visit_test_names(visit.id)
    completed_tests = get_completed_test_names(visit.id)
    is_complete = bool(all_tests) and len(completed_tests) == len(all_tests)
    config = LabConfig.get_config()
    if is_complete:
        if config.require_results_approval:
            visit.status = 'awaiting_approval'
            visit.approval_status = 'pending_approval'
        else:
            visit.status = 'results_delivered_by_link'
            visit.approval_status = 'not_required'
    else:
        visit.status = 'partially_delivered'
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
        messaging = {
            'enabled': bool(config.msg_enabled) and not config.require_results_approval,
            'approval_pending': bool(config.require_results_approval),
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


@reports_bp.route('/visits/<int:visit_id>/results/preview', methods=['POST'])
def preview_results(visit_id):
    """Non-destructive preview of the report a Save right now would produce — same payload
    shape as POST .../results, but nothing is written to TestResult/VisitTest.comment, the
    visit's status never changes, and no WhatsApp/SMS message is ever sent. Lets a
    technician preview (and re-preview after adjusting the report layout) before committing
    with the real Save."""
    data = request.json or {}
    ctx = build_preview_context(visit_id, data.get('results', []), data.get('comments') or {})
    if not ctx:
        return jsonify({'error': 'Visit not found'}), 404
    pdf_bytes, _filename = _render_pdf_from_context(ctx, request.host_url)
    if not pdf_bytes:
        return jsonify({'error': 'Could not generate preview'}), 500
    return Response(pdf_bytes, mimetype='application/pdf')


# --- VIEW RESULTS (read-only per-visit results, for the Dashboard's "click a record" popup) ---

@reports_bp.route('/visits/<int:visit_id>/results-view', methods=['GET'])
def get_results_view(visit_id):
    visit = PatientVisit.query.get(visit_id)
    if not visit:
        return jsonify({'error': 'Visit not found'}), 404
    patient = Client.query.get(visit.patient_id)
    gender = patient.gender if patient else None

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
            _, _, ref_text = _effective_ref_range(tpl, gender)
            params_payload.append({
                'name': tpl.name,
                'unit': tpl.unit,
                'method': tpl.method,
                'reference_range_text': ref_text,
                'result_value': existing.result_value if existing else '',
                'status': _param_status(existing, tpl, gender),
            })
        # A test counts as delivered once any of its parameters has a saved result — same
        # "at least one result" rule get_completed_test_names() uses for the visit-level
        # partially_delivered/delivered status, so this card-level indicator agrees with it.
        has_any_result = any(p['status'] != 'pending' for p in params_payload)
        tests_payload.append({
            'test_name': test.name,
            'sample_type': test.sample_type,
            'status': 'delivered' if has_any_result else 'pending',
            'parameters': params_payload,
        })

    return jsonify({
        'visit_id': visit.id,
        'visit_code': visit.visit_id,
        'patient_id': visit.patient_id,
        'patient_name': patient.first_name + ' ' + patient.last_name if patient else visit.patient_name,
        'date': visit.date,
        'status': visit.status,
        'approval_status': visit.approval_status,
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


def _param_status(result, template, gender=None):
    """normal / high / low / abnormal / entered / pending — derived at read time so it
    always reflects the current parameter template's reference range (and the client's
    gender, for gender-specific ranges), even if that range was edited after the result
    was saved."""
    if not result or not result.result_value:
        return 'pending'
    ref_low, ref_high, _ = _effective_ref_range(template, gender)
    if ref_low is not None and ref_high is not None:
        try:
            numeric = float(result.result_value)
            if numeric < ref_low:
                return 'low'
            if numeric > ref_high:
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

    physician = request.args.get('physician')
    if physician:
        query = query.filter(PatientVisit.referred_by.ilike(f'%{physician}%'))

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
        gender_value = patient.gender if patient else None

        payload.append({
            'visit_id': visit.id,
            'patient_id': visit.patient_id,
            'patient_name': f'{patient.first_name} {patient.last_name}' if patient else visit.patient_name,
            'gender': gender_value,
            'phone': patient.phone if patient else None,
            'physician_name': visit.referred_by,
            'date': visit.date,
            'test_name': result.test_name,
            'parameter_name': result.parameter_name,
            'result_value': result.result_value,
            'unit': result.unit,
            'reference_range': result.reference_range,
            'status': _param_status(result, tpl, gender_value),
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

def _absolute_count_fields(absolute_count, absolute_unit, absolute_reference_range, tpl):
    """Extra keys for a parameter row's Absolute Count, merged into that same row (via
    row.update(...)) rather than appended as a second row — lets the generic (non-categorized)
    renderer keep showing it as a stacked second row exactly as before (see
    _render_generic_test_table), while the categorized differential-count renderer
    (_render_relative_absolute_table) can lay relative % and absolute count side by side in
    one row. hl is (re)computed fresh from the template's current absolute_ref_low/high,
    mirroring how the main row's hl is (re)computed rather than trusted from a stored flag."""
    hl = None
    if absolute_count and tpl:
        try:
            numeric = float(absolute_count)
            if tpl.absolute_ref_low is not None and numeric < tpl.absolute_ref_low:
                hl = 'low'
            elif tpl.absolute_ref_high is not None and numeric > tpl.absolute_ref_high:
                hl = 'high'
        except ValueError:
            pass
    return {
        'absolute_value': absolute_count,
        'absolute_unit': absolute_unit,
        'absolute_reference_range': absolute_reference_range,
        'absolute_hl': hl,
    }


def _build_test_dict(test, results_by_test, templates_by_key, gender, interpretations):
    """Per-test {'lab_test_id', 'name', 'rows'} dict for the report, or None if it has no
    saved results yet. Gender-resolves each row's reference range (Unit 5) and classifies
    it high/low (Unit 6); appends to the shared `interpretations` list as a side effect,
    matching the original inline-loop behavior this was extracted from."""
    rows = []
    for r in results_by_test.get(test.id, []):
        tpl = templates_by_key.get((test.id, r.parameter_name))
        ref_low, ref_high, ref_text = _effective_ref_range(tpl, gender)
        hl = None
        if r.result_value:
            try:
                numeric = float(r.result_value)
                if ref_low is not None and numeric < ref_low:
                    hl = 'low'
                elif ref_high is not None and numeric > ref_high:
                    hl = 'high'
            except ValueError:
                pass
        row = {
            'name': r.parameter_name,
            'result_value': r.result_value,
            'unit': r.unit,
            'reference_range': ref_text or r.reference_range,
            'abnormal': r.status == 'abnormal',
            'hl': hl,
            'category': tpl.category if tpl else None,
            'template_id': tpl.id if tpl else None,
            'parent_template_id': tpl.parent_parameter_id if tpl else None,
        }
        if r.absolute_count:
            row.update(_absolute_count_fields(r.absolute_count, r.absolute_unit, r.absolute_reference_range, tpl))
        rows.append(row)
        if r.status == 'abnormal' and tpl and tpl.abnormal_note:
            interpretations.append({'parameter': r.parameter_name, 'note': tpl.abnormal_note})
    return {'lab_test_id': test.id, 'name': test.name, 'rows': rows} if rows else None


def _group_tests_into_pages(visit_id, visit_tests, build_test_dict_fn):
    """Shared page-grouping logic used by both build_report_context (saved TestResult rows)
    and build_preview_context (submitted-but-unsaved rows). build_test_dict_fn(test) ->
    {'lab_test_id', 'name', 'rows'} dict, or None if that test has nothing to show. A visit
    with any custom VisitReportPage rows uses that page-grouped, user-arranged layout (Unit
    7); otherwise every booked test flows in booking order on one implicit page, exactly as
    before this feature existed."""
    page_rows = VisitReportPage.query.filter_by(visit_id=visit_id).order_by(VisitReportPage.page_number).all()
    if page_rows:
        tests_by_page = {}
        unassigned_tests = []
        for test, vt in visit_tests:
            test_dict = build_test_dict_fn(test)
            if not test_dict:
                continue
            (tests_by_page.setdefault(vt.page_number, []) if vt.page_number is not None
             else unassigned_tests).append(test_dict)
        report_pages = [
            {'title': p.title, 'subtitle': p.subtitle, 'tests': tests_by_page.get(p.page_number, [])}
            for p in page_rows
        ]
        if unassigned_tests:
            report_pages.append({'title': None, 'subtitle': None, 'tests': unassigned_tests})
        return [p for p in report_pages if p['tests']]

    all_test_dicts = [d for d in (build_test_dict_fn(test) for test, _vt in visit_tests) if d]
    return [{'title': None, 'subtitle': None, 'tests': all_test_dicts}] if all_test_dicts else []


def build_report_context(visit_id):
    """Data needed by both the generated PDF and the public /report/<id> page."""
    visit = PatientVisit.query.get(visit_id)
    if not visit:
        return None
    patient = Client.query.get(visit.patient_id)
    gender = patient.gender if patient else None
    config = LabConfig.get_config()

    results = TestResult.query.filter_by(visit_id=visit.id).all()
    results_by_test = {}
    for r in results:
        results_by_test.setdefault(r.lab_test_id, []).append(r)

    visit_tests = _booked_visit_tests(visit.id)
    templates_by_key = {}
    for test, _vt in visit_tests:
        for tpl in TestParameterTemplate.query.filter_by(lab_test_id=test.id).all():
            templates_by_key[(test.id, tpl.name)] = tpl

    interpretations = []
    report_pages = _group_tests_into_pages(
        visit.id, visit_tests,
        lambda test: _build_test_dict(test, results_by_test, templates_by_key, gender, interpretations),
    )

    comments = [{'lab_test_id': test.id, 'test_name': test.name, 'comment': vt.comment}
                for test, vt in visit_tests if vt.comment]
    _attach_page_comments(report_pages, comments)

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
        'report_pages': report_pages,
        'interpretations': interpretations,
        'comments': comments,
        'report_date': now_cairo(),
    }


def _attach_page_comments(report_pages, comments):
    """Scopes each page's `comments` key (req 3) to only the comments of tests that appear
    on that page, so a technician's note about a Chemistry test doesn't show up under a
    Hematology page just because they share a visit. Mutates report_pages in place."""
    for page in report_pages:
        page_ids = {t['lab_test_id'] for t in page['tests']}
        page['comments'] = [c for c in comments if c['lab_test_id'] in page_ids]


def build_preview_context(visit_id, entries, comments_map):
    """Same shape as build_report_context, but sourced from submitted-but-unsaved data —
    `entries` (identical shape to POST .../results' `results` list) and `comments_map`
    ({lab_test_id: text}) — instead of querying TestResult/VisitTest.comment. Nothing here
    is persisted; used only to render a non-destructive preview PDF. VisitReportPage/
    VisitTest.page_number ARE read from the DB, since a layout the technician already saved
    via the Organize Report Layout modal is real, intentionally-persisted state."""
    visit = PatientVisit.query.get(visit_id)
    if not visit:
        return None
    patient = Client.query.get(visit.patient_id)
    gender = patient.gender if patient else None
    config = LabConfig.get_config()

    rows_by_test = {}
    interpretations = []
    template_cache = {}
    for entry in entries:
        result_value = (entry.get('result_value') or '').strip()
        if not result_value:
            continue
        lab_test_id = entry.get('lab_test_id')
        template_id = entry.get('template_id')
        if template_id not in template_cache:
            template_cache[template_id] = TestParameterTemplate.query.get(template_id) if template_id else None
        template = template_cache[template_id]
        ref_low, ref_high, ref_text = _effective_ref_range(template, gender)
        hl = None
        try:
            numeric = float(result_value)
            if ref_low is not None and numeric < ref_low:
                hl = 'low'
            elif ref_high is not None and numeric > ref_high:
                hl = 'high'
        except ValueError:
            pass
        abnormal = hl is not None  # preview approximation of save_results()'s normal/abnormal status
        row = {
            'name': entry.get('name', ''),
            'result_value': result_value,
            'unit': entry.get('unit'),
            'reference_range': entry.get('reference_range_text') or ref_text,
            'abnormal': abnormal,
            'hl': hl,
            'category': template.category if template else None,
            'template_id': template.id if template else None,
            'parent_template_id': template.parent_parameter_id if template else None,
        }

        absolute_count = (entry.get('absolute_count') or '').strip()
        if absolute_count:
            absolute_unit = template.absolute_count_unit if template else None
            absolute_reference_range = None
            if template and template.absolute_ref_low is not None and template.absolute_ref_high is not None:
                absolute_reference_range = f'{template.absolute_ref_low:g} - {template.absolute_ref_high:g}'
            row.update(_absolute_count_fields(absolute_count, absolute_unit, absolute_reference_range, template))

        rows_by_test.setdefault(lab_test_id, []).append(row)

        if abnormal and template and template.abnormal_note:
            interpretations.append({'parameter': row['name'], 'note': template.abnormal_note})

    visit_tests = _booked_visit_tests(visit.id)

    def build_test_dict(test):
        rows = rows_by_test.get(test.id)
        return {'lab_test_id': test.id, 'name': test.name, 'rows': rows} if rows else None

    report_pages = _group_tests_into_pages(visit.id, visit_tests, build_test_dict)

    comments_map = comments_map or {}
    comments = []
    for test, _vt in visit_tests:
        text = comments_map.get(str(test.id)) or comments_map.get(test.id)
        if text:
            comments.append({'lab_test_id': test.id, 'test_name': test.name, 'comment': text})
    _attach_page_comments(report_pages, comments)

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
        'report_pages': report_pages,
        'interpretations': interpretations,
        'comments': comments,
        'report_date': now_cairo(),
    }


def _decode_image_bytes(image_ref):
    """LabConfig.logo_path/cover_path/signature_path is either a data: URI (uploaded via
    Settings) or a static-relative path (the shipped defaults). Returns None rather than
    raising if it can't be loaded — a missing image shouldn't block report generation."""
    if not image_ref:
        return None
    try:
        if image_ref.startswith('data:'):
            _, b64data = image_ref.split(',', 1)
            return base64.b64decode(b64data)
        path = os.path.join(STATIC_DIR, image_ref.lstrip('/'))
        if not os.path.exists(path):
            return None
        with open(path, 'rb') as f:
            return f.read()
    except Exception:
        return None


def _load_image_reader(image_ref):
    """Returns (ImageReader, pixel_width, pixel_height) for direct canvas.drawImage() use
    (the report background/signature, drawn once per page via onFirstPage/onLaterPages
    rather than as a flowable), or None if the image can't be loaded."""
    img_bytes = _decode_image_bytes(image_ref)
    if not img_bytes:
        return None
    try:
        pil_img = PILImage.open(BytesIO(img_bytes)).convert('RGBA')
        buf = BytesIO()
        pil_img.save(buf, format='PNG')
        buf.seek(0)
        return ImageReader(buf), pil_img.width, pil_img.height
    except Exception:
        return None


def _make_qr_reader(url):
    """Returns an ImageReader for direct canvas.drawImage() use (the header's QR code is
    drawn on the canvas now, alongside the rest of the repeating per-page header — a
    Platypus Image flowable can't be used there), or None if it can't be built."""
    try:
        qr_img = qrcode.make(url)
        buf = BytesIO()
        qr_img.save(buf, format='PNG')
        buf.seek(0)
        return ImageReader(buf)
    except Exception:
        return None


def _safe_filename_part(text):
    return re.sub(r'[^A-Za-z0-9]+', '_', (text or '').strip()).strip('_') or 'patient'


def _hl_paragraph(value, hl, cell_style, empty='-'):
    """Value cell with the same red-H/blue-L abnormal marker used throughout the report,
    factored out so the generic table, the bulleted section, and the differential table all
    render the marker identically instead of three near-copies drifting apart over time."""
    text = paragraph_text(value) or empty
    if hl == 'high':
        return Paragraph(f"{text} <font color='#c0392b'><b>H</b></font>", cell_style)
    if hl == 'low':
        return Paragraph(f"{text} <font color='#1d4ed8'><b>L</b></font>", cell_style)
    return Paragraph(text, cell_style)


def _render_generic_test_table(elements, test, cell_style, test_title_style, box_w):
    """The original single 4-column 'Investigation | Result | Ref. Range | Unit' table — used
    for any test with fewer than 2 distinct parameter categories (i.e. every test that isn't
    explicitly split into report sections via TestParameterTemplate.category). An absolute
    count (if any) still expands into a second stacked row here, exactly as this table has
    always shown it, so nothing changes visually for a test that isn't opted into the
    categorized layout below."""
    elements.append(Paragraph(paragraph_text(test['name'].upper()), test_title_style))
    table_data = [['Investigation', 'Result', 'Ref. Range', 'Unit']]
    style_commands = [
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#667eea')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#dddddd')),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('PADDING', (0, 0), (-1, -1), 6),
    ]
    for row in test['rows']:
        table_data.append([
            Paragraph(paragraph_text(row['name']), cell_style),
            _hl_paragraph(row['result_value'], row['hl'], cell_style),
            Paragraph(paragraph_text(row['reference_range']) or '-', cell_style),
            Paragraph(paragraph_text(row['unit']) or '-', cell_style),
        ])
        if row.get('absolute_value') is not None:
            table_data.append([
                Paragraph(paragraph_text(f"{row['name']} (Absolute Count)"), cell_style),
                _hl_paragraph(row.get('absolute_value'), row.get('absolute_hl'), cell_style),
                Paragraph(paragraph_text(row.get('absolute_reference_range')) or '-', cell_style),
                Paragraph(paragraph_text(row.get('absolute_unit')) or '-', cell_style),
            ])
    col_widths = [ratio * box_w for ratio in (0.38, 0.22, 0.22, 0.18)]
    t = Table(table_data, colWidths=col_widths)
    t.setStyle(TableStyle(style_commands))
    elements.append(t)
    elements.append(Spacer(1, 10))


def _render_bulleted_parameter_section(elements, rows, cell_style, box_w):
    """'Blood Picture'-style section (see the CBC reference layout): bullet + name : boxed
    value [H/L flag] | reference range + unit. Only the numeric value itself is boxed, not
    the flag — achieved with a per-cell BACKGROUND/BOX style command targeting just that one
    column/row coordinate — matching the reference image."""
    table_data = []
    style_commands = [
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('PADDING', (0, 0), (-1, -1), 4),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]
    for i, row in enumerate(rows):
        if row['hl'] == 'high':
            flag_cell = Paragraph("<font color='#c0392b'><b>H</b></font>", cell_style)
        elif row['hl'] == 'low':
            flag_cell = Paragraph("<font color='#1d4ed8'><b>L</b></font>", cell_style)
        else:
            flag_cell = Paragraph('', cell_style)
        range_text = ' '.join(filter(None, [row.get('reference_range'), row.get('unit')])) or '-'
        table_data.append([
            Paragraph(f"• {paragraph_text(row['name'])}:", cell_style),
            Paragraph(paragraph_text(row['result_value']) or '-', cell_style),
            flag_cell,
            Paragraph(paragraph_text(range_text), cell_style),
        ])
        style_commands.append(('BACKGROUND', (1, i), (1, i), colors.HexColor('#eef2ff')))
        style_commands.append(('BOX', (1, i), (1, i), 0.5, colors.HexColor('#c7d2fe')))
    col_widths = [ratio * box_w for ratio in (0.42, 0.14, 0.06, 0.38)]
    t = Table(table_data, colWidths=col_widths)
    t.setStyle(TableStyle(style_commands))
    elements.append(t)


def _render_relative_absolute_table(elements, rows, cell_style, box_w):
    """'Differential Count'-style section (see the CBC reference layout): Test | Relative
    count % (value, range) | Absolute count K/uL (value, range), with a root parameter's
    children (matched by parent_template_id — e.g. Neutrophil's Segmented/Band) indented
    immediately below it. A row without an absolute value (a category mixing table-shaped and
    plain rows) just renders '-' in the two absolute-count cells rather than needing
    special-casing."""
    child_style = ParagraphStyle('ChildParamName', parent=cell_style, leftIndent=14)

    table_data = [
        ['Test', 'Relative count %', '', 'Absolute count K/uL', ''],
        ['', 'Value', 'Reference Range', 'Value', 'Reference Range'],
    ]
    style_commands = [
        ('BACKGROUND', (0, 0), (-1, 1), colors.HexColor('#667eea')),
        ('TEXTCOLOR', (0, 0), (-1, 1), colors.white),
        ('SPAN', (0, 0), (0, 1)),
        ('SPAN', (1, 0), (2, 0)),
        ('SPAN', (3, 0), (4, 0)),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#dddddd')),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('PADDING', (0, 0), (-1, -1), 4),
        ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]

    by_template_id = {r['template_id']: r for r in rows if r.get('template_id') is not None}
    children_by_parent = {}
    for r in rows:
        parent_id = r.get('parent_template_id')
        if parent_id is not None and parent_id in by_template_id:
            children_by_parent.setdefault(parent_id, []).append(r)

    def add_row(row, indent=False):
        name_style = child_style if indent else cell_style
        table_data.append([
            Paragraph(paragraph_text(row['name']), name_style),
            _hl_paragraph(row.get('result_value'), row.get('hl'), cell_style),
            Paragraph(paragraph_text(row.get('reference_range')) or '-', cell_style),
            _hl_paragraph(row.get('absolute_value'), row.get('absolute_hl'), cell_style),
            Paragraph(paragraph_text(row.get('absolute_reference_range')) or '-', cell_style),
        ])

    for row in rows:
        parent_id = row.get('parent_template_id')
        if parent_id is not None and parent_id in by_template_id:
            continue  # printed as a child under its parent, below
        add_row(row)
        for child in children_by_parent.get(row.get('template_id'), []):
            add_row(child, indent=True)

    col_widths = [ratio * box_w for ratio in (0.30, 0.13, 0.22, 0.13, 0.22)]
    t = Table(table_data, colWidths=col_widths, repeatRows=2)
    t.setStyle(TableStyle(style_commands))
    elements.append(t)


def _render_categorized_test(elements, test, cell_style, test_title_style, styles, box_w):
    """Renders a test whose parameters carry 2+ distinct `category` values (e.g. CBC's "Blood
    Picture"/"Differential Count") as one section per category, in first-seen row order — so
    a category prints before another purely because its parameters have a lower
    display_order, with no separate ordering field needed. Each category independently picks
    its own layout from its rows' shape (does any row carry an absolute value or a parent
    link?), never from the category's name string, so this works for any future 2+-category
    test, not just CBC."""
    elements.append(Paragraph(paragraph_text(test['name'].upper()), test_title_style))

    categories = {}
    uncategorized_rows = []
    for row in test['rows']:
        label = row.get('category')
        if label:
            categories.setdefault(label, []).append(row)
        else:
            # A parameter with no category on a test that otherwise has 2+ real categories —
            # e.g. one added under a different name than an existing category tagging pass
            # expected, so it was never matched/tagged. Rendering it with no heading at all
            # (the original behavior here) reads as a rendering bug, not "uncategorized" —
            # give it a real, visible heading instead, and print it last so the real sections
            # aren't pushed down by whatever happens to sit first in row order.
            uncategorized_rows.append(row)

    section_heading_style = ParagraphStyle(
        'SectionHeading', parent=styles['Heading4'], textColor=colors.HexColor('#4c51bf'),
        spaceBefore=4, spaceAfter=2)

    def render_section(rows):
        has_table_shape = any(r.get('absolute_value') is not None or r.get('parent_template_id') for r in rows)
        if has_table_shape:
            _render_relative_absolute_table(elements, rows, cell_style, box_w)
        else:
            _render_bulleted_parameter_section(elements, rows, cell_style, box_w)

    for label, rows in categories.items():
        elements.append(Paragraph(paragraph_text(label), section_heading_style))
        render_section(rows)
        elements.append(Spacer(1, 6))

    if uncategorized_rows:
        elements.append(Paragraph('Other Parameters', section_heading_style))
        render_section(uncategorized_rows)
        elements.append(Spacer(1, 6))


def _render_pdf_from_context(ctx, base_url):
    """Returns (pdf_bytes, filename) from a context dict built by either
    build_report_context (saved results) or build_preview_context (unsaved preview)."""
    config, visit, patient = ctx['config'], ctx['visit'], ctx['patient']
    styles = getSampleStyleSheet()
    small = ParagraphStyle('Small', parent=styles['Normal'], fontSize=8, textColor=colors.HexColor('#555555'))
    cell_style = ParagraphStyle('Cell', parent=styles['Normal'], fontSize=9)
    page_title_style = ParagraphStyle('PageTitle', parent=styles['Heading2'], textColor=colors.HexColor('#2d3748'), alignment=TA_CENTER)
    page_sub_style = ParagraphStyle('PageSub', parent=styles['Normal'], fontSize=11, textColor=colors.HexColor('#667eea'), alignment=TA_CENTER)
    test_title_style = ParagraphStyle('TestTitle', parent=styles['Heading3'], textColor=colors.HexColor('#2d3748'))

    PAGE_W, PAGE_H = letter
    MARGIN = 0.5 * inch
    GAP = 1 * cm  # the requested clearance: 1cm after the header, 1cm before the signature/footer

    patient_name = f'{patient.first_name} {patient.last_name}' if patient else (visit.patient_name or '')

    # --- Precompute the repeating header's exact layout ONCE (Paragraph.wrap() is a pure
    # layout calculation — no canvas needed — so the same Paragraph objects and heights
    # computed here are reused for both the topMargin calculation below and the actual
    # per-page drawing in _page_decorations, instead of measuring it twice with two
    # independently-maintained copies of the same logic). ---
    logo = _load_image_reader(config.logo_path) if config.show_logo_on_report else None
    LOGO_H = 0.55 * inch
    logo_w = (LOGO_H * logo[1] / logo[2]) if logo else 0
    text_x = MARGIN + (logo_w + 10 if logo else 0)
    ROW1_H = LOGO_H + 10

    doctor_lines = filter(None, [config.lab_director, config.doctor_qualification,
                                  f'Reg. No. {config.doctor_reg_no}' if config.doctor_reg_no else None])
    tech_lines = filter(None, [config.tech_name, config.tech_qualification, config.tech_institute])
    avail_w = (PAGE_W - 2 * MARGIN) / 2 - 5
    doc_p = Paragraph('<br/>'.join(paragraph_text(line) for line in doctor_lines), small)
    tech_p = Paragraph('<br/>'.join(paragraph_text(line) for line in tech_lines), small)
    _, doc_h = doc_p.wrap(avail_w, 200)
    _, tech_h = tech_p.wrap(avail_w, 200)
    ROW2_H = max(doc_h, tech_h) + 6

    contact = ' | '.join(paragraph_text(v) for v in [config.lab_address, config.lab_phone, config.lab_email] if v)
    contact_p = Paragraph(contact, small) if contact else None
    contact_h = 0
    if contact_p:
        _, contact_h = contact_p.wrap(PAGE_W - 2 * MARGIN, 40)
        contact_h += 2
    social = ' | '.join(paragraph_text(v) for v in [config.social_facebook, config.social_instagram, config.social_twitter] if v)
    social_p = Paragraph(social, small) if social else None
    social_h = 0
    if social_p:
        _, social_h = social_p.wrap(PAGE_W - 2 * MARGIN, 40)
        social_h += 2
    ROW3_H = contact_h + social_h + 8

    box_w = PAGE_W - 2 * MARGIN
    qr_size = 1.0 * inch
    text_w = box_w - qr_size - 30
    info_lines = [
        f'<b>Patient:</b> {paragraph_text(patient_name)}',
        f'<b>Report ID:</b> {visit.visit_id}',
        f"<b>Age/Sex:</b> {ctx['age'] if ctx['age'] is not None else '-'} / {patient.gender if patient else '-'}",
        f'<b>Physician:</b> {paragraph_text(visit.referred_by) if visit.referred_by else "Self"}',
        f'<b>Collection Date:</b> {visit.date}',
        f"<b>Report Date:</b> {ctx['report_date'].strftime('%Y-%m-%d %H:%M')}",
    ]
    info_p = Paragraph('<br/>'.join(info_lines), styles['Normal'])
    _, info_h = info_p.wrap(text_w, 300)
    ROW4_H = info_h + 20  # patient info box height (20 = top+bottom padding)

    # The drawing cursor in _page_decorations starts at PAGE_H - MARGIN (not PAGE_H), so the
    # header actually consumes MARGIN + HEADER_H from the top before its bottom edge — the
    # frame's topMargin needs that same MARGIN accounted for, or the requested GAP silently
    # shrinks by a full MARGIN's worth (was the bug here: previously only HEADER_H + GAP).
    HEADER_H = ROW1_H + ROW2_H + ROW3_H + ROW4_H
    TOP_MARGIN = MARGIN + HEADER_H + GAP

    # Signature box is a fixed, bounded area (contain-fit, like the cover background) rather
    # than a fixed-width/unconstrained-height image — an unusually tall/narrow signature
    # upload used to be able to grow past this area and collide with the report body.
    SIG_Y = 0.5 * inch
    SIG_BOX_W = 1.3 * inch
    SIG_BOX_H = 0.55 * inch
    BOTTOM_MARGIN = SIG_Y + SIG_BOX_H + GAP

    def _page_decorations(canvas_obj, _doc_obj):
        """Draws everything that must repeat identically on every page: the Settings > Cover
        background wash, the full header (logo, lab name/subtitle, barcode top-right,
        doctor/tech credentials, contact/social, patient info box + QR), and the pathologist
        signature bottom-left — reusing the exact Paragraph objects/heights computed above."""
        canvas_obj.saveState()

        # --- Background wash (Settings > Cover) — only drawn when show_report_background
        # is on; the cover image otherwise stays in use as the web app's own background. ---
        bg = _load_image_reader(config.cover_path) if config.show_report_background else None
        if bg:
            reader, iw, ih = bg
            scale = min(PAGE_W / iw, PAGE_H / ih)  # contain-fit: shrink to fit within the page, no cropping
            dw, dh = iw * scale, ih * scale
            canvas_obj.drawImage(reader, (PAGE_W - dw) / 2, (PAGE_H - dh) / 2, width=dw, height=dh, mask='auto')
            # Legibility wash — a vivid photo background would otherwise fight the text.
            canvas_obj.setFillColor(colors.Color(1, 1, 1, alpha=0.85))
            canvas_obj.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

        y = PAGE_H - MARGIN  # top-down cursor

        # --- Row 1: logo + lab name/subtitle (left), barcode (top-right) ---
        if logo:
            reader, _iw, _ih = logo
            canvas_obj.drawImage(reader, MARGIN, y - LOGO_H, width=logo_w, height=LOGO_H, mask='auto')

        canvas_obj.setFillColor(colors.HexColor('#2d3748'))
        draw_string_auto(canvas_obj, text_x, y - 14, config.lab_name or 'Laboratory', 'Helvetica-Bold', 15)
        if config.lab_subtitle:
            canvas_obj.setFillColor(colors.HexColor('#667eea'))
            draw_string_auto(canvas_obj, text_x, y - 28, config.lab_subtitle, 'Helvetica', 9)

        barcode = createBarcodeDrawing('Code128', value=visit.visit_id, humanReadable=True, barHeight=12)
        renderPDF.draw(barcode, canvas_obj, PAGE_W - MARGIN - barcode.width, y - barcode.height)

        y -= ROW1_H

        # --- Row 2: doctor / tech credentials (two columns) ---
        row2_h = ROW2_H - 6
        doc_p.drawOn(canvas_obj, MARGIN, y - row2_h)
        tech_p.drawOn(canvas_obj, MARGIN + avail_w + 10, y - row2_h)
        y -= ROW2_H

        # --- Row 3: contact / social lines ---
        if contact_p:
            contact_p.drawOn(canvas_obj, MARGIN, y - (contact_h - 2))
            y -= contact_h
        if social_p:
            social_p.drawOn(canvas_obj, MARGIN, y - (social_h - 2))
            y -= social_h
        y -= 8

        # --- Row 4: patient info box + QR ---
        box_h = ROW4_H
        canvas_obj.setStrokeColor(colors.HexColor('#cccccc'))
        canvas_obj.rect(MARGIN, y - box_h, box_w, box_h, fill=0, stroke=1)
        info_p.drawOn(canvas_obj, MARGIN + 10, y - box_h + 10)
        qr = _make_qr_reader(f"{base_url.rstrip('/')}/report/{visit.id}")
        if qr:
            canvas_obj.drawImage(qr, MARGIN + box_w - qr_size - 10, y - box_h + (box_h - qr_size) / 2,
                                  width=qr_size, height=qr_size, mask='auto')

        # --- Signature, bottom-left — contain-fit within a fixed SIG_BOX_W x SIG_BOX_H box ---
        sig = _load_image_reader(config.signature_path)
        if sig:
            reader, iw, ih = sig
            sig_scale = min(SIG_BOX_W / iw, SIG_BOX_H / ih)
            sig_draw_w, sig_draw_h = iw * sig_scale, ih * sig_scale
            canvas_obj.drawImage(reader, MARGIN, SIG_Y, width=sig_draw_w, height=sig_draw_h, mask='auto')
            canvas_obj.setFillColor(colors.black)
            draw_string_auto(canvas_obj, MARGIN, SIG_Y - 9,
                              config.signature_title or config.tech_name or config.lab_director
                              or 'Authorized Signatory', 'Helvetica', 7)

        canvas_obj.restoreState()

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=letter,
        leftMargin=MARGIN, rightMargin=MARGIN,  # was left at ReportLab's 1" default, narrower
        topMargin=TOP_MARGIN, bottomMargin=BOTTOM_MARGIN,  # than the 6.8"/6.9"-wide tables below need
    )
    elements = []

    # --- Per-page, per-test result tables, each with only that page's own comments (Unit 7
    # layout, Unit 6 H/L marks) ---
    for page_index, page in enumerate(ctx['report_pages']):
        if page_index > 0:
            elements.append(PageBreak())
        if page['title']:
            elements.append(Paragraph(paragraph_text(page['title']), page_title_style))
        if page['subtitle']:
            elements.append(Paragraph(paragraph_text(page['subtitle']), page_sub_style))
        for test in page['tests']:
            categories = {r.get('category') for r in test['rows'] if r.get('category')}
            if len(categories) >= 2:
                _render_categorized_test(elements, test, cell_style, test_title_style, styles, box_w)
            else:
                _render_generic_test_table(elements, test, cell_style, test_title_style, box_w)

        if page['comments']:
            lines = [f"<b>{paragraph_text(c['test_name'])}:</b> {paragraph_text(c['comment'])}" for c in page['comments']]
            comments_table = Table([[Paragraph(
                '<b>Comments:</b><br/>' + '<br/>'.join(lines), styles['Normal'])]],
                colWidths=[box_w])
            comments_table.setStyle(TableStyle([
                ('BOX', (0, 0), (-1, -1), 1, colors.HexColor('#cccccc')),
                ('PADDING', (0, 0), (-1, -1), 10),
            ]))
            elements.append(comments_table)
            elements.append(Spacer(1, 15))

    # --- Interpretation (global — spans every page's abnormal notes) ---
    if ctx['interpretations']:
        lines = [f"<b>{paragraph_text(i['parameter'])}:</b> {paragraph_text(i['note'])}" for i in ctx['interpretations']]
        interp_table = Table([[Paragraph(
            '<b>Interpretation:</b><br/>' + '<br/>'.join(lines), styles['Normal'])]],
            colWidths=[box_w])
        interp_table.setStyle(TableStyle([
            ('BOX', (0, 0), (-1, -1), 1, colors.HexColor('#cccccc')),
            ('PADDING', (0, 0), (-1, -1), 10),
        ]))
        elements.append(interp_table)
        elements.append(Spacer(1, 15))

    footer = config.report_footer_note or 'This report is not valid for medical legal purposes.'
    elements.append(Paragraph(paragraph_text(footer), small))

    doc.build(elements, onFirstPage=_page_decorations, onLaterPages=_page_decorations)
    buffer.seek(0)
    filename = f"report_{_safe_filename_part(patient_name)}_{visit.visit_id}.pdf".replace('/', '-')
    return buffer.read(), filename


def generate_visit_report_pdf(visit_id, base_url):
    """Returns (pdf_bytes, filename) or (None, None) if the visit doesn't exist."""
    ctx = build_report_context(visit_id)
    if not ctx:
        return None, None
    return _render_pdf_from_context(ctx, base_url)


# --- REPORT LAYOUT (per-visit, one-off page/title organization — "Organize Report Layout") ---

@reports_bp.route('/visits/<int:visit_id>/report-layout', methods=['GET'])
def get_report_layout(visit_id):
    visit = PatientVisit.query.get(visit_id)
    if not visit:
        return jsonify({'error': 'Visit not found'}), 404

    pages = VisitReportPage.query.filter_by(visit_id=visit_id).order_by(VisitReportPage.page_number).all()
    visit_tests = _booked_visit_tests(visit_id)

    by_page = {}
    unassigned = []
    for test, vt in visit_tests:
        entry = {'lab_test_id': test.id, 'test_name': test.name}
        if vt.page_number is None:
            unassigned.append(entry)
        else:
            by_page.setdefault(vt.page_number, []).append(entry)

    return jsonify({
        'has_custom_layout': bool(pages),
        'pages': [{'page_number': p.page_number, 'title': p.title, 'subtitle': p.subtitle,
                   'tests': by_page.get(p.page_number, [])} for p in pages],
        'unassigned_tests': unassigned,
    }), 200


@reports_bp.route('/visits/<int:visit_id>/report-layout', methods=['POST'])
def save_report_layout(visit_id):
    visit = PatientVisit.query.get(visit_id)
    if not visit:
        return jsonify({'error': 'Visit not found'}), 404

    data = request.json or {}
    pages = data.get('pages', [])

    VisitReportPage.query.filter_by(visit_id=visit_id).delete()
    assigned = {}
    for p in pages:
        db.session.add(VisitReportPage(
            visit_id=visit_id,
            page_number=p['page_number'],
            title=(p.get('title') or '').strip() or None,
            subtitle=(p.get('subtitle') or '').strip() or None,
        ))
        for lab_test_id in p.get('lab_test_ids', []):
            assigned[int(lab_test_id)] = p['page_number']

    for vt in VisitTest.query.filter_by(visit_id=visit_id).all():
        vt.page_number = assigned.get(vt.lab_test_id)

    db.session.commit()
    return jsonify({'success': True}), 200


@reports_bp.route('/visits/<int:visit_id>/report-layout', methods=['DELETE'])
def clear_report_layout(visit_id):
    VisitReportPage.query.filter_by(visit_id=visit_id).delete()
    VisitTest.query.filter_by(visit_id=visit_id).update({VisitTest.page_number: None})
    db.session.commit()
    return jsonify({'success': True}), 200
