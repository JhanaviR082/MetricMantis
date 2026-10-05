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
