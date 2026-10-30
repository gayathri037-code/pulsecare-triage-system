import os
import csv
import io
from datetime import datetime, timedelta, timezone

os.environ["DATABASE_URL"] = "sqlite:///./test_pulsecare.db"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text

from database import Base, SessionLocal, engine, normalize_database_url
from main import (
    app,
    gps_is_stale,
    migrate_observation_columns,
    passwords,
    seed_demo_data,
    seed_operational_resources,
)
from models import Alert, Patient, PatientResourceNeed, Resource, User

client = TestClient(app)


def test_postgres_database_urls_use_psycopg_driver():
    assert normalize_database_url(
        "postgres://user:pass@host:5432/pulsecare"
    ) == "postgresql+psycopg://user:pass@host:5432/pulsecare"
    assert normalize_database_url(
        "postgresql://user:pass@host:5432/pulsecare"
    ) == "postgresql+psycopg://user:pass@host:5432/pulsecare"
    assert normalize_database_url("sqlite:///./pulsecare.db") == "sqlite:///./pulsecare.db"


def test_existing_observation_table_receives_new_clinical_columns():
    legacy_engine = create_engine("sqlite:///:memory:")
    with legacy_engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE observations ("
                "id INTEGER PRIMARY KEY, patient_id INTEGER, heart_rate INTEGER, "
                "respiratory_rate INTEGER, notes TEXT, created_by INTEGER, "
                "created_at DATETIME)"
            )
        )

    migrate_observation_columns(legacy_engine)

    columns = {column["name"] for column in inspect(legacy_engine).get_columns("observations")}
    assert {
        "systolic_bp",
        "diastolic_bp",
        "spo2",
        "airway",
        "breathing",
        "circulation",
        "disability",
        "exposure",
    }.issubset(columns)
    legacy_engine.dispose()


@pytest.fixture(autouse=True)
def reset_database():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    db.add_all(
        [
            User(
                email="demo@northstar.example",
                name="Dr. Riley Morgan",
                role="physician",
                password_hash=passwords.hash("PulseCare-Demo-Only"),
            ),
            User(
                email="nurse@northstar.example",
                name="Jordan Lee",
                role="nurse",
                password_hash=passwords.hash("Nurse-Demo-Only"),
            ),
            User(
                email="admin@northstar.example",
                name="Demo Administrator",
                role="admin",
                password_hash=passwords.hash("Admin-Demo-Only"),
            ),
            Resource(name="Treatment bays", total=10, used=4),
        ]
    )
    db.commit()
    db.close()
    db = SessionLocal()
    seed_operational_resources(db)
    db.close()
    yield


def token(email="demo@northstar.example", password="PulseCare-Demo-Only"):
    response = client.post(
        "/api/auth/login",
        json={"email": email, "password": password},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def auth(token_value):
    return {"Authorization": f"Bearer {token_value}"}


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_demo_seed_is_idempotent_and_creates_eight_patients_three_alerts_and_resources():
    db = SessionLocal()
    seed_demo_data(db)
    seed_demo_data(db)
    assert db.query(Patient).count() == 8
    assert db.query(Alert).filter(Alert.resolved.is_(False)).count() == 3
    assert db.query(Resource).filter(Resource.name.in_([
        "Defibrillator", "BP monitor", "X-ray", "Stretchers", "Wheelchairs",
    ])).count() == 5
    db.close()
    assert client.post(
        "/api/auth/login",
        json={"email": "demo@northstar.example", "password": "PulseCare-Demo-Only"},
    ).status_code == 200


def test_demo_controls_preserve_triage_record_reason_and_correct_late_queue():
    db = SessionLocal()
    seed_demo_data(db)
    db.close()
    headers = auth(token())

    patients_before = client.get("/api/patients", headers=headers).json()
    selected = min(patients_before, key=lambda patient: patient["created_at"])
    acuity_before = selected["acuity"]
    worsened = client.post("/api/demo-controls/worsen-vitals", headers=headers)
    assert worsened.status_code == 200
    assert worsened.json()["acuity"] == acuity_before
    flags = client.get("/api/alerts", headers=headers).json()
    look_again = next(item for item in flags if item["title"].startswith("Look again"))
    assert "SpO₂ is 88%" in look_again["body"]

    scanner_offline = client.post("/api/demo-controls/scanner-offline", headers=headers)
    assert scanner_offline.status_code == 200
    needs = client.get("/api/resource-needs", headers=headers).json()
    blocked_need = next(item for item in needs if item["patient_id"] == selected["id"])
    assert blocked_need["status"] == "Blocked"
    assert blocked_need["blocked_reason"] == "Resource is offline."
    assert any(item["title"] == "Resource blocked" for item in client.get(
        "/api/alerts", headers=headers
    ).json())

    dismissed = client.post(
        "/api/demo-controls/dismiss-flag",
        headers=headers,
        json={"reason": "Staff reviewed the demo flag."},
    )
    assert dismissed.status_code == 200
    dismissed_alert = client.get("/api/alerts", headers=headers).json()
    assert len(dismissed_alert) == len(flags)
    refreshed_selected = next(
        patient
        for patient in client.get("/api/patients", headers=headers).json()
        if patient["id"] == selected["id"]
    )
    assert refreshed_selected["acuity"] == acuity_before

    late_update = client.post("/api/demo-controls/late-update", headers=headers)
    assert late_update.status_code == 201
    queue = client.get("/api/patients", headers=headers).json()
    assert queue[0]["id"] != late_update.json()["id"]
    assert any(item["id"] == late_update.json()["id"] for item in queue)
    assert (datetime.now(timezone.utc) - datetime.fromisoformat(
        late_update.json()["created_at"].replace("Z", "+00:00")
    )).total_seconds() >= 44 * 60


def test_login_rejects_invalid_password():
    response = client.post(
        "/api/auth/login",
        json={"email": "demo@northstar.example", "password": "incorrect"},
    )
    assert response.status_code == 401


def test_demo_username_signs_in():
    response = client.post(
        "/api/auth/login",
        json={"email": "gayathri", "password": "PulseCare-Demo-Only"},
    )
    assert response.status_code == 200
    assert response.json()["user"]["email"] == "demo@northstar.example"


def test_authentication_and_patient_registration():
    access_token = token()
    headers = auth(access_token)
    assert client.get("/api/auth/me", headers=headers).json()["role"] == "physician"
    assert client.get("/api/patients").status_code == 401

    created = client.post(
        "/api/patients",
        headers=headers,
        json={
            "name": "Casey Sample",
            "age": 36,
            "reason": "Fictional demo concern",
            "acuity": "Critical",
            "notes": "Initial staff handover",
        },
    )
    assert created.status_code == 201
    patient = created.json()
    assert patient["external_id"].startswith("PT-")
    assert patient["status"] == "Waiting"
    assert patient["acuity"] == "Critical"
    assert patient["created_at"].endswith(("Z", "+00:00"))
    assert patient["updated_at"].endswith(("Z", "+00:00"))

    history = client.get(
        f"/api/patients/{patient['id']}/observations",
        headers=headers,
    )
    assert history.status_code == 200
    assert history.json()[0]["notes"] == "Initial staff handover"

    updated = client.patch(
        f"/api/patients/{patient['id']}",
        headers=headers,
        json={"acuity": "Urgent", "status": "In treatment", "area": "Treatment bay 1"},
    )
    assert updated.status_code == 200
    assert updated.json()["acuity"] == "Urgent"
    assert updated.json()["status"] == "In treatment"
    assert updated.json()["area"] == "Treatment bay 1"

    analytics = client.get("/api/analytics", headers=headers).json()
    assert analytics["patients_in_queue"] == 1
    assert analytics["status_counts"]["In treatment"] == 1
    assert analytics["acuity_mix"]["Urgent"] == 1


def test_observations_create_alert_and_reassessment():
    access_token = token()
    headers = auth(access_token)
    patient = client.post(
        "/api/patients",
        headers=headers,
        json={"name": "Taylor Sample", "age": 45, "reason": "Demo visit"},
    ).json()

    observation = client.post(
        f"/api/patients/{patient['id']}/observations",
        headers=headers,
        json={
            "heart_rate": 88,
            "respiratory_rate": 18,
            "systolic_bp": 120,
            "diastolic_bp": 80,
            "spo2": 98,
            "airway": "Clear",
            "breathing": "Clear",
            "circulation": "Not assessed",
            "disability": "Clear",
            "exposure": "Not assessed",
            "notes": "Fictional observation",
        },
    )
    assert observation.status_code == 201
    assert observation.json()["systolic_bp"] == 120
    assert observation.json()["diastolic_bp"] == 80
    assert observation.json()["spo2"] == 98
    assert observation.json()["airway"] == "Clear"
    incomplete_blood_pressure = client.post(
        f"/api/patients/{patient['id']}/observations",
        headers=headers,
        json={"systolic_bp": 120},
    )
    assert incomplete_blood_pressure.status_code == 422
    empty_observation = client.post(
        f"/api/patients/{patient['id']}/observations",
        headers=headers,
        json={},
    )
    assert empty_observation.status_code == 422
    alerts = client.get("/api/alerts", headers=headers)
    assert alerts.status_code == 200
    assert any(alert["patient_id"] == patient["id"] for alert in alerts.json())

    reassessment = client.post(
        f"/api/patients/{patient['id']}/reassessment",
        headers=headers,
    )
    assert reassessment.status_code == 201
    refreshed = client.get("/api/patients", headers=headers).json()
    assert refreshed[0]["status"] == "Reassessment"

    alert_id = alerts.json()[0]["id"]
    resolved = client.post(f"/api/alerts/{alert_id}/resolve", headers=headers)
    assert resolved.status_code == 200


def test_resource_capacity_and_role_permissions():
    physician_headers = auth(token())
    updated = client.patch(
        "/api/resources/1",
        headers=physician_headers,
        json={"used": 8},
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "Limited"

    too_many = client.patch(
        "/api/resources/1",
        headers=physician_headers,
        json={"used": 11},
    )
    assert too_many.status_code == 422

    nurse_headers = auth(token("nurse@northstar.example", "Nurse-Demo-Only"))
    forbidden = client.patch(
        "/api/resources/1",
        headers=nurse_headers,
        json={"used": 5},
    )
    assert forbidden.status_code == 403


def test_resource_limit_blocks_patient_need_and_logs_actions():
    headers = auth(token())
    patient = client.post(
        "/api/patients",
        headers=headers,
        json={"name": "Resource Sample", "age": 31, "reason": "Fictional demo"},
    ).json()
    resources = client.get("/api/resources", headers=headers).json()
    defibrillator = next(item for item in resources if item["name"] == "Defibrillator")
    assert defibrillator["total"] == 4
    assert defibrillator["used"] == 1

    over_capacity = client.patch(
        f"/api/resources/{defibrillator['id']}",
        headers=headers,
        json={"used": 5},
    )
    assert over_capacity.status_code == 422

    offline = client.patch(
        f"/api/resources/{defibrillator['id']}",
        headers=headers,
        json={"used": 1, "status": "Offline"},
    )
    assert offline.status_code == 200
    need = client.post(
        f"/api/resources/{defibrillator['id']}/needs",
        headers=headers,
        json={"patient_id": patient["id"]},
    )
    assert need.status_code == 201
    assert need.json()["status"] == "Blocked"
    assert need.json()["blocked_reason"] == "Resource is offline."

    operational = client.patch(
        f"/api/resources/{defibrillator['id']}",
        headers=headers,
        json={"used": 1, "status": "Operational"},
    )
    assert operational.status_code == 200
    refreshed_need = client.get("/api/resource-needs", headers=headers).json()[0]
    assert refreshed_need["status"] == "Needed"
    for _ in range(2):
        used = client.patch(
            f"/api/resource-needs/{need.json()['id']}",
            headers=headers,
            json={"status": "Used"},
        )
        assert used.status_code == 200
    refreshed_resource = next(
        item for item in client.get("/api/resources", headers=headers).json()
        if item["id"] == defibrillator["id"]
    )
    assert refreshed_resource["used"] == 2
    admin_headers = auth(token("admin@northstar.example", "Admin-Demo-Only"))
    assert "resource.needed" in [
        row["action"] for row in client.get("/api/audit", headers=admin_headers).json()
    ]


def test_referral_status_flow_does_not_change_triage():
    headers = auth(token())
    patient = client.post(
        "/api/patients",
        headers=headers,
        json={
            "name": "Referral Sample",
            "age": 54,
            "reason": "Fictional referral",
            "acuity": "Urgent",
        },
    ).json()
    created = client.post(
        f"/api/patients/{patient['id']}/referrals",
        headers=headers,
        json={
            "department": "Cardiology",
            "urgency": "Urgent",
            "reason": "Fictional specialist review",
        },
    )
    assert created.status_code == 201
    referral_id = created.json()["id"]
    accepted = client.patch(
        f"/api/referrals/{referral_id}",
        headers=headers,
        json={"status": "Accepted"},
    )
    assert accepted.status_code == 200
    completed = client.patch(
        f"/api/referrals/{referral_id}",
        headers=headers,
        json={"status": "Completed"},
    )
    assert completed.status_code == 200
    refreshed_patient = client.get("/api/patients", headers=headers).json()[0]
    assert refreshed_patient["acuity"] == "Urgent"
    admin_headers = auth(token("admin@northstar.example", "Admin-Demo-Only"))
    assert any(
        item["action"] == "referral.completed"
        for item in client.get("/api/audit", headers=admin_headers).json()
    )


def test_final_report_csv_escapes_patient_name_and_has_utf8_bom():
    headers = auth(token())
    patient = client.post(
        "/api/patients",
        headers=headers,
        json={
            "name": 'Casey, "Sample"',
            "age": 38,
            "reason": "Fictional CSV test",
            "acuity": "Standard",
        },
    ).json()
    discharge = client.patch(
        f"/api/patients/{patient['id']}",
        headers=headers,
        json={"status": "Discharged", "outcome": "Demo outcome", "advice": "Demo advice"},
    )
    assert discharge.status_code == 200
    response = client.get(
        f"/api/patients/{patient['id']}/final-report.csv",
        headers=headers,
    )
    assert response.status_code == 200
    assert response.content.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert ("name", 'Casey, "Sample"') in [tuple(row) for row in rows]


def test_sms_requires_explicit_consent():
    headers = auth(token())
    patient = client.post(
        "/api/patients",
        headers=headers,
        json={"name": "SMS Sample", "age": 40, "reason": "Fictional demo"},
    ).json()
    client.patch(
        f"/api/patients/{patient['id']}",
        headers=headers,
        json={"status": "Discharged"},
    )
    response = client.post(
        f"/api/patients/{patient['id']}/sms",
        headers=headers,
        json={
            "phone": "+14155550123",
            "message": "Your hospital visit has ended. Please contact the hospital if you need assistance.",
            "consent": False,
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "Recorded SMS consent is required"


def test_gps_stale_detection_and_recent_location_trail():
    now = datetime.now(timezone.utc)
    assert gps_is_stale(None, now)
    assert gps_is_stale(now - timedelta(seconds=31), now)
    assert not gps_is_stale(now - timedelta(seconds=30), now)

    headers = auth(token())
    for index in range(51):
        response = client.post(
            "/api/ambulances/AMB-01/location",
            headers=headers,
            json={
                "lat": 13.04 + index / 100000,
                "lng": 80.23,
                "speed": 32,
                "heading": 90,
            },
        )
        assert response.status_code == 201
    location = client.get(
        "/api/ambulances/AMB-01/location",
        headers=headers,
    )
    assert location.status_code == 200
    assert len(location.json()["trail"]) == 50
    assert location.json()["lat"] == pytest.approx(13.0405)
    dashboard = client.get(
        "/api/ambulances?include_trail=false",
        headers=headers,
    )
    assert dashboard.status_code == 200
    tracked = next(
        item for item in dashboard.json()["ambulances"]
        if item["code"] == "AMB-01"
    )
    assert tracked["lat"] == pytest.approx(13.0405)
    assert tracked["trail"] == []
