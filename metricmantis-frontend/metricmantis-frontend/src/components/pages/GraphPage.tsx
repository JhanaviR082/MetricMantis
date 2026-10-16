"use client";

import { useMemo } from "react";
import { PageActions } from "@/components/PageActions";
import { DependencyGraph } from "@/components/graph/DependencyGraph";
import { useSystem } from "@/context/SystemContext";
import { getDependencyChain } from "@/lib/graphLayout";
import { observedServicesMissingFromGraph } from "@/lib/sandboxRuntime";

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="legend-item">
      <div className="legend-dot" style={{ background: color }} />
      {label}
    </div>
  );
}

export function GraphPage() {
  const {
    analyzed,
    services,
    edges,
    faultLabels,
    sandbox,
    sandboxRuntime,
    sandboxRuntimeError,
    sandboxObserved,
    setPage,
  } = useSystem();
  const runtime = useMemo(() => {
    const map: Record<string, NonNullable<typeof sandboxRuntime>["services"][number]> = {};
    for (const service of sandboxRuntime?.services ?? []) map[service.service] = service;
    return map;
  }, [sandboxRuntime]);
  const sandboxServices = observedServicesMissingFromGraph(
    services.map((service) => service.id),
    sandboxRuntime?.services,
  );

  const chain = analyzed
    ? getDependencyChain(services, edges)
    : "";

  return (
    <main className="app-page">
      <div className="page-content graph-page-content">

        <div className="slide-label">
          Architecture map
        </div>

        <h1 className="slide-title">
          Dependency <span className="grad-text">Graph</span>
        </h1>

        <p className="page-desc">
          Card outline, status dot, and the Simulation line follow the simulated failure and the services that depend on it. Docker and Health stay on the card and are not changed by the simulation. Edges are labeled Simulation.
        </p>

        {sandboxObserved && (
          <p className="page-desc">
            {sandbox?.projectName ? `Sandbox ${sandbox.projectName}. ` : ""}
            {sandboxRuntimeError || "Runtime status comes from container inspection."}
            {sandboxServices.length > 0
              ? ` Inspected service ${sandboxServices.map((service) => service.service).join(", ")} is shown beside the uploaded services.`
              : ""}
          </p>
        )}

        <div className="graph-legend graph-legend--bar">
          <Legend color="var(--ok)" label="Healthy" />
          <Legend color="var(--warn)" label="Affected / Degraded" />
          <Legend color="var(--danger)" label="Failed" />
        </div>

        {!analyzed ? (
          <div className="graph-empty glass">

            <div className="graph-empty-icon">
              ◇
            </div>

            <p>No graph yet</p>

            <span>
              Upload and analyze a docker-compose.yml first.
            </span>

            <button
              type="button"
              className="btn-ghost"
              style={{ marginTop: 16 }}
              onClick={() => setPage("upload")}
            >
              Go to Upload
            </button>

          </div>
        ) : (
          <>

            {chain && (
              <p className="graph-chain-label">
                <span>Chain</span> {chain}
              </p>
            )}

            <DependencyGraph
              nodes={services}
              edges={edges}
              faultLabels={faultLabels}
              runtime={runtime}
              sandboxObserved={sandboxObserved}
              runtimeKnown={Boolean(sandboxRuntime) && !sandboxRuntimeError}
              inspectionFailed={Boolean(sandboxRuntimeError)}
            />

          </>
        )}

        <PageActions
          onContinue={() => setPage("chaos")}
          continueLabel="Open chaos controls →"
          continueDisabled={!analyzed}
        />

      </div>
    </main>
  );
}