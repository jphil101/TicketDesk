// Returns a `query(text, params) → rows` function.
// Default: Neon's HTTP driver (works well from serverless functions).
// Set DB_DRIVER=pg to use node-postgres instead (any other Postgres, e.g. Supabase or local).

let cached = null;

// Vercel's Neon integration names the variable DATABASE_URL, or <PREFIX>_DATABASE_URL when a
// custom prefix was typed while connecting the database. Accept any of those.
export function findDatabaseUrl(env = process.env) {
  for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL']) {
    if (env[name]) return { name, url: env[name] };
  }
  const name = Object.keys(env).sort().find(k => /_(DATABASE_URL|POSTGRES_URL)$/.test(k) && env[k]);
  return name ? { name, url: env[name] } : null;
}

export async function getQuery(env = process.env) {
  if (cached) return cached;
  const found = findDatabaseUrl(env);
  if (!found) {
    const err = new Error('Sync isn’t set up on this server yet: no DATABASE_URL. Open /api/sync on this site for details.');
    err.code = 'not_configured';
    throw err;
  }
  if (String(env.DB_DRIVER || '').toLowerCase() === 'pg') {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: found.url, max: 3 });
    cached = (text, params) => pool.query(text, params).then(r => r.rows);
  } else {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(found.url);
    cached = (text, params) => sql.query(text, params);
  }
  return cached;
}
