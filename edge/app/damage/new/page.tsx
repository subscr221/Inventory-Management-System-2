import { EdgeClient } from '../../../src/components/edge-client';

/** Story 8.9: report damage from the employee base role; all state lives in the edge client. */
export default function ReportDamagePage() {
  return <EdgeClient view="report-damage" />;
}
