import type { ResearchConfig } from "./config.js";

export function buildWeeklyPrompt(args: {
  reportDate: string;
  weekNumber: number;
  config: ResearchConfig;
}): string {
  const { reportDate, weekNumber, config } = args;
  const categories = config.categories
    .map((c) => `- ${c.id}: ${c.name}${c.description ? ` (${c.description})` : ""}`)
    .join("\n");

  const watchlist = config.watchlist
    .map(
      (w) =>
        `- ${w.company} (primary: ${w.category_id}) keywords: ${w.keywords.length ? w.keywords.join(", ") : "(none)"}`,
    )
    .join("\n");

  const excludedCompanies = config.excluded_companies.length
    ? config.excluded_companies.map((c) => `- ${c}`).join("\n")
    : "- (none)";

  return [
    `You are a market intelligence analyst writing a weekly competitor newsletter in Korean.`,
    `You MUST use grounded web search to research the last ${config.lookback_days} days only.`,
    `Return ONLY a single JSON object matching the required schema. Do not include markdown or extra text. Do not return an array.`,
    ``,
    `Report date: ${reportDate}`,
    `Week number: ${weekNumber}`,
    ``,
    `Categories (use these exact IDs):`,
    categories,
    ``,
    `Coverage rules:`,
    `- For EACH category, include updates from at least ${config.min_companies_per_category} distinct companies (if any meaningful updates exist).`,
    `- Keep per-category to at most ${config.max_companies_per_category} companies to stay readable.`,
    config.watchlist_only
      ? `- Use ONLY companies in the watchlist (do not introduce new companies).`
      : `- You MAY introduce additional relevant companies beyond the watchlist to meet coverage, but only if grounded sources exist.`,
    config.prefer_startups
      ? `- Prefer startups/scale-ups over large enterprises. For EACH category, include at least ${config.min_startups_per_category} startups/scale-ups when possible, and include at most ${config.max_enterprises_per_category} large enterprises.`
      : `- Company mix is flexible.`,
    `- Exclude these companies unless they are absolutely necessary for context:`,
    excludedCompanies,
    ``,
    `Watchlist companies to research (focus on credible sources such as official announcements, reputable news, hiring pages):`,
    watchlist,
    ``,
    `Output requirements:`,
    `- Identify meaningful updates per company; if none, omit.`,
    `- For each update: include a short title, a tag like "투자/제휴/기능/채용/특허/가격/글로벌" etc.`,
    `- Provide an "insight" that explains strategic meaning (Insight First).`,
    `- Provide source links (url/link) for each item whenever possible. Prefer including an url; if you cannot find a credible source url, omit that item.`,
    `- NEVER fabricate URLs. Do not guess URL slugs. Only output URLs you actually found in web search results or official pages.`,
    config.min_source_urls > 0
      ? `- Include at least ${config.min_source_urls} unique source URLs overall across the report.`
      : `- Include source URLs whenever possible.`,
    `- importance_score: 1-5, where 5 is critical; pick top_highlights as the 3 most important items.`,
    `- Provide 3-6 action_items that are concrete next steps for our team.`,
    `- action_items MUST be an array of strings (not objects). Example: "기획팀: 알리익스프레스 지표 벤치마킹".`,
    ``,
    `Schema (keys must match exactly):`,
    `{"report_date":"YYYY-MM-DD","week_number":2,"top_highlights":[{"company":"...","category":"CAT-A","title":"...","insight":"...","importance_score":5,"link":"https://..."}],"category_updates":{"CAT-A":[{"company":"...","tag":"...","title":"...","url":"https://...","insight":"..."}],"CAT-B":[],"CAT-C":[],"CAT-D":[]},"hiring_signals":[{"company":"...","position":"...","strategic_inference":"...","url":"https://..."}],"action_items":["..."]}`,
  ].join("\n");
}

export function buildSourcesPrompt(args: {
  reportDate: string;
  weekNumber: number;
  config: ResearchConfig;
}): string {
  const { reportDate, weekNumber, config } = args;
  const categories = config.categories
    .map((c) => `- ${c.id}: ${c.name}${c.description ? ` (${c.description})` : ""}`)
    .join("\n");

  const watchlist = config.watchlist
    .map(
      (w) =>
        `- ${w.company} (primary: ${w.category_id}) keywords: ${w.keywords.length ? w.keywords.join(", ") : "(none)"}`,
    )
    .join("\n");

  const excludedCompanies = config.excluded_companies.length
    ? config.excluded_companies.map((c) => `- ${c}`).join("\n")
    : "- (none)";

  return [
    `You are a market intelligence researcher.`,
    `You MUST use grounded web search to collect sources from the last ${config.lookback_days} days only.`,
    `Return ONLY JSON. Do not include markdown. Do not return an array.`,
    ``,
    `Task: build a source list for a Korean weekly competitor newsletter.`,
    `Report date: ${reportDate}`,
    `Week number: ${weekNumber}`,
    ``,
    `Categories (use these exact IDs):`,
    categories,
    ``,
    `Coverage rules:`,
    `- For EACH category, collect sources for at least ${config.min_companies_per_category} distinct companies when possible.`,
    `- Prefer startups/scale-ups over large enterprises.`,
    `- Exclude these companies unless absolutely necessary:`,
    excludedCompanies,
    config.watchlist_only
      ? `- Use ONLY companies in the watchlist (do not introduce new companies).`
      : `- You MAY introduce additional relevant companies beyond the watchlist, but only if sources exist.`,
    ``,
    `Watchlist (start here):`,
    watchlist,
    ``,
    `Output JSON schema:`,
    `{"sources":[{"company":"...","category":"CAT-A","title":"...","url":"https://...","published_date":"YYYY-MM-DD","quote":"(optional) short verbatim snippet","note":"(optional) why relevant"}]}`,
    ``,
    `Rules for URLs:`,
    `- NEVER fabricate URLs. Do not guess URL slugs.`,
    `- Only output URLs you actually found in search results or official pages.`,
    `- Prefer official announcements, reputable news, and official hiring pages.`,
  ].join("\n");
}

export function buildReportFromSourcesPrompt(args: {
  reportDate: string;
  weekNumber: number;
  config: ResearchConfig;
  sourcesJson: string;
  allowedUrls: string[];
}): string {
  const { reportDate, weekNumber, config, sourcesJson, allowedUrls } = args;
  const categories = config.categories.map((c) => `- ${c.id}: ${c.name}`).join("\n");

  return [
    `You are a market intelligence analyst writing a weekly competitor newsletter in Korean.`,
    `You MUST ONLY use the provided source list. Do NOT browse the web or use any additional sources.`,
    `Return ONLY a single JSON object matching the report schema. Do not include markdown or extra text. Do not return an array.`,
    ``,
    `Report date: ${reportDate}`,
    `Week number: ${weekNumber}`,
    ``,
    `Categories (use these exact IDs):`,
    categories,
    ``,
    `Allowed URLs (you MUST use ONLY these URLs for link/url fields; if no suitable URL exists for an item, omit the item):`,
    ...allowedUrls.map((u) => `- ${u}`),
    ``,
    `Source list JSON (use this as evidence; do not invent anything beyond it):`,
    sourcesJson,
    ``,
    `Output requirements:`,
    `- For each included item, include a source link (url/link) from Allowed URLs exactly.`,
    `- Provide an "insight" that explains strategic meaning (Insight First).`,
    `- importance_score: 1-5; pick top_highlights as the 3 most important items.`,
    `- Provide 3-6 action_items (array of strings).`,
    ``,
    `Report schema (keys must match exactly):`,
    `{"report_date":"YYYY-MM-DD","week_number":2,"top_highlights":[{"company":"...","category":"CAT-A","title":"...","insight":"...","importance_score":5,"link":"https://..."}],"category_updates":{"CAT-A":[{"company":"...","tag":"...","title":"...","url":"https://...","insight":"..."}],"CAT-B":[],"CAT-C":[],"CAT-D":[]},"hiring_signals":[{"company":"...","position":"...","strategic_inference":"...","url":"https://..."}],"action_items":["..."]}`,
  ].join("\n");
}
