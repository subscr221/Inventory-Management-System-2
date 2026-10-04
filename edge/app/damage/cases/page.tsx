import { EdgeClient } from '../../../src/components/edge-client';

/**
 * Story 8.9: the damage cases workbench (QC, stores, finance, CEO). The selected case is the
 * `?case=<id>` query parameter: the edge app has no dynamic route segments.
 */
export default function DamageCasesPage() {
  return <EdgeClient view="damage-cases" />;
}
