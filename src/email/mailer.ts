import nodemailer from "nodemailer";
import type { MailEnv } from "../lib/env.js";

function normalizeFrom(env: MailEnv): string {
  const raw = (env.MAIL_FROM ?? "").trim();
  if (!raw) return env.SMTP_USER;
  if (raw.includes("<") && raw.includes(">")) return raw;
  if (raw.includes("@")) return raw;
  const name = raw.replace(/^["']|["']$/g, "").trim();
  const addr = (env.SMTP_USER ?? "").trim();
  if (!addr || !addr.includes("@")) return raw;
  return name ? `${name} <${addr}>` : addr;
}

export async function sendEmail(args: {
  env: MailEnv;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: args.env.SMTP_HOST,
    port: args.env.SMTP_PORT,
    secure: args.env.SMTP_SECURE,
    auth: { user: args.env.SMTP_USER, pass: args.env.SMTP_PASS },
  });

  const to = args.env.MAIL_TO.split(",").map((s) => s.trim()).filter(Boolean);

  await transporter.sendMail({
    from: normalizeFrom(args.env),
    to,
    subject: args.subject,
    html: args.html,
    text: args.text,
  });
}
