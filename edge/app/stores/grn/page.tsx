import { EdgeClient } from '../../../src/components/edge-client';

/** Story 3.15 (AC 5): GRN read card and label queue; `?grn=` selects the receipt. */
export default function GrnPage() {
  return <EdgeClient view="grn-read" />;
}
