"use client";

import { useMemo } from "react";
import { useSystem } from "@/context/SystemContext";
import { buildStructuredReport } from "@/lib/reportBuilder";
import { ResilienceAdvisor } from "@/components/ResilienceAdvisor";
import type { AdvisorReport } from "@/lib/api";

function scoreColor(val: number): string {
  if (val >= 8) return "var(--ok)";
  if (val >= 5) return "var(--warn)";
  return "var(--danger)";
}

function parseScore(scoreStr: string): number {
  return parseFloat(scoreStr.split("/")[0]) ?? 0;
}

export function ReportPage() {
  const { services, edges, chaosEvents, restartPolicies, findings, setPage } =
    useSystem();

  const { sections, scores } = useMemo(
    () => buildStructuredReport(services, edges, chaosEvents, restartPolicies),
    [services, edges, chaosEvents, restartPolicies],
  );

  const criticalFindings = findings.filter((f) => f.severity === "critical");
  const warningFindings = findings.filter((f) => f.severity === "warning");

  // Assembled report payload for the Advisor — never sent to frontend consumers,
  // only forwarded to the backend on user action.
  const advisorReport = useMemo<AdvisorReport>(
    () => ({
      scores,
      sections: sections.map((s) => ({
        id: s.id,
        title: s.title,
        paragraphs: s.paragraphs,
        bullets: s.bullets,
      })),
      findings: findings.map((f) => ({ severity: f.severity, message: `${f.title}: ${f.detail}` })),
    }),
    [scores, sections, findings],
  );

  return (
    <main className="app-page">
      <div className="page-content report-page-content">
        <div className="slide-label">Resilience analysis</div>
        <h1 className="slide-title">
          System <span className="grad-text">Report</span>
        </h1>
        <p className="page-desc">
          Structured analysis from your compose file, dependency graph, and
          chaos experiments.
        </p>

        {/* ── findings banner ── (unchanged from original) */}
        {(criticalFindings.length > 0 || warningFindings.length > 0) && (
          <div className="report-findings-bar">
            {criticalFindings.length > 0 && (
              <div className="report-finding-chip critical">
                <span className="chip-dot" />
                {criticalFindings.length} critical finding
                {criticalFindings.length > 1 ? "s" : ""}
              </div>
            )}
            {warningFindings.length > 0 && (
              <div className="report-finding-chip warning">
                <span className="chip-dot" />
                {warningFindings.length} warning
                {warningFindings.length > 1 ? "s" : ""}
              </div>
            )}
            <div className="report-finding-chip info">
              <span className="chip-dot" />
              Overall score:&nbsp;
              <strong style={{ color: scoreColor(scores.overall) }}>
                {scores.overall}/10
              </strong>
            </div>
          </div>
        )}

        {/* ── Resilience Advisor ── */}
        <div className="advisor-float">
          <ResilienceAdvisor report={advisorReport} />
        </div>

        <div className="report-doc">
          {sections.map((section) => (
            <section key={section.id} className="report-section glass">
              {section.number && (
                <div className="report-section-num">{section.number}</div>
              )}
              {section.title && (
                <h2 className="report-section-title">{section.title}</h2>
              )}

              {section.paragraphs.map((p, i) => (
                <p key={i} className="report-p">
                  {p}
                </p>
              ))}

              {section.bullets && (
                <ul className="report-ul">
                  {section.bullets.map((b, i) => {
                    const isSub = b.startsWith("↳");
                    return (
                      <li
                        key={i}
                        className={isSub ? "report-li-sub" : undefined}
                        style={isSub ? { color: "var(--ash)", marginLeft: "1.4rem", listStyle: "none" } : undefined}
                      >
                        {b}
                      </li>
                    );
                  })}
                </ul>
              )}

              {section.code && (
                <pre className="report-code">{section.code}</pre>
              )}

              {section.log && (
                <pre className="report-log">{section.log}</pre>
              )}

              {section.table && (
                <table className="report-table">
                  <tbody>
                    {section.table.map((row) => {
                      const val = parseScore(row.score);
                      return (
                        <tr key={row.label}>
                          <td>{row.label}</td>
                          <td>
                            <span
                              className="report-score-pill"
                              style={{
                                color: scoreColor(val),
                                borderColor: scoreColor(val),
                              }}
                            >
                              {row.score}
                            </span>
                          </td>
                          <td className="report-score-bar-cell">
                            <div className="report-score-bar-track">
                              <div
                                className="report-score-bar-fill"
                                style={{
                                  width: `${(val / 10) * 100}%`,
                                  background: scoreColor(val),
                                }}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {section.id === "scores" && (
                <p className="report-score-final">
                  Overall:{" "}
                  <strong style={{ color: scoreColor(scores.overall) }}>
                    {scores.overall}/10
                  </strong>
                </p>
              )}
            </section>
          ))}
        </div>

        <div className="hero-actions" style={{ marginTop: 24 }}>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setPage("upload")}
          >
            Run another analysis
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setPage("chaos")}
          >
            Back to chaos controls
          </button>
        </div>
      </div>

      <style>{`
        /* Make the content column the positioning parent for the floated advisor */
        .report-page-content {
          position: relative;
        }

        /* Advisor floated into the right-side empty space beside the report column */
        .advisor-float {
          position: absolute;
          /* sit just to the right of the 720px content column with a gap */
          left: calc(100% + 20px);
          top: 0;
          width: 300px;
        }

        /* Hide when there isn't enough horizontal room (viewport too narrow) */
        @media (max-width: 1120px) {
          .advisor-float {
            display: none;
          }
        }

        /* findings banner — exactly as original */
        .report-findings-bar {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 24px;
        }
        .report-finding-chip {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
          border: 1px solid transparent;
        }
        .report-finding-chip.critical {
          background: rgba(239,68,68,.1);
          color: var(--danger);
          border-color: rgba(239,68,68,.25);
        }
        .report-finding-chip.warning {
          background: rgba(234,179,8,.1);
          color: var(--warn);
          border-color: rgba(234,179,8,.25);
        }
        .report-finding-chip.info {
          background: rgba(255,255,255,.05);
          color: var(--text);
          border-color: var(--border);
        }
        .chip-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: currentColor;
          flex-shrink: 0;
        }

        /* score table bar column */
        .report-score-pill {
          font-size: 12px;
          font-weight: 700;
          border: 1px solid;
          border-radius: 6px;
          padding: 2px 8px;
          white-space: nowrap;
        }
        .report-score-bar-cell { width: 120px; padding-left: 12px; }
        .report-score-bar-track {
          height: 4px;
          background: rgba(255,255,255,.08);
          border-radius: 2px;
          overflow: hidden;
        }
        .report-score-bar-fill {
          height: 100%;
          border-radius: 2px;
          transition: width .4s ease;
        }
      `}</style>
    </main>
  );
}