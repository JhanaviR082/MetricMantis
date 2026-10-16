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
}: {
  edges: { from: string; to: string }[];
  sandbox: SandboxRecord | null;
  runtimeServices: ServiceRuntime[] | null;
  runtimeError: string | null;
  runtimeKnown: boolean;
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
    <div className="mm-exp-layout">
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
      <ObservabilityDashboard record={record} loading={loading} starting={starting} />
      <style>{`
        .mm-exp-layout {
          display: grid;
          grid-template-columns: minmax(280px, 0.92fr) minmax(300px, 1.08fr);
          gap: 16px;
          margin-top: 22px;
          align-items: start;
        }
        .mm-exp-card {
          padding: 18px;
          border-radius: 14px;
          min-width: 0;
        }
        .mm-exp-grid, .mm-metric-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
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
        .mm-metric, .mm-phase, .mm-chart, .mm-timeline {
          margin-top: 12px;
        }
        .mm-metric-label {
          color: var(--pewter);
          font-family: var(--mono);
          font-size: 11px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .mm-metric strong {
          display: block;
          color: var(--chalk);
          font-size: 18px;
          margin-top: 4px;
        }
        .mm-bars {
          display: flex;
          gap: 12px;
          align-items: end;
          min-height: 120px;
        }
        .mm-bar-col {
          flex: 1;
          text-align: center;
          color: var(--silver);
          font-size: 12px;
        }
        .mm-bar-track {
          height: 88px;
          display: flex;
          align-items: end;
          border-bottom: 1px solid var(--border);
        }
        .mm-bar-fill {
          width: 100%;
          border-radius: 6px 6px 0 0;
          min-height: 0;
        }
        @media (max-width: 860px) {
          .mm-exp-layout { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
