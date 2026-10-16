import type { DependencyEdge, ParsedService } from "@/lib/composeParser";

export type ControlledFault = "latency" | "cpu" | "packet_loss";

export const FAULT_LABEL: Record<ControlledFault, string> = {
  latency: "Latency",
  cpu: "CPU stress",
  packet_loss: "Packet loss",
};

export function applyControlledFault(
  services: ParsedService[],
  edges: DependencyEdge[],
  targetId: string,
  fault: ControlledFault,
): { services: ParsedService[]; affected: string[] } {
  const target = services.find((s) => s.id === targetId);
  if (!target || target.status === "down") {
    return { services, affected: [] };
  }

  const names = new Set<string>([target.name]);
  if (fault !== "cpu") {
    for (const edge of edges) {
      if (edge.to === target.name) names.add(edge.from);
    }
  }

  const next = services.map((service) => {
    if (!names.has(service.name) || service.status === "down") return service;
    return { ...service, status: "degraded" as const };
  });

  const affected = next
    .filter((service) => names.has(service.name) && service.status === "degraded")
    .map((service) => service.name);

  return { services: next, affected };
}
