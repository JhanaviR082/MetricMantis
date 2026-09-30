"use client";

import { PageActions } from "@/components/PageActions";
import { DependencyGraph } from "@/components/graph/DependencyGraph";
import { useSystem } from "@/context/SystemContext";
import { getDependencyChain } from "@/lib/graphLayout";

export function GraphPage() {
  const { analyzed, services, edges, setPage } = useSystem();

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
          Live view of service dependencies.
          Colors update when you inject chaos.
        </p>

        <div className="graph-legend graph-legend--bar">

          <div className="legend-item">
            <div
              className="legend-dot"
              style={{ background: "var(--ok)" }}
            />
            Healthy
          </div>

          <div className="legend-item">
            <div
              className="legend-dot"
              style={{ background: "var(--warn)" }}
            />
            Degraded
          </div>

          <div className="legend-item">
            <div
              className="legend-dot"
              style={{ background: "var(--danger)" }}
            />
            Down
          </div>

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