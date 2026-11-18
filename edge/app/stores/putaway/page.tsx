import { EdgeClient } from '../../../src/components/edge-client';

/** Story 3.15 (AC 3): directed putaway detail; `?task=` selects the task. */
export default function PutawayPage() {
  return <EdgeClient view="putaway-task" />;
}
