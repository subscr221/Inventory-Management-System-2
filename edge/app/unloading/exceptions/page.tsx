import { EdgeClient } from '../../../src/components/edge-client';

/** Story 3.20: the unloading exceptions inbox; `?case=gate:<id>` or `?case=line:<id>` opens one. */
export default function UnloadingExceptionsPage() {
  return <EdgeClient view="unloading-exceptions" />;
}
