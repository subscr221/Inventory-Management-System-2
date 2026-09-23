import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBootstrapRefusal } from '../../src/session/bootstrap-refusal';

const reply = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('classifyBootstrapRefusal', () => {
  it('a user with no concrete site assignment is told so, not asked to wait for a first sync', async () => {
    // Found by the simulated pilot 2026-09-23: accounts@ saw a placeholder gate officer instead.
    assert.equal(
      await classifyBootstrapRefusal(reply(403, { error_code: 'EDGE_NO_CONCRETE_SITE' })),
      'no_site',
    );
  });

  it('a user assigned to more than one site is told so', async () => {
    assert.equal(
      await classifyBootstrapRefusal(reply(409, { error_code: 'EDGE_AMBIGUOUS_SITE' })),
      'ambiguous_site',
    );
  });

  it('anything else (server down, other refusals, a non-JSON body) stays unavailable', async () => {
    assert.equal(await classifyBootstrapRefusal(reply(503, { error_code: 'X' })), 'unavailable');
    assert.equal(
      await classifyBootstrapRefusal(reply(403, { error_code: 'OTHER' })),
      'unavailable',
    );
    assert.equal(
      await classifyBootstrapRefusal(reply(502, '<html>bad gateway</html>')),
      'unavailable',
    );
  });
});
