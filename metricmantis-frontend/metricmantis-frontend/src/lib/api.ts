import type { ServiceRuntime } from "./sandboxRuntime";

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
).replace(/\/$/, "");

const CONNECTION_ERROR = "Unable to connect to the server. Please try again.";

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function apiFetch(path: string, init: RequestInit = {}) {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: "include",
    });
    if (response.status === 401 && !path.startsWith("/auth/")) {
      unauthorizedHandler?.();
    }
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new Error(CONNECTION_ERROR);
  }
}

export interface AuthUser {
  id: number;
  username: string;
  email: string;
}

export interface AuthResult {
  success: boolean;
  message: string;
  user?: AuthUser;
}

async function readAuthResult(response: Response): Promise<AuthResult> {
  const body = (await response.json().catch(() => null)) as AuthResult | null;
  if (!body || typeof body.message !== "string") {
    throw new Error(CONNECTION_ERROR);
  }
  if (!response.ok || body.success === false) {
    throw new Error(body.message);
  }
  return body;
}

export async function signupAccount(input: {
  username: string;
  email: string;
  password: string;
}) {
  const response = await apiFetch("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readAuthResult(response);
}

export async function loginAccount(input: { username: string; password: string }) {
  const response = await apiFetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readAuthResult(response);
}

export async function logoutAccount() {
  const response = await apiFetch("/auth/logout", { method: "POST" });
  return readAuthResult(response);
}

export async function getCurrentUser(): Promise<
  { authenticated: true; user: AuthUser } | { authenticated: false }
> {
  const response = await apiFetch("/auth/me");
  if (!response.ok) {
    throw new Error(CONNECTION_ERROR);
  }
  const body = (await response.json().catch(() => null)) as
    | { authenticated: true; user: AuthUser }
    | { authenticated: false }
    | null;
  if (!body || body.authenticated !== true) {
    return { authenticated: false };
  }
  return body;
}

export async function uploadYaml(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await apiFetch("/upload", {
    method: "POST",
    body: formData,
  });

  return res.json();
}


export async function getGraph() {
  const res = await apiFetch("/graph");
  return res.json();
}


export async function stopService(service: string) {
  const res = await apiFetch(`/chaos/stop/${service}`, {
    method: "POST",
  });

  return res.json();
}


export async function restartService(service: string) {
  const res = await apiFetch(`/chaos/restart/${service}`, {
    method: "POST",
  });

  return res.json();
}


export async function getLogs(service: string) {
  const res = await apiFetch(`/logs/${service}`);

  return res.json();
}


export async function getReport() {
  const res = await apiFetch("/report");
  return res.json();
}

export interface ExperimentPhase {
  startedAt?: string;
  finishedAt?: string;
  windowMs?: number;
  metrics?: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    errorRatePercent: number | null;
    requestsPerSecond: number | null;
    latencyMs: { average: number | null; p50: number | null; p95: number | null; p99: number | null };
    statusCodes?: Record<string, number>;
    notes?: string[];
  } | null;
  execution?: { verified?: boolean; observed?: string | null; detail?: string };
  cpuPercent?: number | null;
  memoryBytes?: number | null;
}

export interface ExperimentEvidence {
  mode: string;
  provenance: "observed" | "predicted";
  targetService?: string;
  faultType?: string;
  hypothesis?: string;
  probeUrl?: string;
  declaredDependents?: string[];
  observedImpact?: string | null;
  cpuComparison?: {
    summary?: string;
    baseline?: { requests: number | null; requestsPerSecond: number | null; errorRatePercent: number | null; p50: number | null; p95: number | null; cpuPercent: number | null };
    fault?: { requests: number | null; requestsPerSecond: number | null; errorRatePercent: number | null; p50: number | null; p95: number | null; cpuPercent: number | null };
    recovery?: { requests: number | null; requestsPerSecond: number | null; errorRatePercent: number | null; p50: number | null; p95: number | null; cpuPercent: number | null };
  };
  phases?: { baseline?: ExperimentPhase | null; fault?: ExperimentPhase | null; recovery?: ExperimentPhase | null };
  assertions?: { id: string; name: string; result: string; expected: unknown; observed: unknown; detail: string }[];
  limitations?: string[];
  measurementErrors?: string[];
  cleanup?: { status?: string; detail?: string };
  parameters?: {
    ratePerSecond?: number;
    baselineMs?: number;
    faultDurationMs?: number;
    recoveryMs?: number;
    thresholds?: { maxErrorRatePercent?: number; maxP95Ms?: number };
  };
}

export interface ExperimentRecord {
  id: string;
  name: string;
  status: string;
  verdict: string | null;
  targetService: string;
  faultType: string;
  mode: string;
  evidence: ExperimentEvidence | null;
  error: string | null;
  cleanupStatus: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export async function getExperimentCapabilities() {
  const res = await apiFetch("/experiments/capabilities");
  if (!res.ok) throw new Error("Unable to read experiment capabilities.");
  return res.json() as Promise<{
    dockerAvailable: boolean;
    chaosEnabled: boolean;
    allowlist: string[];
    startupMode?: "chaos" | "normal";
    networkFaultReason: string;
    probeAllowlist: string[];
    stop?: boolean;
    restart?: boolean;
    cpu?: boolean;
    cpuQuota?: number;
    cpuPeriod?: number;
    latency?: boolean;
    packetLoss?: boolean;
  }>;
}

export async function getExperiment(id: string) {
  const res = await apiFetch(`/experiments/${id}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Unable to load the experiment.");
  return body.experiment as ExperimentRecord;
}

export async function cancelExperiment(id: string) {
  const res = await apiFetch(`/experiments/${id}/cancel`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Unable to cancel the experiment.");
}

export async function listExperiments(limit = 10) {
  const res = await apiFetch(`/experiments?limit=${limit}`);
  if (!res.ok) throw new Error("Unable to load experiment history.");
  return res.json() as Promise<{ experiments: ExperimentRecord[] }>;
}

export type SandboxStatus = "created" | "starting" | "running" | "stopping" | "stopped" | "failed";

export interface SandboxRecord {
  id: string;
  projectName: string;
  status: SandboxStatus;
  fileName: string | null;
  services: Record<string, string | null>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
}

async function readSandbox(response: Response): Promise<SandboxRecord> {
  const body = await response.json().catch(() => ({})) as { sandbox?: SandboxRecord; error?: string };
  if (!response.ok || !body.sandbox) {
    throw new Error(body.error || "Sandbox request failed.");
  }
  if (body.error) throw new Error(body.error);
  return body.sandbox;
}

export async function createSandbox(input: { composeYaml: string; fileName?: string | null }) {
  const response = await apiFetch("/sandboxes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { sandbox?: SandboxRecord; error?: string };
  if (!body.sandbox) throw new Error(body.error || "Sandbox request failed.");
  if (!response.ok || body.error) {
    const error = new Error(body.error || "Sandbox request failed.") as Error & { sandbox?: SandboxRecord };
    error.sandbox = body.sandbox;
    throw error;
  }
  return body.sandbox;
}

export async function getActiveSandbox() {
  const response = await apiFetch("/sandboxes/active");
  const body = await response.json().catch(() => ({})) as { sandbox?: SandboxRecord | null; error?: string };
  if (!response.ok) throw new Error(body.error || "Sandbox request failed.");
  return body.sandbox ?? null;
}

export async function startSandbox(id: string) {
  const response = await apiFetch(`/sandboxes/${id}/start`, { method: "POST" });
  const body = await response.json().catch(() => ({})) as { sandbox?: SandboxRecord; error?: string };
  if (!body.sandbox) throw new Error(body.error || "Sandbox start failed.");
  if (body.error && body.sandbox.status !== "failed") {
    const error = new Error(body.error) as Error & { sandbox?: SandboxRecord };
    error.sandbox = body.sandbox;
    throw error;
  }
  return body.sandbox;
}

export async function getSandbox(id: string) {
  const response = await apiFetch(`/sandboxes/${id}`);
  return readSandbox(response);
}

export async function getSandboxRuntime(id: string) {
  const response = await apiFetch(`/sandboxes/${id}/runtime`);
  const body = await response.json().catch(() => ({})) as {
    sandbox?: SandboxRecord;
    runtime?: { services: ServiceRuntime[]; error: string | null } | null;
    error?: string;
  };
  if (!body.sandbox) throw new Error(body.error || "Sandbox runtime status failed.");
  return {
    sandbox: body.sandbox,
    runtime: body.runtime ?? null,
    error: body.error || body.runtime?.error || null,
  };
}

export async function cleanupSandbox(id: string) {
  const response = await apiFetch(`/sandboxes/${id}/cleanup`, { method: "POST" });
  const body = await response.json().catch(() => ({})) as { sandbox?: SandboxRecord; error?: string };
  if (!body.sandbox) throw new Error(body.error || "Sandbox cleanup failed.");
  if (body.error && body.sandbox.status !== "failed") {
    const error = new Error(body.error) as Error & { sandbox?: SandboxRecord };
    error.sandbox = body.sandbox;
    throw error;
  }
  return body.sandbox;
}

export async function runExperiment(input: Record<string, unknown>) {
  const res = await apiFetch("/experiments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Experiment failed.");
  return body.experiment as ExperimentRecord;
}

export interface AdvisorReport {
  scores: {
    overall: number;
    dependencySafety: number;
    faultTolerance: number;
    recoveryCapability: number;
    monitoringVisibility: number;
  };
  sections: {
    id: string;
    title: string;
    paragraphs: string[];
    bullets?: string[];
  }[];
  findings: { severity: string; message: string }[];
}

export interface AdvisorSummaryResponse {
  summary: string;
  suggestedQuestions: string[];
}

export interface AdvisorChatMessage {
  role: "user" | "advisor";
  content: string;
}

export interface AdvisorChatResponse {
  answer: string;
}

export async function postAdvisorSummary(
  report: AdvisorReport,
): Promise<AdvisorSummaryResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await apiFetch("/api/advisor/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Failed to get summary");
    }
    return res.json();
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Request timed out. The advisor took too long — please try again.");
    }
    if (err instanceof TypeError) {
      throw new Error(CONNECTION_ERROR);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function postAdvisorChat(
  report: AdvisorReport,
  history: AdvisorChatMessage[],
  question: string,
): Promise<AdvisorChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await apiFetch("/api/advisor/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report, history, question }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Failed to get answer");
    }
    return res.json();
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Request timed out. Please try again.");
    }
    if (err instanceof TypeError) {
      throw new Error(CONNECTION_ERROR);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
