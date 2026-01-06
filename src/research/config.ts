import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CategoryId } from "./schema.js";

export const ResearchConfigSchema = z.object({
  timezone: z.string().min(1).default("Asia/Seoul"),
  report_name: z.string().min(1).default("Market Radar"),
  lookback_days: z.number().int().min(1).max(30).default(7),
  watchlist_only: z.boolean().default(false),
  min_companies_per_category: z.number().int().min(1).max(20).default(3),
  max_companies_per_category: z.number().int().min(1).max(50).default(6),
  min_source_urls: z.number().int().min(0).max(100).default(5),
  prefer_startups: z.boolean().default(true),
  min_startups_per_category: z.number().int().min(0).max(20).default(2),
  max_enterprises_per_category: z.number().int().min(0).max(20).default(1),
  excluded_companies: z.array(z.string().min(1)).default([]),
  categories: z
    .array(
      z.object({
        id: CategoryId,
        name: z.string().min(1),
        emoji: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
      }),
    )
    .min(1),
  watchlist: z
    .array(
      z.object({
        company: z.string().min(1),
        category_id: CategoryId,
        keywords: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1),
  email: z
    .object({
      subject_prefix: z.string().min(1).optional(),
    })
    .optional(),
});

export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;

export async function loadResearchConfig(path: string): Promise<ResearchConfig> {
  const raw = await readFile(path, "utf8");
  return ResearchConfigSchema.parse(JSON.parse(raw));
}
