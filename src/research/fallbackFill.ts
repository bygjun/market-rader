import type { ResearchConfig } from "./config.js";
import type { SourceItem } from "./sourcesSchema.js";
import { WeeklyReportSchema, type WeeklyReport } from "./schema.js";
import { isLikelyNonKoreanCompany } from "./augment.js";

function normalizeCompany(company: string): string {
  return company.trim().replace(/\s+/g, " ");
}

function normalizeCompanyKey(company: string): string {
  let s = company.trim();
  s = s.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  s = s.split("—")[0]?.split("-")[0]?.trim() ?? s;
  return s;
}

function isKoreaCountryLabel(country: string): boolean {
  const c = country.trim().toLowerCase();
  return c === "korea" || c === "south korea" || c === "republic of korea" || c === "kr";
}

function getCountry(company: string, companyHq: Record<string, string>): string | null {
  const candidates = [company, normalizeCompanyKey(company)];
  for (const c of candidates) {
    const v = companyHq[c];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function isLikelyKoreanCompany(company: string, companyHq: Record<string, string>): boolean {
  const c = getCountry(company, companyHq);
  if (c) return isKoreaCountryLabel(c);
  return !isLikelyNonKoreanCompany(company);
}

function inferTag(title: string): string {
  const t = title.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/m&a|인수|합병|acquisition|merge/i, "M&A"],
    [/투자|seed|series|fund|financing|raise/i, "투자"],
    [/ipo|상장|spac/i, "IPO"],
    [/파트너|제휴|협력|partnership|collaboration/i, "제휴"],
    [/출시|런칭|release|launch/i, "출시"],
    [/업데이트|update|changelog/i, "업데이트"],
    [/채용|recruit|hiring|job/i, "채용"],
    [/리포트|보고서|report|outlook/i, "리포트"],
    [/가격|요금|pricing|price/i, "가격"],
    [/특허|patent/i, "특허"],
    [/글로벌|global|overseas|international/i, "글로벌"],
  ];
  for (const [re, tag] of rules) {
    if (re.test(t)) return tag;
  }
  return "Update";
}

function countUpdates(report: WeeklyReport): number {
  return Object.values(report.category_updates ?? {}).reduce((sum, items) => sum + (items?.length ?? 0), 0);
}

export function fillReportFromSourcesFallback(args: {
  report: WeeklyReport;
  sources: SourceItem[];
  config: ResearchConfig;
  companyHq: Record<string, string>;
}): WeeklyReport {
  const { report, sources, config, companyHq } = args;
  const copy: WeeklyReport = JSON.parse(JSON.stringify(report));

  const sourcesByCat = new Map<string, SourceItem[]>();
  for (const s of sources) {
    const list = sourcesByCat.get(s.category) ?? [];
    list.push(s);
    sourcesByCat.set(s.category, list);
  }

  for (const cat of config.categories) {
    const catId = cat.id;
    const existing = copy.category_updates?.[catId] ?? [];

    // Keep only the first item per company to maximize distinct company coverage.
    const dedupedExisting: WeeklyReport["category_updates"][typeof catId] = [];
    const seenCompanies = new Set<string>();
    for (const u of existing) {
      const key = normalizeCompanyKey(u.company);
      if (seenCompanies.has(key)) continue;
      seenCompanies.add(key);
      dedupedExisting.push(u);
    }

    const catSources = (sourcesByCat.get(catId) ?? []).filter((s) => isLikelyKoreanCompany(s.company, companyHq));
    if (catSources.length === 0) {
      copy.category_updates[catId] = dedupedExisting;
      continue;
    }

    const byCompany = new Map<string, SourceItem>();
    for (const s of catSources) {
      const key = normalizeCompanyKey(s.company);
      if (!byCompany.has(key)) byCompany.set(key, s);
    }

    const maxCompanies = Math.max(config.min_companies_per_category, config.max_companies_per_category);
    const final: WeeklyReport["category_updates"][typeof catId] = [...dedupedExisting].slice(0, maxCompanies);
    const already = new Set(final.map((u) => normalizeCompanyKey(u.company)));

    for (const s of byCompany.values()) {
      if (final.length >= maxCompanies) break;
      const key = normalizeCompanyKey(s.company);
      if (already.has(key)) continue;
      final.push({
        company: s.company,
        tag: inferTag(s.title),
        title: s.title,
        url: s.url,
        insight: s.note,
      });
      already.add(key);
    }

    // If we still don't have enough distinct companies, keep what we have (cannot invent).
    copy.category_updates[catId] = final;
  }

  if ((copy.overseas_competitor_updates?.length ?? 0) === 0) {
    const overseasCandidates: WeeklyReport["overseas_competitor_updates"] = [];
    const seen = new Set<string>();
    for (const s of sources) {
      const country = getCountry(s.company, companyHq);
      const isOverseas = country ? !isKoreaCountryLabel(country) : isLikelyNonKoreanCompany(s.company);
      if (!isOverseas) continue;
      const key = `${normalizeCompany(s.company).toLowerCase()}|${s.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      overseasCandidates.push({
        company: s.company,
        country: country ?? undefined,
        tag: inferTag(s.title),
        title: s.title,
        url: s.url,
        insight: s.note,
      });
      if (overseasCandidates.length >= 8) break;
    }
    copy.overseas_competitor_updates = overseasCandidates;
  }

  if ((copy.action_items?.length ?? 0) < 3 && countUpdates(copy) > 0) {
    const actions = new Set<string>(copy.action_items ?? []);
    const suggestions: string[] = [];

    const topUpdates = Object.entries(copy.category_updates)
      .flatMap(([catId, items]) => items.map((u) => ({ catId, u })))
      .slice(0, 6);

    for (const { catId, u } of topUpdates) {
      const action = `기획팀: ${catId} - ${u.company} (${u.tag}) 업데이트 상세 검토 및 벤치마킹 포인트 정리`;
      if (!actions.has(action)) suggestions.push(action);
      actions.add(action);
      if (actions.size >= 6) break;
    }

    copy.action_items = Array.from(actions).concat(suggestions).slice(0, 6);
    if (copy.action_items.length > 6) copy.action_items = copy.action_items.slice(0, 6);
  }

  return WeeklyReportSchema.parse(copy);
}

export function fillOverseasFromSourcesFallback(args: {
  report: WeeklyReport;
  sources: SourceItem[];
  companyHq: Record<string, string>;
  minItems?: number;
  maxItems?: number;
}): WeeklyReport {
  const minItems = args.minItems ?? 10;
  const maxItems = args.maxItems ?? 15;
  const copy: WeeklyReport = JSON.parse(JSON.stringify(args.report));

  const existing = copy.overseas_competitor_updates ?? [];
  const out: WeeklyReport["overseas_competitor_updates"] = [...existing].slice(0, maxItems);
  const seen = new Set<string>(out.map((u) => `${normalizeCompanyKey(u.company)}|${u.title.trim().toLowerCase()}`));
  const seenCompanies = new Set<string>(out.map((u) => normalizeCompanyKey(u.company)));

  const overseasSources = args.sources.filter((s) => {
    const country = getCountry(s.company, args.companyHq);
    if (country) return !isKoreaCountryLabel(country);
    return isLikelyNonKoreanCompany(s.company);
  });

  // Prefer distinct companies first.
  const byCompany = new Map<string, SourceItem[]>();
  for (const s of overseasSources) {
    const key = normalizeCompanyKey(s.company);
    const list = byCompany.get(key) ?? [];
    list.push(s);
    byCompany.set(key, list);
  }

  for (const [companyKey, list] of byCompany.entries()) {
    if (out.length >= maxItems) break;
    if (out.length >= minItems && seenCompanies.has(companyKey)) continue;
    const s = list[0];
    if (!s) continue;
    const key = `${companyKey}|${s.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seenCompanies.add(companyKey);
    const country = getCountry(s.company, args.companyHq);
    out.push({
      company: s.company,
      country: country ?? undefined,
      tag: inferTag(s.title),
      title: s.title,
      url: s.url,
      insight: s.note,
    });
  }

  // If still short, allow additional items even from already-seen companies.
  if (out.length < minItems) {
    for (const s of overseasSources) {
      if (out.length >= maxItems) break;
      const companyKey = normalizeCompanyKey(s.company);
      const key = `${companyKey}|${s.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const country = getCountry(s.company, args.companyHq);
      out.push({
        company: s.company,
        country: country ?? undefined,
        tag: inferTag(s.title),
        title: s.title,
        url: s.url,
        insight: s.note,
      });
    }
  }

  copy.overseas_competitor_updates = out.slice(0, maxItems);
  return WeeklyReportSchema.parse(copy);
}
