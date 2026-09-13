import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { subjectFromPayload } from '../../src/middleware/auth.js';

/**
 * AUTH_SUBJECT_CLAIM (round table 2026-09-13): the staging Keycloak identifies people by email,
 * so the directory record is looked up by the token's email claim, lower-cased, instead of the
 * opaque sub. Default behaviour (sub, verbatim) is pinned alongside.
 */
describe('subjectFromPayload', () => {
  it('reads sub verbatim by default', () => {
    assert.equal(subjectFromPayload({ sub: 'AbC-123', email: 'x@y.z' }, 'sub'), 'AbC-123');
  });

  it('reads the email claim lower-cased and trimmed when selected', () => {
    assert.equal(
      subjectFromPayload({ sub: 'AbC-123', email: ' Priya.Nair@AncorLabs.org ' }, 'email'),
      'priya.nair@ancorlabs.org',
    );
  });

  it('yields undefined for a missing, blank or non-string claim so the caller answers 401', () => {
    assert.equal(subjectFromPayload({ sub: 'x' }, 'email'), undefined);
    assert.equal(subjectFromPayload({ email: '   ' }, 'email'), undefined);
    assert.equal(subjectFromPayload({ email: 42 }, 'email'), undefined);
  });
});
