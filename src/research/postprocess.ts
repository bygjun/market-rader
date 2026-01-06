import type { GeminiEnv } from "../lib/env.js";
import type { ResearchConfig } from "./config.js";
import type { WeeklyReport } from "./schema.js";
import { logger } from "../lib/logger.js";
import { checkUrls } from "./urlCheck.js";
import { collectReportUrls, dropItemsWithBadUrls, repairReportSources } from "./sourceRepair.js";

export async function postprocessReport(args: {
  env: GeminiEnv;
  modelUsed: string;
  report: WeeklyReport;
  config: ResearchConfig;
}): Promise<WeeklyReport> {
  const { env, modelUsed, config } = args;
  let report = args.report;

  if (!config.verify_source_urls) return report;

  const roundLimit = config.max_source_repair_rounds ?? 0;
  for (let round = 0; round <= roundLimit; round++) {
    const urls = collectReportUrls(report);
    const checks = await checkUrls(urls, {
      timeoutMs: config.url_check_timeout_ms,
      concurrency: config.url_check_concurrency,
    });
    const badUrls = Array.from(checks.values())
      .filter((r) => !r.ok)
      .filter((r) => r.status === 404 || r.status === 410 || r.reason.startsWith("HTTP_4"))
      .map((r) => r.url);

    if (badUrls.length === 0) {
      logger.info({ urlChecks: checks.size }, "Source URL validation passed");
      return report;
    }

    logger.warn({ badUrls: badUrls.length, round }, "Found invalid source URLs");

    if (round < roundLimit) {
      report = await repairReportSources({ env, model: modelUsed, report, badUrls });
      continue;
    }

    if (config.drop_items_without_valid_url) {
      report = dropItemsWithBadUrls({ report, badUrls: new Set(badUrls) });
      logger.warn({ droppedBadUrls: badUrls.length }, "Dropped items with invalid URLs");
      return report;
    }

    return report;
  }

  return report;
}
