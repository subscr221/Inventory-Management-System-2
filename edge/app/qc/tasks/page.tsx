import { EdgeClient } from '../../../src/components/edge-client';

/** Story 8.11 (AC 1): the QC inspector's inbox; `?task=` opens an inspection detail. */
export default function QcTasksPage() {
  return <EdgeClient view="qc-tasks" />;
}
