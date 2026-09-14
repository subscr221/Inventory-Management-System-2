import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_CONFIG_STORAGE_KEY,
  AuthConfigUnavailableError,
  loadAuthConfig,
  parseAuthConfig,
  readServerAuthConfig,
  type StorageLike,
} from '../../src/session/auth-config';

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe('Story 1.12 auth config: server side (readServerAuthConfig)', () => {
  it('defaults to local mode with no subject when EDGE_AUTH_MODE is unset (Playwright, next dev)', () => {
    assert.deepEqual(readServerAuthConfig({}), { mode: 'local', dev_subject: null });
  });

  it('carries the dev subject in local mode', () => {
    assert.deepEqual(readServerAuthConfig({ EDGE_AUTH_MODE: 'local', EDGE_DEV_SUBJECT: 'raman' }), {
      mode: 'local',
      dev_subject: 'raman',
    });
  });

  it('returns the oidc wire shape when authority and client id are set', () => {
    assert.deepEqual(
      readServerAuthConfig({
        EDGE_AUTH_MODE: 'oidc',
        EDGE_OIDC_AUTHORITY: 'https://auth.example.org/realms/ims',
        EDGE_OIDC_CLIENT_ID: 'ims-app',
      }),
      { mode: 'oidc', authority: 'https://auth.example.org/realms/ims', client_id: 'ims-app' },
    );
  });

  it('fails closed (null) in oidc mode when authority or client id is missing', () => {
    assert.equal(readServerAuthConfig({ EDGE_AUTH_MODE: 'oidc' }), null);
    assert.equal(
      readServerAuthConfig({ EDGE_AUTH_MODE: 'oidc', EDGE_OIDC_AUTHORITY: 'https://a' }),
      null,
    );
    assert.equal(readServerAuthConfig({ EDGE_AUTH_MODE: 'oidc', EDGE_OIDC_CLIENT_ID: 'x' }), null);
  });

  it('fails closed on an unknown mode', () => {
    assert.equal(readServerAuthConfig({ EDGE_AUTH_MODE: 'cookie' }), null);
  });
});

describe('Story 1.12 auth config: parseAuthConfig', () => {
  it('rejects oidc without authority or client id', () => {
    assert.throws(() => parseAuthConfig({ mode: 'oidc', authority: 'https://a' }));
    assert.throws(() => parseAuthConfig({ mode: 'oidc', client_id: 'ims-app' }));
    assert.throws(() => parseAuthConfig({ mode: 'oidc', authority: '', client_id: 'ims-app' }));
  });

  it('accepts local without a subject', () => {
    assert.deepEqual(parseAuthConfig({ mode: 'local' }), { mode: 'local', devSubject: null });
    assert.deepEqual(parseAuthConfig({ mode: 'local', dev_subject: 'raman' }), {
      mode: 'local',
      devSubject: 'raman',
    });
  });

  it('rejects anything that is not one of the two modes', () => {
    assert.throws(() => parseAuthConfig(null));
    assert.throws(() => parseAuthConfig({ mode: 'implicit' }));
    assert.throws(() => parseAuthConfig('oidc'));
  });
});

describe('Story 1.12 auth config: loadAuthConfig', () => {
  it('fetches /auth/config, caches it, and returns the parsed config', async (t) => {
    const storage = new MemoryStorage();
    const calls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ mode: 'oidc', authority: 'https://a/realms/ims', client_id: 'ims-app' });
    });
    const config = await loadAuthConfig(storage);
    assert.deepEqual(config, { mode: 'oidc', authority: 'https://a/realms/ims', clientId: 'ims-app' });
    assert.deepEqual(calls, ['/auth/config']);
    assert.equal(
      storage.getItem(AUTH_CONFIG_STORAGE_KEY),
      JSON.stringify({ mode: 'oidc', authority: 'https://a/realms/ims', client_id: 'ims-app' }),
    );
  });

  it('falls back to the cached copy when the fetch fails (offline start)', async (t) => {
    const storage = new MemoryStorage();
    storage.setItem(
      AUTH_CONFIG_STORAGE_KEY,
      JSON.stringify({ mode: 'oidc', authority: 'https://a/realms/ims', client_id: 'ims-app' }),
    );
    t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const config = await loadAuthConfig(storage);
    assert.deepEqual(config, { mode: 'oidc', authority: 'https://a/realms/ims', clientId: 'ims-app' });
  });

  it('does not overwrite a good cached copy with a 500 (fail-closed server) and throws when nothing is cached', async (t) => {
    const storage = new MemoryStorage();
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ error_code: 'EDGE_AUTH_CONFIG_MISSING' }, { status: 500 }),
    );
    await assert.rejects(loadAuthConfig(storage), AuthConfigUnavailableError);
    assert.equal(storage.getItem(AUTH_CONFIG_STORAGE_KEY), null);
  });

  it('ignores a corrupt cached copy and throws when the network is also unavailable', async (t) => {
    const storage = new MemoryStorage();
    storage.setItem(AUTH_CONFIG_STORAGE_KEY, '{not json');
    t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await assert.rejects(loadAuthConfig(storage), AuthConfigUnavailableError);
  });
});
