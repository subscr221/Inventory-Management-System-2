'use client';

import { useCallback, useEffect, useState } from 'react';
import { errorMessage, t } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import {
  buildAssignBody,
  canRevoke,
  describeGrant,
  emptyAssignForm,
  isGrantRow,
  parsePruneDays,
  type AssignForm,
  type AssignReason,
  type GrantRow,
} from './standing-grants-model';

/**
 * Story 4.8: the standing grants screen, a base view of the app shell (same frame, cards and
 * buttons as My requests and Damage cases). Lists the grants I hold, the grants I assigned (revoke),
 * the grants waiting for my finance approval (approve, or reject with a reason), a form to assign a
 * grant, and my reminder interval. The server decides every right; a refusal is shown in plain
 * words. Online only, nothing is queued.
 */

type Section = 'held' | 'assigned' | 'pending';
const QUERY: Record<Section, string> = {
  held: 'held_by=me',
  assigned: 'assigned_by=me',
  pending: 'pending_finance=me',
};
type Lists = Record<Section, GrantRow[] | null>;

const REASON_KEY: Record<AssignReason, string> = {
  bad_grantee: 'standingGrants.badGrantee',
  bad_site: 'standingGrants.badSite',
  no_scope: 'standingGrants.noScope',
  bad_cap: 'standingGrants.badCap',
  bad_limit: 'standingGrants.badLimit',
  bad_end_date: 'standingGrants.badEndDate',
};

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_code?: unknown };
    return typeof body.error_code === 'string'
      ? errorMessage(body.error_code)
      : t('standingGrants.failed');
  } catch {
    return t('standingGrants.failed');
  }
}

export function StandingGrants({ online = true }: { online?: boolean }) {
  const [lists, setLists] = useState<Lists>({ held: null, assigned: null, pending: null });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState<AssignForm>(emptyAssignForm());
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [pruneDays, setPruneDays] = useState('30');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next: Lists = { held: [], assigned: [], pending: [] };
      for (const section of Object.keys(QUERY) as Section[]) {
        const response = await authorizedFetch(`/api/v1/standing-grants?${QUERY[section]}`);
        if (!response.ok) {
          setMessage(await readError(response));
          continue;
        }
        const body = (await response.json()) as { grants?: unknown };
        next[section] = Array.isArray(body.grants) ? body.grants.filter(isGrantRow) : [];
      }
      setLists(next);
    } catch {
      setMessage(t('standingGrants.offline'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!online) {
      setLoading(false);
      return;
    }
    void load();
    // Prefill the site from the device bootstrap; the field stays editable.
    void (async () => {
      try {
        const response = await authorizedFetch('/api/v1/edge/bootstrap');
        if (!response.ok) return;
        const body = (await response.json()) as { site_id?: unknown };
        if (typeof body.site_id === 'string') {
          const siteId = body.site_id;
          setForm((f) => (f.site_id === '' ? { ...f, site_id: siteId } : f));
        }
      } catch {
        /* the operator can type it */
      }
    })();
  }, [load, online]);

  const send = async (path: string, body: unknown, method = 'POST'): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setMessage('');
    try {
      const response = await authorizedFetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setMessage(await readError(response));
        return false;
      }
      setMessage(t('standingGrants.done'));
      await load();
      return true;
    } catch {
      setMessage(t('standingGrants.offline'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitAssign = async () => {
    const built = buildAssignBody(form);
    if (!built.ok) {
      setMessage(t(REASON_KEY[built.reason] as Parameters<typeof t>[0]));
      return;
    }
    if (await send('/api/v1/standing-grants', built.body)) {
      setForm(emptyAssignForm(form.site_id));
    }
  };

  const submitPrune = async () => {
    const days = parsePruneDays(pruneDays);
    if (days === null) {
      setMessage(t('standingGrants.pruneBad'));
      return;
    }
    await send('/api/v1/standing-grants/prune-setting', { prune_interval_days: days }, 'PUT');
  };

  const set = (patch: Partial<AssignForm>) => setForm((f) => ({ ...f, ...patch }));

  const renderList = (section: Section, heading: string, empty: string) => {
    const rows = lists[section];
    return (
      <section className="edge-card" aria-labelledby={`standing-grants-${section}`}>
        <h2 id={`standing-grants-${section}`}>{heading}</h2>
        {rows === null ? null : rows.length === 0 ? (
          <p>{empty}</p>
        ) : (
          <ul className="base-list">
            {rows.map((g) => (
              <li key={g.grant_id} className="base-card base-card-stacked">
                <span className="base-card-title">{describeGrant(g)}</span>
                <span>
                  <span className="state-pill">{g.status}</span>
                </span>
                {section === 'assigned' && canRevoke(g) ? (
                  <div className="edge-actions">
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={busy || !online}
                      onClick={() => void send(`/api/v1/standing-grants/${g.grant_id}/revoke`, {})}
                    >
                      {t('standingGrants.revoke')}
                    </button>
                  </div>
                ) : null}
                {section === 'pending' ? (
                  <div className="edge-actions">
                    <button
                      type="button"
                      className="primary-action"
                      disabled={busy || !online}
                      onClick={() =>
                        void send(`/api/v1/standing-grants/${g.grant_id}/finance-approve`, {})
                      }
                    >
                      {t('standingGrants.approve')}
                    </button>
                    <label htmlFor={`standing-grants-reason-${g.grant_id}`}>
                      {t('standingGrants.rejectReason')}
                      <input
                        id={`standing-grants-reason-${g.grant_id}`}
                        value={rejectReasons[g.grant_id] ?? ''}
                        onChange={(e) =>
                          setRejectReasons((r) => ({ ...r, [g.grant_id]: e.target.value }))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={busy || !online || (rejectReasons[g.grant_id] ?? '').trim() === ''}
                      onClick={() =>
                        void send(`/api/v1/standing-grants/${g.grant_id}/finance-reject`, {
                          reason: (rejectReasons[g.grant_id] ?? '').trim(),
                        })
                      }
                    >
                      {t('standingGrants.reject')}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <div className="base-screen" id="standing-grants" aria-busy={loading}>
      <h2 className="base-screen-title">{t('standingGrants.title')}</h2>
      {!online ? (
        <p className="base-notice" role="status">
          {t('standingGrants.offline')}
        </p>
      ) : null}
      {loading && online ? <p role="status">{t('standingGrants.loading')}</p> : null}
      {renderList('held', t('standingGrants.held'), t('standingGrants.heldEmpty'))}
      {renderList('assigned', t('standingGrants.assigned'), t('standingGrants.assignedEmpty'))}
      {renderList('pending', t('standingGrants.pending'), t('standingGrants.pendingEmpty'))}

      <section className="edge-card" aria-labelledby="standing-grants-assign">
        <h2 id="standing-grants-assign">{t('standingGrants.assign')}</h2>
        <form
          className="base-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAssign();
          }}
        >
          <label htmlFor="standing-grants-kind">{t('standingGrants.kind')}</label>
          <select
            id="standing-grants-kind"
            value={form.grant_kind}
            onChange={(e) => set({ grant_kind: e.target.value as AssignForm['grant_kind'] })}
          >
            <option value="standing_approval">{t('standingGrants.kindStanding')}</option>
            <option value="self_approval_limit">{t('standingGrants.kindLimit')}</option>
          </select>
          <label htmlFor="standing-grants-grantee">{t('standingGrants.grantee')}</label>
          <input
            id="standing-grants-grantee"
            value={form.grantee_user_id}
            onChange={(e) => set({ grantee_user_id: e.target.value })}
          />
          <label htmlFor="standing-grants-site">{t('standingGrants.site')}</label>
          <input
            id="standing-grants-site"
            value={form.site_id}
            onChange={(e) => set({ site_id: e.target.value })}
          />
          {form.grant_kind === 'standing_approval' ? (
            <>
              <label htmlFor="standing-grants-scope-type">{t('standingGrants.scopeType')}</label>
              <select
                id="standing-grants-scope-type"
                value={form.scope_type}
                onChange={(e) => set({ scope_type: e.target.value as AssignForm['scope_type'] })}
              >
                <option value="sku">{t('standingGrants.scopeSku')}</option>
                <option value="group">{t('standingGrants.scopeGroup')}</option>
              </select>
              <label htmlFor="standing-grants-scope">{t('standingGrants.scope')}</label>
              <input
                id="standing-grants-scope"
                value={form.scope}
                onChange={(e) => set({ scope: e.target.value })}
              />
              <label htmlFor="standing-grants-cap">{t('standingGrants.cap')}</label>
              <input
                id="standing-grants-cap"
                inputMode="decimal"
                value={form.monthly_qty_cap}
                onChange={(e) => set({ monthly_qty_cap: e.target.value })}
              />
            </>
          ) : (
            <>
              <label htmlFor="standing-grants-limit">{t('standingGrants.limit')}</label>
              <input
                id="standing-grants-limit"
                inputMode="decimal"
                value={form.limit_amount}
                onChange={(e) => set({ limit_amount: e.target.value })}
              />
            </>
          )}
          <label htmlFor="standing-grants-end">{t('standingGrants.endDate')}</label>
          <input
            id="standing-grants-end"
            value={form.end_date}
            onChange={(e) => set({ end_date: e.target.value })}
          />
          <div className="edge-actions">
            <button className="primary-action" type="submit" disabled={busy || !online}>
              {t('standingGrants.submit')}
            </button>
          </div>
        </form>
      </section>

      <section className="edge-card" aria-labelledby="standing-grants-prune">
        <h2 id="standing-grants-prune">{t('standingGrants.prune')}</h2>
        <form
          className="base-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitPrune();
          }}
        >
          <label htmlFor="standing-grants-prune-days">{t('standingGrants.pruneDays')}</label>
          <input
            id="standing-grants-prune-days"
            inputMode="numeric"
            value={pruneDays}
            onChange={(e) => setPruneDays(e.target.value)}
          />
          <div className="edge-actions">
            <button className="secondary-action" type="submit" disabled={busy || !online}>
              {t('standingGrants.pruneSave')}
            </button>
          </div>
        </form>
      </section>

      <p className="base-notice" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
