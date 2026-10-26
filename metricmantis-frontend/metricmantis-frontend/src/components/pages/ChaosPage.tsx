"use client";

import { PageActions } from "@/components/PageActions";
import { ExperimentWorkspace } from "@/components/pages/ExperimentWorkspace";
import { useSystem } from "@/context/SystemContext";
import { FAULT_LABEL } from "@/lib/chaosFaults";

export function ChaosPage() {
  const {
    edges,
    services,
    faultLabels,
    setPage,
    sandbox,
    sandboxRuntime,
    sandboxRuntimeError,
  } = useSystem();
  const runtime = sandboxRuntime?.services ?? [];
  const degradedServices = services
    .filter((service) => service.status === "degraded")
    .map((service) => ({
      service,
      unhealthyDependencies: edges.flatMap((edge) => {
        if (edge.from !== service.id) return [];
        const dependency = services.find((candidate) => candidate.id === edge.to);
        return dependency &&
          (dependency.status === "down" || dependency.status === "degraded")
          ? [dependency]
          : [];
      }),
    }));

  return (
    <main className="app-page">
      <div className="page-content chaos-page-content">
        <div className="slide-label">Measured experiments</div>
        <h1 className="slide-title">
          Sandbox <span className="grad-text">chaos</span>
        </h1>
        <p className="page-desc" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          Runs use the verified sandbox containers. Docker state and health come from inspection.
        </p>

        <section className="glass chaos-runtime" aria-label="Sandbox runtime">
          <div className="chaos-section-title">Runtime</div>
          {!sandbox && (
            <p className="chaos-desc">No sandbox is selected. Start one from the upload page first.</p>
          )}
          {sandbox && (
            <p className="chaos-desc">
              {sandbox.projectName} · {sandbox.status}
              {sandboxRuntimeError ? ` · ${sandboxRuntimeError}` : ""}
            </p>
          )}
          {runtime.length === 0 && sandbox && !sandboxRuntimeError && (
            <p className="chaos-desc">Verified container status is not loaded yet.</p>
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

        <section className="glass chaos-runtime" aria-label="Simulated dependency impact">
          <div className="chaos-section-title">Dependency simulation</div>
          <p className="chaos-desc">Simulated graph statuses — not measured container health.</p>
          {degradedServices.length === 0 ? (
            <p className="chaos-desc">No services are currently DEGRADED in the dependency simulation.</p>
          ) : (
            <div className="chaos-runtime-list">
              {degradedServices.map(({ service, unhealthyDependencies }) => (
                <div key={service.id} className="chaos-runtime-row">
                  <strong>{service.name}</strong>
                  <span>
                    {unhealthyDependencies.length > 0
                      ? `Degraded because immediate dependencies ${unhealthyDependencies
                          .map((dependency) => `${dependency.name} (${dependency.status.toUpperCase()})`)
                          .join(", ")} are unhealthy.`
                      : faultLabels[service.id]
                        ? `Degraded by simulated ${FAULT_LABEL[faultLabels[service.id]]} fault; no immediate dependency is currently unhealthy.`
                        : "No immediate dependency is currently DOWN or DEGRADED."}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <ExperimentWorkspace
          edges={edges}
          sandbox={sandbox}
          runtimeServices={runtime}
          runtimeError={sandboxRuntimeError}
          runtimeKnown={Boolean(sandboxRuntime) && !sandboxRuntimeError}
          mode="configure"
          onRunStarted={() => setPage("dashboard")}
        />

        <PageActions
          onContinue={() => setPage("dashboard")}
          continueLabel="View experiment dashboard →"
        />
      </div>
      <style>{`
        .chaos-page-content { max-width: 1080px; }
        .chaos-section-title {
          font-size: 10px;
          letter-spacing: .1em;
          text-transform: uppercase;
          color: var(--ash);
          margin-bottom: 10px;
        }
        .chaos-runtime {
          padding: 18px 20px;
          border-radius: 14px;
          margin-top: 16px;
        }
        .chaos-desc {
          font-family: var(--mono);
          font-size: 12px;
          color: var(--pewter);
          line-height: 1.6;
          margin: 0 0 8px;
          max-width: 100%;
        }
        .chaos-runtime-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 8px;
        }
        .chaos-runtime-row {
          display: flex;
          flex-wrap: wrap;
          gap: 4px 16px;
          font-size: 13px;
          align-items: baseline;
          padding: 4px 0;
        }
      `}</style>
    </main>
  );
}
