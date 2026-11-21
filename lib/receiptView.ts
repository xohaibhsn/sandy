/**
 * Classify a receipt URL for admin preview (Finding 67).
 * Uses path extension only; ignores query/hash. Non-relative / non-proxy -> unknown.
 */
export function receiptKindFromUrl(url: string): "pdf" | "image" | "unknown" {
  if (typeof url !== "string" || !url.trim()) return "unknown";
  const trimmed = url.trim();
  // Reject absolute URLs and dangerous schemes
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return "unknown";
  // Path only (strip query/hash)
  const pathOnly = trimmed.split(/[?#]/, 1)[0] || "";
  // Same-origin proxy or other relative paths only
  if (!pathOnly.startsWith("/")) return "unknown";
  const m = pathOnly.match(/\.([a-zA-Z0-9]+)$/);
  if (!m) return "unknown";
  const ext = m[1].toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp") return "image";
  return "unknown";
}
