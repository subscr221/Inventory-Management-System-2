import { EdgeClient } from '../../../src/components/edge-client';

/** Story 1.14: the site supervisor's refused-captures screen; all state lives in the edge client. */
export default function RefusedCapturesPage() {
  return <EdgeClient view="refused-captures" />;
}
