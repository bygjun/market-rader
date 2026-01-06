import { GoogleGenAI } from "@google/genai";
import type { GeminiEnv } from "../lib/env.js";
import { WeeklyReportSchema, type WeeklyReport } from "./schema.js";
import { logger } from "../lib/logger.js";
import { listModels, pickFallbackModel } from "./models.js";

function extractFirstJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const sliced = text.slice(start, end + 1);
  return JSON.parse(sliced);
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
  return JSON.parse(text);
}

const WeeklyReportJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["report_date", "week_number", "top_highlights", "category_updates", "hiring_signals", "action_items"],
  properties: {
    report_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    week_number: { type: "integer", minimum: 1, maximum: 53 },
    top_highlights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["company", "category", "title", "insight", "importance_score"],
        properties: {
          company: { type: "string" },
          category: { type: "string", enum: ["CAT-A", "CAT-B", "CAT-C", "CAT-D"] },
          title: { type: "string" },
          insight: { type: "string" },
          importance_score: { type: "integer", minimum: 1, maximum: 5 },
          link: { type: "string" },
        },
      },
    },
    category_updates: {
      type: "object",
      additionalProperties: true,
      required: ["CAT-A", "CAT-B", "CAT-C", "CAT-D"],
      properties: {
        "CAT-A": {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["company", "tag", "title"],
            properties: {
              company: { type: "string" },
              tag: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              insight: { type: "string" },
            },
          },
        },
        "CAT-B": {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["company", "tag", "title"],
            properties: {
              company: { type: "string" },
              tag: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              insight: { type: "string" },
            },
          },
        },
        "CAT-C": {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["company", "tag", "title"],
            properties: {
              company: { type: "string" },
              tag: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              insight: { type: "string" },
            },
          },
        },
        "CAT-D": {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["company", "tag", "title"],
            properties: {
              company: { type: "string" },
              tag: { type: "string" },
              title: { type: "string" },
              url: { type: "string" },
              insight: { type: "string" },
            },
          },
        },
      },
    },
    hiring_signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["company", "position", "strategic_inference"],
        properties: {
          company: { type: "string" },
          position: { type: "string" },
          strategic_inference: { type: "string" },
          url: { type: "string" },
        },
      },
    },
    action_items: { type: "array", items: { type: "string" } },
  },
} as const;

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
  for (const h of report.hiring_signals) {
    if (h.url) urls.add(h.url);
  }
  return urls.size;
}

export async function generateWeeklyReport(args: {
  env: GeminiEnv;
  prompt: string;
}): Promise<WeeklyReport> {
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
        maxOutputTokens: 65536,
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

      logger.warn(
        { model: modelUsed, err },
        "Requested model unavailable; attempting fallback via ListModels",
      );
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
      parsed = JSON.parse(text);
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

    const report = WeeklyReportSchema.parse(normalizeRootJson(parsed));

    const groundingChunks = result?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const hasGroundingChunks = Array.isArray(groundingChunks) && groundingChunks.length > 0;
    const urlCount = countSourceUrls(report);

    if (hasGroundingChunks) {
      logger.info(
        { model: modelUsed, tool: responseTool, groundingChunks: groundingChunks.length, urlCount },
        "Grounded search references attached",
      );
      return report;
    }

    if (!args.env.REQUIRE_GROUNDING) {
      logger.warn({ model: modelUsed, tool: responseTool, urlCount }, "Grounding metadata missing; proceeding");
      return report;
    }

    if (urlCount >= 1) {
      logger.warn(
        { model: modelUsed, tool: responseTool, urlCount },
        "Grounding metadata missing, but source URLs are present; proceeding",
      );
      return report;
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
