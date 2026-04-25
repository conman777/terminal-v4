export interface NeonUser {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: string;
}

interface QueryablePool {
  query<T>(text: string, params: unknown[]): Promise<{ rows: T[] }>;
}

let poolPromise: Promise<QueryablePool> | null = null;

async function getPool(): Promise<QueryablePool> {
  if (!process.env.STORAGE_DATABASE_URL) {
    throw new Error('STORAGE_DATABASE_URL is not configured');
  }

  if (!poolPromise) {
    poolPromise = import('pg').then(({ default: pg }) => {
      const { Pool } = pg;
      return new Pool({
        connectionString: process.env.STORAGE_DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 3,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000
      }) as unknown as QueryablePool;
    });
  }

  return poolPromise;
}

export async function getNeonUserByIdentifier(identifier: string): Promise<NeonUser | undefined> {
  const normalized = identifier.toLowerCase();
  const result = await (await getPool()).query<NeonUser>(
    `SELECT id, email, password_hash, display_name, created_at
     FROM users
     WHERE lower(email) = $1 OR lower(coalesce(display_name, '')) = $1
     LIMIT 1`,
    [normalized]
  );
  return result.rows[0] || undefined;
}

export async function getNeonUserByEmail(email: string): Promise<NeonUser | undefined> {
  const result = await (await getPool()).query<NeonUser>(
    'SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  return result.rows[0] || undefined;
}

export async function getNeonUserById(id: string): Promise<NeonUser | undefined> {
  const result = await (await getPool()).query<NeonUser>(
    'SELECT id, email, password_hash, display_name, created_at FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || undefined;
}
