import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { getPool } from '../../config/db.js';
import {
  RD_CHECKLIST_CRITERIA,
  getRdProjectChecklist,
  upsertRdProjectChecklistCriterion,
  setRdProjectCapitalizationEffectiveDate,
  getRdProjectCapitalizationDates,
} from '../../read/projections/rd_project_checklist.js';

/**
 * Story 10.1 (FR-RD-03): R&D project master. shortcut: written straight to the rd_project
 * projection (no domain event), upgrade when project changes must replay or sync offline.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const COLUMNS = 'project_code, owner_user_id, phase, budget_amount, status, created_at, updated_at';

const createBase: RouteHandler = async (req, res) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const code =
    typeof body['project_code'] === 'string' ? body['project_code'].trim().toUpperCase() : '';
  const owner = body['owner_user_id'] ?? getAuthContext(req)?.userId;
  const status = body['status'] ?? 'active';
  const budget = body['budget_amount'];
  const bad = (m: string) => sendRequestError(req, res, 400, 'INVALID_PARAMS', m);
  if (!CODE_REGEX.test(code)) return bad('project_code must match [A-Z0-9][A-Z0-9_-]{1,31}');
  if (typeof owner !== 'string' || !UUID_REGEX.test(owner))
    return bad('owner_user_id must be a UUID');
  if (body['phase'] !== 'research' && body['phase'] !== 'development') {
    return bad('phase must be research or development');
  }
  if (
    typeof budget !== 'number' ||
    !Number.isFinite(budget) ||
    budget < 0 ||
    budget >= 1e16 ||
    Math.abs(Math.round(budget * 100) - budget * 100) > 1e-6
  ) {
    return bad('budget_amount must be a number >= 0 and < 1e16 with at most 2 decimal places');
  }
  if (status !== 'active' && status !== 'on_hold' && status !== 'closed') {
    return bad('status must be active, on_hold or closed');
  }
  const inserted = await getPool().query(
    `INSERT INTO rd_project (project_code, owner_user_id, phase, budget_amount, status)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_code) DO NOTHING RETURNING ${COLUMNS}`,
    [code, owner, body['phase'], budget, status],
  );
  if (inserted.rows.length === 0) {
    sendRequestError(req, res, 409, 'PROJECT_CODE_EXISTS', 'Project code already exists', {
      project_code: code,
    });
    return;
  }
  sendJson(res, 201, inserted.rows[0]);
};

const listBase: RouteHandler = async (_req, res) => {
  const r = await getPool().query(`SELECT ${COLUMNS} FROM rd_project ORDER BY project_code`);
  sendJson(res, 200, { projects: r.rows });
};

const getBase: RouteHandler = async (req, res, params) => {
  const r = await getPool().query(`SELECT ${COLUMNS} FROM rd_project WHERE project_code = $1`, [
    (params?.['projectCode'] ?? '').trim().toUpperCase(),
  ]);
  if (r.rows.length === 0) {
    sendRequestError(req, res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    return;
  }
  sendJson(res, 200, r.rows[0]);
};

export const createRdProjectHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(createBase);
export const listRdProjectsHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  listBase,
);
export const getRdProjectHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  getBase,
);

/**
 * Story 10.2 (FR-AC-03/06): sets the six Ind AS 38 development-capitalization criteria. The
 * effective date is derived server-side and set forward-only once all six are met; any attempt to
 * supply a capitalization_effective_date is refused with RETROACTIVE_REINSTATEMENT_BLOCKED.
 */
const setChecklistBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const code = (params?.['projectCode'] ?? '').trim().toUpperCase();
  const bad = (m: string) => sendRequestError(req, res, 400, 'INVALID_PARAMS', m);

  if (body['capitalization_effective_date'] !== undefined && body['capitalization_effective_date'] !== null) {
    sendRequestError(req, res, 409, 'RETROACTIVE_REINSTATEMENT_BLOCKED', 'capitalization_effective_date is derived server-side and cannot be supplied', {
      project_code: code,
    });
    return;
  }

  const rawCriteria = body['criteria'];
  if (!rawCriteria || typeof rawCriteria !== 'object' || Array.isArray(rawCriteria)) {
    return bad('criteria must be an object mapping criterion codes to booleans');
  }
  const entries = Object.entries(rawCriteria as Record<string, unknown>);
  if (entries.length === 0) return bad('criteria must contain at least one criterion');
  for (const [criterion, met] of entries) {
    if (!(RD_CHECKLIST_CRITERIA as readonly string[]).includes(criterion)) {
      return bad(`unknown criterion code: ${criterion}`);
    }
    if (typeof met !== 'boolean') return bad(`criterion ${criterion} must be a boolean`);
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const project = await client.query(
      `SELECT status FROM rd_project WHERE project_code = $1 FOR UPDATE`,
      [code],
    );
    if (project.rows.length === 0) {
      await client.query('ROLLBACK');
      sendRequestError(req, res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      return;
    }
    if (project.rows[0]!['status'] !== 'active') {
      await client.query('ROLLBACK');
      sendRequestError(req, res, 409, 'PROJECT_CODE_REQUIRED', 'Only an active project can hold a checklist');
      return;
    }
    for (const [criterion, met] of entries) {
      await upsertRdProjectChecklistCriterion(code, criterion as (typeof RD_CHECKLIST_CRITERIA)[number], met as boolean, client);
    }
    const checklist = await getRdProjectChecklist(code, client);
    if (checklist.length === 6 && checklist.every((c) => c.met)) {
      await setRdProjectCapitalizationEffectiveDate(code, client);
    }
    const dates = await getRdProjectCapitalizationDates(code, client);
    await client.query('COMMIT');
    sendJson(res, 200, {
      project_code: code,
      criteria: checklist,
      capitalization_effective_date: dates.capitalization_effective_date,
      capitalization_effective_date_ist: dates.capitalization_effective_date_ist,
    });
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  } finally {
    client.release();
  }
};

export const setRdProjectChecklistHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(setChecklistBase);
