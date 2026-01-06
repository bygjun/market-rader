import { z } from "zod";
import { CategoryId } from "./schema.js";

function coerceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let s = value.trim();
  if (!s) return undefined;
  s = s.replace(/^[<[(\s]+/, "").replace(/[>\])\s]+$/, "");
  if (!/^https?:\/\//i.test(s)) {
    if (s.startsWith("www.")) s = `https://${s}`;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(s);
    return s;
  } catch {
    return undefined;
  }
}

export const SourceItemSchema = z.object({
  company: z.string().min(1),
  category: CategoryId,
  title: z.string().min(1),
  url: z.preprocess((v) => coerceUrl(v) ?? v, z.string().url()),
  published_date: z.string().optional(),
  note: z.string().optional(),
  quote: z.preprocess((value) => {
    if (typeof value !== "string") return undefined;
    const s = value.trim();
    return s.length >= 20 ? s : undefined;
  }, z.string().min(20).max(400).optional()),
});

export const SourceListSchema = z
  .object({
    sources: z.array(z.unknown()).default([]),
  })
  .transform((input) => {
    const sources = input.sources
      .map((item) => SourceItemSchema.safeParse(item))
      .filter((r) => r.success)
      .map((r) => r.data);
    return { sources };
  });

export type SourceItem = z.infer<typeof SourceItemSchema>;
export type SourceList = z.infer<typeof SourceListSchema>;
