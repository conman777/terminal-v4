import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.STORAGE_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

export interface NeonUser {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: string;
}

export async function getNeonUserByEmail(email: string): Promise<NeonUser | undefined> {
  const result = await getPool().query(
    'SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  return result.rows[0] || undefined;
}

export async function getNeonUserById(id: string): Promise<NeonUser | undefined> {
  const result = await getPool().query(
    'SELECT id, email, password_hash, display_name, created_at FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || undefined;
}
