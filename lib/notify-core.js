// Notifications: web push (free, no account) and optional email through Resend's free plan.
//
//   POST /api/notify  (owner, Authorization: Bearer <sync key>)
//     { action: "status", endpoint? }       → { publicKey, device, email, emailAvailable, digestUtc }
//     { action: "subscribe", subscription, tz, prefs }
//     { action: "prefs", endpoint, prefs }
//     { action: "unsubscribe", endpoint }
//     { action: "test", endpoint? }          → { sent, failed }
//     { action: "email", address, guest, digest, tz }
//     { action: "testEmail" }
//   GET /api/digest  (Vercel cron, once a day) → morning summary, at most once per local day per recipient
//
// Push keys (VAPID) are generated on first use and stored in the database, so push needs no setup.
// Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to supply your own. Email needs RESEND_API_KEY.

import webpush from 'web-push';
import { ensureSchema, resolveDesk, fail } from './sync-core.js';

export const DIGEST_UTC = '02:00';             // keep in step with the cron in vercel.json
export const MAX_SUBS_PER_DESK = 10;
const PRIO_NAME = {1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low', 5: 'Planning'};
const prio = (u, i) => 7 - (u + i);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

export function validTz(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
export function localDay(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: validTz(tz) ? tz : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const vapidCache = new WeakMap();
export async function getVapid(query, env = {}) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  if (vapidCache.has(query)) return vapidCache.get(query);
  await ensureSchema(query);
  let r = await query(`select value from settings where key = 'vapid'`, []);
  if (!r.length) {
    const keys = webpush.generateVAPIDKeys();
    await query(`insert into settings (key, value) values ('vapid', $1::jsonb) on conflict (key) do nothing`, [JSON.stringify(keys)]);
    r = await query(`select value from settings where key = 'vapid'`, []);   // another instance may have won the race
  }
  vapidCache.set(query, r[0].value);
  return r[0].value;
}
const subject = env => env.VAPID_SUBJECT || (env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + env.VERCEL_PROJECT_PRODUCTION_URL : 'mailto:ticket-desk@example.com');

function validSubscription(s, env) {
  if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string' || s.endpoint.length > 1000) return false;
  let u; try { u = new URL(s.endpoint); } catch { return false; }
  if (u.protocol !== 'https:' && !(env.ALLOW_HTTP_PUSH === '1' && u.protocol === 'http:')) return false;
  const k = s.keys || {};
  return typeof k.p256dh === 'string' && typeof k.auth === 'string' && k.p256dh.length < 200 && k.auth.length < 100;
}
const cleanPrefs = p => ({ guest: p?.guest !== false, digest: p?.digest !== false });

export async function sendPush(query, env, rows, payload) {
  if (!rows.length) return { sent: 0, failed: 0 };
  const v = await getVapid(query, env);
  const opts = { vapidDetails: { subject: subject(env), publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 12 * 3600, urgency: 'high', timeout: 5000 };
  let sent = 0, failed = 0;
  await Promise.all(rows.map(async row => {
    // web-push encrypts and signs; the request itself goes out with fetch.
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const d = webpush.generateRequestDetails(row.sub, JSON.stringify(payload), opts);
      const headers = { ...d.headers }; delete headers['Content-Length'];
      const res = await fetch(d.endpoint, { method: d.method, headers, body: d.body, signal: ctl.signal });
      if (res.ok) { sent++; return; }
      failed++;
      // Gone, or signed with keys it no longer accepts: the subscription is dead, so forget it.
      if ([403, 404, 410].includes(res.status)) await query('delete from push_subs where endpoint = $1', [row.endpoint]).catch(() => {});
    } catch { failed++; }
    finally { clearTimeout(timer); }
  }));
  return { sent, failed };
}

export async function sendEmail(env, to, subjectLine, text) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'Email isn’t set up on this server.' };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(env.RESEND_API_URL || 'https://api.resend.com/emails', {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM || 'Ticket Desk <onboarding@resend.dev>', to: [to], subject: subjectLine, text }),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.message || `Resend answered ${res.status}.` };
  } catch { return { ok: false, error: 'Couldn’t reach the email service.' }; }
  finally { clearTimeout(timer); }
}

// Called after a guest submits. Never throws.
export async function notifyGuestTicket(query, env, desk, r) {
  try {
    const p = prio(r.urgency, r.impact);
    const line = `P${p} ${PRIO_NAME[p]} · ${r.name}`;
    const subs = await query(`select endpoint, sub from push_subs where desk = $1 and coalesce((prefs->>'guest')::boolean, true)`, [desk]);
    const mail = await query(`select email from desk_settings where desk = $1 and email is not null and email_guest`, [desk]);
    await Promise.all([
      sendPush(query, env, subs, { title: r.from ? `New ticket from ${r.from}` : 'New guest ticket', body: line, tag: 'guest-' + r.id, url: '/#day' }),
      mail[0] ? sendEmail(env, mail[0].email, `New guest ticket: ${r.name}`,
        `${r.from ? r.from + ' sent' : 'A guest sent'} a ticket to your desk:\n\n  ${line}\n  Urgency ${['', 'Low', 'Medium', 'High'][r.urgency]}, impact ${['', 'Low', 'Medium', 'High'][r.impact]}\n\nOpen Ticket Desk to add it to today or decline it.\n`) : null,
    ]);
  } catch (e) { console.error('guest notification failed', e); }
}

export async function handleNotify({ query, auth, body, env = {} }) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return fail(400, 'Request body must be JSON.'); } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Request body must be a JSON object.');
  const who = await resolveDesk(query, auth, env);
  if (who.error) return who.error;
  const { desk } = who;
  const a = body.action;

  if (a === 'status') {
    const v = await getVapid(query, env);
    let device = null;
    if (typeof body.endpoint === 'string') {
      const r = await query('select prefs from push_subs where endpoint = $1 and desk = $2', [body.endpoint, desk]);
      if (r[0]) device = { prefs: cleanPrefs(r[0].prefs) };
    }
    const m = await query('select email, email_guest, email_digest from desk_settings where desk = $1', [desk]);
    return { status: 200, json: {
      publicKey: v.publicKey, device, digestUtc: DIGEST_UTC, emailAvailable: !!env.RESEND_API_KEY,
      email: m[0] && m[0].email ? { address: m[0].email, guest: m[0].email_guest, digest: m[0].email_digest } : null,
    } };
  }

  if (a === 'subscribe') {
    const s = body.subscription;
    if (!validSubscription(s, env)) return fail(400, 'That push subscription isn’t valid.');
    const tz = validTz(body.tz) ? body.tz : 'UTC';
    const n = await query('select count(*)::int as n from push_subs where desk = $1 and endpoint <> $2', [desk, s.endpoint]);
    if (n[0].n >= MAX_SUBS_PER_DESK) return fail(429, `Notifications are already on for ${MAX_SUBS_PER_DESK} devices. Turn them off on one first.`);
    await query(
      `insert into push_subs (endpoint, desk, sub, tz, prefs) values ($1, $2, $3::jsonb, $4, $5::jsonb)
       on conflict (endpoint) do update set desk = excluded.desk, sub = excluded.sub, tz = excluded.tz, prefs = excluded.prefs,
         last_digest = case when push_subs.desk = excluded.desk then push_subs.last_digest else null end`,
      [s.endpoint, desk, JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }), tz, JSON.stringify(cleanPrefs(body.prefs))],
    );
    await query(`insert into desk_settings (desk, tz) values ($1, $2) on conflict (desk) do update set tz = excluded.tz`, [desk, tz]);
    return { status: 200, json: { ok: true, prefs: cleanPrefs(body.prefs) } };
  }

  if (a === 'prefs') {
    const r = await query('update push_subs set prefs = $3::jsonb where endpoint = $1 and desk = $2 returning prefs', [body.endpoint, desk, JSON.stringify(cleanPrefs(body.prefs))]);
    if (!r.length) return fail(404, 'Notifications aren’t on for this device.');
    return { status: 200, json: { ok: true, prefs: cleanPrefs(r[0].prefs) } };
  }

  if (a === 'unsubscribe') {
    await query('delete from push_subs where endpoint = $1 and desk = $2', [String(body.endpoint || ''), desk]);
    return { status: 200, json: { ok: true } };
  }

  if (a === 'test') {
    const rows = typeof body.endpoint === 'string'
      ? await query('select endpoint, sub from push_subs where endpoint = $1 and desk = $2', [body.endpoint, desk])
      : await query('select endpoint, sub from push_subs where desk = $1', [desk]);
    if (!rows.length) return fail(404, 'Notifications aren’t on for this device.');
    const r = await sendPush(query, env, rows, { title: 'Ticket Desk', body: 'Notifications are working on this device.', tag: 'test', url: '/' });
    return { status: 200, json: r };
  }

  if (a === 'email') {
    const address = String(body.address || '').trim();
    if (address && !EMAIL_RE.test(address)) return fail(400, 'That doesn’t look like an email address.');
    const tz = validTz(body.tz) ? body.tz : 'UTC';
    await query(
      `insert into desk_settings (desk, email, email_guest, email_digest, tz) values ($1, $2, $3, $4, $5)
       on conflict (desk) do update set email = excluded.email, email_guest = excluded.email_guest, email_digest = excluded.email_digest, tz = excluded.tz`,
      [desk, address || null, !!address && body.guest !== false, !!address && body.digest !== false, tz],
    );
    return { status: 200, json: { ok: true } };
  }

  if (a === 'testEmail') {
    const m = await query('select email from desk_settings where desk = $1 and email is not null', [desk]);
    if (!m[0]) return fail(400, 'Save an email address first.');
    const r = await sendEmail(env, m[0].email, 'Ticket Desk test email', 'Email alerts are working. You’ll get guest tickets and/or your morning summary here.\n');
    return r.ok ? { status: 200, json: { ok: true } } : fail(502, r.error);
  }
  return fail(400, 'Unknown action.');
}

// ----- daily summary -----
// Open tickets whose TRUCE resolution time has run out (paused time excluded).
function pastTruce(t, now) {
  const T = t.truce; if (!T || !(T.res > 0) || now < T.start) return false;
  let paused = 0;
  for (const p of Array.isArray(t.pauses) ? t.pauses : []) { const a = Math.max(p.from, T.start), b = Math.min(p.endedAt || p.until, now); if (b > a) paused += b - a; }
  return now - T.start - paused > T.res;
}
function summarise(tasks, pending, today, now = Date.now()) {
  const open = tasks.filter(t => !t.done && typeof t.day === 'string');
  const c = [0, 0, 0, 0, 0, 0];
  open.forEach(t => c[prio(t.urgency, t.impact)]++);
  const carried = open.filter(t => t.day < today || (t.carriedFrom && t.carriedFrom < t.day)).length;
  const today_ = open.filter(t => t.day <= today).length;
  const parts = [];
  if (today_) parts.push(`${today_} open today${c[1] || c[2] ? ` (${[c[1] && c[1] + ' P1', c[2] && c[2] + ' P2'].filter(Boolean).join(', ')})` : ''}`);
  if (carried) parts.push(`${carried} carried over`);
  const late = open.filter(t => pastTruce(t, now)).length;
  if (late) parts.push(`${late} past TRUCE`);
  if (pending) parts.push(`${pending} guest request${pending > 1 ? 's' : ''} waiting`);
  const top = open.filter(t => t.day <= today).sort((a, b) => prio(a.urgency, a.impact) - prio(b.urgency, b.impact)).slice(0, 10);
  return { empty: !today_ && !pending, line: parts.join(' · '), top };
}
const prettyDay = (tz, now) => new Intl.DateTimeFormat('en-GB', { timeZone: validTz(tz) ? tz : 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(now);

export async function handleDigest({ query, auth, env = {}, now = new Date() }) {
  if (env.CRON_SECRET && auth !== 'Bearer ' + env.CRON_SECRET) return fail(401, 'Not allowed.');
  await ensureSchema(query);
  const subs = await query(`select endpoint, desk, sub, tz, last_digest from push_subs where coalesce((prefs->>'digest')::boolean, true)`, []);
  const mails = await query(`select desk, email, tz, last_digest from desk_settings where email is not null and email_digest`, []);
  const desks = [...new Set([...subs.map(s => s.desk), ...mails.map(m => m.desk)])].slice(0, 500);
  let pushed = 0, emailed = 0, skipped = 0;
  for (const desk of desks) {
    const rows = await query(`select body from items where desk = $1 and kind = 'tasks' and not deleted and coalesce((body->>'done')::boolean, false) = false`, [desk]);
    const tasks = rows.map(r => r.body);
    const pend = await query(`select count(*)::int as n from items where desk = $1 and kind = 'requests' and not deleted and coalesce(body->>'status', '') = ''`, [desk]);
    for (const s of subs.filter(x => x.desk === desk)) {
      const day = localDay(s.tz, now);
      if (s.last_digest === day) { skipped++; continue; }
      const sum = summarise(tasks, pend[0].n, day, +now);
      await query('update push_subs set last_digest = $2 where endpoint = $1', [s.endpoint, day]);
      if (sum.empty) { skipped++; continue; }
      const r = await sendPush(query, env, [s], { title: `Your desk · ${prettyDay(s.tz, now)}`, body: sum.line, tag: 'digest', url: '/#day' });
      pushed += r.sent;
    }
    for (const m of mails.filter(x => x.desk === desk)) {
      const day = localDay(m.tz, now);
      if (m.last_digest === day) { skipped++; continue; }
      const sum = summarise(tasks, pend[0].n, day, +now);
      await query('update desk_settings set last_digest = $2 where desk = $1', [desk, day]);
      if (sum.empty) { skipped++; continue; }
      const list = sum.top.map(t => `  P${prio(t.urgency, t.impact)}  ${t.name}${t.day < day ? '  (carried over)' : ''}`).join('\n');
      const r = await sendEmail(env, m.email, `Your desk · ${prettyDay(m.tz, now)}: ${sum.line}`, `${sum.line}\n\n${list}\n\nOpen Ticket Desk to get started.\n`);
      if (r.ok) emailed++;
    }
  }
  return { status: 200, json: { pushed, emailed, skipped } };
}
