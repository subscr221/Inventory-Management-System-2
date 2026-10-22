import { EdgeClient } from '../../../src/components/edge-client';

/** Story 3.16 (AC 1): the floor task inbox and pick execution screen; `?task=` opens a pick list. */
export default function FloorTasksPage() {
  return <EdgeClient view="floor-tasks" />;
}
