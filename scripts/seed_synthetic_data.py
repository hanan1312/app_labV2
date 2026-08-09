#!/usr/bin/env python3
"""
Synthetic dataset generator for load/performance testing.

Generates: Egyptian-Arab patients, a realistic pathology lab test catalog (with
per-parameter reference ranges), warehouse stock + purchase-bill history, and full
visit/booking/results/transaction activity tying it all together — so the Dashboard,
Statistics tab, and Financial pages have real volume to query against.

ALWAYS verify against an isolated copy first (never the live file):
    cp database/app.db /tmp/seed_test.db
    DATABASE_URL=sqlite:////tmp/seed_test.db lab_app/bin/python scripts/seed_synthetic_data.py --patients 2000 --clear

Once verified, back up the real database, then run for real:
    cp database/app.db "database/app.db.bak-$(date +%Y%m%d%H%M%S)"
    lab_app/bin/python scripts/seed_synthetic_data.py --patients 2000 --clear

--clear wipes existing clients/visits/tests/transactions/warehouse data (not users,
lab_config, or employees) before seeding, in FK-safe dependency order.
"""
import os
import sys
import random
import argparse
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.main import app
from src.models.user import db, LabTest, TransactionList, PatientVisit, WarehouseItem, WarehouseBill
from src.models.client import Client
from src.models.test_result import TestResult
from src.models.test_parameter import TestParameterTemplate
from src.models.junctions import VisitTest, VisitReport, TransactionLineItem, ClientAllergy

# =====================================================================================
# REFERENCE DATA — names, demographics
# =====================================================================================

MALE_FIRST_NAMES = [
    "Ahmed", "Mohammed", "Ali", "Omar", "Khalid", "Youssef", "Hassan", "Hussein",
    "Ibrahim", "Mahmoud", "Karim", "Tariq", "Faisal", "Saeed", "Nasser", "Abdullah",
    "Waleed", "Adel", "Sami", "Ziad", "Rami", "Amjad", "Bilal", "Fadi", "Jaber",
    "Salem", "Marwan", "Yasin", "Anas", "Zaid", "Sherif", "Tamer", "Hazem", "Mostafa",
    "Amr", "Ashraf", "Wael", "Emad", "Fathy", "Gamal",
]
FEMALE_FIRST_NAMES = [
    "Fatima", "Aisha", "Layla", "Mariam", "Noura", "Huda", "Sara", "Rania", "Dina",
    "Salma", "Reem", "Yasmin", "Amira", "Hind", "Lina", "Nour", "Zeinab", "Hala",
    "Manal", "Widad", "Marwa", "Rasha", "Leen", "Jana", "Farah", "Alaa", "Doaa",
    "Shorouk", "Israa", "Nada", "Heba", "Mona", "Samar", "Iman", "Ghada", "Yara",
    "Nesma", "Radwa", "Aya", "Basma",
]
FAMILY_NAMES = [
    "Al-Sayed", "Al-Farouk", "Mansour", "Khalil", "Hamdan", "Al-Amin", "Nasser",
    "Al-Rashid", "Saleh", "Al-Qahtani", "Zaidan", "Rashid", "Al-Baghdadi", "Youssef",
    "Hijazi", "Abdel-Rahman", "Al-Masri", "Kamel", "Fathallah", "Al-Husseini",
    "Sabbagh", "Barakat", "Halabi", "Shaheen", "Radwan", "Fawzy", "Abdel-Aziz",
    "El-Sherif", "Zahran", "Gaber",
]
CITIES = [
    "Cairo", "Giza", "Alexandria", "Mansoura", "Tanta", "Zagazig", "Ismailia",
    "Suez", "Luxor", "Aswan", "Port Said", "Faiyum", "Damanhur", "Minya", "Sohag",
]
AREAS = [
    "Nasr City", "Maadi", "Heliopolis", "Dokki", "Mohandessin", "Zamalek",
    "6th of October", "Shubra", "Downtown", "New Cairo", "Agouza", "Haram",
]
BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]
BLOOD_TYPE_WEIGHTS = [28, 6, 18, 5, 6, 2, 28, 7]
PAYMENT_METHODS = ["Cash", "Visa", "InstaPay", "Vodafone Cash"]
REFERRING_DOCTORS = [
    "Self", "Self", "Self", "Self", "Self",  # walk-ins dominate
    "Dr. Ahmed Hassan", "Dr. Mona Said", "Dr. Youssef Kamal", "Dr. Rania Adel",
    "Dr. Karim Fathy", "Dr. Salma Ibrahim",
]
STAFF_NAMES = ["Lab Admin", "Hanan", "Mostafa (Technician)", "Sara (Reception)"]

# =====================================================================================
# REFERENCE DATA — lab test catalog
#
# Each parameter tuple: (name, unit, method, ref_low, ref_high, ref_text, choices)
#   - Numeric parameter: ref_low/ref_high are floats, choices=None.
#   - Categorical parameter (e.g. "Negative"/"Positive"): ref_low/ref_high=None,
#     choices=[(value, weight), ...], ref_text is the normal/expected display value.
# =====================================================================================

LAB_TESTS = [
    {
        "name": "Complete Blood Count (CBC)", "sample_type": "Blood", "price": 120.0,
        "params": [
            ("WBC", "10^3/uL", "Automated Analyzer", 4.0, 11.0, "4.0 - 11.0", None),
            ("RBC", "10^6/uL", "Automated Analyzer", 4.2, 5.9, "4.2 - 5.9", None),
            ("Hemoglobin (Hb)", "g/dL", "Automated Analyzer", 12.0, 17.0, "12.0 - 17.0", None),
            ("Hematocrit (HCT)", "%", "Automated Analyzer", 36.0, 52.0, "36 - 52", None),
            ("MCV", "fL", "Automated Analyzer", 80.0, 100.0, "80 - 100", None),
            ("MCH", "pg", "Automated Analyzer", 27.0, 33.0, "27 - 33", None),
            ("Platelet Count", "10^3/uL", "Automated Analyzer", 150.0, 450.0, "150 - 450", None),
            ("Neutrophils", "%", "Automated Analyzer", 40.0, 75.0, "40 - 75", None),
            ("Lymphocytes", "%", "Automated Analyzer", 20.0, 45.0, "20 - 45", None),
        ],
    },
    {
        "name": "Erythrocyte Sedimentation Rate (ESR)", "sample_type": "Blood", "price": 40.0,
        "params": [("ESR 1st Hour", "mm/hr", "Westergren", 0.0, 20.0, "0 - 20", None)],
    },
    {
        "name": "Fasting Blood Sugar (FBS)", "sample_type": "Serum", "price": 30.0,
        "params": [("Glucose, Fasting", "mg/dL", "Enzymatic (GOD-PAP)", 70.0, 100.0, "70 - 100", None)],
    },
    {
        "name": "Random Blood Sugar (RBS)", "sample_type": "Serum", "price": 30.0,
        "params": [("Glucose, Random", "mg/dL", "Enzymatic (GOD-PAP)", 70.0, 140.0, "70 - 140", None)],
    },
    {
        "name": "HbA1c (Glycated Hemoglobin)", "sample_type": "Blood", "price": 150.0,
        "params": [("HbA1c", "%", "HPLC", 4.0, 5.6, "4.0 - 5.6", None)],
    },
    {
        "name": "Lipid Profile", "sample_type": "Serum", "price": 250.0,
        "params": [
            ("Total Cholesterol", "mg/dL", "Enzymatic", 0.0, 200.0, "< 200", None),
            ("Triglycerides", "mg/dL", "Enzymatic", 0.0, 150.0, "< 150", None),
            ("HDL Cholesterol", "mg/dL", "Direct", 40.0, 60.0, "40 - 60", None),
            ("LDL Cholesterol", "mg/dL", "Calculated", 0.0, 100.0, "< 100", None),
        ],
    },
    {
        "name": "Liver Function Test (LFT)", "sample_type": "Serum", "price": 200.0,
        "params": [
            ("ALT (SGPT)", "U/L", "IFCC", 0.0, 41.0, "up to 41", None),
            ("AST (SGOT)", "U/L", "IFCC", 0.0, 40.0, "up to 40", None),
            ("Total Bilirubin", "mg/dL", "Diazo Method", 0.2, 1.2, "0.2 - 1.2", None),
            ("Albumin", "g/dL", "Bromocresol Green", 3.5, 5.0, "3.5 - 5.0", None),
        ],
    },
    {
        "name": "Kidney Function Test (KFT)", "sample_type": "Serum", "price": 180.0,
        "params": [
            ("Urea", "mg/dL", "Enzymatic", 15.0, 45.0, "15 - 45", None),
            ("Creatinine", "mg/dL", "Jaffe", 0.6, 1.3, "0.6 - 1.3", None),
            ("Uric Acid", "mg/dL", "Enzymatic", 3.4, 7.0, "3.4 - 7.0", None),
            ("Sodium (Na+)", "mmol/L", "ISE", 135.0, 145.0, "135 - 145", None),
            ("Potassium (K+)", "mmol/L", "ISE", 3.5, 5.1, "3.5 - 5.1", None),
        ],
    },
    {
        "name": "Thyroid Function Test (TFT)", "sample_type": "Serum", "price": 350.0,
        "params": [
            ("TSH", "uIU/mL", "ECLIA", 0.4, 4.0, "0.4 - 4.0", None),
            ("T3 (Total)", "ng/dL", "ECLIA", 80.0, 200.0, "80 - 200", None),
            ("T4 (Total)", "ug/dL", "ECLIA", 5.1, 14.1, "5.1 - 14.1", None),
        ],
    },
    {
        "name": "Urine Complete Examination", "sample_type": "Urine", "price": 60.0,
        "params": [
            ("Color", None, "Physical", None, None, "Pale Yellow",
             [("Pale Yellow", 70), ("Yellow", 20), ("Dark Yellow", 10)]),
            ("pH", None, "Strip", 4.5, 8.0, "4.5 - 8.0", None),
            ("Protein", None, "Strip", None, None, "Negative",
             [("Negative", 85), ("Trace", 10), ("+1", 5)]),
            ("Glucose", None, "Strip", None, None, "Negative",
             [("Negative", 92), ("Trace", 5), ("+1", 3)]),
            ("Pus Cells", "/HPF", "Microscopy", 0.0, 5.0, "0 - 5", None),
            ("RBCs", "/HPF", "Microscopy", 0.0, 3.0, "0 - 3", None),
        ],
    },
    {
        "name": "Stool Analysis", "sample_type": "Stool", "price": 70.0,
        "params": [
            ("Consistency", None, "Physical", None, None, "Formed",
             [("Formed", 75), ("Semi-formed", 18), ("Loose", 7)]),
            ("Ova/Parasites", None, "Microscopy", None, None, "Not seen",
             [("Not seen", 92), ("Ova of A. lumbricoides seen", 4), ("Giardia cysts seen", 4)]),
            ("Occult Blood", None, "Chemical", None, None, "Negative",
             [("Negative", 90), ("Positive", 10)]),
        ],
    },
    {
        "name": "C-Reactive Protein (CRP)", "sample_type": "Serum", "price": 120.0,
        "params": [("CRP", "mg/L", "Turbidimetric", 0.0, 6.0, "< 6", None)],
    },
    {
        "name": "Vitamin D (25-OH)", "sample_type": "Serum", "price": 350.0,
        "params": [("Vitamin D", "ng/mL", "CLIA", 30.0, 100.0, "30 - 100", None)],
    },
    {
        "name": "Vitamin B12", "sample_type": "Serum", "price": 300.0,
        "params": [("Vitamin B12", "pg/mL", "CLIA", 200.0, 900.0, "200 - 900", None)],
    },
    {
        "name": "Iron Studies", "sample_type": "Serum", "price": 280.0,
        "params": [
            ("Serum Iron", "ug/dL", "Colorimetric", 60.0, 170.0, "60 - 170", None),
            ("TIBC", "ug/dL", "Colorimetric", 240.0, 450.0, "240 - 450", None),
            ("Ferritin", "ng/mL", "CLIA", 20.0, 250.0, "20 - 250", None),
        ],
    },
    {
        "name": "Coagulation Profile (PT/PTT)", "sample_type": "Blood (Citrate)", "price": 200.0,
        "params": [
            ("PT", "sec", "Optical Clot Detection", 11.0, 13.5, "11 - 13.5", None),
            ("INR", None, "Calculated", 0.8, 1.2, "0.8 - 1.2", None),
            ("PTT (aPTT)", "sec", "Optical Clot Detection", 25.0, 35.0, "25 - 35", None),
        ],
    },
    {
        "name": "Blood Grouping & Rh", "sample_type": "Blood", "price": 50.0,
        "params": [
            ("ABO Group", None, "Slide Method", None, None, "-",
             [("A", 30), ("B", 20), ("AB", 8), ("O", 42)]),
            ("Rh Factor", None, "Slide Method", None, None, "Positive",
             [("Positive", 88), ("Negative", 12)]),
        ],
    },
    {
        "name": "HBsAg (Hepatitis B)", "sample_type": "Serum", "price": 100.0,
        "params": [("HBsAg", None, "ELISA", None, None, "Negative",
                     [("Negative", 96), ("Positive", 4)])],
    },
    {
        "name": "HCV Antibody", "sample_type": "Serum", "price": 150.0,
        "params": [("Anti-HCV", None, "ELISA", None, None, "Negative",
                     [("Negative", 94), ("Positive", 6)])],
    },
    {
        "name": "Widal Test", "sample_type": "Serum", "price": 80.0,
        "params": [
            ("S. Typhi O", None, "Slide Agglutination", None, None, "Negative",
             [("Negative", 70), ("1:20", 12), ("1:40", 10), ("1:80", 6), ("1:160", 2)]),
            ("S. Typhi H", None, "Slide Agglutination", None, None, "Negative",
             [("Negative", 70), ("1:20", 12), ("1:40", 10), ("1:80", 6), ("1:160", 2)]),
        ],
    },
    {
        "name": "Pregnancy Test (Beta hCG)", "sample_type": "Urine", "price": 60.0,
        "params": [("Beta hCG (Qualitative)", None, "Immunochromatography", None, None, "Negative",
                     [("Negative", 75), ("Positive", 25)])],
    },
]

# =====================================================================================
# REFERENCE DATA — warehouse
# =====================================================================================

WAREHOUSE_ITEMS = [
    ("EDTA Tubes (Purple Top)", "Consumables", "pcs", 40),
    ("Plain Tubes (Red Top)", "Consumables", "pcs", 40),
    ("Citrate Tubes (Blue Top)", "Consumables", "pcs", 30),
    ("Fluoride Tubes (Grey Top)", "Consumables", "pcs", 30),
    ("Disposable Syringes 5ml", "Consumables", "pcs", 50),
    ("Disposable Syringes 2ml", "Consumables", "pcs", 50),
    ("Winged Infusion Set (Butterfly Needle)", "Consumables", "pcs", 30),
    ("Alcohol Swabs", "Consumables", "box", 10),
    ("Cotton Wool Rolls", "Consumables", "roll", 8),
    ("Nitrile Gloves (Box of 100)", "PPE", "box", 15),
    ("Surgical Masks (Box of 50)", "PPE", "box", 10),
    ("Lab Coats", "PPE", "pcs", 5),
    ("Micropipette Tips 1000uL", "Consumables", "box", 10),
    ("Micropipette Tips 200uL", "Consumables", "box", 10),
    ("Urine Containers", "Consumables", "pcs", 60),
    ("Stool Containers", "Consumables", "pcs", 40),
    ("Glucose Reagent Kit", "Reagents", "kit", 3),
    ("Lipid Profile Reagent Kit", "Reagents", "kit", 3),
    ("Liver Function Reagent Kit", "Reagents", "kit", 3),
    ("Kidney Function Reagent Kit", "Reagents", "kit", 3),
    ("CBC Diluent Fluid", "Reagents", "bottle", 4),
    ("CBC Lyse Solution", "Reagents", "bottle", 4),
    ("ESR Tubes (Westergren)", "Consumables", "pcs", 30),
    ("HbA1c Test Cartridges", "Reagents", "box", 5),
    ("Control Sera (Normal/Abnormal)", "Reagents", "kit", 2),
    ("Centrifuge Tubes 15ml", "Consumables", "pcs", 40),
    ("Report Printer Paper", "Stationery", "ream", 5),
    ("Barcode Labels", "Stationery", "roll", 5),
    ("Disinfectant Solution", "Consumables", "bottle", 6),
]


# =====================================================================================
# GENERATION HELPERS
# =====================================================================================

def make_phone():
    prefix = random.choice(["010", "011", "012", "015"])
    return prefix + "".join(random.choice("0123456789") for _ in range(8))


def random_dob(now):
    age = random.choices(
        population=[
            random.randint(1, 12), random.randint(13, 17), random.randint(18, 40),
            random.randint(41, 65), random.randint(66, 90),
        ],
        weights=[8, 7, 45, 30, 10],
    )[0]
    days_into_year = random.randint(0, 364)
    return (now - timedelta(days=age * 365 + days_into_year)).date()


def gen_numeric_result(ref_low, ref_high):
    """80% within range, 20% abnormal (either side)."""
    span = ref_high - ref_low
    if random.random() < 0.8:
        val = random.uniform(ref_low, ref_high)
    elif random.random() < 0.5:
        val = max(0.0, ref_low - random.uniform(0.05, 0.4) * span)
    else:
        val = ref_high + random.uniform(0.05, 0.6) * span
    if ref_high < 5:
        return round(val, 2)
    if ref_high < 100:
        return round(val, 1)
    return round(val, 0)


def gen_result_value(param):
    _name, _unit, _method, ref_low, ref_high, _text, choices = param
    if choices is not None:
        values, weights = zip(*choices)
        return str(random.choices(values, weights=weights)[0])
    return str(gen_numeric_result(ref_low, ref_high))


def pick_visit_status(visit_dt, now):
    age_days = (now - visit_dt).days
    if age_days < 1:
        weights = {"pending": 55, "collected": 30, "partially_delivered": 12, "results_delivered_by_link": 3}
    elif age_days < 3:
        weights = {"pending": 20, "collected": 30, "partially_delivered": 30, "results_delivered_by_link": 20}
    elif age_days < 10:
        weights = {"pending": 5, "collected": 15, "partially_delivered": 25, "results_delivered_by_link": 55}
    else:
        weights = {"pending": 2, "collected": 5, "partially_delivered": 13, "results_delivered_by_link": 80}
    return random.choices(list(weights.keys()), weights=list(weights.values()))[0]


# =====================================================================================
# CLEAR (FK-safe dependency order: children before parents)
# =====================================================================================

def clear_existing_data():
    print("Clearing existing patient/test/warehouse data (users, lab_config, employees kept)...")
    WarehouseBill.query.delete()
    WarehouseItem.query.delete()
    TestResult.query.delete()
    VisitTest.query.delete()
    VisitReport.query.delete()
    TransactionLineItem.query.delete()
    TransactionList.query.delete()
    PatientVisit.query.delete()
    ClientAllergy.query.delete()
    Client.query.delete()
    TestParameterTemplate.query.delete()
    LabTest.query.delete()
    db.session.commit()
    print("Cleared.")


# =====================================================================================
# SEED
# =====================================================================================

def seed_lab_tests():
    print(f"Creating {len(LAB_TESTS)} lab tests with parameters...")
    test_rows = []
    for spec in LAB_TESTS:
        test = LabTest(name=spec["name"], sample_type=spec["sample_type"], price=spec["price"])
        db.session.add(test)
        db.session.flush()  # populate test.id
        for order, param in enumerate(spec["params"]):
            name, unit, method, ref_low, ref_high, ref_text, _choices = param
            db.session.add(TestParameterTemplate(
                lab_test_id=test.id, name=name, unit=unit, method=method,
                ref_low=ref_low, ref_high=ref_high, reference_range_text=ref_text,
                display_order=order,
            ))
        test_rows.append((test, spec["params"]))
    db.session.commit()
    print(f"  -> {len(test_rows)} tests, "
          f"{sum(len(p) for _, p in test_rows)} parameters.")
    return test_rows


def seed_warehouse():
    print(f"Creating {len(WAREHOUSE_ITEMS)} warehouse items + purchase bill history...")
    now = datetime.now()
    bill_count = 0
    for name, category, unit, critical_level in WAREHOUSE_ITEMS:
        # ~20% of items intentionally sit below their critical level, for a realistic
        # "low stock" alert mix in the Warehouse tab.
        low_stock = random.random() < 0.2
        quantity = random.randint(0, critical_level - 1) if low_stock else random.randint(critical_level, critical_level * 8)
        item = WarehouseItem(name=name, category=category, quantity=quantity,
                              critical_level=critical_level, unit=unit)
        db.session.add(item)
        db.session.flush()

        for _ in range(random.randint(1, 4)):
            bill_count += 1
            days_ago = random.randint(1, 300)
            ordered_stock = random.randint(critical_level, critical_level * 5)
            price_per_unit = round(random.uniform(5, 300), 2)
            db.session.add(WarehouseBill(
                order_id=f"PO-{now.strftime('%Y%m%d')}-{bill_count:05d}",
                item_id=item.id, item_name=item.name, present_stock=item.quantity,
                ordered_stock=ordered_stock, unit=item.unit, price_per_unit=price_per_unit,
                total_price=round(price_per_unit * ordered_stock, 2), category=item.category,
                user=random.choice(STAFF_NAMES),
                date_time=(now - timedelta(days=days_ago)).strftime("%Y-%m-%d %H:%M:%S"),
                status=random.choices(["demanded", "ordered", "delivered"], weights=[15, 25, 60])[0],
            ))
    db.session.commit()
    print(f"  -> {len(WAREHOUSE_ITEMS)} items, {bill_count} purchase bills.")


def seed_patients(num_patients, test_rows):
    print(f"Creating {num_patients} patients with visit/results/transaction history...")
    now = datetime.now()
    visit_counter = 0
    client_count = 0
    visit_count = 0
    visit_test_count = 0
    result_count = 0
    transaction_count = 0
    line_item_count = 0

    BATCH_SIZE = 100
    for batch_start in range(0, num_patients, BATCH_SIZE):
        batch_end = min(batch_start + BATCH_SIZE, num_patients)
        for _ in range(batch_start, batch_end):
            is_male = random.random() < 0.5
            first_name = random.choice(MALE_FIRST_NAMES if is_male else FEMALE_FIRST_NAMES)
            last_name = random.choice(FAMILY_NAMES)
            dob = random_dob(now)
            age = (now.date() - dob).days // 365
            phone = make_phone()

            client = Client(
                first_name=first_name, last_name=last_name, date_of_birth=dob,
                gender="Male" if is_male else "Female",
                contact_person="Self" if age >= 18 else f"{random.choice(FAMILY_NAMES)} (Guardian)",
                phone=phone, client_phone=phone,
                city=random.choice(CITIES), area=random.choice(AREAS),
                street=f"{random.randint(1, 120)} St.", apartment=str(random.randint(1, 40)),
                blood_type=random.choices(BLOOD_TYPES, weights=BLOOD_TYPE_WEIGHTS)[0],
                sample_status="pending",
                created_at=now - timedelta(days=random.randint(0, 365)),
            )
            db.session.add(client)
            db.session.flush()  # populate client.id
            client_count += 1

            for _ in range(random.randint(1, 4)):
                visit_counter += 1
                visit_dt = now - timedelta(
                    days=random.randint(0, 365), hours=random.randint(0, 23), minutes=random.randint(0, 59)
                )
                if visit_dt > now:
                    visit_dt = now
                date_str = visit_dt.strftime("%Y-%m-%d %H:%M:%S")
                code = f"{visit_dt.strftime('%Y%m%d%H%M%S')}-{client.id}-{visit_counter}"

                chosen_tests = random.sample(test_rows, k=min(random.randint(1, 4), len(test_rows)))
                total_price = sum(t.price for t, _ in chosen_tests)
                discount = random.choices([0, 0, 0, 5, 10, 15], weights=[50, 20, 10, 10, 5, 5])[0]
                final_payment = round(total_price * (1 - discount / 100), 2)

                status = pick_visit_status(visit_dt, now)
                patient_name = f"{first_name} {last_name}"

                visit = PatientVisit(
                    patient_id=client.id, patient_name=patient_name, visit_id=code,
                    date=date_str, status=status, referred_by=random.choice(REFERRING_DOCTORS),
                )
                db.session.add(visit)
                db.session.flush()
                visit_count += 1

                for position, (test, _params) in enumerate(chosen_tests):
                    db.session.add(VisitTest(visit_id=visit.id, lab_test_id=test.id, position=position))
                    visit_test_count += 1

                transaction = TransactionList(
                    transaction_id=code, patient_id=client.id, patient_name=patient_name,
                    patient_phone=phone, date=date_str, total_price=total_price,
                    discount_percentage=discount, payment_method=random.choice(PAYMENT_METHODS),
                    final_payment=final_payment,
                )
                db.session.add(transaction)
                db.session.flush()
                transaction_count += 1

                for test, _params in chosen_tests:
                    db.session.add(TransactionLineItem(
                        transaction_id=transaction.id, lab_test_id=test.id, price_at_sale=test.price,
                    ))
                    line_item_count += 1

                # Decide which of this visit's booked tests have results, based on status.
                if status == "results_delivered_by_link":
                    tests_with_results = chosen_tests
                elif status == "partially_delivered":
                    k = random.randint(1, max(1, len(chosen_tests) - 1))
                    tests_with_results = random.sample(chosen_tests, k=k)
                else:
                    tests_with_results = []

                for test, params in tests_with_results:
                    completion_dt = visit_dt + timedelta(hours=random.randint(1, 48))
                    for param in params:
                        name, unit, _method, ref_low, ref_high, ref_text, choices = param
                        value = gen_result_value(param)
                        if choices is not None:
                            p_status = "normal" if value == ref_text else "abnormal"
                            ref_range = ref_text
                        elif ref_low is not None and ref_high is not None:
                            numeric = float(value)
                            p_status = "normal" if ref_low <= numeric <= ref_high else "abnormal"
                            ref_range = ref_text
                        else:
                            p_status = "completed"
                            ref_range = ref_text
                        db.session.add(TestResult(
                            client_id=client.id, visit_id=visit.id, lab_test_id=test.id,
                            test_name=test.name, parameter_name=name, result_value=value,
                            unit=unit, reference_range=ref_range, status=p_status,
                            test_completion_date=completion_dt,
                        ))
                        result_count += 1

        db.session.commit()
        print(f"  ... {batch_end}/{num_patients} patients "
              f"({visit_count} visits, {result_count} results so far)")

    print(f"  -> {client_count} patients, {visit_count} visits, {visit_test_count} booked tests, "
          f"{result_count} results, {transaction_count} transactions, {line_item_count} line items.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--patients", type=int, default=2000, help="Number of patients to generate")
    parser.add_argument("--clear", action="store_true", help="Clear existing patient/test/warehouse data first")
    parser.add_argument("--seed", type=int, default=None, help="Random seed for reproducibility")
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    with app.app_context():
        db_uri = app.config.get("SQLALCHEMY_DATABASE_URI")
        print(f"Target database: {db_uri}")

        if args.clear:
            clear_existing_data()

        test_rows = seed_lab_tests()
        seed_warehouse()
        seed_patients(args.patients, test_rows)

        print("Done.")


if __name__ == "__main__":
    main()
