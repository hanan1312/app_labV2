import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from src.main import app
from src.models.user import User, db

def fix_and_test():
    with app.app_context():
        admin = User.query.filter_by(username='admin').first()
        
        # Force the fix
        admin.set_password('admin123')
        db.session.commit()
        
        print("\n--- NEW PASSWORD TEST ---")
        print(f"Admin password 'admin123' matches: {admin.check_password('admin123')}")
        print("---------------------------\n")

if __name__ == '__main__':
    fix_and_test()