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
import { computeGraphLayout } from "@/lib/graphLayout";

const nodeTypes = { service: ServiceNode };

function serviceIcon(name: string, image?: string): string {
  const n = `${name} ${image ?? ""}`.toLowerCase();
  if (/db|mysql|postgres|mongo|redis|database/.test(n)) return "🗄️";
  if (/api|backend|server|spring|node/.test(n)) return "⚙️";
  if (/web|front|nginx|ui/.test(n)) return "🌐";
  return "📦";
}

function edgeStyle(fromStatus: string, toStatus: string) {
  if (fromStatus === "down" || toStatus === "down") {
    return { stroke: "#ef4444", strokeWidth: 2, animated: true };
  }
  if (fromStatus === "degraded" || toStatus === "degraded") {
    return { stroke: "#f59e0b", strokeWidth: 2, animated: true };
  }
  return { stroke: "#10b981", strokeWidth: 1.5, animated: false };
}

interface Props {
  nodes: any[];
  edges: any[];
}

export function DependencyGraph({ nodes, edges }: Props) {
  // layout positions
  const layout = useMemo(() => {
    return computeGraphLayout(nodes, edges);
  }, [nodes, edges]);

  // safe status lookup (NO Map, avoids stale chaos issues)
  const getStatus = (id: string) =>
    nodes.find((n) => n.id === id)?.status ?? "healthy";

  // FLOW NODES
  const flowNodes: Node[] = useMemo(() => {
    return layout.map((pos: any) => {
      const s = nodes.find((x) => x.id === pos.id);

      if (!s) {
        return {
          id: pos.id,
          type: "service",
          position: { x: pos.x, y: pos.y },
          data: {
            label: pos.id,
            status: "healthy",
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
          status: s.status ?? "healthy",
          icon: serviceIcon(s.id, s.image),
        } satisfies ServiceNodeData,
      };
    });
  }, [layout, nodes]);

  // FLOW EDGES
  const flowEdges: Edge[] = useMemo(() => {
    return edges.map((e) => {
      const fromSt = getStatus(e.from);
      const toSt = getStatus(e.to);

      const style = edgeStyle(fromSt, toSt);

      return {
        id: `${e.from}-${e.to}`,
        source: e.from,
        target: e.to,
        type: "smoothstep",
label: "depends on",

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
            if (st === "down") return "#ef4444";
            if (st === "degraded") return "#f59e0b";
            return "#10b981";
          }}
        />
      </ReactFlow>
    </div>
  );
}