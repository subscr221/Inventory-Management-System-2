import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web';
import { EdgeSchema } from './schema';

export function createEdgeDatabase(): PowerSyncDatabase {
  if (typeof window === 'undefined') {
    throw new Error('Edge database is only available in the browser');
  }

  // Story 1.13 (AD-18): never call disconnectAndClear() without { clearLocal: false } - the default
  // also wipes local-only tables, including edge_outbox_retained (refused and parked captures).
  return new PowerSyncDatabase({
    schema: EdgeSchema,
    database: new WASQLiteOpenFactory({
      dbFilename: 'inventory-edge.db',
      vfs: WASQLiteVFS.OPFSCoopSyncVFS,
      flags: {
        enableMultiTabs: typeof SharedWorker !== 'undefined',
      },
    }),
    flags: {
      enableMultiTabs: typeof SharedWorker !== 'undefined',
    },
  });
}
