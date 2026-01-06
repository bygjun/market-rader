import { z } from "zod";

const GeminiEnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().min(1).default("gemini-2.5-flash"),
  ),
  REQUIRE_GROUNDING: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  MAIL_SUBJECT_PREFIX: z.string().optional().default("[Market Radar]"),
  TZ: z.string().optional().default("Asia/Seoul"),
});

const MailEnvSchema = z.object({
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase() === "true"),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  MAIL_FROM: z.string().min(1),
  MAIL_TO: z.string().min(1),
});

export type GeminiEnv = z.infer<typeof GeminiEnvSchema>;
export type MailEnv = z.infer<typeof MailEnvSchema>;

export function loadGeminiEnv(): GeminiEnv {
  return GeminiEnvSchema.parse(process.env);
}

export function loadMailEnv(): MailEnv {
  return MailEnvSchema.parse(process.env);
}
