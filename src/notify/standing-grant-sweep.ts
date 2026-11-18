import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config/index.js';
import { getPool } from '../config/db.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { persistEvent } from '../events/store.js';
import { emitNotificationInTransaction } from './emit.js';
import {
  getGrantById,
  getGrantLabel,
  getPruneSetting,
  issuedBetween,
  lastIssueAt,
  lastLimitUseAt,
  listActiveGrantsPastEnd,
  stampPruneSent,
  type StandingGrantRow,
} from '../read/projections/standing_grant.js';
import {
  findActiveDelegation,
  findRoleHolder,
  listActiveDoaEntries,
} from '../read/projections/doa_registry.js';
import {
  STANDING_GRANT_FINANCE_DOA_TYPE,
  STANDING_GRANT_SYSTEM_ACTOR_ID,
} from '../compliance/standing-grant.js';

/**
 * Story 4.8 (D13, AC 6): the daily standing-grant sweep. One pass, one transaction, one advisory
 * lock, per-item SAVEPOINT isolation (the Story 9.5 return-clock sweep idiom):
 *
 *   1. grants past their end date are expired through the standing_grant.expired event;
 *   2. every assigner whose pruning interval has run (default 30 days, set per assigner) receives
 *      notifications listing all their live grants, up to 50 per notification - in_app and web_push
 *      (email is a recorded pilot gap) - each with last-period issued quantity and a "consider
 *      revoking" flag when it has not
 *      been used for 90 days. A grant whose assigner's account is disabled moves to the finance
 *      approver's list (D12), so a live grant never loses its reviewer.
 *
 * `now` is the one clock input: tests pass it to move the calendar without waiting real time.
 */

// 9505 is the job-work return-clock sweep and 9506 the job-work billing sweep; 8707 is the BIS
// licence sweep. The next unused key after grepping LOCK_KEY across src.
const STANDING_GRANT_SWEEP_LOCK_KEY = 9507;

const SYSTEM_ACTOR = {
  user_id: STANDING_GRANT_SYSTEM_ACTOR_ID,
  role: 'system_standing_grant_sweep',
  location_id: STANDING_GRANT_SYSTEM_ACTOR_ID,
};

/** Bound each notification's grant count without omitting any grants from the review. */
const MAX_LISTED_GRANTS = 50;
const MS_PER_DAY = 86_400_000;

export interface StandingGrantSweepResult {
  /** Grants flipped to expired in this tick. */
  expired: number;
  /** Complete pruning reviews sent (one per due recipient, possibly multiple notifications). */
  listsSent: number;
  /** Items whose work failed and was rolled back to its savepoint (retried next tick). */
  failed: number;
  /** True when the tick itself could not run (connection or transaction failure). */
  cycleFailed: boolean;
  /** True when another instance held the sweep lock and this tick did no work. */
  skippedLocked: boolean;
}

/** Whole IST calendar days from `fromIso` to `today` (both reduced to their IST date first). */
function istDaysBetween(fromIso: string, today: string): number {
  const from = toIstCalendarDate(new Date(fromIso));
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY,
  );
}

/** The finance approver a disabled assigner's list moves to: a holder of the finance role at the site. */
async function financeRecipientFor(
  siteId: string,
  today: string,
  client: PoolClient,
): Promise<string | null> {
  for (const entry of await listActiveDoaEntries(STANDING_GRANT_FINANCE_DOA_TYPE, client)) {
    const holder = await findRoleHolder(entry.role, client, siteId);
    if (!holder) continue;
    const delegation = await findActiveDelegation(holder.user_id, today, client);
    return delegation?.delegate_user_id ?? holder.user_id;
  }
  return null;
}

interface ListedGrant {
  considerRevoking: boolean;
  text: string;
}

async function describeGrant(
  grant: StandingGrantRow,
  now: string,
  today: string,
  sinceIso: string,
  client: PoolClient,
): Promise<ListedGrant> {
  const label = await getGrantLabel(grant, client);
  const lastUsed =
    grant.grant_kind === 'standing_approval'
      ? await lastIssueAt(grant.grant_id, client)
      : await lastLimitUseAt(grant.grant_id, client);
  // Unused for N days counts from the last use, or from activation for a grant never used.
  const baseline = lastUsed ?? grant.finance_decided_at ?? grant.created_at;
  const consider = istDaysBetween(baseline, today) >= config.standingGrant.unusedFlagDays;
  const parts: string[] = [grant.grant_ref, label.grantee_name];
  if (grant.grant_kind === 'standing_approval') {
    parts.push(label.scope_label);
    parts.push(grant.monthly_qty_cap !== null ? `cap ${grant.monthly_qty_cap} a month` : 'no cap');
    parts.push(`issued last period ${await issuedBetween(grant.grant_id, sinceIso, now, client)}`);
  } else {
    parts.push(`self-approval limit Rs ${grant.limit_amount}`);
  }
  parts.push(`last used ${lastUsed ? toIstCalendarDate(new Date(lastUsed)) : 'never'}`);
  if (grant.end_date) parts.push(`ends ${grant.end_date}`);
  if (consider)
    parts.push(`consider revoking (unused ${config.standingGrant.unusedFlagDays}+ days)`);
  return { considerRevoking: consider, text: parts.join(' | ') };
}

export async function runStandingGrantSweepCycle(
  opts: { now?: string } = {},
): Promise<StandingGrantSweepResult> {
  const result: StandingGrantSweepResult = {
    expired: 0,
    listsSent: 0,
    failed: 0,
    cycleFailed: false,
    skippedLocked: false,
  };
  let client: PoolClient;
  try {
    client = await getPool().connect();
  } catch (err) {
    console.error('standing grant sweep: could not connect', err);
    return { ...result, cycleFailed: true };
  }
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [
      STANDING_GRANT_SWEEP_LOCK_KEY,
    ]);
    if (!(lock.rows[0] as { acquired: boolean }).acquired) {
      await client.query('ROLLBACK');
      return { ...result, skippedLocked: true };
    }
    const now = opts.now ?? new Date().toISOString();
    const today = toIstCalendarDate(new Date(now));
    const correlationId = randomUUID();

    // 1. Expiry. The seam re-checks status and end date under the row lock.
    for (const grant of await listActiveGrantsPastEnd(
      today,
      config.standingGrant.sweepBatchSize,
      client,
    )) {
      await client.query('SAVEPOINT standing_grant_expiry');
      try {
        await persistEvent(
          {
            stream_type: 'standing_grant',
            stream_id: grant.grant_id,
            event_type: 'standing_grant.expired',
            event_id: randomUUID(),
            payload: { grant_id: grant.grant_id },
            metadata: { correlation_id: correlationId, actor: SYSTEM_ACTOR, occurred_at: now },
          },
          undefined,
          client,
        );
        await client.query('RELEASE SAVEPOINT standing_grant_expiry');
        result.expired += 1;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT standing_grant_expiry');
        console.error(`standing grant sweep: expiry of ${grant.grant_ref} failed`, err);
        result.failed += 1;
      }
    }

    // 2. Pruning lists, grouped by recipient. Read after the expiry so an expired grant is not listed.
    const live = await client.query(
      `SELECT grant_id FROM standing_grant WHERE status = 'active' ORDER BY created_at ASC, grant_id ASC`,
    );
    const byRecipient = new Map<string, StandingGrantRow[]>();
    const activeAssigners = new Map<string, boolean>();
    for (const row of live.rows as Array<{ grant_id: string }>) {
      const grant = await getGrantById(row.grant_id, client);
      if (!grant) continue;
      let assignerActive = activeAssigners.get(grant.assigner_user_id);
      if (assignerActive === undefined) {
        const u = await client.query(`SELECT active FROM users WHERE user_id = $1`, [
          grant.assigner_user_id,
        ]);
        assignerActive = (u.rows[0] as { active?: boolean } | undefined)?.active === true;
        activeAssigners.set(grant.assigner_user_id, assignerActive);
      }
      const recipient = assignerActive
        ? grant.assigner_user_id
        : await financeRecipientFor(grant.site_id, today, client);
      if (!recipient) continue;
      const bucket = byRecipient.get(recipient) ?? [];
      bucket.push(grant);
      byRecipient.set(recipient, bucket);
    }

    for (const [recipient, grants] of byRecipient) {
      const setting = await getPruneSetting(recipient, client);
      const due =
        setting.last_prune_sent_at === null ||
        istDaysBetween(setting.last_prune_sent_at, today) >= setting.prune_interval_days;
      if (!due) continue;
      await client.query('SAVEPOINT standing_grant_prune');
      try {
        const sinceIso =
          setting.last_prune_sent_at ??
          new Date(Date.parse(now) - setting.prune_interval_days * MS_PER_DAY).toISOString();
        const listed: ListedGrant[] = [];
        for (const grant of grants) {
          listed.push(await describeGrant(grant, now, today, sinceIso, client));
        }
        const flagged = listed.filter((l) => l.considerRevoking).length;
        const header = `${grants.length} live standing approval${grants.length === 1 ? '' : 's'} and limits${flagged > 0 ? `, ${flagged} to consider revoking` : ''}`;
        const chunkCount = Math.ceil(listed.length / MAX_LISTED_GRANTS);
        for (let offset = 0; offset < listed.length; offset += MAX_LISTED_GRANTS) {
          const chunk = listed.slice(offset, offset + MAX_LISTED_GRANTS);
          // Each emission gets its own source event, the dispatcher's dedupe identity.
          await emitNotificationInTransaction(
            {
              target: { role: 'standing_grant_assigner', user_id: recipient },
              event_type: 'standing_grant_review',
              status_verb: 'review due',
              object_type: 'standing_grant_list',
              object_id: recipient,
              actor_label:
                chunkCount === 1
                  ? header
                  : `${header} (part ${offset / MAX_LISTED_GRANTS + 1} of ${chunkCount})`,
              next_step: `${chunk.map((l) => l.text).join('; ')}. Revoke any you no longer need.`,
              actor: SYSTEM_ACTOR,
              correlation_id: correlationId,
              occurred_at: now,
            },
            client,
          );
        }
        await stampPruneSent(recipient, now, client);
        await client.query('RELEASE SAVEPOINT standing_grant_prune');
        result.listsSent += 1;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT standing_grant_prune');
        console.error(`standing grant sweep: pruning list for ${recipient} failed`, err);
        result.failed += 1;
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('standing grant sweep: cycle failed', err);
    return { ...result, cycleFailed: true };
  } finally {
    client.release();
  }
}
