import { Pool } from "pg";

let pool: Pool | undefined;

export function db(): Pool {
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}
