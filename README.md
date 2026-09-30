# MetricMantis
MetricMantis is a chaos-engineering workspace for Docker Compose systems. Upload a compose file, map how services depend on each other, simulate failures, and read a resilience report that calls out single points of failure, missing health checks, and recovery gaps.
The browser app does the analysis locally. A Node API adds live Docker chaos commands, container logs, and a Gemini-backed Resilience Advisor. A Spring Boot service offers a second YAML parser that flags missing restart policies and memory limits.
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
│  parse compose · graph · simulated chaos    │
│  resilience report · advisor chat           │
└───────────────┬─────────────────────────────┘
                │  advisor summary / chat
                ▼
┌─────────────────────────────────────────────┐
│  Node API  (port 3001)                      │
│  YAML upload · docker stop/start/logs       │
│  Gemini Resilience Advisor                  │
└───────────────┬─────────────────────────────┘
                │  docker CLI
                ▼
┌─────────────────────────────────────────────┐
│  Sample stack (docker compose)              │
│  web-app (nginx :8090) → api → db (postgres)│
└─────────────────────────────────────────────┘
Spring Boot parser (port 8080) is a separate upload endpoint.
It returns services, depends_on, and config warnings.
```
Graph layout, cascade simulation, and the written report run in the browser. The Node API is required for the advisor, and for stopping, starting, or reading logs from real containers.

## Repository layout
```text
.
├── metricmantis-frontend/metricmantis-frontend/   Next.js app
│   ├── src/app/                  pages and global styles
│   ├── src/components/           upload, graph, chaos, report, guide, advisor
│   ├── src/context/              workflow state
│   ├── src/lib/                  compose parser, graph layout, report builder, API client
│   └── public/sample-docker-compose.yml
├── demo/demo/                    backends and the sample Docker stack
│   ├── index.js                  Express API (port 3001)
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
| Node API | Express 5, Multer, `js-yaml`, Google Generative AI |
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
Open [http://localhost:3000](http://localhost:3000). Upload, analyze, graph, chaos, and the report work without a backend.
Other scripts: `npm run build`, `npm start`, `npm run lint`.
## Run the Node API
The advisor and the Docker chaos endpoints live here.
```bash
cd demo/demo
npm install
```
Create `demo/demo/.env` (this file is gitignored):
```bash
GEMINI_API_KEY=your_key_here
```
Start the server:
```bash
node index.js
```
It listens on [http://localhost:3001](http://localhost:3001). The frontend advisor client uses that URL.
### HTTP API
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
| `GEMINI_API_KEY` | `demo/demo/.env` | Resilience Advisor model calls |
| `NEXT_PUBLIC_API_URL` | `metricmantis-frontend/metricmantis-frontend/.env.local` | Documented in `.env.local.example`. The advisor client currently calls `http://localhost:3001` directly. |
Do not commit `.env` or `.env.local`.
## Notes
- Chaos on the **Chaos** page is a browser simulation. It updates service status and records a `docker stop <service>` event for the report. It does not call Docker unless you use the Node API endpoints.
- The advisor sends a shortened report (scores, findings, bullets, and tables) and refuses to invent services or metrics that are not in that report.
- `index.html` at the repository root is a simulation of the interface. 
