import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // No Content-Security-Policy here on purpose: the page is dynamically
          // rendered and Next.js inlines its hydration bootstrap, which a static
          // `script-src 'self'` blocks — dead page, no canvas, every UI test
          // burning its full timeout (see src/proxy.ts). The proxy owns the CSP
          // and mints a per-request nonce for those inline scripts instead.
        ],
      },
    ];
  },
};

export default nextConfig;
