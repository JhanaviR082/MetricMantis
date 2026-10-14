# MetricMantis — Node API & Sample Stack

This directory contains two things:

1. **The Node/Express API** (`index.js`) — handles authentication, YAML upload, live Docker chaos commands, container logs, and the Gemini-backed Resilience Advisor.
2. **The sample Docker stack** (`docker-compose.yml`) — an Nginx + Node.js + PostgreSQL system you can actually break with chaos experiments.

A Spring Boot YAML parser also lives here (`src/main/java/`) and runs independently on port 8080.

---

## Prerequisites

- Node.js 20+ and npm
- Docker (for the sample stack and live chaos commands)
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

```bash
npm start
```

Listens on **http://localhost:3001**. The SQLite database (`data/metricmantis.db`) is created automatically on first run — no separate database server needed.

---

## Authentication

Accounts use username + email + password. Passwords are hashed with bcrypt; only the hash is stored.

Login returns an `HttpOnly` session cookie (`metricmantis.sid`). The cookie is `SameSite=None; Secure` so the browser on port 3000 can send it to the API on port 3001 — browsers accept Secure cookies over HTTP on localhost.

Session state is in memory. Restarting the API clears sessions and asks users to log in again. User accounts persist in SQLite across restarts.

| Method | Path | Auth required | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/signup` | No | Create an account (does not log in automatically). |
| `POST` | `/auth/login` | No | Start a session, return user object. |
| `POST` | `/auth/logout` | No | Destroy the session. |
| `GET` | `/auth/me` | No | Return current user or `{ "authenticated": false }`. |

---

## HTTP API

All routes below require a valid session cookie. Without it they return HTTP 401.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/upload` | Multipart field `file`. Parses `services` and `depends_on` into nodes and edges. |
| `GET` | `/graph` | Returns the last parsed graph. |
| `POST` | `/chaos/stop/:service` | Runs `docker stop <service>` and marks the node failed. |
| `POST` | `/chaos/restart/:service` | Runs `docker start <service>` and marks the node running. |
| `GET` | `/logs/:service` | Returns `docker logs` for that container. |
| `GET` | `/report` | Lists services currently marked failed and generic resilience recommendations. |
| `POST` | `/api/advisor/summary` | Body `{ report }`. Returns a 3–5 sentence plain-language summary and four suggested follow-up questions. |
| `POST` | `/api/advisor/chat` | Body `{ report, history, question }`. Answers strictly from the report — no invented data. |

`:service` must match a running container name. In the sample stack those are `db`, `api`, and `web-app`.

---

## Resilience Advisor

Powered by Google Gemini (`gemini-3.6-flash`). The advisor receives a slimmed-down version of the resilience report (scores, findings, bullets) and refuses to invent services or metrics not present in it.

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

Do not commit `.env`.

---

## Project structure

```
demo/demo/
├── index.js                  Express API entry point (port 3001)
├── auth/
│   ├── authService.js        signup, login, bcrypt password handling
│   └── session.js            express-session + cookie config
├── database/
│   ├── database.js           SQLite init, table creation
│   └── userRepository.js     user CRUD
├── middleware/
│   └── requireAuth.js        401 guard for protected routes
├── routes/
│   └── authRoutes.js         /auth/* endpoints
├── uploads/                  temp files from multipart uploads (gitignored)
├── data/
│   └── metricmantis.db       SQLite database (auto-created, gitignored)
├── docker-compose.yml        sample Nginx + Node + PostgreSQL stack
├── Dockerfile                Node API image for the sample stack
├── pom.xml                   Spring Boot Maven config
└── src/main/java/            Spring Boot YAML parser (port 8080)
```
