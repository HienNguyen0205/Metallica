import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Per-request Content-Security-Policy with a mint-fresh nonce.
 *
 * A static `script-src 'self'` (previously in next.config.ts) blocks the
 * inline bootstrap Next.js needs to hydrate a prerendered page: no hydration
 * means no canvas, and every UI test burns its full 120s timeout until the CI
 * shards hit the 25-minute job limit. Next applies the request's nonce to its
 * own inline scripts automatically (no per-tag wiring), but only for
 * dynamically rendered pages — hence `export const dynamic = "force-dynamic"`
 * in src/app/page.tsx.
 *
 * Deliberately WITHOUT 'strict-dynamic': the policy keeps the previous
 * allowlist semantics plus the nonce. strict-dynamic would additionally void
 * the 'self' allowlist, and the TTS AudioWorklet module (same-origin
 * /audio/tts-worklet.js, fetched via addModule rather than <script>) is not
 * something the UI suite can prove safe under it. No third-party scripts exist
 * here, so strict-dynamic buys nothing while risking the voice path.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  // React dev uses eval for server-error reconstruction; production never does.
  const isDev = process.env.NODE_ENV === "development";
  const cspHeader = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""};
    style-src 'self' 'unsafe-inline';
    img-src 'self' data: blob:;
    font-src 'self' data:;
    connect-src 'self' https: http://localhost:8000 http://127.0.0.1:8123;
    media-src 'self' blob:;
    object-src 'none';
    base-uri 'self';
    frame-ancestors 'none'
  `;
  // tighten connect-src once the orchestrator host is stable;
  // https: allowance covers the Render backend + Vercel preview deploys.
  const contentSecurityPolicyHeaderValue = cspHeader.replace(/\s{2,}/g, " ").trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicyHeaderValue);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  response.headers.set("Content-Security-Policy", contentSecurityPolicyHeaderValue);

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the favicon — those carry no inline
     * scripts and must not pay proxy overhead or gain a useless nonce.
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
