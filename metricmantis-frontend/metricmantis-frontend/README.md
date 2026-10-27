# MetricMantis Frontend

Next.js web app for chaos engineering with Docker Compose. Upload a compose file, map service dependencies, simulate cascading failures, spin up isolated container sandboxes, run measured chaos experiments, and inspect structured resilience reports — all from the browser. User authentication, sandbox lifecycle, live container faults, logs, and the AI Advisor connect to the Node API on port 3001.

---

## Quick start

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

`.env.local` should contain:

```
NEXT_PUBLIC_API_URL=http://localhost:3001
```

`npm run dev` runs via webpack because Turbopack has package resolution issues with nested repository structures. The Node API must be running for login, signup, sandboxes, measured experiments, live chaos, logs, and the Advisor. See `demo/demo/README.md`.

---

## App flow

### 1. Splash
Animated entry screen with subtle grid-line and scanline styling. Click **Enter Platform** to proceed to the authentication screen.

### 2. Auth
Sign up with username, email, and password. Log in with existing credentials. Passwords feature a show/hide toggle. Authentication state is tracked via an HttpOnly session cookie (`metricmantis.sid`). Login success banners auto-dismiss after 3 seconds.

### 3. Upload
Drop a `docker-compose.yml` or `.yaml` file. Displays the uploaded file name and size. Click **Analyze System** to parse the configuration client-side and send it to `POST /upload`. Extracts services, `depends_on` relationships, ports, health checks, restart policies, volume bindings, and environment variables.

Try `public/sample-docker-compose.yml` for an immediate test drive.

### 4. Graph
Interactive dependency graph rendered with React Flow (`@xyflow/react`) and Dagre auto-layout. Node colors reflect service health in real time: green (healthy), amber (degraded), red (down). Shows dependency arrows and service metadata badges.

### 5. Chaos & Sandboxes
The Chaos view provides two distinct operational paths:

- **Browser Simulation**: Trigger **Stop DB**, **Stop API**, or **Restart All**. Failures cascade along `depends_on` edges in the graph. Degraded service explanations, blast radius, and risk assessments are computed client-side.
- **Server Sandbox Management**: Start, monitor runtime status, and clean up server-managed sandboxes (`web-app`, `api`, `db`) running `demo/demo/sandboxes/approved-sample-compose.yml`.
- **Measured Experiment Configuration**: Configure real fault runs against sandbox containers:
  - **Fault types**: `measure` (probe only), `stop`, `restart`, `cpu` throttling (5% limit + bounded burn workload), `memory` pressure (4, 8, 12 MiB), `latency` injection (20–500 ms), and `packet_loss` (1–20%).
  - **Windows & rates**: Configure baseline duration (200–10000 ms), fault duration (200–15000 ms), recovery duration (200–10000 ms), probe rate (1–20 req/s), concurrency (1–4), and request timeout.
  - **Thresholds**: Define target limits for max error rate percentage and max p95 latency.

### 6. Observability Dashboard
Monitors live measured experiment execution via polling (`GET /experiments/:id`):
- Phase indicator tracking progress through **baseline**, **fault**, and **recovery** windows.
- Metric cards for total requests, error rate, throughput, p50 latency, p95 latency, and p99 latency.
- Verified Docker status, inspection quota details, and `tc qdisc` netem rule verification.
- Final experiment verdict badge: `PASSED`, `FAILED`, `INCONCLUSIVE`, `ERROR`, or `CANCELLED`.
- History list of recent experiment runs with quick recall.

### 7. Report & PDF Export
Comprehensive resilience audit combining static Compose analysis, simulation events, and observed measured experiment evidence:
- **Resilience Scores**: Dependency Safety, Fault Tolerance, Recovery Capability, and Monitoring Coverage.
- **Structural Findings**: Single points of failure (services with 2+ dependents), databases without replication or persistent volumes, missing health checks or restart policies, and exposed environment secrets.
- **Measured Experiment Evidence**: Phase-by-phase request counts, error rates, throughput, latency percentiles, limitations, and verification verdicts.
- **Actionable Recommendations**: Clear, prioritized remediation steps.
- **Export PDF**: One-click download of a clean, structured PDF report generated in the browser via `jspdf`.

### 8. Resilience Advisor
AI assistant powered by Google Gemini (`gemini-3.6-flash`). Receives a structured summary of the generated report and produces:
- A concise 3–5 sentence plain-language explanation of system health and critical failure points.
- Four context-aware suggested follow-up questions referencing actual services in your compose file.
- An interactive chat interface for in-depth questions. The Advisor strictly references the report and never invents measurements or alters verdicts.

### 9. Platform Guide
Platform manual accessible anytime from the header nav. Explains the 4-step workflow, supported chaos faults, architecture, security rules, and how MetricMantis compares to heavier enterprise chaos tools.

---

## Navigation

- **Back** button (top left) — step back through the workflow
- **Header nav tabs** — jump to any unlocked page
- **MetricMantis logo** (top left) — returns to the splash screen
- **Continue / Start with Upload** buttons — progress forward
- Graph, Chaos, and Report tabs are disabled until a compose file has been analyzed

---

## Theme

Dark and light mode toggle via the pill button in the header. Both themes use custom CSS tokens, frosted glass cards, grid background, and noise texture. Theme selection is persisted in `localStorage`.

---

## Project structure

```
src/
├── app/
│   ├── page.tsx              mounts MetricMantisApp
│   ├── layout.tsx            fonts, metadata, theme flash prevention
│   ├── globals.css           Tailwind import
│   └── metricmantis.css      full design system (tokens, components, layout, themes)
├── components/
│   ├── AppHeader.tsx         sticky header, nav, theme toggle, logout
│   ├── Background.tsx        grid, noise, scanline background layers
│   ├── MetricMantisApp.tsx   root application shell, route state, auth gate
│   ├── PageActions.tsx       reusable forward/back workflow action buttons
│   ├── ResilienceAdvisor.tsx Gemini AI advisor chat and summary component
│   ├── Splash.tsx            animated entry splash screen
│   ├── ThemeToggle.tsx       sun/moon pill theme switch
│   ├── auth/
│   │   ├── AuthMessage.tsx   success / error notice banner
│   │   └── AuthScreen.tsx    login / signup form with password visibility toggle
│   ├── graph/
│   │   ├── DependencyGraph.tsx React Flow canvas, zoom controls, mini-map
│   │   └── ServiceNode.tsx   custom styled graph node with status badges
│   └── pages/
│       ├── ChaosPage.tsx     simulation actions, sandboxes, and experiment workspace
│       ├── ConfigureExperimentPanel.tsx measured fault form and parameter controls
│       ├── DashboardPage.tsx standalone observability dashboard view
│       ├── ExperimentWorkspace.tsx tabs for sandbox runtime, experiment form, and dashboard
│       ├── GraphPage.tsx     dependency graph view and service inventory
│       ├── GuidePage.tsx     platform documentation and manual
│       ├── ObservabilityDashboard.tsx live phase progress, metrics, and verdicts
│       ├── ReportPage.tsx    resilience scores, findings, experiment evidence, PDF export
│       └── UploadPage.tsx    file drop zone, file size indicator, analyze trigger
├── context/
│   ├── AuthContext.tsx       user state, login/signup/logout, session notice
│   ├── SystemContext.tsx     workflow state, compose data, chaos events, sandbox state
│   └── ThemeContext.tsx      dark/light theme preference provider
└── lib/
    ├── api.ts                typed fetch client with session cookie credentials
    ├── chaosFaults.ts        fault type definitions, metadata, and options
    ├── composeParser.ts      client-side YAML parser and resilience rule engine
    ├── experimentDashboard.ts dashboard state mapping and sparkline calculations
    ├── experimentForm.ts     form state, validation, and default parameters
    ├── experimentReport.ts   measured evidence formatting for reports
    ├── graphLayout.ts        Dagre layout engine for React Flow
    ├── reportBuilder.ts      nine-section resilience scoring and findings builder
    ├── reportPdf.ts          client-side multi-page PDF generation via jspdf
    └── sandboxRuntime.ts     sandbox runtime status helpers
```

---

## Scripts and tests

```bash
npm run dev     # start local development server (webpack)
npm test        # run frontend test suite (core, forms, dashboard, runtime, graph)
npx tsc --noEmit # TypeScript type checking
npm run lint    # ESLint validation
npm run build   # production build
npm start       # serve production build
```

---

## Tech stack

| | |
| --- | --- |
| Framework | Next.js 16 (App Router) |
| UI | React 19, TypeScript |
| Styling | Tailwind CSS 4, custom CSS design system |
| Graph | React Flow (`@xyflow/react`), Dagre |
| YAML parsing | `js-yaml` (browser-side) |
| PDF Export | `jspdf` |
| Fonts | Syne (headings), JetBrains Mono (mono) |
| API client | native `fetch` with session cookie (`credentials: 'include'`) |
