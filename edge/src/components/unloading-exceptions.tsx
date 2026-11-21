'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { t, errorMessage, formatDateTime, type MessageKey } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { useDeviceClass } from '../lib/use-device-class';
import { ScanField } from './scan-field';
import {
  findCaseByScan,
  mergeOpenCases,
  resolvedToday,
  type ExceptionRow,
  type GateEventRow,
  type OpenCase,
} from './unloading-exceptions-model';

/**
 * Story 3.20: the unloading supervisor's exception inbox. One merged list of open unmatched gate
 * events and open over-tolerance lines, a Resolved today group, a scan field and a detail pane that
 * resolves each case with one Story 3.19 command. Online-only: nothing is written to the outbox.
 */

export interface UnloadingExceptionsProps {
  online: boolean;
  ready: boolean;
  /** The site CODE (not the site id): both list calls filter by it. */
  siteCodeExt: string;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; gates: GateEventRow[]; exceptions: ExceptionRow[] }
  | { kind: 'message'; text: string };

interface PoLookup {
  po_number_ext: string;
  supplier_ref_ext: string | null;
  expected_delivery_date: string | null;
  lines: Array<{ line_no: number; sku: string; ordered_qty: string; open_qty: string }>;
}

type Done = 'resolved' | 'sent' | null;

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_code?: unknown };
    return typeof body.error_code === 'string'
      ? errorMessage(body.error_code)
      : t('unloading.commandFailed');
  } catch {
    return t('unloading.commandFailed');
  }
}

function caseFromUrl(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('case') ?? '';
}

function caseHref(key: string): string {
  return `/unloading/exceptions?case=${encodeURIComponent(key)}`;
}

export function UnloadingExceptions({ online, ready, siteCodeExt }: UnloadingExceptionsProps) {
  const deviceClass = useDeviceClass();
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [caseKey] = useState(caseFromUrl);
  const [scanValue, setScanValue] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [done, setDone] = useState<Done>(null);

  const load = useCallback(async () => {
    if (!online || !siteCodeExt) return;
    const site = encodeURIComponent(siteCodeExt);
    try {
      // One call per status: the server caps each list at 500 rows oldest first, so an
      // unfiltered call would let resolved history crowd out the open rows.
      const responses = await Promise.all([
        authorizedFetch(`/api/v1/gate-events?site=${site}&binding=unmatched&status=open`),
        ...(['open', 'resolved', 'sent_to_procurement'] as const).map((status) =>
          authorizedFetch(`/api/v1/receiving/exceptions?site=${site}&status=${status}`),
        ),
      ]);
      if (responses.some((response) => !response.ok)) {
        setList({ kind: 'message', text: t('unloading.failed') });
        return;
      }
      const [gateRes, ...excResponses] = responses;
      const gateBody = (await gateRes!.json()) as { gate_events?: GateEventRow[] };
      const excBodies = (await Promise.all(excResponses.map((r) => r.json()))) as {
        exceptions?: ExceptionRow[];
      }[];
      setList({
        kind: 'ready',
        gates: gateBody.gate_events ?? [],
        exceptions: excBodies.flatMap((body) => body.exceptions ?? []),
      });
    } catch {
      setList((current) =>
        current.kind === 'ready' ? current : { kind: 'message', text: t('unloading.failed') },
      );
    }
  }, [online, siteCodeExt]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  if (!ready) return <p className="stores-status">{t('unloading.loading')}</p>;
  if (!siteCodeExt) {
    return (
      <section className="edge-card" role="alert">
        <p>{t('unloading.noSite')}</p>
      </section>
    );
  }

  const cases = list.kind === 'ready' ? mergeOpenCases(list.gates, list.exceptions) : [];
  const resolved =
    list.kind === 'ready' ? resolvedToday(list.exceptions, new Date().toISOString()) : [];

  function onScan(value: string) {
    const match = findCaseByScan(cases, value);
    if (match) {
      window.location.assign(caseHref(match.key));
      return;
    }
    setAnnouncement(t('unloading.scan.notFound').replace('{code}', value.trim()));
  }

  const selected = cases.find((c) => c.key === caseKey) ?? null;
  const showDetail = Boolean(caseKey);
  const wideTwoPane = deviceClass !== 'handheld' && showDetail;

  const scan = (
    <section className="stores-scan" aria-label={t('unloading.scan.label')}>
      <ScanField
        id="unloading-scan"
        label={t('unloading.scan.label')}
        value={scanValue}
        placeholder={t('unloading.scan.placeholder')}
        onScan={onScan}
        onChange={setScanValue}
      />
      <p role="status" aria-live="polite" className="stores-announcement">
        {announcement}
      </p>
    </section>
  );

  const detail = showDetail ? (
    <CaseDetail
      key={caseKey}
      caseKey={caseKey}
      selected={selected}
      listReady={list.kind === 'ready'}
      online={online}
      done={done}
      onDone={(kind) => {
        setDone(kind);
        void load();
      }}
      onStale={() => void load()}
      onAnnounce={setAnnouncement}
    />
  ) : null;

  const inbox = (
    <div>
      {scan}
      {list.kind === 'loading' && online ? (
        <p className="stores-status">{t('unloading.loading')}</p>
      ) : null}
      {list.kind === 'message' ? (
        <section className="edge-card" role="alert">
          <p>{list.text}</p>
          <button className="secondary-action" type="button" onClick={() => void load()}>
            {t('unloading.checkConnection')}
          </button>
        </section>
      ) : null}
      {list.kind === 'ready' ? (
        <>
          <section className="stores-group" aria-labelledby="unloading-open-heading">
            <h2 id="unloading-open-heading">
              {t('unloading.group.open').replace('{count}', String(cases.length))}
            </h2>
            {cases.length === 0 ? (
              <div className="emptyst" role="status">
                <p>{t('unloading.empty')}</p>
              </div>
            ) : (
              <ul className="stores-cards">
                {cases.map((c) => (
                  <OpenCard key={c.key} item={c} />
                ))}
              </ul>
            )}
          </section>
          <section className="stores-group" aria-labelledby="unloading-resolved-heading">
            <h2 id="unloading-resolved-heading">{t('unloading.group.resolved')}</h2>
            {resolved.length === 0 ? (
              <p className="stores-status">{t('unloading.resolvedEmpty')}</p>
            ) : (
              <ul className="stores-cards">
                {resolved.map((row) => (
                  <li key={row.exception_id} className="stores-card">
                    <div>
                      <h3>{row.po_ref_ext ?? row.vehicle_reg_ext ?? row.sku}</h3>
                    </div>
                    <span className="state-pill state-pill-ok">
                      {t(`unloading.pill.${row.resolution ?? row.status}` as MessageKey)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );

  return (
    <div id="unloading-exceptions" className="floor-screen" data-device-class={deviceClass}>
      {!online ? (
        <section className="edge-card" aria-live="polite">
          <p>{t('unloading.needsConnection')}</p>
        </section>
      ) : null}
      {showDetail && !wideTwoPane ? detail : inbox}
      {wideTwoPane ? detail : null}
    </div>
  );
}

function OpenCard({ item }: { item: OpenCase }) {
  const unmatched = item.kind === 'unmatched';
  const title = unmatched ? item.gate.vehicle_reg_ext : (item.exception.po_ref_ext ?? '');
  const detail = unmatched
    ? t('unloading.card.enteredAt').replace('{time}', formatDateTime(item.gate.entered_at))
    : t('unloading.card.line')
        .replace('{po}', item.exception.po_ref_ext ?? '')
        .replace('{line}', String(item.exception.line_no ?? ''))
        .replace('{sku}', item.exception.sku ?? '');
  return (
    <li className="stores-card">
      <div>
        <h3>
          <a href={caseHref(item.key)}>{title}</a>
        </h3>
        <p>{detail}</p>
      </div>
      <span className={`state-pill ${unmatched ? 'state-pill-warn' : 'state-pill-err'}`}>
        {unmatched ? t('unloading.pill.unmatched') : t('unloading.pill.overTolerance')}
      </span>
    </li>
  );
}

interface CaseDetailProps {
  caseKey: string;
  selected: OpenCase | null;
  listReady: boolean;
  online: boolean;
  done: Done;
  onDone: (kind: Exclude<Done, null>) => void;
  onStale: () => void;
  onAnnounce: (text: string) => void;
}

function CaseDetail(props: CaseDetailProps) {
  const { selected, listReady, online, done } = props;
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function run(path: string, note: string | null, kind: Exclude<Done, null>, extra = {}) {
    setSubmitting(true);
    setError('');
    try {
      const response = await authorizedFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...extra, ...(note ? { note } : {}) }),
      });
      if (response.ok) {
        props.onDone(kind);
        return;
      }
      setError(await readError(response));
      // 409 or 404: the case changed elsewhere, so refresh the lists.
      if (response.status === 409 || response.status === 404) props.onStale();
    } catch {
      setError(t('unloading.commandFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  const back = (
    <a className="secondary-action" href="/unloading/exceptions">
      {done ? t('unloading.done.back') : t('unloading.back')}
    </a>
  );

  if (done) {
    return (
      <section className="edge-card" role="status" aria-labelledby="unloading-done-heading">
        <h2 id="unloading-done-heading">{t('unloading.done.title')}</h2>
        <p>{done === 'sent' ? t('unloading.done.sentBody') : t('unloading.done.body')}</p>
        {back}
      </section>
    );
  }
  if (!listReady) return <p className="stores-status">{t('unloading.loading')}</p>;
  if (!selected) {
    const code = props.caseKey.startsWith('line:') ? 'GRN_LINE_NOT_FOUND' : 'GATE_EVENT_NOT_FOUND';
    return (
      <section className="edge-card" role="alert">
        <p>{errorMessage(code)}</p>
        {back}
      </section>
    );
  }

  const blocked = !online || submitting;
  return selected.kind === 'unmatched' ? (
    <UnmatchedDetail
      row={selected.gate}
      blocked={blocked}
      offline={!online}
      error={error}
      back={back}
      onAnnounce={props.onAnnounce}
      onMatch={(po, note) =>
        run(
          `/api/v1/gate-events/${encodeURIComponent(selected.gate.gate_event_id)}/match-po`,
          note,
          'resolved',
          { po_ref_ext: po },
        )
      }
      onProcure={(note) =>
        run(
          `/api/v1/gate-events/${encodeURIComponent(selected.gate.gate_event_id)}/send-to-procurement`,
          note,
          'sent',
        )
      }
    />
  ) : (
    <OverToleranceDetail
      row={selected.exception}
      blocked={blocked}
      offline={!online}
      error={error}
      onAccept={() =>
        run(
          `/api/v1/grn-lines/${encodeURIComponent(selected.exception.source_id)}/accept-within-band`,
          null,
          'resolved',
        )
      }
    />
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || t('unloading.fact.none')}</dd>
    </>
  );
}

function Footer({
  offline,
  error,
  children,
}: {
  offline: boolean;
  error: string;
  children: ReactNode;
}) {
  return (
    <div className="unloading-footer">
      {error ? <p role="alert">{error}</p> : null}
      {offline ? <p className="stores-status">{t('unloading.actionsNeedConnection')}</p> : null}
      {children}
    </div>
  );
}

function UnmatchedDetail(props: {
  row: GateEventRow;
  blocked: boolean;
  offline: boolean;
  error: string;
  back: ReactNode;
  onAnnounce: (text: string) => void;
  onMatch: (po: string, note: string | null) => void;
  onProcure: (note: string | null) => void;
}) {
  const { row, blocked } = props;
  const [facts, setFacts] = useState<GateEventRow>(row);
  const [poInput, setPoInput] = useState('');
  const [po, setPo] = useState<PoLookup | null>(null);
  const [miss, setMiss] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authorizedFetch(
          `/api/v1/gate-events/${encodeURIComponent(row.gate_event_id)}`,
        );
        if (response.ok && !cancelled) setFacts((await response.json()) as GateEventRow);
      } catch {
        // The list row already carries the facts; the detail read only adds the photo ref.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.gate_event_id]);

  async function lookup(event: FormEvent) {
    event.preventDefault();
    const ref = poInput.trim();
    if (!ref || props.offline) return;
    setPo(null);
    setMiss('');
    try {
      const response = await authorizedFetch(
        `/api/v1/erp/purchase-orders/${encodeURIComponent(ref)}`,
      );
      if (response.ok) {
        setPo((await response.json()) as PoLookup);
        return;
      }
      setMiss(
        response.status === 404
          ? t('unloading.poNotFound').replace('{ref}', ref)
          : await readError(response),
      );
    } catch {
      setMiss(t('unloading.commandFailed'));
    }
  }

  const supplier = facts.supplier_name_unlisted ?? facts.supplier_ref_ext;
  const trimmedNote = note.trim() || null;
  return (
    <section className="edge-card" aria-labelledby="unloading-detail-heading">
      <h2 id="unloading-detail-heading">{row.vehicle_reg_ext}</h2>
      <span className="state-pill state-pill-warn">{t('unloading.pill.unmatched')}</span>
      <dl>
        <Fact label={t('unloading.fact.vehicle')} value={facts.vehicle_reg_ext} />
        <Fact label={t('unloading.fact.driver')} value={facts.driver_name} />
        <Fact label={t('unloading.fact.challan')} value={facts.challan_number_ext} />
        <Fact label={t('unloading.fact.challanPhoto')} value={facts.challan_photo_ref} />
        <Fact label={t('unloading.fact.poRef')} value={facts.po_ref_ext} />
        <Fact label={t('unloading.fact.supplier')} value={supplier} />
      </dl>
      <form onSubmit={(event) => void lookup(event)}>
        <label htmlFor="unloading-po">{t('unloading.po.label')}</label>
        <input
          id="unloading-po"
          className="scan-input"
          value={poInput}
          disabled={blocked}
          onChange={(event) => setPoInput(event.target.value)}
        />
        <button className="secondary-action" type="submit" disabled={blocked || !poInput.trim()}>
          {t('unloading.po.lookup')}
        </button>
      </form>
      <p role="status" aria-live="polite">
        {miss}
      </p>
      {po ? (
        <section aria-label={t('unloading.po.lines')}>
          <dl>
            <Fact label={t('unloading.po.supplier')} value={po.supplier_ref_ext} />
            <Fact label={t('unloading.po.due')} value={po.expected_delivery_date} />
          </dl>
          <h3>{t('unloading.po.lines')}</h3>
          <ul className="stores-lines">
            {po.lines.map((line) => (
              <li key={line.line_no}>
                {t('unloading.po.line')
                  .replace('{line}', String(line.line_no))
                  .replace('{sku}', line.sku)
                  .replace('{open}', line.open_qty)
                  .replace('{ordered}', line.ordered_qty)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <label htmlFor="unloading-note">{t('unloading.note.label')}</label>
      <textarea
        id="unloading-note"
        value={note}
        maxLength={500}
        disabled={blocked}
        onChange={(event) => setNote(event.target.value)}
      />
      <Footer offline={props.offline} error={props.error}>
        <button
          className="primary-action"
          type="button"
          disabled={blocked || !po}
          onClick={() => po && props.onMatch(po.po_number_ext, trimmedNote)}
        >
          {po
            ? t('unloading.match.action').replace('{po}', po.po_number_ext)
            : t('unloading.match.choose')}
        </button>
        <button
          className="secondary-action"
          type="button"
          disabled={blocked}
          onClick={() => props.onProcure(trimmedNote)}
        >
          {t('unloading.procure.action')}
        </button>
        {props.back}
      </Footer>
    </section>
  );
}

function OverToleranceDetail(props: {
  row: ExceptionRow;
  blocked: boolean;
  offline: boolean;
  error: string;
  onAccept: () => void;
}) {
  const { row } = props;
  const cap = row.cap_qty ?? '';
  const excess = row.excess_qty ?? '';
  return (
    <section className="edge-card" aria-labelledby="unloading-detail-heading">
      <h2 id="unloading-detail-heading">{t('unloading.band.title')}</h2>
      <span className="state-pill state-pill-err">{t('unloading.pill.overTolerance')}</span>
      <dl>
        <Fact
          label={t('unloading.band.poLine')}
          value={`${row.po_ref_ext ?? ''} / ${row.line_no ?? ''} - ${row.sku ?? ''}`}
        />
        <Fact
          label={t('unloading.band.ordered')}
          value={`${row.ordered_qty ?? ''} ${row.uom ?? ''}`}
        />
        <Fact
          label={t('unloading.band.alreadyReceived')}
          value={`${row.already_received_qty ?? ''} ${row.uom ?? ''}`}
        />
        <Fact
          label={t('unloading.band.acceptUpTo')
            .replace('{cap}', cap)
            .replace('{pct}', row.tolerance_pct ?? '')}
          value={`${cap} ${row.uom ?? ''}`}
        />
        <Fact
          label={t('unloading.band.counted')}
          value={`${row.counted_qty ?? ''} ${row.uom ?? ''}`}
        />
      </dl>
      <p className="state-pill state-pill-warn">
        {t('unloading.band.excess').replace('{excess}', excess)}
      </p>
      <Footer offline={props.offline} error={props.error}>
        <button
          className="primary-action"
          type="button"
          disabled={props.blocked}
          onClick={props.onAccept}
        >
          {t('unloading.band.accept').replace('{cap}', cap).replace('{excess}', excess)}
        </button>
        <a className="secondary-action" href="/unloading/exceptions">
          {t('unloading.band.recount')}
        </a>
        <button className="secondary-action" type="button" disabled>
          {t('unloading.band.hold')}
        </button>
        <span className="state-pill state-pill-off">{t('unloading.band.postPilot')}</span>
      </Footer>
    </section>
  );
}
