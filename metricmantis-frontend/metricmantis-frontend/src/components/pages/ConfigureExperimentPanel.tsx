"use client";

import { API_BASE_URL } from "@/lib/api";
import { chaosStatusText, FIELD_LIMITS, type ExperimentCapabilities, type MeasuredFault } from "@/lib/experimentForm";

type Service = { id: string; name: string };

const FAULTS: Array<{ value: MeasuredFault; label: string }> = [
  { value: "measure", label: "Measure only" },
  { value: "cpu", label: "CPU limit" },
  { value: "memory", label: "Memory pressure" },
  { value: "stop", label: "Stop" },
  { value: "restart", label: "Restart" },
  { value: "latency", label: "Network latency" },
  { value: "packet_loss", label: "Packet loss" },
];

const NUMBER_FIELDS: Array<{ name: keyof typeof FIELD_LIMITS; label: string }> = [
  { name: "baselineMs", label: "Baseline" },
  { name: "faultDurationMs", label: "Fault window" },
  { name: "recoveryMs", label: "Recovery window" },
  { name: "ratePerSecond", label: "Probe send rate" },
  { name: "concurrency", label: "Concurrency" },
  { name: "timeoutMs", label: "Probe timeout" },
  { name: "maxErrorRatePercent", label: "Max recovery error" },
  { name: "maxP95Ms", label: "Max p95" },
  { name: "recoveryTimeoutMs", label: "Recovery deadline" },
];

export function ConfigureExperimentPanel({
  services,
  sandbox,
  gatePhase,
  target,
  fault,
  hypothesis,
  memoryMib,
  latencyMs,
  lossPercent,
  health,
  values,
  supportReason,
  executable,
  running,
  canCancel,
  caps,
  error,
  onTarget,
  onFault,
  onHypothesis,
  onMemoryMib,
  onLatencyMs,
  onLossPercent,
  onValue,
  onRun,
  onCancel,
}: {
  services: Service[];
  sandbox: { projectName: string; status: string } | null;
  gatePhase: "empty" | "loading" | "unavailable" | "error" | "ready";
  target: string;
  fault: MeasuredFault;
  hypothesis: string;
  memoryMib: number;
  latencyMs: number;
  lossPercent: number;
  health: string;
  values: Record<keyof typeof FIELD_LIMITS, number>;
  supportReason: string;
  executable: boolean;
  running: boolean;
  canCancel: boolean;
  caps: ExperimentCapabilities | null;
  error: string;
  onTarget: (value: string) => void;
  onFault: (value: MeasuredFault) => void;
  onHypothesis: (value: string) => void;
  onMemoryMib: (value: number) => void;
  onLatencyMs: (value: number) => void;
  onLossPercent: (value: number) => void;
  onValue: (name: keyof typeof FIELD_LIMITS, value: number) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="glass mm-exp-card" aria-label="Configure Experiment">
      <div className="slide-label">Configure experiment</div>
      <h2 className="slide-title" style={{ fontSize: 28, margin: "6px 0 8px" }}>
        Run a <span className="grad-text">measured</span> fault
      </h2>
      <p className="page-desc">
        Choose one verified sandbox service, then a fault. The API checks ownership and container labels before it changes anything.
        Results below are measured. A missing number stays unavailable.
      </p>
      <p className="page-desc">Selected target health: {health}.</p>
      <p className="page-desc">
        {sandbox
          ? `Sandbox ${sandbox.projectName} · status ${sandbox.status}.`
          : "No sandbox is selected."}
      </p>
      {gatePhase === "loading" && <p className="page-desc">Loading verified sandbox containers.</p>}
      {gatePhase === "empty" && <p className="page-desc">No sandbox is selected.</p>}
      {gatePhase === "unavailable" && <p className="page-desc">Verified sandbox targets are unavailable.</p>}
      {gatePhase === "error" && <p className="page-desc">Sandbox runtime could not be verified.</p>}
      <p className="page-desc">{supportReason}</p>
      <p className="page-desc">{chaosStatusText(caps, API_BASE_URL)}</p>
      <div className="mm-exp-grid">
        <label className="auth-field">
          <span>Target</span>
          <select className="mm-exp-select" value={target} disabled={running || services.length === 0} onChange={(event) => onTarget(event.target.value)}>
            {services.length === 0 && <option value="">No verified service</option>}
            {services.map((service) => (
              <option key={service.id} value={service.name}>{service.name}</option>
            ))}
          </select>
        </label>
        <label className="auth-field">
          <span>Fault</span>
          <select className="mm-exp-select" value={fault} disabled={running} onChange={(event) => onFault(event.target.value as MeasuredFault)}>
            {FAULTS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        {NUMBER_FIELDS.map((field) => {
          const limit = FIELD_LIMITS[field.name];
          return (
            <label className="auth-field" key={field.name}>
              <span>{field.label} ({limit.unit})</span>
              <input
                className="mm-exp-input"
                type="number"
                min={limit.min}
                max={limit.max}
                step={1}
                value={values[field.name]}
                disabled={running}
                onChange={(event) => onValue(field.name, Number(event.target.value))}
              />
            </label>
          );
        })}
        {fault === "memory" && (
          <label className="auth-field">
            <span>Memory file (MiB)</span>
            <select className="mm-exp-select" value={memoryMib} disabled={running} onChange={(event) => onMemoryMib(Number(event.target.value))}>
              {[4, 8, 12].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        )}
        {fault === "latency" && (
          <label className="auth-field">
            <span>Delay (ms)</span>
            <input className="mm-exp-input" type="number" min={20} max={500} step={1} value={latencyMs} disabled={running} onChange={(event) => onLatencyMs(Number(event.target.value))} />
          </label>
        )}
        {fault === "packet_loss" && (
          <label className="auth-field">
            <span>Loss (%)</span>
            <input className="mm-exp-input" type="number" min={1} max={20} step={1} value={lossPercent} disabled={running} onChange={(event) => onLossPercent(Number(event.target.value))} />
          </label>
        )}
        {fault === "cpu" && (
          <p className="page-desc" style={{ gridColumn: "1 / -1" }}>
            Configured CPU quota: {caps?.cpuQuota ?? 5000} / {caps?.cpuPeriod ?? 100000}.
            The executor applies this fixed quota. The percentage in the dashboard is one stats sample, not this setting.
          </p>
        )}
        <label className="auth-field" style={{ gridColumn: "1 / -1" }}>
          <span>Hypothesis</span>
          <input className="mm-exp-input" value={hypothesis} disabled={running} maxLength={300} onChange={(event) => onHypothesis(event.target.value)} />
        </label>
      </div>
      <p className="page-desc">
        Probe send rate is how fast this panel asks the API to send probes. It is not service capacity.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button type="button" className="btn-primary" disabled={running || !executable || !target} onClick={onRun}>
          {running ? "Running…" : "Run experiment"}
        </button>
        <button type="button" className="chaos-btn chaos-btn--restart" disabled={!canCancel} onClick={onCancel}>
          Cancel run
        </button>
      </div>
      {error && <p className="page-desc" style={{ color: "var(--danger)" }}>{error}</p>}
    </section>
  );
}
