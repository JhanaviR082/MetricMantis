"use client";

import { useSystem } from "@/context/SystemContext";

const STEPS = [
  {
    n: "01",
    title: "Upload",
    icon: "📦",
    text: "Drop your docker-compose.yml. We read services and depends_on — nothing runs on your machine yet.",
  },
  {
    n: "02",
    title: "Analyze",
    icon: "🔬",
    text: "Hit Analyze System. Dependencies and health are extracted instantly in your browser.",
  },
  {
    n: "03",
    title: "Map & break",
    icon: "💥",
    text: "Explore the live dependency graph, then inject chaos — stop DB, stop API, or restart all.",
  },
  {
    n: "04",
    title: "Report",
    icon: "📜",
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

        <section className="guide-block glass">
          <h2 className="guide-block-title">What MetricMantis does</h2>
          <div className="guide-feature-grid">
            <div className="guide-feature">
              <span className="guide-feature-icon">🧬</span>
              <h3>Parse your stack</h3>
              <p>
                Reads services, images, ports, and depends_on from your YAML —
                no guessing, no hardcoded demo data.
              </p>
            </div>
            <div className="guide-feature">
              <span className="guide-feature-icon">🕸️</span>
              <h3>Visualize dependencies</h3>
              <p>
                Interactive graph: who depends on whom, with green / amber / red
                health as chaos runs.
              </p>
            </div>
            <div className="guide-feature">
              <span className="guide-feature-icon">🎯</span>
              <h3>Simulate failures</h3>
              <p>
                Stop DB, stop API, restart all — watch cascade effects on the
                graph and in the report.
              </p>
            </div>
            <div className="guide-feature">
              <span className="guide-feature-icon">📊</span>
              <h3>Explain risk</h3>
              <p>
                Nine-section resilience report: SPOF, propagation, scores, and
                concrete engineering fixes.
              </p>
            </div>
          </div>
        </section>

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
                  <span className="guide-step-icon">{s.icon}</span>
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
