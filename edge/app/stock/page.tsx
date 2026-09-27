import { EdgeClient } from '../../src/components/edge-client';

/** Story 1.15: the employee base role's stock availability check; all state lives in the edge client. */
export default function StockPage() {
  return <EdgeClient view="check-stock" />;
}
