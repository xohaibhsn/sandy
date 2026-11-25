/**
 * about_mission may be plain text or a JSON object `{ title?, text }` (B-24).
 * When the value parses as an object with a string `text`, use that text; otherwise return as-is.
 */
export function resolveAboutMissionText(raw: unknown): string {
  if (raw == null) return "";
  const s = typeof raw === "string" ? raw : String(raw);
  const trimmed = s.trim();
  if (!trimmed) return "";
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return s;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { text?: unknown }).text === "string"
    ) {
      return (parsed as { text: string }).text;
    }
  } catch {
    /* keep original */
  }
  return s;
}
