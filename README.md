# PulseCare

PulseCare is a fictional emergency-operations workflow prototype. It includes a Next.js staff interface, a FastAPI service, and persistent SQLite or PostgreSQL storage. It is not clinically validated, is not a medical device, and must not be used to make or replace clinical decisions.

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

The local-only fictional demo account is `demo@northstar.example` / `PulseCare-Demo-Only`. Staff accounts are provisioned by an administrator; public self-registration is intentionally disabled. Replace demo credentials and secrets before any non-local deployment.

## User workflows

- Sign in and restore an authenticated session for the browser tab.
- View the saved patient queue, filter/search it, update staff-assigned acuity and workflow status, or request a reassessment.
- Register a fictional patient and optional initial handover note.
- Select a patient, add observations, and view the saved observation history.
- Review and resolve open workflow alerts.
- View resource utilization; physicians and administrators can update capacity, with server-side validation against each resource's total.
- View queue counts and acuity mix calculated from persisted records.

All workflows require the API. If it is unavailable, the interface shows an error rather than reporting unsaved demo changes as successful.

## Backend configuration

The API defaults to a local SQLite database. For PostgreSQL, set `DATABASE_URL` to a SQLAlchemy URL such as `postgresql+psycopg://user:password@host:5432/pulsecare`, set `JWT_SECRET` to a random value of at least 32 characters, and set `FRONTEND_ORIGIN` to the exact frontend origin (or a comma-separated allowlist of origins). Example variables are in `backend/.env.example`; the application does not automatically load `.env` files, so configure them in the process environment or hosting platform.

The local Compose credentials and demo account are for development only. Do not expose `DATABASE_URL` or `JWT_SECRET` through `NEXT_PUBLIC_*` variables.

## Tests and production build

From the project root:

```powershell
cd backend
python -m pytest -q
cd ..
pnpm build
```

The backend tests use a disposable local SQLite test database. The frontend build enforces TypeScript checks.

## Deployment notes

### Render public demo

This repository includes a `render.yaml` Blueprint for a public demo: a Next.js web service, a FastAPI service, and PostgreSQL. To deploy it, sign in to Render using GitHub, create a **New Blueprint Instance**, select this public GitHub repository, review the three free services, and apply the Blueprint. Render generates the API JWT secret and wires the database and frontend/backend origins together. Wait for both web services to finish deploying; then open the `pulsecare-triage-web` service URL. Verify `/health` on the API service and sign in with the local fictional demo account above.

The Blueprint intentionally seeds only fictional demo records so the public sign-in works. Anyone with the demo credentials can change this demo database; never use real patient information. Free web services can sleep when idle, and Render's free PostgreSQL plan has limited retention/expiry; back up the database or select a paid persistent database plan before relying on it. Free services are for demonstration and do not have production availability guarantees.

For an independently managed deployment, set `ENVIRONMENT=production`, the backend's `DATABASE_URL` to PostgreSQL, a unique `JWT_SECRET` (at least 32 characters), and the exact frontend origin in the hosting environment. Startup refuses production mode without these settings. Use HTTPS, rotate any demo credentials, and complete security, privacy, accessibility, and clinical/regulatory review before any real-world use.
