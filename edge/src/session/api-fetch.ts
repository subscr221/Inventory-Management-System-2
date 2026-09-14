import { getActiveSession } from './session';

/**
 * Story 1.12: the one place the edge UI attaches its identity to an API call.
 *
 * - Resolves the global `fetch` at call time so unit tests can keep mocking `globalThis.fetch`.
 * - Adds `Authorization: Bearer <access token>` when the active session has one (AC2); with no
 *   active session or no token the request goes out unchanged (node:test, Playwright, local mode
 *   without a dev subject).
 * - On a 401 that was sent WITH a token: one refresh-token grant and one retry. A second 401, or
 *   a failed refresh, is reported through `EdgeSession.notifyRejected()`; the edge client decides
 *   whether a redirect is possible (online) or the outbox simply keeps the captures (offline).
 * - 403 and every other status pass through: authorization failures are not sign-in problems.
 */
export async function authorizedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const session = getActiveSession();
  const token = session ? await session.getAccessToken() : null;
  // A Request carrying a body can be sent once; keep an unread copy for the retry.
  const replay = token && input instanceof Request ? input.clone() : input;
  const response = await fetch(input, withBearer(init, token));
  if (response.status !== 401 || !session || !token) return response;

  const refreshed = await session.refresh();
  const retryToken = refreshed ? await session.getAccessToken() : null;
  if (!retryToken) {
    session.notifyRejected();
    return response;
  }
  const retry = await fetch(replay, withBearer(init, retryToken));
  if (retry.status === 401) session.notifyRejected();
  return retry;
}

function withBearer(init: RequestInit | undefined, token: string | null): RequestInit | undefined {
  if (!token) return init;
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}
