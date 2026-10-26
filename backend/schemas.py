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
    notes: str = Field(default="", max_length=2000)


class PatientUpdate(BaseModel):
    acuity: str | None = Field(default=None, pattern="^(Critical|Urgent|Standard)$")
    status: str | None = Field(
        default=None,
        pattern="^(Waiting|In treatment|Reassessment|Discharged)$",
    )
    area: str | None = Field(default=None, max_length=80)


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
    notes: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def require_observation_content(self):
        if (
            self.heart_rate is None
            and self.respiratory_rate is None
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
    notes: str
    created_at: datetime

    @field_validator("created_at", mode="before")
    @classmethod
    def normalize_timestamp(cls, value):
        return normalize_utc(value)


class ResourceUpdate(BaseModel):
    used: int = Field(ge=0)


class ResourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    total: int
    used: int
    status: str


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    title: str
    body: str
    patient_id: int | None
    resolved: bool
    created_at: datetime

    @field_validator("created_at", mode="before")
    @classmethod
    def normalize_timestamp(cls, value):
        return normalize_utc(value)
