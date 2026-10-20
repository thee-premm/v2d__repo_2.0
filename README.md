# Vote2Dine (V2D)

Intention-driven demand management for college and university messes. Students declare whether they will eat; voting locks at a cutoff; a transparent model forecasts attendance (including students who didn't vote); a supervisor approves a preparation target that becomes recipe-based ingredient quantities; the counter records who actually ate; reconciliation handles no-shows fairly with appeals; and Analyze reports waste, accuracy and impact from recorded data — labelling every estimate and never reporting missing data as zero.

```
Declare → Lock → Forecast → Approve → Prepare → Verify → Reconcile → Learn
```

Four workspaces share one API and one database: **Student**, **Mess supervisor**, **Kitchen**, **Institution admin**.

## Repository layout

```
v2d_Backend/     Node 20+ / Express 5 / PostgreSQL API (modular monolith), migrations, tests
v2d_Frontend/    React 19 + Vite + TypeScript web app, design system, Vitest + browser smoke test
docs/            Architecture, API, permissions, data model, analytics, design, testing, deployment
```

## Prerequisites

- Node.js 20.11 or newer (developed on 24)
- PostgreSQL 13 or newer (developed on 17), with a role that can create databases for local setup
- No Redis or other services are required

## Quick start (local)

```bash
# 1. Install
npm --prefix v2d_Backend install
npm --prefix v2d_Frontend install

# 2. Configure the API
cp v2d_Backend/.env.example v2d_Backend/.env
#    edit DB_* (or DATABASE_URL) and set APP_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 3. Create the database and apply migrations
npm --prefix v2d_Backend run db:setup

# 4. (Optional) load the clearly-labelled demo institution
npm --prefix v2d_Backend run db:seed:demo

# 5. Run — two terminals
npm --prefix v2d_Backend run dev     # API on http://localhost:5000 (+ scheduler)
npm --prefix v2d_Frontend run dev    # web on http://localhost:5173 (proxies /api)
```

Open http://localhost:5173. With the demo seed, sign in with password `vote2dine-demo` as `demo.student`, `demo.supervisor`, `demo.kitchen` or `demo.admin`. The demo institution is flagged and every screen shows a "simulated sample data" banner; never seed it into a production database (the script refuses when `NODE_ENV=production`).

### Production-style run (single origin)

```bash
npm --prefix v2d_Frontend run build        # outputs v2d_Frontend/dist
NODE_ENV=production npm --prefix v2d_Backend start   # serves the API and the built app
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for required settings, proxying and backups.

## Tests

```bash
npm --prefix v2d_Backend test        # 85 API/integration/unit tests against a *_test database
npm --prefix v2d_Frontend test       # Vitest component tests
npm --prefix v2d_Frontend run typecheck
# Browser smoke test (needs the API running with demo data and a local Chrome/Edge):
npm --prefix v2d_Frontend run e2e:screens
```

The backend suite creates and migrates `v2d_test` (override with `TEST_DB_NAME`, which must end in `_test`) and refuses to touch any other database. Details in [docs/TESTING.md](docs/TESTING.md).

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, request flow, lifecycle, scheduler, key decisions |
| [docs/API.md](docs/API.md) | Endpoint reference and error contract |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | Role and scope matrix |
| [docs/DATABASE.md](docs/DATABASE.md) | Data model, invariants, migrations |
| [docs/ANALYTICS.md](docs/ANALYTICS.md) | Forecasting method and every metric definition |
| [docs/DESIGN.md](docs/DESIGN.md) | Design system and accessibility |
| [docs/TESTING.md](docs/TESTING.md) | How to run and extend tests |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production configuration and operations |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Implementation log, limitations, open decisions |
| [docs/AUDIT.md](docs/AUDIT.md) | Audit of the original repository |
