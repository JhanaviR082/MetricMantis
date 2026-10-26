"use client";

import { useEffect, useState } from "react";
import { ConfigureExperimentPanel } from "@/components/pages/ConfigureExperimentPanel";
import { ObservabilityDashboard } from "@/components/pages/ObservabilityDashboard";
import {
  cancelExperiment,
  getExperiment,
  getExperimentCapabilities,
  listExperiments,
  runExperiment,
  type ExperimentRecord,
  type SandboxRecord,
} from "@/lib/api";
import {
  FIELD_LIMITS,
  measuredFaultSupport,
  measuredSandboxGate,
  validateMeasuredForm,
  verifiedSandboxTargets,
  type ExperimentCapabilities,
  type FieldName,
  type MeasuredFault,
} from "@/lib/experimentForm";
import type { ServiceRuntime } from "@/lib/sandboxRuntime";

const DEFAULTS = {
  baselineMs: FIELD_LIMITS.baselineMs.fallback,
  faultDurationMs: FIELD_LIMITS.faultDurationMs.fallback,
  recoveryMs: FIELD_LIMITS.recoveryMs.fallback,
  ratePerSecond: FIELD_LIMITS.ratePerSecond.fallback,
  concurrency: FIELD_LIMITS.concurrency.fallback,
  timeoutMs: FIELD_LIMITS.timeoutMs.fallback,
  maxErrorRatePercent: FIELD_LIMITS.maxErrorRatePercent.fallback,
  maxP95Ms: FIELD_LIMITS.maxP95Ms.fallback,
  recoveryTimeoutMs: FIELD_LIMITS.recoveryTimeoutMs.fallback,
};

export function ExperimentWorkspace({
  edges,
  sandbox,
  runtimeServices,
  runtimeError,
  runtimeKnown,
  onRunStarted,
  mode = "configure",
}: {
  edges: { from: string; to: string }[];
  sandbox: SandboxRecord | null;
  runtimeServices: ServiceRuntime[] | null;
  runtimeError: string | null;
  runtimeKnown: boolean;
  onRunStarted?: () => void;
  mode?: "configure" | "observe" | "both";
}) {
  const verified = verifiedSandboxTargets(runtimeServices);
  const [target, setTarget] = useState("");
  const selected = verified.some((service) => service.service === target) ? target : (verified[0]?.service || "");
  const gate = measuredSandboxGate({
    sandbox,
    runtimeKnown,
    runtimeError,
    verifiedTargets: verified,
    selected,
  });
  const [fault, setFault] = useState<MeasuredFault>("measure");
  const [memoryMib, setMemoryMib] = useState(8);
  const [latencyMs, setLatencyMs] = useState(100);
  const [lossPercent, setLossPercent] = useState(5);
  const [hypothesis, setHypothesis] = useState("The service stays within its error and latency limits.");
  const [values, setValues] = useState(DEFAULTS);
  const [caps, setCaps] = useState<ExperimentCapabilities | null>(null);
  const [record, setRecord] = useState<ExperimentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const support = measuredFaultSupport(fault, caps, selected);
  const executable = gate.ready && support.executable;
  const supportReason = gate.ready ? support.reason : gate.reason;
  const running = starting || record?.status === "RUNNING" || record?.status === "PENDING";

  useEffect(() => {
    let active = true;
    getExperimentCapabilities()
      .then((next) => { if (active) setCaps(next); })
      .catch(() => { if (active) setCaps(null); });
    listExperiments(1)
      .then((body) => { if (active) setRecord(body.experiments[0] || null); })
      .catch(() => undefined)
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const recordId = record?.id;
  const recordStatus = record?.status;
  useEffect(() => {
    if (!recordId || (recordStatus !== "RUNNING" && recordStatus !== "PENDING")) return undefined;
    let active = true;
    const timer = setInterval(() => {
      getExperiment(recordId)
        .then((next) => { if (active) setRecord(next); })
        .catch((err: unknown) => {
          if (active) setError(err instanceof Error ? err.message : "Unable to refresh the experiment.");
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [recordId, recordStatus]);

  async function onRun() {
    const checked = validateMeasuredForm({
      target: selected,
      fault,
      probeUrl: "",
      hypothesis,
      ...values,
      executable,
      blockedReason: supportReason,
    });
    if (checked.error) {
      setError(checked.error);
      return;
    }
    setStarting(true);
    setError("");
    try {
      const created = await runExperiment({
        mode: "measured",
        sandboxId: sandbox?.id,
        faultType: fault,
        targetService: selected,
        hypothesis,
        memoryMib,
        latencyMs,
        lossPercent,
        baselineMs: values.baselineMs,
        faultDurationMs: values.faultDurationMs,
        recoveryMs: values.recoveryMs,
        ratePerSecond: values.ratePerSecond,
        concurrency: values.concurrency,
        timeoutMs: values.timeoutMs,
        thresholds: {
          maxErrorRatePercent: values.maxErrorRatePercent,
          maxP95Ms: values.maxP95Ms,
          recoveryTimeoutMs: values.recoveryTimeoutMs,
        },
        edges,
      });
      setRecord(created);
      onRunStarted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Experiment failed.");
    } finally {
      setStarting(false);
    }
  }

  async function onCancel() {
    if (!record) return;
    setError("");
    try {
      await cancelExperiment(record.id);
      const next = await getExperiment(record.id);
      setRecord(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to cancel the experiment.");
    }
  }

  return (
    <div className={mode === "both" ? "mm-exp-layout" : "mm-exp-single"}>
      {(mode === "configure" || mode === "both") && (
        <ConfigureExperimentPanel
          services={verified.map((service) => ({ id: service.service, name: service.service }))}
          sandbox={sandbox}
          gatePhase={gate.phase}
          target={selected}
          fault={fault}
          hypothesis={hypothesis}
          memoryMib={memoryMib}
          latencyMs={latencyMs}
          lossPercent={lossPercent}
          health={runtimeServices?.find((service) => service.service === selected)?.health || "unavailable"}
          values={values}
          supportReason={supportReason}
          executable={executable}
          running={running}
          canCancel={Boolean(record && (record.status === "RUNNING" || record.status === "PENDING"))}
          caps={caps}
          error={error}
          onTarget={setTarget}
          onFault={setFault}
          onHypothesis={setHypothesis}
          onMemoryMib={setMemoryMib}
          onLatencyMs={setLatencyMs}
          onLossPercent={setLossPercent}
          onValue={(name: FieldName, value: number) => setValues((current) => ({ ...current, [name]: value }))}
          onRun={() => void onRun()}
          onCancel={() => void onCancel()}
        />
      )}
      {(mode === "observe" || mode === "both") && (
        <ObservabilityDashboard record={record} loading={loading} starting={starting} />
      )}
      <style>{`
        .mm-exp-layout {
          display: grid;
          grid-template-columns: minmax(280px, 0.92fr) minmax(300px, 1.08fr);
          gap: 24px;
          margin-top: 24px;
          align-items: start;
        }
        .mm-exp-single {
          margin-top: 24px;
        }
        /* Reset the global page-desc negative margin inside cards */
        .mm-exp-card .page-desc {
          margin-top: 0;
          margin-bottom: 8px;
          max-width: 100%;
        }
        .mm-exp-card {
          padding: 22px 24px;
          border-radius: 14px;
          min-width: 0;
          overflow: hidden;
        }
        .mm-exp-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(3, 1fr);
        }
        .mm-metric-grid {
          display: grid;
          gap: 6px 12px;
          grid-template-columns: repeat(4, 1fr);
        }
        .mm-exp-select, .mm-exp-input {
          width: 100%;
          color: var(--chalk);
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 10px 12px;
          font-family: var(--sans);
        }
        .mm-metric {
          margin-top: 0;
          min-width: 0;
        }
        .mm-phase {
          margin-top: 16px;
          padding-top: 14px;
          border-top: 1px solid var(--border);
        }
        .mm-chart {
          margin-top: 16px;
          padding-top: 14px;
          border-top: 1px solid var(--border);
        }
        .mm-timeline {
          margin-top: 16px;
          padding-top: 14px;
          border-top: 1px solid var(--border);
        }
        .mm-metric-label {
          display: block;
          color: var(--pewter);
          font-family: var(--mono);
          font-size: 10px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-bottom: 2px;
        }
        .mm-metric strong {
          display: block;
          color: var(--chalk);
          font-size: 16px;
          font-weight: 700;
          line-height: 1.3;
          word-break: break-all;
        }
        .mm-bars {
          display: flex;
          gap: 10px;
          align-items: flex-end;
          min-height: 100px;
          margin-top: 10px;
        }
        .mm-bar-col {
          flex: 1;
          min-width: 0;
          text-align: center;
          color: var(--silver);
          font-size: 11px;
          overflow: hidden;
        }
        .mm-bar-col > span {
          display: block;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-top: 3px;
          line-height: 1.4;
        }
        .mm-bar-col > span.mm-metric-label {
          margin-top: 1px;
          font-size: 9px;
        }
        .mm-bar-track {
          height: 80px;
          display: flex;
          align-items: flex-end;
          border-bottom: 1px solid var(--border);
        }
        .mm-bar-fill {
          width: 100%;
          border-radius: 4px 4px 0 0;
          min-height: 2px;
        }
        .mm-chart .page-desc {
          margin: 3px 0 8px;
          font-size: 11px;
        }
        @media (max-width: 900px) {
          .mm-exp-layout { grid-template-columns: 1fr; }
          .mm-metric-grid { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>
    </div>
  );
}
