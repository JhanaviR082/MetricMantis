"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

export interface ServiceNodeData {
  label: string;
  image?: string;
  port?: string;
  status: string;
  dockerTone: string;
  dockerLabel: string;
  healthLabel?: string | null;
  simulationLabel?: string | null;
  icon: string;
  [key: string]: unknown;
}

export function ServiceNode({ data }: NodeProps) {
  const d = data as ServiceNodeData;
  const status = d.status || "unknown";
  const dockerTone = d.dockerTone || "unknown";

  return (
    <div className={`rf-node rf-node--${status}`}>
      <Handle type="target" position={Position.Left} className="rf-handle" />
      {d.simulationLabel && (
        <div className={`rf-node-sim rf-node-sim--${status}`}>
          <span className="rf-node-sim-dot" />
          {d.simulationLabel}
        </div>
      )}
      <div className={`rf-node-status rf-node-status--${dockerTone}`}>{d.dockerLabel}</div>
      {d.healthLabel && <div className="rf-node-health">{d.healthLabel}</div>}
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
