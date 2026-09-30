"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ServiceStatus } from "@/lib/composeParser";

export interface ServiceNodeData {
  label: string;
  image?: string;
  port?: string;
  status: ServiceStatus;
  icon: string;
  [key: string]: unknown;
}

const STATUS_LABEL: Record<ServiceStatus, string> = {
  healthy: "Healthy",
  degraded: "Affected",
  down: "Offline",
};

export function ServiceNode({ data }: NodeProps) {
  const d = data as ServiceNodeData;
  const status = d.status ?? "healthy";

  return (
    <div className={`rf-node rf-node--${status}`}>
      <Handle type="target" position={Position.Left} className="rf-handle" />
      <div className="rf-node-status">{STATUS_LABEL[status]}</div>
      <div className="rf-node-icon">{d.icon}</div>
      <div className="rf-node-name">{d.label}</div>
      <div className="rf-node-meta">
        {d.image?.split(":")[0] ?? "service"}
        {d.port ? ` · ${d.port}` : ""}
      </div>
      <Handle type="source" position={Position.Right} className="rf-handle" />
    </div>
  );
}
