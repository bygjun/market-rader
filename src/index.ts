import "dotenv/config";
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadGeminiEnv, loadMailEnv } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { getIsoDateInTimeZone, getWeekNumberInTimeZone } from "./lib/date.js";
import { loadResearchConfig } from "./research/config.js";
import {
  buildCompanyHomepagesPrompt,
  buildReportFromSourcesPrompt,
  buildSourcesPrompt,
  buildWeeklyPrompt,
} from "./research/prompt.js";
import {
  generateCompanyHomepages,
  generateSourceList,
  generateWeeklyReport,
  generateWeeklyReportFromSources,
} from "./research/gemini.js";
import { WeeklyReportSchema } from "./research/schema.js";
import { postprocessReport } from "./research/postprocess.js";
import { renderHtmlFromMarkdown, renderMarkdown } from "./email/render.js";
import { sendEmail } from "./email/mailer.js";

const program = new Command();

program
  .name("market-rader")
  .description("Weekly competitor radar via Gemini grounded search + email")
  .option("-c, --config <path>", "research config json path", "config/research.json")
  .option("--input-report <path>", "use an existing report JSON instead of calling Gemini")
  .option("--as-of <date>", "report date (YYYY-MM-DD) in configured timezone")
  .option("--dry-run", "do not send email; write outputs to out/", false);

program.parse(process.argv);
const opts = program.opts<{ config: string; inputReport?: string; dryRun: boolean; asOf?: string }>();

async function main(): Promise<void> {
  const configPath = path.resolve(process.cwd(), opts.config);
  const researchConfig = await loadResearchConfig(configPath);

  const now = new Date();
  let report = null as unknown;
  let subjectPrefix = researchConfig.email?.subject_prefix ?? process.env.MAIL_SUBJECT_PREFIX ?? "[Market Radar]";
  let modelUsed = process.env.GEMINI_MODEL ?? "unknown";

  if (opts.inputReport) {
    const raw = await readFile(opts.inputReport, "utf8");
    report = WeeklyReportSchema.parse(JSON.parse(raw));
  } else {
    const geminiEnv = loadGeminiEnv();
    subjectPrefix = researchConfig.email?.subject_prefix ?? geminiEnv.MAIL_SUBJECT_PREFIX;
    const timeZone = researchConfig.timezone ?? geminiEnv.TZ;
    if (opts.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(opts.asOf)) {
      throw new Error("--as-of must be YYYY-MM-DD");
    }
    const baseDate = opts.asOf ? new Date(`${opts.asOf}T00:00:00.000Z`) : now;
    const reportDate = getIsoDateInTimeZone(baseDate, timeZone);
    const weekNumber = getWeekNumberInTimeZone(baseDate, timeZone);
    const sourcesPrompt = buildSourcesPrompt({ reportDate, weekNumber, config: researchConfig });
    const sourcesResult = await generateSourceList({ env: geminiEnv, prompt: sourcesPrompt });
    const allowedUrls = sourcesResult.sources.sources.map((s) => s.url);

    if (allowedUrls.length >= 3) {
      const companies = Array.from(new Set(sourcesResult.sources.sources.map((s) => s.company))).slice(0, 50);
      const homepagesPrompt = buildCompanyHomepagesPrompt({
        lookbackDays: researchConfig.lookback_days,
        companies,
      });
      const homepagesResult = await generateCompanyHomepages({ env: geminiEnv, prompt: homepagesPrompt });

      const reportPrompt = buildReportFromSourcesPrompt({
        reportDate,
        weekNumber,
        config: researchConfig,
        sourcesJson: JSON.stringify(sourcesResult.sources),
        allowedUrls,
      });
      const generated = await generateWeeklyReportFromSources({ env: geminiEnv, prompt: reportPrompt, allowedUrls });
      report = {
        ...generated.report,
        company_homepages: {
          ...(generated.report.company_homepages ?? {}),
          ...(homepagesResult.homepages.company_homepages ?? {}),
        },
      };
      modelUsed = generated.meta.model;
    } else {
      // Fallback to one-shot if grounding metadata is missing or too few sources were captured.
      const prompt = buildWeeklyPrompt({ reportDate, weekNumber, config: researchConfig });
      const generated = await generateWeeklyReport({ env: geminiEnv, prompt });
      const companies = Array.from(
        new Set([
          ...generated.report.top_highlights.map((h) => h.company),
          ...Object.values(generated.report.category_updates).flat().map((u) => u.company),
          ...generated.report.hiring_signals.map((h) => h.company),
        ]),
      ).slice(0, 50);
      const homepagesPrompt = buildCompanyHomepagesPrompt({
        lookbackDays: researchConfig.lookback_days,
        companies,
      });
      const homepagesResult = await generateCompanyHomepages({ env: geminiEnv, prompt: homepagesPrompt });
      report = {
        ...generated.report,
        company_homepages: {
          ...(generated.report.company_homepages ?? {}),
          ...(homepagesResult.homepages.company_homepages ?? {}),
        },
      };
      modelUsed = generated.meta.model;
    }

    // Optional postprocess (URL status check) can be enabled in config; default can be false.
    report = await postprocessReport({
      env: geminiEnv,
      modelUsed,
      report: WeeklyReportSchema.parse(report),
      config: researchConfig,
    });
  }

  const parsedReport = WeeklyReportSchema.parse(report);

  const markdown = renderMarkdown(parsedReport, researchConfig);
  const html = await renderHtmlFromMarkdown(markdown);

  const subject = `${subjectPrefix} ${parsedReport.report_date} (W${parsedReport.week_number}) 경쟁사 동향`;

  await mkdir("out", { recursive: true });
  await writeFile("out/report.json", JSON.stringify(parsedReport, null, 2), "utf8");
  await writeFile("out/email.md", markdown, "utf8");
  await writeFile("out/email.html", html, "utf8");

  if (opts.dryRun) {
    logger.info({ subject, modelUsed }, "Dry-run complete (no email sent)");
    return;
  }

  const mailEnv = loadMailEnv();
  await sendEmail({ env: mailEnv, subject, html, text: markdown });
  logger.info({ subject }, "Email sent");
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exitCode = 1;
});
