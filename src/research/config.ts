import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CategoryId } from "./schema.js";

export const ResearchConfigSchema = z.object({
  timezone: z.string().min(1).default("Asia/Seoul"),
  report_name: z.string().min(1).default("Market Radar"),
  lookback_days: z.number().int().min(1).max(30).default(7),
  source_provider: z.enum(["gemini_grounded", "searchapi_google_news"]).default("gemini_grounded"),
  history_path: z.string().min(1).default("out/seen.json"),
  watchlist_only: z.boolean().default(false),
  min_companies_per_category: z.number().int().min(1).max(20).default(3),
  max_companies_per_category: z.number().int().min(1).max(50).default(6),
  min_source_urls: z.number().int().min(0).max(100).default(5),
  prefer_startups: z.boolean().default(true),
  min_startups_per_category: z.number().int().min(0).max(20).default(2),
  max_enterprises_per_category: z.number().int().min(0).max(20).default(1),
  excluded_companies: z.array(z.string().min(1)).default([]),
  verify_source_urls: z.boolean().default(false),
  drop_items_without_valid_url: z.boolean().default(true),
  max_source_repair_rounds: z.number().int().min(0).max(3).default(1),
  url_check_timeout_ms: z.number().int().min(1000).max(30000).default(8000),
  url_check_concurrency: z.number().int().min(1).max(20).default(6),
  searchapi: z
    .object({
      max_results_per_query: z.number().int().min(1).max(100).default(10),
      max_pages_per_query: z.number().int().min(1).max(20).default(3),
      concurrency: z.number().int().min(1).max(10).default(4),
      include_kr: z.boolean().default(true),
      include_global: z.boolean().default(true),
      kr_gl: z.string().min(1).default("kr"),
      kr_hl: z.string().min(1).default("ko"),
      global_gl: z.string().min(1).default("us"),
      global_hl: z.string().min(1).default("en"),
      include_category_queries: z.boolean().default(false),
      category_query_max_results: z.number().int().min(1).max(30).default(6),
      require_company_mention: z.boolean().default(true),
      max_updates_per_company: z.number().int().min(1).max(10).default(3),
      enable_company_discovery: z.boolean().default(true),
      discovery_candidates_per_category: z.number().int().min(1).max(30).default(12),
      discovery_target_companies_per_category: z.number().int().min(1).max(10).default(3),
      discovery_max_companies_total: z.number().int().min(1).max(80).default(12),
      discovery_max_results_per_query: z.number().int().min(1).max(50).default(15),
      discovery_max_pages_per_query: z.number().int().min(1).max(10).default(2),
      global_watchlist_max_results_per_query: z.number().int().min(1).max(100).default(20),
      global_watchlist_max_pages_per_query: z.number().int().min(1).max(20).default(2),
    })
    .optional(),
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
        aliases: z.array(z.string().min(1)).default([]),
        keywords: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1),
  global_watchlist: z
    .array(
      z.object({
        company: z.string().min(1),
        category_id: CategoryId,
        aliases: z.array(z.string().min(1)).default([]),
        keywords: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
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
