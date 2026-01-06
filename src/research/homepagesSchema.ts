import { z } from "zod";

function coerceOptionalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let s = value.trim();
  if (!s) return undefined;
  s = s.replace(/^[<[(\s]+/, "").replace(/[>\])\s]+$/, "");
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s)) {
    if (s.startsWith("www.")) s = `https://${s}`;
    else return undefined;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(s);
    return s;
  } catch {
    return undefined;
  }
}

export const CompanyHomepagesSchema = z.object({
  company_homepages: z
    .record(z.string().min(1), z.preprocess(coerceOptionalUrl, z.string().url().optional()))
    .default({})
    .transform((rec) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (typeof v === "string" && v) out[k] = v;
      }
      return out;
    }),
});

export type CompanyHomepages = z.infer<typeof CompanyHomepagesSchema>;
