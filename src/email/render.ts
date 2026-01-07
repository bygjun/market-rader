import sanitizeHtml from "sanitize-html";
import { marked } from "marked";
import type { WeeklyReport } from "../research/schema.js";
import type { ResearchConfig } from "../research/config.js";

function categoryName(config: ResearchConfig, id: string): string {
  const c = config.categories.find((x) => x.id === id);
  if (!c) return id;
  return `${c.emoji ? `${c.emoji} ` : ""}${c.name}`;
}

function normalizeCompanyKey(company: string): string {
  let s = company.trim();
  // Remove trailing parenthetical aliases: "업스테이지 (Upstage)" -> "업스테이지"
  s = s.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  // If it contains a dash separator, keep the left part
  s = s.split("—")[0]?.split("-")[0]?.trim() ?? s;
  return s;
}

function companyLabel(report: WeeklyReport, company: string): string {
  const homepages = report.company_homepages ?? {};
  const candidates = [company, normalizeCompanyKey(company)];
  const homepage = candidates.map((c) => homepages[c]).find((u) => typeof u === "string" && u.length > 0);
  return homepage ? `[${company}](${homepage})` : company;
}

export function renderMarkdown(report: WeeklyReport, config: ResearchConfig): string {
  const lines: string[] = [];

  lines.push(`# ${config.report_name} 주간 경쟁사 동향 리포트`);
  lines.push(`- 기준일: ${report.report_date} / Week ${report.week_number}`);
  lines.push("");

  if (report.top_highlights.length) {
    lines.push("## 1) 금주의 하이라이트 (Executive Summary)");
    for (const item of report.top_highlights.slice(0, 3)) {
      const scoreTag =
        item.importance_score >= 5 ? "🚨 Critical" : item.importance_score >= 4 ? "✨ Important" : "🗒️ Update";
      const company = companyLabel(report, item.company);
      const source = item.link ? ` ([출처](${item.link}))` : "";
      lines.push(`- **[${scoreTag}]** **${company}** — ${item.title}${source}`);
      lines.push(`  - Insight: ${item.insight}`);
    }
    lines.push("");
  }

  lines.push("## 2) 카테고리별 상세 동향 (Category Deep Dive)");
  const cats = Object.entries(report.category_updates);
  for (const [catId, updates] of cats) {
    if (!updates?.length) continue;
    lines.push(`### ${categoryName(config, catId)}`);
    for (const u of updates) {
      const company = companyLabel(report, u.company);
      const source = u.url ? ` ([출처](${u.url}))` : "";
      lines.push(`- \`[${u.tag}]\` **${company}:** ${u.title}${source}`);
      if (u.insight) lines.push(`  - Insight: ${u.insight}`);
    }
    lines.push("");
  }

  let section = 3;

  if (report.overseas_competitor_updates?.length) {
    lines.push(`## ${section}) 해외 경쟁사 동향 (Global Competitors)`);
    for (const u of report.overseas_competitor_updates) {
      const company = companyLabel(report, u.company);
      const country = u.country ? ` (${u.country})` : "";
      const source = u.url ? ` ([출처](${u.url}))` : "";
      lines.push(`- \`[${u.tag}]\` **${company}${country}:** ${u.title}${source}`);
      if (u.insight) lines.push(`  - Insight: ${u.insight}`);
    }
    lines.push("");
    section += 1;
  }

  if (report.hiring_signals.length) {
    lines.push(`## ${section}) 채용으로 보는 기술 신호 (Talent & Tech Signals)`);
    lines.push("| 기업명 | 채용 직무 | 우리의 해석 (Hidden Strategy) |");
    lines.push("| :--- | :--- | :--- |");
    for (const h of report.hiring_signals) {
      const company = companyLabel(report, h.company);
      const position = h.url ? `[${h.position}](${h.url})` : h.position;
      lines.push(`| ${company} | ${position} | ${h.strategic_inference} |`);
    }
    lines.push("");
    section += 1;
  }

  if (report.action_items.length) {
    lines.push(`## ${section}) 우리의 대응 (Action Items)`);
    for (const a of report.action_items) lines.push(`- ${a}`);
    lines.push("");
  }

  return lines.join("\n");
}

export async function renderHtmlFromMarkdown(markdown: string): Promise<string> {
  const rawHtml = await marked.parse(markdown, { gfm: true });
  const clean = sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "h3"]),
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt"],
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
    },
  });

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Market Radar</title>
    <style>
      body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.55;padding:20px;color:#111}
      h1{font-size:20px;margin:0 0 12px}
      h2{font-size:16px;margin:18px 0 8px}
      h3{font-size:14px;margin:14px 0 6px}
      code{background:#f4f4f5;padding:2px 4px;border-radius:4px}
      table{border-collapse:collapse;width:100%}
      th,td{border:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top}
      a{color:#2563eb}
    </style>
  </head>
  <body>
    ${clean}
  </body>
</html>`;
}
