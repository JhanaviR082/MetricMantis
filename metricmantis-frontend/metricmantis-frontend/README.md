# MetricMantis Frontend

Next.js web app for chaos engineering with Docker Compose. Upload a compose file, map service dependencies, simulate failures, and read a structured resilience report — all in the browser. Authentication, live Docker commands, and the AI Advisor require the Node API running on port 3001.

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

The Node API must be running for login, signup, file upload, live chaos, logs, and the Advisor. See `demo/demo/README.md`.

---

## App flow

### 1. Splash
Animated entry screen. Click **Enter Platform** to proceed to login.

### 2. Auth
Sign up with username, email, and password. Log in. Passwords have a show/hide toggle. Session is maintained via an HttpOnly cookie from the API. The "Logged in successfully" banner auto-dismisses after 3 seconds.

### 3. Upload
Drop a `docker-compose.yml` or `.yaml`. The file is sent to `POST /upload` on the Node API and stored temporarily. Click **Analyze System** to extract services, `depends_on` links, ports, health checks, restart policies, volumes, and environment keys.

Try `public/sample-docker-compose.yml` for an immediate test drive.

### 4. Graph
Interactive dependency graph built with React Flow and Dagre layout. Node colours track health status in real time as chaos runs: green (healthy), amber (degraded), red (down).

### 5. Chaos
Three actions: **Stop DB**, **Stop API**, **Restart All**. Each action cascades through the dependency graph — dependents degrade based on the actual `depends_on` relationships. Events are recorded for the report.

> Chaos on this page is a browser simulation. It updates node state and logs a `docker stop <service>` command. Live Docker execution happens only through the Node API endpoints.

### 6. Report
Nine-section structured resilience report:
- Dependency safety score
- Fault tolerance score
- Recovery capability
- Monitoring coverage
- Single points of failure (services with 2+ dependents)
- Databases with no replication or volume
- Missing health checks or restart policies
- Secrets stored in plain `environment` blocks
- Concrete engineering recommendations

### 7. Resilience Advisor
AI assistant backed by Google Gemini. Reads the report you just generated and provides a plain-language summary plus four suggested follow-up questions. You can ask follow-ups in a chat interface. The Advisor never invents data — if something isn't in the report, it says so.

### 8. Platform Guide
Accessible from the header at any time. Explains what MetricMantis does, how to use it in 4 steps, what files to upload, and how it compares to heavier enterprise chaos tools.

---

## Navigation

- **Back** button (top left) — step back through the workflow
- **Header nav tabs** — jump to any unlocked page
- **MetricMantis logo** (top left) — returns to the splash screen
- **Continue / Start with Upload** buttons — progress forward
- Graph, Chaos, and Report tabs are disabled until a compose file has been analyzed

---

## Theme

Dark and light mode via the pill toggle in the header. Both themes use the same grid-line background, frosted glass cards, and noise texture. Preference is saved to `localStorage`.

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
│   ├── auth/
│   │   ├── AuthScreen.tsx    login / signup form with show-password toggle
│   │   └── AuthMessage.tsx   success / error notice banner
│   ├── pages/
│   │   ├── UploadPage.tsx    file drop, analyze trigger
│   │   ├── GraphPage.tsx     React Flow dependency graph
│   │   ├── ChaosPage.tsx     chaos controls + live metric cards
│   │   ├── ReportPage.tsx    structured nine-section report
│   │   └── GuidePage.tsx     platform manual
│   ├── AppHeader.tsx         sticky header, nav, theme toggle, logout
│   ├── Background.tsx        grid, noise, scanline layers
│   ├── MetricMantisApp.tsx   root — providers, auth gate, page routing
│   ├── Splash.tsx            animated entry screen
│   └── ThemeToggle.tsx       sun/moon pill toggle
├── context/
│   ├── AuthContext.tsx       user state, login/signup/logout, session notice
│   ├── SystemContext.tsx     workflow state, compose data, chaos events
│   └── ThemeContext.tsx      dark/light preference
└── lib/
    ├── api.ts                typed fetch client for the Node API
    ├── composeParser.ts      client-side YAML parsing, dependency extraction, findings
    ├── graphLayout.ts        Dagre layout for React Flow
    └── reportBuilder.ts      report section assembly from findings + chaos events
```

---

## Other scripts

```bash
npm run build   # production build
npm start       # serve the production build
npm run lint    # ESLint
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
| Fonts | Syne (headings), JetBrains Mono (mono) |
| API client | native `fetch` with session cookie |
