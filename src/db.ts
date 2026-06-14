// Postgres access — a single shared pool. Mantle Push owns this database; it is
// deliberately separate from the Mantle "brain" DB so relay metadata never
// touches user data (see push-notifications.md §7.2).

import pg from 'pg';
import { config } from './config.ts';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
