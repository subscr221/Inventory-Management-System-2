import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { authorizedFetch } from '../../src/session/api-fetch';
import { EdgeSession, setActiveSession, type SessionManager, type SessionUser } from '../../src/session/session';

interface Seen {
  url: string;
  authorization: string | null;
  method: string;
  contentType: string | null;
}

function recordFetch(t: TestContext, responder: (call: number) => Response): Seen[] {
  const seen: Seen[] = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      authorization: headers.get('authorization'),
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type'),
    });
    calls += 1;
    return responder(calls);
  });
  return seen;
}

class TokenManager implements SessionManager {
  calls: string[] = [];
  constructor(
    private user: SessionUser | null,
    private readonly renewed: SessionUser | null,
  ) {}
  async getUser() {
    return this.user;
  }
  async signinRedirect() {
    this.calls.push('signinRedirect');
  }
  async signinCallback() {
    return undefined;
  }
  async signinSilent() {
    this.calls.push('signinSilent');
    if (this.renewed) this.user = this.renewed;
    return this.renewed;
  }
  async signoutRedirect() {}
  async removeUser() {
    this.user = null;
  }
  events = { addUserSignedOut: () => undefined };
}

const OIDC = { mode: 'oidc' as const, authority: 'https://a/realms/ims', clientId: 'ims-app' };

describe('Story 1.12 authorizedFetch', () => {
  it('sends the request untouched when no session is active (node:test, Playwright)', async (t) => {
    setActiveSession(null);
    const seen = recordFetch(t, () => new Response(null, { status: 201 }));
    const response = await authorizedFetch('/api/v1/edge/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 201);
    assert.deepEqual(seen, [
      { url: '/api/v1/edge/events', authorization: null, method: 'POST', contentType: 'application/json' },
    ]);
  });

  it('adds Authorization: Bearer and keeps the caller headers (AC2)', async (t) => {
    setActiveSession(new EdgeSession({ config: OIDC, manager: new TokenManager({ access_token: 'tok' }, null) }));
    try {
      const seen = recordFetch(t, () => Response.json({ endpoint: 'e', token: 'p' }));
      await authorizedFetch('/api/v1/edge/powersync-credentials', { credentials: 'include' });
      assert.deepEqual(seen, [
        { url: '/api/v1/edge/powersync-credentials', authorization: 'Bearer tok', method: 'GET', contentType: null },
      ]);
    } finally {
      setActiveSession(null);
    }
  });

  it('on 401 with a token: refreshes once, retries with the new token, and returns the retry', async (t) => {
    const manager = new TokenManager({ access_token: 'old' }, { access_token: 'new' });
    const session = new EdgeSession({ config: OIDC, manager });
    let lost = 0;
    session.onAuthLost(() => {
      lost += 1;
    });
    setActiveSession(session);
    try {
      const seen = recordFetch(t, (call) =>
        call === 1
          ? Response.json({ error_code: 'UNAUTHORIZED' }, { status: 401 })
          : Response.json({ user_id: 'u' }, { status: 200 }),
      );
      const response = await authorizedFetch('/api/v1/edge/bootstrap');
      assert.equal(response.status, 200);
      assert.deepEqual(
        seen.map((s) => s.authorization),
        ['Bearer old', 'Bearer new'],
      );
      assert.deepEqual(manager.calls, ['signinSilent']);
      assert.equal(lost, 0);
    } finally {
      setActiveSession(null);
    }
  });

  it('on 401 twice: reports auth lost and returns the second 401 unchanged (no redirect here)', async (t) => {
    const manager = new TokenManager({ access_token: 'old' }, { access_token: 'new' });
    const session = new EdgeSession({ config: OIDC, manager });
    const reasons: string[] = [];
    session.onAuthLost((reason) => reasons.push(reason));
    setActiveSession(session);
    try {
      const seen = recordFetch(t, () => Response.json({ error_code: 'UNAUTHORIZED' }, { status: 401 }));
      const response = await authorizedFetch('/api/v1/edge/bootstrap');
      assert.equal(response.status, 401);
      assert.equal(seen.length, 2);
      assert.deepEqual(reasons, ['rejected']);
      assert.deepEqual(manager.calls, ['signinSilent']);
    } finally {
      setActiveSession(null);
    }
  });

  it('on 401 when the refresh itself fails: reports auth lost without a retry', async (t) => {
    const manager = new TokenManager({ access_token: 'old' }, null);
    const session = new EdgeSession({ config: OIDC, manager });
    const reasons: string[] = [];
    session.onAuthLost((reason) => reasons.push(reason));
    setActiveSession(session);
    try {
      const seen = recordFetch(t, () => Response.json({ error_code: 'UNAUTHORIZED' }, { status: 401 }));
      const response = await authorizedFetch('/api/v1/edge/bootstrap');
      assert.equal(response.status, 401);
      assert.equal(seen.length, 1);
      assert.deepEqual(reasons, ['rejected']);
    } finally {
      setActiveSession(null);
    }
  });

  it('reports auth lost instead of retrying without a bearer when a refresh yields no token', async (t) => {
    const manager = new TokenManager({ access_token: 'old' }, { access_token: 'new' });
    manager.getUser = async () => (manager.calls.includes('signinSilent') ? null : { access_token: 'old' });
    const session = new EdgeSession({ config: OIDC, manager });
    const reasons: string[] = [];
    session.onAuthLost((reason) => reasons.push(reason));
    setActiveSession(session);
    try {
      const seen = recordFetch(t, () => Response.json({ error_code: 'UNAUTHORIZED' }, { status: 401 }));
      const response = await authorizedFetch('/api/v1/edge/bootstrap');
      assert.equal(response.status, 401);
      assert.equal(seen.length, 1);
      assert.deepEqual(reasons, ['rejected']);
    } finally {
      setActiveSession(null);
    }
  });

  it('replays a Request with a body on the retry', async (t) => {
    const manager = new TokenManager({ access_token: 'old' }, { access_token: 'new' });
    setActiveSession(new EdgeSession({ config: OIDC, manager }));
    try {
      const bodies: string[] = [];
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        calls += 1;
        bodies.push(await (input as Request).text());
        return calls === 1 ? new Response(null, { status: 401 }) : new Response(null, { status: 201 });
      });
      const request = new Request('http://edge/api/v1/edge/events', { method: 'POST', body: '{"a":1}' });
      const response = await authorizedFetch(request);
      assert.equal(response.status, 201);
      assert.deepEqual(bodies, ['{"a":1}', '{"a":1}']);
    } finally {
      setActiveSession(null);
    }
  });

  it('passes 403 and other failures through untouched (authorization is not authentication)', async (t) => {
    const manager = new TokenManager({ access_token: 'tok' }, { access_token: 'new' });
    const session = new EdgeSession({ config: OIDC, manager });
    let lost = 0;
    session.onAuthLost(() => {
      lost += 1;
    });
    setActiveSession(session);
    try {
      const seen = recordFetch(t, () => Response.json({ error_code: 'EDGE_NO_CONCRETE_SITE' }, { status: 403 }));
      const response = await authorizedFetch('/api/v1/edge/bootstrap');
      assert.equal(response.status, 403);
      assert.equal(seen.length, 1);
      assert.deepEqual(manager.calls, []);
      assert.equal(lost, 0);
    } finally {
      setActiveSession(null);
    }
  });

  it('does not treat a 401 as a session problem when no token was sent', async (t) => {
    setActiveSession(new EdgeSession({ config: { mode: 'local', devSubject: null } }));
    try {
      const seen = recordFetch(t, () => Response.json({ error_code: 'UNAUTHORIZED' }, { status: 401 }));
      const response = await authorizedFetch('/api/v1/edge/bootstrap');
      assert.equal(response.status, 401);
      assert.equal(seen.length, 1);
    } finally {
      setActiveSession(null);
    }
  });
});
