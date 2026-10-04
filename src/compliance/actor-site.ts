import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { AppError } from '../middleware/error.js';

/** Stamped on the event actor when the authorizing assignment is the `*` wildcard. */
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The one "actor must be at the site" rule for the compliance seams (Pilot F1).
 *
 * With hierarchy coverage a site-scoped user acting at a bin is stamped with the BIN id (see
 * auditLocationFor in src/middleware/rbac.ts), so comparing the stamp to the site id by equality
 * refused callers who are legitimately at the site. The actor's location belongs to the site when
 * it IS the site or its location_register.site_id names that site. Nothing else widens: a location
 * of another site, or one the register does not know, is refused, and the wildcard sentinel is
 * unrestricted exactly as before. Pass the seam's transaction client where one exists.
 */
export async function assertActorAtSite(
  actorLocationId: string,
  siteId: string,
  context: Record<string, unknown> = {},
  client?: PoolClient,
): Promise<void> {
  if (actorLocationId === NO_LOCATION_UUID || actorLocationId === siteId) return;
  const result = await (client ?? getPool()).query(
    `SELECT 1 FROM location_register WHERE location_id = $1 AND site_id = $2`,
    [actorLocationId, siteId],
  );
  if (result.rows.length > 0) return;
  throw new AppError(
    403,
    'LOCATION_ACCESS_DENIED',
    `No assignment grants access to site "${siteId}"`,
    {
      ...context,
      actor_location_id: actorLocationId,
      site_id: siteId,
    },
  );
}

/**
 * The sibling of assertActorAtSite for seams that fall back to the actor's location AS a site id
 * (Pilot R5). The stamp can be a bin, so the fallback is the location's site: its
 * location_register.site_id, or itself when it is the site. The wildcard sentinel and a location
 * the register does not know are returned unchanged - callers keep their own sentinel handling, and
 * nothing is invented for an unknown id. Pass the seam's transaction client where one exists.
 */
export async function resolveActorSiteId(
  actorLocationId: string,
  client?: PoolClient,
): Promise<string> {
  if (actorLocationId === NO_LOCATION_UUID) return actorLocationId;
  const result = await (client ?? getPool()).query(
    `SELECT COALESCE(site_id, location_id) AS site_id FROM location_register WHERE location_id = $1`,
    [actorLocationId],
  );
  return result.rows.length > 0 ? (result.rows[0]['site_id'] as string) : actorLocationId;
}
