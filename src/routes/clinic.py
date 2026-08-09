from flask import Blueprint, jsonify
from src.models.clinic_config import ClinicConfig

clinic_bp = Blueprint('clinic_bp', __name__)

@clinic_bp.route('/clinic/config', methods=['GET'])
def get_clinic_config():
    """Get the clinic's configuration details."""
    config = ClinicConfig.get_config()
    return jsonify(config.to_dict()), 200
