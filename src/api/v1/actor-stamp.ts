import type { IncomingMessage } from 'node:http';
import { getAuthorizedAssignment } from '../../middleware/context.js';
import { auditLocationFor } from '../../middleware/rbac.js';

export interface StampedActor {
  auditLocationId: string;
  eventLocationId: string;
}

/**
 * Pilot G2: the REST twin of the envelope-path stamp (events.ts / edge.ts, Pilot B1). A handler that
 * acts at ONE location passes it here and the actor is stamped with that location when a write
 * assignment of the module covers it from above (a site grant acting at a bin), on the event and on
 * the audit row alike. Everything else is returned unchanged: no single location (a site-level duty
 * such as an approval or a task spanning bins), an exact-match assignment (already that id), or a
 * wildcard assignment (the caller's own sentinel handling stays as it was). This only chooses the
 * stamp - the handler's own access check has already authorized the call and is not revisited.
 *
 * Review R7(d): only the AUTHORIZED assignment is consulted - the one the handler's actorContext
 * took `role` from - so the stamped role and the stamped location always describe one assignment.
 * Reading the caller's other write assignments could pair role X with a bin only role Y reaches.
 */
export function stampActedLocation<T extends StampedActor>(
  req: IncomingMessage,
  actor: T,
  module: string,
  actedLocationId: string | undefined,
): T {
  if (actedLocationId === undefined) return actor;
  const acted = actedLocationId.toLowerCase();
  const authorized = getAuthorizedAssignment(req);
  const covers =
    authorized !== undefined &&
    (authorized.module === module || authorized.module === '*') &&
    authorized.locationId !== '*' &&
    auditLocationFor(authorized, acted).toLowerCase() === acted;
  return covers ? { ...actor, auditLocationId: acted, eventLocationId: acted } : actor;
}
