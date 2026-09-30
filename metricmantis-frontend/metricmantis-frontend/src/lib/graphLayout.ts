import type { DependencyEdge, ParsedService } from "@/lib/composeParser";

export interface GraphNodePosition {
  id: string;
  x: number;
  y: number;
  layer: number;
}

const NODE_W = 200;
const NODE_H = 100;
const GAP_X = 120;
const GAP_Y = 90;

/** Consumers on the left, dependencies on the right (web-app → api → db). */
export function computeGraphLayout(
  services: ParsedService[],
  edges: DependencyEdge[],
): GraphNodePosition[] {
  if (services.length === 0) return [];

  const layer = new Map<string, number>();
  for (const s of services) layer.set(s.name, 0);

  for (const e of edges) {
    const next = (layer.get(e.from) ?? 0) + 1;
    layer.set(e.to, Math.max(layer.get(e.to) ?? 0, next));
  }

  const byLayer = new Map<number, string[]>();
  for (const s of services) {
    const l = layer.get(s.name) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(s.name);
  }

  const positions: GraphNodePosition[] = [];
  const layers = [...byLayer.keys()].sort((a, b) => a - b);

  for (const layer of layers) {
    const names = byLayer.get(layer)!.sort();
    const count = names.length;
    names.forEach((name, i) => {
      const x = layer * (NODE_W + GAP_X) + 40;
      const y = (i - (count - 1) / 2) * (NODE_H + GAP_Y) + 180;
      positions.push({ id: name, x, y, layer });
    });
  }

  return positions;
}

export function getDependencyChain(
  services: ParsedService[],
  edges: DependencyEdge[],
): string {
  const sources = services.filter(
    (s) => !edges.some((e) => e.from === s.name),
  );
  if (sources.length === 0 && services.length > 0) {
    return services.map((s) => s.name).join(" · ");
  }

  const paths: string[] = [];
  for (const src of sources) {
    const path = [src.name];
    let cur = src.name;
    const visited = new Set<string>([cur]);
    while (true) {
      const edge = edges.find((e) => e.from === cur);
      if (!edge || visited.has(edge.to)) break;
      path.push(edge.to);
      visited.add(edge.to);
      cur = edge.to;
    }
    paths.push(path.join(" → "));
  }

  return paths.length ? paths.join("  |  ") : services.map((s) => s.name).join(" → ");
}
