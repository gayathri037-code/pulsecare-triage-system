import os
from uuid import uuid4
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from database import Base, engine, get_db
from models import Alert, AuditLog, Observation, Patient, Resource, User
from schemas import (
    AlertOut,
    Login,
    ObservationCreate,
    ObservationOut,
    PatientCreate,
    PatientOut,
    PatientUpdate,
    ResourceOut,
    ResourceUpdate,
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
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
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
passwords = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)


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
    user = db.scalar(select(User).where(User.email == email))
    if user is None or not passwords.verify(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {
        "access_token": token_for(user),
        "token_type": "bearer",
        "user": UserOut.model_validate(user),
    }


@app.get("/api/auth/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


@app.post("/api/auth/logout")
def logout(user: User = Depends(current_user)):
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
    )
    db.add(item)
    db.flush()

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
    for key, value in data.model_dump(exclude_none=True).items():
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
    return db.scalars(select(Resource).order_by(Resource.id)).all()


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
    item.used = data.used
    item.status = "Limited" if item.used / item.total >= 0.75 else "Operational"
    audit(db, user, "resource.updated", "resource", item.id)
    db.commit()
    db.refresh(item)
    return item


@app.get("/api/alerts", response_model=list[AlertOut])
def alerts(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return db.scalars(
        select(Alert)
        .where(Alert.resolved.is_(False))
        .order_by(Alert.created_at.desc())
    ).all()


@app.post("/api/alerts/{alert_id}/resolve")
def resolve_alert(
    alert_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "physician", "nurse", "triage")),
):
    item = db.get(Alert, alert_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    item.resolved = True
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
