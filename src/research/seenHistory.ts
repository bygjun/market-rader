import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WeeklyReport } from "./schema.js";

type SeenHistoryV1 = {
  version: 1;
  weeks: Record<
    string,
    {
      urls: string[];
      updated_at?: string;
    }
  >;
};

export function normalizeUrlForDedupe(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of Array.from(u.searchParams.keys())) {
      if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
    }
    if (!u.searchParams.toString()) u.search = "";
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return url.trim();
  }
}

function safeParseHistory(raw: string): SeenHistoryV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SeenHistoryV1>;
    if (parsed?.version !== 1) return null;
    if (!parsed.weeks || typeof parsed.weeks !== "object") return { version: 1, weeks: {} };
    const weeks: SeenHistoryV1["weeks"] = {};
    for (const [k, v] of Object.entries(parsed.weeks)) {
      if (!v || typeof v !== "object") continue;
      const urls = Array.isArray((v as any).urls) ? (v as any).urls.filter((u: any) => typeof u === "string") : [];
      weeks[k] = { urls, updated_at: typeof (v as any).updated_at === "string" ? (v as any).updated_at : undefined };
    }
    return { version: 1, weeks };
  } catch {
    return null;
  }
}

export async function loadSeenHistory(filePath: string): Promise<SeenHistoryV1> {
  try {
    const raw = await readFile(filePath, "utf8");
    return safeParseHistory(raw) ?? { version: 1, weeks: {} };
  } catch {
    return { version: 1, weeks: {} };
  }
}

export function getSeenUrlSetForWeek(history: SeenHistoryV1, weekKey: string): Set<string> {
  const urls = history.weeks?.[weekKey]?.urls ?? [];
  return new Set(urls.map(normalizeUrlForDedupe).filter(Boolean));
}

function collectReportUrls(report: WeeklyReport): string[] {
  const urls: string[] = [];
  for (const h of report.top_highlights ?? []) if (h.link) urls.push(h.link);
  for (const updates of Object.values(report.category_updates ?? {})) {
    for (const u of updates ?? []) if (u.url) urls.push(u.url);
  }
  for (const u of report.overseas_competitor_updates ?? []) if (u.url) urls.push(u.url);
  for (const h of report.hiring_signals ?? []) if (h.url) urls.push(h.url);
  return urls;
}

export function filterReportBySeenUrls(args: { report: WeeklyReport; seen: Set<string> }): WeeklyReport {
  const isNew = (url: string | undefined): boolean => {
    if (!url) return true;
    return !args.seen.has(normalizeUrlForDedupe(url));
  };

  const copy: WeeklyReport = JSON.parse(JSON.stringify(args.report));
  copy.top_highlights = (copy.top_highlights ?? []).filter((h) => isNew(h.link));
  for (const key of Object.keys(copy.category_updates ?? {}) as Array<keyof WeeklyReport["category_updates"]>) {
    copy.category_updates[key] = (copy.category_updates[key] ?? []).filter((u) => isNew(u.url));
  }
  copy.overseas_competitor_updates = (copy.overseas_competitor_updates ?? []).filter((u) => isNew(u.url));
  copy.hiring_signals = (copy.hiring_signals ?? []).filter((h) => isNew(h.url));
  return copy;
}

export function filterUrlsBySeen(args: { urls: string[]; seen: Set<string> }): string[] {
  const out: string[] = [];
  const dedupe = new Set<string>();
  for (const u of args.urls) {
    const key = normalizeUrlForDedupe(u);
    if (!key) continue;
    if (args.seen.has(key)) continue;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    out.push(u);
  }
  return out;
}

export function addReportUrlsToHistory(args: {
  history: SeenHistoryV1;
  weekKey: string;
  report: WeeklyReport;
  keepWeeks: number;
}): SeenHistoryV1 {
  const history: SeenHistoryV1 = JSON.parse(JSON.stringify(args.history ?? { version: 1, weeks: {} }));
  const urls = collectReportUrls(args.report).map(normalizeUrlForDedupe).filter(Boolean);
  const existing = new Set((history.weeks?.[args.weekKey]?.urls ?? []).map(normalizeUrlForDedupe));
  for (const u of urls) existing.add(u);

  history.weeks ??= {};
  history.weeks[args.weekKey] = { urls: Array.from(existing), updated_at: new Date().toISOString() };

  const keys = Object.keys(history.weeks);
  keys.sort();
  if (keys.length > args.keepWeeks) {
    const drop = keys.slice(0, Math.max(0, keys.length - args.keepWeeks));
    for (const k of drop) delete history.weeks[k];
  }

  return history;
}

export async function saveSeenHistory(filePath: string, history: SeenHistoryV1): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}
