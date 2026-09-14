import { readServerAuthConfig } from '../../../src/session/auth-config';

/**
 * Story 1.12: runtime auth configuration, read from the edge container's environment on every
 * request (never baked at build time - the image is promoted between environments by digest).
 * In `oidc` mode a missing authority or client id fails closed with 500.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  const config = readServerAuthConfig(process.env);
  if (!config) {
    return Response.json(
      {
        error_code: 'EDGE_AUTH_CONFIG_MISSING',
        message: 'EDGE_AUTH_MODE=oidc requires EDGE_OIDC_AUTHORITY and EDGE_OIDC_CLIENT_ID',
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return Response.json(config, { headers: { 'Cache-Control': 'no-store' } });
}
