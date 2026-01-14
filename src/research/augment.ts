import { WeeklyReportSchema, type WeeklyReport } from "./schema.js";

function normalizeCompany(company: string): string {
  return company
    .trim()
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function hasHangul(s: string): boolean {
  return /[\uAC00-\uD7AF]/.test(s);
}

function hasLatin(s: string): boolean {
  return /[A-Za-z]/.test(s);
}

function getCompanyHomepageHost(report: WeeklyReport, company: string): string | null {
  const url = report.company_homepages?.[company];
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isLikelyNonKoreanCompany(company: string, report?: WeeklyReport): boolean {
  const hangul = hasHangul(company);
  const latin = hasLatin(company);
  if (hangul) return false; // treat "한글 (English)" as Korean by default

  const host = report ? getCompanyHomepageHost(report, company) : null;
  if (host && host.endsWith(".kr")) return false;

  return latin;
}

export function ensureOverseasCompetitorSection(args: {
  report: WeeklyReport;
}): WeeklyReport {
  const { report } = args;
  const minItems = 10;
  const maxItems = 15;
  if ((report.overseas_competitor_updates?.length ?? 0) >= minItems) return report;

  const existing = report.overseas_competitor_updates ?? [];
  const candidates: Array<NonNullable<WeeklyReport["overseas_competitor_updates"]>[number]> = [...existing];
  const seen = new Set<string>(existing.map((u) => `${normalizeCompany(u.company)}|${u.title.trim().toLowerCase()}`));

  for (const h of report.top_highlights) {
    if (!h.link) continue;
    if (!isLikelyNonKoreanCompany(h.company)) continue;
    const key = `${normalizeCompany(h.company)}|${h.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      company: h.company,
      category: h.category,
      tag: "Highlight",
      title: h.title,
      url: h.link,
      insight: h.insight,
    });
  }

  for (const h of report.hiring_signals) {
    if (!h.url) continue;
    if (!isLikelyNonKoreanCompany(h.company)) continue;
    const title = `채용: ${h.position}`;
    const key = `${normalizeCompany(h.company)}|${title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      company: h.company,
      tag: "Hiring",
      title,
      url: h.url,
      insight: h.strategic_inference,
    });
  }

  const copy: WeeklyReport = JSON.parse(JSON.stringify(report));
  copy.overseas_competitor_updates = candidates.slice(0, maxItems);
  return WeeklyReportSchema.parse(copy);
}

function isKoreaCountryLabel(country: string): boolean {
  const c = country.trim().toLowerCase();
  return c === "korea" || c === "south korea" || c === "republic of korea" || c === "kr";
}

function normalizeCompanyKey(company: string): string {
  let s = company.trim();
  s = s.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  s = s.split("—")[0]?.split("-")[0]?.trim() ?? s;
  return s;
}

export function splitOverseasFromCategoryUpdatesByHq(args: {
  report: WeeklyReport;
  companyHq: Record<string, string>;
}): WeeklyReport {
  const { report, companyHq } = args;
  const copy: WeeklyReport = JSON.parse(JSON.stringify(report));

  const overseas = copy.overseas_competitor_updates ?? [];
  const seen = new Set<string>(
    overseas.map((u) => `${normalizeCompany(u.company)}|${u.title.trim().toLowerCase()}`),
  );

  const getCountry = (company: string): string | null => {
    const candidates = [company, normalizeCompanyKey(company)];
    for (const c of candidates) {
      const v = companyHq[c];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };

  for (const cat of Object.keys(copy.category_updates) as Array<keyof WeeklyReport["category_updates"]>) {
    const kept: WeeklyReport["category_updates"][typeof cat] = [];
    for (const u of copy.category_updates[cat]) {
      const country = getCountry(u.company);
      if (!country || isKoreaCountryLabel(country)) {
        kept.push(u);
        continue;
      }

      if (!u.url) continue;
      const key = `${normalizeCompany(u.company)}|${u.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      overseas.push({
        company: u.company,
        country,
        category: cat,
        tag: u.tag,
        title: u.title,
        url: u.url,
        insight: u.insight,
      });
    }
    copy.category_updates[cat] = kept;
  }

  copy.overseas_competitor_updates = overseas
    .map((u) => {
      if (u.country) return u;
      const country = getCountry(u.company);
      if (!country || isKoreaCountryLabel(country)) return u;
      return { ...u, country };
    })
    .slice(0, 15);

  return WeeklyReportSchema.parse(copy);
}
