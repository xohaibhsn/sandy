"use client";

import Image, { type ImageProps } from "next/image";
import { cloudinaryLoader, imageMode } from "@/lib/imageLoader";

type SmartImageProps = Omit<ImageProps, "src" | "loader" | "unoptimized"> & {
  src: string | null | undefined;
};

/**
 * Storefront image wrapper: Cloudinary URLs use a custom loader
 * (f_auto,q_auto,w_ on CDN). Local/external use unoptimized next/image.
 * Empty src renders nothing (caller keeps placeholder).
 */
export default function SmartImage({ src, alt, ...rest }: SmartImageProps) {
  const mode = imageMode(src);
  if (mode === "empty" || !src) return null;

  const resolvedAlt = alt ?? "";

  if (mode === "cloudinary") {
    return <Image {...rest} src={src} alt={resolvedAlt} loader={cloudinaryLoader} />;
  }

  // local (/public) or other hosts — never throw on unknown host
  return <Image {...rest} src={src} alt={resolvedAlt} unoptimized />;
}
