import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyServerUploadFailure } from '../../src/sync/connector';

describe('edge upload failure classification', () => {
  it('treats duplicate conflicts as convergence', () => {
    assert.deepEqual(
      classifyServerUploadFailure(409, {
        error_code: 'DUPLICATE_EVENT',
        details: { existing_event_id: '11111111-1111-4111-8111-111111111111' },
      }),
      {
        action: 'complete',
        localStatus: 'synced',
        retryable: false,
        serverErrorCode: 'DUPLICATE_EVENT',
        existingEventId: '11111111-1111-4111-8111-111111111111',
      },
    );
  });

  it('separates permanent, auth, and retryable failures', () => {
    assert.equal(
      classifyServerUploadFailure(400, { error_code: 'UNTAGGED_TRANSACTION' }).localStatus,
      'needs_attention',
    );
    assert.equal(
      classifyServerUploadFailure(409, { error_code: 'STREAM_CONFLICT' }).localStatus,
      'needs_attention',
    );
    assert.equal(
      classifyServerUploadFailure(401, { error_code: 'UNAUTHORIZED' }).localStatus,
      'auth_required',
    );
    assert.equal(
      classifyServerUploadFailure(503, { error_code: 'INTERNAL_ERROR' }).retryable,
      true,
    );
  });
});
