from flask import Blueprint, jsonify, request
from src.models.lab_config import LabConfig

lab_bp = Blueprint('lab_bp', __name__)

@lab_bp.route('/lab/config', methods=['GET'])
def get_lab_config():
    """Get the laboratory's configuration details."""
    config = LabConfig.get_config()
    return jsonify(config.to_dict()), 200

@lab_bp.route('/lab/config', methods=['PUT'])
def update_lab_config():
    """Update the laboratory's configuration details."""
    try:
        config = LabConfig.get_config()
        data = request.get_json()
        
        if 'lab_name' in data:
            config.lab_name = data['lab_name']
        if 'lab_director' in data:
            config.lab_director = data['lab_director']
        if 'lab_phone' in data:
            config.lab_phone = data['lab_phone']
        if 'lab_address' in data:
            config.lab_address = data['lab_address']
        if 'logo_path' in data:
            config.logo_path = data['logo_path']
        
        from src.models.user import db
        db.session.commit()
        
        return jsonify(config.to_dict()), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500
