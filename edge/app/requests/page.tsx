import { EdgeClient } from '../../src/components/edge-client';

/** Story 1.15: the signed-in person's own requests; all state lives in the edge client. */
export default function MyRequestsPage() {
  return <EdgeClient view="my-requests" />;
}
