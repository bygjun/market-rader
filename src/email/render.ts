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

export function renderMarkdown(
  report: WeeklyReport,
  config: ResearchConfig,
  meta?: { sourcesCollected?: number; sourcesQueries?: number; droppedUrls?: number; dedupedItems?: number },
): string {
  const lines: string[] = [];

  lines.push(`# ${config.report_name} 주간 경쟁사 동향 리포트`);
  lines.push(`- 기준일: ${report.report_date} / Week ${report.week_number}`);
  if (meta?.sourcesCollected != null) {
    const q = meta.sourcesQueries != null ? ` (queries: ${meta.sourcesQueries})` : "";
    lines.push(`- 수집된 소스: ${meta.sourcesCollected}개${q}`);
  }
  if (meta?.droppedUrls != null && meta.droppedUrls > 0) {
    lines.push(`- 링크 필터링(404/홈페이지 등): ${meta.droppedUrls}개 제외`);
  }
  if (meta?.dedupedItems != null && meta.dedupedItems > 0) {
    lines.push(`- 동일 주 중복 제거: ${meta.dedupedItems}개 제외`);
  }
  lines.push("");

  lines.push("## 1) 금주의 하이라이트 (Executive Summary)");
  if (report.top_highlights.length) {
    const picked: WeeklyReport["top_highlights"] = [];
    const seenCompanies = new Set<string>();
    for (const item of report.top_highlights) {
      const key = normalizeCompanyKey(item.company);
      if (seenCompanies.has(key)) continue;
      seenCompanies.add(key);
      picked.push(item);
      if (picked.length >= 3) break;
    }
    for (const item of picked) {
      const scoreTag =
        item.importance_score >= 5 ? "🚨 Critical" : item.importance_score >= 4 ? "✨ Important" : "🗒️ Update";
      const company = companyLabel(report, item.company);
      const title = item.link ? `[${item.title}](${item.link})` : item.title;
      lines.push(`- **[${scoreTag}]** **${company}** — ${title}`);
      lines.push(`  - Insight: ${item.insight}`);
    }
  } else {
    lines.push(`- (최근 ${config.lookback_days}일 내 주요 하이라이트 없음)`);
  }
  lines.push("");

  lines.push("## 2) 카테고리별 상세 동향 (Category Deep Dive)");
  for (const c of config.categories) {
    const updates = report.category_updates?.[c.id] ?? [];
    lines.push(`### ${categoryName(config, c.id)}`);
    if (updates.length) {
      const grouped = new Map<string, Array<(typeof updates)[number]>>();
      const companyOrder: string[] = [];
      const companyName: Record<string, string> = {};
      for (const u of updates) {
        const key = normalizeCompanyKey(u.company);
        if (!grouped.has(key)) {
          grouped.set(key, []);
          companyOrder.push(key);
          companyName[key] = u.company;
        }
        grouped.get(key)!.push(u);
      }

      for (const key of companyOrder) {
        const items = grouped.get(key) ?? [];
        const company = companyLabel(report, companyName[key] ?? key);
        if (items.length <= 1) {
          const u = items[0]!;
          const title = u.url ? `[${u.title}](${u.url})` : u.title;
          lines.push(`- \`[${u.tag}]\` **${company}:** ${title}`);
          if (u.insight) lines.push(`  - Insight: ${u.insight}`);
          continue;
        }
        lines.push(`- **${company}**`);
        for (const u of items) {
          const title = u.url ? `[${u.title}](${u.url})` : u.title;
          lines.push(`  - \`[${u.tag}]\` ${title}`);
          if (u.insight) lines.push(`    - Insight: ${u.insight}`);
        }
      }
    } else {
      lines.push(`- (최근 ${config.lookback_days}일 내 업데이트 없음)`);
    }
    lines.push("");
  }

  lines.push("## 3) 해외 경쟁사 동향 (Global Competitors by Category)");
  const overseas = report.overseas_competitor_updates ?? [];
  const byCategory = new Map<string, Array<(typeof overseas)[number]>>();
  const uncategorized: Array<(typeof overseas)[number]> = [];
  for (const u of overseas) {
    if (u.category) {
      const list = byCategory.get(u.category) ?? [];
      list.push(u);
      byCategory.set(u.category, list);
    } else {
      uncategorized.push(u);
    }
  }

  const renderOverseasList = (updates: Array<(typeof overseas)[number]>): void => {
    const grouped = new Map<string, Array<(typeof updates)[number]>>();
    const companyOrder: string[] = [];
    for (const u of updates) {
      const key = normalizeCompanyKey(u.company);
      if (!grouped.has(key)) {
        grouped.set(key, []);
        companyOrder.push(key);
      }
      grouped.get(key)!.push(u);
    }

    for (const key of companyOrder) {
      const items = grouped.get(key) ?? [];
      const first = items[0]!;
      const company = companyLabel(report, first.company);
      const country = first.country ? ` (${first.country})` : "";
      if (items.length <= 1) {
        const title = first.url ? `[${first.title}](${first.url})` : first.title;
        lines.push(`- \`[${first.tag}]\` **${company}${country}:** ${title}`);
        if (first.insight) lines.push(`  - Insight: ${first.insight}`);
        continue;
      }
      lines.push(`- **${company}${country}**`);
      for (const u of items) {
        const title = u.url ? `[${u.title}](${u.url})` : u.title;
        lines.push(`  - \`[${u.tag}]\` ${title}`);
        if (u.insight) lines.push(`    - Insight: ${u.insight}`);
      }
    }
  };

  if (overseas.length === 0) {
    lines.push(`- (최근 ${config.lookback_days}일 내 확인된 해외 경쟁사 업데이트 없음)`);
  } else {
    for (const c of config.categories) {
      const items = byCategory.get(c.id) ?? [];
      lines.push(`### ${categoryName(config, c.id)} (해외)`);
      if (items.length) renderOverseasList(items);
      else lines.push(`- (최근 ${config.lookback_days}일 내 업데이트 없음)`);
      lines.push("");
    }
    if (uncategorized.length) {
      lines.push("### 기타 (해외)");
      renderOverseasList(uncategorized);
      lines.push("");
    }
  }
  lines.push("");

  lines.push("## 4) 채용으로 보는 기술 신호 (Talent & Tech Signals)");
  if (report.hiring_signals.length) {
    lines.push("| 기업명 | 채용 직무 | 우리의 해석 (Hidden Strategy) |");
    lines.push("| :--- | :--- | :--- |");
    for (const h of report.hiring_signals) {
      const company = companyLabel(report, h.company);
      const position = h.url ? `[${h.position}](${h.url})` : h.position;
      lines.push(`| ${company} | ${position} | ${h.strategic_inference} |`);
    }
  } else {
    lines.push(`- (최근 ${config.lookback_days}일 내 유의미한 채용 신호 없음)`);
  }
  lines.push("");

  lines.push("## 5) 우리의 대응 (Action Items)");
  if (report.action_items.length) {
    for (const a of report.action_items) lines.push(`- ${a}`);
  } else {
    lines.push(`- (이번 주 권장 액션 없음)`);
  }
  lines.push("");

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
