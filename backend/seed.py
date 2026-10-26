from sqlalchemy import select
from passlib.context import CryptContext

from database import Base, SessionLocal, engine
from models import Alert, Patient, Resource, User

Base.metadata.create_all(bind=engine)
passwords = CryptContext(schemes=["bcrypt"], deprecated="auto")

with SessionLocal() as db:
    user = db.scalar(select(User).where(User.email == "demo@northstar.example"))
    if user is None:
        user = User(
            email="demo@northstar.example",
            name="Dr. Riley Morgan",
            role="physician",
            password_hash=passwords.hash("PulseCare-Demo-Only"),
        )
        db.add(user)

    demo_patients = [
        ("PT-1042", "Maya Rodriguez", 42, "Chest discomfort", "Critical", "Resus 01"),
        ("PT-1047", "Ethan Brooks", 67, "Shortness of breath", "Urgent", "Triage 02"),
        ("PT-1051", "Olivia Chen", 29, "Laceration - hand", "Standard", "Waiting room"),
    ]
    patients_by_reference = {}
    for reference, name, age, reason, acuity, area in demo_patients:
        patient = db.scalar(
            select(Patient).where(Patient.external_id == reference)
        )
        if patient is None:
            patient = Patient(
                external_id=reference,
                name=name,
                age=age,
                reason=reason,
                acuity=acuity,
                area=area,
            )
            db.add(patient)
            db.flush()
        patients_by_reference[reference] = patient

    demo_resources = [
        ("Treatment bays", 12, 8),
        ("Monitored beds", 8, 6),
        ("Critical care beds", 4, 3),
        ("CT scanner", 2, 1),
        ("Ventilators", 6, 2),
    ]
    for name, total, used in demo_resources:
        if db.scalar(select(Resource).where(Resource.name == name)) is None:
            db.add(Resource(name=name, total=total, used=used))

    reminder_patient = patients_by_reference["PT-1051"]
    if db.scalar(
        select(Alert).where(
            Alert.kind == "waiting-time",
            Alert.patient_id == reminder_patient.id,
        )
    ) is None:
        db.add(
            Alert(
                kind="waiting-time",
                title="Waiting-time reminder",
                body=f"{reminder_patient.name} is awaiting staff review.",
                patient_id=reminder_patient.id,
            )
        )

    db.commit()

print("Fictional PulseCare demo records are ready.")
