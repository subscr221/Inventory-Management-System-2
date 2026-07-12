export const config = {
  port: Number(process.env['PORT'] ?? 3000),
  hostname: process.env['HOSTNAME'] ?? '0.0.0.0',
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  db: {
    host: process.env['DB_HOST'] ?? 'localhost',
    port: Number(process.env['DB_PORT'] ?? 5432),
    database: process.env['DB_NAME'] ?? 'inventory_events',
    user: process.env['DB_USER'] ?? 'app_user',
    password: process.env['DB_PASSWORD'] ?? 'app_password',
    max: Number(process.env['DB_POOL_MAX'] ?? 20),
    ssl: process.env['DB_SSL'] === 'true',
  },
} as const;
