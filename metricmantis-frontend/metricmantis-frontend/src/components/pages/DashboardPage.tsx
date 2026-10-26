"use client";

import { PageActions } from "@/components/PageActions";
import { ExperimentWorkspace } from "@/components/pages/ExperimentWorkspace";
import { useSystem } from "@/context/SystemContext";

export function DashboardPage() {
  const {
    edges,
    sandbox,
    sandboxRuntime,
    sandboxRuntimeError,
    setPage,
  } = useSystem();
  const runtime = sandboxRuntime?.services ?? [];

  return (
    <main className="app-page">
      <div className="page-content dashboard-page-content">
        <div className="slide-label">Observability</div>
        <h1 className="slide-title">
          Experiment <span className="grad-text">dashboard</span>
        </h1>
        <p className="page-desc" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {sandbox
            ? `Sandbox ${sandbox.projectName} · status ${sandbox.status}.`
            : "No sandbox running."}
        </p>
        <ExperimentWorkspace
          edges={edges}
          sandbox={sandbox}
          runtimeServices={runtime}
          runtimeError={sandboxRuntimeError}
          runtimeKnown={Boolean(sandboxRuntime) && !sandboxRuntimeError}
          mode="observe"
        />
        <PageActions
          onContinue={() => setPage("report")}
          continueLabel="View resilience report →"
        />
      </div>
      <style>{`
        .dashboard-page-content { max-width: 900px; }
      `}</style>
    </main>
  );
}
