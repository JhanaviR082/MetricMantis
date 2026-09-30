const BASE_URL = "http://localhost:3001";

export async function uploadYaml(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${BASE_URL}/upload`, {
    method: "POST",
    body: formData,
  });

  return res.json();
}


export async function getGraph() {
  const res = await fetch(`${BASE_URL}/graph`);
  return res.json();
}


export async function stopService(service: string) {
  const res = await fetch(
    `${BASE_URL}/chaos/stop/${service}`,
    {
      method: "POST",
    }
  );

  return res.json();
}


export async function restartService(service: string) {
  const res = await fetch(
    `${BASE_URL}/chaos/restart/${service}`,
    {
      method: "POST",
    }
  );

  return res.json();
}


export async function getLogs(service: string) {
  const res = await fetch(
    `${BASE_URL}/logs/${service}`
  );

  return res.json();
}


export async function getReport() {
  const res = await fetch(`${BASE_URL}/report`);
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
    const res = await fetch(`${BASE_URL}/api/advisor/summary`, {
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
    const res = await fetch(`${BASE_URL}/api/advisor/chat`, {
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
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
