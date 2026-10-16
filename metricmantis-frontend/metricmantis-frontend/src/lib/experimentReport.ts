import type { ExperimentPhase, ExperimentRecord } from "@/lib/api";
import type { ReportSection } from "@/lib/reportBuilder";

function metricLine(label: string, phase?: ExperimentPhase | null) {
  const metrics = phase?.metrics;
  if (!metrics || metrics.totalRequests === 0) {
    return `${label}: no requests recorded. Rates and latency are unavailable.`;
  }
  const latency = metrics.latencyMs;
  const hasCpuSample = phase != null && Object.prototype.hasOwnProperty.call(phase, "cpuPercent");
  const cpu = hasCpuSample
    ? ` CPU sample ${phase?.cpuPercent == null ? "unavailable" : `${phase.cpuPercent}%`}.`
    : "";
  const rateLabel = hasCpuSample ? "probe completion " : "";
  return [
    `${label}: ${metrics.totalRequests} requests, ${rateLabel}${metrics.requestsPerSecond ?? "n/a"} req/s, error rate ${metrics.errorRatePercent ?? "n/a"}%.`,
    `Latency ms — average ${latency.average ?? "n/a"}, p50 ${latency.p50 ?? "n/a"}, p95 ${latency.p95 ?? "n/a"}, p99 ${latency.p99 ?? "n/a"}.${cpu}`,
  ].join(" ");
}

export function buildMeasuredSection(experiment: ExperimentRecord | null): ReportSection | null {
  if (!experiment?.evidence) return null;
  const evidence = experiment.evidence;
  const observed = evidence.provenance === "observed";
  const bullets = [
    `Experiment ${experiment.id}. Mode: ${experiment.mode}. Data: ${observed ? "observed measurements" : "simulation, not measured"}.`,
    `Target: ${experiment.targetService}. Fault: ${experiment.faultType}. Verdict: ${experiment.verdict || experiment.status}.`,
    metricLine("Baseline", evidence.phases?.baseline),
  ];
  if (evidence.phases?.fault) bullets.push(metricLine("Fault window", evidence.phases.fault));
  if (evidence.phases?.recovery) bullets.push(metricLine("Recovery", evidence.phases.recovery));
  if (evidence.cpuComparison?.summary) bullets.push(evidence.cpuComparison.summary);
  if (evidence.observedImpact && evidence.observedImpact !== evidence.cpuComparison?.summary) {
    bullets.push(evidence.observedImpact);
  }
  if (evidence.declaredDependents?.length) {
    bullets.push(`Declared Compose dependents (not observed failures): ${evidence.declaredDependents.join(", ")}.`);
  }
  for (const item of evidence.assertions || []) {
    bullets.push(`${item.result} — ${item.name}. Expected ${String(item.expected)}. Observed ${String(item.observed)}.`);
  }
  if (evidence.cleanup?.detail) bullets.push(`Cleanup: ${evidence.cleanup.status}. ${evidence.cleanup.detail}`);
  for (const limit of evidence.limitations || []) bullets.push(limit);
  if (experiment.error) bullets.push(experiment.error);

  return {
    id: "measured-experiment",
    number: "10",
    title: observed ? "Measured Experiment" : "Simulated Experiment Record",
    paragraphs: [
      evidence.hypothesis || "No hypothesis was recorded.",
      observed
        ? "Numbers in this section were calculated from probe samples or Docker inspection for this run."
        : "This record does not contain live measurements.",
    ],
    bullets,
  };
}
