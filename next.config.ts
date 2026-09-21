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
          // Allow exactly what the app uses, for this origin only: the mic
          // (voice), geolocation (LOC button) and compute-pressure (device
          // readings for get_client_metrics). Powerful features it never
          // touches are switched off, so no injected script can ask for them.
          {
            key: "Permissions-Policy",
            value: [
              "microphone=(self)",
              "geolocation=(self)",
              "compute-pressure=(self)",
              "camera=()",
              "usb=()",
              "serial=()",
              "bluetooth=()",
              "hid=()",
              "payment=()",
              "display-capture=()",
              "idle-detection=()",
            ].join(", "),
          },
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
