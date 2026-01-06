import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["GEMINI_API_KEY", "SMTP_PASS"],
    remove: true,
  },
});

