/**
 * Classify a receipt URL for admin preview (Finding 67 / 73).
 * Uses path extension only; ignores query/hash.
 * Relative same-origin paths and absolute https: URLs are classified by extension.
 * Protocol-relative and non-https schemes -> unknown.
 */
export function receiptKindFromUrl(url: string): "pdf" | "image" | "unknown" {
  if (typeof url !== "string" || !url.trim()) return "unknown";
  const trimmed = url.trim();
  // Protocol-relative URLs (Finding 73)
  if (trimmed.startsWith("//")) return "unknown";

  let pathOnly = "";
  if (/^https:/i.test(trimmed)) {
    // Absolute https: — classify by path extension (legacy server-validated receipts)
    try {
      const u = new URL(trimmed);
      pathOnly = u.pathname || "";
    } catch {
      return "unknown";
    }
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    // http:, data:, javascript:, blob:, and any other scheme
    return "unknown";
  } else {
    // Path only (strip query/hash)
    pathOnly = trimmed.split(/[?#]/, 1)[0] || "";
    // Same-origin proxy or other relative paths only
    if (!pathOnly.startsWith("/")) return "unknown";
  }

  const m = pathOnly.match(/\.([a-zA-Z0-9]+)$/);
  if (!m) return "unknown";
  const ext = m[1].toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp") return "image";
  return "unknown";
}
