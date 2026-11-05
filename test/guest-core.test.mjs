// Guest links against a real Postgres (see sync-core.test.mjs for setup).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../lib/sync-core.js';
import { handleGuest, MAX_PENDING } from '../lib/guest-core.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

test('guest links', { skip }, async t => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const query = (s, p) => pool.query(s, p).then(r => r.rows);
  const OWNER = 'Bearer TD-GGGGG-HHHHH-JJJJJ-KKKKK';
  const OTHER = 'Bearer TD-MMMMM-NNNNN-PPPPP-QQQQQ';
  const owner = (body, auth = OWNER) => handleGuest({ query, auth, body });
  const guest = (token, body) => handleGuest({ query, auth: 'Guest ' + token, body });
  const sync = (body, auth = OWNER) => handleSync({ query, auth, body });

  // Fresh guest data for this run (sync tests may share the database).
  await sync({ since: 0 });
  await query('delete from guest_links', []).catch(() => {});
  await query(`delete from items where kind = 'requests'`, []).catch(() => {});
  const now = Date.now();
  await sync({ changes: [
    { kind: 'tasks', id: 'open1', updatedAt: now, body: { id: 'open1', seq: 7, name: 'Open task', urgency: 3, impact: 2, day: '2026-11-05', done: false, notes: 'private note', updatedAt: now } },
    { kind: 'tasks', id: 'done1', updatedAt: now, body: { id: 'done1', seq: 8, name: 'Done task', urgency: 1, impact: 1, day: '2026-11-05', done: true, doneAt: now, notes: '', updatedAt: now } },
  ] });

  await t.test('owner must authenticate; bad input is rejected', async () => {
    assert.equal((await owner({ action: 'status' }, null)).status, 401);
    assert.equal((await owner({ action: 'create', mode: 'admin', ttlMinutes: 60 })).status, 400);
    assert.equal((await owner({ action: 'create', mode: 'submit', ttlMinutes: 5 })).status, 400);
    assert.equal((await owner({ action: 'create', mode: 'submit', ttlMinutes: 99999 })).status, 400);
  });

  let submitToken;
  await t.test('create, status and drop-off submissions', async () => {
    assert.equal((await owner({ action: 'status' })).json.active, null);
    const c = await owner({ action: 'create', mode: 'submit', ttlMinutes: 60 });
    assert.equal(c.status, 200);
    submitToken = c.json.token;
    const mins = (new Date(c.json.expiresAt) - Date.now()) / 60000;
    assert.ok(mins > 58 && mins <= 60.5, 'expires in an hour');
    const s = await owner({ action: 'status' });
    assert.equal(s.json.active.mode, 'submit');

    const info = await guest(submitToken, { action: 'info' });
    assert.equal(info.status, 200);
    assert.equal(info.json.tasks, undefined, 'drop-off guests see no tasks');

    assert.equal((await guest(submitToken, { action: 'submit', name: '   ', urgency: 2, impact: 2 })).status, 400);
    assert.equal((await guest(submitToken, { action: 'submit', name: 'x', urgency: 4, impact: 2 })).status, 400);
    const ok = await guest(submitToken, { action: 'submit', name: '  Fix   the printer ', urgency: 3, impact: 2, from: 'Sam' });
    assert.equal(ok.status, 200);
    assert.equal((await owner({ action: 'status' })).json.active.submissions, 1);
  });

  await t.test('submissions reach the owner through sync, and can be resolved', async () => {
    const r = await sync({ since: 0 });
    const reqs = r.json.changes.filter(c => c.kind === 'requests' && !c.deleted);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].body.name, 'Fix the printer');
    assert.equal(reqs[0].body.from, 'Sam');
    // Owner declines: a tombstone through normal sync
    await sync({ changes: [{ kind: 'requests', id: reqs[0].id, updatedAt: Date.now() + 1, deleted: true }] });
    assert.equal((await owner({ action: 'status' })).json.pending, 0);
  });

  await t.test('a guest token does not work as an owner, nor on another desk', async () => {
    assert.equal((await owner({ action: 'status' }, 'Bearer ' + submitToken)).status, 401);
    assert.equal((await handleSync({ query, auth: 'Guest ' + submitToken, body: {} })).status, 401);
    const other = await owner({ action: 'status' }, OTHER);
    assert.equal(other.json.active, null, 'other desks have no link');
  });

  await t.test('view mode shows open tasks without notes; a new link replaces the old', async () => {
    const c = await owner({ action: 'create', mode: 'view', ttlMinutes: 240 });
    const info = await guest(c.json.token, { action: 'info' });
    assert.equal(info.json.mode, 'view');
    assert.deepEqual(info.json.tasks.map(x => x.name), ['Open task']);
    assert.equal(info.json.tasks[0].notes, undefined);
    assert.equal(JSON.stringify(info.json).includes('private note'), false);
    assert.equal((await guest(submitToken, { action: 'info' })).status, 410, 'old link stops working');
    submitToken = c.json.token;
  });

  await t.test('expired and revoked links stop working', async () => {
    await query(`update guest_links set expires_at = now() - interval '1 second'`, []);
    const r = await guest(submitToken, { action: 'submit', name: 'Late', urgency: 1, impact: 1 });
    assert.equal(r.status, 410);
    assert.equal((await owner({ action: 'status' })).json.active, null);
    const c = await owner({ action: 'create', mode: 'submit', ttlMinutes: 15 });
    assert.equal((await owner({ action: 'revoke' })).status, 200);
    assert.equal((await guest(c.json.token, { action: 'info' })).status, 410);
    assert.equal((await guest('not-a-token', { action: 'info' })).status, 410);
  });

  await t.test('pending requests are capped', async () => {
    const c = await owner({ action: 'create', mode: 'submit', ttlMinutes: 60 });
    for (let n = 0; n < MAX_PENDING; n++) assert.equal((await guest(c.json.token, { action: 'submit', name: 'Req ' + n, urgency: 1, impact: 1 })).status, 200);
    assert.equal((await guest(c.json.token, { action: 'submit', name: 'One too many', urgency: 1, impact: 1 })).status, 429);
  });

  await t.test('only the token hash is stored', async () => {
    const rows = await query('select token_hash from guest_links', []);
    assert.ok(rows.every(r => /^[0-9a-f]{64}$/.test(r.token_hash)));
  });

  await pool.end();
});
