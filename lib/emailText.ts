/** Shared text helpers for transactional email (HTML escaping + subject sanitising). */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes user text for HTML and turns line breaks into <br>. */
export function escapeHtmlMultiline(s: string): string {
  return escapeHtml(s).replace(/\r\n|\r|\n/g, '<br>');
}

export const SUBJECT_NAME_MAX = 80;

/** Single-line, control-character-free, length-capped text for an email subject header. */
export function sanitizeSubjectPart(s: string, max: number): string {
  return s
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Simple syntactic check: local@domain.tld, single line, 5..254 chars. */
export function isValidCustomerEmail(s: string): boolean {
  const t = String(s ?? '').trim();
  if (t.length < 5 || t.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) && !/[\r\n]/.test(t);
}
