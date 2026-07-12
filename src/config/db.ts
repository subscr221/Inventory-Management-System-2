import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

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
