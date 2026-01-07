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
    `- Prefer Korean company names for Korean companies; if a Korean company has a common English name, format like "회사명 (English)".`,
    `- IMPORTANT: category_updates MUST contain ONLY Korea-headquartered companies. If a company is headquartered outside Korea, put it in overseas_competitor_updates instead (do NOT include it in category_updates).`,
    `- Also include overseas_competitor_updates: recent updates from competitors headquartered outside Korea (10-15 items when possible, prefer distinct companies). Write tag/title/insight in Korean even for overseas companies. If a company's HQ country is unclear, omit it from overseas_competitor_updates. If watchlist_only=true, overseas_competitor_updates MUST only use watchlist companies and may be empty.`,
    `- If you include any non-Korea companies in top_highlights/category_updates/hiring_signals, try to also include them in overseas_competitor_updates (deduplicate by company+title).`,
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
    `{"report_date":"YYYY-MM-DD","week_number":2,"top_highlights":[{"company":"...","category":"CAT-A","title":"...","insight":"...","importance_score":5,"link":"https://..."}],"category_updates":{"CAT-A":[{"company":"...","tag":"...","title":"...","url":"https://...","insight":"..."}],"CAT-B":[],"CAT-C":[],"CAT-D":[]},"overseas_competitor_updates":[{"company":"...","country":"USA","tag":"...","title":"...","url":"https://...","insight":"..."}],"hiring_signals":[{"company":"...","position":"...","strategic_inference":"...","url":"https://..."}],"action_items":["..."]}`,
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
    `- For EACH category, FIRST collect sources for at least ${config.min_companies_per_category} distinct Korea-headquartered companies when possible.`,
    `- Prefer Korean company names for Korea-headquartered companies; if a Korean company has a common English name, format like "회사명 (English)".`,
    `- Prefer startups/scale-ups over large enterprises.`,
    `- After meeting Korea-headquartered coverage, you MAY include additional overseas competitors (headquartered outside Korea) to support overseas_competitor_updates, but do not reduce Korea coverage.`,
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

export function buildOverseasSourcesPrompt(args: {
  reportDate: string;
  weekNumber: number;
  config: ResearchConfig;
  minItems: number;
}): string {
  const { reportDate, weekNumber, config, minItems } = args;
  const categories = config.categories
    .map((c) => `- ${c.id}: ${c.name}${c.description ? ` (${c.description})` : ""}`)
    .join("\n");

  const excludedCompanies = config.excluded_companies.length
    ? config.excluded_companies.map((c) => `- ${c}`).join("\n")
    : "- (none)";

  const primaryDays = config.lookback_days;
  const fallbackDays = Math.max(primaryDays, Math.min(primaryDays * 2, 14));

  return [
    `You are a market intelligence researcher.`,
    `You MUST use grounded web search.`,
    `Return ONLY JSON. Do not include markdown. Do not return an array.`,
    ``,
    `Task: build a source list for the "overseas competitors" section of a Korean weekly competitor newsletter.`,
    `Report date: ${reportDate}`,
    `Week number: ${weekNumber}`,
    ``,
    `Time window:`,
    `- Primary: last ${primaryDays} days only.`,
    `- Fallback (ONLY if still short of coverage after thorough search): extend up to last ${fallbackDays} days.`,
    ``,
    `Categories (use these exact IDs):`,
    categories,
    ``,
    `Coverage rules:`,
    `- Collect sources for at least ${minItems} DISTINCT competitors headquartered outside Korea (prefer 10-15).`,
    `- Do NOT include ANY Korea-headquartered companies.`,
    `- Each source MUST map to one of the category IDs.`,
    `- Use English queries primarily; also use local-language queries when helpful.`,
    `- Prefer official announcements, release notes/changelogs, funding news, pricing updates, partnerships, hiring pages, and reputable global tech news.`,
    `- Exclude these companies unless absolutely necessary:`,
    excludedCompanies,
    ``,
    `Helpful example competitors (NOT exhaustive; include only if a qualifying source exists in the time window):`,
    `- CAT-A: PitchBook, Crunchbase, CB Insights, Tracxn, Dealroom, FactSet, S&P Capital IQ`,
    `- CAT-B: ZoomInfo, Apollo.io, 6sense, Demandbase, Cognism, Lusha, Clay`,
    `- CAT-C: Jungle Scout, Helium 10, Keepa, DataWeave, Profitero, Stackline`,
    `- CAT-D: OpenAI, Anthropic, Cohere, Mistral AI, Perplexity, Hugging Face, Stability AI`,
    ``,
    `Output JSON schema:`,
    `{"sources":[{"company":"...","category":"CAT-A","title":"...","url":"https://...","published_date":"YYYY-MM-DD","quote":"(optional) short verbatim snippet","note":"(optional) why relevant"}]}`,
    ``,
    `Rules for URLs:`,
    `- NEVER fabricate URLs. Do not guess URL slugs.`,
    `- Only output URLs you actually found in search results or official pages.`,
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
    `- Prefer Korean company names for Korean companies; if a Korean company has a common English name, format like "회사명 (English)".`,
    `- IMPORTANT: category_updates MUST contain ONLY Korea-headquartered companies. If a company is headquartered outside Korea, put it in overseas_competitor_updates instead (do NOT include it in category_updates).`,
    `- For EACH category, include at least ${config.min_companies_per_category} DISTINCT Korea-headquartered companies in category_updates when the provided sources support it, and include at most ${config.max_companies_per_category} companies per category.`,
    `- Include overseas_competitor_updates: 10-15 items about competitors headquartered outside Korea (prefer distinct companies), using only Allowed URLs. Write tag/title/insight in Korean even for overseas companies. If you cannot find suitable overseas items in the provided sources, return an empty array.`,
    `- If the source list contains non-Korea companies that you used elsewhere (top_highlights/category_updates/hiring_signals), prefer adding them into overseas_competitor_updates too (deduplicate).`,
    `- importance_score: 1-5; pick top_highlights as the 3 most important items.`,
    `- Provide 3-6 action_items (array of strings).`,
    `- Do NOT include company_homepages here; it will be attached separately.`,
    ``,
    `Report schema (keys must match exactly):`,
    `{"report_date":"YYYY-MM-DD","week_number":2,"company_homepages":{"회사명":"https://..."}, "top_highlights":[{"company":"...","category":"CAT-A","title":"...","insight":"...","importance_score":5,"link":"https://..."}],"category_updates":{"CAT-A":[{"company":"...","tag":"...","title":"...","url":"https://...","insight":"..."}],"CAT-B":[],"CAT-C":[],"CAT-D":[]},"overseas_competitor_updates":[{"company":"...","country":"USA","tag":"...","title":"...","url":"https://...","insight":"..."}],"hiring_signals":[{"company":"...","position":"...","strategic_inference":"...","url":"https://..."}],"action_items":["..."]}`,
  ].join("\n");
}

export function buildCompanyHomepagesPrompt(args: { lookbackDays: number; companies: string[] }): string {
  const companies = args.companies.map((c) => `- ${c}`).join("\n");
  return [
    `You are collecting official company homepages.`,
    `You MUST use grounded web search.`,
    `Return ONLY JSON, no markdown, no extra text.`,
    ``,
    `Task: for each company below, find the official homepage URL (not a news article, not a social profile).`,
    `If you cannot confidently find the official homepage, omit that company from the output.`,
    ``,
    `Companies:`,
    companies,
    ``,
    `Output schema:`,
    `{"company_homepages":{"회사명":"https://official-domain.tld","다른회사":"https://..."}}`,
    ``,
    `Rules:`,
    `- NEVER fabricate URLs. Do not guess URL slugs or domains.`,
    `- Only output URLs you actually found in search results.`,
  ].join("\n");
}

export function buildCompanyHqPrompt(args: { companies: string[] }): string {
  const companies = args.companies.map((c) => `- ${c}`).join("\n");
  return [
    `You are collecting company headquarters countries.`,
    `You MUST use grounded web search.`,
    `Return ONLY JSON, no markdown, no extra text.`,
    ``,
    `Task: for each company below, identify its headquarters country (HQ country).`,
    `- If the HQ country is unclear, omit that company.`,
    `- Use short English country names (e.g., "Korea", "USA", "Japan", "Singapore"). For South Korea, use exactly "Korea".`,
    ``,
    `Companies:`,
    companies,
    ``,
    `Output schema:`,
    `{"company_hq":{"회사명":"Korea","OtherCompany":"USA"}}`,
  ].join("\n");
}
