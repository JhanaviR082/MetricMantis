export type RuntimeDisplay = "running" | "healthy" | "unhealthy" | "exited" | "unknown";
export type SimulatedStatus = "healthy" | "degraded" | "down";

export interface ServiceRuntime {
  service: string;
  containerId: string | null;
  state: string;
  health: string;
  display: RuntimeDisplay;
  verified: boolean;
}

export interface SandboxRuntimeSnapshot {
  services: ServiceRuntime[];
  error: string | null;
}

export function sandboxHasRuntime(status: string | null | undefined) {
  return status === "starting"
    || status === "running"
    || status === "stopping"
    || status === "stopped"
    || status === "failed";
}

export function runtimeDisplay(input: { verified: boolean; state: string; health: string }): RuntimeDisplay {
  if (!input.verified) return "unknown";
  if (input.state === "exited" || input.state === "dead" || input.state === "removing") return "exited";
  if (input.health === "healthy") return "healthy";
  if (input.health === "unhealthy") return "unhealthy";
  if (input.state === "running") return "running";
  return "unknown";
}

export function observedServicesMissingFromGraph(
  serviceIds: string[],
  runtime: ServiceRuntime[] | null | undefined,
) {
  const present = new Set(serviceIds);
  return (runtime ?? []).filter((row) => row.verified && row.service && !present.has(row.service));
}

const DOCKER_STATES = new Set(["running", "exited", "created", "paused", "restarting", "dead", "removing"]);

export function simulationLabel(status: SimulatedStatus, fault?: string | null) {
  if (fault) return `Simulation: ${fault}`;
  if (status === "degraded") return "Simulation: affected";
  if (status === "down") return "Simulation: Down";
  return "Simulation: healthy";
}

function dockerState(state: string) {
  return DOCKER_STATES.has(state) ? state : "unknown";
}

function dockerHealth(health: string): "healthy" | "unhealthy" | "unknown" {
  if (health === "healthy" || health === "unhealthy") return health;
  return "unknown";
}

function dockerTone(state: string, health: "healthy" | "unhealthy" | "unknown") {
  if (state === "exited" || state === "dead" || state === "removing") return "exited";
  if (health === "unhealthy") return "unhealthy";
  if (health === "healthy") return "healthy";
  if (state === "running") return "running";
  return "unknown";
}

export function graphNodeView(input: {
  simulatedStatus?: SimulatedStatus | null;
  simulatedFault?: string | null;
  observation: { verified: boolean; state: string; health: string; containerId?: string | null } | null;
  sandboxObserved: boolean;
  runtimeKnown?: boolean;
  inspectionFailed?: boolean;
}) {
  const simulationTone = input.simulatedStatus ?? null;
  const simulation = simulationTone
    ? simulationLabel(simulationTone, input.simulatedFault)
    : null;

  if (input.observation?.verified) {
    const state = dockerState(input.observation.state);
    const health = dockerHealth(input.observation.health);
    return {
      source: "docker" as const,
      tone: dockerTone(state, health),
      simulationTone,
      dockerLabel: `Docker: ${state}`,
      healthLabel: `Health: ${health}`,
      simulationLabel: simulation,
    };
  }

  if (input.observation && !input.observation.verified) {
    if (!input.observation.containerId && !input.inspectionFailed) {
      return {
        source: "docker" as const,
        tone: "absent" as const,
        simulationTone,
        dockerLabel: "Docker: Not running in sandbox",
        healthLabel: null,
        simulationLabel: simulation,
      };
    }
    return {
      source: "docker" as const,
      tone: "unknown" as const,
      simulationTone,
      dockerLabel: "Docker: Unknown",
      healthLabel: null,
      simulationLabel: simulation,
    };
  }

  if (!input.sandboxObserved || input.runtimeKnown) {
    return {
      source: "docker" as const,
      tone: "absent" as const,
      simulationTone,
      dockerLabel: "Docker: Not running in sandbox",
      healthLabel: null,
      simulationLabel: simulation,
    };
  }

  return {
    source: "docker" as const,
    tone: "unknown" as const,
    simulationTone,
    dockerLabel: "Docker: Unknown",
    healthLabel: null,
    simulationLabel: simulation,
  };
}

export function graphCardStatus(view: { simulationTone: SimulatedStatus | null; tone: string }) {
  return view.simulationTone ?? view.tone;
}

export function graphEdgeView(from: SimulatedStatus, to: SimulatedStatus) {
  let tone: SimulatedStatus = "healthy";
  if (from === "down" || to === "down") tone = "down";
  else if (from === "degraded" || to === "degraded") tone = "degraded";
  return { label: "Simulation" as const, tone };
}
