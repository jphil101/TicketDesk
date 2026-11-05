// Morning summary. Vercel Cron calls this once a day (see "crons" in vercel.json).
import { handleDigest } from '../lib/notify-core.js';
import { getQuery } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let query;
  try { query = await getQuery(); } catch (e) { return res.status(503).json({ error: e.message, code: 'not_configured' }); }
  try {
    const out = await handleDigest({ query, auth: req.headers.authorization, env: process.env });
    return res.status(out.status).json(out.json);
  } catch (e) {
    console.error('digest failed', e);
    return res.status(500).json({ error: 'Digest failed.' });
  }
}
