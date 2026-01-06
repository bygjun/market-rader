import nodemailer from "nodemailer";
import type { MailEnv } from "../lib/env.js";

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
    from: args.env.MAIL_FROM,
    to,
    subject: args.subject,
    html: args.html,
    text: args.text,
  });
}
