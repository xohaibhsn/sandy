import type { NextConfig } from "next";
import { buildHeaderRules } from "./lib/securityHeaders";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  generateEtags: false,
  images: {
    unoptimized: false,
    remotePatterns: [
      { protocol: "https", hostname: "res.cloudinary.com" },
    ],
  },
  compress: true,
  async redirects() {
    return [
      // Canonical host: www → apex (path + query preserved by Next)
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.sandy.com.pk" }],
        destination: "https://sandy.com.pk/:path*",
        statusCode: 301,
      },
    ];
  },
  async rewrites() {
    return [
      // Browsers auto-request /favicon.ico — serve dynamic DB favicon
      { source: "/favicon.ico", destination: "/api/favicon" },
    ];
  },
  async headers() {
    return buildHeaderRules();
  },
};

export default nextConfig;
