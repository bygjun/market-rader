export type UrlCheckResult =
  | { url: string; ok: true; status: number }
  | { url: string; ok: false; status?: number; reason: string };

function isProbablyOkStatus(status: number): boolean {
  if (status >= 200 && status <= 399) return true;
  // Some sites block bot/HEAD requests but still exist.
  if (status === 401 || status === 403 || status === 429) return true;
  return false;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(url: string, timeoutMs: number): Promise<UrlCheckResult> {
  try {
    let res = await fetchWithTimeout(url, { method: "HEAD" }, timeoutMs);
    if (res.status === 405 || res.status === 400) {
      res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
    }

    if (isProbablyOkStatus(res.status)) return { url, ok: true, status: res.status };
    return { url, ok: false, status: res.status, reason: `HTTP_${res.status}` };
  } catch (err) {
    return { url, ok: false, reason: (err as Error)?.message ?? "FETCH_FAILED" };
  }
}

export async function checkUrls(
  urls: string[],
  opts: { timeoutMs: number; concurrency: number },
): Promise<Map<string, UrlCheckResult>> {
  const uniq = Array.from(new Set(urls)).filter((u) => /^https?:\/\//i.test(u));
  const results = new Map<string, UrlCheckResult>();
  let index = 0;

  const workers = Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
    while (true) {
      const i = index++;
      if (i >= uniq.length) break;
      const url = uniq[i];
      const r = await checkOne(url, opts.timeoutMs);
      results.set(url, r);
    }
  });

  await Promise.all(workers);
  return results;
}

