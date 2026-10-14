const BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
).replace(/\/$/, "");

function withSession(init: RequestInit = {}): RequestInit {
  return { ...init, credentials: "include" };
}

export async function uploadYaml(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${BASE_URL}/upload`, withSession({
    method: "POST",
    body: formData,
  }));

  return response.json();
}

export async function getGraph() {
  const response = await fetch(`${BASE_URL}/graph`, withSession());
  return response.json();
}

export async function stopService(service: string) {
  const response = await fetch(
    `${BASE_URL}/chaos/stop/${service}`,
    withSession({
      method: "POST",
    })
  );

  return response.json();
}

export async function restartService(service: string) {
  const response = await fetch(
    `${BASE_URL}/chaos/restart/${service}`,
    withSession({
      method: "POST",
    })
  );

  return response.json();
}

export async function getLogs(service: string) {
  const response = await fetch(
    `${BASE_URL}/logs/${service}`,
    withSession()
  );

  return response.json();
}

export async function getReport() {
  const response = await fetch(`${BASE_URL}/report`, withSession());
  return response.json();
}
