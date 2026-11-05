import { handleNotify } from '../lib/notify-core.js';
import { getQuery } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST.' }); }
  let query;
  try { query = await getQuery(); } catch (e) { return res.status(503).json({ error: e.message, code: 'not_configured' }); }
  try {
    const out = await handleNotify({ query, auth: req.headers.authorization, body: req.body, env: process.env });
    return res.status(out.status).json(out.json);
  } catch (e) {
    console.error('notify failed', e);
    return res.status(500).json({ error: 'The server hit an error. Try again in a moment.' });
  }
}
