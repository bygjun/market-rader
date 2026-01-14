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

function toOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s ? s : undefined;
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

    const isSearchApiMode = config.source_provider === "searchapi_google_news";
    const dedupedExisting: WeeklyReport["category_updates"][typeof catId] = [];
    if (isSearchApiMode) {
      dedupedExisting.push(...existing);
    } else {
      // Keep only the first item per company to maximize distinct company coverage.
      const seenCompanies = new Set<string>();
      for (const u of existing) {
        const key = normalizeCompanyKey(u.company);
        if (seenCompanies.has(key)) continue;
        seenCompanies.add(key);
        dedupedExisting.push(u);
      }
    }

    const catSources = (sourcesByCat.get(catId) ?? []).filter((s) => isLikelyKoreanCompany(s.company, companyHq));
    if (catSources.length === 0) {
      copy.category_updates[catId] = dedupedExisting;
      continue;
    }

    const maxCompanies = config.max_companies_per_category;
    const final: WeeklyReport["category_updates"][typeof catId] = [];

    if (isSearchApiMode) {
      const maxUpdatesPerCompany = config.searchapi?.max_updates_per_company ?? 3;
      const seenItems = new Set<string>();
      const companyCounts = new Map<string, number>();
      const companyOrder: string[] = [];
      const companyName: Record<string, string> = {};

      const addUpdate = (u: WeeklyReport["category_updates"][typeof catId][number]): void => {
        const companyKey = normalizeCompanyKey(u.company);
        const itemKey = u.url ? u.url : `${companyKey}|${u.title.trim().toLowerCase()}`;
        if (seenItems.has(itemKey)) return;
        const currentCompanies = companyCounts.size;
        if (!companyCounts.has(companyKey) && currentCompanies >= maxCompanies) return;
        const count = companyCounts.get(companyKey) ?? 0;
        if (count >= maxUpdatesPerCompany) return;
        seenItems.add(itemKey);
        companyCounts.set(companyKey, count + 1);
        if (!companyName[companyKey]) {
          companyName[companyKey] = u.company;
          companyOrder.push(companyKey);
        }
        final.push(u);
      };

      for (const u of dedupedExisting) addUpdate(u);

      for (const s of catSources) {
        const companyKey = normalizeCompanyKey(s.company);
        if (!companyName[companyKey]) {
          companyName[companyKey] = s.company;
          companyOrder.push(companyKey);
        }
      }

      const sourcesByCompany = new Map<string, SourceItem[]>();
      for (const s of catSources) {
        const companyKey = normalizeCompanyKey(s.company);
        const list = sourcesByCompany.get(companyKey) ?? [];
        list.push(s);
        sourcesByCompany.set(companyKey, list);
      }

      // Preserve company order, fill up to maxUpdatesPerCompany per company and maxCompanies companies.
      for (const companyKey of companyOrder) {
        const list = sourcesByCompany.get(companyKey) ?? [];
        for (const s of list) {
          addUpdate({
            company: s.company,
            tag: inferTag(s.title),
            title: s.title,
            url: s.url,
            insight: toOptionalNonEmptyString(s.note),
          });
        }
      }
    } else {
      final.push(...dedupedExisting.slice(0, maxCompanies));
      const byCompany = new Map<string, SourceItem>();
      for (const s of catSources) {
        const key = normalizeCompanyKey(s.company);
        if (!byCompany.has(key)) byCompany.set(key, s);
      }

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
          insight: toOptionalNonEmptyString(s.note),
        });
        already.add(key);
      }
    }

    // If we still don't have enough distinct companies, keep what we have (cannot invent).
    copy.category_updates[catId] = final;
  }

  if ((copy.overseas_competitor_updates?.length ?? 0) === 0) {
    const maxItems = 15;
    const perCategoryTarget = Math.max(1, Math.min(3, Math.ceil(maxItems / Math.max(1, config.categories.length))));

    const overseasSources = sources.filter((s) => {
      const country = getCountry(s.company, companyHq);
      return country ? !isKoreaCountryLabel(country) : isLikelyNonKoreanCompany(s.company);
    });

    const byCategoryCompany = new Map<string, Map<string, SourceItem[]>>();
    for (const s of overseasSources) {
      const cat = s.category;
      const companyKey = normalizeCompanyKey(s.company);
      const companies = byCategoryCompany.get(cat) ?? new Map<string, SourceItem[]>();
      const list = companies.get(companyKey) ?? [];
      list.push(s);
      companies.set(companyKey, list);
      byCategoryCompany.set(cat, companies);
    }

    const out: WeeklyReport["overseas_competitor_updates"] = [];
    const seenCompanies = new Set<string>();
    const seenItems = new Set<string>();

    const pushOne = (s: SourceItem) => {
      const companyKey = normalizeCompanyKey(s.company);
      const itemKey = `${companyKey}|${s.title.trim().toLowerCase()}`;
      if (seenItems.has(itemKey)) return;
      if (seenCompanies.has(companyKey)) return;
      seenItems.add(itemKey);
      seenCompanies.add(companyKey);
      const country = getCountry(s.company, companyHq);
      out.push({
        company: s.company,
        country: country ?? undefined,
        category: s.category,
        tag: inferTag(s.title),
        title: s.title,
        url: s.url,
        insight: toOptionalNonEmptyString(s.note),
      });
    };

    // Pass 1: pick a few companies per category to improve category coverage.
    for (const cat of config.categories) {
      const companies = byCategoryCompany.get(cat.id);
      if (!companies) continue;
      let picked = 0;
      for (const list of companies.values()) {
        if (out.length >= maxItems) break;
        const s = list[0];
        if (!s) continue;
        pushOne(s);
        if (seenCompanies.has(normalizeCompanyKey(s.company))) picked++;
        if (picked >= perCategoryTarget) break;
      }
    }

    // Pass 2: fill remaining slots with distinct companies regardless of category.
    if (out.length < maxItems) {
      for (const s of overseasSources) {
        if (out.length >= maxItems) break;
        pushOne(s);
      }
    }

    copy.overseas_competitor_updates = out.slice(0, maxItems);
  }

  if ((copy.action_items?.length ?? 0) < 3 && countUpdates(copy) > 0) {
    const actions = new Set<string>(copy.action_items ?? []);
    const topUpdates = Object.entries(copy.category_updates)
      .flatMap(([catId, items]) => items.map((u) => ({ catId, u })))
      .slice(0, 6);

    for (const { catId, u } of topUpdates) {
      const action = `기획팀: ${catId} - ${u.company} (${u.tag}) 업데이트 상세 검토 및 벤치마킹 포인트 정리`;
      actions.add(action);
      if (actions.size >= 6) break;
    }

    copy.action_items = Array.from(actions).slice(0, 6);
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
      category: s.category,
      tag: inferTag(s.title),
      title: s.title,
      url: s.url,
      insight: toOptionalNonEmptyString(s.note),
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
        category: s.category,
        tag: inferTag(s.title),
        title: s.title,
        url: s.url,
        insight: toOptionalNonEmptyString(s.note),
      });
    }
  }

  copy.overseas_competitor_updates = out.slice(0, maxItems);
  return WeeklyReportSchema.parse(copy);
}
