import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import { getAuthContext, getParsedBody } from '../../middleware/context.js';
import { requireRole, EMPLOYEE_MODULE } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import { getPool } from '../../config/db.js';
import { actorContext, auditCtxFor } from './quality.js';
import { ATTACHMENT_STREAM_TYPE, ATTACHMENT_UPLOADED } from '../../compliance/damage.js';
import { mapDamageRow } from '../../read/projections/damage_report.js';
import { canSeeDamageReport } from './damage-reports.js';

// ---------------------------------------------------------------------------
// Story 8.9 (AC 7, D14): the photo store. A photo is uploaded as taken - the raw image is the
// request body, no base64 inflation, no photo-specific size cap - under a client-minted id, so an
// offline report never waits on or fails with its photo. The bytes live in the attachment table;
// the attachment.uploaded event carries metadata only and edit-logs the upload (AD-12).
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** The declared type must also be what the bytes are (magic numbers), else 415. */
function magicMatches(contentType: string, data: Buffer): boolean {
  switch (contentType) {
    case 'image/jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/png':
      return (
        data.length >= 8 &&
        data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    case 'image/webp':
      return (
        data.length >= 12 &&
        data.subarray(0, 4).toString('latin1') === 'RIFF' &&
        data.subarray(8, 12).toString('latin1') === 'WEBP'
      );
    case 'image/heic':
    case 'image/heif':
      return (
        data.length >= 12 &&
        data.subarray(4, 8).toString('latin1') === 'ftyp' &&
        HEIF_BRANDS.has(data.subarray(8, 12).toString('latin1'))
      );
    default:
      return false;
  }
}

function attachmentIdParam(params: Record<string, string> | undefined): string {
  const id = params?.['attachmentId'];
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new AppError(400, 'INVALID_PARAMS', 'attachmentId must be a UUID');
  }
  return id.toLowerCase();
}

interface StoredAttachment {
  attachment_id: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  uploaded_by: string;
}

function describe(row: StoredAttachment): Record<string, unknown> {
  return {
    attachment_id: row.attachment_id,
    content_type: row.content_type,
    byte_size: Number(row.byte_size),
    sha256: row.sha256,
  };
}

async function findAttachment(id: string): Promise<StoredAttachment | null> {
  const result = await getPool().query(
    `SELECT attachment_id, content_type, byte_size, sha256, uploaded_by FROM attachment WHERE attachment_id = $1`,
    [id],
  );
  return (result.rows[0] as StoredAttachment | undefined) ?? null;
}

const putAttachmentBase: RouteHandler = async (req, res, params) => {
  const attachmentId = attachmentIdParam(params);
  const body = getParsedBody(req);
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (!Buffer.isBuffer(body) || body.length === 0 || !magicMatches(contentType, body)) {
    throw new AppError(
      415,
      'ATTACHMENT_TYPE_INVALID',
      'The body must be a JPEG, PNG, WebP or HEIC/HEIF image, sent as raw bytes with its own Content-Type',
      { content_type: contentType || null },
    );
  }
  const sha256 = createHash('sha256').update(body).digest('hex');

  const existing = await findAttachment(attachmentId);
  if (existing) {
    if (existing.sha256 !== sha256) {
      throw new AppError(
        409,
        'ATTACHMENT_CONFLICT',
        'This attachment id already holds different bytes',
        { attachment_id: attachmentId },
      );
    }
    sendJson(res, 200, describe(existing));
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const client = await getPool().connect();
  let inserted = false;
  try {
    await client.query('BEGIN');
    const persisted = await persistEvent(
      {
        stream_type: ATTACHMENT_STREAM_TYPE,
        stream_id: attachmentId,
        event_type: ATTACHMENT_UPLOADED,
        payload: {
          attachment_id: attachmentId,
          content_type: contentType,
          byte_size: body.length,
          sha256,
        },
        metadata: {
          correlation_id: attachmentId,
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: `${ATTACHMENT_UPLOADED}:${attachmentId}`,
      },
      auditCtxFor(req, actor, 201),
      client,
    );
    const result = await client.query(
      `INSERT INTO attachment (attachment_id, content_type, byte_size, sha256, data, uploaded_by, uploaded_at, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (attachment_id) DO NOTHING`,
      [attachmentId, contentType, body.length, sha256, body, actor.userId, now, persisted.event_id],
    );
    inserted = (result.rowCount ?? 0) > 0;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const stored = await findAttachment(attachmentId);
  if (!stored) throw new AppError(500, 'INTERNAL_ERROR', 'The attachment was not stored');
  if (stored.sha256 !== sha256) {
    throw new AppError(
      409,
      'ATTACHMENT_CONFLICT',
      'This attachment id already holds different bytes',
      {
        attachment_id: attachmentId,
      },
    );
  }
  sendJson(res, inserted ? 201 : 200, describe(stored));
};

/**
 * D11: the uploader, or anyone who can read a damage case that references the photo. The bytes go
 * back with their stored type and are never cached by an intermediary.
 */
async function canReadAttachment(req: IncomingMessage, stored: StoredAttachment): Promise<boolean> {
  const authContext = getAuthContext(req);
  if (!authContext) return false;
  if (stored.uploaded_by === authContext.userId) return true;
  const cases = await getPool().query(
    `SELECT d.*, d.quantity::text AS quantity FROM damage_report d WHERE d.photo_attachment_id = $1`,
    [stored.attachment_id],
  );
  for (const row of cases.rows) {
    if (await canSeeDamageReport(authContext, mapDamageRow(row))) return true;
  }
  return false;
}

const getAttachmentBase: RouteHandler = async (req, res, params) => {
  const attachmentId = attachmentIdParam(params);
  const stored = await findAttachment(attachmentId);
  if (!stored) {
    throw new AppError(404, 'ATTACHMENT_NOT_FOUND', 'The attachment does not exist', {
      attachment_id: attachmentId,
    });
  }
  if (!(await canReadAttachment(req, stored))) {
    throw new AppError(403, 'FUNCTION_ACCESS_DENIED', 'This attachment is not visible to you', {
      attachment_id: attachmentId,
    });
  }
  const data = await getPool().query(`SELECT data FROM attachment WHERE attachment_id = $1`, [
    attachmentId,
  ]);
  const bytes = data.rows[0]!['data'] as Buffer;
  res.writeHead(200, {
    'Content-Type': stored.content_type,
    'Content-Length': bytes.length,
    'Cache-Control': 'private, no-store',
  });
  res.end(bytes);
};

export const putAttachmentHandler = requireRole({
  module: EMPLOYEE_MODULE,
  functionScope: 'write',
})(putAttachmentBase);

export const getAttachmentHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'qc', 'warehouse', 'compliance'],
  functionScope: 'read',
})(getAttachmentBase);
