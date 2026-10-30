import os
import base64
import csv
import io
import json
import urllib.error
import urllib.parse
import urllib.request
from uuid import uuid4
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import inspect, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from database import Base, SessionLocal, engine, get_db
from models import (
    Alert,
    Ambulance,
    AmbulanceLocation,
    AuditLog,
    Observation,
    Patient,
    PatientResourceNeed,
    Referral,
    Resource,
    SmsOutbox,
    TriageHistory,
    User,
)
from schemas import (
    AlertOut,
    AmbulanceLocationCreate,
    AlertResolve,
    DemoDismiss,
    Login,
    ObservationCreate,
    ObservationOut,
    PatientCreate,
    PatientOut,
    PatientUpdate,
    ReferralCreate,
    ReferralOut,
    ReferralUpdate,
    ResourceNeedCreate,
    ResourceNeedOut,
    ResourceNeedUpdate,
    ResourceOut,
    ResourceUpdate,
    SmsCreate,
    UserOut,
)

app = FastAPI(
    title="PulseCare API",
    version="1.0.0",
    description="Fictional emergency operations workflow API",
)
frontend_origins = [
    origin.strip()
    for origin in os.getenv(
        "FRONTEND_ORIGIN",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3101,http://127.0.0.1:3101",
    ).split(",")
    if origin.strip()
]
frontend_origins = [
    origin if "://" in origin else f"https://{origin}"
    for origin in frontend_origins
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=frontend_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["Authorization", "Content-Type"],
)

environment = os.getenv("ENVIRONMENT", "development").lower()
secret = os.getenv("JWT_SECRET", "development-only-change-me")
if environment == "production":
    if secret == "development-only-change-me" or len(secret) < 32:
        raise RuntimeError("Production requires a random JWT_SECRET of at least 32 characters.")
    database_url = os.getenv("DATABASE_URL", "")
    if not database_url.startswith("postgresql"):
        raise RuntimeError("Production requires a PostgreSQL DATABASE_URL.")
    if not frontend_origins:
        raise RuntimeError("Production requires an explicit FRONTEND_ORIGIN allowlist.")

Base.metadata.create_all(bind=engine)
observation_columns = {
    "systolic_bp": "INTEGER",
    "diastolic_bp": "INTEGER",
    "spo2": "INTEGER",
    "airway": "VARCHAR(30)",
    "breathing": "VARCHAR(30)",
    "circulation": "VARCHAR(30)",
    "disability": "VARCHAR(30)",
    "exposure": "VARCHAR(30)",
}


def migrate_observation_columns(database_engine: Engine) -> None:
    if "observations" not in inspect(database_engine).get_table_names():
        return
    existing_columns = {
        column["name"]
        for column in inspect(database_engine).get_columns("observations")
    }
    with database_engine.begin() as connection:
        for column, sql_type in observation_columns.items():
            if column not in existing_columns:
                connection.execute(
                    text(f"ALTER TABLE observations ADD COLUMN {column} {sql_type}")
                )


migrate_observation_columns(engine)
patient_columns = {
    "discharged_at": "DATETIME",
    "outcome": "VARCHAR(500) NOT NULL DEFAULT ''",
    "advice": "VARCHAR(1000) NOT NULL DEFAULT ''",
}
existing_patient_columns = {
    column["name"] for column in inspect(engine).get_columns("patients")
}
with engine.begin() as connection:
    for column, sql_type in patient_columns.items():
        if column not in existing_patient_columns:
            connection.execute(text(f"ALTER TABLE patients ADD COLUMN {column} {sql_type}"))
    existing_alert_columns = {
        column["name"] for column in inspect(connection).get_columns("alerts")
    }
    if "resolution_reason" not in existing_alert_columns:
        connection.execute(
            text("ALTER TABLE alerts ADD COLUMN resolution_reason VARCHAR(500) NOT NULL DEFAULT ''")
        )

passwords = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)
HOSPITAL = {"name": "Northstar General Hospital", "lat": 13.0827, "lng": 80.2707}
RESOURCE_SEEDS = (
    ("Defibrillator", 4, 1),
    ("BP monitor", 10, 6),
    ("X-ray", 2, 1),
    ("Stretchers", 15, 11),
    ("Wheelchairs", 12, 5),
)
AMBULANCE_SEEDS = (
    {
        "code": "AMB-01",
        "direction": "INBOUND",
        "origin": "T. Nagar, Chennai",
        "origin_lat": 13.0418,
        "origin_lng": 80.2337,
        "destination": HOSPITAL["name"],
        "destination_lat": 13.0827,
        "destination_lng": 80.2707,
    },
    {
        "code": "AMB-02",
        "direction": "INBOUND",
        "origin": "Adyar, Chennai",
        "origin_lat": 12.9975,
        "origin_lng": 80.2567,
        "destination": HOSPITAL["name"],
        "destination_lat": 13.0827,
        "destination_lng": 80.2707,
    },
    {
        "code": "AMB-03",
        "direction": "OUTBOUND",
        "origin": HOSPITAL["name"],
        "origin_lat": 13.0827,
        "origin_lng": 80.2707,
        "destination": "Fictional Regional Facility, Chennai",
        "destination_lat": 13.0569,
        "destination_lng": 80.2425,
    },
)


def resource_status(total: int, used: int, offline: bool = False) -> str:
    if offline:
        return "Offline"
    if used >= total:
        return "Full"
    if used / total >= 0.75:
        return "Limited"
    return "Operational"


def gps_is_stale(last_updated: datetime | None, now: datetime | None = None) -> bool:
    if last_updated is None:
        return True
    current_time = now or datetime.now(timezone.utc)
    if last_updated.tzinfo is None:
        last_updated = last_updated.replace(tzinfo=timezone.utc)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)
    return (current_time - last_updated).total_seconds() > 30


def _resource_block_reason(resource: Resource) -> str:
    reasons = []
    if resource.status == "Offline":
        reasons.append("Resource is offline.")
    if resource.used >= resource.total:
        reasons.append("Resource is full.")
    return " ".join(reasons)


def seed_operational_resources(db: Session) -> None:
    for name, total, used in RESOURCE_SEEDS:
        item = db.scalar(select(Resource).where(Resource.name == name))
        if item is None:
            db.add(
                Resource(
                    name=name,
                    total=total,
                    used=used,
                    status=resource_status(total, used),
                )
            )
    for details in AMBULANCE_SEEDS:
        if db.get(Ambulance, details["code"]) is None:
            db.add(Ambulance(**details))
    db.commit()


DEMO_PATIENTS = (
    ("PT-1042", "Maya Rodriguez", 42, "Chest discomfort", "Critical", "Resus 01"),
    ("PT-1047", "Ethan Brooks", 67, "Shortness of breath", "Urgent", "Triage 02"),
    ("PT-1051", "Olivia Chen", 29, "Laceration - hand", "Standard", "Waiting room"),
    ("PT-1054", "Noah Williams", 51, "Abdominal pain", "Urgent", "Triage 01"),
    ("PT-1058", "Ava Patel", 34, "Ankle injury", "Standard", "Waiting room"),
    ("PT-1062", "Liam Johnson", 73, "Dizziness", "Urgent", "Observation"),
    ("PT-1065", "Isabella Garcia", 26, "Fever", "Standard", "Waiting room"),
    ("PT-1069", "Oliver Brown", 59, "Back pain", "Standard", "Triage 03"),
)


def seed_demo_data(db: Session) -> None:
    user = db.scalar(select(User).where(User.email == "demo@northstar.example"))
    if user is None:
        user = User(
            email="demo@northstar.example",
            name="Dr. Riley Morgan",
            role="physician",
            password_hash=passwords.hash("PulseCare-Demo-Only"),
        )
        db.add(user)
        db.flush()
        db.add(
            AuditLog(
                actor_id=user.id,
                action="demo.user.seeded",
                entity="user",
                entity_id=str(user.id),
            )
        )

    demo_patients: dict[str, Patient] = {}
    for external_id, name, age, reason, acuity, area in DEMO_PATIENTS:
        patient = db.scalar(
            select(Patient).where(Patient.external_id == external_id)
        )
        if patient is None:
            patient = Patient(
                external_id=external_id,
                name=name,
                age=age,
                reason=reason,
                acuity=acuity,
                area=area,
            )
            db.add(patient)
            db.flush()
        demo_patients[external_id] = patient
        if not db.scalar(
            select(TriageHistory).where(TriageHistory.patient_id == patient.id)
        ):
            db.add(
                TriageHistory(
                    patient_id=patient.id,
                    acuity=patient.acuity,
                    changed_by=user.id,
                    changed_at=patient.created_at,
                )
            )

    for name, total, used in RESOURCE_SEEDS:
        resource = db.scalar(select(Resource).where(Resource.name == name))
        if resource is None:
            db.add(
                Resource(
                    name=name,
                    total=total,
                    used=used,
                    status=resource_status(total, used),
                )
            )

    for details in AMBULANCE_SEEDS:
        if db.get(Ambulance, details["code"]) is None:
            db.add(Ambulance(**details))

    alert_seeds = (
        ("demo-wait", "Waiting-time reminder", "Please review the current waiting queue.", "PT-1051"),
        ("demo-observation", "Observation requires review", "A fictional observation is ready for staff review.", "PT-1047"),
        ("demo-resource", "Resource availability notice", "Review imaging resource availability before assigning a patient.", "PT-1054"),
    )
    for kind, title, body, patient_ref in alert_seeds:
        if db.scalar(
            select(Alert).where(
                Alert.kind == kind,
                Alert.patient_id == demo_patients[patient_ref].id,
            )
        ) is None:
            db.add(
                Alert(
                    kind=kind,
                    title=title,
                    body=body,
                    patient_id=demo_patients[patient_ref].id,
                )
            )

    db.commit()


with SessionLocal() as db:
    seed_demo_data(db)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "pulsecare-api",
        "timestamp": datetime.now(timezone.utc),
    }


def token_for(user: User) -> str:
    expires_at = datetime.now(timezone.utc) + timedelta(hours=8)
    return jwt.encode(
        {"sub": str(user.id), "exp": expires_at},
        secret,
        algorithm="HS256",
    )


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        subject = jwt.decode(
            credentials.credentials,
            secret,
            algorithms=["HS256"],
        ).get("sub")
        user_id = int(subject)
    except (JWTError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid or expired session") from None

    user = db.get(User, user_id)
    if user is None or not user.active:
        raise HTTPException(status_code=401, detail="User session is inactive")
    return user


def require_roles(*roles: str):
    def guard(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(
                status_code=403,
                detail="Your role cannot perform this action",
            )
        return user

    return guard


def audit(db: Session, user: User, action: str, entity: str, entity_id: int) -> None:
    db.add(
        AuditLog(
            actor_id=user.id,
            action=action,
            entity=entity,
            entity_id=str(entity_id),
        )
    )


@app.post("/api/auth/login")
def login(data: Login, db: Session = Depends(get_db)):
    email = data.email.strip().lower()
    if email == "gayathri":
        email = "demo@northstar.example"
    user = db.scalar(select(User).where(User.email == email))
    if user is None or not passwords.verify(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    audit(db, user, "auth.login", "user", user.id)
    db.commit()
    return {
        "access_token": token_for(user),
        "token_type": "bearer",
        "user": UserOut.model_validate(user),
    }


@app.get("/api/auth/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


@app.post("/api/auth/logout")
def logout(
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    audit(db, user, "auth.logout", "user", user.id)
    db.commit()
    return {"message": "Session ended"}


@app.get("/api/patients", response_model=list[PatientOut])
def patients(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return db.scalars(select(Patient).order_by(Patient.created_at.desc())).all()


@app.post("/api/patients", response_model=PatientOut, status_code=201)
def create_patient(
    data: PatientCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    item = Patient(
        external_id=f"PT-{uuid4().hex[:12].upper()}",
        name=data.name.strip(),
        age=data.age,
        reason=data.reason.strip(),
        acuity=data.acuity,
    )
    db.add(item)
    db.flush()
    db.add(
        TriageHistory(
            patient_id=item.id,
            acuity=item.acuity,
            changed_by=user.id,
        )
    )

    if data.notes.strip():
        db.add(
            Observation(
                patient_id=item.id,
                created_by=user.id,
                notes=data.notes.strip(),
            )
        )
    audit(db, user, "patient.created", "patient", item.id)
    db.commit()
    db.refresh(item)
    return item


@app.patch("/api/patients/{patient_id}", response_model=PatientOut)
def update_patient(
    patient_id: int,
    data: PatientUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    item = db.get(Patient, patient_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    updates = data.model_dump(exclude_none=True)
    if "acuity" in updates and updates["acuity"] != item.acuity:
        db.add(
            TriageHistory(
                patient_id=item.id,
                acuity=updates["acuity"],
                changed_by=user.id,
            )
        )
    if updates.get("status") == "Discharged" and item.status != "Discharged":
        item.discharged_at = datetime.now(timezone.utc)
    elif updates.get("status") and updates["status"] != "Discharged":
        item.discharged_at = None
    for key, value in updates.items():
        setattr(item, key, value)
    audit(db, user, "patient.updated", "patient", item.id)
    db.commit()
    db.refresh(item)
    return item


@app.get(
    "/api/patients/{patient_id}/observations",
    response_model=list[ObservationOut],
)
def patient_observations(
    patient_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    if db.get(Patient, patient_id) is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    return db.scalars(
        select(Observation)
        .where(Observation.patient_id == patient_id)
        .order_by(Observation.created_at.desc())
    ).all()


@app.post(
    "/api/patients/{patient_id}/observations",
    response_model=ObservationOut,
    status_code=201,
)
def create_observation(
    patient_id: int,
    data: ObservationCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    if db.get(Patient, patient_id) is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    item = Observation(
        patient_id=patient_id,
        created_by=user.id,
        **data.model_dump(),
    )
    db.add(item)
    db.add(
        Alert(
            kind="reassessment",
            title="Observation requires review",
            body=f"New observation recorded for patient {patient_id}.",
            patient_id=patient_id,
        )
    )
    audit(db, user, "observation.created", "patient", patient_id)
    db.commit()
    db.refresh(item)
    return item


@app.post("/api/patients/{patient_id}/reassessment", status_code=201)
def request_reassessment(
    patient_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    item = db.get(Patient, patient_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    item.status = "Reassessment"
    existing = db.scalar(
        select(Alert).where(
            Alert.patient_id == patient_id,
            Alert.kind == "reassessment",
            Alert.resolved.is_(False),
        )
    )
    if existing is None:
        db.add(
            Alert(
                kind="reassessment",
                title="Reassessment requested",
                body=f"Patient {item.external_id} is ready for clinician review.",
                patient_id=patient_id,
            )
        )
    audit(db, user, "reassessment.requested", "patient", patient_id)
    db.commit()
    return {"message": "Reassessment requested"}


@app.get("/api/resources", response_model=list[ResourceOut])
def resources(db: Session = Depends(get_db), user: User = Depends(current_user)):
    items = db.scalars(select(Resource).order_by(Resource.id)).all()
    for item in items:
        item.status = resource_status(item.total, item.used, offline=item.status == "Offline")
    return items


@app.patch("/api/resources/{resource_id}", response_model=ResourceOut)
def update_resource(
    resource_id: int,
    data: ResourceUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician")),
):
    item = db.get(Resource, resource_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Resource not found")
    if item.total <= 0:
        raise HTTPException(
            status_code=409,
            detail="Resource total capacity must be greater than zero",
        )
    if data.used > item.total:
        raise HTTPException(
            status_code=422,
            detail="Used capacity cannot exceed total capacity",
        )
    was_offline = item.status == "Offline"
    item.used = data.used
    is_offline = data.status == "Offline" if data.status is not None else was_offline
    item.status = resource_status(item.total, item.used, offline=is_offline)
    audit(db, user, "resource.updated", "resource", item.id)
    db.commit()
    db.refresh(item)
    return item


@app.get("/api/resource-needs", response_model=list[ResourceNeedOut])
def resource_needs(db: Session = Depends(get_db), user: User = Depends(current_user)):
    items = db.scalars(
        select(PatientResourceNeed).order_by(PatientResourceNeed.created_at.desc())
    ).all()
    for item in items:
        reason = _resource_block_reason(item.resource)
        item.blocked_reason = reason
        if reason and item.status != "Used":
            item.status = "Blocked"
        elif not reason and item.status == "Blocked":
            item.status = "Needed"
    return items


@app.post(
    "/api/resources/{resource_id}/needs",
    response_model=ResourceNeedOut,
    status_code=201,
)
def request_resource(
    resource_id: int,
    data: ResourceNeedCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    resource = db.get(Resource, resource_id)
    patient = db.get(Patient, data.patient_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Resource not found")
    if patient is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    blocked_reason = _resource_block_reason(resource)
    item = PatientResourceNeed(
        resource_id=resource.id,
        patient_id=patient.id,
        status="Blocked" if blocked_reason else "Needed",
        blocked_reason=blocked_reason,
    )
    db.add(item)
    db.flush()
    audit(db, user, "resource.needed", "resource_need", item.id)
    db.commit()
    db.refresh(item)
    return item


@app.patch("/api/resource-needs/{need_id}", response_model=ResourceNeedOut)
def update_resource_need(
    need_id: int,
    data: ResourceNeedUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    item = db.get(PatientResourceNeed, need_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Resource request not found")
    resource = item.resource
    blocked_reason = _resource_block_reason(resource)
    if data.status == "Used" and item.status != "Used":
        if blocked_reason:
            raise HTTPException(status_code=409, detail=f"Resource blocked: {blocked_reason}")
        if resource.used >= resource.total:
            raise HTTPException(status_code=422, detail="Used capacity cannot exceed total capacity")
        resource.used += 1
        item.status = "Used"
        resource.status = resource_status(resource.total, resource.used)
    elif data.status == "Used":
        item.blocked_reason = ""
    elif item.status == "Used":
        resource.used -= 1
        resource.status = resource_status(resource.total, resource.used, offline=resource.status == "Offline")
        item.status = "Needed"
    else:
        item.status = "Blocked" if blocked_reason else "Needed"
    item.blocked_reason = blocked_reason
    audit(db, user, "resource.need_updated", "resource_need", item.id)
    db.commit()
    db.refresh(item)
    return item


@app.get("/api/referrals", response_model=list[ReferralOut])
def referrals(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return db.scalars(select(Referral).order_by(Referral.created_at.desc())).all()


@app.post("/api/patients/{patient_id}/referrals", response_model=ReferralOut, status_code=201)
def create_referral(
    patient_id: int,
    data: ReferralCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    item = Referral(
        patient_id=patient.id,
        department=data.department,
        urgency=data.urgency,
        reason=data.reason.strip(),
        requested_by=user.id,
    )
    db.add(item)
    db.flush()
    audit(db, user, "referral.requested", "referral", item.id)
    db.commit()
    db.refresh(item)
    return item


@app.patch("/api/referrals/{referral_id}", response_model=ReferralOut)
def update_referral(
    referral_id: int,
    data: ReferralUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    item = db.get(Referral, referral_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Referral not found")
    allowed = {
        "Requested": {"Accepted", "Declined"},
        "Accepted": {"Completed"},
    }
    if data.status not in allowed.get(item.status, set()):
        raise HTTPException(status_code=409, detail=f"Cannot change referral from {item.status} to {data.status}")
    item.status = data.status
    audit(db, user, f"referral.{data.status.lower()}", "referral", item.id)
    db.commit()
    db.refresh(item)
    return item


def _ambulance_location_payload(
    db: Session,
    ambulance: Ambulance,
    include_trail: bool = True,
) -> dict:
    points = db.scalars(
        select(AmbulanceLocation)
        .where(AmbulanceLocation.ambulance_code == ambulance.code)
        .order_by(AmbulanceLocation.created_at.desc(), AmbulanceLocation.id.desc())
        .limit(50 if include_trail else 1)
    ).all()
    trail = list(reversed(points))
    latest = points[0] if points else None
    last_updated = latest.created_at if latest else None
    return {
        "code": ambulance.code,
        "direction": ambulance.direction,
        "origin": ambulance.origin,
        "origin_lat": ambulance.origin_lat,
        "origin_lng": ambulance.origin_lng,
        "destination": ambulance.destination,
        "destination_lat": ambulance.destination_lat,
        "destination_lng": ambulance.destination_lng,
        "patient_id": ambulance.patient_id,
        "lat": latest.lat if latest else None,
        "lng": latest.lng if latest else None,
        "speed": latest.speed if latest else 0,
        "heading": latest.heading if latest else 0,
        "last_updated": last_updated,
        "gps_lost": gps_is_stale(last_updated),
        "trail": [
            {"lat": point.lat, "lng": point.lng, "created_at": point.created_at}
            for point in (trail if include_trail else [])
        ],
    }


@app.get("/api/ambulances")
def ambulances(
    include_trail: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    items = db.scalars(select(Ambulance).order_by(Ambulance.code)).all()
    return {
        "hospital": HOSPITAL,
        "ambulances": [
            _ambulance_location_payload(db, item, include_trail=include_trail)
            for item in items
        ],
    }


@app.get("/api/ambulances/{ambulance_code}/location")
def ambulance_location(
    ambulance_code: str,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    ambulance = db.get(Ambulance, ambulance_code.upper())
    if ambulance is None:
        raise HTTPException(status_code=404, detail="Ambulance not found")
    return _ambulance_location_payload(db, ambulance)


@app.post("/api/ambulances/{ambulance_code}/location", status_code=201)
def receive_ambulance_location(
    ambulance_code: str,
    data: AmbulanceLocationCreate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    ambulance = db.get(Ambulance, ambulance_code.upper())
    if ambulance is None:
        raise HTTPException(status_code=404, detail="Ambulance not found")
    point = AmbulanceLocation(
        ambulance_code=ambulance.code,
        **data.model_dump(),
    )
    db.add(point)
    db.flush()
    audit(db, user, "ambulance.location_received", "ambulance", ambulance.code)
    db.commit()
    db.refresh(point)
    return {
        "code": ambulance.code,
        "lat": point.lat,
        "lng": point.lng,
        "speed": point.speed,
        "heading": point.heading,
        "last_updated": point.created_at,
    }


def _final_report(db: Session, patient: Patient) -> dict:
    triage = db.scalars(
        select(TriageHistory)
        .where(TriageHistory.patient_id == patient.id)
        .order_by(TriageHistory.changed_at, TriageHistory.id)
    ).all()
    referrals = db.scalars(
        select(Referral)
        .where(Referral.patient_id == patient.id)
        .order_by(Referral.created_at)
    ).all()
    resources = db.scalars(
        select(PatientResourceNeed)
        .where(
            PatientResourceNeed.patient_id == patient.id,
            PatientResourceNeed.status == "Used",
        )
        .order_by(PatientResourceNeed.created_at)
    ).all()
    discharged_at = patient.discharged_at or patient.updated_at
    arrival = patient.created_at
    if arrival.tzinfo is None:
        arrival = arrival.replace(tzinfo=timezone.utc)
    if discharged_at.tzinfo is None:
        discharged_at = discharged_at.replace(tzinfo=timezone.utc)
    return {
        "patient_id": patient.external_id,
        "name": patient.name,
        "age": patient.age,
        "arrival": patient.created_at,
        "discharged_at": patient.discharged_at,
        "triage_history": [
            {"acuity": entry.acuity, "changed_at": entry.changed_at}
            for entry in triage
        ],
        "wait_minutes": max(0, int((discharged_at - arrival).total_seconds() // 60)),
        "referrals": [
            {
                "department": item.department,
                "urgency": item.urgency,
                "status": item.status,
                "reason": item.reason,
            }
            for item in referrals
        ],
        "resources_used": [item.resource.name for item in resources],
        "outcome": patient.outcome,
        "advice": patient.advice,
    }


@app.get("/api/patients/{patient_id}/final-report")
def final_report(
    patient_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    if patient.status != "Discharged":
        raise HTTPException(status_code=409, detail="Discharge the patient before generating a final report")
    report = _final_report(db, patient)
    audit(db, user, "report.generated", "patient", patient.id)
    db.commit()
    return report


@app.get("/api/patients/{patient_id}/final-report.csv")
def final_report_csv(
    patient_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    if patient.status != "Discharged":
        raise HTTPException(status_code=409, detail="Discharge the patient before downloading the final report")
    report = _final_report(db, patient)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(("Field", "Value"))
    for key, value in report.items():
        if isinstance(value, list):
            value = json.dumps(value, ensure_ascii=False, default=str)
        writer.writerow((key, value if value is not None else ""))
    audit(db, user, "report.csv_downloaded", "patient", patient.id)
    db.commit()
    filename = f"final-report-{patient.external_id}.csv"
    return Response(
        content="\ufeff" + output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/patients/{patient_id}/sms", status_code=201)
def send_patient_sms(
    patient_id: int,
    data: SmsCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    if not data.consent:
        raise HTTPException(status_code=422, detail="Recorded SMS consent is required")
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    if patient.status != "Discharged":
        raise HTTPException(status_code=409, detail="SMS can be sent only after discharge")

    account_sid = os.getenv("TWILIO_ACCOUNT_SID")
    auth_token = os.getenv("TWILIO_AUTH_TOKEN")
    from_number = os.getenv("TWILIO_FROM_NUMBER")
    twilio_values = (account_sid, auth_token, from_number)
    if any(twilio_values) and not all(twilio_values):
        raise HTTPException(status_code=503, detail="Twilio is partially configured; set all TWILIO_* variables")

    status = "Demo queued"
    provider_sid = ""
    if all(twilio_values):
        endpoint = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"
        payload = urllib.parse.urlencode(
            {"To": data.phone, "From": from_number, "Body": data.message}
        ).encode()
        request = urllib.request.Request(endpoint, data=payload, method="POST")
        request.add_header(
            "Authorization",
            "Basic " + base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode(),
        )
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                twilio_response = json.loads(response.read().decode())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise HTTPException(status_code=502, detail=f"Twilio SMS failed: {error}") from None
        status = "Sent"
        provider_sid = twilio_response.get("sid", "")

    outbox = SmsOutbox(
        patient_id=patient.id,
        phone=data.phone,
        message=data.message,
        status=status,
        provider_sid=provider_sid,
        sent_by=user.id,
    )
    db.add(outbox)
    db.flush()
    audit(db, user, "sms.sent" if status == "Sent" else "sms.queued", "sms", outbox.id)
    db.commit()
    db.refresh(outbox)
    return {
        "id": outbox.id,
        "phone": outbox.phone,
        "status": outbox.status,
        "created_at": outbox.created_at,
    }


@app.get("/api/sms-outbox")
def sms_outbox(db: Session = Depends(get_db), user: User = Depends(current_user)):
    items = db.scalars(select(SmsOutbox).order_by(SmsOutbox.created_at.desc())).all()
    return [
        {
            "id": item.id,
            "patient_id": item.patient_id,
            "phone": item.phone,
            "message": item.message,
            "status": item.status,
            "created_at": item.created_at,
        }
        for item in items
    ]


@app.get("/api/alerts", response_model=list[AlertOut])
def alerts(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return db.scalars(
        select(Alert)
        .where(Alert.resolved.is_(False))
        .order_by(Alert.created_at.desc())
    ).all()


def _demo_active_patient(db: Session) -> Patient:
    patient = db.scalar(
        select(Patient)
        .where(Patient.status != "Discharged")
        .order_by(Patient.created_at, Patient.id)
    )
    if patient is None:
        raise HTTPException(status_code=409, detail="Register or seed an active patient before using demo controls")
    return patient


@app.post("/api/demo-controls/worsen-vitals")
def demo_worsen_vitals(
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    patient = _demo_active_patient(db)
    observation = Observation(
        patient_id=patient.id,
        created_by=user.id,
        heart_rate=142,
        respiratory_rate=30,
        systolic_bp=88,
        diastolic_bp=58,
        spo2=88,
        notes="Fictional demo update: vital signs worsened. Staff review required.",
    )
    alert = Alert(
        kind="reassessment",
        title="Look again: vital signs changed",
        body="SpO₂ is 88%, systolic BP is 88 mmHg, and heart rate is 142 bpm. Look again and review this fictional update.",
        patient_id=patient.id,
    )
    db.add_all((observation, alert))
    db.flush()
    audit(db, user, "demo.vitals_worsened", "patient", patient.id)
    db.commit()
    return {"patient_id": patient.id, "alert_id": alert.id, "acuity": patient.acuity}


@app.post("/api/demo-controls/scanner-offline")
def demo_scanner_offline(
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    patient = _demo_active_patient(db)
    scanner = db.scalar(select(Resource).where(Resource.name == "X-ray"))
    if scanner is None:
        scanner = Resource(name="X-ray", total=2, used=1, status="Offline")
        db.add(scanner)
        db.flush()
    scanner.status = "Offline"

    need = db.scalar(
        select(PatientResourceNeed).where(
            PatientResourceNeed.patient_id == patient.id,
            PatientResourceNeed.resource_id == scanner.id,
            PatientResourceNeed.status != "Used",
        )
    )
    if need is None:
        need = PatientResourceNeed(
            patient_id=patient.id,
            resource_id=scanner.id,
            status="Blocked",
            blocked_reason="Resource is offline.",
        )
        db.add(need)
    else:
        need.status = "Blocked"
        need.blocked_reason = "Resource is offline."

    alert = Alert(
        kind="resource-blocked",
        title="Resource blocked",
        body="X-ray scanner is offline. The requested imaging resource is blocked until staff restores availability.",
        patient_id=patient.id,
    )
    db.add(alert)
    db.flush()
    audit(db, user, "demo.scanner_offline", "resource", scanner.id)
    audit(db, user, "resource.needed", "resource_need", need.id)
    db.commit()
    return {"patient_id": patient.id, "resource_id": scanner.id, "alert_id": alert.id}


@app.post("/api/demo-controls/dismiss-flag")
def demo_dismiss_flag(
    data: DemoDismiss,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    alert = db.scalar(
        select(Alert)
        .where(Alert.resolved.is_(False))
        .order_by(Alert.created_at.desc(), Alert.id.desc())
    )
    if alert is None:
        raise HTTPException(status_code=409, detail="There are no open flags to dismiss")
    alert.resolved = True
    alert.resolution_reason = data.reason.strip()
    audit(db, user, "alert.dismissed", "alert", alert.id)
    db.commit()
    return {"alert_id": alert.id, "reason": alert.resolution_reason}


@app.post("/api/demo-controls/late-update", status_code=201)
def demo_late_update(
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    arrived_at = datetime.now(timezone.utc) - timedelta(minutes=45)
    patient = Patient(
        external_id=f"PT-LATE-{uuid4().hex[:8].upper()}",
        name="Jordan Sample",
        age=38,
        reason="Fictional late arrival feed update",
        acuity="Standard",
        status="Waiting",
        area="Late update",
        created_at=arrived_at,
        updated_at=arrived_at,
    )
    db.add(patient)
    db.flush()
    db.add(
        TriageHistory(
            patient_id=patient.id,
            acuity=patient.acuity,
            changed_by=user.id,
            changed_at=arrived_at,
        )
    )
    audit(db, user, "demo.late_update_received", "patient", patient.id)
    db.commit()
    return PatientOut.model_validate(patient)


@app.post("/api/alerts/{alert_id}/resolve")
def resolve_alert(
    alert_id: int,
    data: AlertResolve | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    item = db.get(Alert, alert_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    item.resolved = True
    item.resolution_reason = data.reason.strip() if data else "Reviewed by staff."
    audit(db, user, "alert.resolved", "alert", item.id)
    db.commit()
    return {"message": "Alert reviewed"}


@app.get("/api/analytics")
def analytics(db: Session = Depends(get_db), user: User = Depends(current_user)):
    rows = db.scalars(select(Patient)).all()
    active = [patient for patient in rows if patient.status != "Discharged"]
    acuity_mix = {
        acuity: sum(patient.acuity == acuity for patient in active)
        for acuity in ("Critical", "Urgent", "Standard")
    }
    status_counts = {
        status: sum(patient.status == status for patient in active)
        for status in ("Waiting", "In treatment", "Reassessment")
    }
    return {
        "patients_in_queue": len(active),
        "acuity_mix": acuity_mix,
        "status_counts": status_counts,
        "arrivals": len(rows),
        "in_treatment": sum(patient.status == "In treatment" for patient in active),
        "discharged": sum(patient.status == "Discharged" for patient in rows),
        "recorded_at": datetime.now(timezone.utc),
    }


@app.get("/api/audit")
def audit_logs(
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin")),
):
    return db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc())).all()
