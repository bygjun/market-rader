import { GoogleGenAI } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import type { GeminiEnv } from "../lib/env.js";
import type { WeeklyReport } from "./schema.js";
import { WeeklyReportSchema } from "./schema.js";
import { WeeklyReportJsonSchema } from "./reportJsonSchema.js";

const RepairMappingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["replacements"],
  properties: {
    replacements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["old_url"],
        properties: {
          old_url: { type: "string" },
          new_url: { type: "string" },
        },
      },
    },
  },
} as const;

export function collectReportUrls(report: WeeklyReport): string[] {
  const urls: string[] = [];
  for (const h of report.top_highlights) if (h.link) urls.push(h.link);
  for (const updates of Object.values(report.category_updates)) {
    for (const u of updates) if (u.url) urls.push(u.url);
  }
  for (const h of report.hiring_signals) if (h.url) urls.push(h.url);
  return urls;
}

export function applyUrlReplacements(report: WeeklyReport, replacements: Map<string, string>): WeeklyReport {
  const copy: WeeklyReport = JSON.parse(JSON.stringify(report));

  for (const h of copy.top_highlights) {
    if (h.link && replacements.has(h.link)) h.link = replacements.get(h.link)!;
  }
  for (const [cat, updates] of Object.entries(copy.category_updates)) {
    copy.category_updates[cat as keyof WeeklyReport["category_updates"]] = updates.map((u) => {
      if (u.url && replacements.has(u.url)) u.url = replacements.get(u.url)!;
      return u;
    });
  }
  for (const h of copy.hiring_signals) {
    if (h.url && replacements.has(h.url)) h.url = replacements.get(h.url)!;
  }

  return WeeklyReportSchema.parse(copy);
}

export function dropItemsWithBadUrls(args: {
  report: WeeklyReport;
  badUrls: Set<string>;
}): WeeklyReport {
  const { report, badUrls } = args;
  const copy: WeeklyReport = JSON.parse(JSON.stringify(report));

  copy.top_highlights = copy.top_highlights.filter((h) => !h.link || !badUrls.has(h.link));
  for (const cat of Object.keys(copy.category_updates) as Array<keyof WeeklyReport["category_updates"]>) {
    copy.category_updates[cat] = copy.category_updates[cat].filter((u) => !u.url || !badUrls.has(u.url));
  }
  copy.hiring_signals = copy.hiring_signals.filter((h) => !h.url || !badUrls.has(h.url));

  return WeeklyReportSchema.parse(copy);
}

function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(jsonrepair(text));
  }
}

export async function repairReportSources(args: {
  env: GeminiEnv;
  model: string;
  report: WeeklyReport;
  badUrls: string[];
}): Promise<WeeklyReport> {
  const ai = new GoogleGenAI({ apiKey: args.env.GEMINI_API_KEY });

  const prompt = [
    "You are fixing incorrect source URLs in a Korean market intelligence report.",
    "Some URLs are broken (404) or clearly invalid. Use grounded web search to find the correct source URLs for the SAME claims.",
    "Rules:",
    "- Only change link/url fields. Do not rewrite titles/insights except if strictly necessary to match the corrected source.",
    "- For each bad URL, either replace it with a valid URL that supports the claim, or remove the entire item if you cannot find a valid source.",
    "- Return ONLY the full corrected report JSON (not a diff), matching the exact schema.",
    "",
    "Bad URLs:",
    ...args.badUrls.map((u) => `- ${u}`),
    "",
    "Current report JSON:",
    JSON.stringify(args.report),
  ].join("\n");

  const res = await ai.models.generateContent({
    model: args.model,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0,
      maxOutputTokens: 6000,
      responseMimeType: "application/json",
      responseJsonSchema: WeeklyReportJsonSchema,
    },
  });

  const text = res.text ?? "";
  if (!text.trim()) {
    throw new Error("Source repair returned empty response text");
  }
  const parsed = parseJsonLenient(text);
  return WeeklyReportSchema.parse(parsed);
}
