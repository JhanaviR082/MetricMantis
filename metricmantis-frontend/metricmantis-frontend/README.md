# MetricMantis Frontend

Chaos engineering web app — upload Docker Compose, extract dependencies, visualize the graph, inject failures, and read a resilience report.

## Flow

1. **Splash** → enter the app
2. **Upload** — drop `docker-compose.yml`; success confirmation; **Analyze System** parses services & `depends_on`
3. **Graph** — empty until analyzed; then dynamic dependency graph
4. **Chaos** — Stop DB, Stop API, Restart All
5. **Report** — SPOF and cascade findings

Navigation: **Back** (top left), header tabs, **Continue** buttons. No presentation-style arrows or dots.

## Run

```bash
npm install
npm run dev
```

Try `public/sample-docker-compose.yml`.

## Parsing

Client-side `js-yaml` in `src/lib/composeParser.ts` — no backend required for the demo flow.
