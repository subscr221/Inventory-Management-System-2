import { EdgeClient } from '../../../src/components/edge-client';

/** Story 3.18 (AC 1): the pack station list and dispatch screen; `?dispatch=` opens a pack station. */
export default function PackPage() {
  return <EdgeClient view="pack-dispatch" />;
}
