import { z } from "zod";

export const CompanyDiscoverySchema = z.object({
  companies: z
    .array(
      z.object({
        company: z.string().optional().default(""),
        category_id: z.string().optional().default(""),
        aliases: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
});

export type CompanyDiscovery = z.infer<typeof CompanyDiscoverySchema>;
