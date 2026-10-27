'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
  /** Label for the manual-entry action; the gate's challan wording is the default. */
  typeLabel?: string;
}

/**
 * The wedge finishes a scan with Enter; the trimmed value is the scanned code. Both rules live in
 * ../capture/scan so they are unit-testable without a DOM.
 */

/** Viewfinder mark used inside every scan box (key-desk scan glyph). Decorative only. */
export function ScanMark() {
  return (
    <svg
      className="scan-mark"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 8V5a1 1 0 0 1 1-1h3" />
      <path d="M16 4h3a1 1 0 0 1 1 1v3" />
      <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
      <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M7 12h10" />
    </svg>
  );
}

/** Scan control chrome: the mark sits inside the box, to the left of the text. */
export function ScanInputBox({ children }: { children: ReactNode }) {
  return (
    <div className="scan-input-box">
      <span className="scan-input-icon" aria-hidden="true">
        <ScanMark />
      </span>
      {children}
    </div>
  );
}

export function ScanField({
  id,
  label,
  value,
  placeholder,
  disabled = false,
  onScan,
  onChange,
  cameraAvailable,
  typeLabel,
}: ScanFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelRef = useRef(false);
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

  const stopCamera = useCallback(() => {
    cancelRef.current = true;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Release the camera when the field unmounts mid-scan.
  useEffect(() => stopCamera, [stopCamera]);

  async function scanWithCamera(): Promise<void> {
    setCameraError('');
    const detectorCtor = (
      window as unknown as {
        BarcodeDetector?: new (o?: unknown) => {
          detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
        };
      }
    ).BarcodeDetector;
    if (!detectorCtor || !navigator.mediaDevices?.getUserMedia) {
      setCameraError(t('gate.cameraUnavailable'));
      return;
    }
    cancelRef.current = false;
    setCameraOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      if (cancelRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('no viewfinder');
      video.srcObject = stream;
      await video.play();
      const detector = new detectorCtor();
      // Poll frames until a code is found, the officer cancels, or the field unmounts.
      while (!cancelRef.current) {
        const results = await detector.detect(video);
        const first = results[0];
        if (first && normalizeScanValue(first.rawValue)) {
          stopCamera();
          setCameraOpen(false);
          accept(first.rawValue);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch {
      stopCamera();
      setCameraOpen(false);
      setCameraError(t('gate.cameraUnavailable'));
    }
  }

  return (
    <div className="scan-field">
      <label htmlFor={id}>{label}</label>
      <ScanInputBox>
        <input
          id={id}
          ref={inputRef}
          className="scan-input"
          name={id}
          autoComplete="off"
          autoCapitalize="characters"
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
      </ScanInputBox>
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
          {typeLabel ?? t('gate.typeNumber')}
        </button>
        {canUseCamera ? (
          <button
            type="button"
            className="secondary-action"
            disabled={disabled}
            onClick={() => {
              if (cameraOpen) {
                stopCamera();
                setCameraOpen(false);
              } else {
                void scanWithCamera();
              }
            }}
          >
            {cameraOpen ? t('gate.stopCamera') : t('gate.scanWithCamera')}
          </button>
        ) : null}
      </div>
      <video
        ref={videoRef}
        className="scan-viewfinder"
        muted
        playsInline
        hidden={!cameraOpen}
        aria-label={t('gate.viewfinder')}
      />
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
