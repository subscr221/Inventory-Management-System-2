import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web';
import { EdgeSchema } from './schema';

export function createEdgeDatabase(): PowerSyncDatabase {
  if (typeof window === 'undefined') {
    throw new Error('Edge database is only available in the browser');
  }

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
