"use client";

import { PageActions } from "@/components/PageActions";
import { ExperimentWorkspace } from "@/components/pages/ExperimentWorkspace";
import { useSystem } from "@/context/SystemContext";

export function ChaosPage() {
  const {
    edges,
    setPage,
    sandbox,
    sandboxRuntime,
    sandboxRuntimeError,
  } = useSystem();
  const runtime = sandboxRuntime?.services ?? [];

  return (
    <main className="app-page">
      <div className="page-content chaos-page-content">
        <div className="slide-label">Measured experiments</div>
        <h1 className="slide-title">
          Sandbox <span className="grad-text">chaos</span>
        </h1>
        <p className="page-desc">
          Runs use the verified sandbox containers. Docker state and health come from inspection.
          The dependency graph still has its own simulation, and those simulated statuses are not shown here as measurements.
        </p>
        <section className="glass chaos-runtime" aria-label="Sandbox runtime">
          <div className="chaos-section-title">Runtime</div>
          {!sandbox && <p className="page-desc">No sandbox is selected. Start one from the graph before running a fault.</p>}
          {sandbox && (
            <p className="page-desc">
              {sandbox.projectName} · {sandbox.status}
              {sandboxRuntimeError ? ` · ${sandboxRuntimeError}` : ""}
            </p>
          )}
          {runtime.length === 0 && sandbox && !sandboxRuntimeError && (
            <p className="page-desc">Verified container status is not loaded yet.</p>
          )}
          <div className="chaos-runtime-list">
            {runtime.map((service) => (
              <div key={service.service} className="chaos-runtime-row">
                <strong>{service.service}</strong>
                <span>Docker: {service.verified ? service.state : "not verified"}</span>
                <span>Health: {service.verified ? service.health : "unavailable"}</span>
              </div>
            ))}
          </div>
        </section>
        <ExperimentWorkspace
          edges={edges}
          sandbox={sandbox}
          runtimeServices={runtime}
          runtimeError={sandboxRuntimeError}
          runtimeKnown={Boolean(sandboxRuntime) && !sandboxRuntimeError}
        />
        <PageActions
          onContinue={() => setPage("report")}
          continueLabel="View resilience report →"
        />
      </div>
      <style>{`
        .chaos-page-content { max-width: 1180px; }
        .chaos-section-title {
          font-size: 10px;
          letter-spacing: .1em;
          text-transform: uppercase;
          color: var(--ash);
          margin-bottom: 8px;
        }
        .chaos-runtime { padding: 16px 18px; border-radius: 14px; }
        .chaos-runtime-list { display: flex; flex-direction: column; gap: 8px; }
        .chaos-runtime-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px 16px;
          font-size: 13px;
        }
        .chaos-btn {
          padding: 6px 12px;
          border-radius: 7px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid transparent;
        }
        .chaos-btn:disabled { opacity: .3; cursor: not-allowed; }
        .chaos-btn--restart {
          background: rgba(34,197,94,.12);
          color: var(--ok);
          border-color: rgba(34,197,94,.3);
        }
      `}</style>
    </main>
  );
}
