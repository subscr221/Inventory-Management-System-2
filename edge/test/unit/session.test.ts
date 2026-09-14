import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EdgeSession,
  getActiveSession,
  safeReturnPath,
  setActiveSession,
  type SessionManager,
  type SessionUser,
} from '../../src/session/session';
import type { AuthConfig } from '../../src/session/auth-config';

const OIDC: AuthConfig = { mode: 'oidc', authority: 'https://a/realms/ims', clientId: 'ims-app' };

interface FakeOptions {
  user?: SessionUser | null;
  silent?: SessionUser | null | Error;
}

class FakeManager implements SessionManager {
  calls: string[] = [];
  renewErrorHandlers: Array<(error: Error) => void> = [];
  signedOutHandlers: Array<() => void> = [];
  private user: SessionUser | null;
  private readonly silent: SessionUser | null | Error;

  constructor(options: FakeOptions = {}) {
    this.user = options.user ?? null;
    this.silent = options.silent ?? null;
  }

  async getUser(): Promise<SessionUser | null> {
    this.calls.push('getUser');
    return this.user;
  }
  async signinRedirect(args?: { state?: unknown }): Promise<void> {
    this.calls.push(`signinRedirect:${JSON.stringify(args?.state ?? null)}`);
  }
  async signinCallback(url?: string): Promise<SessionUser | undefined> {
    this.calls.push(`signinCallback:${url ?? ''}`);
    return this.user ?? undefined;
  }
  async signinSilent(): Promise<SessionUser | null> {
    this.calls.push('signinSilent');
    if (this.silent instanceof Error) throw this.silent;
    if (this.silent) this.user = this.silent;
    return this.silent;
  }
  async signoutRedirect(): Promise<void> {
    this.calls.push('signoutRedirect');
  }
  async removeUser(): Promise<void> {
    this.calls.push('removeUser');
    this.user = null;
  }
  stopSilentRenew(): void {
    this.calls.push('stopSilentRenew');
  }
  events = {
    addSilentRenewError: (cb: (error: Error) => void) => {
      this.renewErrorHandlers.push(cb);
      return () => undefined;
    },
    addUserSignedOut: (cb: () => void) => {
      this.signedOutHandlers.push(cb);
      return () => undefined;
    },
  };
}

const live: SessionUser = { access_token: 'live-token', refresh_token: 'r', expired: false };
const stale: SessionUser = { access_token: 'stale-token', refresh_token: 'r', expired: true };

describe('Story 1.12 session: local mode', () => {
  it('takes a dev token for the configured subject and serves it as the access token', async (t) => {
    const requests: Array<{ url: string; body: unknown }> = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ token: 'dev-token' }, { status: 201 });
    });
    const session = new EdgeSession({ config: { mode: 'local', devSubject: 'raman' } });
    const outcome = await session.ensureSignedIn('/maintenance');
    assert.equal(outcome.kind, 'ready');
    assert.deepEqual(requests, [{ url: '/api/v1/auth/dev-token', body: { sub: 'raman' } }]);
    assert.equal(await session.getAccessToken(), 'dev-token');
  });

  it('runs with no token when no subject is configured (Playwright, no API)', async (t) => {
    let fetched = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetched += 1;
      return new Response(null, { status: 500 });
    });
    const session = new EdgeSession({ config: { mode: 'local', devSubject: null } });
    assert.equal((await session.ensureSignedIn('/')).kind, 'ready');
    assert.equal(fetched, 0);
    assert.equal(await session.getAccessToken(), null);
  });

  it('still starts when the dev-token endpoint is unreachable', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const session = new EdgeSession({ config: { mode: 'local', devSubject: 'raman' } });
    assert.equal((await session.ensureSignedIn('/')).kind, 'ready');
    assert.equal(await session.getAccessToken(), null);
  });
});

describe('Story 1.12 session: oidc start rules', () => {
  it('proceeds without any redirect when a live user is cached', async () => {
    const manager = new FakeManager({ user: live });
    const session = new EdgeSession({ config: OIDC, manager, isOnline: () => true });
    assert.equal((await session.ensureSignedIn('/maintenance')).kind, 'ready');
    assert.deepEqual(manager.calls, ['getUser']);
    assert.equal(await session.getAccessToken(), 'live-token');
  });

  it('renews silently once when the cached user is expired and the device is online', async () => {
    const manager = new FakeManager({ user: stale, silent: live });
    const session = new EdgeSession({ config: OIDC, manager, isOnline: () => true });
    assert.equal((await session.ensureSignedIn('/maintenance')).kind, 'ready');
    assert.deepEqual(manager.calls, ['getUser', 'signinSilent']);
    assert.equal(await session.getAccessToken(), 'live-token');
  });

  it('redirects to login, remembering the requested screen, when the silent renew fails online', async () => {
    const manager = new FakeManager({ user: stale, silent: new Error('invalid_grant') });
    const session = new EdgeSession({ config: OIDC, manager, isOnline: () => true });
    assert.equal((await session.ensureSignedIn('/maintenance?wo=1')).kind, 'redirecting');
    assert.deepEqual(manager.calls, [
      'getUser',
      'signinSilent',
      'signinRedirect:{"returnTo":"/maintenance?wo=1"}',
    ]);
  });

  it('keeps the expired cached user and never redirects while offline (AC5)', async () => {
    const manager = new FakeManager({ user: stale, silent: live });
    const session = new EdgeSession({ config: OIDC, manager, isOnline: () => false });
    assert.equal((await session.ensureSignedIn('/')).kind, 'ready');
    assert.deepEqual(manager.calls, ['getUser']);
    assert.equal(await session.getAccessToken(), 'stale-token');
  });

  it('redirects to login when there is no cached user and the device is online (AC1)', async () => {
    const manager = new FakeManager();
    const session = new EdgeSession({ config: OIDC, manager, isOnline: () => true });
    assert.equal((await session.ensureSignedIn('/gate')).kind, 'redirecting');
    assert.deepEqual(manager.calls, ['getUser', 'signinRedirect:{"returnTo":"/gate"}']);
  });

  it('reports offline_no_session when there is no cached user and no network', async () => {
    const manager = new FakeManager();
    const session = new EdgeSession({ config: OIDC, manager, isOnline: () => false });
    assert.equal((await session.ensureSignedIn('/')).kind, 'offline_no_session');
    assert.deepEqual(manager.calls, ['getUser']);
  });
});

describe('Story 1.12 session: refresh, auth loss, callback', () => {
  it('refresh() returns true after a successful silent renew and false after a failure', async () => {
    const ok = new EdgeSession({ config: OIDC, manager: new FakeManager({ user: stale, silent: live }) });
    assert.equal(await ok.refresh(), true);
    const bad = new EdgeSession({
      config: OIDC,
      manager: new FakeManager({ user: stale, silent: new Error('invalid_grant') }),
    });
    assert.equal(await bad.refresh(), false);
  });

  it('coalesces concurrent refreshes into one token request', async () => {
    const manager = new FakeManager({ user: stale, silent: live });
    const session = new EdgeSession({ config: OIDC, manager });
    await Promise.all([session.refresh(), session.refresh(), session.refresh()]);
    assert.equal(manager.calls.filter((call) => call === 'signinSilent').length, 1);
  });

  it('routes IdP sign-out events to onAuthLost but never a background silent-renew failure (AC5)', () => {
    const manager = new FakeManager({ user: live });
    const session = new EdgeSession({ config: OIDC, manager });
    const reasons: string[] = [];
    session.onAuthLost((reason) => reasons.push(reason));
    assert.equal(manager.renewErrorHandlers.length, 0, 'no silent-renew error subscription');
    manager.signedOutHandlers.forEach((handler) => handler());
    assert.deepEqual(reasons, ['signed_out']);
  });

  it('dispose stops the renew timer and every subscription', () => {
    const manager = new FakeManager({ user: live });
    let unsubscribed = 0;
    manager.events.addUserSignedOut = (cb: () => void) => {
      manager.signedOutHandlers.push(cb);
      return () => {
        unsubscribed += 1;
      };
    };
    const session = new EdgeSession({ config: OIDC, manager });
    const reasons: string[] = [];
    session.onAuthLost((reason) => reasons.push(reason));
    session.dispose();
    manager.signedOutHandlers.forEach((handler) => handler());
    assert.deepEqual(manager.calls, ['stopSilentRenew']);
    assert.equal(unsubscribed, 1);
    assert.deepEqual(reasons, []);
  });

  it('handleCallback completes the code exchange and returns the remembered screen', async () => {
    const manager = new FakeManager({ user: { ...live, state: { returnTo: '/maintenance' } } });
    const session = new EdgeSession({ config: OIDC, manager });
    assert.deepEqual(await session.handleCallback('https://ims/auth/callback?code=x&state=y'), {
      returnTo: '/maintenance',
    });
    assert.deepEqual(manager.calls, ['signinCallback:https://ims/auth/callback?code=x&state=y']);
  });

  it('never returns an external or protocol-relative return path', () => {
    assert.equal(safeReturnPath('/maintenance?wo=1'), '/maintenance?wo=1');
    assert.equal(safeReturnPath('https://evil.example/'), '/');
    assert.equal(safeReturnPath('//evil.example/'), '/');
    assert.equal(safeReturnPath('/auth/callback?code=old'), '/');
    assert.equal(safeReturnPath('/auth/callback/'), '/');
    assert.equal(safeReturnPath('/auth/callback#x'), '/');
    assert.equal(safeReturnPath('/auth/callbacks-report'), '/auth/callbacks-report');
    assert.equal(safeReturnPath(undefined), '/');
    assert.equal(safeReturnPath(42), '/');
  });
});

describe('Story 1.12 session: sign-out on a shared tablet (AC4)', () => {
  it('refuses to sign out while unsettled captures remain, touching nothing', async () => {
    const manager = new FakeManager({ user: live });
    const session = new EdgeSession({ config: OIDC, manager });
    let cleared = 0;
    const result = await session.signOut({
      countUnsettled: async () => 3,
      clearCachedUser: async () => {
        cleared += 1;
      },
    });
    assert.deepEqual(result, { blocked: 'unsettled_outbox', count: 3 });
    assert.equal(cleared, 0);
    assert.deepEqual(manager.calls, []);
  });

  it('clears the cached identity, ends the Keycloak session while the id token is still there, then drops the tokens', async () => {
    const manager = new FakeManager({ user: live });
    const session = new EdgeSession({ config: OIDC, manager });
    const order: string[] = [];
    const result = await session.signOut({
      countUnsettled: async () => 0,
      clearCachedUser: async () => {
        order.push('clearCachedUser');
      },
    });
    assert.deepEqual(result, { blocked: null });
    // signoutRedirect first: it needs the stored id token for id_token_hint.
    assert.deepEqual([...order, ...manager.calls], ['clearCachedUser', 'signoutRedirect', 'removeUser']);
    assert.equal(await session.getAccessToken(), null);
  });

  it('still drops the tokens and reports it when the IdP logout redirect fails', async () => {
    const manager = new FakeManager({ user: live });
    manager.signoutRedirect = async () => {
      manager.calls.push('signoutRedirect');
      throw new Error('IdP unreachable');
    };
    const session = new EdgeSession({ config: OIDC, manager });
    const result = await session.signOut({ countUnsettled: async () => 0, clearCachedUser: async () => undefined });
    assert.deepEqual(result, { blocked: null, redirectFailed: true });
    assert.deepEqual(manager.calls, ['signoutRedirect', 'removeUser']);
    assert.equal(await session.getAccessToken(), null);
  });

  it('local mode sign-out forgets the dev token without an IdP round trip', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ token: 'dev-token' }, { status: 201 }));
    const session = new EdgeSession({ config: { mode: 'local', devSubject: 'raman' } });
    await session.ensureSignedIn('/');
    assert.equal(await session.getAccessToken(), 'dev-token');
    const result = await session.signOut({ countUnsettled: async () => 0, clearCachedUser: async () => undefined });
    assert.deepEqual(result, { blocked: null });
    assert.equal(await session.getAccessToken(), null);
  });
});

describe('Story 1.12 session: active session registry', () => {
  it('exposes the active session to non-React callers and can be cleared', () => {
    assert.equal(getActiveSession(), null);
    const session = new EdgeSession({ config: { mode: 'local', devSubject: null } });
    setActiveSession(session);
    assert.equal(getActiveSession(), session);
    setActiveSession(null);
    assert.equal(getActiveSession(), null);
  });
});
