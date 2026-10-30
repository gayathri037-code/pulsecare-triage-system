from datetime import datetime, timezone
from sqlalchemy import String, Integer, DateTime, Boolean, ForeignKey, Text, CheckConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base

def now(): return datetime.now(timezone.utc)

class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(30), default="nurse")
    password_hash: Mapped[str] = mapped_column(String(255))
    active: Mapped[bool] = mapped_column(Boolean, default=True)

class Patient(Base):
    __tablename__ = "patients"
    id: Mapped[int] = mapped_column(primary_key=True)
    external_id: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(160))
    age: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(500))
    acuity: Mapped[str] = mapped_column(String(20), default="Standard")
    status: Mapped[str] = mapped_column(String(30), default="Waiting")
    area: Mapped[str] = mapped_column(String(80), default="Triage pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    discharged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    outcome: Mapped[str] = mapped_column(String(500), default="")
    advice: Mapped[str] = mapped_column(String(1000), default="")
    observations = relationship("Observation", back_populates="patient", cascade="all, delete-orphan")
    referrals = relationship("Referral", back_populates="patient", cascade="all, delete-orphan")
    resource_needs = relationship("PatientResourceNeed", back_populates="patient", cascade="all, delete-orphan")
    triage_history = relationship("TriageHistory", back_populates="patient", cascade="all, delete-orphan")
    __table_args__ = (CheckConstraint("age >= 0 AND age <= 120", name="valid_age"),)

class Observation(Base):
    __tablename__ = "observations"
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    heart_rate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    respiratory_rate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    systolic_bp: Mapped[int | None] = mapped_column(Integer, nullable=True)
    diastolic_bp: Mapped[int | None] = mapped_column(Integer, nullable=True)
    spo2: Mapped[int | None] = mapped_column(Integer, nullable=True)
    airway: Mapped[str | None] = mapped_column(String(30), nullable=True)
    breathing: Mapped[str | None] = mapped_column(String(30), nullable=True)
    circulation: Mapped[str | None] = mapped_column(String(30), nullable=True)
    disability: Mapped[str | None] = mapped_column(String(30), nullable=True)
    exposure: Mapped[str | None] = mapped_column(String(30), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    patient = relationship("Patient", back_populates="observations")

class Resource(Base):
    __tablename__ = "resources"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    total: Mapped[int] = mapped_column(Integer)
    used: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(30), default="Operational")
    __table_args__ = (
        CheckConstraint("total > 0", name="positive_total_capacity"),
        CheckConstraint("used >= 0 AND used <= total", name="valid_capacity"),
    )
    patient_needs = relationship("PatientResourceNeed", back_populates="resource")

class PatientResourceNeed(Base):
    __tablename__ = "patient_resource_needs"
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    resource_id: Mapped[int] = mapped_column(ForeignKey("resources.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="Needed")
    blocked_reason: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    patient = relationship("Patient", back_populates="resource_needs")
    resource = relationship("Resource", back_populates="patient_needs")

class TriageHistory(Base):
    __tablename__ = "triage_history"
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    acuity: Mapped[str] = mapped_column(String(20))
    changed_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    patient = relationship("Patient", back_populates="triage_history")

class Referral(Base):
    __tablename__ = "referrals"
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    department: Mapped[str] = mapped_column(String(30))
    urgency: Mapped[str] = mapped_column(String(20))
    reason: Mapped[str] = mapped_column(String(1000))
    status: Mapped[str] = mapped_column(String(20), default="Requested")
    requested_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    patient = relationship("Patient", back_populates="referrals")

class Ambulance(Base):
    __tablename__ = "ambulances"
    code: Mapped[str] = mapped_column(String(12), primary_key=True)
    direction: Mapped[str] = mapped_column(String(10), default="INBOUND")
    origin: Mapped[str] = mapped_column(String(120))
    origin_lat: Mapped[float] = mapped_column()
    origin_lng: Mapped[float] = mapped_column()
    destination: Mapped[str] = mapped_column(String(120))
    destination_lat: Mapped[float] = mapped_column()
    destination_lng: Mapped[float] = mapped_column()
    patient_id: Mapped[int | None] = mapped_column(ForeignKey("patients.id"), nullable=True)
    locations = relationship("AmbulanceLocation", back_populates="ambulance", cascade="all, delete-orphan")

class AmbulanceLocation(Base):
    __tablename__ = "ambulance_locations"
    id: Mapped[int] = mapped_column(primary_key=True)
    ambulance_code: Mapped[str] = mapped_column(ForeignKey("ambulances.code"), index=True)
    lat: Mapped[float] = mapped_column()
    lng: Mapped[float] = mapped_column()
    speed: Mapped[float] = mapped_column()
    heading: Mapped[float] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    ambulance = relationship("Ambulance", back_populates="locations")

class SmsOutbox(Base):
    __tablename__ = "sms_outbox"
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    phone: Mapped[str] = mapped_column(String(20))
    message: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(30))
    provider_sid: Mapped[str] = mapped_column(String(64), default="")
    sent_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(String(500))
    patient_id: Mapped[int | None] = mapped_column(ForeignKey("patients.id"), nullable=True)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    resolution_reason: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(100))
    entity: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[str] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
