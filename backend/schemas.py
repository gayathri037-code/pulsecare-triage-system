from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def normalize_utc(value):
    if isinstance(value, datetime) and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


class Login(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    role: str


class PatientCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    age: int = Field(ge=0, le=120)
    reason: str = Field(min_length=2, max_length=500)
    acuity: str = Field(default="Standard", pattern="^(Critical|Urgent|Standard)$")
    notes: str = Field(default="", max_length=2000)


class PatientUpdate(BaseModel):
    acuity: str | None = Field(default=None, pattern="^(Critical|Urgent|Standard)$")
    status: str | None = Field(
        default=None,
        pattern="^(Waiting|In treatment|Reassessment|Discharged)$",
    )
    area: str | None = Field(default=None, max_length=80)
    outcome: str | None = Field(default=None, max_length=500)
    advice: str | None = Field(default=None, max_length=1000)


class PatientOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    external_id: str
    name: str
    age: int
    reason: str
    acuity: str
    status: str
    area: str
    created_at: datetime
    updated_at: datetime

    @field_validator("created_at", "updated_at", mode="before")
    @classmethod
    def normalize_timestamps(cls, value):
        return normalize_utc(value)


class ObservationCreate(BaseModel):
    heart_rate: int | None = Field(default=None, ge=20, le=250)
    respiratory_rate: int | None = Field(default=None, ge=4, le=80)
    systolic_bp: int | None = Field(default=None, ge=40, le=300)
    diastolic_bp: int | None = Field(default=None, ge=20, le=200)
    spo2: int | None = Field(default=None, ge=0, le=100)
    airway: str | None = Field(default=None, pattern="^(Clear|Concern|Not assessed)$")
    breathing: str | None = Field(default=None, pattern="^(Clear|Concern|Not assessed)$")
    circulation: str | None = Field(default=None, pattern="^(Clear|Concern|Not assessed)$")
    disability: str | None = Field(default=None, pattern="^(Clear|Concern|Not assessed)$")
    exposure: str | None = Field(default=None, pattern="^(Clear|Concern|Not assessed)$")
    notes: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def require_observation_content(self):
        if (self.systolic_bp is None) != (self.diastolic_bp is None):
            raise ValueError("Record both systolic and diastolic blood pressure")
        if (
            self.systolic_bp is not None
            and self.diastolic_bp is not None
            and self.systolic_bp <= self.diastolic_bp
        ):
            raise ValueError("Systolic pressure must be greater than diastolic pressure")
        if (
            self.heart_rate is None
            and self.respiratory_rate is None
            and self.systolic_bp is None
            and self.spo2 is None
            and all(
                finding is None
                for finding in (
                    self.airway,
                    self.breathing,
                    self.circulation,
                    self.disability,
                    self.exposure,
                )
            )
            and not self.notes.strip()
        ):
            raise ValueError("Record a measurement or note before saving")
        return self


class ObservationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    patient_id: int
    heart_rate: int | None
    respiratory_rate: int | None
    systolic_bp: int | None
    diastolic_bp: int | None
    spo2: int | None
    airway: str | None
    breathing: str | None
    circulation: str | None
    disability: str | None
    exposure: str | None
    notes: str
    created_at: datetime

    @field_validator("created_at", mode="before")
    @classmethod
    def normalize_timestamp(cls, value):
        return normalize_utc(value)


class ResourceUpdate(BaseModel):
    used: int = Field(ge=0)
    status: str | None = Field(default=None, pattern="^(Operational|Offline)$")


class ResourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    total: int
    used: int
    status: str


class ResourceNeedCreate(BaseModel):
    patient_id: int = Field(gt=0)


class ResourceNeedUpdate(BaseModel):
    status: str = Field(pattern="^(Needed|Used)$")


class ResourceNeedOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    patient_id: int
    resource_id: int
    status: str
    blocked_reason: str
    created_at: datetime
    resource: ResourceOut
    patient: PatientOut


class ReferralCreate(BaseModel):
    department: str = Field(pattern="^(Cardiology|Orthopaedics|Neurology|Surgery|Paediatrics|Radiology|ICU)$")
    urgency: str = Field(pattern="^(Routine|Urgent|Emergency)$")
    reason: str = Field(min_length=2, max_length=1000)


class ReferralUpdate(BaseModel):
    status: str = Field(pattern="^(Accepted|Completed|Declined)$")


class ReferralOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    patient_id: int
    department: str
    urgency: str
    reason: str
    status: str
    requested_by: int
    created_at: datetime
    updated_at: datetime
    patient: PatientOut


class AmbulanceLocationCreate(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    speed: float = Field(ge=0, le=300)
    heading: float = Field(ge=0, lt=360)


class SmsCreate(BaseModel):
    phone: str = Field(pattern=r"^\+[1-9]\d{7,14}$")
    message: str = Field(min_length=1, max_length=160)
    consent: bool

    @field_validator("message")
    @classmethod
    def require_approved_generic_message(cls, value):
        if value != "Your hospital visit has ended. Please contact the hospital if you need assistance.":
            raise ValueError("Use the approved non-clinical demo message")
        return value


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    title: str
    body: str
    patient_id: int | None
    resolved: bool
    resolution_reason: str
    created_at: datetime

    @field_validator("created_at", mode="before")
    @classmethod
    def normalize_timestamp(cls, value):
        return normalize_utc(value)


class AlertResolve(BaseModel):
    reason: str = Field(default="Reviewed by staff.", min_length=3, max_length=500)


class DemoDismiss(BaseModel):
    reason: str = Field(min_length=3, max_length=500)
