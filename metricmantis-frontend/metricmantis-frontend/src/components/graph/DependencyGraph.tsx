"use client";

import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { ServiceNode, type ServiceNodeData } from "@/components/graph/ServiceNode";
import { FAULT_LABEL, type ControlledFault } from "@/lib/chaosFaults";
import type { DependencyEdge, ParsedService } from "@/lib/composeParser";
import { computeGraphLayout, type GraphNodePosition } from "@/lib/graphLayout";
import { graphCardStatus, graphEdgeView, graphNodeView, observedServicesMissingFromGraph, type ServiceRuntime } from "@/lib/sandboxRuntime";

const nodeTypes = { service: ServiceNode };

function serviceIcon(name: string, image?: string): string {
  const n = `${name} ${image ?? ""}`.toLowerCase();
  if (/db|mysql|postgres|mongo|redis|database/.test(n)) return "🗄️";
  if (/api|backend|server|spring|node/.test(n)) return "⚙️";
  if (/web|front|nginx|ui/.test(n)) return "🌐";
  return "📦";
}

function edgeStyle(tone: "healthy" | "degraded" | "down") {
  if (tone === "down") return { stroke: "#ef4444", strokeWidth: 2, animated: true };
  if (tone === "degraded") return { stroke: "#f59e0b", strokeWidth: 2, animated: true };
  return { stroke: "#10b981", strokeWidth: 1.5, animated: false };
}

interface Props {
  nodes: ParsedService[];
  edges: DependencyEdge[];
  faultLabels?: Record<string, ControlledFault>;
  runtime?: Record<string, ServiceRuntime>;
  sandboxObserved?: boolean;
  runtimeKnown?: boolean;
  inspectionFailed?: boolean;
}

export function DependencyGraph({
  nodes,
  edges,
  faultLabels = {},
  runtime = {},
  sandboxObserved = false,
  runtimeKnown = false,
  inspectionFailed = false,
}: Props) {
  // layout positions
  const layout = useMemo(() => {
    return computeGraphLayout(nodes, edges);
  }, [nodes, edges]);

  const flowNodes: Node[] = useMemo(() => {
    const placed = layout.map((pos: GraphNodePosition) => {
      const s = nodes.find((node) => node.id === pos.id);

      const view = graphNodeView({
        simulatedStatus: s?.status ?? "healthy",
        simulatedFault: s && faultLabels[s.id] ? FAULT_LABEL[faultLabels[s.id]] : null,
        observation: s ? runtime[s.id] ?? null : null,
        sandboxObserved,
        runtimeKnown,
        inspectionFailed,
      });

      if (!s) {
        return {
          id: pos.id,
          type: "service",
          position: { x: pos.x, y: pos.y },
          data: {
            label: pos.id,
            status: graphCardStatus(view),
            dockerTone: view.tone,
            dockerLabel: view.dockerLabel,
            healthLabel: view.healthLabel,
            simulationLabel: view.simulationLabel,
            icon: "📦",
          } satisfies ServiceNodeData,
        };
      }

      return {
        id: pos.id,
        type: "service",
        position: { x: pos.x, y: pos.y },
        data: {
          label: s.id,
          image: s.image ?? "",
          port: s.ports?.[0] ?? "",
          status: graphCardStatus(view),
          dockerTone: view.tone,
          dockerLabel: view.dockerLabel,
          healthLabel: view.healthLabel,
          simulationLabel: view.simulationLabel,
          icon: serviceIcon(s.id, s.image),
        } satisfies ServiceNodeData,
      };
    });

    const maxX = layout.reduce((max, pos) => Math.max(max, pos.x), 0);
    const missing = observedServicesMissingFromGraph(nodes.map((node) => node.id), Object.values(runtime));
    missing.forEach((row, index) => {
      const view = graphNodeView({
        observation: row,
        sandboxObserved: true,
        runtimeKnown,
      });
      placed.push({
        id: row.service,
        type: "service",
        position: { x: maxX + 320, y: 180 + index * 190 },
        data: {
          label: row.service,
          status: graphCardStatus(view),
          dockerTone: view.tone,
          dockerLabel: view.dockerLabel,
          healthLabel: view.healthLabel,
          simulationLabel: view.simulationLabel,
          icon: serviceIcon(row.service),
        } satisfies ServiceNodeData,
      });
    });
    return placed;
  }, [layout, nodes, faultLabels, runtime, sandboxObserved, runtimeKnown, inspectionFailed]);

  const flowEdges: Edge[] = useMemo(() => {
    const simulatedStatus = (id: string) => nodes.find((node) => node.id === id)?.status ?? "healthy";
    return edges.map((edge) => {
      const view = graphEdgeView(simulatedStatus(edge.from), simulatedStatus(edge.to));
      const style = edgeStyle(view.tone);

      return {
        id: `${edge.from}-${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
        label: view.label,
        labelStyle: {
          fill: "rgba(255,255,255,0.72)",
          fontSize: 10,
          fontFamily: "var(--mono)",
          fontWeight: 500,
        },
        labelBgStyle: {
          fill: "rgba(0,0,0,0.95)",
          stroke: "rgba(255,255,255,0.08)",
          strokeWidth: 1,
          rx: 10,
          ry: 6,
        },
        style,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: style.stroke,
        },
      };
    });
  }, [edges, nodes]);

  return (
    <div className="rf-wrapper glass">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.35 }}
        minZoom={0.4}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background gap={20} color="rgba(255,255,255,0.04)" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            const st = (n.data as ServiceNodeData).status;
            if (st === "down" || st === "exited") return "#ef4444";
            if (st === "degraded" || st === "unhealthy") return "#f59e0b";
            if (st === "running") return "#93c5fd";
            if (st === "unknown" || st === "absent") return "#5a5450";
            return "#10b981";
          }}
        />
      </ReactFlow>
    </div>
  );
}