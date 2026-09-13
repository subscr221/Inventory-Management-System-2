import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

/**
 * The IST pin (deferred-work 215 and 616, decided 2026-09-04, applied 2026-09-13). Every session
 * this process opens runs with the business calendar's zone, so `CURRENT_DATE` and `now()::date`
 * in SQL agree with `toIstCalendarDate` in TypeScript instead of with the host's clock, and
 * `DateStyle` is ISO so a `::text` read of a DATE is always YYYY-MM-DD. A DATE column is returned
 * as that same string, never a midnight-UTC `Date` the driver would shift on a non-UTC host
 * (OID 1082 is PostgreSQL's DATE). Both pools share the pin; the test harness inherits it.
 */
export const DB_SESSION_TIME_ZONE = 'Asia/Kolkata';
export const DB_SESSION_OPTIONS = `-c TimeZone=${DB_SESSION_TIME_ZONE} -c DateStyle=ISO`;
pg.types.setTypeParser(1082, (value: string) => value);

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      max: config.db.max,
      ssl: config.db.ssl ? true : false,
      options: DB_SESSION_OPTIONS,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

let adminPool: pg.Pool | null = null;

/**
 * Connection pool for DDL only (migrations, test schema setup). The app's runtime pool
 * (getPool()) always connects as the least-privilege app_user, which has no CREATE
 * privilege on the public schema by design (PostgreSQL 15+ default) - DDL must go
 * through admin_user instead. Never use this pool for request-serving queries.
 */
export function getAdminPool(): pg.Pool {
  if (!adminPool) {
    adminPool = new Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.adminUser,
      password: config.db.adminPassword,
      max: 5,
      ssl: config.db.ssl ? true : false,
      options: DB_SESSION_OPTIONS,
    });
  }
  return adminPool;
}

export async function closeAdminPool(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
    adminPool = null;
  }
}
