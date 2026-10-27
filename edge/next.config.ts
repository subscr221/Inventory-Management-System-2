import type { NextConfig } from 'next';
import { resolve } from 'node:path';

// PowerSync listens on loopback only. Production nginx publishes it at /powersync on the
// same origin as the edge (deploy/compose/nginx.conf.template). Next does that job in dev
// and in the standalone server, so the browser is never told to dial 127.0.0.1:8080.
const powerSyncUpstream = (process.env['POWERSYNC_UPSTREAM'] ?? 'http://127.0.0.1:8080').replace(
  /\/$/,
  '',
);

const nextConfig: NextConfig = {
  output: 'standalone',
  // Next treats 127.0.0.1 as cross-origin when the dev server is bound to 0.0.0.0.
  // Without this, the dev client never hydrates and the shell stays a static page.
  allowedDevOrigins: ['127.0.0.1'],
  turbopack: { root: resolve(process.cwd(), '..') },
  async rewrites() {
    return [
      { source: '/powersync', destination: `${powerSyncUpstream}/` },
      { source: '/powersync/:path*', destination: `${powerSyncUpstream}/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
