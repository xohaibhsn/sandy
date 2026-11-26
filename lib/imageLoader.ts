/**
 * Cloudinary / storefront image helpers for SmartImage.
 * Resizing and format negotiation happen on Cloudinary's CDN (f_auto,q_auto,w_).
 */

export type ImageMode = "cloudinary" | "local" | "external" | "empty";

const CLOUDINARY_UPLOAD_MARKER = "/image/upload/";

export function isCloudinaryImage(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return (
      u.hostname === "res.cloudinary.com" &&
      u.pathname.includes(CLOUDINARY_UPLOAD_MARKER)
    );
  } catch {
    return false;
  }
}

/** Private / authenticated Cloudinary delivery — never pass through SmartImage. */
export function isPrivateCloudinary(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (u.hostname !== "res.cloudinary.com") return false;
    const p = u.pathname;
    return (
      p.includes("/authenticated/") ||
      p.includes("/private/")
    );
  } catch {
    return false;
  }
}

export function imageMode(src: string | null | undefined): ImageMode {
  if (src == null) return "empty";
  const s = String(src).trim();
  if (!s) return "empty";
  if (isPrivateCloudinary(s)) return "empty";
  if (isCloudinaryImage(s)) return "cloudinary";
  if (s.startsWith("/")) return "local";
  if (/^https?:\/\//i.test(s)) return "external";
  return "empty";
}

function splitUploadPath(pathname: string): { before: string; after: string } | null {
  const idx = pathname.indexOf(CLOUDINARY_UPLOAD_MARKER);
  if (idx < 0) return null;
  const before = pathname.slice(0, idx + CLOUDINARY_UPLOAD_MARKER.length);
  const after = pathname.slice(idx + CLOUDINARY_UPLOAD_MARKER.length);
  return { before, after };
}

function firstSegmentIsTransforms(after: string): boolean {
  const first = after.split("/")[0] || "";
  if (!first) return false;
  if (/^v\d+$/i.test(first)) return false;
  // Transform tokens use underscore prefixes (f_auto, w_800, …)
  return /(^|,)(f_|q_|w_|c_|g_|h_|x_|y_|e_|b_|r_|a_|dpr_|fl_)/.test("," + first);
}

function tokenPresent(transformSegment: string, prefix: string): boolean {
  return transformSegment.split(",").some((t) => t === prefix || t.startsWith(prefix));
}

/**
 * Insert or merge f_auto,q_auto,w_<width> after /image/upload/.
 * Idempotent: does not double-apply existing f_/w_ tokens.
 * If both f_ and w_ are already present, pass through unchanged.
 */
export function cloudinaryLoader({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number | string;
}): string {
  if (!isCloudinaryImage(src)) return src;

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return src;
  }

  const parts = splitUploadPath(url.pathname);
  if (!parts) return src;

  const { before, after } = parts;
  const hasTransforms = firstSegmentIsTransforms(after);
  const existingTx = hasTransforms ? after.split("/")[0] || "" : "";
  const hasF = hasTransforms && tokenPresent(existingTx, "f_");
  const hasW = hasTransforms && tokenPresent(existingTx, "w_");
  const hasQ = hasTransforms && tokenPresent(existingTx, "q_");

  if (hasF && hasW) {
    return src;
  }

  const q =
    quality === undefined || quality === null || quality === ""
      ? "auto"
      : String(quality);

  const toAdd: string[] = [];
  if (!hasF) toAdd.push("f_auto");
  if (!hasQ) toAdd.push(`q_${q === "auto" ? "auto" : q}`);
  if (!hasW) toAdd.push(`w_${Math.round(Number(width) || 640)}`);

  let rest: string;
  if (hasTransforms) {
    const slash = after.indexOf("/");
    const tail = slash >= 0 ? after.slice(slash) : "";
    rest = [existingTx, ...toAdd].filter(Boolean).join(",") + tail;
  } else {
    rest = toAdd.join(",") + "/" + after;
  }

  url.pathname = before + rest;
  return url.toString();
}
