import type { AuthConfig } from './auth-config';

/**
 * Story 1.12: the edge UI's sign-in session.
 *
 * A thin wrapper over an injectable `SessionManager` (in the browser: oidc-client-ts's
 * `UserManager`, built by `createBrowserSession`). The wrapper owns the start rules, the
 * single-flight refresh, the auth-loss fan-out, and the shared-tablet sign-out gate; the library
 * owns PKCE, state, token storage and the refresh-token grant. Unit tests drive the wrapper through
 * a fake manager under `node:test` with no DOM.
 *
 * Start rules (`ensureSignedIn`):
 * - local mode: take a dev token for the configured subject, or run with no token at all.
 * - oidc, cached user still valid: proceed.
 * - oidc, cached user expired, online: one silent renew; if that fails, redirect to login.
 * - oidc, cached user expired, offline: proceed on the cached user (AC5) - never redirect offline.
 * - oidc, no user, online: redirect to login remembering the requested screen (AC1).
 * - oidc, no user, offline: nothing can be done; the shell shows `auth.offlineNoSession`.
 */

/** The subset of oidc-client-ts's `User` the session reads. */
export interface SessionUser {
  access_token: string;
  refresh_token?: string;
  /** oidc-client-ts: `undefined` when the token carries no expiry. */
  expired?: boolean | undefined;
  state?: unknown;
  /** ID-token claims (scope `openid profile email`). */
  profile?: { name?: string; preferred_username?: string; email?: string };
}

/** The subset of oidc-client-ts's `UserManager` the session drives (structurally satisfied). */
export interface SessionManager {
  getUser(): Promise<SessionUser | null>;
  signinRedirect(args?: { state?: unknown }): Promise<void>;
  signinCallback(url?: string): Promise<SessionUser | undefined | void>;
  signinSilent(): Promise<SessionUser | null>;
  signoutRedirect(): Promise<void>;
  removeUser(): Promise<void>;
  /** oidc-client-ts: stops the `automaticSilentRenew` timer. */
  stopSilentRenew?(): void;
  events: {
    addUserSignedOut(callback: () => void): (() => void) | unknown;
  };
}

export type StartOutcome =
  | { kind: 'ready' }
  | { kind: 'redirecting' }
  | { kind: 'offline_no_session' };

export type AuthLostReason = 'signed_out' | 'rejected';

export type SignOutResult =
  | { blocked: null; redirectFailed?: boolean }
  | { blocked: 'unsettled_outbox'; count: number };

export interface SignOutHooks {
  /** Rows in `edge_outbox` that would upload under the NEXT user's token if left behind. */
  countUnsettled(): Promise<number>;
  /** Drop `cached_user_context` so the next user never inherits this identity. */
  clearCachedUser(): Promise<void>;
}

export interface SessionOptions {
  config: AuthConfig;
  /** Required in `oidc` mode; ignored in `local` mode. */
  manager?: SessionManager;
  isOnline?: () => boolean;
}

export const CALLBACK_PATH = '/auth/callback';
const DEV_TOKEN_PATH = '/api/v1/auth/dev-token';

function defaultIsOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

/**
 * Only a same-origin path may be used as a post-login return target (no open redirect), and the
 * callback route itself is never a valid destination.
 */
export function safeReturnPath(candidate: unknown): string {
  if (typeof candidate !== 'string') return '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  if (candidate === CALLBACK_PATH || /^\/auth\/callback[/?#]/.test(candidate)) return '/';
  return candidate;
}

export class EdgeSession {
  private readonly config: AuthConfig;
  private readonly manager: SessionManager | null;
  private readonly isOnline: () => boolean;
  private readonly authLostListeners = new Set<(reason: AuthLostReason) => void>();
  private devToken: string | null = null;
  private inFlightRefresh: Promise<boolean> | null = null;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(options: SessionOptions) {
    this.config = options.config;
    this.isOnline = options.isOnline ?? defaultIsOnline;
    if (options.config.mode === 'oidc') {
      if (!options.manager) throw new Error('oidc mode requires a session manager');
      this.manager = options.manager;
      // A failed background silent renew is deliberately NOT an auth loss (review decision 2,
      // AC5): a network blip must not throw a technician onto the login page mid-form. The token
      // is only given up on when the API rejects it (`authorizedFetch`, which refreshes once).
      const unsubscribe = this.manager.events.addUserSignedOut(() => this.emitAuthLost('signed_out'));
      if (typeof unsubscribe === 'function') this.unsubscribers.push(unsubscribe as () => void);
    } else {
      this.manager = null;
    }
  }

  /** Stop the renew timer and event subscriptions (component unmount, StrictMode re-run). */
  dispose(): void {
    this.manager?.stopSilentRenew?.();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.authLostListeners.clear();
  }

  get mode(): AuthConfig['mode'] {
    return this.config.mode;
  }

  async ensureSignedIn(returnTo: string): Promise<StartOutcome> {
    if (this.config.mode === 'local') {
      await this.takeDevToken(this.config.devSubject);
      return { kind: 'ready' };
    }
    const manager = this.requireManager();
    const user = await manager.getUser();
    if (user && user.expired !== true) return { kind: 'ready' };
    if (!this.isOnline()) {
      return user ? { kind: 'ready' } : { kind: 'offline_no_session' };
    }
    if (user && (await this.refresh())) return { kind: 'ready' };
    await this.requestSignIn(returnTo);
    return { kind: 'redirecting' };
  }

  /** Redirect to the IdP login page, remembering the screen to come back to. Online only. */
  async requestSignIn(returnTo: string): Promise<void> {
    await this.requireManager().signinRedirect({ state: { returnTo: safeReturnPath(returnTo) } });
  }

  async getAccessToken(): Promise<string | null> {
    if (!this.manager) return this.devToken;
    const user = await this.manager.getUser();
    return user?.access_token ?? null;
  }

  /**
   * Who the identity provider says is signed in, for the header when the API has not confirmed a
   * user (bootstrap refused the account's site). Null in local mode or with no user.
   */
  async getDisplayName(): Promise<string | null> {
    if (!this.manager) return null;
    const profile = (await this.manager.getUser())?.profile;
    return profile?.name || profile?.preferred_username || profile?.email || null;
  }

  /**
   * One refresh-token grant, shared by every concurrent caller. Resolves true when a user came
   * back. Never throws: the callers (start rules, `authorizedFetch`) decide what a false means.
   */
  refresh(): Promise<boolean> {
    if (!this.manager) return Promise.resolve(false);
    if (!this.inFlightRefresh) {
      const manager = this.manager;
      this.inFlightRefresh = manager
        .signinSilent()
        .then((user) => user !== null)
        .catch(() => false)
        .finally(() => {
          this.inFlightRefresh = null;
        });
    }
    return this.inFlightRefresh;
  }

  /** Complete the authorization-code exchange on `/auth/callback`. */
  async handleCallback(url?: string): Promise<{ returnTo: string }> {
    const user = await this.requireManager().signinCallback(url);
    const state = user && typeof user === 'object' ? (user.state as { returnTo?: unknown } | undefined) : undefined;
    return { returnTo: safeReturnPath(state?.returnTo) };
  }

  /**
   * Shared-tablet sign-out (AC4). The server pins every uploaded event's actor to the bearer
   * identity (`src/api/v1/edge.ts`), so captures still waiting to upload would be attributed to
   * whoever signs in next. Sign-out is therefore refused while any unsettled row remains; the
   * caller shows the count and, when online, drains first.
   *
   * `signoutRedirect` runs BEFORE the stored user is dropped: it reads the id token for
   * `id_token_hint`, without which Keycloak shows a logout confirmation page instead of ending the
   * session, and a tablet left on that page would sign the next person in as this one. The library
   * removes the user itself; the explicit `removeUser` afterwards (and on failure) guarantees the
   * tokens are gone from the device either way.
   */
  async signOut(hooks: SignOutHooks): Promise<SignOutResult> {
    const count = await hooks.countUnsettled();
    if (count > 0) return { blocked: 'unsettled_outbox', count };
    await hooks.clearCachedUser();
    if (!this.manager) {
      this.devToken = null;
      return { blocked: null };
    }
    try {
      await this.manager.signoutRedirect();
    } catch {
      await this.manager.removeUser().catch(() => undefined);
      return { blocked: null, redirectFailed: true };
    }
    await this.manager.removeUser().catch(() => undefined);
    return { blocked: null };
  }

  onAuthLost(listener: (reason: AuthLostReason) => void): () => void {
    this.authLostListeners.add(listener);
    return () => this.authLostListeners.delete(listener);
  }

  /** Raised by `authorizedFetch` when the API still says 401 after a refresh. */
  notifyRejected(): void {
    this.emitAuthLost('rejected');
  }

  private emitAuthLost(reason: AuthLostReason): void {
    for (const listener of this.authLostListeners) listener(reason);
  }

  private requireManager(): SessionManager {
    if (!this.manager) throw new Error('not an oidc session');
    return this.manager;
  }

  private async takeDevToken(subject: string | null): Promise<void> {
    this.devToken = null;
    if (!subject) return;
    try {
      const response = await fetch(DEV_TOKEN_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub: subject }),
      });
      if (!response.ok) return;
      const body = (await response.json()) as { token?: unknown };
      if (typeof body.token === 'string') this.devToken = body.token;
    } catch {
      // No API in this environment (next dev without the server, Playwright): run without a token.
    }
  }
}

// --- Active session registry -------------------------------------------------------------------
// The PowerSync connector and `authorizedFetch` are not React; they reach the session through
// this registry. Nothing is registered under node:test, so those code paths send no header.

let activeSession: EdgeSession | null = null;

export function setActiveSession(session: EdgeSession | null): void {
  activeSession = session;
}

export function getActiveSession(): EdgeSession | null {
  return activeSession;
}

// --- Browser factory ---------------------------------------------------------------------------

/**
 * Build the real session in the browser. oidc-client-ts is imported lazily so the module can be
 * loaded (and unit-tested) under Node and during Next.js server rendering.
 *
 * Settings rationale (see the story's Dev Notes):
 * - `userStore` and `stateStore` in `localStorage`: an installed PWA loses `sessionStorage` when
 *   closed, and the PKCE verifier must survive the external login redirect.
 * - `automaticSilentRenew` with no `silent_redirect_uri` and `monitorSession: false`: renewal goes
 *   through the refresh-token grant, never an iframe (both this app and Keycloak deny framing).
 * - no `offline_access`: offline tokens would outlive the realm's SSO idle timeout.
 */
export async function createBrowserSession(config: AuthConfig): Promise<EdgeSession> {
  if (config.mode === 'local' || typeof window === 'undefined') {
    return new EdgeSession({ config: config.mode === 'local' ? config : { mode: 'local', devSubject: null } });
  }
  const { UserManager, WebStorageStateStore } = await import('oidc-client-ts');
  const origin = window.location.origin;
  const manager = new UserManager({
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: 'code',
    scope: 'openid profile email',
    automaticSilentRenew: true,
    monitorSession: false,
    revokeTokensOnSignout: false,
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    stateStore: new WebStorageStateStore({ store: window.localStorage }),
  });
  return new EdgeSession({ config, manager });
}
