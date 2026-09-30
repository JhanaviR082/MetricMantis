"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
  restartPolicies: Record<string, string | undefined>;
  uploadCompose: (file: File) => Promise<void>;
  analyzeSystem: () => Promise<void>;
  stopService: (id: string) => void;
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

  const applyAnalysis = useCallback((analysis: ComposeAnalysis) => {
    setServices(analysis.services);
    setEdges(analysis.edges);
    setFindings(analysis.findings);
    setRestartPolicies(analysis.restartPolicies);
    setAnalyzed(true);
    setChaosEvents([]);
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
      setServices((prev) => applyCascadeFailure(prev, edges, id));
      setChaosEvents((prev) => [
        ...prev,
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

  const restartAll = useCallback(() => {
    setServices((prev) => resetServiceHealth(prev));
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
      restartPolicies,
      uploadCompose,
      analyzeSystem,
      stopService,
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
      restartPolicies,
      uploadCompose,
      analyzeSystem,
      stopService,
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

