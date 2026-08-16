/**
 * Next.js configuration for the Telegram Mini App.
 *
 * The security headers here are the browser-side half of the defence; the API half lives in
 * `src/lib/api-handler.ts`. Both are needed: headers stop a hostile page from framing or
 * script-injecting this one, while the handler stops a hostile *request* from being trusted.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Type and lint errors fail the build. A financial app should not ship a "warning".
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true, dirs: [] },

  experimental: {
    // Workspace packages ship compiled ESM, so nothing extra to transpile.
    optimizePackageImports: ['@wallet/shared'],
  },

  async headers() {
    const csp = [
      "default-src 'self'",
      // Telegram's WebApp bridge must be loaded from telegram.org — that is the platform
      // contract. 'unsafe-inline' covers Next's inline bootstrap; there is no nonce path
      // that works with static export of client components here.
      "script-src 'self' 'unsafe-inline' https://telegram.org",
      "style-src 'self' 'unsafe-inline'",
      // Telegram serves user avatars from its own CDN; data: covers our server-rendered QR.
      "img-src 'self' data: blob: https://t.me https://*.telegram.org https://*.cdn-telegram.org",
      "font-src 'self' data:",
      // Same-origin API only. No third-party endpoint is called from the browser — all
      // provider traffic happens server-side.
      "connect-src 'self'",
      'frame-ancestors https://web.telegram.org https://telegram.org',
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Telegram renders the Mini App inside an iframe on web, so DENY is not an option;
          // `frame-ancestors` above restricts it to Telegram's own origins instead.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
        ],
      },
      {
        // API responses must never be cached by a proxy or the browser: they are per-user
        // financial data behind a bearer token.
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ];
  },
};

export default nextConfig;
