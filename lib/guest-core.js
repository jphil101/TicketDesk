// Guest links: time-limited access for other people to send tickets to a desk,
// and optionally to see its open tickets (read-only, without notes).
//
//   POST /api/guest
//   Owner (Authorization: Bearer <sync key>)
//     { action: "status" }                      → { active: { mode, expiresAt, createdAt, submissions } | null, pending }
//     { action: "create", mode, ttlMinutes }    → { token, mode, expiresAt }   (replaces any existing link)
//     { action: "revoke" }                      → { ok: true }
//   Guest (Authorization: Guest <token>)
//     { action: "info" }                        → { mode, expiresAt, tasks? }
//     { action: "submit", name, urgency, impact, from? } → { ok: true }
//
// Only a SHA-256 of the guest token is stored. One link per desk is live at a time.
// Guest submissions become items of kind "requests", so they reach the owner's devices
// through the normal sync and are accepted or declined there.

import { createHash, randomBytes } from 'node:crypto';
import { ensureSchema, resolveDesk, pushItems, fail } from './sync-core.js';

export const GUEST_MODES = new Set(['submit', 'view']);
export const MIN_TTL = 15, MAX_TTL = 7 * 24 * 60;          // minutes
export const MAX_PENDING = 50;                            // unreviewed requests per desk
export const MAX_PER_LINK = 200;                          // submissions per link
export const MAX_BOARD = 300;                             // tasks shown to a viewing guest

const hashToken = t => createHash('sha256').update(t).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const iso = v => new Date(v).toISOString();
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function pendingCount(query, desk) {
  const r = await query(`select count(*)::int as n from items where desk = $1 and kind = 'requests' and not deleted`, [desk]);
  return Number(r[0].n);
}

async function liveLink(query, token) {
  if (!TOKEN_RE.test(token || '')) return null;
  const r = await query(
    `select token_hash, desk, mode, expires_at, submissions from guest_links where token_hash = $1 and expires_at > now()`,
    [hashToken(token)],
  );
  return r[0] || null;
}

export async function handleGuest({ query, auth, body, env = {} }) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return fail(400, 'Request body must be JSON.'); } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Request body must be a JSON object.');
  const action = body.action;
  await ensureSchema(query);

  // ----- guest side -----
  const g = /^Guest\s+(\S+)$/i.exec(auth || '');
  if (g) {
    const link = await liveLink(query, g[1]);
    if (!link) return fail(410, 'This guest link has expired or was turned off. Ask for a new one.', { code: 'expired' });

    if (action === 'info') {
      const out = { mode: link.mode, expiresAt: iso(link.expires_at) };
      if (link.mode === 'view') {
        const rows = await query(
          `select body from items
           where desk = $1 and kind = 'tasks' and not deleted and coalesce((body->>'done')::boolean, false) = false
           order by body->>'day', (body->>'seq')::int nulls last limit $2`,
          [link.desk, MAX_BOARD],
        );
        out.tasks = rows.map(({ body: t }) => ({
          seq: Number(t.seq) || 0, name: clip(t.name, 200), urgency: t.urgency, impact: t.impact,
          day: t.day, carriedFrom: t.carriedFrom || null, recurring: !!t.ruleId,
        }));
      }
      return { status: 200, json: out };
    }

    if (action === 'submit') {
      const name = clip(body.name, 200), from = clip(body.from, 60);
      const u = body.urgency, i = body.impact;
      if (!name) return fail(400, 'Add a short description of the task.');
      if (![1, 2, 3].includes(u) || ![1, 2, 3].includes(i)) return fail(400, 'Pick an urgency and an impact.');
      if (link.submissions >= MAX_PER_LINK) return fail(429, 'This link has reached its limit. Ask for a new one.');
      if (await pendingCount(query, link.desk) >= MAX_PENDING) return fail(429, 'The owner has a lot of requests waiting. Try again once they’ve caught up.');
      const now = Date.now();
      const id = 'g' + now.toString(36) + randomBytes(5).toString('hex');
      await pushItems(query, link.desk, [{
        kind: 'requests', id, deleted: false, updated_at: now,
        body: { id, name, urgency: u, impact: i, from, submittedAt: now, updatedAt: now },
      }]);
      await query('update guest_links set submissions = submissions + 1 where token_hash = $1', [link.token_hash]);
      return { status: 200, json: { ok: true } };
    }
    return fail(400, 'Unknown action.');
  }

  // ----- owner side -----
  const who = await resolveDesk(query, auth, env);
  if (who.error) return who.error;
  const { desk } = who;

  if (action === 'status') {
    const r = await query(
      `select mode, created_at, expires_at, submissions from guest_links where desk = $1 and expires_at > now() order by created_at desc limit 1`,
      [desk],
    );
    const a = r[0];
    return { status: 200, json: {
      active: a ? { mode: a.mode, createdAt: iso(a.created_at), expiresAt: iso(a.expires_at), submissions: Number(a.submissions) } : null,
      pending: await pendingCount(query, desk),
    } };
  }

  if (action === 'create') {
    const mode = body.mode;
    const ttl = body.ttlMinutes;
    if (!GUEST_MODES.has(mode)) return fail(400, 'Choose what guests can do.');
    if (!Number.isInteger(ttl) || ttl < MIN_TTL || ttl > MAX_TTL) return fail(400, `Choose a duration between ${MIN_TTL} minutes and 7 days.`);
    const token = randomBytes(24).toString('base64url');
    await query('delete from guest_links where desk = $1 or expires_at < now() - interval \'7 days\'', [desk]);
    const r = await query(
      `insert into guest_links (token_hash, desk, mode, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4)) returning expires_at`,
      [hashToken(token), desk, mode, ttl],
    );
    return { status: 200, json: { token, mode, expiresAt: iso(r[0].expires_at) } };
  }

  if (action === 'revoke') {
    await query('delete from guest_links where desk = $1', [desk]);
    return { status: 200, json: { ok: true } };
  }
  return fail(400, 'Unknown action.');
}
