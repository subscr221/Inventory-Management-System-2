/**
 * Why /api/v1/edge/bootstrap did not answer 200. A person whose account has no single concrete
 * site is not "waiting for a first sync": nothing will ever sync until an administrator fixes the
 * assignment, so the shell says that instead (simulated pilot, 2026-09-23).
 */
export type BootstrapRefusal = 'no_site' | 'ambiguous_site' | 'unavailable';

export async function classifyBootstrapRefusal(response: Response): Promise<BootstrapRefusal> {
  let code: unknown;
  try {
    code = ((await response.json()) as { error_code?: unknown }).error_code;
  } catch {
    return 'unavailable';
  }
  if (response.status === 403 && code === 'EDGE_NO_CONCRETE_SITE') return 'no_site';
  if (response.status === 409 && code === 'EDGE_AMBIGUOUS_SITE') return 'ambiguous_site';
  return 'unavailable';
}
