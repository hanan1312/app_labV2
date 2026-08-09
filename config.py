import os

# Base directory of the application
BASE_DIR = os.path.abspath(os.path.dirname(__file__))

# 1. Define the absolute path to the database folder
DB_DIR = os.path.join(BASE_DIR, 'database')

# 2. BULLETPROOF: Force the folder to be created right now, before anything else runs
os.makedirs(DB_DIR, exist_ok=True)

# 3. Create the file path and convert any Windows backslashes (\) to forward slashes (/)
DB_PATH = os.path.join(DB_DIR, 'app.db').replace('\\', '/')

class Config:
    """Base configuration class with secure defaults."""
    
    # Cryptographic key for securing sessions
    SECRET_KEY = os.environ.get('SECRET_KEY', 'super-secret-dev-key')
    
    # Safely connect to SQLite using the normalized path
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL', f"sqlite:///{DB_PATH}")
    
    # Disable tracking to save memory and improve performance
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    
    # Security: Ensure cookies can't be read by malicious JavaScript
    SESSION_COOKIE_HTTPONLY = True
    
    # Security: Require HTTPS for cookies only in production
    SESSION_COOKIE_SECURE = os.environ.get('FLASK_ENV') == 'production'

class DevelopmentConfig(Config):
    DEBUG = True

class ProductionConfig(Config):
    DEBUG = False