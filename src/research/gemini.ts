import { GoogleGenAI } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import type { GeminiEnv } from "../lib/env.js";
import { WeeklyReportSchema, type WeeklyReport } from "./schema.js";
import { logger } from "../lib/logger.js";
import { listModels, pickFallbackModel } from "./models.js";
import { WeeklyReportJsonSchema } from "./reportJsonSchema.js";
import { SourceListSchema, type SourceList } from "./sourcesSchema.js";
import { CompanyHomepagesSchema, type CompanyHomepages } from "./homepagesSchema.js";
import { CompanyHqSchema, type CompanyHq } from "./companyHqSchema.js";
import { CompanyDiscoverySchema, type CompanyDiscovery } from "./companyDiscoverySchema.js";
import { CompanyDiscoveryJsonSchema } from "./companyDiscoveryJsonSchema.js";
import { OverseasTranslateItemJsonSchema, OverseasTranslateJsonSchema } from "./overseasTranslateSchema.js";

function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(jsonrepair(text));
  }
}

function extractFirstJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const sliced = text.slice(start, end + 1);
  return parseJsonLenient(sliced);
}

async function repairToValidJson(args: {
  ai: GoogleGenAI;
  model: string;
  badText: string;
}): Promise<unknown> {
  const repairPrompt = [
    "You are a strict JSON reformatter.",
    "Given the following text that should be a single JSON object, output ONLY a corrected, valid JSON object that matches the schema.",
    "Do not add new facts; preserve URLs and content; only fix structure/types/quoting/commas.",
    "",
    "TEXT TO FIX:",
    args.badText,
  ].join("\n");

  const repaired = await args.ai.models.generateContent({
    model: args.model,
    contents: repairPrompt,
    config: {
      temperature: 0,
      maxOutputTokens: 4000,
      responseMimeType: "application/json",
      responseJsonSchema: WeeklyReportJsonSchema,
    },
  });

  const text = repaired.text ?? "";
  return parseJsonLenient(text);
}

function normalizeRootJson(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length === 1) return value[0];
  const candidate = value.find(
    (v) =>
      !!v &&
      typeof v === "object" &&
      "report_date" in (v as Record<string, unknown>) &&
      "category_updates" in (v as Record<string, unknown>),
  );
  return candidate ?? value[0];
}

function applyMissingFieldPlaceholders(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

  const ensureString = (value: unknown, fallback: string): string => {
    if (typeof value === "string") {
      const s = value.trim();
      return s ? s : fallback;
    }
    return fallback;
  };

  const ensureInt = (value: unknown, fallback: number): number => {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    return fallback;
  };

  // If a section is present but malformed, delete it so Zod defaults can apply.
  if (copy.category_updates && (typeof copy.category_updates !== "object" || Array.isArray(copy.category_updates))) {
    delete copy.category_updates;
  }
  if (copy.hiring_signals && !Array.isArray(copy.hiring_signals)) delete copy.hiring_signals;
  if (copy.action_items && !Array.isArray(copy.action_items)) delete copy.action_items;
  if (copy.company_homepages && (typeof copy.company_homepages !== "object" || Array.isArray(copy.company_homepages))) {
    delete copy.company_homepages;
  }
  if (copy.overseas_competitor_updates && !Array.isArray(copy.overseas_competitor_updates)) {
    delete copy.overseas_competitor_updates;
  }

  if (Array.isArray(copy.top_highlights)) {
    copy.top_highlights = copy.top_highlights.map((h) => {
      if (!h || typeof h !== "object") return h;
      const obj = h as Record<string, unknown>;
      obj.company = ensureString(obj.company, "(회사명 미상)");
      obj.title = ensureString(obj.title, "(제목 없음)");
      obj.insight = ensureString(obj.insight, "요약(Insight) 자동 생성 실패: 출처 링크를 확인하세요.");
      obj.importance_score = ensureInt(obj.importance_score, 3);
      return obj;
    });
  }

  if (copy.category_updates && typeof copy.category_updates === "object" && !Array.isArray(copy.category_updates)) {
    const cu = copy.category_updates as Record<string, unknown>;
    for (const [cat, items] of Object.entries(cu)) {
      if (!Array.isArray(items)) continue;
      cu[cat] = items.map((u) => {
        if (!u || typeof u !== "object") return u;
        const obj = u as Record<string, unknown>;
        obj.company = ensureString(obj.company, "(회사명 미상)");
        obj.tag = ensureString(obj.tag, "Update");
        obj.title = ensureString(obj.title, "(제목 없음)");
        return obj;
      });
    }
  }

  if (Array.isArray(copy.overseas_competitor_updates)) {
    copy.overseas_competitor_updates = copy.overseas_competitor_updates.map((u) => {
      if (!u || typeof u !== "object") return u;
      const obj = u as Record<string, unknown>;
      obj.company = ensureString(obj.company, "(회사명 미상)");
      obj.tag = ensureString(obj.tag, "Update");
      obj.title = ensureString(obj.title, "(제목 없음)");
      return obj;
    });
  }

  if (Array.isArray(copy.hiring_signals)) {
    copy.hiring_signals = copy.hiring_signals.map((h) => {
      if (!h || typeof h !== "object") return h;
      const obj = h as Record<string, unknown>;
      obj.company = ensureString(obj.company, "(회사명 미상)");
      obj.position = ensureString(obj.position, "(직무 미상)");
      obj.strategic_inference = ensureString(
        obj.strategic_inference,
        "해석 자동 생성 실패: 출처 링크를 확인하세요.",
      );
      return obj;
    });
  }

  return copy;
}

function countSourceUrls(report: WeeklyReport): number {
  const urls = new Set<string>();
  for (const h of report.top_highlights) {
    if (h.link) urls.add(h.link);
  }
  for (const updates of Object.values(report.category_updates)) {
    for (const u of updates) {
      if (u.url) urls.add(u.url);
    }
  }
  for (const u of report.overseas_competitor_updates ?? []) {
    if (u.url) urls.add(u.url);
  }
  for (const h of report.hiring_signals) {
    if (h.url) urls.add(h.url);
  }
  return urls.size;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of Array.from(u.searchParams.keys())) {
      if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
    }
    if (!u.searchParams.toString()) u.search = "";
    // normalize trailing slash (keep root)
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return url.trim();
  }
}

function hasHangul(s: string): boolean {
  return /[\uAC00-\uD7AF]/.test(s);
}

function looksEnglishish(s: string): boolean {
  if (!s) return false;
  const trimmed = s.trim();
  if (!trimmed) return false;
  if (hasHangul(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed);
}

function needsOverseasKoreanTranslation(report: WeeklyReport): boolean {
  const updates = report.overseas_competitor_updates ?? [];
  return updates.some(
    (u) => looksEnglishish(u.title) || looksEnglishish(u.tag) || (u.insight ? looksEnglishish(u.insight) : false),
  );
}

function extractGroundedUrls(result: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>): string[] {
  const chunks = result?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const urls: string[] = [];
  for (const c of chunks) {
    const uri = c?.web?.uri;
    if (typeof uri === "string" && uri.startsWith("http")) urls.push(uri);
  }
  return urls;
}

function enforceAllowedUrlsOnReport(report: WeeklyReport, allowedUrls: string[]): WeeklyReport {
  const allowed = new Set(allowedUrls.map(normalizeUrl));
  const copy: WeeklyReport = JSON.parse(JSON.stringify(report));

  copy.top_highlights = copy.top_highlights
    .map((h) => {
      if (h.link && !allowed.has(normalizeUrl(h.link))) h.link = undefined;
      return h;
    })
    .filter((h) => !h.link || allowed.has(normalizeUrl(h.link)));

  for (const cat of Object.keys(copy.category_updates) as Array<keyof WeeklyReport["category_updates"]>) {
    copy.category_updates[cat] = copy.category_updates[cat]
      .map((u) => {
        if (u.url && !allowed.has(normalizeUrl(u.url))) u.url = undefined;
        return u;
      })
      .filter((u) => !u.url || allowed.has(normalizeUrl(u.url)));
  }

  copy.overseas_competitor_updates = (copy.overseas_competitor_updates ?? [])
    .map((u) => {
      if (u.url && !allowed.has(normalizeUrl(u.url))) u.url = undefined;
      return u;
    })
    .filter((u) => !u.url || allowed.has(normalizeUrl(u.url)));

  copy.hiring_signals = copy.hiring_signals
    .map((h) => {
      if (h.url && !allowed.has(normalizeUrl(h.url))) h.url = undefined;
      return h;
    })
    .filter((h) => !h.url || allowed.has(normalizeUrl(h.url)));

  return WeeklyReportSchema.parse(copy);
}

async function selectModelOrFallback(args: {
  env: GeminiEnv;
  ai: GoogleGenAI;
  model: string;
  run: (modelName: string) => Promise<Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>>;
}): Promise<{ modelUsed: string; result: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>> }> {
  try {
    const result = await args.run(args.model);
    return { modelUsed: args.model, result };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    const isNotFound =
      e?.status === 404 ||
      (typeof e?.message === "string" &&
        (e.message.includes("is not found") || e.message.includes("not supported for generateContent")));
    if (!isNotFound) throw err;

    logger.warn({ model: args.model, err }, "Requested model unavailable; attempting fallback via ListModels");
    const models = await listModels(args.env.GEMINI_API_KEY);
    const fallback = pickFallbackModel(models);
    if (!fallback) throw err;

    logger.warn({ fallback }, "Retrying with fallback model");
    const result = await args.run(fallback);
    return { modelUsed: fallback, result };
  }
}

export async function generateSourceList(args: {
  env: GeminiEnv;
  prompt: string;
}): Promise<{ sources: SourceList; meta: { model: string; groundedUrls: string[]; tool: string } }> {
  const ai = new GoogleGenAI({ apiKey: args.env.GEMINI_API_KEY });

  const run = async (modelName: string) => {
    return ai.models.generateContent({
      model: modelName,
      contents: args.prompt,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.2,
        maxOutputTokens: 6000,
        responseMimeType: "application/json",
      },
    });
  };

  const { modelUsed, result } = await selectModelOrFallback({ env: args.env, ai, model: args.env.GEMINI_MODEL, run });

  const groundedUrls = extractGroundedUrls(result);
  const text = result.text ?? "";
  const parsed = parseJsonLenient(text);
  const sources = SourceListSchema.parse(parsed);
  // Grounding metadata isn't always populated reliably across models/accounts.
  // We rely on the 2-step pipeline (source list → report restricted to that list)
  // to prevent URL hallucination, rather than filtering by groundingChunks here.
  const filtered = sources;

  logger.info(
    {
      model: modelUsed,
      groundedUrls: groundedUrls.length,
      sources: sources.sources.length,
      kept: filtered.sources.length,
    },
    "Collected sources",
  );

  return { sources: filtered, meta: { model: modelUsed, groundedUrls, tool: "googleSearch" } };
}

export async function generateWeeklyReportFromSources(args: {
  env: GeminiEnv;
  prompt: string;
  allowedUrls: string[];
}): Promise<{ report: WeeklyReport; meta: { model: string } }> {
  const ai = new GoogleGenAI({ apiKey: args.env.GEMINI_API_KEY });

  const repairFromText = async (model: string, badText: string): Promise<WeeklyReport> => {
    const repairPrompt = [
      "You produced an invalid or schema-noncompliant JSON report.",
      "Fix it to strictly match the required JSON schema.",
      "Rules:",
      "- Return ONLY a single JSON object (no markdown).",
      "- Do NOT add new facts. Do NOT add new items unless required to satisfy schema defaults.",
      "- Preserve existing items as much as possible; only fill missing required fields and fix types.",
      "- All link/url fields MUST be valid URLs and MUST be chosen from the provided Allowed URLs list.",
      "",
      "Allowed URLs:",
      ...args.allowedUrls.map((u) => `- ${u}`),
      "",
      "BAD OUTPUT:",
      badText,
    ].join("\n");

    const repaired = await ai.models.generateContent({
      model,
      contents: repairPrompt,
      config: {
        temperature: 0,
        maxOutputTokens: 6000,
        responseMimeType: "application/json",
        responseJsonSchema: WeeklyReportJsonSchema,
      },
    });

    const repairedText = repaired.text ?? "";
    const repairedParsed = parseJsonLenient(repairedText);
    const normalized = normalizeRootJson(repairedParsed);
    const softened = applyMissingFieldPlaceholders(normalized);
    const repairedReportRaw = WeeklyReportSchema.parse(softened);
    return enforceAllowedUrlsOnReport(repairedReportRaw, args.allowedUrls);
  };

  const run = async (modelName: string) => {
    return ai.models.generateContent({
      model: modelName,
      contents: args.prompt,
      config: {
        temperature: 0.2,
        maxOutputTokens: 6000,
        responseMimeType: "application/json",
        responseJsonSchema: WeeklyReportJsonSchema,
      },
    });
  };

  const { modelUsed, result } = await selectModelOrFallback({ env: args.env, ai, model: args.env.GEMINI_MODEL, run });
  const text = result.text ?? "";
  let report: WeeklyReport;
  try {
    const parsed = parseJsonLenient(text);
    const reportRaw = WeeklyReportSchema.parse(normalizeRootJson(parsed));
    report = enforceAllowedUrlsOnReport(reportRaw, args.allowedUrls);
  } catch (err) {
    report = await repairFromText(modelUsed, text);
  }

  return { report, meta: { model: modelUsed } };
}

export async function generateCompanyHomepages(args: {
  env: GeminiEnv;
  prompt: string;
}): Promise<{ homepages: CompanyHomepages; meta: { model: string } }> {
  const ai = new GoogleGenAI({ apiKey: args.env.GEMINI_API_KEY });

  const run = async (modelName: string) => {
    return ai.models.generateContent({
      model: modelName,
      contents: args.prompt,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.2,
        maxOutputTokens: 4000,
        responseMimeType: "application/json",
      },
    });
  };

  const { modelUsed, result } = await selectModelOrFallback({ env: args.env, ai, model: args.env.GEMINI_MODEL, run });
  const text = result.text ?? "";
  const parsed = parseJsonLenient(text);
  const homepages = CompanyHomepagesSchema.parse(parsed);
  return { homepages, meta: { model: modelUsed } };
}

export async function generateCompanyHq(args: {
  env: GeminiEnv;
  prompt: string;
}): Promise<{ hq: CompanyHq; meta: { model: string } }> {
  const ai = new GoogleGenAI({ apiKey: args.env.GEMINI_API_KEY });

  const run = async (modelName: string) => {
    return ai.models.generateContent({
      model: modelName,
      contents: args.prompt,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.2,
        maxOutputTokens: 2000,
        responseMimeType: "application/json",
      },
    });
  };

  const { modelUsed, result } = await selectModelOrFallback({ env: args.env, ai, model: args.env.GEMINI_MODEL, run });
  const text = result.text ?? "";
  const parsed = parseJsonLenient(text);
  const hq = CompanyHqSchema.parse(parsed);
  return { hq, meta: { model: modelUsed } };
}

export async function generateCompanyDiscovery(args: {
  env: GeminiEnv;
  prompt: string;
}): Promise<{ discovery: CompanyDiscovery; meta: { model: string } }> {
  const ai = new GoogleGenAI({ apiKey: args.env.GEMINI_API_KEY });

  const run = async (modelName: string) => {
    return ai.models.generateContent({
      model: modelName,
      contents: args.prompt,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0,
        maxOutputTokens: 3000,
        responseMimeType: "application/json",
        responseJsonSchema: CompanyDiscoveryJsonSchema,
      },
    });
  };

  const { modelUsed, result } = await selectModelOrFallback({ env: args.env, ai, model: args.env.GEMINI_MODEL, run });
  const text = result.text ?? "";
  try {
    const parsed = parseJsonLenient(text);
    const discovery = CompanyDiscoverySchema.parse(parsed);
    return { discovery, meta: { model: modelUsed } };
  } catch (err) {
    logger.warn({ err }, "Company discovery JSON parse failed; continuing without discovery");
    return { discovery: CompanyDiscoverySchema.parse({ companies: [] }), meta: { model: modelUsed } };
  }
}

export async function translateOverseasSectionToKorean(args: {
  env: GeminiEnv;
  report: WeeklyReport;
}): Promise<{ report: WeeklyReport; meta: { model: string } }> {
  if (!needsOverseasKoreanTranslation(args.report)) return { report: args.report, meta: { model: args.env.GEMINI_MODEL } };

  const original = args.report.overseas_competitor_updates ?? [];
  if (original.length === 0) return { report: args.report, meta: { model: args.env.GEMINI_MODEL } };

  const needsItemTranslation = (u: NonNullable<WeeklyReport["overseas_competitor_updates"]>[number]): boolean => {
    return (
      looksEnglishish(u.tag) ||
      looksEnglishish(u.title) ||
      (u.insight ? looksEnglishish(u.insight) : false) ||
      (u.country ? looksEnglishish(u.country) : false)
    );
  };

  const indicesNeeding = original.map((u, i) => (needsItemTranslation(u) ? i : -1)).filter((i) => i >= 0);
  if (indicesNeeding.length === 0) return { report: args.report, meta: { model: args.env.GEMINI_MODEL } };

  const mergeTranslation = (
    translated: WeeklyReport["overseas_competitor_updates"],
  ): WeeklyReport["overseas_competitor_updates"] => {
    if (!Array.isArray(translated) || translated.length !== original.length) return null;
    const out: NonNullable<WeeklyReport["overseas_competitor_updates"]> = [];
    for (let i = 0; i < original.length; i++) {
      const o = original[i]!;
      const t = translated[i]!;
      out.push({
        company: o.company,
        url: o.url,
        country: (t as any)?.country ?? o.country,
        category: o.category,
        tag: typeof (t as any)?.tag === "string" && (t as any).tag.trim() ? (t as any).tag : o.tag,
        title: typeof (t as any)?.title === "string" && (t as any).title.trim() ? (t as any).title : o.title,
        insight:
          typeof (t as any)?.insight === "string" && (t as any).insight.trim()
            ? (t as any).insight
            : (o.insight ?? undefined),
      });
    }
    return out;
  };

  const isStructurallyValid = (translated: WeeklyReport["overseas_competitor_updates"]): boolean => {
    if (!Array.isArray(translated)) return false;
    if (translated.length !== original.length) return false;
    for (let i = 0; i < original.length; i++) {
      const o = original[i]!;
      const t = translated[i] as any;
      if (!t || typeof t !== "object") return false;
      if (t.company !== o.company) return false;
      if (typeof t.tag !== "string" || !t.tag.trim()) return false;
      if (typeof t.title !== "string" || !t.title.trim()) return false;
      if (typeof t.url === "string" && o.url && normalizeUrl(t.url) !== normalizeUrl(o.url)) return false;
    }
    return true;
  };

  const stillNeedsTranslation = (
    o: NonNullable<WeeklyReport["overseas_competitor_updates"]>[number],
    t: NonNullable<WeeklyReport["overseas_competitor_updates"]>[number],
  ): boolean => {
    if (looksEnglishish(o.tag) && !hasHangul(t.tag)) return true;
    if (looksEnglishish(o.title) && !hasHangul(t.title)) return true;
    if (o.insight && looksEnglishish(o.insight) && (!t.insight || !hasHangul(t.insight))) return true;
    if (o.country && looksEnglishish(o.country) && t.country && !hasHangul(t.country)) return true;
    return false;
  };

  const ai = new GoogleGenAI({ apiKey: args.env.GEMINI_API_KEY });
  const buildBatchPrompt = (mode: "normal" | "strict") => {
    const rules = [
      "You are translating a report section into Korean.",
      "Translate ONLY these fields to natural Korean: tag, title, insight, and country (if present).",
      "Rules:",
      "- Do NOT add, remove, or reorder items.",
      "- Preserve the exact number of items and keep the same order.",
      "- Do NOT change company names.",
      "- Do NOT change or fabricate URLs; keep url exactly the same per item (or omit url field).",
      "- Do NOT add new facts; translate only.",
      "- For items written in English, produce Korean sentences (keep proper nouns/product names as-is).",
      mode === "strict"
        ? `- CRITICAL: The output MUST contain exactly ${original.length} items in overseas_competitor_updates. If unsure, keep original strings rather than omitting anything.`
        : "",
      "",
      "INPUT JSON:",
      JSON.stringify({ overseas_competitor_updates: original }),
    ]
      .filter(Boolean)
      .join("\n");
    return rules;
  };

  const translateBatch = async () => {
    const run = async (modelName: string) =>
      ai.models.generateContent({
        model: modelName,
        contents: buildBatchPrompt("strict"),
        config: {
          temperature: 0,
          maxOutputTokens: 5000,
          responseMimeType: "application/json",
          responseJsonSchema: OverseasTranslateJsonSchema,
        },
      });

    const { modelUsed, result } = await selectModelOrFallback({ env: args.env, ai, model: args.env.GEMINI_MODEL, run });
    const parsed = parseJsonLenient(result.text ?? "") as { overseas_competitor_updates?: unknown };
    const translated = (parsed && typeof parsed === "object" ? (parsed as any).overseas_competitor_updates : null) as
      | WeeklyReport["overseas_competitor_updates"]
      | null;
    return { translated, modelUsed };
  };

  let modelUsed = args.env.GEMINI_MODEL;
  let merged: WeeklyReport["overseas_competitor_updates"] = original;
  try {
    const batch = await translateBatch();
    modelUsed = batch.modelUsed;
    if (batch.translated && isStructurallyValid(batch.translated)) {
      const maybe = mergeTranslation(batch.translated);
      if (maybe) merged = maybe;
    } else {
      logger.warn({ items: original.length }, "Overseas translation batch invalid; will try per-item translation");
    }
  } catch (err) {
    logger.warn({ err }, "Overseas translation batch failed; will try per-item translation");
  }

  const translateOne = async (
    item: NonNullable<WeeklyReport["overseas_competitor_updates"]>[number],
  ): Promise<NonNullable<WeeklyReport["overseas_competitor_updates"]>[number] | null> => {
    const prompt = [
      "You are translating one report item into Korean.",
      "Translate ONLY these fields to natural Korean: tag, title, insight, and country (if present).",
      "Rules:",
      "- Do NOT change company name.",
      "- Do NOT change or fabricate URL; keep url exactly the same (or omit url field).",
      "- Do NOT add new facts; translate only.",
      "- Output ONLY a single JSON object.",
      "",
      "INPUT JSON:",
      JSON.stringify(item),
    ].join("\n");

    const run = async (modelName: string) =>
      ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          temperature: 0,
          maxOutputTokens: 800,
          responseMimeType: "application/json",
          responseJsonSchema: OverseasTranslateItemJsonSchema,
        },
      });

    const { modelUsed: itemModelUsed, result } = await selectModelOrFallback({
      env: args.env,
      ai,
      model: args.env.GEMINI_MODEL,
      run,
    });
    modelUsed = itemModelUsed;
    const parsed = parseJsonLenient(result.text ?? "");
    if (!parsed || typeof parsed !== "object") return null;
    const t = parsed as any;
    if (t.company !== item.company) return null;
    if (typeof t.tag !== "string" || !t.tag.trim()) return null;
    if (typeof t.title !== "string" || !t.title.trim()) return null;
    if (typeof t.url === "string" && item.url && normalizeUrl(t.url) !== normalizeUrl(item.url)) return null;

    const translated: NonNullable<WeeklyReport["overseas_competitor_updates"]>[number] = {
      company: item.company,
      url: item.url,
      country: typeof t.country === "string" && t.country.trim() ? t.country.trim() : item.country,
      category: item.category,
      tag: t.tag.trim(),
      title: t.title.trim(),
      insight: typeof t.insight === "string" && t.insight.trim() ? t.insight.trim() : (item.insight ?? undefined),
    };

    if (stillNeedsTranslation(item, translated)) return null;
    return translated;
  };

  // If any items still look English after batch (or batch wasn't applied), translate those items individually.
  const toFix: number[] = [];
  for (const i of indicesNeeding) {
    const o = original[i]!;
    const t = merged[i]!;
    if (stillNeedsTranslation(o, t)) toFix.push(i);
  }

  if (toFix.length) {
    const copy = merged.slice();
    for (const i of toFix) {
      const fixed = await translateOne(original[i]!);
      if (fixed) copy[i] = fixed;
    }
    merged = copy;
  }

  const copy: WeeklyReport = JSON.parse(JSON.stringify(args.report));
  copy.overseas_competitor_updates = merged;
  return { report: WeeklyReportSchema.parse(copy), meta: { model: modelUsed } };
}

export async function generateWeeklyReport(args: {
  env: GeminiEnv;
  prompt: string;
}): Promise<{ report: WeeklyReport; meta: { model: string; tool: string; groundingChunks: number; urlCount: number } }> {
  const ai = new GoogleGenAI({ apiKey: args.env.GEMINI_API_KEY });
  const systemInstruction =
    "You are rigorous about sources. Prefer official pages and reputable news. Always include links when possible.";

  type GroundingTool = "googleSearch" | "googleSearchRetrieval";

  const runOnce = async (modelName: string, tool: GroundingTool, prompt: string) => {
    const tools =
      tool === "googleSearch"
        ? [{ googleSearch: {} }]
        : [{ googleSearchRetrieval: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } } }];

    return ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        tools,
        systemInstruction,
        temperature: 0.2,
        maxOutputTokens: 6000,
        responseMimeType: "application/json",
        responseJsonSchema: WeeklyReportJsonSchema,
      },
    });
  };

  const tryModel = async (modelName: string, prompt: string) => {
    const toolOrder: GroundingTool[] = ["googleSearch", "googleSearchRetrieval"];
    let lastErr: unknown = null;

    for (const tool of toolOrder) {
      try {
        const response = await runOnce(modelName, tool, prompt);
        return { response, tool };
      } catch (err) {
        lastErr = err;
        const msg = (err as { message?: string })?.message ?? "";
        const wantsSearch = msg.includes("Please use google_search tool");
        const wantsRetrieval = msg.includes("Please use google_search_retrieval tool");
        if (wantsSearch && tool !== "googleSearch") continue;
        if (wantsRetrieval && tool !== "googleSearchRetrieval") continue;
        // Otherwise try the next tool.
      }
    }

    throw lastErr;
  };

  const basePrompt = args.prompt;
  const forceGroundingHint =
    "\n\nIMPORTANT:\n- You MUST use the provided grounding tool (googleSearch) to perform web searches before answering.\n- If you cannot find grounded sources for the last lookback window, return empty arrays for those sections.\n";
  const forceUrlsHint =
    "\n\nIMPORTANT:\n- Every included update MUST have a credible source URL in `url` or `link`.\n- If you cannot find a source URL, omit the item.\n";

  let modelUsed = args.env.GEMINI_MODEL;
  let responseTool: GroundingTool = "googleSearch";
  let result: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  let promptToUse = basePrompt;

  const maxAttempts = args.env.REQUIRE_GROUNDING ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ok = await tryModel(modelUsed, promptToUse);
      result = ok.response;
      responseTool = ok.tool;
    } catch (err) {
      const e = err as { status?: number; message?: string };
      const isNotFound =
        e?.status === 404 ||
        (typeof e?.message === "string" &&
          (e.message.includes("is not found") || e.message.includes("not supported for generateContent")));

      if (!isNotFound) throw err;

      logger.warn({ model: modelUsed, err }, "Requested model unavailable; attempting fallback via ListModels");
      const models = await listModels(args.env.GEMINI_API_KEY);
      const fallback = pickFallbackModel(models);
      if (!fallback) throw err;

      logger.warn({ fallback }, "Retrying with fallback model");
      modelUsed = fallback;
      const ok = await tryModel(modelUsed, promptToUse);
      result = ok.response;
      responseTool = ok.tool;
    }

    const text = result?.text ?? "";
    let parsed: unknown;
    try {
      parsed = parseJsonLenient(text);
    } catch (err) {
      logger.warn({ err }, "JSON parse failed; attempting recovery");
      try {
        const recovered = extractFirstJson(text);
        if (recovered) parsed = recovered;
        else throw err;
      } catch (err2) {
        logger.warn({ err: err2 }, "JSON recovery failed; attempting LLM repair");
        parsed = await repairToValidJson({ ai, model: modelUsed, badText: text });
      }
    }

    const normalized = normalizeRootJson(parsed);
    const softened = applyMissingFieldPlaceholders(normalized);
    const report = WeeklyReportSchema.parse(softened);

    const groundingChunks = result?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const hasGroundingChunks = Array.isArray(groundingChunks) && groundingChunks.length > 0;
    const urlCount = countSourceUrls(report);

    if (hasGroundingChunks) {
      logger.info(
        { model: modelUsed, tool: responseTool, groundingChunks: groundingChunks.length, urlCount },
        "Grounded search references attached",
      );
      return {
        report,
        meta: { model: modelUsed, tool: responseTool, groundingChunks: groundingChunks.length, urlCount },
      };
    }

    if (!args.env.REQUIRE_GROUNDING) {
      logger.warn({ model: modelUsed, tool: responseTool, urlCount }, "Grounding metadata missing; proceeding");
      return { report, meta: { model: modelUsed, tool: responseTool, groundingChunks: 0, urlCount } };
    }

    if (urlCount >= 1) {
      logger.warn(
        { model: modelUsed, tool: responseTool, urlCount },
        "Grounding metadata missing, but source URLs are present; proceeding",
      );
      return { report, meta: { model: modelUsed, tool: responseTool, groundingChunks: 0, urlCount } };
  }

    if (attempt < maxAttempts) {
      logger.warn({ model: modelUsed, tool: responseTool }, "No grounding/urls; retrying with stronger instructions");
      promptToUse = `${basePrompt}${forceGroundingHint}${forceUrlsHint}`;
      continue;
    }

    throw new Error("Grounding metadata missing and no source URLs found (REQUIRE_GROUNDING=true)");
  }

  throw new Error("Unexpected: report generation loop ended without returning");
}
