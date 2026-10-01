import xss, { type IFilterXSSOptions } from "xss";

const ALLOWED_ALIGN = new Set(["left", "center", "right"]);
const ALLOWED_CLASSES = new Set(["tiptap-link", "tiptap-img"]);
const ALLOWED_TARGETS = new Set(["_blank", "_self"]);
const ALLOWED_REL_TOKENS = new Set(["noopener", "noreferrer"]);

const DANGEROUS_SCHEME =
  /^(?:javascript|vbscript|data|file|blob|filesystem|about)\s*:/i;

function sanitizeStyleAttr(value: string): string {
  const decls = String(value)
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);

  let align: string | null = null;
  for (const decl of decls) {
    const m = /^text-align\s*:\s*(left|center|right)\s*$/i.exec(decl);
    if (m && ALLOWED_ALIGN.has(m[1].toLowerCase())) {
      align = m[1].toLowerCase();
    }
  }
  return align ? `text-align: ${align}` : "";
}

function sanitizeClassAttr(value: string): string {
  const kept = String(value)
    .split(/\s+/)
    .map((c) => c.trim())
    .filter((c) => c && ALLOWED_CLASSES.has(c));
  return kept.join(" ");
}

function sanitizeRelAttr(value: string): string {
  const kept = String(value)
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t && ALLOWED_REL_TOKENS.has(t));
  // Preserve stable order: noopener then noreferrer when both present
  const ordered: string[] = [];
  if (kept.includes("noopener")) ordered.push("noopener");
  if (kept.includes("noreferrer")) ordered.push("noreferrer");
  return ordered.join(" ");
}

function isSafeHref(raw: string): boolean {
  const value = String(raw).trim();
  if (!value) return false;
  if (DANGEROUS_SCHEME.test(value)) return false;
  // Protocol-relative URLs are rejected
  if (value.startsWith("//")) return false;
  // Internal absolute path, fragment, query-relative
  if (value.startsWith("/") || value.startsWith("#") || value.startsWith("?")) {
    return true;
  }
  if (/^mailto:/i.test(value) || /^tel:/i.test(value)) {
    return true;
  }
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function isSafeImgSrc(raw: string): boolean {
  const value = String(raw).trim();
  if (!value) return false;
  if (DANGEROUS_SCHEME.test(value)) return false;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/")) return true;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

/** Normalize an allowlisted attr; return null to drop the attribute entirely. */
function normalizeWhiteAttr(
  tag: string,
  name: string,
  value: string
): string | null {
  const attr = name.toLowerCase();
  const tagName = tag.toLowerCase();

  if (attr.startsWith("on")) return null;
  if (attr === "srcdoc" || attr === "formaction") return null;
  if (attr.startsWith("data-") || attr.startsWith("aria-")) return null;

  if (attr === "style") {
    const style = sanitizeStyleAttr(value);
    return style || null;
  }

  if (attr === "class") {
    const cls = sanitizeClassAttr(value);
    return cls || null;
  }

  if (tagName === "a" && attr === "href") {
    return isSafeHref(value) ? value.trim() : null;
  }

  if (tagName === "a" && attr === "target") {
    const t = String(value).trim().toLowerCase();
    return ALLOWED_TARGETS.has(t) ? t : null;
  }

  if (tagName === "a" && attr === "rel") {
    const rel = sanitizeRelAttr(value);
    return rel || null;
  }

  if (tagName === "img" && attr === "src") {
    return isSafeImgSrc(value) ? value.trim() : null;
  }

  if (tagName === "img" && (attr === "alt" || attr === "width" || attr === "height")) {
    return String(value);
  }

  return String(value);
}

const richHtmlXssOptions: IFilterXSSOptions = {
  whiteList: {
    h1: ["style", "class"],
    h2: ["style", "class"],
    h3: ["style", "class"],
    h4: ["style", "class"],
    p: ["style", "class"],
    strong: [],
    em: [],
    u: [],
    s: [],
    b: [],
    i: [],
    ul: [],
    ol: [],
    li: [],
    blockquote: [],
    a: ["href", "target", "rel", "class"],
    img: ["src", "alt", "width", "height", "class"],
    br: [],
    hr: [],
    span: ["style", "class"],
    div: ["style", "class"],
    pre: [],
    code: [],
  },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style", "iframe", "object", "embed"],
  allowCommentTag: false,
  css: false,
  // Return "" to fully drop the attribute (xss keeps bare attr names if safeAttrValue is "").
  onTagAttr(tag, name, value, isWhiteAttr) {
    if (!isWhiteAttr) return "";
    const normalized = normalizeWhiteAttr(tag, name, value);
    if (normalized == null) return "";
    return `${name}="${escapeAttr(normalized)}"`;
  },
};

/**
 * Write-time sanitizer for TipTap / CMS rich HTML.
 * Additive defense — render-time xss remains in place.
 */
export function sanitizeRichHtml(input: unknown): string {
  if (input == null) return "";
  const html = typeof input === "string" ? input : String(input);
  return xss(html, richHtmlXssOptions);
}
