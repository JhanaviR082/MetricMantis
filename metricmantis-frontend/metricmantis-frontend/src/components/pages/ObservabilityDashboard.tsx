"use client";

import type { ExperimentRecord } from "@/lib/api";
import {
  barPercent,
  dashboardMode,
  formatMetric,
  phaseSnapshots,
  seriesMax,
  timelineEvents,
  type DashboardMode,
  type PhaseSnapshot,
} from "@/lib/experimentDashboard";

const PHASE_COLOR = {
  baseline: "var(--pewter)",
  fault: "var(--warn)",
  recovery: "var(--ok)",
} as const;

function verdictColor(verdict: string | null | undefined): string {
  if (verdict === "PASSED") return "var(--ok)";
  if (verdict === "FAILED" || verdict === "ERROR") return "var(--danger)";
  if (verdict === "INCONCLUSIVE" || verdict === "RUNNING" || verdict === "PENDING") return "var(--warn)";
  return "var(--silver)";
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="mm-metric">
      <span className="mm-metric-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PhaseChart({
  title,
  caption,
  points,
}: {
  title: string;
  caption: string;
  points: Array<{ label: string; value: number | null; color: string; missing: string }>;
}) {
  const max = seriesMax(points.map((point) => point.value));
  const any = points.some((point) => point.value != null);
  return (
    <div className="mm-chart">
      <div className="mm-metric-label">{title}</div>
      <p className="page-desc">{caption}</p>
      {!any ? (
        <p className="page-desc">No numeric samples for this chart.</p>
      ) : (
        <div className="mm-bars" aria-hidden="false">
          {points.map((point) => (
            <div key={point.label} className="mm-bar-col">
              <div className="mm-bar-track">
                <div
                  className="mm-bar-fill"
                  style={{
                    height: point.value == null ? "0%" : `${barPercent(point.value, max)}%`,
                    background: point.color,
                  }}
                />
              </div>
              <span>{point.value == null ? point.missing : point.value}</span>
              <span className="mm-metric-label">{point.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function phaseMetric(row: PhaseSnapshot, value: number | null): string {
  return row.ran ? formatMetric(value) : "not run";
}

function phasePoints(rows: PhaseSnapshot[], pick: (row: PhaseSnapshot) => number | null) {
  return rows.map((row) => ({
    label: row.label,
    value: row.ran ? pick(row) : null,
    color: PHASE_COLOR[row.key],
    missing: row.ran ? "unavailable" : "not run",
  }));
}

export function ObservabilityDashboard({
  record,
  loading,
  starting,
}: {
  record: ExperimentRecord | null;
  loading: boolean;
  starting: boolean;
}) {
  const mode: DashboardMode = dashboardMode(record, loading, starting);
  const current = starting && record && record.status !== "RUNNING" && record.status !== "PENDING" ? null : record;
  const rows = phaseSnapshots(current);
  const events = timelineEvents(current);
  const verdict = current?.verdict || current?.status || null;
  const partial = mode === "running" && rows.some((row) => row.requests != null);

  return (
    <section className="glass mm-exp-card" aria-label="Observability Dashboard">
      <div className="slide-label">Observability</div>
      <h2 className="slide-title" style={{ fontSize: 28, margin: "6px 0 8px" }}>
        Experiment <span className="grad-text">dashboard</span>
      </h2>
      {mode === "loading" && <p className="page-desc">Loading the latest saved experiment.</p>}
      {mode === "empty" && (
        <p className="page-desc">
          No experiment is loaded. Counts, latency, CPU, and cleanup stay blank until a run saves real samples.
        </p>
      )}
      {mode === "running" && (
        <p className="page-desc">
          {partial
            ? "Partial phase data has been saved. The verdict is not final."
            : "The run is in progress. Measurements stay blank until the API saves a phase."}
        </p>
      )}
      {mode === "error" && (
        <p className="page-desc" style={{ color: "var(--danger)" }}>
          {record?.error || "The experiment ended with an error."}
        </p>
      )}
      {current && mode !== "empty" && mode !== "loading" && (
        <>
          <p className="page-desc">
            {current.mode} · {current.faultType} on {current.targetService}
            {" · "}
            <strong style={{ color: verdictColor(verdict) }}>{verdict}</strong>
            {current.evidence?.provenance === "observed"
              ? " · observed"
              : current.evidence?.provenance === "predicted"
                ? " · predicted, not measured"
                : " · not measured"}
          </p>
          <p className="page-desc">
            {mode === "running"
              ? "Figures below are phase snapshots saved during the run, not a live capacity chart."
              : "Figures below are the final phase summary for this experiment."}
            {" "}Probe completion is the configured send rate, not service capacity.
          </p>
          <div className="mm-metric-grid">
            <MetricCell label="Cleanup" value={current.evidence?.cleanup?.status || current.cleanupStatus || "unavailable"} />
            <MetricCell label="Service" value={current.targetService} />
          </div>
          {rows.map((row) => (
            <div key={row.key} className="mm-phase">
              <div className="mm-metric-label">{row.label}</div>
              <div className="mm-metric-grid">
                <MetricCell label="Requests" value={phaseMetric(row, row.requests)} />
                <MetricCell label="Succeeded" value={phaseMetric(row, row.successful)} />
                <MetricCell label="Failed" value={phaseMetric(row, row.failed)} />
                <MetricCell label="Error rate %" value={phaseMetric(row, row.errorRate)} />
                <MetricCell label="Probe completion /s" value={phaseMetric(row, row.probeCompletion)} />
                <MetricCell label="p50 ms" value={phaseMetric(row, row.p50)} />
                <MetricCell label="p95 ms" value={phaseMetric(row, row.p95)} />
                <MetricCell label="p99 ms" value={phaseMetric(row, row.p99)} />
                <MetricCell label="Statuses" value={!row.ran ? "not run" : row.statuses || "unavailable"} />
                <MetricCell label="CPU sample %" value={!row.ran ? "not run" : row.cpuKnown ? formatMetric(row.cpu) : "not sampled"} />
                <MetricCell label="Memory bytes" value={!row.ran ? "not run" : row.memoryKnown ? formatMetric(row.memoryBytes) : "not sampled"} />
              </div>
            </div>
          ))}
          <PhaseChart
            title="p95 latency by phase"
            caption="Missing p95 stays unavailable. It is not drawn as zero."
            points={phasePoints(rows, (row) => row.p95)}
          />
          <PhaseChart
            title="Probe completion by phase"
            caption="Completed probes per second at the configured send rate."
            points={phasePoints(rows, (row) => row.probeCompletion)}
          />
          <PhaseChart
            title="CPU sample by phase"
            caption="One docker stats sample per phase when a CPU experiment saved it."
            points={phasePoints(rows, (row) => (row.cpuKnown ? row.cpu : null)).map((point, index) => ({
              ...point,
              missing: !rows[index].ran ? "not run" : rows[index].cpuKnown ? "unavailable" : "not sampled",
            }))}
          />
          {current.evidence?.cpuComparison?.summary && (
            <p className="page-desc">{current.evidence.cpuComparison.summary}</p>
          )}
          <div className="mm-timeline">
            <div className="mm-metric-label">Events</div>
            {events.length === 0 ? (
              <p className="page-desc">No fault, recovery, or cleanup events have been saved.</p>
            ) : (
              events.map((event, index) => (
                <p key={`${event.label}-${index}`} className="page-desc">
                  <strong>{event.label}.</strong> {event.detail}
                </p>
              ))
            )}
          </div>
          {(current.evidence?.assertions || []).map((item) => (
            <p key={item.id} className="page-desc">
              <span style={{ color: verdictColor(item.result) }}>{item.result}</span>
              {": "}{item.name}. Observed {String(item.observed)}.
            </p>
          ))}
          {(current.evidence?.limitations || []).map((item) => (
            <p key={item} className="page-desc">{item}</p>
          ))}
        </>
      )}
    </section>
  );
}
