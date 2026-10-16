import type { ExperimentPhase, ExperimentRecord } from "@/lib/api";

export type DashboardMode = "empty" | "loading" | "running" | "completed" | "error";

export function dashboardMode(
  record: ExperimentRecord | null,
  loading: boolean,
  starting: boolean,
): DashboardMode {
  if (starting) return "running";
  if (loading && !record) return "loading";
  if (!record) return "empty";
  if (record.status === "RUNNING" || record.status === "PENDING") return "running";
  if (record.status === "ERROR" || record.verdict === "ERROR") return "error";
  return "completed";
}

export function formatMetric(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unavailable";
  return String(value);
}

export type PhaseSnapshot = {
  key: "baseline" | "fault" | "recovery";
  label: string;
  requests: number | null;
  successful: number | null;
  failed: number | null;
  errorRate: number | null;
  probeCompletion: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  cpu: number | null;
  cpuKnown: boolean;
  memoryBytes: number | null;
  memoryKnown: boolean;
  statuses: string | null;
  ran: boolean;
};

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function phaseSnapshots(record: ExperimentRecord | null): PhaseSnapshot[] {
  const phases = record?.evidence?.phases;
  const rows: Array<["baseline" | "fault" | "recovery", string, ExperimentPhase | null | undefined]> = [
    ["baseline", "Baseline", phases?.baseline],
    ["fault", "Fault", phases?.fault],
    ["recovery", "Recovery", phases?.recovery],
  ];
  return rows.map(([key, label, phase]) => {
    const metrics = phase?.metrics;
    const cpuKnown = phase != null && Object.prototype.hasOwnProperty.call(phase, "cpuPercent");
    const memoryKnown = phase != null && Object.prototype.hasOwnProperty.call(phase, "memoryBytes");
    const codes = metrics?.statusCodes;
    const statuses = codes && Object.keys(codes).length
      ? Object.entries(codes).map(([code, count]) => `${code}: ${count}`).join(", ")
      : null;
    return {
      key,
      label,
      requests: finite(metrics?.totalRequests),
      successful: finite(metrics?.successfulRequests),
      failed: finite(metrics?.failedRequests),
      errorRate: finite(metrics?.errorRatePercent),
      probeCompletion: finite(metrics?.requestsPerSecond),
      p50: finite(metrics?.latencyMs?.p50),
      p95: finite(metrics?.latencyMs?.p95),
      p99: finite(metrics?.latencyMs?.p99),
      cpu: cpuKnown ? finite(phase?.cpuPercent) : null,
      cpuKnown,
      memoryBytes: memoryKnown ? finite(phase?.memoryBytes) : null,
      memoryKnown,
      statuses,
      ran: phase != null,
    };
  });
}

export function barPercent(value: number | null, max: number): number {
  if (value == null || max <= 0) return 0;
  return Math.max(4, Math.min(100, (value / max) * 100));
}

export function seriesMax(values: Array<number | null>): number {
  const present = values.filter((value): value is number => value != null);
  return present.length ? Math.max(...present) : 0;
}

export type TimelineEvent = { label: string; detail: string };

export function timelineEvents(record: ExperimentRecord | null): TimelineEvent[] {
  if (!record) return [];
  const events: TimelineEvent[] = [];
  const phases = record.evidence?.phases;
  for (const [label, phase] of [
    ["Baseline", phases?.baseline],
    ["Fault", phases?.fault],
    ["Recovery", phases?.recovery],
  ] as const) {
    if (!phase) continue;
    const when = [phase.startedAt, phase.finishedAt].filter(Boolean).join(" → ");
    events.push({
      label,
      detail: when || "Phase saved without timestamps.",
    });
    if (phase.execution?.detail) {
      events.push({ label: `${label} check`, detail: phase.execution.detail });
    }
  }
  if (record.evidence?.cleanup?.detail || record.cleanupStatus) {
    events.push({
      label: "Cleanup",
      detail: `${record.evidence?.cleanup?.status || record.cleanupStatus || "unknown"}. ${record.evidence?.cleanup?.detail || ""}`.trim(),
    });
  }
  for (const assertion of record.evidence?.assertions || []) {
    events.push({
      label: assertion.result,
      detail: assertion.name,
    });
  }
  return events;
}
