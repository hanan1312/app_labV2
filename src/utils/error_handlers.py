from flask import jsonify
from werkzeug.exceptions import HTTPException
import logging

# Configure logging
log = logging.getLogger(__name__)

def register_error_handlers(app):
    """Register centralized error handlers for the Flask app."""

    @app.errorhandler(HTTPException)
    def handle_http_exception(e):
        """Return JSON instead of HTML for HTTP errors."""
        response = e.get_response()
        response.data = jsonify({
            "code": e.code,
            "name": e.name,
            "description": e.description,
        }).data
        response.content_type = "application/json"
        log.warning(f"{e.name}: {e.description}")
        return response

    @app.errorhandler(Exception)
    def handle_generic_exception(e):
        """Handle any other unhandled exceptions."""
        # Log the full exception for debugging
        log.exception("An unhandled exception occurred")
        
        # Return a generic 500 error to the client
        return jsonify({
            "code": 500,
            "name": "Internal Server Error",
            "description": "An unexpected error occurred on the server.",
        }), 500
