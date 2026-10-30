# THE NEW 2026

THE NEW 2026 (PulseCare) is a fictional emergency-operations workflow prototype. It includes a Next.js staff interface, a FastAPI service, and persistent SQLite or PostgreSQL storage. It is not clinically validated, is not a medical device, and must not be used to make or replace clinical decisions.

## Run the complete local demo

### Option A: Docker Compose

From the project root:

```powershell
docker compose up --build
```

Open `http://localhost:3000`. The frontend, API, and PostgreSQL database run together. The API seeds fictional local-demo records on first startup. Swagger is available at `http://localhost:8000/docs`.

Stop the stack with `Ctrl+C`; use `docker compose down` to stop and remove its containers. The PostgreSQL volume is retained unless explicitly removed.

### Option B: Run services separately

Start the API in one PowerShell window:

```powershell
cd backend
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python seed.py
python -m uvicorn main:app --reload --port 8000
```

Start the frontend in another PowerShell window:

```powershell
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3000`. The default local API URL is `http://localhost:8000`. For a different API host, set `NEXT_PUBLIC_API_BASE_URL` before building the frontend.

The local-only fictional demo account is `demo@northstar.example` / `PulseCare-Demo-Only`. First API startup idempotently adds eight fictional patients, the operational resources, and three review alerts without overwriting existing records. Staff accounts are provisioned by an administrator; public self-registration is intentionally disabled. Replace demo credentials and secrets before any non-local deployment.

## User workflows

- Sign in and restore an authenticated session for the browser tab.
- View the saved patient queue, filter/search it, update staff-assigned acuity and workflow status, or request a reassessment.
- Register a fictional patient with a staff-selected immediate (red), delayed (yellow), or standard (green) category and optional initial handover note.
- Record a structured ABCDE assessment, blood pressure, SpO₂, heart rate, respiratory rate, and notes in the saved observation history.
- Use the AI Assist workspace as an interactive, offline chart Q&A helper for saved summaries, observations, ABCDE findings, staff-marked concerns, and missing chart fields. It uses fixed local rules, is not connected to a language model, and does not send questions or patient context to an AI provider.
- Review and resolve open workflow alerts.
- Use the Overview **Demo controls** to add a fictional worsened-vitals "Look again" flag, take the X-ray scanner offline and flag a blocked patient request, dismiss the newest flag with a recorded reason without changing acuity, or inject a late fictional arrival and refresh the queue.
- View the seeded Defibrillator (4/1), BP monitor (10/6), X-ray (2/1), Stretchers (15/11), and Wheelchairs (12/5) capacity. Utilization at or above 75% is Limited; full/offline resources block patient requests with a plain-language reason. Physicians and administrators can update capacity; server-side validation prevents exceeding totals.
- Record patient resource needs and mark them used; usage is capacity-checked and audited.
- Track the three fictional Chennai ambulances on the Ambulances page. OpenStreetMap provides map tiles, OSRM is tried for driving routes, and a straight-line route is used when OSRM is unavailable. The demo simulator sends a GPS ping every three seconds. Start it to see moving vehicles, trails, ETAs, and inbound dashboard notices.
- Ambulance tracking loads on demand; ordinary dashboard refreshes fetch current GPS status without the trail history, while the tracking page retrieves the latest 50 points.
- Use `/driver/AMB-01` (or `AMB-02` / `AMB-03`) on a signed-in device to share browser geolocation. Sharing requires permission and HTTPS or localhost; when enabled, the device sends its actual coordinates every three seconds. Use the simulator instead when you need fictional-only demo data. GPS pings become stale after 30 seconds and all received pings are audited.
- Request referrals for Cardiology, Orthopaedics, Neurology, Surgery, Paediatrics, Radiology, or ICU and track Requested, Accepted, Completed, or Declined. Referrals never change triage acuity.
- Discharge a patient with an outcome and advice to generate a final report with triage history, wait time, referral history, and resources used. Download an escaped UTF-8-BOM CSV.
- Send a generic, non-diagnostic discharge SMS only with an E.164 international phone number and explicit consent. Without Twilio configuration, the message is recorded in the SMS outbox. Real delivery requires all three server-side variables `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`; no keys are included in source or sent to the frontend.
- View queue counts and acuity mix calculated from persisted records.

All workflows require the API. If it is unavailable, the interface shows an error rather than reporting unsaved demo changes as successful.

The map uses public OpenStreetMap and OSRM services and does not require a paid map key. The demo ambulance simulator and all seeded records are fictional; browser GPS is real device-location data only when a user explicitly starts sharing it.

The ABCDE and AI Assist workspaces are workflow prototypes only. AI Assist responds to common chart questions using deterministic local rules; it does not use a language model, understand arbitrary prompts, or provide an AI-generated clinical assessment. It must not be used for diagnosis, treatment, triage decisions, or patient care.

## Backend configuration

The API defaults to a local SQLite database. For PostgreSQL, set `DATABASE_URL` to a SQLAlchemy URL such as `postgresql+psycopg://user:password@host:5432/pulsecare`, set `JWT_SECRET` to a random value of at least 32 characters, and set `FRONTEND_ORIGIN` to the exact frontend origin (or a comma-separated allowlist of origins). Example variables are in `backend/.env.example`; the application does not automatically load `.env` files, so configure them in the process environment or hosting platform.

The local Compose credentials and demo account are for development only. Do not expose `DATABASE_URL` or `JWT_SECRET` through `NEXT_PUBLIC_*` variables.

## Tests and production build

From the project root:

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q
cd ..
corepack pnpm build
```

The backend tests use a disposable local SQLite test database. The frontend build enforces TypeScript checks.

## Deployment notes

### Render public demo

This repository includes a `render.yaml` Blueprint for a public demo: a Next.js web service, a FastAPI service, and PostgreSQL. To deploy it, sign in to Render using GitHub, create a **New Blueprint Instance**, select this public GitHub repository, review the three free services, and apply the Blueprint. Render generates the API JWT secret and wires the database and frontend/backend origins together. Wait for both web services to finish deploying; then open the `pulsecare-triage-web` service URL. Verify `/health` on the API service and sign in with the local fictional demo account above.

The Blueprint intentionally seeds only fictional demo records so the public sign-in works. Anyone with the demo credentials can change this demo database; never use real patient information. Free web services can sleep when idle, and Render's free PostgreSQL plan has limited retention/expiry; back up the database or select a paid persistent database plan before relying on it. Free services are for demonstration and do not have production availability guarantees.

For an independently managed deployment, set `ENVIRONMENT=production`, the backend's `DATABASE_URL` to PostgreSQL, a unique `JWT_SECRET` (at least 32 characters), and the exact frontend origin in the hosting environment. Startup refuses production mode without these settings. Use HTTPS, rotate any demo credentials, and complete security, privacy, accessibility, and clinical/regulatory review before any real-world use.
