import { z } from "zod";

export const CategoryId = z.enum(["CAT-A", "CAT-B", "CAT-C", "CAT-D"]);

export const HighlightSchema = z.object({
  company: z.string().min(1),
  category: CategoryId,
  title: z.string().min(1),
  insight: z.string().min(1),
  importance_score: z.number().int().min(1).max(5),
  link: z.string().url().optional(),
});

export const CategoryUpdateSchema = z.object({
  company: z.string().min(1),
  tag: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url().optional(),
  insight: z.string().min(1).optional(),
});

export const HiringSignalSchema = z.object({
  company: z.string().min(1),
  position: z.string().min(1),
  strategic_inference: z.string().min(1),
  url: z.string().url().optional(),
});

const ActionItemSchema = z.preprocess((value) => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;

  const textLike =
    (typeof obj.text === "string" && obj.text) ||
    (typeof obj.item === "string" && obj.item) ||
    (typeof obj.action === "string" && obj.action) ||
    (typeof obj.title === "string" && obj.title);
  const teamLike =
    (typeof obj.team === "string" && obj.team) ||
    (typeof obj.owner === "string" && obj.owner) ||
    (typeof obj.department === "string" && obj.department);

  if (teamLike && textLike) return `${teamLike}: ${textLike}`;
  if (textLike) return textLike;

  try {
    return JSON.stringify(obj);
  } catch {
    return String(value);
  }
}, z.string().min(1));

export const WeeklyReportSchema = z.object({
  report_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  week_number: z.number().int().min(1).max(53),
  top_highlights: z.array(HighlightSchema).default([]),
  category_updates: z
    .object({
      "CAT-A": z.array(CategoryUpdateSchema).default([]),
      "CAT-B": z.array(CategoryUpdateSchema).default([]),
      "CAT-C": z.array(CategoryUpdateSchema).default([]),
      "CAT-D": z.array(CategoryUpdateSchema).default([]),
    })
    .default({
      "CAT-A": [],
      "CAT-B": [],
      "CAT-C": [],
      "CAT-D": [],
    }),
  hiring_signals: z.array(HiringSignalSchema).default([]),
  action_items: z.array(ActionItemSchema).default([]),
});

export type WeeklyReport = z.infer<typeof WeeklyReportSchema>;
