"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  applyControlledFault,
  type ControlledFault,
} from "@/lib/chaosFaults";
import {
  applyCascadeFailure,
  parseComposeYaml,
  resetServiceHealth,
  type ComposeAnalysis,
  type DependencyEdge,
  type ParsedService,
  type ReportFinding,
} from "@/lib/composeParser";
import type { ChaosEvent } from "@/lib/reportBuilder";
import {
  cleanupSandbox,
  createSandbox,
  getActiveSandbox,
  getSandboxRuntime,
  startSandbox,
  type SandboxRecord,
} from "@/lib/api";
import {
  sandboxHasRuntime,
  type SandboxRuntimeSnapshot,
} from "@/lib/sandboxRuntime";

export type WorkflowPage = "upload" | "graph" | "chaos" | "report";
export type AppPage = WorkflowPage | "guide";

interface SystemContextValue {
  page: AppPage;
  setPage: (p: AppPage) => void;
  openGuide: () => void;
  goBack: () => void;
  composeFileName: string | null;
  uploadSuccess: boolean;
  analyzed: boolean;
  analyzing: boolean;
  composeText: string | null;
  services: ParsedService[];
  edges: DependencyEdge[];
  findings: ReportFinding[];
  chaosEvents: ChaosEvent[];
  faultLabels: Record<string, ControlledFault>;
  restartPolicies: Record<string, string | undefined>;
  uploadCompose: (file: File) => Promise<void>;
  analyzeSystem: () => Promise<void>;
  sandbox: SandboxRecord | null;
  sandboxRuntime: SandboxRuntimeSnapshot | null;
  sandboxRuntimeError: string | null;
  sandboxObserved: boolean;
  sandboxBusy: boolean;
  sandboxAction: "run" | "stop" | null;
  sandboxError: string | null;
  runSandbox: () => Promise<void>;
  stopSandbox: () => Promise<void>;
  stopService: (id: string) => void;
  injectFault: (id: string, fault: ControlledFault) => void;
  restartAll: () => void;
}

export const PAGE_ORDER: WorkflowPage[] = ["upload", "graph", "chaos", "report"];

const SystemContext = createContext<SystemContextValue | null>(null);

export function SystemProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<AppPage>("upload");
  const [returnPage, setReturnPage] = useState<WorkflowPage>("upload");
  const [composeFileName, setComposeFileName] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [composeText, setComposeText] = useState<string | null>(null);
  const [analyzed, setAnalyzed] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [services, setServices] = useState<ParsedService[]>([]);
  const [edges, setEdges] = useState<DependencyEdge[]>([]);
  const [findings, setFindings] = useState<ReportFinding[]>([]);
  const [restartPolicies, setRestartPolicies] = useState<
    Record<string, string | undefined>
  >({});
  const [chaosEvents, setChaosEvents] = useState<ChaosEvent[]>([]);
  const [faultLabels, setFaultLabels] = useState<Record<string, ControlledFault>>({});
  const [sandbox, setSandbox] = useState<SandboxRecord | null>(null);
  const [sandboxRuntime, setSandboxRuntime] = useState<SandboxRuntimeSnapshot | null>(null);
  const [sandboxRuntimeError, setSandboxRuntimeError] = useState<string | null>(null);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [sandboxAction, setSandboxAction] = useState<"run" | "stop" | null>(null);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const sandboxLock = useRef(false);
  const runtimeEpoch = useRef(0);
  const servicesRef = useRef<ParsedService[]>([]);
  useEffect(() => {
    servicesRef.current = services;
  }, [services]);

  useEffect(() => {
    let active = true;
    getActiveSandbox()
      .then((record) => {
        if (active && record) setSandbox((current) => current ?? record);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSandboxError(error instanceof Error ? error.message : "Sandbox request failed.");
      });
    return () => {
      active = false;
    };
  }, []);

  const applyRuntime = useCallback((epoch: number, body: {
    sandbox: SandboxRecord;
    runtime: SandboxRuntimeSnapshot | null;
    error: string | null;
  }) => {
    if (epoch !== runtimeEpoch.current) return;
    setSandbox((current) => {
      if (!current || current.id !== body.sandbox.id) return body.sandbox;
      if (current.updatedAt > body.sandbox.updatedAt) return current;
      return body.sandbox;
    });
    if (body.runtime) setSandboxRuntime(body.runtime);
    setSandboxRuntimeError(body.error);
  }, []);

  const refreshRuntime = useCallback(async (id: string, epoch: number) => {
    try {
      const body = await getSandboxRuntime(id);
      applyRuntime(epoch, body);
    } catch (error) {
      if (epoch !== runtimeEpoch.current) return;
      setSandboxRuntimeError(error instanceof Error ? error.message : "Sandbox runtime status failed.");
    }
  }, [applyRuntime]);

  const applyAnalysis = useCallback((analysis: ComposeAnalysis) => {
    setServices(analysis.services);
    setEdges(analysis.edges);
    setFindings(analysis.findings);
    setRestartPolicies(analysis.restartPolicies);
    setAnalyzed(true);
    setChaosEvents([]);
    setFaultLabels({});
  }, []);

  const uploadCompose = useCallback(async (file: File) => {
    const text = await file.text();
    setComposeText(text);
    setComposeFileName(file.name);
    setUploadSuccess(true);
    setAnalyzed(false);
    setServices([]);
    setEdges([]);
    setFindings([]);
    setChaosEvents([]);
    setFaultLabels({});
    setRestartPolicies({});
  }, []);

  const analyzeSystem = useCallback(async () => {
    if (!composeText || analyzing) return;
    setAnalyzing(true);
    try {
      const analysis = parseComposeYaml(composeText);
      applyAnalysis(analysis);
    } finally {
      setAnalyzing(false);
    }
  }, [composeText, analyzing, applyAnalysis]);

  const stopService = useCallback(
    (id: string) => {
      const prev = servicesRef.current;
      const next = applyCascadeFailure(prev, edges, id);
      setServices(next);
      setFaultLabels({});
      setChaosEvents((events) => [
        ...events,
        {
          type: "stop",
          target: id,
          command: `docker stop ${id}`,
          at: new Date().toISOString(),
        },
      ]);
    },
    [edges],
  );

  const injectFault = useCallback(
    (id: string, fault: ControlledFault) => {
      const current = servicesRef.current;
      const target = current.find((service) => service.id === id);
      if (!target || target.status === "down") return;

      const result = applyControlledFault(current, edges, id, fault);
      if (result.affected.length === 0) return;

      setServices(result.services);
      setFaultLabels((labels) => {
        const next = { ...labels };
        for (const name of result.affected) next[name] = fault;
        return next;
      });
      setChaosEvents((events) => [
        ...events,
        {
          type: fault,
          target: id,
          command: "",
          at: new Date().toISOString(),
        },
      ]);
    },
    [edges],
  );

  const runSandbox = useCallback(async () => {
    if (sandboxLock.current || !composeText) return;
    if (sandbox && ["starting", "running", "stopping"].includes(sandbox.status)) return;
    sandboxLock.current = true;
    runtimeEpoch.current += 1;
    setSandboxBusy(true);
    setSandboxAction("run");
    setSandboxError(null);
    setSandboxRuntime(null);
    setSandboxRuntimeError(null);
    let runtimeId: string | null = null;
    try {
      const record = await createSandbox({ composeYaml: composeText, fileName: composeFileName });
      runtimeId = record.id;
      setSandbox(record);
      const started = await startSandbox(record.id);
      setSandbox(started);
      if (started.status !== "running") {
        setSandboxError(started.error || "The approved sample did not start.");
      }
    } catch (error) {
      const failed = error as Error & { sandbox?: SandboxRecord };
      if (failed.sandbox) {
        runtimeId = failed.sandbox.id;
        setSandbox(failed.sandbox);
      }
      setSandboxError(failed instanceof Error ? failed.message : "Sandbox request failed.");
    } finally {
      runtimeEpoch.current += 1;
      const epoch = runtimeEpoch.current;
      if (runtimeId) await refreshRuntime(runtimeId, epoch);
      sandboxLock.current = false;
      setSandboxBusy(false);
      setSandboxAction(null);
    }
  }, [composeText, composeFileName, sandbox, refreshRuntime]);

  const stopSandbox = useCallback(async () => {
    if (sandboxLock.current || !sandbox || sandbox.status === "stopped") return;
    sandboxLock.current = true;
    runtimeEpoch.current += 1;
    setSandboxBusy(true);
    setSandboxAction("stop");
    setSandboxError(null);
    try {
      const record = await cleanupSandbox(sandbox.id);
      setSandbox(record);
      if (record.status !== "stopped") {
        setSandboxError(record.error || "Sandbox cleanup did not finish.");
      }
    } catch (error) {
      const failed = error as Error & { sandbox?: SandboxRecord };
      if (failed.sandbox) setSandbox(failed.sandbox);
      setSandboxError(failed instanceof Error ? failed.message : "Sandbox cleanup failed.");
    } finally {
      runtimeEpoch.current += 1;
      const epoch = runtimeEpoch.current;
      await refreshRuntime(sandbox.id, epoch);
      sandboxLock.current = false;
      setSandboxBusy(false);
      setSandboxAction(null);
    }
  }, [sandbox, refreshRuntime]);

  const sandboxId = sandbox?.id ?? null;
  const sandboxStatus = sandbox?.status ?? null;
  useEffect(() => {
    const activeStatus = sandboxStatus === "starting" || sandboxStatus === "running" || sandboxStatus === "stopping";
    if (!sandboxId || (!activeStatus && sandboxAction !== "run")) return undefined;
    let active = true;
    const tick = () => {
      const epoch = runtimeEpoch.current;
      getSandboxRuntime(sandboxId)
        .then((body) => {
          if (active) applyRuntime(epoch, body);
        })
        .catch((error: unknown) => {
          if (!active || epoch !== runtimeEpoch.current) return;
          setSandboxRuntimeError(error instanceof Error ? error.message : "Sandbox runtime status failed.");
        });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sandboxId, sandboxStatus, sandboxAction, applyRuntime]);

  const restartAll = useCallback(() => {
    setServices((prev) => resetServiceHealth(prev));
    setFaultLabels({});
    setChaosEvents((prev) => [
      ...prev,
      {
        type: "restart",
        command: "docker compose restart",
        at: new Date().toISOString(),
      },
    ]);
  }, []);

  const openGuide = useCallback(() => {
    if (page !== "guide") {
      setReturnPage(page);
      setPage("guide");
    }
  }, [page]);

  const goBack = useCallback(() => {
    if (page === "guide") {
      setPage(returnPage);
      return;
    }
    const idx = PAGE_ORDER.indexOf(page);
    if (idx > 0) setPage(PAGE_ORDER[idx - 1]);
  }, [page, returnPage]);

  const value = useMemo(
    () => ({
      page,
      setPage,
      openGuide,
      goBack,
      composeFileName,
      uploadSuccess,
      analyzed,
      analyzing,
      composeText,
      services,
      edges,
      findings,
      chaosEvents,
      faultLabels,
      restartPolicies,
      uploadCompose,
      analyzeSystem,
      sandbox,
      sandboxRuntime,
      sandboxRuntimeError,
      sandboxObserved: sandboxHasRuntime(sandbox?.status),
      sandboxBusy,
      sandboxAction,
      sandboxError,
      runSandbox,
      stopSandbox,
      stopService,
      injectFault,
      restartAll,
    }),
    [
      page,
      openGuide,
      goBack,
      composeFileName,
      uploadSuccess,
      analyzed,
      analyzing,
      composeText,
      services,
      edges,
      findings,
      chaosEvents,
      faultLabels,
      restartPolicies,
      uploadCompose,
      analyzeSystem,
      sandbox,
      sandboxRuntime,
      sandboxRuntimeError,
      sandboxBusy,
      sandboxAction,
      sandboxError,
      runSandbox,
      stopSandbox,
      stopService,
      injectFault,
      restartAll,
    ],
  );

  return (
    <SystemContext.Provider value={value}>{children}</SystemContext.Provider>
  );
}

export function useSystem() {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error("useSystem must be used within SystemProvider");
  return ctx;
}

