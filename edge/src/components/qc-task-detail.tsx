'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, formatDateTime, t } from '../i18n/locale';
import { authorizedFetch } from '../session/api-fetch';
import { useDeviceClass } from '../lib/use-device-class';
import { pendingPhotoStore, type PendingPhoto, type PendingPhotoStore } from '../local-db/pending-photos';
import { reencodeAsJpeg, uploadPendingPhotos } from '../sync/attachment-uploader';
import type { QcTaskListItem } from './qc-inbox-model';

// Story 8.11 (AC 3, 4, 5): the QC inspection detail. Online-only for every write (D1); writes go
// through the online REST paths, never the edge outbox.

interface QcCharacteristic {
  characteristic_id: string;
  characteristic_name: string;
  characteristic_class: 'critical' | 'major' | 'minor';
  result_kind: 'numeric' | 'attribute';
  lower_limit: string | null;
  upper_limit: string | null;
  limit_uom: string | null;
  acceptance_criteria: string | null;
}

interface QcSampling {
  sample_size: number;
  sampling_basis: string;
}

interface QcNote {
  note_id: string;
  note: string;
  attachment_id: string | null;
  recorded_by: string;
  recorded_at: string;
}

interface QcResult {
  characteristic_id: string;
  sample_unit_no: number;
  conforms: boolean;
  measured_value: string | null;
}

interface QcHoldSummary {
  hold_id: string;
  lot_id: string;
  status: string;
  hold_reason?: string;
}

interface QcSplitChild {
  child_task_id: string;
  child_lot_id: string;
  sequence: number;
  quantity: string;
}

interface QcDetail {
  task: QcTaskListItem & {
    item_id: string;
    plan_id: string | null;
    plan_version_id: string | null;
    source_completion_type: string;
  };
  sampling: QcSampling | null;
  disposition: string | null;
  receipt: {
    grn_number?: string;
    supplier_name?: string | null;
    received_quantity?: string;
    uom?: string;
    line_condition?: string;
    inspect_on_opening?: boolean;
    inspect_note?: string | null;
  } | null;
  putaway: { status?: string; hold_reason?: string | null } | null;
}

export interface QcTaskDetailProps {
  taskId: string;
  online: boolean;
  siteId: string;
  userId: string;
  role: string;
  onComplete: () => void;
  onBack?: () => void;
}

type DetailState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      detail: QcDetail;
      characteristics: QcCharacteristic[];
      results: QcResult[];
      notes: QcNote[];
    }
  | { kind: 'message'; text: string };

const MAX_NOTE_LENGTH = 1000;

async function errorCodeFrom(response: Response): Promise<string | null> {
  try {
    const body = (await response.json().catch(() => null)) as { error_code?: unknown } | null;
    return typeof body?.error_code === 'string' ? body.error_code : null;
  } catch {
    return null;
  }
}

function memoryPhotoStore(): PendingPhotoStore {
  let items: PendingPhoto[] = [];
  return {
    async put(photo) {
      items = [...items.filter((p) => p.attachmentId !== photo.attachmentId), photo];
    },
    async list() {
      return items;
    },
    async remove(attachmentId) {
      items = items.filter((p) => p.attachmentId !== attachmentId);
    },
  };
}

function NotePhoto({ attachmentId }: { attachmentId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const res = await authorizedFetch(`/api/v1/attachments/${encodeURIComponent(attachmentId)}`, {
          credentials: 'include',
        });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        // Leave absent when attachment cannot be loaded.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [attachmentId]);
  if (!url) return null;
  return <img className="qc-note-photo" src={url} alt={t('qc.note.photoAlt')} />;
}

function unitKey(characteristicId: string, unitNo: number): string {
  return `${characteristicId}:${unitNo}`;
}

export function QcTaskDetail({
  taskId,
  online,
  siteId,
  userId,
  role,
  onComplete,
  onBack,
}: QcTaskDetailProps) {
  const deviceClass = useDeviceClass();
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [good, setGood] = useState(0);
  const [scope, setScope] = useState<'bay' | 'whole_lot' | 'reported_only'>('bay');
  const [decisionChoice, setDecisionChoice] = useState<'accept' | 'reject'>('accept');
  const [holdReason, setHoldReason] = useState('');
  const [justification, setJustification] = useState('');
  const [defectCode, setDefectCode] = useState('');
  const [note, setNote] = useState('');
  const [notePhotoId, setNotePhotoId] = useState<string | null>(null);
  const [noteAnnouncement, setNoteAnnouncement] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [samplingError, setSamplingError] = useState<string | null>(null);
  const [releaseState, setReleaseState] = useState<'idle' | 'released'>('idle');
  const [openHold, setOpenHold] = useState<QcHoldSummary | null>(null);
  const [holdReleaseReason, setHoldReleaseReason] = useState('');
  const [holdReleaseArmed, setHoldReleaseArmed] = useState(false);
  const [retentionTaskId, setRetentionTaskId] = useState<string | null>(null);
  const [retentionQty, setRetentionQty] = useState('1');
  const [retentionLocationId, setRetentionLocationId] = useState('');
  const [numericValues, setNumericValues] = useState<Record<string, string>>({});
  const [instrumentAssetId, setInstrumentAssetId] = useState('');
  const samplingPosted = useRef(false);
  const initializedTask = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isQcHead = role === 'qc_head';

  useEffect(() => {
    samplingPosted.current = false;
    initializedTask.current = null;
    setState({ kind: 'loading' });
    setGood(0);
    setScope('bay');
    setDecisionChoice('accept');
    setHoldReason('');
    setJustification('');
    setDefectCode('');
    setNote('');
    setNotePhotoId(null);
    setNoteAnnouncement('');
    setBusy(null);
    setNotice(null);
    setSamplingError(null);
    setReleaseState('idle');
    setOpenHold(null);
    setHoldReleaseReason('');
    setHoldReleaseArmed(false);
    setRetentionTaskId(null);
    setRetentionQty('1');
    setRetentionLocationId('');
    setNumericValues({});
    setInstrumentAssetId('');
  }, [taskId]);

  const fetchOpenHold = useCallback(async (lotId: string): Promise<QcHoldSummary | null> => {
    try {
      const res = await authorizedFetch(
        `/api/v1/qc/holds?lot_id=${encodeURIComponent(lotId)}&status=open`,
        { credentials: 'include' },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { holds?: QcHoldSummary[] };
      const first = body.holds?.[0] ?? null;
      setOpenHold(first);
      return first;
    } catch {
      return null;
    }
  }, []);

  const load = useCallback(async () => {
    if (!siteId) {
      setState({ kind: 'message', text: t('qc.detail.notFound') });
      return;
    }
    if (!online) return;
    try {
      const res = await authorizedFetch(`/api/v1/qc/tasks/${encodeURIComponent(taskId)}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        setState({ kind: 'message', text: t('qc.detail.failed') });
        return;
      }
      const body = (await res.json()) as {
        task?: QcDetail['task'];
        sampling?: QcSampling | null;
        disposition?: string | null;
        receipt?: QcDetail['receipt'] | null;
        putaway?: QcDetail['putaway'] | null;
      };
      if (!body.task) {
        setState({ kind: 'message', text: t('qc.detail.failed') });
        return;
      }
      const detail: QcDetail = {
        task: body.task,
        sampling: body.sampling ?? null,
        disposition: body.disposition ?? null,
        receipt: body.receipt ?? null,
        putaway: body.putaway ?? null,
      };
      if (!detail.task.plan_id || !detail.task.plan_version_id) {
        setState({ kind: 'message', text: t('qc.pill.noPlan') });
        return;
      }
      const [charsRes, resultsRes, activeHold] = await Promise.all([
        authorizedFetch(
          `/api/v1/qc/inspection-plans/${encodeURIComponent(detail.task.plan_id)}/versions/${encodeURIComponent(detail.task.plan_version_id)}`,
          { credentials: 'include' },
        ),
        authorizedFetch(`/api/v1/qc/tasks/${encodeURIComponent(taskId)}/results`, {
          credentials: 'include',
        }),
        fetchOpenHold(detail.task.lot_id),
      ]);
      if (!charsRes.ok || !resultsRes.ok) {
        setState({ kind: 'message', text: t('qc.detail.failed') });
        return;
      }
      const charsBody = (await charsRes.json()) as { characteristics?: QcCharacteristic[] };
      const resultsBody = (await resultsRes.json()) as { results?: QcResult[]; notes?: QcNote[] };
      if (initializedTask.current !== taskId) {
        initializedTask.current = taskId;
        const parsed = Number(detail.task.quantity);
        setGood(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0);
      }
      setState({
        kind: 'ready',
        detail,
        characteristics: (charsBody.characteristics ?? []) as QcCharacteristic[],
        results: resultsBody.results ?? [],
        notes: resultsBody.notes ?? [],
      });
      if (!activeHold && detail.putaway && detail.putaway.status !== 'held') {
        setReleaseState('released');
      } else if (activeHold) {
        setReleaseState('idle');
      }
    } catch {
      if (online) setState({ kind: 'message', text: t('qc.detail.failed') });
    }
  }, [fetchOpenHold, online, siteId, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.kind !== 'ready' || samplingPosted.current) return;
    if (state.detail.sampling || state.detail.task.task_status !== 'open') return;
    samplingPosted.current = true;
    void (async () => {
      try {
        const res = await authorizedFetch(`/api/v1/qc/tasks/${encodeURIComponent(taskId)}/sampling`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          credentials: 'include',
        });
        if (!res.ok) {
          const code = await errorCodeFrom(res);
          setSamplingError(code ? errorMessage(code) : t('qc.detail.failed'));
          return;
        }
        setSamplingError(null);
        await load();
      } catch {
        setSamplingError(t('qc.detail.failed'));
      }
    })();
  }, [state, taskId, load]);

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    return authorizedFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
  }

  async function recordAttribute(
    characteristicId: string,
    unitNo: number,
    conforms: boolean,
  ): Promise<void> {
    const key = unitKey(characteristicId, unitNo);
    setBusy(key);
    setNotice(null);
    try {
      const res = await post(`/api/v1/qc/tasks/${encodeURIComponent(taskId)}/observations`, {
        characteristic_id: characteristicId,
        readings: [{ sample_unit_no: unitNo, attribute_conforms: conforms }],
      });
      if (!res.ok) {
        setNotice(errorMessage((await errorCodeFrom(res)) ?? 'INVALID_PARAMS'));
        return;
      }
      await load();
    } catch {
      setNotice(t('qc.detail.failed'));
    } finally {
      setBusy(null);
    }
  }

  async function recordNumeric(
    characteristicId: string,
    unitNo: number,
    uom: string | null,
  ): Promise<void> {
    const key = unitKey(characteristicId, unitNo);
    const measured = (numericValues[key] ?? '').trim();
    if (!measured || !instrumentAssetId.trim()) {
      setNotice(t('qc.detail.measuredRequired'));
      return;
    }
    setBusy(key);
    setNotice(null);
    try {
      const res = await post(`/api/v1/qc/tasks/${encodeURIComponent(taskId)}/results`, {
        characteristic_id: characteristicId,
        instrument_asset_id: instrumentAssetId.trim(),
        readings: [
          {
            sample_unit_no: unitNo,
            measured_value: measured,
            ...(uom ? { measured_uom: uom } : {}),
          },
        ],
      });
      if (!res.ok) {
        setNotice(errorMessage((await errorCodeFrom(res)) ?? 'INVALID_PARAMS'));
        return;
      }
      await load();
    } catch {
      setNotice(t('qc.detail.failed'));
    } finally {
      setBusy(null);
    }
  }

  async function completeInspection(): Promise<void> {
    setBusy('complete');
    setNotice(null);
    try {
      const res = await post(`/api/v1/qc/tasks/${encodeURIComponent(taskId)}/inspection-completion`, {});
      if (!res.ok) {
        setNotice(errorMessage((await errorCodeFrom(res)) ?? 'INVALID_PARAMS'));
        return;
      }
      setNotice(t('qc.detail.completed'));
      await load();
      onComplete();
    } catch {
      setNotice(t('qc.detail.failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handlePhotoUpload(file: File): Promise<void> {
    const id = crypto.randomUUID();
    const owner = userId || 'anonymous';
    setBusy('photo');
    setNotice(t('qc.note.photoUploading'));
    const photo: PendingPhoto = {
      attachmentId: id,
      blob: file,
      contentType: file.type || 'image/jpeg',
      ownerUserId: owner,
      createdAt: new Date().toISOString(),
    };
    let store: PendingPhotoStore = pendingPhotoStore;
    try {
      await store.put(photo);
    } catch {
      store = memoryPhotoStore();
      await store.put(photo);
    }
    try {
      const result = await uploadPendingPhotos({
        store,
        ownerUserId: owner,
        fetch: authorizedFetch,
        reencode: reencodeAsJpeg,
      });
      if (result.stored > 0) {
        setNotePhotoId(id);
        setNotice(t('qc.note.photoSaved'));
      } else {
        await store.remove(id).catch(() => undefined);
        setNotice(t('qc.note.photoFailed'));
      }
    } catch {
      await store.remove(id).catch(() => undefined);
      setNotice(t('qc.note.photoFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function saveNote(): Promise<void> {
    const trimmed = note.trim();
    if (!trimmed) {
      setNotice(t('qc.note.missing'));
      return;
    }
    setBusy('note');
    setNotice(null);
    try {
      const res = await post(`/api/v1/qc/tasks/${encodeURIComponent(taskId)}/notes`, {
        note: trimmed,
        ...(notePhotoId ? { attachment_id: notePhotoId } : {}),
      });
      if (!res.ok) {
        setNotice(errorMessage((await errorCodeFrom(res)) ?? 'INVALID_PARAMS'));
        return;
      }
      setNote('');
      setNotePhotoId(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setNoteAnnouncement(t('qc.note.saved'));
      await load();
    } catch {
      setNotice(t('qc.detail.failed'));
    } finally {
      setBusy(null);
    }
  }

  async function releaseTask(targetTaskId: string): Promise<boolean> {
    const res = await post(`/api/v1/qc/tasks/${encodeURIComponent(targetTaskId)}/release`, {});
    if (!res.ok) {
      const code = await errorCodeFrom(res);
      if (code === 'RETENTION_SAMPLE_REQUIRED' || code === 'QC_RELEASE_NOT_ELIGIBLE') {
        setRetentionTaskId(targetTaskId);
        return false;
      }
      if (code === 'RELEASE_EXISTS') {
        setReleaseState('released');
        return true;
      }
      setNotice(errorMessage(code ?? 'INVALID_PARAMS'));
      return false;
    }
    setReleaseState('released');
    return true;
  }

  async function recordDisposition(): Promise<void> {
    if (state.kind !== 'ready') return;
    const trimmedReason = holdReason.trim();
    const trimmedJust = justification.trim();
    const trimmedDefect = defectCode.trim();
    if (scope === 'whole_lot' && !trimmedReason) {
      setNotice(t('qc.disposition.holdReasonRequired'));
      return;
    }
    if (!trimmedJust) {
      setNotice(t('qc.disposition.justificationRequired'));
      return;
    }
    const parsedQty = Number(state.detail.task.quantity);
    const totalQty = Number.isFinite(parsedQty) && parsedQty >= 0 ? parsedQty : 0;
    const notUsableQty = Math.max(0, totalQty - good);
    const isTwoPart = good > 0 && notUsableQty > 0;
    const effectiveChoice: 'accept' | 'reject' =
      scope === 'whole_lot' && decisionChoice === 'accept' ? 'reject' : decisionChoice;

    setBusy('disposition');
    setNotice(null);
    try {
      let holdActive = Boolean(openHold);
      if (scope === 'whole_lot') {
        const holdRes = await post('/api/v1/qc/holds', {
          lot_id: state.detail.task.lot_id,
          hold_reason: trimmedReason,
        });
        if (holdRes.status === 409) {
          const code = await errorCodeFrom(holdRes);
          if (code === 'HOLD_EXISTS') {
            holdActive = Boolean(await fetchOpenHold(state.detail.task.lot_id));
          } else {
            setNotice(errorMessage(code ?? 'INVALID_PARAMS'));
            return;
          }
        } else if (!holdRes.ok) {
          setNotice(errorMessage((await errorCodeFrom(holdRes)) ?? 'INVALID_PARAMS'));
          return;
        } else {
          const holdBody = (await holdRes.json()) as { hold?: QcHoldSummary };
          if (holdBody.hold) {
            setOpenHold(holdBody.hold);
            holdActive = true;
          } else {
            holdActive = Boolean(await fetchOpenHold(state.detail.task.lot_id));
          }
        }
      }

      if (isTwoPart) {
        const splitRes = await post(`/api/v1/qc/tasks/${encodeURIComponent(taskId)}/split`, {
          justification: trimmedJust,
          splits: [
            { sequence: 1, quantity: String(good) },
            { sequence: 2, quantity: String(notUsableQty) },
          ],
        });
        if (!splitRes.ok) {
          const code = await errorCodeFrom(splitRes);
          if (code === 'DISPOSITION_EXISTS') {
            await load();
            return;
          }
          setNotice(errorMessage(code ?? 'INVALID_PARAMS'));
          return;
        }
        const splitBody = (await splitRes.json()) as { splits?: QcSplitChild[] };
        const children = splitBody.splits ?? [];
        const goodChild = children.find((c) => c.sequence === 1);
        const badChild = children.find((c) => c.sequence === 2);
        if (goodChild && scope !== 'whole_lot') {
          const dRes = await post(
            `/api/v1/qc/tasks/${encodeURIComponent(goodChild.child_task_id)}/disposition`,
            {
              disposition: effectiveChoice,
              justification: trimmedJust,
              ...(effectiveChoice === 'reject' && trimmedDefect ? { defect_code: trimmedDefect } : {}),
            },
          );
          if (!dRes.ok) {
            setNotice(errorMessage((await errorCodeFrom(dRes)) ?? 'INVALID_PARAMS'));
            return;
          }
          if (effectiveChoice === 'accept' && !holdActive) {
            await releaseTask(goodChild.child_task_id);
          }
        } else if (goodChild && scope === 'whole_lot' && decisionChoice === 'reject') {
          await post(
            `/api/v1/qc/tasks/${encodeURIComponent(goodChild.child_task_id)}/disposition`,
            {
              disposition: 'reject',
              justification: trimmedJust,
              ...(trimmedDefect ? { defect_code: trimmedDefect } : {}),
            },
          );
        }
        if (badChild) {
          const bRes = await post(
            `/api/v1/qc/tasks/${encodeURIComponent(badChild.child_task_id)}/disposition`,
            {
              disposition: 'reject',
              justification: trimmedJust,
              ...(trimmedDefect ? { defect_code: trimmedDefect } : {}),
            },
          );
          if (!bRes.ok) {
            setNotice(errorMessage((await errorCodeFrom(bRes)) ?? 'INVALID_PARAMS'));
            return;
          }
        }
      } else {
        if (scope === 'whole_lot' && decisionChoice === 'accept') {
          setNotice(t('qc.disposition.acceptDisabled'));
          await load();
          onComplete();
          return;
        }
        const res = await post(`/api/v1/qc/tasks/${encodeURIComponent(taskId)}/disposition`, {
          disposition: effectiveChoice,
          justification: trimmedJust,
          ...(effectiveChoice === 'reject' && trimmedDefect ? { defect_code: trimmedDefect } : {}),
        });
        if (!res.ok) {
          const code = await errorCodeFrom(res);
          if (code === 'DISPOSITION_EXISTS') {
            await load();
            return;
          }
          setNotice(errorMessage(code ?? 'INVALID_PARAMS'));
          return;
        }
        if (effectiveChoice === 'accept' && !holdActive) {
          await releaseTask(taskId);
        }
      }
      await load();
      onComplete();
    } catch {
      setNotice(t('qc.disposition.failed'));
    } finally {
      setBusy(null);
    }
  }

  async function releaseOpenHold(): Promise<void> {
    if (!openHold) return;
    const trimmed = holdReleaseReason.trim();
    if (!trimmed) {
      setNotice(t('qc.holds.releaseReasonRequired'));
      return;
    }
    setBusy('hold-release');
    setNotice(null);
    try {
      const res = await post(`/api/v1/qc/holds/${encodeURIComponent(openHold.hold_id)}/release`, {
        release_reason: trimmed,
      });
      if (!res.ok) {
        setNotice(errorMessage((await errorCodeFrom(res)) ?? 'INVALID_PARAMS'));
        return;
      }
      setHoldReleaseReason('');
      setHoldReleaseArmed(false);
      setOpenHold(null);
      if (state.kind === 'ready' && state.detail.disposition === 'accept') {
        await releaseTask(taskId);
      }
      await load();
      onComplete();
    } catch {
      setNotice(t('qc.holds.releaseFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function logRetentionSample(): Promise<void> {
    const qty = retentionQty.trim();
    const loc = retentionLocationId.trim();
    if (!qty || Number(qty) <= 0 || !Number.isFinite(Number(qty))) {
      setNotice(t('qc.retention.quantityRequired'));
      return;
    }
    if (!loc) {
      setNotice(t('qc.retention.locationRequired'));
      return;
    }
    const targetTask = retentionTaskId ?? taskId;
    setBusy('retention');
    setNotice(null);
    try {
      const res = await post(
        `/api/v1/qc/tasks/${encodeURIComponent(targetTask)}/retention-sample`,
        {
          quantity: qty,
          uom: state.kind === 'ready' ? state.detail.task.uom : 'EA',
          location_id: loc,
        },
      );
      if (!res.ok) {
        setNotice(errorMessage((await errorCodeFrom(res)) ?? 'INVALID_PARAMS'));
        return;
      }
      setRetentionTaskId(null);
      await releaseTask(targetTask);
      await load();
      onComplete();
    } catch {
      setNotice(t('qc.disposition.failed'));
    } finally {
      setBusy(null);
    }
  }

  if (!online) {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{t('qc.needsConnection')}</p>
        <button className="secondary-action" type="button" onClick={() => window.location.reload()}>
          {t('qc.checkConnection')}
        </button>
      </section>
    );
  }

  if (state.kind === 'loading') {
    return <p className="stores-status">{t('qc.detail.loading')}</p>;
  }
  if (state.kind === 'message') {
    return (
      <section className="edge-card" aria-live="polite">
        <p>{state.text}</p>
        <a
          className="secondary-action"
          href="/qc/tasks"
          onClick={(e) => {
            if (!onBack) return;
            e.preventDefault();
            onBack();
          }}
        >
          {t('qc.detail.back')}
        </a>
      </section>
    );
  }

  const { detail, characteristics, results, notes } = state;
  const parsedQty = Number(detail.task.quantity);
  const received = Number.isFinite(parsedQty) && parsedQty >= 0 ? parsedQty : 0;
  const notUsable = Math.max(0, received - good);
  const sampleSize = Math.max(1, detail.sampling?.sample_size ?? 1);
  const sampleUnits = Array.from({ length: sampleSize }, (_, i) => i + 1);
  const allCharacteristicsSampled =
    characteristics.length > 0 &&
    characteristics.every((c) => {
      const recorded = new Set(
        results.filter((r) => r.characteristic_id === c.characteristic_id).map((r) => r.sample_unit_no),
      );
      return sampleUnits.every((u) => recorded.has(u));
    });
  const canComplete = allCharacteristicsSampled && (notUsable === 0 || notes.length > 0);
  const hasDisposition = Boolean(detail.disposition);
  const isInspected = detail.task.task_status === 'inspected';
  const isDamageSourced = detail.task.source_completion_type !== 'goods_receipt';
  const isTwoPart = good > 0 && notUsable > 0;
  const acceptBlockedByHold = scope === 'whole_lot';
  const isReleased =
    !openHold && (releaseState === 'released' || (detail.putaway && detail.putaway.status !== 'held'));

  return (
    <div className="qc-detail" data-device-class={deviceClass}>
      <header className="qc-detail-head">
        <a
          className="secondary-action"
          href="/qc/tasks"
          onClick={(e) => {
            if (!onBack) return;
            e.preventDefault();
            onBack();
          }}
        >
          {t('qc.detail.back')}
        </a>
        <h2>{t('qc.detail.title').replace('{sku}', detail.task.sku)}</h2>
      </header>

      <dl className="qc-facts">
        <div>
          <dt>{t('qc.detail.lot')}</dt>
          <dd>{detail.task.lot_number}</dd>
        </div>
        <div>
          <dt>{t('qc.detail.quantity')}</dt>
          <dd>{`${detail.task.quantity} ${detail.task.uom}`}</dd>
        </div>
        {detail.receipt?.grn_number ? (
          <div>
            <dt>{t('qc.detail.grn')}</dt>
            <dd>{detail.receipt.grn_number}</dd>
          </div>
        ) : null}
        {detail.receipt?.supplier_name ? (
          <div>
            <dt>{t('qc.detail.supplier')}</dt>
            <dd>{detail.receipt.supplier_name}</dd>
          </div>
        ) : null}
        {detail.receipt?.inspect_on_opening ? (
          <div>
            <dt aria-hidden="true" />
            <dd className="qc-chip">{t('qc.chip.inspectOnOpening')}</dd>
          </div>
        ) : null}
      </dl>

      <section className="edge-card" aria-labelledby="qc-sampling-heading">
        <h3 id="qc-sampling-heading">{t('qc.detail.samplingDetermined')}</h3>
        <p>
          {samplingError
            ? samplingError
            : detail.sampling
              ? t('qc.detail.sampleSize').replace('{n}', String(detail.sampling.sample_size))
              : t('qc.detail.loading')}
        </p>
      </section>

      <section className="edge-card" aria-labelledby="qc-char-heading">
        <h3 id="qc-char-heading">{t('qc.detail.characteristics')}</h3>
        <ul className="qc-char-list">
          {characteristics.map((c) => (
            <li key={c.characteristic_id} className="qc-char">
              <div>
                <h4>{c.characteristic_name}</h4>
                {c.acceptance_criteria ? <p>{c.acceptance_criteria}</p> : null}
              </div>
              {sampleUnits.map((unitNo) => {
                const key = unitKey(c.characteristic_id, unitNo);
                const existing = results
                  .filter(
                    (r) => r.characteristic_id === c.characteristic_id && r.sample_unit_no === unitNo,
                  )
                  .slice(-1)[0];
                return (
                  <div key={key} className="qc-char-actions">
                    {sampleSize > 1 ? (
                      <span className="qc-unit-label">
                        {t('qc.detail.unitLabel').replace('{n}', String(unitNo))}
                      </span>
                    ) : null}
                    {c.result_kind === 'attribute' ? (
                      <>
                        <button
                          type="button"
                          className={existing && existing.conforms ? 'primary-action' : 'secondary-action'}
                          disabled={busy === key}
                          onClick={() => void recordAttribute(c.characteristic_id, unitNo, true)}
                        >
                          {t('qc.detail.pass')}
                        </button>
                        <button
                          type="button"
                          className={
                            existing && !existing.conforms
                              ? 'primary-action danger'
                              : 'secondary-action'
                          }
                          disabled={busy === key}
                          onClick={() => void recordAttribute(c.characteristic_id, unitNo, false)}
                        >
                          {t('qc.detail.fail')}
                        </button>
                        {existing && !existing.conforms ? (
                          <span className="qc-pill fail">{t('qc.detail.outOfTolerance')}</span>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <input
                          className="qc-measured"
                          aria-label={`${c.characteristic_name} ${t('qc.detail.measured')} ${unitNo}`}
                          value={numericValues[key] ?? existing?.measured_value ?? ''}
                          onChange={(e) =>
                            setNumericValues((cur) => ({ ...cur, [key]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="primary-action"
                          disabled={busy === key}
                          onClick={() => void recordNumeric(c.characteristic_id, unitNo, c.limit_uom)}
                        >
                          {t('qc.detail.recordResult')}
                        </button>
                        {existing && !existing.conforms ? (
                          <span className="qc-pill fail">{t('qc.detail.outOfTolerance')}</span>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })}
            </li>
          ))}
        </ul>
        {characteristics.some((c) => c.result_kind === 'numeric') ? (
          <p className="qc-instrument">
            <label>
              {t('qc.detail.instrumentLabel')}
              <input
                value={instrumentAssetId}
                onChange={(e) => setInstrumentAssetId(e.target.value)}
              />
            </label>
          </p>
        ) : null}
      </section>

      <section className="edge-card" aria-labelledby="qc-split-heading">
        <h3 id="qc-split-heading">{t('qc.split.title')}</h3>
        <div className="qc-split">
          <label>
            {t('qc.split.goodLabel')}
            <input
              type="number"
              min={0}
              max={received}
              value={good}
              onChange={(e) => setGood(Math.max(0, Math.min(received, Number(e.target.value) || 0)))}
            />
          </label>
          <p>
            {t('qc.split.notUsable')}: {notUsable}
          </p>
          <p className="qc-hint">{t('qc.split.notUsableDerived')}</p>
        </div>
      </section>

      <section className="edge-card" aria-labelledby="qc-note-heading">
        <h3 id="qc-note-heading">{t('qc.note.title')}</h3>
        <ul className="qc-note-list">
          {notes.map((n) => (
            <li key={n.note_id}>
              <p>{n.note}</p>
              <p className="qc-note-meta">
                <span>{t('qc.note.by').replace('{who}', n.recorded_by)}</span> ·{' '}
                <span>{formatDateTime(n.recorded_at)}</span>
              </p>
              {n.attachment_id ? <NotePhoto attachmentId={n.attachment_id} /> : null}
            </li>
          ))}
        </ul>
        {notes.length === 0 ? <p className="emptyst">{t('qc.note.empty')}</p> : null}
        <p
          className="qc-note-live"
          role="status"
          aria-live="polite"
          aria-label={t('qc.note.liveLabel')}
        >
          {noteAnnouncement}
        </p>
        <div className="qc-note-compose">
          <p className="qc-hint">{t('qc.note.hint')}</p>
          <textarea
            aria-label={t('qc.note.label')}
            value={note}
            maxLength={MAX_NOTE_LENGTH}
            onChange={(e) => setNote(e.target.value)}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            aria-label={t('qc.note.addPhoto')}
            disabled={busy === 'photo'}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handlePhotoUpload(file);
            }}
          />
          {notePhotoId ? (
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                setNotePhotoId(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            >
              {t('qc.note.removePhoto')}
            </button>
          ) : null}
          <button
            type="button"
            className="primary-action"
            disabled={busy === 'note' || busy === 'photo'}
            onClick={() => void saveNote()}
          >
            {t('qc.note.submit')}
          </button>
        </div>
      </section>

      {!isInspected && !hasDisposition ? (
        <section className="edge-card">
          <button
            type="button"
            className="primary-action"
            disabled={!canComplete || busy === 'complete'}
            onClick={() => void completeInspection()}
          >
            {busy === 'complete' ? t('qc.detail.completing') : t('qc.detail.complete')}
          </button>
          {!canComplete ? <p className="qc-hint">{t('qc.detail.completeDisabled')}</p> : null}
        </section>
      ) : null}

      {isInspected || hasDisposition || isReleased ? (
        <section className="edge-card" aria-labelledby="qc-disposition-heading">
          <h3 id="qc-disposition-heading">{t('qc.disposition.title')}</h3>
          {hasDisposition || isReleased ? (
            isReleased ? (
              <p className="qc-result" role="status">
                {t('qc.disposition.released')}
              </p>
            ) : openHold ? (
              <div className="qc-hold-active">
                <p className="qc-result" role="status">
                  {t('qc.disposition.onHoldWithId').replace('{id}', openHold.hold_id)}
                </p>
                {isQcHead ? (
                  <div className="qc-hold-release">
                    <label>
                      {t('qc.holds.releaseReason')}
                      <input
                        value={holdReleaseReason}
                        onChange={(e) => setHoldReleaseReason(e.target.value)}
                      />
                    </label>
                    {holdReleaseArmed ? (
                      <button
                        type="button"
                        className="primary-action"
                        disabled={busy === 'hold-release'}
                        onClick={() => void releaseOpenHold()}
                      >
                        {t('qc.holds.confirmRelease')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={busy === 'hold-release'}
                        onClick={() => {
                          if (!holdReleaseReason.trim()) {
                            setNotice(t('qc.holds.releaseReasonRequired'));
                            return;
                          }
                          setNotice(null);
                          setHoldReleaseArmed(true);
                        }}
                      >
                        {t('qc.holds.release')}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="qc-result" role="status">
                {t('qc.disposition.onHold')}
              </p>
            )
          ) : (
            <fieldset disabled={!isQcHead}>
              <legend>{t('qc.disposition.holdScope')}</legend>
              {!isQcHead ? <p className="qc-hint">{t('qc.disposition.readOnly')}</p> : null}
              <label>
                <input
                  type="radio"
                  name="qc-scope"
                  checked={scope === 'bay'}
                  onChange={() => setScope('bay')}
                />
                {t('qc.disposition.scopeBay')}
              </label>
              <label>
                <input
                  type="radio"
                  name="qc-scope"
                  checked={scope === 'whole_lot'}
                  onChange={() => setScope('whole_lot')}
                />
                {t('qc.disposition.scopeWholeLot')}
              </label>
              {isDamageSourced ? (
                <label>
                  <input
                    type="radio"
                    name="qc-scope"
                    checked={scope === 'reported_only'}
                    onChange={() => setScope('reported_only')}
                  />
                  {t('qc.disposition.scopeReported')}
                </label>
              ) : null}
              {scope === 'whole_lot' ? (
                <label>
                  {t('qc.disposition.holdReason')}
                  <input
                    className="qc-hold-reason"
                    value={holdReason}
                    onChange={(e) => setHoldReason(e.target.value)}
                  />
                </label>
              ) : null}

              {isTwoPart ? (
                <div className="qc-two-part">
                  <p className="qc-hint">
                    {t('qc.disposition.splitSummary')
                      .replace('{good}', String(good))
                      .replace('{notUsable}', String(notUsable))}
                  </p>
                  <p>{t('qc.disposition.goodPart').replace('{qty}', String(good))}</p>
                  <p>{t('qc.disposition.notUsablePart').replace('{qty}', String(notUsable))}</p>
                </div>
              ) : null}

              <div className="qc-decision-tiles">
                <button
                  type="button"
                  className={
                    decisionChoice === 'accept' && !acceptBlockedByHold
                      ? 'primary-action'
                      : 'secondary-action'
                  }
                  disabled={!isQcHead || acceptBlockedByHold}
                  aria-describedby={acceptBlockedByHold ? 'qc-accept-blocked-reason' : undefined}
                  onClick={() => setDecisionChoice('accept')}
                >
                  {t('qc.disposition.accept')}
                </button>
                <button
                  type="button"
                  className={
                    decisionChoice === 'reject' || acceptBlockedByHold
                      ? 'primary-action'
                      : 'secondary-action'
                  }
                  disabled={!isQcHead}
                  onClick={() => setDecisionChoice('reject')}
                >
                  {t('qc.disposition.reject')}
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  disabled
                  aria-describedby="qc-conditional-reason"
                >
                  {t('qc.disposition.conditional')}
                </button>
              </div>
              {acceptBlockedByHold ? (
                <p id="qc-accept-blocked-reason" className="qc-hint">
                  {t('qc.disposition.acceptDisabled')}
                </p>
              ) : null}
              <p id="qc-conditional-reason" className="qc-hint">
                {t('qc.disposition.conditionalDisabled')}
              </p>

              <label>
                {t('qc.disposition.justification')}
                <input value={justification} onChange={(e) => setJustification(e.target.value)} />
              </label>
              <label>
                {t('qc.disposition.defectCode')}
                <input value={defectCode} onChange={(e) => setDefectCode(e.target.value)} />
              </label>
              <button
                type="button"
                className="primary-action"
                disabled={!isQcHead || busy === 'disposition'}
                onClick={() => void recordDisposition()}
              >
                {busy === 'disposition' ? t('qc.disposition.recording') : t('qc.disposition.record')}
              </button>
            </fieldset>
          )}
          {retentionTaskId && isQcHead ? (
            <div className="qc-retention">
              <p>{t('qc.release.retentionFirst')}</p>
              <label>
                {t('qc.retention.quantity')}
                <input value={retentionQty} onChange={(e) => setRetentionQty(e.target.value)} />
              </label>
              <label>
                {t('qc.retention.location')}
                <input
                  value={retentionLocationId}
                  onChange={(e) => setRetentionLocationId(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="primary-action"
                disabled={busy === 'retention'}
                onClick={() => void logRetentionSample()}
              >
                {t('qc.retention.submit')}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {notice ? (
        <p className="qc-notice" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
