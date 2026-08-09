from flask import Blueprint, request, jsonify
from src.models.test_result import TestResult
from src.models.client import Client
from src.models.user import db
from datetime import datetime

test_result_bp = Blueprint('test_result_bp', __name__)

# --- TEST RESULT CRUD ---

@test_result_bp.route('/test-results', methods=['GET'])
def get_test_results():
    """Retrieve all test results."""
    try:
        client_id = request.args.get('client_id')
        if client_id:
            results = TestResult.query.filter_by(client_id=int(client_id)).all()
        else:
            results = TestResult.query.all()
        
        return jsonify([r.to_dict() for r in results]), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@test_result_bp.route('/test-results/<int:result_id>', methods=['GET'])
def get_test_result(result_id):
    """Retrieve a specific test result."""
    try:
        result = TestResult.query.get(result_id)
        if not result:
            return jsonify({'error': 'Test result not found'}), 404
        return jsonify(result.to_dict()), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@test_result_bp.route('/test-results', methods=['POST'])
def create_test_result():
    """Create a new test result."""
    try:
        data = request.get_json()
        
        # Validate required fields
        required_fields = ['client_id', 'test_name', 'parameter_name', 'result_value']
        for field in required_fields:
            if field not in data:
                return jsonify({'error': f'Missing required field: {field}'}), 400
        
        # Verify client exists
        client = Client.query.get(data['client_id'])
        if not client:
            return jsonify({'error': 'Client not found'}), 404
        
        # Parse dates if provided
        sample_collection_date = None
        test_completion_date = None
        
        if data.get('sample_collection_date'):
            try:
                sample_collection_date = datetime.fromisoformat(data['sample_collection_date'])
            except:
                pass
        
        if data.get('test_completion_date'):
            try:
                test_completion_date = datetime.fromisoformat(data['test_completion_date'])
            except:
                pass
        
        result = TestResult(
            client_id=data['client_id'],
            test_name=data['test_name'],
            test_category=data.get('test_category'),
            sample_type=data.get('sample_type'),
            parameter_name=data['parameter_name'],
            result_value=data['result_value'],
            unit=data.get('unit'),
            reference_range=data.get('reference_range'),
            status=data.get('status', 'pending'),
            sample_collection_date=sample_collection_date,
            test_completion_date=test_completion_date,
            technician_notes=data.get('technician_notes'),
            pathologist_notes=data.get('pathologist_notes')
        )
        
        db.session.add(result)
        db.session.commit()
        
        return jsonify(result.to_dict()), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@test_result_bp.route('/test-results/<int:result_id>', methods=['PUT'])
def update_test_result(result_id):
    """Update a test result."""
    try:
        result = TestResult.query.get(result_id)
        if not result:
            return jsonify({'error': 'Test result not found'}), 404
        
        data = request.get_json()
        
        # Update fields
        if 'test_name' in data:
            result.test_name = data['test_name']
        if 'test_category' in data:
            result.test_category = data['test_category']
        if 'sample_type' in data:
            result.sample_type = data['sample_type']
        if 'parameter_name' in data:
            result.parameter_name = data['parameter_name']
        if 'result_value' in data:
            result.result_value = data['result_value']
        if 'unit' in data:
            result.unit = data['unit']
        if 'reference_range' in data:
            result.reference_range = data['reference_range']
        if 'status' in data:
            result.status = data['status']
        if 'sample_collection_date' in data and data['sample_collection_date']:
            try:
                result.sample_collection_date = datetime.fromisoformat(data['sample_collection_date'])
            except:
                pass
        if 'test_completion_date' in data and data['test_completion_date']:
            try:
                result.test_completion_date = datetime.fromisoformat(data['test_completion_date'])
            except:
                pass
        if 'technician_notes' in data:
            result.technician_notes = data['technician_notes']
        if 'pathologist_notes' in data:
            result.pathologist_notes = data['pathologist_notes']
        
        db.session.commit()
        return jsonify(result.to_dict()), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@test_result_bp.route('/test-results/<int:result_id>', methods=['DELETE'])
def delete_test_result(result_id):
    """Delete a test result."""
    try:
        result = TestResult.query.get(result_id)
        if not result:
            return jsonify({'error': 'Test result not found'}), 404
        
        db.session.delete(result)
        db.session.commit()
        
        return jsonify({'message': 'Test result deleted successfully'}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

# --- TEST STATISTICS ---

@test_result_bp.route('/test-results/stats/summary', methods=['GET'])
def get_test_stats():
    """Get test statistics."""
    try:
        total_tests = TestResult.query.count()
        pending_tests = TestResult.query.filter_by(status='pending').count()
        completed_tests = TestResult.query.filter_by(status='completed').count()
        abnormal_tests = TestResult.query.filter_by(status='abnormal').count()
        
        # Most common test
        from sqlalchemy import func
        most_common = db.session.query(
            TestResult.test_name,
            func.count(TestResult.id).label('count')
        ).group_by(TestResult.test_name).order_by(func.count(TestResult.id).desc()).first()
        
        return jsonify({
            'total_tests': total_tests,
            'pending': pending_tests,
            'completed': completed_tests,
            'abnormal': abnormal_tests,
            'most_common_test': most_common[0] if most_common else None
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500
