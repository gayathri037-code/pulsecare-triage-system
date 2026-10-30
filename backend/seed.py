from database import SessionLocal
from main import seed_demo_data


with SessionLocal() as db:
    seed_demo_data(db)

print("Fictional PulseCare demo records are ready.")
