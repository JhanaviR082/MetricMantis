# MetricMantis — Node API & Sample Stack

This directory contains the backend services and sandbox environments:

1. **The Node/Express API** (`index.js`) — handles user authentication, compose YAML parsing, live Docker chaos controls, container logs, and the Gemini-backed Resilience Advisor.
2. **The Sandboxes & Measured Experiments Engine** (`sandboxes/`, `experiments/`) — manages isolated, server-owned Compose sandboxes (`web-app`, `api`, `db`), in-network HTTP probing via a measurer container, and real fault injection (stop, restart, CPU throttling, memory pressure, and netem latency/packet loss).
3. **The sample Docker stack** (`docker-compose.yml`) — an Nginx + Node.js + PostgreSQL system you can break with chaos experiments.

A Spring Boot YAML parser also lives here (`src/main/java/`) and runs independently on port 8080.

---

## Prerequisites

- Node.js 20+ and npm
- Docker and Docker Compose (for sandboxes, sample stack, measurer container, and netem sidecars)
- Java 17 + Maven (Spring Boot parser only)
- A [Gemini API key](https://aistudio.google.com/apikey) (Resilience Advisor only)

---

## Run the Node API

```bash
npm install
cp .env.example .env
```

Open `.env` and set these values:

```
SESSION_SECRET=replace-with-a-long-random-string
FRONTEND_URL=http://localhost:3000
GEMINI_API_KEY=your-key-here        # optional — only needed for the Advisor
```

The server exits immediately on startup if `SESSION_SECRET` is missing.

### Normal mode (chaos disabled)

```bash
npm start
```

Listens on **http://localhost:3001**. Real container faults stay disabled. The SQLite database (`data/metricmantis.db`) is created automatically on first run — no separate database server needed.

### Chaos mode (measured experiments enabled)

```bash
npm run dev:chaos
```

Starts the API with `METRICMANTIS_CHAOS_ENABLED=true` and allowlists `web-app,api,db`. If port 3001 is held by this project's normal API, that process is replaced cleanly.

### One-time measurer build

Before running measured experiments that probe sandbox services, build the measurer image once:

```bash
docker compose -f sandboxes/approved-sample-compose.yml --profile measure build measurer
```

The netem sidecar image (`metricmantis-sandbox-netem:approved`) builds automatically the first time a latency or packet-loss experiment runs.

---

## Authentication

Accounts use username + email + password. Passwords are hashed with bcrypt; only the hash is stored.

Login returns an `HttpOnly` session cookie (`metricmantis.sid`). The cookie is `SameSite=None; Secure` so the browser on port 3000 can send it to the API on port 3001 — browsers accept Secure cookies over HTTP on localhost.

Session state is in memory. Restarting the API clears sessions and asks users to log in again. User accounts, sandbox records, and experiment history persist in SQLite across restarts.

| Method | Path | Auth required | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/signup` | No | Create an account (does not log in automatically). |
| `POST` | `/auth/login` | No | Start a session, return user object. |
| `POST` | `/auth/logout` | No | Destroy the session. |
| `GET` | `/auth/me` | No | Return current user or `{ "authenticated": false }`. |

---

## HTTP API

All routes below require a valid session cookie. Without it they return HTTP 401.

### Compose Analysis & Simulation

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/upload` | Multipart field `file`. Parses `services` and `depends_on` into nodes and edges. |
| `GET` | `/graph` | Returns the last parsed graph. |
| `POST` | `/chaos/stop/:service` | Older direct `docker stop <service>` and marks node failed. |
| `POST` | `/chaos/restart/:service` | Older direct `docker start <service>` and marks node running. |
| `GET` | `/logs/:service` | Returns `docker logs` for that container. |
| `GET` | `/report` | Lists services currently marked failed and generic resilience recommendations. |

`:service` must match a running container name. In the sample stack those are `db`, `api`, and `web-app`.

### Resilience Advisor

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/advisor/summary` | Body `{ report }`. Returns a 3–5 sentence plain-language summary and four suggested follow-up questions. |
| `POST` | `/api/advisor/chat` | Body `{ report, history, question }`. Answers strictly from the report — no invented data. |

### Sandboxes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/sandboxes` | Body `{ composeYaml, fileName }`. Creates a sandbox record; does not start containers. |
| `GET` | `/sandboxes/active` | Returns this user's active sandbox. |
| `GET` | `/sandboxes/:id` | Returns metadata for one sandbox (never includes raw `composeYaml`). |
| `POST` | `/sandboxes/:id/start` | Starts the approved sample compose sandbox (`web-app`, `api`, `db`). |
| `GET` | `/sandboxes/:id/runtime` | Live Docker status and container IDs for that project. |
| `POST` | `/sandboxes/:id/cleanup` | Removes sandbox containers (`docker compose down --remove-orphans`). |

### Measured Experiments

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/experiments/capabilities` | Checks Docker availability, enabled fault modes, and probe allowlist. |
| `GET` | `/experiments` | List recent experiment runs for this user (up to 20; query `limit`). |
| `POST` | `/experiments` | Start a measured experiment run. Returns HTTP 202 with status `RUNNING`. |
| `GET` | `/experiments/:id` | Poll experiment status, live phase progress, metrics, and verdict. |
| `POST` | `/experiments/:id/cancel` | Abort an active experiment run. |

---

## Measured Experiments

Measured experiments execute controlled chaos against a running, server-owned sandbox (`sandboxes/approved-sample-compose.yml`) containing `web-app`, `api`, and `db`.

- Sandbox project names follow `mm` plus 16 hex characters. No host ports are exposed.
- HTTP probes are invoked inside the sandbox network by a dedicated measurer container:
  - `web-app` probe: `http://web-app/health`
  - `api` probe: `http://api:8080/health`
  - `db`: fault target only; has no HTTP health probe.
- Runs execute across three time windows: **baseline**, **fault**, and **recovery**.

### Supported fault types

| Fault Type | Action | Verification |
| --- | --- | --- |
| `measure` | Probe baseline only; no fault window | Validates health and baseline latency/throughput without mutating containers. |
| `stop` | `docker stop` target container | Verified with `docker inspect` before and after; restored via `docker start` during cleanup. |
| `restart` | `docker restart` target container | Verified by checking that `State.StartedAt` is newer than before the restart. |
| `cpu` | `docker update --cpus 0.05` | Verified with `docker inspect` quota `5000` (or `50000000` NanoCPUs). Starts a bounded `dd` burn workload during the fault window. Restored to previous quota/unlimited. |
| `memory` | Creates 4, 8, or 12 MiB file in `/dev/shm` | Verified via file size check in `/dev/shm`. Rejected if target memory limit < 4× the pressure size. Cleared during cleanup. |
| `latency` | Injects 20–500 ms on `eth0` | Unprivileged `netem` sidecar container attached to target container network namespace. Verified with `tc qdisc show dev eth0`. Cleared on cleanup. |
| `packet_loss` | Injects 1–20% loss on `eth0` | Same `netem` sidecar. Delay and packet loss are mutually exclusive. Cleared on cleanup. |

### Verdicts and metrics

- **Verdicts**: `PASSED` (all assertions met), `FAILED` (threshold missed), `INCONCLUSIVE` (insufficient samples), `ERROR` (execution/Docker failure), or `CANCELLED`.
- **Latency Percentiles**: nearest rank. p50 is always computed, p95 requires ≥5 samples, and p99 requires ≥20 samples.
- **Unavailable Values**: missing samples remain `null` and are never recorded as zero.
- **Rate Limits**: 1 active run per user, maximum 8 runs in 10 minutes, latest 50 runs kept in history.

---

## Resilience Advisor

Powered by Google Gemini (`gemini-3.6-flash`). The advisor receives a slimmed-down version of the resilience report (scores, findings, bullets, and table facts) and refuses to invent services or metrics not present in it.

Requires `GEMINI_API_KEY` in `.env`. Without it the `/api/advisor/*` routes return HTTP 500 with a clear error message — the rest of the app still works.

---

## Run the sample Docker stack

```bash
docker compose up -d --build
docker ps
```

| Service | Container | Published port |
| --- | --- | --- |
| `web-app` | `web-app` | `8090` → 80 |
| `api` | `api` | internal only |
| `db` | `db` | `5433` → 5432 |

PostgreSQL credentials: database `chaosdb`, user `user`, password `password`. For local experiments only.

Inject a failure and observe:

```bash
docker stop db
docker logs api   # expect: DB connection failed: connect ECONNREFUSED
docker start db
```

Tear down:

```bash
docker compose down
```

---

## Run the Spring Boot parser

Parses YAML independently of the Node API. Flags missing `restart` and `mem_limit` fields.

```bash
mvn spring-boot:run
```

Listens on **http://localhost:8080**.

- `GET /` → `MetricMantis Running`
- `POST /upload` → multipart field `file`; returns services, `depends_on` lists, and warnings.

Example:

```bash
curl -F "file=@../../metricmantis-frontend/metricmantis-frontend/public/sample-docker-compose.yml" \
  http://localhost:8080/upload
```

---

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | **Yes** | Signs the session cookie. Server exits if missing. |
| `FRONTEND_URL` | No | CORS origin for cookie requests. Defaults to `http://localhost:3000`. |
| `GEMINI_API_KEY` | No | Enables the Resilience Advisor. App works without it. |
| `PORT` | No | Node API port. Defaults to `3001`. |
| `METRICMANTIS_PROBE_ALLOWLIST` | No | Hosts allowed for measured probing. Defaults to `127.0.0.1,localhost`. Ports 3000 and 3001 are always refused. |
| `METRICMANTIS_CHAOS_ENABLED` | No | Enables real Docker faults. Set to `true` by `npm run dev:chaos`. |
| `METRICMANTIS_CHAOS_ALLOWLIST` | No | Allowlisted services for faults. Set to `web-app,api,db` by `npm run dev:chaos`. |

Do not commit `.env`.

---

## Tests

Run the backend test suite:

```bash
npm test
```

---

## Project structure

```
demo/demo/
├── index.js                  Express API entry point (port 3001)
├── auth/
│   ├── authService.js        signup, login, bcrypt password handling
│   └── session.js            express-session + cookie config
├── database/
│   ├── database.js           SQLite init, schema creation
│   ├── experimentRepository.js experiment CRUD, progress, and history
│   ├── sandboxRepository.js  sandbox state and active project tracking
│   └── userRepository.js     user CRUD
├── experiments/
│   ├── assertions.js         threshold evaluation and verdicts
│   ├── cpuComparison.js      CPU stats, window metrics comparison
│   ├── dockerExecutor.js     Docker inspect, CPU limit, memory, netem sidecar
│   ├── experimentService.js  execution orchestrator, validation, phases
│   ├── faultLease.js         fault tracking and restart recovery
│   ├── metrics.js            error rate, throughput, p50/p95/p99 nearest rank
│   ├── probeTarget.js        URL parsing, security guards, allowlist
│   ├── sandboxProbe.js       measurer container probe execution
│   └── workload.js           HTTP probing rate and concurrency worker
├── middleware/
│   └── requireAuth.js        401 guard for protected routes
├── routes/
│   ├── authRoutes.js         /auth/* endpoints
│   ├── experimentRoutes.js   /experiments/* endpoints
│   └── sandboxRoutes.js      /sandboxes/* endpoints
├── sandboxes/
│   ├── approved-sample-compose.yml canonical 3-service sandbox stack
│   ├── sandboxRuntime.js     Docker project inspection, readiness, cleanup
│   ├── sandboxService.js     sandbox reservation, start, and removal
│   └── sample/               web, api, measurer, and netem Dockerfiles
├── scripts/
│   ├── apiListener.js        process management and port detection
│   └── startApi.js           normal vs chaos mode lifecycle launcher
├── uploads/                  temp files from multipart uploads (gitignored)
├── data/
│   └── metricmantis.db       SQLite database (auto-created, gitignored)
├── docker-compose.yml        sample Nginx + Node + PostgreSQL stack
├── Dockerfile                Node API image for the sample stack
├── pom.xml                   Spring Boot Maven config
└── src/main/java/            Spring Boot YAML parser (port 8080)
```
