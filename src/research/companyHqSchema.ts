import { z } from "zod";

export const CompanyHqSchema = z.object({
  company_hq: z
    .record(z.string(), z.unknown())
    .default({})
    .transform((rec) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) {
        const key = typeof k === "string" ? k.trim() : "";
        if (!key) continue;
        if (typeof v === "string" && v.trim()) out[key] = v.trim();
      }
      return out;
    }),
});

export type CompanyHq = z.infer<typeof CompanyHqSchema>;
