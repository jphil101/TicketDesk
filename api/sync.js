import { handleSync } from '../lib/sync-core.js';
import { getQuery, findDatabaseUrl } from '../lib/db.js';

// GET /api/sync → setup diagnostics (variable names and status only, never values).
async function diagnose() {
  const env = process.env;
  const found = findDatabaseUrl(env);
  const seen = Object.keys(env).filter(k => /DATABASE|POSTGRES|NEON|^PG/.test(k)).sort();
  const deployment = env.VERCEL_ENV || 'local';
  let database = 'not configured';
  if (found) {
    try { const q = await getQuery(); await q('select 1', []); database = 'reachable'; }
    catch { database = 'unreachable'; }
  }
  let next;
  if (database === 'reachable') next = 'Sync is set up. In the app, open Sync & backup and tap “Sync now”.';
  else if (database === 'unreachable') next = `${found.name} is set but the database didn't answer. Check the database in the Neon console (it may be suspended for the month or deleted), or reconnect it under Vercel → Storage.`;
  else if (seen.length) next = `Database variables exist (${seen.join(', ')}) but none ends in DATABASE_URL or POSTGRES_URL. Reconnect the database under Vercel → Storage without a custom prefix, then redeploy.`;
  else next = `No database variables in this ${deployment} deployment. In Vercel: Storage → your Neon database → Connect Project, tick ${deployment === 'preview' ? 'Preview' : 'Production'}, then Deployments → ⋯ → Redeploy. If you only just connected it, you just need to redeploy.`;
  return { ok: database === 'reachable', deployment, database, usingVariable: found ? found.name : null, databaseVariablesSeen: seen, next };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json(await diagnose());
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Use POST.' });
  }
  let query;
  try {
    query = await getQuery();
  } catch (e) {
    return res.status(503).json({ error: e.message, code: 'not_configured' });
  }
  try {
    const out = await handleSync({ query, auth: req.headers.authorization, body: req.body, env: process.env });
    return res.status(out.status).json(out.json);
  } catch (e) {
    console.error('sync failed', e);
    return res.status(500).json({ error: 'The sync server hit an error. Your changes are kept on this device and will be retried.' });
  }
}
