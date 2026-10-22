import { EdgeClient } from '../../src/components/edge-client';

/** Story 3.14 (AC 1): the storekeeper's task inbox; all state lives in the edge client. */
export default function StoresPage() {
  return <EdgeClient view="stores" />;
}
