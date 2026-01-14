import type { SearchApiEnv } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import type { ResearchConfig } from "./config.js";
import type { SourceItem, SourceList } from "./sourcesSchema.js";

type SearchApiLocale = {
  label: "KR" | "GLOBAL";
  gl: string;
  hl: string;
  extraTerms: string[];
};

function hasHangul(s: string): boolean {
  return /[\uAC00-\uD7AF]/.test(s);
}

function hasLatin(s: string): boolean {
  return /[A-Za-z]/.test(s);
}

function shouldUseCompanyTerm(term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  if (hasHangul(t)) return true;
  if (hasLatin(t)) {
    const letters = t.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 5) return true;
    if (t.includes(".") || t.includes(" ")) return true;
    return false;
  }
  return t.length >= 6;
}

function normalizeUrl(url: string): string {
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

function toMmDdYyyy(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${m}/${d}/${y}`;
}

function subtractDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function mapLimit<T, R>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const c = Math.max(1, Math.trunc(concurrency));
  let index = 0;
  const results: R[] = new Array(items.length);

  const workers = Array.from({ length: Math.min(c, items.length) }, async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) break;
      results[i] = await run(items[i]!, i);
    }
  });

  return Promise.all(workers).then(() => results);
}

function buildQuery(args: { company: string; keywords: string[]; locale: SearchApiLocale; start: string; end: string }): string {
  const base = [`"${args.company}"`];
  const terms = Array.from(
    new Set(
      [...args.keywords, ...args.locale.extraTerms]
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12),
    ),
  );

  if (terms.length) base.push(`(${terms.map((t) => `"${t}"`).join(" OR ")})`);
  return base.join(" ");
}

function buildCompanyOnlyQuery(company: string): string {
  return `"${company.trim()}"`;
}

function pickDomainAlias(aliases: string[]): string | null {
  for (const a of aliases) {
    const t = a.trim();
    if (!t) continue;
    if (!shouldUseCompanyTerm(t)) continue;
    if (t.includes(".")) return t;
  }
  return null;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`SearchAPI HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`SearchAPI returned non-JSON: ${text.slice(0, 400)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function coerceNewsResults(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const candidates = [
    obj.news_results,
    obj.top_stories,
    obj.organic_results,
    obj.results,
    obj.items,
    obj.data,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter((x) => !!x && typeof x === "object") as Array<Record<string, unknown>>;
  }
  return [];
}

function coerceString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function pickFirstUrl(item: Record<string, unknown>): string | null {
  // Prefer publisher URLs over Google/aggregator wrapper URLs when available.
  const keys = ["news_url", "source_url", "url", "link"];
  for (const k of keys) {
    const s = coerceString(item[k]);
    if (s && /^https?:\/\//i.test(s)) return s;
  }
  const nested = item.story && typeof item.story === "object" ? (item.story as Record<string, unknown>) : null;
  if (nested) {
    for (const k of keys) {
      const s = coerceString(nested[k]);
      if (s && /^https?:\/\//i.test(s)) return s;
    }
  }
  return null;
}

function shouldExcludeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const pathname = u.pathname.toLowerCase();
    const badHosts = [
      "instagram.com",
      "www.instagram.com",
      "facebook.com",
      "www.facebook.com",
      "tiktok.com",
      "www.tiktok.com",
      "youtube.com",
      "www.youtube.com",
      "x.com",
      "twitter.com",
      "www.twitter.com",
      "linkedin.com",
      "www.linkedin.com",
      "pinterest.com",
      "www.pinterest.com",
      "reddit.com",
      "www.reddit.com",
      "engine.roa.ai",
      "www.engine.roa.ai",
    ];
    if (badHosts.includes(host)) return true;
    if (host.endsWith("google.com") || host.endsWith("googleusercontent.com")) return true;
    if (pathname.endsWith("/error") || pathname.endsWith("/error.html") || pathname.includes("/error.html")) return true;
    if (pathname.includes("image_popup")) return true;
    if (u.pathname.includes("/popular/")) return true;
    return false;
  } catch {
    return true;
  }
}

function pickTitle(item: Record<string, unknown>): string | null {
  return coerceString(item.title) ?? coerceString(item.headline) ?? coerceString(item.name);
}

function pickDate(item: Record<string, unknown>): string | undefined {
  const d = coerceString(item.date) ?? coerceString(item.published) ?? coerceString(item.published_date);
  return d ?? undefined;
}

function pickSnippet(item: Record<string, unknown>): string | undefined {
  const s = coerceString(item.snippet) ?? coerceString(item.description) ?? coerceString(item.summary);
  return s ?? undefined;
}

function mentionsCompany(args: { companyTerms: string[]; title: string; snippet?: string }): boolean {
  const hay = `${args.title} ${args.snippet ?? ""}`.toLowerCase();
  for (const raw of args.companyTerms) {
    const term = raw.trim().toLowerCase();
    if (!term) continue;
    if (hay.includes(term)) return true;
  }
  return false;
}

async function searchOne(args: {
  env: SearchApiEnv;
  q: string;
  gl: string;
  hl: string;
  start: string;
  end: string;
  maxResults: number;
  maxPages: number;
  requireCompanyMention: boolean;
  companyTerms: string[];
}): Promise<Array<{ title: string; url: string; published_date?: string; snippet?: string }>> {
  const out: Array<{ title: string; url: string; published_date?: string; snippet?: string }> = [];
  const seen = new Set<string>();

  for (let page = 1; page <= Math.max(1, args.maxPages); page++) {
    if (out.length >= args.maxResults) break;

    const params = new URLSearchParams();
    params.set("engine", "google_news");
    params.set("q", args.q);
    params.set("gl", args.gl);
    params.set("hl", args.hl);
    params.set("api_key", args.env.SEARCHAPI_API_KEY);
    params.set("sort_by", "most_recent");
    params.set("page", String(page));

    // SearchAPI-supported custom time range filter.
    params.set("time_period_min", toMmDdYyyy(args.start));
    params.set("time_period_max", toMmDdYyyy(args.end));

    const url = `${args.env.SEARCHAPI_BASE_URL}?${params.toString()}`;
    const raw = await fetchJsonWithTimeout(url, 25_000);
    const results = coerceNewsResults(raw);
    if (results.length === 0) break;

    let addedThisPage = 0;
    for (const item of results) {
      const title = pickTitle(item);
      const link = pickFirstUrl(item);
      if (!title || !link) continue;
      if (shouldExcludeUrl(link)) continue;
      const snippet = pickSnippet(item) ?? undefined;
      if (args.requireCompanyMention && args.companyTerms.length > 0) {
        if (!mentionsCompany({ companyTerms: args.companyTerms, title, snippet })) continue;
      }
      const key = normalizeUrl(link);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ title, url: link, published_date: pickDate(item), snippet });
      addedThisPage++;
      if (out.length >= args.maxResults) break;
    }

    if (addedThisPage === 0) break;
  }

  return out;
}

async function searchWithFallback(args: {
  env: SearchApiEnv;
  primaryQ: string;
  fallbackQ: string;
  gl: string;
  hl: string;
  start: string;
  end: string;
  maxResults: number;
  maxPages: number;
  requireCompanyMention: boolean;
  companyTerms: string[];
}): Promise<Array<{ title: string; url: string; published_date?: string; snippet?: string }>> {
  const primary = await searchOne({
    env: args.env,
    q: args.primaryQ,
    gl: args.gl,
    hl: args.hl,
    start: args.start,
    end: args.end,
    maxResults: args.maxResults,
    maxPages: args.maxPages,
    requireCompanyMention: args.requireCompanyMention,
    companyTerms: args.companyTerms,
  });

  const minEnough = Math.min(10, Math.max(3, Math.floor(args.maxResults / 10)));
  if (primary.length >= minEnough) return primary;

  const remaining = Math.max(0, args.maxResults - primary.length);
  if (remaining === 0) return primary;

  const secondary = await searchOne({
    env: args.env,
    q: args.fallbackQ,
    gl: args.gl,
    hl: args.hl,
    start: args.start,
    end: args.end,
    maxResults: remaining,
    maxPages: args.maxPages,
    requireCompanyMention: args.requireCompanyMention,
    companyTerms: args.companyTerms,
  });

  const seen = new Set(primary.map((x) => normalizeUrl(x.url)));
  const merged = [...primary];
  for (const s of secondary) {
    const key = normalizeUrl(s.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(s);
    if (merged.length >= args.maxResults) break;
  }
  return merged;
}

export async function generateSourceListViaSearchApiGoogleNews(args: {
  env: SearchApiEnv;
  config: ResearchConfig;
  reportDate: string;
}): Promise<{ sources: SourceList; meta: { provider: "searchapi_google_news"; queries: number; results: number } }> {
  return generateSourceListViaSearchApiGoogleNewsForWatchlist({
    env: args.env,
    config: args.config,
    reportDate: args.reportDate,
    watchlist: args.config.watchlist ?? [],
  });
}

export async function generateSourceListViaSearchApiGoogleNewsForWatchlist(args: {
  env: SearchApiEnv;
  config: ResearchConfig;
  reportDate: string;
  watchlist: ResearchConfig["watchlist"];
  overrides?: { maxResults?: number; maxPages?: number; includeKr?: boolean; includeGlobal?: boolean };
}): Promise<{ sources: SourceList; meta: { provider: "searchapi_google_news"; queries: number; results: number } }> {
  const lookbackDays = args.config.lookback_days ?? 7;
  const start = subtractDays(args.reportDate, Math.max(0, lookbackDays - 1));
  const end = args.reportDate;

  const opts = args.config.searchapi ?? {};
  const locales: SearchApiLocale[] = [];
  const includeKr = args.overrides?.includeKr ?? (opts.include_kr ?? true);
  const includeGlobal = args.overrides?.includeGlobal ?? (opts.include_global ?? true);
  if (includeKr) {
    locales.push({
      label: "KR",
      gl: opts.kr_gl ?? "kr",
      hl: opts.kr_hl ?? "ko",
      extraTerms: ["출시", "론칭", "런칭", "업데이트", "기능", "발표", "제휴", "파트너십", "투자", "채용"],
    });
  }
  if (includeGlobal) {
    locales.push({
      label: "GLOBAL",
      gl: opts.global_gl ?? "us",
      hl: opts.global_hl ?? "en",
      extraTerms: ["launch", "release", "releases", "update", "announces", "introduces", "partnership", "funding", "hiring"],
    });
  }

  const tasks: Array<{
    company: string; // label to attach to sources
    queryCompany: string; // name used for query + fallback
    companyTerms: string[]; // terms required to appear in title/snippet
    category: SourceItem["category"];
    q: string;
    locale: SearchApiLocale;
    maxResults: number;
    maxPages: number;
  }> = [];

  for (const w of args.watchlist ?? []) {
    for (const locale of locales) {
      let queryCompany = w.company;
      if (locale.label === "GLOBAL" && hasHangul(w.company) && !hasLatin(w.company)) {
        const domain = pickDomainAlias(w.aliases ?? []);
        const alias = domain ?? (w.aliases ?? []).find((a) => hasLatin(a) && shouldUseCompanyTerm(a));
        if (!alias) continue;
        queryCompany = alias;
      } else if (locale.label === "GLOBAL") {
        const domain = pickDomainAlias(w.aliases ?? []);
        if (domain) queryCompany = domain;
      }
      const companyTerms = Array.from(
        new Set([w.company, queryCompany, ...(w.aliases ?? [])].map((s) => s.trim()).filter(shouldUseCompanyTerm)),
      );
      const q = buildQuery({ company: queryCompany, keywords: w.keywords ?? [], locale, start, end });
      const maxResults = args.overrides?.maxResults ?? opts.max_results_per_query ?? 10;
      const maxPages = args.overrides?.maxPages ?? opts.max_pages_per_query ?? 3;
      tasks.push({ company: w.company, queryCompany, companyTerms, category: w.category_id, q, locale, maxResults, maxPages });
    }
  }

  // Global competitor watchlist: query GLOBAL locale only (unless explicitly disabled).
  const globalWatchlist = args.config.global_watchlist ?? [];
  if (globalWatchlist.length) {
    const globalLocale = locales.find((l) => l.label === "GLOBAL");
    if (globalLocale) {
      const maxResults = opts.global_watchlist_max_results_per_query ?? 20;
      const maxPages = opts.global_watchlist_max_pages_per_query ?? 2;
      for (const w of globalWatchlist) {
        let queryCompany = w.company;
        if (hasHangul(w.company) && !hasLatin(w.company)) {
          const domain = pickDomainAlias(w.aliases ?? []);
          const alias = domain ?? (w.aliases ?? []).find((a) => hasLatin(a) && shouldUseCompanyTerm(a));
          if (!alias) continue;
          queryCompany = alias;
        } else {
          const domain = pickDomainAlias(w.aliases ?? []);
          if (domain) queryCompany = domain;
        }
        const companyTerms = Array.from(
          new Set([w.company, queryCompany, ...(w.aliases ?? [])].map((s) => s.trim()).filter(shouldUseCompanyTerm)),
        );
        const q = buildQuery({ company: queryCompany, keywords: w.keywords ?? [], locale: globalLocale, start, end });
        tasks.push({
          company: w.company,
          queryCompany,
          companyTerms,
          category: w.category_id,
          q,
          locale: globalLocale,
          maxResults,
          maxPages,
        });
      }
    }
  }

  if (opts.include_category_queries) {
    for (const c of args.config.categories ?? []) {
      const keywords = [c.name, c.description ?? ""].map((s) => s.trim()).filter(Boolean);
      for (const locale of locales) {
        const q = buildQuery({ company: c.name, keywords, locale, start, end });
        const maxResults = args.overrides?.maxResults ?? opts.max_results_per_query ?? 10;
        const maxPages = args.overrides?.maxPages ?? opts.max_pages_per_query ?? 3;
        tasks.push({
          company: c.name,
          queryCompany: c.name,
          companyTerms: [c.name].filter(shouldUseCompanyTerm),
          category: c.id,
          q,
          locale,
          maxResults,
          maxPages,
        });
      }
    }
  }

  const concurrency = opts.concurrency ?? 4;
  const requireCompanyMention = opts.require_company_mention ?? true;

  const results = await mapLimit(tasks, concurrency, async (t) => {
    try {
      const primaryQ = t.q;
      const fallbackQ = buildCompanyOnlyQuery(t.queryCompany);
      const items = await searchWithFallback({
        env: args.env,
        primaryQ,
        fallbackQ,
        gl: t.locale.gl,
        hl: t.locale.hl,
        start,
        end,
        maxResults: t.maxResults,
        maxPages: t.maxPages,
        requireCompanyMention,
        companyTerms: t.companyTerms,
      });
      logger.info(
        { company: t.company, queryCompany: t.queryCompany, locale: t.locale.label, results: items.length },
        "SearchAPI query results",
      );
      return items.map((item) => ({ ...item, company: t.company, category: t.category, locale: t.locale.label }));
    } catch (err) {
      logger.warn({ err, q: t.q, gl: t.locale.gl, hl: t.locale.hl }, "SearchAPI google_news query failed");
      return [] as Array<{ title: string; url: string; published_date?: string; snippet?: string; company: string; category: SourceItem["category"]; locale: string }>;
    }
  });

  const flat = results.flat();
  const seen = new Set<string>();
  const sources: SourceItem[] = [];
  for (const r of flat) {
    const key = normalizeUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      company: r.company,
      category: r.category,
      title: r.title,
      url: r.url,
      published_date: r.published_date,
      note: `[${r.locale}] ${r.snippet ?? ""}`.trim(),
    });
  }

  logger.info({ queries: tasks.length, results: flat.length, kept: sources.length }, "Collected sources via SearchAPI");

  return {
    sources: { sources },
    meta: { provider: "searchapi_google_news", queries: tasks.length, results: sources.length },
  };
}
