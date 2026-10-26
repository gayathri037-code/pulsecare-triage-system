import os

os.environ["DATABASE_URL"] = "sqlite:///./test_pulsecare.db"

import pytest
from fastapi.testclient import TestClient

from database import Base, SessionLocal, engine
from main import app, passwords
from models import Resource, User

client = TestClient(app)


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
            Resource(name="Treatment bays", total=10, used=4),
        ]
    )
    db.commit()
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


def test_login_rejects_invalid_password():
    response = client.post(
        "/api/auth/login",
        json={"email": "demo@northstar.example", "password": "incorrect"},
    )
    assert response.status_code == 401


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
            "notes": "Initial staff handover",
        },
    )
    assert created.status_code == 201
    patient = created.json()
    assert patient["external_id"].startswith("PT-")
    assert patient["status"] == "Waiting"
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
        json={"heart_rate": 88, "respiratory_rate": 18, "notes": "Fictional observation"},
    )
    assert observation.status_code == 201
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
