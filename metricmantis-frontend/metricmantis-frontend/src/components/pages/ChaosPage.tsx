"use client";

import { useCallback, useMemo } from "react";
import { PageActions } from "@/components/PageActions";
import { useSystem } from "@/context/SystemContext";

/* ─── helpers ─────────────────────────────────────────────── */

type Service = {
  id: string;
  name: string;
  status: "healthy" | "degraded" | "down";
  dependsOn?: string[];
};

function getBlastRadius(
  target: Service,
  all: Service[],
): string[] {
  // direct dependents
  const affected = all
    .filter(
      (s) =>
        s.id !== target.id &&
        (s.dependsOn ?? []).includes(target.id),
    )
    .map((s) => s.id);

  // transitive (one level more)
  const transitive = all
    .filter(
      (s) =>
        !affected.includes(s.id) &&
        s.id !== target.id &&
        (s.dependsOn ?? []).some((dep) => affected.includes(dep)),
    )
    .map((s) => s.id);

  return [...affected, ...transitive];
}

function riskLevel(blastCount: number, total: number): "low" | "medium" | "high" | "critical" {
  const pct = blastCount / Math.max(total - 1, 1);
  if (pct >= 0.6) return "critical";
  if (pct >= 0.35) return "high";
  if (pct >= 0.15) return "medium";
  return "low";
}

const RISK_COLOR: Record<string, string> = {
  low: "var(--ok)",
  medium: "var(--warn)",
  high: "#f97316",
  critical: "var(--danger)",
};

const RISK_LABEL: Record<string, string> = {
  low: "LOW RISK",
  medium: "MEDIUM",
  high: "HIGH RISK",
  critical: "CRITICAL",
};

/* ─── component ───────────────────────────────────────────── */

export function ChaosPage() {
  const { services, stopService, restartAll, setPage } = useSystem() as {
    services: Service[];
    stopService: (id: string) => void;
    restartAll: () => void;
    restartService?: (id: string) => void;
    setPage: (page: string) => void;
  };

  // optional per-service restart from context (add if not present)
  const restartService = useCallback(
    (id: string) => {
      if ((useSystem as any)._restartService) {
        (useSystem as any)._restartService(id);
      }
    },
    [],
  );

  const blastMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    services.forEach((s) => {
      map[s.id] = getBlastRadius(s, services);
    });
    return map;
  }, [services]);

  const downCount = services.filter((s) => s.status === "down").length;
  const degradedCount = services.filter((s) => s.status === "degraded").length;
  const healthyCount = services.filter((s) => s.status === "healthy").length;

  return (
    <main className="app-page">
      <div className="page-content">
        <div className="slide-label">Chaos engineering</div>
        <h1 className="slide-title">
          Manual <span className="grad-text">failure injection</span>
        </h1>
        <p className="page-desc">
          Inject failures to observe cascade behaviour. Each row shows live
          status and the blast radius if that service is stopped.
        </p>

        {/* ── top stat bar ── */}
        <div className="chaos-stat-bar glass">
          <div className="chaos-stat">
            <span className="chaos-stat-val" style={{ color: "var(--ok)" }}>
              {healthyCount}
            </span>
            <span className="chaos-stat-lbl">Healthy</span>
          </div>
          <div className="chaos-stat-divider" />
          <div className="chaos-stat">
            <span className="chaos-stat-val" style={{ color: "var(--warn)" }}>
              {degradedCount}
            </span>
            <span className="chaos-stat-lbl">Degraded</span>
          </div>
          <div className="chaos-stat-divider" />
          <div className="chaos-stat">
            <span
              className="chaos-stat-val"
              style={{ color: "var(--danger)" }}
            >
              {downCount}
            </span>
            <span className="chaos-stat-lbl">Down</span>
          </div>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="chaos-restart-all"
            onClick={restartAll}
          >
            🟢 Restart All
          </button>
        </div>

        {/* ── two-column layout ── */}
        <div className="chaos-grid">
          {/* LEFT — service rows */}
          <div className="chaos-service-list">
            <div className="chaos-section-title">Services</div>
            {services.length === 0 && (
              <div className="chaos-empty glass">
                No services loaded. Upload a YAML first.
              </div>
            )}
            {services.map((s) => {
              const blast = blastMap[s.id] ?? [];
              const risk = riskLevel(blast.length, services.length);
              const riskColor = RISK_COLOR[risk];

              return (
                <div
                  key={s.id}
                  className={`chaos-row glass chaos-row--${s.status}`}
                >
                  {/* left section */}
                  <div className="chaos-row-left">
                    <div className="chaos-row-indicator" style={{
                      background: s.status === "healthy"
                        ? "var(--ok)"
                        : s.status === "degraded"
                          ? "var(--warn)"
                          : "var(--danger)",
                    }} />
                    <div>
                      <div className="chaos-svc-name">{s.name}</div>
                      <div className="chaos-svc-meta">
                        <span
                          className="chaos-svc-status"
                          style={{
                            color:
                              s.status === "healthy"
                                ? "var(--ok)"
                                : s.status === "degraded"
                                  ? "var(--warn)"
                                  : "var(--danger)",
                          }}
                        >
                          {s.status.toUpperCase()}
                        </span>
                        {blast.length > 0 && (
                          <span
                            className="chaos-blast-badge"
                            style={{ color: riskColor, borderColor: riskColor }}
                          >
                            {RISK_LABEL[risk]} · {blast.length} affected
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* right — action buttons */}
                  <div className="chaos-row-actions">
                    <button
                      type="button"
                      className="chaos-btn chaos-btn--stop"
                      disabled={s.status === "down"}
                      onClick={() => stopService(s.id)}
                      title="Stop this service"
                    >
                      ⏹ Stop
                    </button>
                    <button
                      type="button"
                      className="chaos-btn chaos-btn--restart"
                      disabled={s.status === "healthy"}
                      onClick={() => {
                        // use context restartService if available, else restartAll
                        if ((window as any).__restartService) {
                          (window as any).__restartService(s.id);
                        } else {
                          restartAll();
                        }
                      }}
                      title="Restart this service"
                    >
                      ↺ Restart
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* RIGHT — blast radius panel */}
          <div className="blast-panel glass">
            <div className="blast-panel-header">
              <span className="blast-panel-title">💥 Blast Radius</span>
              <div className="live-badge">LIVE</div>
            </div>
            <p className="blast-panel-desc">
              Services that would be cascaded-failed if a node is stopped.
            </p>
            <div className="blast-grid">
              {services.map((s) => {
                const blast = blastMap[s.id] ?? [];
                const risk = riskLevel(blast.length, services.length);
                const riskColor = RISK_COLOR[risk];
                const pct =
                  services.length > 1
                    ? Math.round((blast.length / (services.length - 1)) * 100)
                    : 0;

                return (
                  <div
                    key={s.id}
                    className="blast-cell glass"
                    style={{ "--blast-color": riskColor } as React.CSSProperties}
                  >
                    <div className="blast-cell-name">{s.name}</div>
                    <div
                      className="blast-cell-ring"
                      style={{
                        background: `conic-gradient(${riskColor} ${pct}%, transparent ${pct}%)`,
                      }}
                    >
                      <div className="blast-cell-ring-inner">
                        <span style={{ color: riskColor, fontWeight: 700 }}>
                          {pct}%
                        </span>
                      </div>
                    </div>
                    <div
                      className="blast-cell-label"
                      style={{ color: riskColor }}
                    >
                      {RISK_LABEL[risk]}
                    </div>
                    {blast.length > 0 && (
                      <div className="blast-cell-deps">
                        {blast.map((dep) => (
                          <span key={dep} className="blast-dep-chip">
                            {services.find((sv) => sv.id === dep)?.name ?? dep}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <PageActions
          onContinue={() => setPage("report")}
          continueLabel="View resilience report →"
        />
      </div>

      {/* ── scoped styles ── */}
      <style>{`
        /* stat bar */
        .chaos-stat-bar {
          display: flex;
          align-items: center;
          gap: 0;
          padding: 14px 20px;
          border-radius: 12px;
          margin-bottom: 24px;
        }
        .chaos-stat {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          padding: 0 20px;
        }
        .chaos-stat-val { font-size: 26px; font-weight: 800; line-height: 1; }
        .chaos-stat-lbl { font-size: 10px; letter-spacing: .08em; color: var(--ash); text-transform: uppercase; }
        .chaos-stat-divider { width: 1px; height: 36px; background: var(--border); }
        .chaos-restart-all {
          background: rgba(34,197,94,.12);
          color: var(--ok);
          border: 1px solid rgba(34,197,94,.3);
          border-radius: 8px;
          padding: 8px 16px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: background .2s;
        }
        .chaos-restart-all:hover { background: rgba(34,197,94,.22); }

        /* two-col grid */
        .chaos-grid {
          display: grid;
          grid-template-columns: 1fr 340px;
          gap: 20px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .chaos-grid { grid-template-columns: 1fr; }
        }

        /* section title */
        .chaos-section-title {
          font-size: 10px;
          letter-spacing: .1em;
          text-transform: uppercase;
          color: var(--ash);
          margin-bottom: 10px;
          padding-left: 2px;
        }

        /* service rows */
        .chaos-service-list { display: flex; flex-direction: column; gap: 10px; }
        .chaos-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 16px;
          border-radius: 12px;
          border-left: 3px solid transparent;
          transition: border-color .2s, opacity .2s;
        }
        .chaos-row--healthy  { border-left-color: var(--ok); }
        .chaos-row--degraded { border-left-color: var(--warn); }
        .chaos-row--down     { border-left-color: var(--danger); opacity: .75; }

        .chaos-row-left { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
        .chaos-row-indicator {
          width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
          box-shadow: 0 0 6px currentColor;
        }
        .chaos-svc-name { font-size: 14px; font-weight: 600; }
        .chaos-svc-meta { display: flex; align-items: center; gap: 8px; margin-top: 2px; flex-wrap: wrap; }
        .chaos-svc-status { font-size: 10px; font-weight: 700; letter-spacing: .07em; }
        .chaos-blast-badge {
          font-size: 9px;
          font-weight: 600;
          letter-spacing: .06em;
          border: 1px solid;
          border-radius: 4px;
          padding: 1px 6px;
          white-space: nowrap;
        }

        /* action buttons */
        .chaos-row-actions { display: flex; gap: 6px; flex-shrink: 0; }
        .chaos-btn {
          padding: 6px 12px;
          border-radius: 7px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid transparent;
          transition: background .18s, opacity .18s;
          white-space: nowrap;
        }
        .chaos-btn:disabled { opacity: .3; cursor: not-allowed; }
        .chaos-btn--stop {
          background: rgba(239,68,68,.12);
          color: var(--danger);
          border-color: rgba(239,68,68,.3);
        }
        .chaos-btn--stop:not(:disabled):hover { background: rgba(239,68,68,.24); }
        .chaos-btn--restart {
          background: rgba(34,197,94,.12);
          color: var(--ok);
          border-color: rgba(34,197,94,.3);
        }
        .chaos-btn--restart:not(:disabled):hover { background: rgba(34,197,94,.24); }

        /* blast panel */
        .blast-panel {
          padding: 18px 16px;
          border-radius: 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .blast-panel-header { display: flex; align-items: center; justify-content: space-between; }
        .blast-panel-title { font-size: 13px; font-weight: 700; letter-spacing: .03em; }
        .blast-panel-desc { font-size: 11px; color: var(--ash); line-height: 1.4; margin: 0; }

        .blast-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
          gap: 10px;
        }

        .blast-cell {
          padding: 12px 10px;
          border-radius: 10px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          border: 1px solid rgba(255,255,255,.06);
          transition: border-color .2s;
        }
        .blast-cell:hover { border-color: var(--blast-color, var(--border)); }

        .blast-cell-name {
          font-size: 10px;
          font-weight: 600;
          text-align: center;
          letter-spacing: .04em;
          text-transform: uppercase;
          color: var(--ash);
        }

        /* conic ring */
        .blast-cell-ring {
          width: 62px;
          height: 62px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 5px;
        }
        .blast-cell-ring-inner {
          width: 100%;
          height: 100%;
          border-radius: 50%;
          background: var(--surface, #0e0e1a);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
        }

        .blast-cell-label {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: .08em;
          text-transform: uppercase;
        }

        .blast-cell-deps {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          justify-content: center;
        }
        .blast-dep-chip {
          font-size: 8px;
          padding: 2px 6px;
          border-radius: 4px;
          background: rgba(255,255,255,.06);
          color: var(--ash);
        }

        /* empty state */
        .chaos-empty {
          padding: 24px;
          border-radius: 12px;
          text-align: center;
          font-size: 13px;
          color: var(--ash);
        }
      `}</style>
    </main>
  );
}