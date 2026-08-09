"""
Input validation utilities for the Pediatric Clinic application.
"""

import re
from datetime import datetime, date
from typing import Dict, Any, List, Optional

class ValidationError(Exception):
    """Custom exception for validation errors"""
    pass

def validate_required_fields(data: Dict[str, Any], required_fields: List[str]) -> None:
    """
    Validate that all required fields are present and not empty.
    
    Args:
        data: Dictionary containing the data to validate
        required_fields: List of field names that are required
        
    Raises:
        ValidationError: If any required field is missing or empty
    """
    missing_fields = []
    for field in required_fields:
        if field not in data or not data[field] or (isinstance(data[field], str) and not data[field].strip()):
            missing_fields.append(field)
    
    if missing_fields:
        raise ValidationError(f"Missing or empty required fields: {', '.join(missing_fields)}")

def validate_email(email: str) -> bool:
    """
    Validate email format.
    
    Args:
        email: Email string to validate
        
    Returns:
        bool: True if email is valid, False otherwise
    """
    if not email:
        return False
    
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, email))

def validate_phone(phone: str) -> bool:
    """
    Validate phone number format (basic validation).
    
    Args:
        phone: Phone number string to validate
        
    Returns:
        bool: True if phone is valid, False otherwise
    """
    if not phone:
        return False
    
    # Remove common separators and spaces
    cleaned_phone = re.sub(r'[\s\-\(\)\+]', '', phone)
    
    # Check if it contains only digits and is of reasonable length
    return cleaned_phone.isdigit() and 7 <= len(cleaned_phone) <= 15

def validate_date(date_str: str, date_format: str = '%Y-%m-%d') -> Optional[date]:
    """
    Validate and parse date string.
    
    Args:
        date_str: Date string to validate
        date_format: Expected date format (default: '%Y-%m-%d')
        
    Returns:
        date: Parsed date object if valid, None otherwise
        
    Raises:
        ValidationError: If date format is invalid
    """
    if not date_str:
        return None
    
    try:
        return datetime.strptime(date_str, date_format).date()
    except ValueError:
        raise ValidationError(f"Invalid date format. Expected format: {date_format}")

def validate_time(time_str: str, time_format: str = '%H:%M') -> Optional:
    """
    Validate and parse time string.
    
    Args:
        time_str: Time string to validate
        time_format: Expected time format (default: '%H:%M')
        
    Returns:
        time: Parsed time object if valid, None otherwise
        
    Raises:
        ValidationError: If time format is invalid
    """
    if not time_str:
        return None
    
    try:
        return datetime.strptime(time_str, time_format).time()
    except ValueError:
        raise ValidationError(f"Invalid time format. Expected format: {time_format}")

def validate_gender(gender: str) -> bool:
    """
    Validate gender value.
    
    Args:
        gender: Gender string to validate
        
    Returns:
        bool: True if gender is valid, False otherwise
    """
    valid_genders = ['Male', 'Female', 'Other']
    return gender in valid_genders

def validate_blood_type(blood_type: str) -> bool:
    """
    Validate blood type value.
    
    Args:
        blood_type: Blood type string to validate
        
    Returns:
        bool: True if blood type is valid, False otherwise
    """
    if not blood_type:
        return True  # Blood type is optional
    
    valid_blood_types = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
    return blood_type in valid_blood_types

def validate_hall_status(hall_status: str) -> bool:
    """
    Validate hall status value.
    
    Args:
        hall_status: Hall status string to validate
        
    Returns:
        bool: True if hall status is valid, False otherwise
    """
    valid_statuses = ['In', 'Out']
    return hall_status in valid_statuses

def validate_patient_status(status: str) -> bool:
    """
    Validate patient status value.
    
    Args:
        status: Patient status string to validate
        
    Returns:
        bool: True if status is valid, False otherwise
    """
    valid_statuses = ['waiting', 'scheduled', 'in_hall', 'finished', 'registered']
    return status in valid_statuses

def validate_visit_type(visit_type: str) -> bool:
    """
    Validate visit type value.
    
    Args:
        visit_type: Visit type string to validate
        
    Returns:
        bool: True if visit type is valid, False otherwise
    """
    valid_types = ['examination', 'fast examination', 'consultation']
    return visit_type in valid_types

def validate_payment_method(payment_method: str) -> bool:
    """
    Validate payment method value.
    
    Args:
        payment_method: Payment method string to validate
        
    Returns:
        bool: True if payment method is valid, False otherwise
    """
    valid_methods = ['cash', 'card', 'insurance', 'bank_transfer']
    return payment_method in valid_methods

def validate_transaction_status(status: str) -> bool:
    """
    Validate transaction status value.
    
    Args:
        status: Transaction status string to validate
        
    Returns:
        bool: True if status is valid, False otherwise
    """
    valid_statuses = ['completed', 'pending', 'cancelled', 'refunded']
    return status in valid_statuses

def validate_numeric_range(value: Any, min_val: float = None, max_val: float = None) -> bool:
    """
    Validate that a numeric value is within a specified range.
    
    Args:
        value: Value to validate
        min_val: Minimum allowed value (optional)
        max_val: Maximum allowed value (optional)
        
    Returns:
        bool: True if value is valid, False otherwise
    """
    try:
        num_val = float(value)
        if min_val is not None and num_val < min_val:
            return False
        if max_val is not None and num_val > max_val:
            return False
        return True
    except (ValueError, TypeError):
        return False

def validate_string_length(value: str, min_length: int = 0, max_length: int = None) -> bool:
    """
    Validate string length.
    
    Args:
        value: String to validate
        min_length: Minimum allowed length (default: 0)
        max_length: Maximum allowed length (optional)
        
    Returns:
        bool: True if string length is valid, False otherwise
    """
    if not isinstance(value, str):
        return False
    
    length = len(value.strip())
    if length < min_length:
        return False
    if max_length is not None and length > max_length:
        return False
    
    return True

def sanitize_string(value: str) -> str:
    """
    Sanitize string input by stripping whitespace and removing potentially harmful characters.
    
    Args:
        value: String to sanitize
        
    Returns:
        str: Sanitized string
    """
    if not isinstance(value, str):
        return str(value)
    
    # Strip whitespace
    sanitized = value.strip()
    
    # Remove null bytes and other control characters
    sanitized = re.sub(r'[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '', sanitized)
    
    return sanitized

def validate_sample_status(status: str) -> bool:
    """
    Validate sample status value for lab tests.
    
    Args:
        status: Sample status string to validate
        
    Returns:
        bool: True if sample status is valid, False otherwise
    """
    valid_statuses = ['pending', 'collected', 'processing', 'completed', 'rejected']
    return status in valid_statuses

def validate_test_status(status: str) -> bool:
    """
    Validate test status value.
    
    Args:
        status: Test status string to validate
        
    Returns:
        bool: True if test status is valid, False otherwise
    """
    valid_statuses = ['scheduled', 'in_progress', 'completed', 'cancelled', 'pending', 'abnormal', 'normal']
    return status in valid_statuses

def validate_test_type(test_type: str) -> bool:
    """
    Validate test type value.
    
    Args:
        test_type: Test type string to validate
        
    Returns:
        bool: True if test type is valid, False otherwise
    """
    valid_types = ['blood test', 'urine test', 'stool test', 'x-ray', 'ultrasound', 'ecg', 'other']
    return test_type.lower() in valid_types

def validate_client_data(data: Dict[str, Any], is_update: bool = False) -> List[str]:
    """
    Comprehensive validation for client data in the laboratory system.
    
    Args:
        data: Client data dictionary
        is_update: Whether this is an update operation (less strict validation)
        
    Returns:
        list: List of validation error messages (empty if valid)
    """
    errors = []
    
    # Required fields for new clients
    if not is_update:
        required_fields = ['first_name', 'last_name', 'date_of_birth', 'gender', 'contact_person', 'phone']
        for field in required_fields:
            if field not in data or not data[field] or (isinstance(data[field], str) and not data[field].strip()):
                errors.append(f"Missing or empty required field: {field}")
    
    # Validate string fields
    if 'first_name' in data and data['first_name']:
        if not validate_string_length(data['first_name'], 1, 100):
            errors.append("First name must be between 1 and 100 characters")
    
    if 'last_name' in data and data['last_name']:
        if not validate_string_length(data['last_name'], 1, 100):
            errors.append("Last name must be between 1 and 100 characters")
    
    if 'contact_person' in data and data['contact_person']:
        if not validate_string_length(data['contact_person'], 1, 200):
            errors.append("Contact person name must be between 1 and 200 characters")
    
    # Validate phone
    if 'phone' in data and data['phone']:
        if not validate_phone(data['phone']):
            errors.append("Invalid phone format")
    
    if 'client_phone' in data and data['client_phone']:
        if not validate_phone(data['client_phone']):
            errors.append("Invalid client phone format")
    
    # Validate date of birth
    if 'date_of_birth' in data and data['date_of_birth']:
        try:
            dob = datetime.fromisoformat(data['date_of_birth']).date() if isinstance(data['date_of_birth'], str) else data['date_of_birth']
            if dob > date.today():
                errors.append("Date of birth cannot be in the future")
        except:
            errors.append("Invalid date of birth format")
    
    # Validate gender
    if 'gender' in data and data['gender']:
        if not validate_gender(data['gender']):
            errors.append("Invalid gender. Must be 'Male', 'Female', or 'Other'")
    
    # Validate blood type
    if 'blood_type' in data and data['blood_type']:
        if not validate_blood_type(data['blood_type']):
            errors.append("Invalid blood type")
    
    # Validate sample status
    if 'sample_status' in data and data['sample_status']:
        if not validate_sample_status(data['sample_status']):
            errors.append("Invalid sample status")
    
    # Validate test status
    if 'status' in data and data['status']:
        if not validate_test_status(data['status']):
            errors.append("Invalid test status")
    
    # Validate test type
    if 'test_type' in data and data['test_type']:
        if not validate_test_type(data['test_type']):
            errors.append("Invalid test type")
    
    # Validate vital signs
    vital_fields = {
        'temperature': (30.0, 45.0),
        'blood_pressure_systolic': (50, 300),
        'blood_pressure_diastolic': (30, 200),
        'weight': (0.1, 500.0),
        'height': (10.0, 300.0)
    }
    
    for field, (min_val, max_val) in vital_fields.items():
        if field in data and data[field] is not None:
            if not validate_numeric_range(data[field], min_val, max_val):
                errors.append(f"Invalid {field}. Must be between {min_val} and {max_val}")
    
    return errors

def validate_patient_data(data: Dict[str, Any], is_update: bool = False) -> Dict[str, Any]:
    """
    Comprehensive validation for patient data.
    
    Args:
        data: Patient data dictionary
        is_update: Whether this is an update operation (less strict validation)
        
    Returns:
        dict: Validated and sanitized data
        
    Raises:
        ValidationError: If validation fails
    """
    validated_data = {}
    
    # Required fields for new patients
    if not is_update:
        required_fields = ['first_name', 'last_name', 'date_of_birth', 'gender', 'parent_name', 'phone']
        validate_required_fields(data, required_fields)
    
    # Validate and sanitize string fields
    string_fields = ['first_name', 'last_name', 'parent_name', 'phone', 'patient_phone', 
                    'city', 'area', 'street', 'apartment', 'medical_history', 'doctor_comments']
    
    for field in string_fields:
        if field in data:
            if data[field] is not None:
                validated_data[field] = sanitize_string(data[field])
                
                # Validate string lengths
                if field in ['first_name', 'last_name'] and not validate_string_length(validated_data[field], 1, 100):
                    raise ValidationError(f"{field} must be between 1 and 100 characters")
                elif field == 'parent_name' and not validate_string_length(validated_data[field], 1, 200):
                    raise ValidationError("Parent name must be between 1 and 200 characters")
                elif field in ['phone', 'patient_phone'] and validated_data[field] and not validate_phone(validated_data[field]):
                    raise ValidationError(f"Invalid {field} format")
            else:
                validated_data[field] = None
    
    # Validate date of birth
    if 'date_of_birth' in data:
        validated_data['date_of_birth'] = validate_date(data['date_of_birth'])
        if validated_data['date_of_birth'] and validated_data['date_of_birth'] > date.today():
            raise ValidationError("Date of birth cannot be in the future")
    
    # Validate gender
    if 'gender' in data and not validate_gender(data['gender']):
        raise ValidationError("Invalid gender. Must be 'Male', 'Female', or 'Other'")
    
    # Validate blood type
    if 'blood_type' in data and data['blood_type'] and not validate_blood_type(data['blood_type']):
        raise ValidationError("Invalid blood type")
    
    # Validate hall status
    if 'hall_status' in data and not validate_hall_status(data['hall_status']):
        raise ValidationError("Invalid hall status. Must be 'In' or 'Out'")
    
    # Validate patient status
    if 'status' in data and not validate_patient_status(data['status']):
        raise ValidationError("Invalid patient status")
    
    # Validate visit type
    if 'visit_type' in data and data['visit_type'] and not validate_visit_type(data['visit_type']):
        raise ValidationError("Invalid visit type")
    
    # Validate visit date and time
    if 'visit_date' in data:
        validated_data['visit_date'] = validate_date(data['visit_date'])
    
    if 'visit_time' in data:
        validated_data['visit_time'] = validate_time(data['visit_time'])
    
    # Validate vital signs
    vital_fields = {
        'temperature': (30.0, 45.0),  # Celsius
        'blood_pressure_systolic': (50, 300),  # mmHg
        'blood_pressure_diastolic': (30, 200),  # mmHg
        'weight': (0.1, 500.0),  # kg
        'height': (10.0, 300.0)  # cm
    }
    
    for field, (min_val, max_val) in vital_fields.items():
        if field in data and data[field] is not None:
            if not validate_numeric_range(data[field], min_val, max_val):
                raise ValidationError(f"Invalid {field}. Must be between {min_val} and {max_val}")
            validated_data[field] = float(data[field])
    
    # Copy other validated fields
    for field in ['gender', 'blood_type', 'hall_status', 'status', 'visit_type', 'allergies']:
        if field in data:
            validated_data[field] = data[field]
    
    return validated_data

