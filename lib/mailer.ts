/**
 * Shared SMTP transport + never-throwing send helper for transactional email.
 * Logs failures with kind / order id / error code only — never recipient, subject or body.
 */
import nodemailer from "nodemailer";
import { ORDERS_FROM_EMAIL } from "./site";
import { isValidCustomerEmail } from "./emailText";

export type MailMessage = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
};

export type MailMeta = { kind: string; orderId: string };

export type MailResult = { ok: true } | { ok: false; code: string };

/** Minimal transport surface (real nodemailer transporter or a test double). */
export type MailTransport = {
  sendMail: (message: MailMessage) => Promise<unknown>;
};

/**
 * From address for store + customer order emails.
 * Optional MAIL_FROM (validated) overrides ORDERS_FROM_EMAIL; invalid/empty is ignored.
 */
export function resolveMailFromAddress(): string {
  const raw = typeof process.env.MAIL_FROM === "string" ? process.env.MAIL_FROM.trim() : "";
  if (raw && isValidCustomerEmail(raw)) return raw;
  return ORDERS_FROM_EMAIL;
}

/**
 * Test-only JSON transport: SANDY_MAIL_JSON_TRANSPORT=1 and NODE_ENV !== "production".
 * In production the flag is ignored and the real SMTP transport is always used.
 */
function jsonTransportEnabled(): boolean {
  return process.env.SANDY_MAIL_JSON_TRANSPORT === "1" && process.env.NODE_ENV !== "production";
}

/** True when a transport can be created (SMTP credentials, or the test-only JSON transport). */
export function isMailConfigured(): boolean {
  if (jsonTransportEnabled()) return true;
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function createOrderTransport(): MailTransport {
  if (jsonTransportEnabled()) {
    return nodemailer.createTransport({ jsonTransport: true }) as unknown as MailTransport;
  }
  return nodemailer.createTransport({
    host: "smtp.hostinger.com",
    port: 465,
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  }) as unknown as MailTransport;
}

function safeToken(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, max);
}

/**
 * Sends one message; never throws. On failure logs ONLY
 * `[mail] send failed kind=<kind> order=<id> code=<err.code|unknown>`.
 */
export async function sendMailSafe(
  msg: MailMessage,
  meta: MailMeta,
  transport?: MailTransport
): Promise<MailResult> {
  try {
    const t = transport ?? createOrderTransport();
    await t.sendMail(msg);
    return { ok: true };
  } catch (err) {
    const rawCode = (err as { code?: unknown } | null | undefined)?.code;
    const code = typeof rawCode === "string" && rawCode ? safeToken(rawCode, 40) || "unknown" : "unknown";
    console.error(`[mail] send failed kind=${safeToken(meta.kind, 40)} order=${safeToken(meta.orderId, 64)} code=${code}`);
    return { ok: false, code };
  }
}
