import { EdgeClient } from '../../src/components/edge-client';

/** Story 3.13: the gate entry and weighbridge capture screen; state lives in the edge client. */
export default function GateEntryPage() {
  return <EdgeClient view="gate" />;
}
