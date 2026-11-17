import type { NextApiRequest, NextApiResponse } from 'next';
import pool from '../../lib/db';
import { getClientIp, rateLimit } from '../../lib/rateLimit';

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

type Cleaned = { ok: true; value: string } | { ok: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Strip control characters (optionally keeping newlines), then trim. */
function clean(raw: string, keepNewlines: boolean): string {
  const normalized = keepNewlines ? raw.replace(/\r\n?/g, '\n') : raw;
  const pattern = keepNewlines ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return normalized.replace(pattern, '').trim();
}

function readField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  keepNewlines = false
): Cleaned {
  const raw = body[key];
  if (raw === undefined || raw === null) return min === 0 ? { ok: true, value: '' } : { ok: false };
  if (typeof raw !== 'string') return { ok: false };
  const value = clean(raw, keepNewlines);
  if (value.length < min || value.length > max) return { ok: false };
  return { ok: true, value };
}

function isMissing(body: Record<string, unknown>, key: string): boolean {
  const raw = body[key];
  if (raw === undefined || raw === null) return true;
  return typeof raw === 'string' && raw.trim() === '';
}

function honeypotFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { allowed } = rateLimit(`contact:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  const body: unknown = req.body;
  if (!isPlainObject(body)) return res.status(400).json({ error: 'Invalid input' });

  // Honeypot: bots fill the hidden field. Pretend success, store nothing.
  if (honeypotFilled(body.website)) return res.status(200).json({ success: true });

  if (['name', 'email', 'message'].some((key) => isMissing(body, key))) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const name = readField(body, 'name', 1, 255);
  const email = readField(body, 'email', 1, 255);
  const phone = readField(body, 'phone', 0, 50);
  const subject = readField(body, 'subject', 0, 255);
  const message = readField(body, 'message', 1, 5000, true);

  if (!name.ok || !email.ok || !phone.ok || !subject.ok || !message.ok || !EMAIL_RE.test(email.value)) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  try {
    await pool.query(
      'INSERT INTO contact_messages (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)',
      [name.value, email.value, phone.value, subject.value, message.value]
    );
    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error('[contact] insert failed', typeof code === 'string' ? code : 'unknown');
    return res.status(500).json({ error: 'Server error' });
  }
}
