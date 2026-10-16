# MetricMantis

MetricMantis is a chaos-engineering workspace for Docker Compose systems. Upload a compose file, map how services depend on each other, simulate failures, and read a resilience report that calls out single points of failure, missing health checks, and recovery gaps.

The browser app does the analysis locally. A Node API handles username/password login, live Docker chaos commands, container logs, and a Gemini-backed Resilience Advisor. A Spring Boot service offers a second YAML parser that flags missing restart policies and memory limits. Authentication is not part of the Spring Boot service.

## What you can do

1. **Upload** a `docker-compose.yml` or `.yaml`.
2. **Analyze** services, images, ports, `depends_on`, health checks, restart policies, volumes, and environment keys.
3. **Map** the dependency graph. Node color tracks healthy, degraded, and down.
4. **Inject chaos** by stopping a service. Dependents degrade along the graph, with a blast-radius and risk level for each target. Restart restores the stack.
5. **Read the report**, which scores dependency safety, fault tolerance, recovery, and monitoring, and lists findings such as:
   - single points of failure (a service with two or more dependents)
   - databases with no replication or volume
   - missing health checks or restart policies
   - secrets stored in the `environment` block
6. **Ask the Resilience Advisor** to summarize the report in plain language and answer follow-up questions. The advisor only uses the report you just generated.

A sample file ships with the frontend: `metricmantis-frontend/metricmantis-frontend/public/sample-docker-compose.yml`.

## Architecture

```text
┌─────────────────────────────────────────────┐
│  Next.js UI  (port 3000)                    │
│  login · parse compose · graph · chaos      │
│  resilience report · advisor chat           │
└───────────────┬─────────────────────────────┘
                │  session cookie
                ▼
┌─────────────────────────────────────────────┐
│  Node API  (port 3001)                      │
│  auth · YAML upload · docker stop/start     │
│  Gemini Resilience Advisor                  │
└───────────────┬─────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────┐
│  SQLite  demo/demo/data/metricmantis.db     │
│  users only (passwords stored as bcrypt)    │
└─────────────────────────────────────────────┘

The sample Docker stack (nginx, Node API, PostgreSQL) is a system you can break.
Spring Boot on port 8080 is a separate YAML parser and does not handle login.
```

Graph layout, cascade simulation, and the written report run in the browser. Signing in, the advisor, and live Docker commands need the Node API.

## Repository layout

```text
.
├── metricmantis-frontend/metricmantis-frontend/   Next.js app
│   ├── src/app/                  pages and global styles
│   ├── src/components/           upload, graph, chaos, report, guide, advisor
│   ├── src/context/              auth state and workflow state
│   ├── src/components/auth/      login and signup screens
│   ├── src/lib/                  compose parser, graph layout, report builder, API client
│   └── public/sample-docker-compose.yml
├── demo/demo/                    backends and the sample Docker stack
│   ├── index.js                  Express API (port 3001)
│   ├── auth/                     signup, login, sessions
│   ├── database/                 SQLite setup and user repository
│   ├── middleware/requireAuth.js authentication check for protected routes
│   ├── data/metricmantis.db      created on startup (gitignored)
│   ├── src/main/java/...         Spring Boot YAML parser
│   ├── docker-compose.yml        nginx + Node API + PostgreSQL
│   ├── Dockerfile
│   └── pom.xml
└── index.html                    earlier static prototype of the UI
```

## Tech stack

| Piece | Stack |
| --- | --- |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Graph | React Flow (`@xyflow/react`) and Dagre |
| Compose parsing | `js-yaml` in the browser; SnakeYAML in Spring Boot |
| Node API | Express 5, express-session, bcrypt, SQLite, Multer, `js-yaml`, Google Generative AI |
| Java API | Spring Boot 4, Java 17 |
| Sample system | Docker Compose, Nginx, Node.js, PostgreSQL 15 |

## Prerequisites

- Node.js 20 or newer and npm
- Docker, if you want the sample stack or live `docker stop` / `docker start` / `docker logs`
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

Open [http://localhost:3000](http://localhost:3000). The app checks the session first. Sign up, then log in. Upload, analyze, graph, chaos, and the report then work as before.

Other scripts: `npm run build`, `npm start`, `npm run lint`.

## Run the Node API

Authentication, the advisor, and the Docker chaos endpoints live here.

```bash
cd demo/demo
npm install
cp .env.example .env
```

Edit `.env` and set `SESSION_SECRET` to a long random string. The process exits on startup if that variable is missing. Do not commit `.env`.

`npm install` followed by `npm start` is enough to create the SQLite database and users table. No separate database server and no manual SQL.

```bash
npm start
```

It listens on [http://localhost:3001](http://localhost:3001). Real chaos stays off. If that port is already this project's chaos-enabled API, `npm start` exits and leaves that process running.

For a local chaos-testing session, stop is not required first:

```bash
npm run dev:chaos
```

That starts the API with chaos enabled for the approved services `web-app`, `api`, and `db`. If port 3001 is held by this project's API and chaos is off, only that process is stopped and replaced. A listener that is not `node index.js` in `demo/demo` is left alone, and the command exits. Sign in again after the API process changes. The Chaos page reads `GET /experiments/capabilities` from `NEXT_PUBLIC_API_URL` and shows that response.

### Authentication

Accounts are username, email, and password. Passwords are hashed with bcrypt and only the hash is stored. Login creates an HttpOnly session cookie (`metricmantis.sid`). The cookie is `SameSite=None` and `Secure` so the browser on port 3000 can send it to the API on port 3001. Localhost accepts that Secure cookie over HTTP.

Refreshing the page calls `GET /auth/me` and restores the session. Logout destroys it. Signup does not log the user in.

The database file is `demo/demo/data/metricmantis.db`. It is created automatically and is gitignored. User rows remain after the API restarts. The session itself is stored in memory, so restarting the API asks the user to log in again.

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
| `POST` | `/chaos/stop/:service` | Runs `docker stop` and marks the node failed. |
| `POST` | `/chaos/restart/:service` | Runs `docker start` and marks the node running. |
| `GET` | `/logs/:service` | Returns `docker logs` for that container. |
| `GET` | `/report` | Lists services currently marked failed, plus generic recommendations. |
| `POST` | `/api/advisor/summary` | JSON body `{ report }`. Returns a short summary and four suggested questions. |
| `POST` | `/api/advisor/chat` | JSON body `{ report, history, question }`. Answers from the report only. |

`:service` must match a running container name. In the sample compose file those names are `db`, `api`, and `web-app`.

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

- The row controls on the **Chaos** page are a browser simulation. They do not call Docker.
- **Measured experiments** on that page send HTTP probes and, only when enabled, Docker commands for an allowlisted container. Latency and packet loss are not applied on this host. See `docs/EXPERIMENTS.md`.
- The advisor sends a shortened report (scores, findings, bullets, and tables). It must not invent measurements or change a computed verdict.
- `index.html` at the repository root is a self-contained earlier version of the interface. The Next.js app is the current UI.