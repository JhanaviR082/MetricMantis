# MetricMantis

MetricMantis is a chaos-engineering workspace for Docker Compose systems. Upload a compose file, map how services depend on each other, simulate cascading failures, execute measured chaos experiments against container sandboxes, and read a resilience report that calls out single points of failure, missing health checks, and recovery gaps.

The browser app handles YAML analysis, dependency graphing, blast-radius simulation, report assembly, PDF export, and observability. A Node API handles user authentication, sandbox lifecycle management, measured chaos experiment execution (Docker and netem faults), container logs, and a Gemini-backed Resilience Advisor. A Spring Boot service offers a second YAML parser that flags missing restart policies and memory limits. Authentication is not part of the Spring Boot service.

## What you can do

1. **Upload** a `docker-compose.yml` or `.yaml`.
2. **Analyze** services, images, ports, `depends_on`, health checks, restart policies, volumes, and environment keys.
3. **Map** the dependency graph with Dagre layout. Node color tracks healthy (green), degraded (amber), and down (red).
4. **Simulate chaos** by stopping a service. Dependents degrade along the graph with calculated blast-radius and risk levels. Restart restores the stack.
5. **Run measured experiments** on an isolated, server-owned container sandbox (`web-app`, `api`, `db`):
   - Probe endpoints inside the sandbox network via a dedicated measurer container.
   - Inject verified faults: `measure` (probe only), `stop`, `restart`, `cpu` throttling (with bounded workload), `memory` pressure, `latency` injection, and `packet_loss`.
   - Monitor real-time progress, error rates, throughput, and latency percentiles (p50, p95, p99) in the Observability Dashboard.
6. **Read the report and export PDF**, which scores dependency safety, fault tolerance, recovery, and monitoring, displays measured experiment evidence and verdicts, and lists findings such as:
   - single points of failure (a service with two or more dependents)
   - databases with no replication or volume
   - missing health checks or restart policies
   - secrets stored in the `environment` block
7. **Ask the Resilience Advisor** to summarize the report in plain language and answer follow-up questions. The advisor strictly uses the report you just generated and never invents metrics.

A sample file ships with the frontend: `metricmantis-frontend/metricmantis-frontend/public/sample-docker-compose.yml`.

## UI 

**Dark / light mode** toggle switches between a dark charcoal theme and a warm off-white theme. 

## Architecture

```text
┌─────────────────────────────────────────────┐
│  Next.js UI  (port 3000)                    │
│  login · parse compose · graph · simulation │
│  sandboxes · measured chaos · dashboard     │
│  resilience report · PDF · advisor chat     │
└───────────────┬─────────────────────────────┘
                │  session cookie
                ▼
┌─────────────────────────────────────────────┐
│  Node API  (port 3001)                      │
│  auth · YAML upload · sandbox manager       │
│  measured experiments executor · netem/dd   │
│  Gemini Resilience Advisor                  │
└───────────────┬─────────────┬───────────────┘
                │             │
                ▼             ▼
┌──────────────────────────┐ ┌──────────────────────────┐
│  SQLite                  │ │  Docker Sandbox          │
│  demo/demo/data/         │ │  web-app · api · db      │
│  metricmantis.db         │ │  measurer container      │
│  users, sandboxes, runs  │ │  netem sidecar (tc rule) │
└──────────────────────────┘ └──────────────────────────┘

The sample Docker stack (nginx, Node API, PostgreSQL) is a system you can break.
Spring Boot on port 8080 is a separate YAML parser and does not handle login.
```

Graph layout, cascade simulation, and the written report run in the browser. Signing in, the advisor, sandboxes, live Docker commands, and measured experiments need the Node API.

## Repository layout

```text
.
├── metricmantis-frontend/metricmantis-frontend/   Next.js app
│   ├── src/app/                  pages and global styles
│   ├── src/components/           upload, graph, chaos, report, guide, advisor, sandbox & dashboard
│   ├── src/context/              auth state, system context, theme state
│   ├── src/components/auth/      login and signup screens
│   ├── src/lib/                  compose parser, graph layout, report builder, PDF exporter, API client
│   └── public/sample-docker-compose.yml
├── demo/demo/                    backends, sandbox definitions, and the sample Docker stack
│   ├── index.js                  Express API (port 3001)
│   ├── auth/                     signup, login, sessions
│   ├── database/                 SQLite setup, user, sandbox & experiment repositories
│   ├── experiments/              measured experiment engine, probes, assertions, netem & cpu executors
│   ├── middleware/requireAuth.js authentication check for protected routes
│   ├── routes/                   auth, sandbox, and experiment routes
│   ├── sandboxes/                approved sample compose & runtime manager
│   ├── scripts/                  API lifecycle & process listener scripts
│   ├── data/metricmantis.db      created on startup (gitignored)
│   ├── src/main/java/...         Spring Boot YAML parser
│   ├── docker-compose.yml        nginx + Node API + PostgreSQL
│   ├── Dockerfile
│   └── pom.xml
├── docs/
│   └── EXPERIMENTS.md            measured experiment architecture, faults, and metrics guide
└── index.html                    earlier static prototype of the UI
```

## Tech stack

| Piece | Stack |
| --- | --- |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Graph | React Flow (`@xyflow/react`) and Dagre |
| Compose parsing | `js-yaml` in the browser; SnakeYAML in Spring Boot |
| PDF Export | `jspdf` |
| Node API | Express 5, express-session, bcryptjs, SQLite (`better-sqlite3`), Multer, `js-yaml`, Google Generative AI |
| Java API | Spring Boot 4, Java 17 |
| Sandbox & Chaos | Docker Compose, Netem sidecars (`iproute2`/`tc`), Measurer container (`pg`, curl) |
| Sample system | Docker Compose, Nginx, Node.js, PostgreSQL 15 |

## Prerequisites

- Node.js 20 or newer and npm
- Docker, if you want sandboxes, live `docker stop` / `docker start` / `docker logs`, or measured experiments
- Java 17 and Maven, only if you run the Spring Boot parser
- A [Gemini API key](https://aistudio.google.com/apikey), only if you use the Resilience Advisor

## Run the frontend

```bash
cd metricmantis-frontend/metricmantis-frontend
npm install
npm run dev
```

`npm run dev` uses webpack. Turbopack cannot resolve the Next.js package from this nested repository layout and crashes the dev server.

Copy the frontend environment example if you do not already have `.env.local`:

```bash
cp .env.local.example .env.local
```

`.env.local` should contain:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001
```

Open [http://localhost:3000](http://localhost:3000). The app checks the session first. Sign up, then log in. Upload, analyze, graph, chaos, report, and measured experiments then work as expected.

Run frontend tests:

```bash
npm test
```

Other scripts: `npm run build`, `npm start`, `npm run lint`, `npx tsc --noEmit`.

## Run the Node API

Authentication, the advisor, sandboxes, and chaos experiment endpoints live here.

```bash
cd demo/demo
npm install
cp .env.example .env
```

Edit `.env` and set `SESSION_SECRET` to a long random string. The process exits on startup if that variable is missing. Do not commit `.env`.

`npm install` followed by `npm start` is enough to create the SQLite database and tables. No separate database server and no manual SQL.

```bash
npm start
```

It listens on [http://localhost:3001](http://localhost:3001). Real chaos stays off. If that port is already this project's chaos-enabled API, `npm start` exits and leaves that process running.

For a local chaos-testing session, stop is not required first:

```bash
npm run dev:chaos
```

That starts the API with chaos enabled for the approved services `web-app`, `api`, and `db`. If port 3001 is held by this project's API and chaos is off, only that process is stopped and replaced. A listener that is not `node index.js` in `demo/demo` is left alone, and the command exits. Sign in again after the API process changes. The Chaos page reads `GET /experiments/capabilities` from `NEXT_PUBLIC_API_URL` and shows that response.

Before running measured experiments for the first time, build the measurer image once from `demo/demo`:

```bash
docker compose -f sandboxes/approved-sample-compose.yml --profile measure build measurer
```

(The `metricmantis-sandbox-netem:approved` image builds automatically the first time a latency or packet-loss experiment is launched.)

Run backend tests:

```bash
npm test
```

### Authentication

Accounts are username, email, and password. Passwords are hashed with bcrypt and only the hash is stored. Login creates an HttpOnly session cookie (`metricmantis.sid`). The cookie is `SameSite=None` and `Secure` so the browser on port 3000 can send it to the API on port 3001. Localhost accepts that Secure cookie over HTTP.

Refreshing the page calls `GET /auth/me` and restores the session. Logout destroys it. Signup does not log the user in.

The database file is `demo/demo/data/metricmantis.db`. It is created automatically and is gitignored. User accounts, sandboxes, and experiment records persist across restarts. The session itself is stored in memory, so restarting the API asks the user to log in again.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/signup` | public | Create an account. |
| `POST` | `/auth/login` | public | Start a session. |
| `POST` | `/auth/logout` | public | Destroy the session. |
| `GET` | `/auth/me` | public | Return the current user, or `{ "authenticated": false }`. |

### HTTP API

These routes require a logged-in session. Without the cookie they return HTTP 401.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/upload` | Multipart field `file`. Parses `services` and `depends_on` into nodes and edges. |
| `GET` | `/graph` | Last parsed graph. |
| `POST` | `/chaos/stop/:service` | Older direct `docker stop` by container name; marks node failed. |
| `POST` | `/chaos/restart/:service` | Older direct `docker start` by container name; marks node running. |
| `GET` | `/logs/:service` | Returns `docker logs` for that container. |
| `GET` | `/report` | Lists services currently marked failed, plus generic recommendations. |
| `POST` | `/api/advisor/summary` | JSON body `{ report }`. Returns a short summary and four suggested questions. |
| `POST` | `/api/advisor/chat` | JSON body `{ report, history, question }`. Answers from the report only. |
| `POST` | `/sandboxes` | JSON body `{ composeYaml, fileName }`. Creates a sandbox record (does not start containers). |
| `GET` | `/sandboxes/active` | Returns the signed-in user's active sandbox. |
| `GET` | `/sandboxes/:id` | Returns metadata for one sandbox (never exposes raw `composeYaml`). |
| `POST` | `/sandboxes/:id/start` | Starts the approved sample sandbox stack (`web-app`, `api`, `db`). |
| `GET` | `/sandboxes/:id/runtime` | Live Docker status and container IDs for that project. |
| `POST` | `/sandboxes/:id/cleanup` | Removes that sandbox stack (`docker compose down --remove-orphans`). |
| `GET` | `/experiments/capabilities` | Docker availability, enabled fault modes, and probe allowlist. |
| `GET` | `/experiments` | List recent experiment runs for this user (up to 20; query `limit`). |
| `POST` | `/experiments` | Start a measured experiment run. Returns HTTP 202 with initial status. |
| `GET` | `/experiments/:id` | Status, live metrics, and verdict for an experiment run. |
| `POST` | `/experiments/:id/cancel` | Abort an experiment run that is still active. |

`:service` must match a running container name. In the sample compose file those names are `db`, `api`, and `web-app`.

### Measured experiments

Measured experiments run against the server-owned sandbox (`sandboxes/approved-sample-compose.yml`). The uploaded compose file is parsed for structure and stored, while container execution is restricted to the verified sandbox stack: `web-app`, `api`, and `db`.

- Sandbox project names follow `mm` plus 16 hex characters. No host ports are published.
- Cleanups run `docker compose down --remove-orphans` without deleting volumes.
- Probes are executed from inside the sandbox network via a dedicated measurer container:
  - `web-app` probe: `http://web-app/health`
  - `api` probe: `http://api:8080/health`
  - `db`: no HTTP health probe; `db` can be a fault target but cannot be an HTTP probe target.
- Experiments run across three phases: **baseline**, **fault**, and **recovery**.
- Each experiment is evaluated against configured thresholds (e.g., max error rate, max p95 latency).

| Fault Type | Mechanism | Verification / Impact |
| --- | --- | --- |
| `measure` | HTTP probe only | No fault window and no container mutation. Records baseline metrics. |
| `stop` | `docker stop` | Verified with `docker inspect` (running → stopped). Restored via `docker start` in cleanup. |
| `restart` | `docker restart` | Verified with a newer `State.StartedAt` timestamp (not Docker's `RestartCount`). |
| `cpu` | `docker update --cpus 0.05` | Verified via inspect quota `5000` or `50000000` NanoCPUs. A bounded `dd` workload runs during the fault window. Restored to previous quota/unlimited. |
| `memory` | 4, 8, or 12 MiB file in `/dev/shm` | Verified via file size check in `/dev/shm`. Rejected if container memory limit is under 4× the pressure size. Cleaned up on completion. |
| `latency` | 20–500 ms on `eth0` | Applied via an unprivileged `netem` sidecar container attached to target container network namespace. Verified via `tc qdisc show`. Cleared on cleanup. |
| `packet_loss` | 1–20% packet loss on `eth0` | Applied via the same `netem` sidecar. Delay and packet loss are mutually exclusive. Cleared on cleanup. |

Verdicts are strictly computed from evidence: `PASSED`, `FAILED`, `INCONCLUSIVE`, `ERROR`, or `CANCELLED`.
- Percentiles use nearest rank: p50 is always available, p95 requires ≥5 samples, and p99 requires ≥20 samples.
- Missing values stay `null` (never stored or reported as zero).
- Users can run at most 1 active experiment at a time, with a rate limit of 8 runs per 10 minutes and history keeping the latest 50 runs.

## Run the Spring Boot parser

```bash
cd demo/demo
mvn spring-boot:run
```

The app listens on [http://localhost:8080](http://localhost:8080).

- `GET /` returns `MetricMantis Running`.
- `POST /upload` accepts a multipart field named `file` and returns each service, its `depends_on` list, and warnings when `restart` or `mem_limit` is missing.

Example:

```bash
curl -F "file=@metricmantis-frontend/metricmantis-frontend/public/sample-docker-compose.yml" \
  http://localhost:8080/upload
```

## Run the sample Docker stack

From `demo/demo`:

```bash
docker compose up -d --build
docker ps
```

| Service | Container | Published port |
| --- | --- | --- |
| `web-app` | `web-app` | `8090` → 80 |
| `api` | `api` | none (Express inside the container still binds 3001) |
| `db` | `db` | `5433` → 5432 |

PostgreSQL is created with database `chaosdb`, user `user`, and password `password`. Those values are for local experiments only.

Stop one container and read what the API logged:

```bash
docker stop db
docker logs api
docker start db
```

The same actions are exposed by `POST /chaos/stop/db` and `GET /logs/api` on the Node API when it is running on the host and can reach the Docker daemon.

Tear the stack down with:

```bash
docker compose down
```

## Environment

| Variable | Where | Used for |
| --- | --- | --- |
| `SESSION_SECRET` | `demo/demo/.env` | Signs the session cookie. Required. |
| `FRONTEND_URL` | `demo/demo/.env` | CORS origin allowed to send cookies. Defaults to `http://localhost:3000`. |
| `GEMINI_API_KEY` | `demo/demo/.env` | Resilience Advisor model calls. Optional. |
| `PORT` | `demo/demo/.env` | Node API port. Defaults to `3001`. |
| `METRICMANTIS_PROBE_ALLOWLIST` | `demo/demo/.env` | Hosts a measured experiment may probe. Defaults to `127.0.0.1,localhost`. Ports 3000 and 3001 are always refused. |
| `METRICMANTIS_CHAOS_ENABLED` | API process | `npm run dev:chaos` in `demo/demo` sets this to `true` for that process. `npm start` leaves it unset, so real faults stay off. |
| `METRICMANTIS_CHAOS_ALLOWLIST` | API process | `npm run dev:chaos` sets this to the approved services `web-app,api,db`. The target must also be a verified container in the signed-in user's running sandbox. |
| `NEXT_PUBLIC_API_URL` | `metricmantis-frontend/metricmantis-frontend/.env.local` | API base URL. Set to `http://localhost:3001`. |

Do not commit `.env` or `.env.local`.

## Future improvements

These are not implemented:

- Authorization on top of `requireAuth`, such as a later `requireRole` check
- Permissions for who can run chaos experiments or read reports

## Notes

- The row controls on the **Chaos** page provide a browser-side simulation. They cascade visual failure states and log commands without mutating containers.
- **Measured experiments** run against allowlisted sandbox containers (`web-app`, `api`, `db`) and apply real container faults (`stop`, `restart`, `cpu`, `memory`, `latency`, `packet_loss`, or `measure`-only) when chaos is enabled.
- Latency and packet loss are applied directly to the container's network namespace (`eth0`) using an unprivileged `netem` sidecar with `NET_ADMIN` capability.
- The advisor sends a shortened report (scores, findings, bullets, and tables). It must not invent measurements or change a computed verdict.
- `index.html` at the repository root is a self-contained earlier version of the interface. The Next.js app is the current UI.