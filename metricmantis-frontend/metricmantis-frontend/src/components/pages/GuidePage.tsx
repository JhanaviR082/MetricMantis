"use client";

import { useSystem } from "@/context/SystemContext";

/* ── Inline SVG icons ── */
function IconParse() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function IconGraph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}
function IconChaos() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function IconReport() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

/* Step icons */
function IconUpload() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
function IconAnalyze() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function IconMap() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
      <line x1="8" y1="2" x2="8" y2="18" />
      <line x1="16" y1="6" x2="16" y2="22" />
    </svg>
  );
}
function IconFlag() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

const FEATURES = [
  {
    Icon: IconParse,
    title: "Parse your stack",
    text: "Reads services, images, ports, and depends_on from your YAML — no guessing, no hardcoded demo data.",
  },
  {
    Icon: IconGraph,
    title: "Visualize dependencies",
    text: "Interactive graph: who depends on whom, with green / amber / red health as chaos runs.",
  },
  {
    Icon: IconChaos,
    title: "Simulate failures",
    text: "Stop DB, stop API, restart all — watch cascade effects on the graph and in the report.",
  },
  {
    Icon: IconReport,
    title: "Explain risk",
    text: "Nine-section resilience report: SPOF, propagation, scores, and concrete engineering fixes.",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Upload",
    Icon: IconUpload,
    text: "Drop your docker-compose.yml. We read services and depends_on — nothing runs on your machine yet.",
  },
  {
    n: "02",
    title: "Analyze",
    Icon: IconAnalyze,
    text: "Hit Analyze System. Dependencies and health are extracted instantly in your browser.",
  },
  {
    n: "03",
    title: "Map & break",
    Icon: IconMap,
    text: "Explore the live dependency graph, then inject chaos — stop DB, stop API, or restart all.",
  },
  {
    n: "04",
    title: "Report",
    Icon: IconFlag,
    text: "Get SPOF detection, failure propagation, resilience scores, and engineering recommendations.",
  },
];

const ACCEPT = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "Compose files with a services: block",
  "depends_on links between services",
];

const REJECT = [
  "ZIP archives or full project folders",
  "Kubernetes manifests (not yet supported)",
  "Plain .env files without compose structure",
  "Random YAML without service definitions",
];

const COMPARE = [
  {
    them: "Gremlin / enterprise suites",
    us: "Zero setup — upload compose, see graph in seconds",
  },
  {
    them: "Blind fault injection",
    us: "Dependency-aware chaos — failures cascade on the real graph",
  },
  {
    them: "Separate tools for map vs test vs report",
    us: "Upload → graph → chaos → report in one themed flow",
  },
  {
    them: "Heavy agents & cloud lock-in",
    us: "Browser-first analysis; your compose never leaves until you choose",
  },
];

export function GuidePage() {
  const { setPage } = useSystem();

  return (
    <main className="app-page guide-page">
      <div className="page-content guide-content">
        <div className="guide-hero glass">
          <div className="guide-hero-grid" aria-hidden />
          <div className="guide-orb guide-orb-1" aria-hidden />
          <div className="guide-orb guide-orb-2" aria-hidden />
          <div className="guide-mantis" aria-hidden>
            <span className="guide-mantis-eye guide-mantis-eye-l" />
            <span className="guide-mantis-eye guide-mantis-eye-r" />
            <span className="guide-mantis-body">M</span>
          </div>
          <p className="slide-label">Platform manual</p>
          <h1 className="guide-hero-title">
            Break systems <span className="grad-text">before</span> production
            does it for you.
          </h1>
          <p className="guide-hero-lead">
            MetricMantis is a chaos resilience lab for Docker Compose stacks.
            Upload your architecture, see how failures propagate, and walk away
            with a report your team can actually use.
          </p>
          <div className="guide-hero-pills">
            <span className="guide-pill">Compose-native</span>
            <span className="guide-pill">Live dependency graph</span>
            <span className="guide-pill">SPOF intelligence</span>
          </div>
        </div>

        {/* ── What MetricMantis does ── */}
        <section className="guide-block glass">
          <h2 className="guide-block-title">What MetricMantis does</h2>
          <div className="guide-feature-grid">
            {FEATURES.map(({ Icon, title, text }) => (
              <div key={title} className="guide-feature">
                <span className="guide-feature-icon">
                  <Icon />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── How to use it — 4 steps ── */}
        <section className="guide-block glass">
          <h2 className="guide-block-title">How to use it — 4 steps</h2>
          <div className="guide-steps">
            {STEPS.map((s, i) => (
              <div
                key={s.n}
                className="guide-step"
                style={{ animationDelay: `${i * 0.12}s` }}
              >
                <div className="guide-step-rail">
                  <span className="guide-step-num">{s.n}</span>
                  {i < STEPS.length - 1 && <span className="guide-step-line" />}
                </div>
                <div className="guide-step-body">
                  <span className="guide-step-icon"><s.Icon /></span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn-primary guide-cta"
            onClick={() => setPage("upload")}
          >
            Start with Upload →
          </button>
        </section>

        <section className="guide-block glass guide-upload-rules">
          <h2 className="guide-block-title">What to upload</h2>
          <div className="guide-rules-grid">
            <div className="guide-rules-col guide-rules-ok">
              <h3>✓ Works</h3>
              <ul>
                {ACCEPT.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="guide-rules-col guide-rules-no">
              <h3>✗ Won&apos;t work (yet)</h3>
              <ul>
                {REJECT.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="guide-rules-note">
            Tip: use <code>public/sample-docker-compose.yml</code> in this repo
            if you want a quick test drive.
          </p>
        </section>

        <section className="guide-block glass">
          <h2 className="guide-block-title">Why MetricMantis?</h2>
          <p className="guide-compare-intro">
            Most chaos tools assume you already run agents, clusters, and
            experiments. We start where your team already lives —{" "}
            <strong>docker-compose.yml</strong>.
          </p>
          <div className="guide-compare-list">
            {COMPARE.map((row, i) => (
              <div
                key={row.them}
                className="guide-compare-row"
                style={{ animationDelay: `${i * 0.08}s` }}
              >
                <div className="guide-compare-them">
                  <span className="guide-compare-label">Others</span>
                  {row.them}
                </div>
                <div className="guide-compare-arrow">→</div>
                <div className="guide-compare-us">
                  <span className="guide-compare-label">MetricMantis</span>
                  {row.us}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="guide-block glass guide-manifesto">
          <blockquote>
            Production doesn&apos;t fail by accident. It fails along dependency
            lines you never drew on a whiteboard. MetricMantis draws them for
            you — then lets you pull one thread and watch the rest react.
          </blockquote>
          <p className="guide-manifesto-sign">— The Mantis watches the graph</p>
        </section>
      </div>
    </main>
  );
}
