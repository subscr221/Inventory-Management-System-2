'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/locale';
import { isScanSubmitKey, normalizeScanValue } from '../capture/scan';

/**
 * Story 3.13 (Task 2): the shared scan control. It covers the three capture paths a gate officer
 * actually has: a hardware trigger (which emits keydown events into the focused input), a keyboard
 * wedge (the same, character by character), and typing. On a coarse-pointer device it can also
 * decode a QR/barcode with the platform `BarcodeDetector` when that exists; no npm dependency is
 * added, and when it does not exist the control renders only the `Scan again` / `Type` actions.
 */

export interface ScanFieldProps {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onScan: (value: string) => void;
  onChange: (value: string) => void;
  /** Test seam: force the coarse-pointer/camera path on or off. */
  cameraAvailable?: boolean;
}

/**
 * The wedge finishes a scan with Enter; the trimmed value is the scanned code. Both rules live in
 * ../capture/scan so they are unit-testable without a DOM.
 */

export function ScanField({
  id,
  label,
  value,
  placeholder,
  disabled = false,
  onScan,
  onChange,
  cameraAvailable,
}: ScanFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const canUseCamera =
    cameraAvailable === undefined
      ? typeof window !== 'undefined' &&
        typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined'
      : cameraAvailable;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const accept = useCallback(
    (raw: string) => {
      const scanned = normalizeScanValue(raw);
      if (!scanned) return;
      onChange(scanned);
      onScan(scanned);
      setAnnouncement(t('gate.scanAnnouncement').replace('{value}', scanned));
    },
    [onChange, onScan],
  );

  async function scanWithCamera(): Promise<void> {
    setCameraError('');
    const detectorCtor = (window as unknown as { BarcodeDetector?: new (o?: unknown) => { detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>> } })
      .BarcodeDetector;
    if (!detectorCtor) {
      setCameraError(t('gate.cameraUnavailable'));
      return;
    }
    try {
      setCameraOpen(true);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();
      const detector = new detectorCtor();
      const results = await detector.detect(video);
      stream.getTracks().forEach((track) => track.stop());
      setCameraOpen(false);
      const first = results[0];
      if (first) accept(first.rawValue);
    } catch {
      setCameraOpen(false);
      setCameraError(t('gate.cameraUnavailable'));
    }
  }

  return (
    <div className="scan-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        ref={inputRef}
        className="scan-input"
        name={id}
        autoComplete="off"
        autoCapitalize="characters"
        maxLength={64}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (isScanSubmitKey(event.key, event.shiftKey)) {
            event.preventDefault();
            accept(event.currentTarget.value);
          }
        }}
      />
      <div className="scan-field-actions">
        <button
          type="button"
          className="secondary-action"
          disabled={disabled}
          onClick={() => {
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
        >
          {t('gate.scanAgain')}
        </button>
        <button
          type="button"
          className="secondary-action"
          disabled={disabled}
          onClick={() => {
            inputRef.current?.focus();
          }}
        >
          {t('gate.typeNumber')}
        </button>
        {canUseCamera ? (
          <button
            type="button"
            className="secondary-action"
            disabled={disabled || cameraOpen}
            onClick={() => void scanWithCamera()}
          >
            {t('gate.scanWithCamera')}
          </button>
        ) : null}
      </div>
      {cameraError ? (
        <p className="base-hint" role="status">
          {cameraError}
        </p>
      ) : null}
      <p className="base-hint" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
