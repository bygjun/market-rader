type GsLocation = { bucket: string; object: string };

export function isGsPath(p: string): boolean {
  return p.startsWith("gs://");
}

export function parseGsPath(p: string): GsLocation {
  if (!isGsPath(p)) throw new Error(`Not a gs:// path: ${p}`);
  const rest = p.slice("gs://".length);
  const idx = rest.indexOf("/");
  if (idx <= 0) throw new Error(`Invalid gs:// path (missing object): ${p}`);
  const bucket = rest.slice(0, idx);
  const object = rest.slice(idx + 1);
  if (!bucket || !object) throw new Error(`Invalid gs:// path: ${p}`);
  return { bucket, object };
}

async function getMetadataAccessToken(): Promise<string> {
  const url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
  const res = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) {
    throw new Error(`Failed to fetch metadata token (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Metadata token response missing access_token");
  return json.access_token;
}

async function fetchWithAuth(input: string, init: RequestInit): Promise<Response> {
  const token = await getMetadataAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

export async function readGsText(p: string): Promise<string> {
  const { bucket, object } = parseGsPath(p);
  const mediaUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
  const res = await fetchWithAuth(mediaUrl, { method: "GET" });
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`GCS read failed (${res.status}) for ${p}: ${await res.text()}`);
  return res.text();
}

export async function writeGsText(p: string, text: string): Promise<void> {
  const { bucket, object } = parseGsPath(p);
  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`;
  const res = await fetchWithAuth(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: text,
  });
  if (!res.ok) throw new Error(`GCS write failed (${res.status}) for ${p}: ${await res.text()}`);
}

