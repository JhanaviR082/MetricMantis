const BASE_URL = "http://localhost:3001";

export async function uploadYaml(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${BASE_URL}/upload`, {
    method: "POST",
    body: formData,
  });

  return response.json();
}

export async function getGraph() {
  const response = await fetch(`${BASE_URL}/graph`);
  return response.json();
}

export async function stopService(service: string) {
  const response = await fetch(
    `${BASE_URL}/chaos/stop/${service}`,
    {
      method: "POST",
    }
  );

  return response.json();
}

export async function restartService(service: string) {
  const response = await fetch(
    `${BASE_URL}/chaos/restart/${service}`,
    {
      method: "POST",
    }
  );

  return response.json();
}

export async function getLogs(service: string) {
  const response = await fetch(
    `${BASE_URL}/logs/${service}`
  );

  return response.json();
}

export async function getReport() {
  const response = await fetch(`${BASE_URL}/report`);
  return response.json();
}
