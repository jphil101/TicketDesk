// Returns a `query(text, params) → rows` function.
// Default: Neon's HTTP driver (works well from serverless functions).
// Set DB_DRIVER=pg to use node-postgres instead (any other Postgres, e.g. Supabase or local).

let cached = null;

export async function getQuery(env = process.env) {
  if (cached) return cached;
  const url = env.DATABASE_URL || env.POSTGRES_URL;
  if (!url) {
    const err = new Error('Sync isn’t set up on this server yet: DATABASE_URL is missing.');
    err.code = 'not_configured';
    throw err;
  }
  if (String(env.DB_DRIVER || '').toLowerCase() === 'pg') {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    cached = (text, params) => pool.query(text, params).then(r => r.rows);
  } else {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    cached = (text, params) => sql.query(text, params);
  }
  return cached;
}
