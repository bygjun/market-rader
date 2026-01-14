import { parse as dotenvParse } from "dotenv";
import { z } from "zod";

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function tryDecodeBase64(input: string): string | null {
  const compact = input.replace(/\s+/g, "");
  if (!compact) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
  if (compact.length % 4 !== 0) return null;
  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    if (decoded.includes("GEMINI_API_KEY") || decoded.includes("SMTP_HOST") || decoded.includes("MAIL_TO")) {
      return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

function parseSimpleYamlMapping(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = raw.replace(/\r/g, "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? "";
    if (value === "|") continue;
    value = value.replace(/^['"]/, "").replace(/['"]$/, "");
    result[key] = value;
  }
  return result;
}

function hydrateEnvFromSecrets(): void {
  const hasSecretBlob =
    (typeof process.env.ENV_B64 === "string" && process.env.ENV_B64.trim()) ||
    (typeof process.env.MARKET_RADER_SECRET_YML === "string" && process.env.MARKET_RADER_SECRET_YML.trim());
  if (!hasSecretBlob) return;

  const candidates: Array<{ name: string; raw: string }> = [];
  if (typeof process.env.ENV_B64 === "string" && process.env.ENV_B64.trim()) {
    candidates.push({ name: "ENV_B64", raw: process.env.ENV_B64 });
  }
  if (typeof process.env.MARKET_RADER_SECRET_YML === "string" && process.env.MARKET_RADER_SECRET_YML.trim()) {
    candidates.push({ name: "MARKET_RADER_SECRET_YML", raw: process.env.MARKET_RADER_SECRET_YML });
  }

  for (const c of candidates) {
    const decoded = tryDecodeBase64(c.raw);
    const raw = decoded ?? c.raw;
    let parsed: Record<string, string> = {};
    try {
      parsed = dotenvParse(raw);
    } catch {
      parsed = parseSimpleYamlMapping(raw);
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (isBlank(process.env[key]) && typeof value === "string" && value.trim()) {
        process.env[key] = value.trim();
      }
    }

    // Stop early only when we have the critical keys for common execution paths.
    if (!isBlank(process.env.GEMINI_API_KEY) && !isBlank(process.env.SEARCHAPI_API_KEY)) return;
  }
}

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

const SearchApiEnvSchema = z.object({
  SEARCHAPI_API_KEY: z.string().min(1),
  SEARCHAPI_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (typeof v === "string" && v.trim() ? v.trim() : undefined))
    .pipe(z.string().url().optional())
    .default("https://www.searchapi.io/api/v1/search"),
});

export type GeminiEnv = z.infer<typeof GeminiEnvSchema>;
export type MailEnv = z.infer<typeof MailEnvSchema>;
export type SearchApiEnv = z.infer<typeof SearchApiEnvSchema>;

export function loadGeminiEnv(): GeminiEnv {
  hydrateEnvFromSecrets();
  return GeminiEnvSchema.parse(process.env);
}

export function loadMailEnv(): MailEnv {
  hydrateEnvFromSecrets();
  return MailEnvSchema.parse(process.env);
}

export function loadSearchApiEnv(): SearchApiEnv {
  hydrateEnvFromSecrets();
  return SearchApiEnvSchema.parse(process.env);
}
