import type { GeminiEnv } from "../lib/env.js";
import type { ResearchConfig } from "./config.js";
import type { WeeklyReport } from "./schema.js";
import { logger } from "../lib/logger.js";
import { checkUrls } from "./urlCheck.js";
import {
  applyUrlReplacements,
  collectReportUrls,
  dropItemsWithBadUrls,
  dropItemsWithoutSourceUrls,
  repairReportSources,
} from "./sourceRepair.js";

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

function extractHtmlTitle(html: string): string {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return (m?.[1] ?? "").trim();
}

function normalizeSig(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function isHomepageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = (u.pathname ?? "").replace(/\/+$/, "") || "/";
    return path === "/";
  } catch {
    return false;
  }
}

function isLikelyErrorPageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = (u.pathname ?? "").toLowerCase();
    if (path.endsWith("/error") || path.endsWith("/error.html")) return true;
    if (path.includes("/error/") || path.includes("/error.html")) return true;
    return false;
  } catch {
    return false;
  }
}

function dropHomepageSourceUrls(report: WeeklyReport): { report: WeeklyReport; dropped: number } {
  const urls = collectReportUrls(report);
  const bad = new Set<string>(urls.filter(isHomepageUrl));
  if (bad.size === 0) return { report, dropped: 0 };
  const next = dropItemsWithBadUrls({ report, badUrls: bad });
  return { report: next, dropped: bad.size };
}

async function dropUrlsThatLookLikeHomepageFallback(args: {
  report: WeeklyReport;
  timeoutMs: number;
  concurrency: number;
}): Promise<{ report: WeeklyReport; dropped: number }> {
  let report = args.report;
  const urls = collectReportUrls(report);
  const byOrigin = new Map<string, string[]>();

  const allowedOrigins = new Set<string>();
  for (const u of Object.values(report.company_homepages ?? {})) {
    if (typeof u !== "string") continue;
    try {
      allowedOrigins.add(new URL(u).origin);
    } catch {
      // ignore
    }
  }

  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (parsed.pathname === "/" || parsed.pathname === "") continue;
      const origin = parsed.origin;
      // Only apply homepage-fallback checks to corporate origins we know (company homepages).
      if (allowedOrigins.size > 0 && !allowedOrigins.has(origin)) continue;
      const list = byOrigin.get(origin) ?? [];
      list.push(u);
      byOrigin.set(origin, list);
    } catch {
      // ignore
    }
  }

  const origins = Array.from(byOrigin.keys());
  if (origins.length === 0) return { report, dropped: 0 };

  const sigByOrigin = new Map<string, { title: string; prefix: string }>();
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(args.concurrency, origins.length)) }, async () => {
    while (true) {
      const i = index++;
      if (i >= origins.length) break;
      const origin = origins[i]!;
      try {
        const res = await fetchWithTimeout(`${origin}/`, { method: "GET" }, args.timeoutMs);
        if (!res.ok) continue;
        const ct = res.headers.get("content-type")?.toLowerCase() ?? "";
        if (!ct.includes("text/html")) continue;
        const prefix = await readBodyPrefix(res, 8192);
        const title = extractHtmlTitle(prefix);
        if (!title && !prefix.trim()) continue;
        sigByOrigin.set(origin, { title: normalizeSig(title), prefix: normalizeSig(prefix).slice(0, 2000) });
      } catch {
        // ignore
      }
    }
  });
  await Promise.all(workers);

  const bad = new Set<string>();
  const allCandidates = Array.from(byOrigin.entries()).flatMap(([, list]) => list);
  let idx2 = 0;
  const workers2 = Array.from({ length: Math.max(1, Math.min(args.concurrency, allCandidates.length)) }, async () => {
    while (true) {
      const i = idx2++;
      if (i >= allCandidates.length) break;
      const url = allCandidates[i]!;
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        continue;
      }
      const home = sigByOrigin.get(origin);
      if (!home) continue;
      try {
        const res = await fetchWithTimeout(url, { method: "GET" }, args.timeoutMs);
        if (!res.ok) continue;
        const ct = res.headers.get("content-type")?.toLowerCase() ?? "";
        if (!ct.includes("text/html")) continue;
        const prefix = await readBodyPrefix(res, 8192);
        const title = normalizeSig(extractHtmlTitle(prefix));
        const bodySig = normalizeSig(prefix).slice(0, 2000);
        const sameBody = !!home.prefix && bodySig && bodySig === home.prefix;
        if (sameBody && bodySig.length >= 200) bad.add(url);
      } catch {
        // ignore
      }
    }
  });
  await Promise.all(workers2);

  if (bad.size === 0) return { report, dropped: 0 };
  report = dropItemsWithBadUrls({ report, badUrls: bad });
  return { report, dropped: bad.size };
}

export async function postprocessReport(args: {
  env?: GeminiEnv;
  modelUsed?: string;
  report: WeeklyReport;
  config: ResearchConfig;
}): Promise<WeeklyReport> {
  const { env, modelUsed, config } = args;
  let report = args.report;

  if (config.drop_items_without_valid_url) {
    report = dropItemsWithoutSourceUrls(report);
    const droppedHome = dropHomepageSourceUrls(report);
    report = droppedHome.report;
    if (droppedHome.dropped) {
      logger.warn({ droppedHomepageUrls: droppedHome.dropped }, "Dropped items that used homepage URLs as sources");
    }

    // Treat hard/soft-404 as "invalid" even when URL verification is disabled.
    const urls = collectReportUrls(report);
    if (urls.length) {
      const checks = await checkUrls(urls, {
        timeoutMs: config.url_check_timeout_ms,
        concurrency: config.url_check_concurrency,
        soft404: true,
      });

      const replacements = new Map<string, string>();
      for (const r of checks.values()) {
        if (r.ok && r.finalUrl && r.finalUrl.startsWith("http") && r.finalUrl !== r.url) {
          replacements.set(r.url, r.finalUrl);
        }
      }
      if (replacements.size) {
        report = applyUrlReplacements(report, replacements);
      }

      const redirectedToError = Array.from(checks.values())
        .filter((r) => r.ok && r.finalUrl && isLikelyErrorPageUrl(r.finalUrl))
        .map((r) => r.finalUrl as string);
      if (redirectedToError.length) {
        report = dropItemsWithBadUrls({ report, badUrls: new Set(redirectedToError) });
        logger.warn({ droppedErrorUrls: redirectedToError.length }, "Dropped items that redirect to obvious error pages");
      }

      const hardBadUrls = Array.from(checks.values())
        .filter((r) => !r.ok)
        // Only treat true not-found signals as "invalid" here.
        // Other 4xx statuses can be bot-blocks or method restrictions and should not erase content.
        .filter((r) => r.reason === "SOFT_404" || r.status === 404 || r.status === 410)
        .map((r) => r.url);

      if (hardBadUrls.length) {
        report = dropItemsWithBadUrls({ report, badUrls: new Set(hardBadUrls) });
        logger.warn({ droppedBadUrls: hardBadUrls.length }, "Dropped items with hard/soft-404 source URLs");
      }

      const homeDropped = await dropUrlsThatLookLikeHomepageFallback({
        report,
        timeoutMs: config.url_check_timeout_ms,
        concurrency: config.url_check_concurrency,
      });
      report = homeDropped.report;
      if (homeDropped.dropped) {
        logger.warn({ droppedHomeFallbackUrls: homeDropped.dropped }, "Dropped items whose URL resolves to homepage fallback");
      }
    }
  }

  if (!config.verify_source_urls) return report;
  if (!env) {
    throw new Error("verify_source_urls=true requires GEMINI_API_KEY (env missing) for source repair");
  }
  if (!modelUsed) {
    throw new Error("verify_source_urls=true requires modelUsed for source repair");
  }

  const roundLimit = config.max_source_repair_rounds ?? 0;
  for (let round = 0; round <= roundLimit; round++) {
    const urls = collectReportUrls(report);
    const checks = await checkUrls(urls, {
      timeoutMs: config.url_check_timeout_ms,
      concurrency: config.url_check_concurrency,
      soft404: true,
    });
    const badUrls = Array.from(checks.values())
      .filter((r) => !r.ok)
      .filter((r) => r.reason === "SOFT_404" || r.status === 404 || r.status === 410 || r.reason.startsWith("HTTP_4"))
      .map((r) => r.url);

    if (badUrls.length === 0) {
      logger.info({ urlChecks: checks.size }, "Source URL validation passed");
      return report;
    }

    logger.warn({ badUrls: badUrls.length, round }, "Found invalid source URLs");

    if (round < roundLimit) {
      report = await repairReportSources({ env, model: modelUsed, report, badUrls });
      continue;
    }

    if (config.drop_items_without_valid_url) {
      report = dropItemsWithBadUrls({ report, badUrls: new Set(badUrls) });
      logger.warn({ droppedBadUrls: badUrls.length }, "Dropped items with invalid URLs");
      return report;
    }

    return report;
  }

  return report;
}
