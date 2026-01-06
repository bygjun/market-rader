export type ListedModel = {
  name?: string;
  supportedGenerationMethods?: string[];
};

export function normalizeModelName(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

export async function listModels(apiKey: string): Promise<ListedModel[]> {
  const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
  url.searchParams.set("key", apiKey);
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ListModels failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const parsed = JSON.parse(text) as { models?: ListedModel[] };
  return Array.isArray(parsed.models) ? parsed.models : [];
}

export function pickFallbackModel(models: ListedModel[]): string | null {
  const supported = models
    .map((m) => ({
      name: m.name ? normalizeModelName(m.name) : null,
      methods: m.supportedGenerationMethods ?? [],
    }))
    .filter((m): m is { name: string; methods: string[] } => !!m.name)
    .filter((m) => m.methods.includes("generateContent"));

  if (!supported.length) return null;

  const score = (name: string): number => {
    const lower = name.toLowerCase();
    let s = 0;
    if (lower.includes("flash")) s += 1000;
    if (lower.includes("latest")) s += 200;
    if (lower.includes("pro")) s += 50;
    const m = lower.match(/gemini-(\\d+)(?:\\.(\\d+))?/);
    if (m) {
      const major = Number(m[1] ?? 0);
      const minor = Number(m[2] ?? 0);
      s += major * 100 + minor;
    }
    return s;
  };

  supported.sort((a, b) => score(b.name) - score(a.name));
  return supported[0].name;
}

