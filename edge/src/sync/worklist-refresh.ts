import type { WorklistSnapshot } from '../local-db/worklist';

/**
 * Story 7.8 (Binding Decision 11): fetches the technician worklist. Called on app start when
 * online and on the `online` event (the edge-client connectivity pattern), NEVER on a timer.
 * Returns null when offline or when the server is unreachable; the cached snapshot stays in place.
 */
export async function refreshWorklist(apiBaseUrl = ''): Promise<WorklistSnapshot | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/edge/maintenance/worklist`, {
      credentials: 'include',
    });
    if (!response.ok) return null;
    return (await response.json()) as WorklistSnapshot;
  } catch {
    return null;
  }
}
