'use client';

import { useEffect, useState } from 'react';

/**
 * EXPERIENCE.md Foundation: four device classes, chosen by viewport width plus the pointer media
 * query, never by role or device name. The class decides the nav surface; density itself is bound
 * in CSS (globals.css) to the same breakpoints, so the two can never disagree.
 */
export type DeviceClass = 'handheld' | 'tablet' | 'desktop' | 'desktop-touch';

/** Widths under this are Handheld. */
export const HANDHELD_BELOW = 600;
/** Widths above this are Desktop or Desktop touch; up to and including it is Tablet. */
export const TABLET_MAX = 1100;

const COARSE_POINTER = '(pointer: coarse)';
const RESIZE_DEBOUNCE_MS = 50;

/** What the server renders and the first client paint assumes, so hydration always matches. */
const SERVER_DEVICE_CLASS: DeviceClass = 'desktop';

/**
 * Pure classification. Below the desktop breakpoint the width alone decides (a small viewport is
 * touch-roomy whatever the pointer); above it the primary pointer splits compact from touch. The
 * primary pointer is used, not `any-pointer`, so a laptop with a touchscreen and a mouse stays
 * compact, exactly as the `(pointer: coarse)` block in globals.css treats it.
 */
export function classifyDevice(width: number, coarsePointer: boolean): DeviceClass {
  if (width < HANDHELD_BELOW) return 'handheld';
  if (width <= TABLET_MAX) return 'tablet';
  return coarsePointer ? 'desktop-touch' : 'desktop';
}

export function useDeviceClass(): DeviceClass {
  const [deviceClass, setDeviceClass] = useState<DeviceClass>(SERVER_DEVICE_CLASS);

  useEffect(() => {
    const coarse = window.matchMedia(COARSE_POINTER);
    const read = () => setDeviceClass(classifyDevice(window.innerWidth, coarse.matches));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(read, RESIZE_DEBOUNCE_MS);
    };

    read();
    window.addEventListener('resize', onResize);
    // Docking a tablet to a mouse (or undocking it) flips the primary pointer without a resize.
    coarse.addEventListener('change', read);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      coarse.removeEventListener('change', read);
    };
  }, []);

  return deviceClass;
}
