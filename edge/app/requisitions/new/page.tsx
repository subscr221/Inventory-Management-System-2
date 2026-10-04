import { EdgeClient } from '../../../src/components/edge-client';

/** Story 1.15: raise a requisition from the employee base role; all state lives in the edge client. */
export default function NewRequisitionPage() {
  return <EdgeClient view="new-requisition" />;
}
