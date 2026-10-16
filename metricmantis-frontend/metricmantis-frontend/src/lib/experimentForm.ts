export const FIELD_LIMITS = {
  baselineMs: { min: 200, max: 10000, fallback: 2000, unit: "ms" },
  faultDurationMs: { min: 200, max: 15000, fallback: 2000, unit: "ms" },
  recoveryMs: { min: 200, max: 10000, fallback: 2000, unit: "ms" },
  ratePerSecond: { min: 1, max: 20, fallback: 5, unit: "probes/s" },
  concurrency: { min: 1, max: 4, fallback: 2, unit: "in flight" },
  timeoutMs: { min: 200, max: 5000, fallback: 1000, unit: "ms" },
  maxErrorRatePercent: { min: 0, max: 100, fallback: 5, unit: "%" },
  maxP95Ms: { min: 1, max: 30000, fallback: 1000, unit: "ms" },
  recoveryTimeoutMs: { min: 200, max: 20000, fallback: 5000, unit: "ms" },
} as const;

export type FieldName = keyof typeof FIELD_LIMITS;

export type ExperimentCapabilities = {
  dockerAvailable: boolean;
  chaosEnabled: boolean;
  allowlist: string[];
  stop?: boolean;
  restart?: boolean;
  cpu?: boolean;
  memory?: boolean;
  cpuQuota?: number;
  cpuPeriod?: number;
  memoryMib?: number[];
  latency?: boolean;
  packetLoss?: boolean;
  maxLatencyMs?: number;
  maxLossPercent?: number;
  networkFaultReason: string;
  probeAllowlist?: string[];
  startupMode?: "chaos" | "normal";
};

export function chaosStatusText(
  caps: Pick<ExperimentCapabilities, "chaosEnabled" | "allowlist" | "startupMode"> | null,
  apiBase: string,
): string {
  if (!caps) return `Chaos status is unavailable from ${apiBase}.`;
  const allowlist = caps.allowlist.length ? caps.allowlist.join(", ") : "none";
  const mode = caps.startupMode ? ` Mode: ${caps.startupMode}.` : "";
  return `Connected to ${apiBase}. Real chaos is ${caps.chaosEnabled ? "on" : "off"}. Allowlist: ${allowlist}.${mode}`;
}

export type MeasuredFault = "measure" | "stop" | "restart" | "cpu" | "memory" | "latency" | "packet_loss";

const CONTAINER_ID = /^[a-f0-9]{64}$/;
const HTTP_TARGETS = new Set(["web-app", "api"]);

function withoutHttpProbe(target: string, reason: string): string {
  if (HTTP_TARGETS.has(target)) return reason;
  return `${reason} This service has no approved HTTP health endpoint, so request counts and latency stay unavailable.`;
}

export interface VerifiedSandboxTarget {
  service: string;
  containerId: string;
}

export function verifiedSandboxTargets(
  services: Array<{ service: string; verified: boolean; containerId: string | null }> | null | undefined,
): VerifiedSandboxTarget[] {
  return (services ?? []).flatMap((service) => (
    service.verified && service.service && CONTAINER_ID.test(service.containerId || "")
      ? [{ service: service.service, containerId: service.containerId as string }]
      : []
  ));
}

export function measuredSandboxGate(input: {
  sandbox: { projectName: string; status: string } | null;
  runtimeKnown: boolean;
  runtimeError: string | null;
  verifiedTargets: VerifiedSandboxTarget[];
  selected: string;
}): { ready: boolean; phase: "empty" | "loading" | "unavailable" | "error" | "ready"; reason: string } {
  if (!input.sandbox) {
    return {
      ready: false,
      phase: "empty",
      reason: "No sandbox is selected. Run a sandbox before starting a measured experiment.",
    };
  }
  if (input.sandbox.status === "starting" || input.sandbox.status === "stopping") {
    return { ready: false, phase: "loading", reason: `Sandbox ${input.sandbox.projectName} is ${input.sandbox.status}.` };
  }
  if (input.sandbox.status === "running" && !input.runtimeKnown && !input.runtimeError) {
    return { ready: false, phase: "loading", reason: `Checking verified containers for ${input.sandbox.projectName}.` };
  }
  if (input.runtimeError) {
    return { ready: false, phase: "error", reason: input.runtimeError };
  }
  if (input.sandbox.status !== "running") {
    return {
      ready: false,
      phase: "unavailable",
      reason: `Sandbox ${input.sandbox.projectName} is ${input.sandbox.status}, so a measured experiment cannot run.`,
    };
  }
  if (input.verifiedTargets.length === 0) {
    return {
      ready: false,
      phase: "unavailable",
      reason: "No verified sandbox container is available. Uploaded service names are not used as targets.",
    };
  }
  if (!input.verifiedTargets.some((target) => target.service === input.selected)) {
    return {
      ready: false,
      phase: "unavailable",
      reason: "The selected service is not a verified container in this sandbox.",
    };
  }
  return { ready: true, phase: "ready", reason: `Sandbox ${input.sandbox.projectName} is running.` };
}

export function measuredFaultSupport(
  fault: MeasuredFault,
  caps: ExperimentCapabilities | null,
  target: string,
): { executable: boolean; reason: string } {
  if (fault === "measure") {
    if (!HTTP_TARGETS.has(target)) {
      return { executable: false, reason: "This sandbox service has no approved HTTP health endpoint." };
    }
    return {
      executable: true,
      reason: "Probes run inside the sandbox network against the verified service health endpoint. No fault is injected.",
    };
  }
  if (fault === "latency" && caps?.latency !== true) {
    return { executable: false, reason: caps?.networkFaultReason || "Network latency is not available." };
  }
  if (fault === "packet_loss" && caps?.packetLoss !== true) {
    return { executable: false, reason: caps?.networkFaultReason || "Packet loss is not available." };
  }
  if (!caps) return { executable: false, reason: "Experiment capabilities are still loading." };
  if (!caps.dockerAvailable) return { executable: false, reason: "Docker is not available, so this fault cannot run." };
  if (!caps.chaosEnabled) return { executable: false, reason: "Real container faults are off. The API will not change a container." };
  if (!caps.allowlist.includes(target)) {
    return { executable: false, reason: `${target || "This target"} is not on the chaos allowlist.` };
  }
  if (fault === "stop" && caps.stop !== false) {
    return { executable: true, reason: withoutHttpProbe(target, "Stop counts only when inspect shows the container leave the running state.") };
  }
  if (fault === "restart" && caps.restart !== false) {
    return { executable: true, reason: withoutHttpProbe(target, "Restart counts only when inspect shows a newer start time.") };
  }
  if (fault === "memory" && caps.memory !== false) {
    return {
      executable: true,
      reason: withoutHttpProbe(target, "Memory pressure is a 4, 8, or 12 MiB file in the container. It is removed before recovery, and a missing memory sample stays unavailable."),
    };
  }
  if ((fault === "latency" || fault === "packet_loss") && caps.chaosEnabled) {
    return {
      executable: true,
      reason: withoutHttpProbe(
        target,
        fault === "latency"
          ? "Latency is a bounded netem delay on the verified container egress interface. It counts only when tc qdisc show on that interface reports the requested delay."
          : "Packet loss is a bounded netem loss on the verified container egress interface. It counts only when tc qdisc show on that interface reports the requested loss.",
      ),
    };
  }
  if (fault === "cpu" && caps.cpu !== false) {
    const quota = caps.cpuQuota ?? 5000;
    const period = caps.cpuPeriod ?? 100000;
    return {
      executable: true,
      reason: withoutHttpProbe(target, `CPU quota is fixed at ${quota}/${period}, about 5% of one core. It is not a free-form percentage.`),
    };
  }
  return { executable: false, reason: "This fault is not executable with the current executor." };
}

function integerField(value: number, name: FieldName): string | null {
  const limit = FIELD_LIMITS[name];
  if (!Number.isInteger(value)) return `${name} must be a whole number.`;
  if (value < limit.min || value > limit.max) {
    return `${name} must be from ${limit.min} to ${limit.max} ${limit.unit}.`;
  }
  return null;
}

export function validateMeasuredForm(input: {
  target: string;
  fault: MeasuredFault;
  probeUrl: string;
  hypothesis: string;
  baselineMs: number;
  faultDurationMs: number;
  recoveryMs: number;
  ratePerSecond: number;
  concurrency: number;
  timeoutMs: number;
  maxErrorRatePercent: number;
  maxP95Ms: number;
  recoveryTimeoutMs: number;
  executable: boolean;
  blockedReason: string;
}): { error: string | null } {
  if (!input.target) return { error: "Choose one target service." };
  if (!input.executable) return { error: input.blockedReason };
  const fields: Array<[FieldName, number]> = [
    ["baselineMs", input.baselineMs],
    ["faultDurationMs", input.faultDurationMs],
    ["recoveryMs", input.recoveryMs],
    ["ratePerSecond", input.ratePerSecond],
    ["concurrency", input.concurrency],
    ["timeoutMs", input.timeoutMs],
    ["maxErrorRatePercent", input.maxErrorRatePercent],
    ["maxP95Ms", input.maxP95Ms],
    ["recoveryTimeoutMs", input.recoveryTimeoutMs],
  ];
  for (const [name, value] of fields) {
    const error = integerField(value, name);
    if (error) return { error };
  }
  if (input.hypothesis.length > 300) return { error: "Hypothesis must be 300 characters or fewer." };
  return { error: null };
}
