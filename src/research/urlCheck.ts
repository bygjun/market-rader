export type UrlCheckResult =
  | { url: string; ok: true; status: number; finalUrl?: string }
  | { url: string; ok: false; status?: number; reason: string; finalUrl?: string };

function isProbablyOkStatus(status: number): boolean {
  if (status >= 200 && status <= 399) return true;
  // Some sites block bot/HEAD requests but still exist.
  if (status === 401 || status === 403 || status === 406 || status === 418 || status === 429 || status === 451) return true;
  return false;
}

async function readBodyPrefix(res: Response, maxBytes: number): Promise<string> {
  try {
    if (!res.body) return "";
    const reader = (res.body as any).getReader?.();
    if (!reader) {
      const text = await res.text();
      return text.slice(0, maxBytes);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = maxBytes - total;
        chunks.push(value.slice(0, remaining));
        total += Math.min(value.length, remaining);
      }
    }
    try {
      reader.releaseLock?.();
    } catch {
      // ignore
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
  } catch {
    return "";
  }
}

function looksLikeSoft404(bodyPrefix: string): boolean {
  const s = bodyPrefix.toLowerCase();
  if (!s.trim()) return false;
  const patterns: RegExp[] = [
    /\b404\b/i,
    /\bnot\s+found\b/i,
    /\bpage\s+not\s+found\b/i,
    /\bthe\s+page\s+you\s+(requested|are\s+looking\s+for)\b/i,
    /페이지를\s*찾을\s*수\s*없/i,
    /요청하신\s*페이지/i,
    /존재하지\s*않는\s*페이지/i,
    /찾을\s*수\s*없/i,
  ];
  return patterns.some((re) => re.test(s));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) {
      headers.set(
        "user-agent",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      );
    }
    if (!headers.has("accept")) headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    if (!headers.has("accept-language")) headers.set("accept-language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");
    return await fetch(url, { ...init, headers, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(url: string, timeoutMs: number): Promise<UrlCheckResult> {
  try {
    let res = await fetchWithTimeout(url, { method: "HEAD" }, timeoutMs);
    // Many sites block HEAD or respond with non-representative 4xx; retry with GET broadly.
    if ((res.status >= 400 && res.status <= 599) || res.status === 405) {
      res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
    }

    const finalUrl = typeof res.url === "string" && res.url.startsWith("http") && res.url !== url ? res.url : undefined;
    if (isProbablyOkStatus(res.status)) return { url, ok: true, status: res.status, finalUrl };
    return { url, ok: false, status: res.status, reason: `HTTP_${res.status}`, finalUrl };
  } catch (err) {
    return { url, ok: false, reason: (err as Error)?.message ?? "FETCH_FAILED" };
  }
}

export async function checkUrls(
  urls: string[],
  opts: { timeoutMs: number; concurrency: number; soft404?: boolean },
): Promise<Map<string, UrlCheckResult>> {
  const uniq = Array.from(new Set(urls)).filter((u) => /^https?:\/\//i.test(u));
  const results = new Map<string, UrlCheckResult>();
  let index = 0;

  const workers = Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
    while (true) {
      const i = index++;
      if (i >= uniq.length) break;
      const url = uniq[i];
      let r = await checkOne(url, opts.timeoutMs);
      if (opts.soft404 && r.ok && r.status >= 200 && r.status <= 299) {
        try {
          const res = await fetchWithTimeout(url, { method: "GET" }, opts.timeoutMs);
          const ct = res.headers.get("content-type")?.toLowerCase() ?? "";
          if (res.status >= 200 && res.status <= 299 && ct.includes("text/html")) {
            const prefix = await readBodyPrefix(res, 8192);
            if (looksLikeSoft404(prefix)) {
              r = { url, ok: false, status: res.status, reason: "SOFT_404", finalUrl: res.url && res.url !== url ? res.url : undefined };
            } else if (typeof res.url === "string" && res.url.startsWith("http") && res.url !== url) {
              r = { ...r, finalUrl: res.url };
            }
          }
        } catch {
          // ignore soft-404 failures; keep original r
        }
      }
      results.set(url, r);
    }
  });

  await Promise.all(workers);
  return results;
}
