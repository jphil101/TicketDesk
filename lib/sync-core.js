// Sync protocol for Ticket Desk.
//
// A "desk" is one person's data, identified by a sync key the browser generates
// (20 Crockford base32 chars ≈ 100 bits). The server never stores the key, only an
// HMAC of it, so a database dump can't be used to sign in.
//
// Every task / recurring rule / guest request is one row. Clients push changed rows and
// pull rows newer than their cursor in the same request:
//   POST /api/sync   Authorization: Bearer <key>
//   { since: <cursor>, changes: [{ kind, id, body, deleted, updatedAt }] }
//   → { cursor, hasMore, changes: [{ kind, id, body, deleted, updatedAt, rev }] }
//
// Conflicts resolve last-writer-wins per row on the client's updatedAt.
// Deletes are kept as tombstones so other devices learn about them.
// Each push takes the next per-desk revision number while holding that desk's row lock,
// so revisions for a desk become visible in order and a cursor never skips a row.

import { createHmac } from 'node:crypto';

export const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const KEY_LENGTH = 20;
export const MAX_CHANGES = 500;        // per request; must stay below PULL_LIMIT
export const PULL_LIMIT = 1000;
export const MAX_BODY_BYTES = 16 * 1024;
export const KINDS = new Set(['tasks', 'rules', 'requests', 'settings']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeKey(raw) {
  let s = String(raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.length === KEY_LENGTH + 2 && s.startsWith('TD')) s = s.slice(2);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== KEY_LENGTH) return null;
  for (const c of s) if (!KEY_ALPHABET.includes(c)) return null;
  return s;
}

export function deskIdFor(key, pepper) {
  return createHmac('sha256', pepper || 'ticket-desk/v1').update(key).digest('hex');
}

export const SCHEMA = [
  `create table if not exists desks (
     desk text primary key,
     rev bigint not null default 0,
     created_at timestamptz not null default now(),
     seen_at timestamptz not null default now()
   )`,
  `create table if not exists items (
     desk text not null references desks(desk) on delete cascade,
     kind text not null,
     id text not null,
     body jsonb,
     deleted boolean not null default false,
     updated_at bigint not null,
     rev bigint not null,
     primary key (desk, kind, id)
   )`,
  `create index if not exists items_desk_rev on items (desk, rev)`,
  `create table if not exists guest_links (
     token_hash text primary key,
     desk text not null references desks(desk) on delete cascade,
     mode text not null,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null,
     submissions integer not null default 0
   )`,
  `create index if not exists guest_links_desk on guest_links (desk)`,
  `create table if not exists settings (
     key text primary key,
     value jsonb not null
   )`,
  `create table if not exists push_subs (
     endpoint text primary key,
     desk text not null references desks(desk) on delete cascade,
     sub jsonb not null,
     tz text not null default 'UTC',
     prefs jsonb not null default '{"guest": true, "digest": true}',
     last_digest text,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists push_subs_desk on push_subs (desk)`,
  `create table if not exists desk_settings (
     desk text primary key references desks(desk) on delete cascade,
     email text,
     email_guest boolean not null default false,
     email_digest boolean not null default false,
     tz text not null default 'UTC',
     last_digest text
   )`,
];

const schemaReady = new WeakMap();
export function ensureSchema(query) {
  let p = schemaReady.get(query);
  if (!p) {
    p = (async () => { for (const s of SCHEMA) await query(s, []); })();
    p.catch(() => schemaReady.delete(query));
    schemaReady.set(query, p);
  }
  return p;
}

export const fail = (status, error, extra = {}) => ({ status, json: { error, ...extra } });

// Owner authentication: a sync key in "Authorization: Bearer <key>".
// Returns { desk, rev } or { error } (a ready-made response).
export async function resolveDesk(query, auth, env = {}) {
  const m = /^Bearer\s+(.+)$/i.exec(auth || '');
  const key = m && normalizeKey(m[1]);
  if (!key) return { error: fail(401, 'Missing or malformed sync key.') };
  await ensureSchema(query);
  const desk = deskIdFor(key, env.SYNC_PEPPER);
  const found = await query('select rev from desks where desk = $1', [desk]);
  if (found.length) return { desk, rev: Number(found[0].rev) };
  const allowNew = String(env.ALLOW_NEW_DESKS ?? 'true').trim().toLowerCase() !== 'false';
  if (!allowNew) return { error: fail(403, 'This server isn’t accepting new sync keys.') };
  await query('insert into desks (desk) values ($1) on conflict (desk) do nothing', [desk]);
  return { desk, rev: 0 };
}

// Write rows under the desk's next revision (last-writer-wins on updated_at). Returns the new revision.
export async function pushItems(query, desk, rows) {
  const r = await query(
    `with d as (
       update desks set rev = rev + 1, seen_at = now() where desk = $1 returning rev
     ), up as (
       insert into items (desk, kind, id, body, deleted, updated_at, rev)
       select $1, t.kind, t.id, t.body, t.deleted, t.updated_at, d.rev
       from jsonb_to_recordset($2::jsonb) as t(kind text, id text, body jsonb, deleted boolean, updated_at bigint), d
       on conflict (desk, kind, id) do update
         set body = excluded.body, deleted = excluded.deleted, updated_at = excluded.updated_at, rev = excluded.rev
         where items.updated_at <= excluded.updated_at
       returning 1
     )
     select (select rev from d) as rev, (select count(*) from up) as applied`,
    [desk, JSON.stringify(rows)],
  );
  return Number(r[0].rev);
}

export async function handleSync({ query, auth, body, env = {} }) {
  const m = /^Bearer\s+(.+)$/i.exec(auth || '');
  if (!m || !normalizeKey(m[1])) return fail(401, 'Missing or malformed sync key.');

  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return fail(400, 'Request body must be JSON.'); } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Request body must be a JSON object.');

  let since = Number.isSafeInteger(body.since) && body.since >= 0 ? body.since : 0;
  const changes = body.changes == null ? [] : body.changes;
  if (!Array.isArray(changes)) return fail(400, '`changes` must be an array.');
  if (changes.length > MAX_CHANGES) return fail(413, `Send at most ${MAX_CHANGES} changes per request.`);

  const clean = new Map();
  for (const c of changes) {
    if (!c || !KINDS.has(c.kind) || typeof c.id !== 'string' || !ID_RE.test(c.id) || !Number.isSafeInteger(c.updatedAt) || c.updatedAt < 0) {
      return fail(400, 'Each change needs a valid kind, id and updatedAt.');
    }
    const deleted = c.deleted === true;
    let b = null;
    if (!deleted) {
      if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) return fail(400, 'A change that is not a delete needs an object body.');
      if (Buffer.byteLength(JSON.stringify(c.body)) > MAX_BODY_BYTES) return fail(413, 'One of the items is too large.');
      b = c.body;
    }
    const k = c.kind + ':' + c.id, prev = clean.get(k);
    if (!prev || prev.updated_at <= c.updatedAt) clean.set(k, { kind: c.kind, id: c.id, body: b, deleted, updated_at: c.updatedAt });
  }

  const who = await resolveDesk(query, auth, env);
  if (who.error) return who.error;
  const { desk } = who;
  let deskRev = who.rev;
  if (clean.size) deskRev = await pushItems(query, desk, [...clean.values()]);

  // A cursor ahead of the server (e.g. the database was reset) restarts from zero.
  let reset = false;
  if (since > deskRev) { since = 0; reset = true; }

  const rows = await query(
    `select kind, id, body, deleted, updated_at, rev from items
     where desk = $1 and rev > $2 order by rev, kind, id limit $3`,
    [desk, since, PULL_LIMIT + 1],
  );
  const hasMore = rows.length > PULL_LIMIT;
  let page = rows.slice(0, PULL_LIMIT);
  if (hasMore) {
    // Never end a page part-way through one revision, or the rest of it would be skipped.
    const last = String(page[page.length - 1].rev);
    page = page.filter(r => String(r.rev) !== last);
  }
  const out = page.map(r => ({
    kind: r.kind, id: r.id, body: r.deleted ? null : r.body, deleted: !!r.deleted,
    updatedAt: Number(r.updated_at), rev: Number(r.rev),
  }));
  const cursor = out.length ? out[out.length - 1].rev : since;
  return { status: 200, json: { cursor, hasMore, reset, changes: out } };
}
