// Runs against a real Postgres. Point TEST_DATABASE_URL at a throwaway database:
//   TEST_DATABASE_URL=postgres://localhost:5432/ticketdesk_test npm test
// Skipped when TEST_DATABASE_URL is not set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSync, normalizeKey, deskIdFor, MAX_CHANGES, PULL_LIMIT } from '../lib/sync-core.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let pool, query;
if (url) {
  const { default: pg } = await import('pg');
  pool = new pg.Pool({ connectionString: url, max: 6 });
  query = (t, p) => pool.query(t, p).then(r => r.rows);
}

const KEY_A = 'TD-7K3QX-M2PZD-9VBNH-4RWEA';
const KEY_B = 'td 0000011111222223333344444'.slice(0, 2) + 'ABCDEFGHJKMNPQRSTVWX';
const call = (key, body, env) => handleSync({ query, auth: key ? 'Bearer ' + key : undefined, body, env });
const task = (id, name, updatedAt, extra = {}) => ({ kind: 'tasks', id, updatedAt, body: { id, name, urgency: 2, impact: 2, day: '2026-11-04', done: false, updatedAt, ...extra } });

test('key normalisation', () => {
  assert.equal(normalizeKey('TD-7K3QX-M2PZD-9VBNH-4RWEA'), '7K3QXM2PZD9VBNH4RWEA');
  assert.equal(normalizeKey('7k3qx m2pzd 9vbnh 4rwea'), '7K3QXM2PZD9VBNH4RWEA');
  assert.equal(normalizeKey('7K3QX-M2PZD-9VBNH-4RWEO'), '7K3QXM2PZD9VBNH4RWE0', 'O reads as zero');
  assert.equal(normalizeKey('short'), null);
  assert.equal(normalizeKey('7K3QX-M2PZD-9VBNH-4RWEU'), null, 'U is not in the alphabet');
  assert.notEqual(deskIdFor('A'.repeat(20)), deskIdFor('A'.repeat(20), 'pepper'));
});

test('database variable lookup', async () => {
  const { findDatabaseUrl } = await import('../lib/db.js');
  assert.equal(findDatabaseUrl({ DATABASE_URL: 'a', POSTGRES_URL: 'b' }).name, 'DATABASE_URL');
  assert.equal(findDatabaseUrl({ POSTGRES_URL: 'b' }).name, 'POSTGRES_URL');
  assert.equal(findDatabaseUrl({ TICKETDESK_DATABASE_URL: 'c', TICKETDESK_DATABASE_URL_UNPOOLED: 'd' }).name, 'TICKETDESK_DATABASE_URL');
  assert.equal(findDatabaseUrl({ DATABASE_URL_UNPOOLED: 'd', POSTGRES_URL_NON_POOLING: 'e' }), null);
  assert.equal(findDatabaseUrl({ DATABASE_URL: '' }), null);
});

test('sync against Postgres', { skip }, async t => {
  await query('drop table if exists guest_links', []);
  await query('drop table if exists items', []);
  await query('drop table if exists desks', []);

  await t.test('rejects missing and malformed keys', async () => {
    assert.equal((await call(null, {})).status, 401);
    assert.equal((await call('nope', {})).status, 401);
  });

  await t.test('validates changes', async () => {
    assert.equal((await call(KEY_A, { changes: [{ kind: 'x', id: 'a', updatedAt: 1, body: {} }] })).status, 400);
    assert.equal((await call(KEY_A, { changes: [{ kind: 'tasks', id: 'a/b', updatedAt: 1, body: {} }] })).status, 400);
    assert.equal((await call(KEY_A, { changes: [{ kind: 'tasks', id: 'a', updatedAt: 1 }] })).status, 400);
    assert.equal((await call(KEY_A, { changes: Array(MAX_CHANGES + 1).fill(task('a', 'x', 1)) })).status, 413);
    assert.equal((await call(KEY_A, '{bad json')).status, 400);
  });

  let cursorA = 0;
  await t.test('push then pull from a second device', async () => {
    const r = await call(KEY_A, { since: 0, changes: [task('t1', 'Fix login', 100), task('t2', 'Budget', 100)] });
    assert.equal(r.status, 200);
    assert.equal(r.json.changes.length, 2);
    cursorA = r.json.cursor;
    const other = await call(KEY_A, { since: 0 });
    assert.deepEqual(other.json.changes.map(c => c.body.name).sort(), ['Budget', 'Fix login']);
  });

  await t.test('desks are isolated', async () => {
    const r = await call(KEY_B, { since: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.json.changes.length, 0);
  });

  await t.test('last writer wins on updatedAt', async () => {
    await call(KEY_A, { changes: [task('t1', 'Fix login (newer)', 300)] });
    const stale = await call(KEY_A, { since: cursorA, changes: [task('t1', 'Fix login (stale)', 200)] });
    const t1 = stale.json.changes.find(c => c.id === 't1');
    assert.equal(t1.body.name, 'Fix login (newer)');
    cursorA = stale.json.cursor;
  });

  await t.test('deletes travel as tombstones', async () => {
    await call(KEY_A, { changes: [{ kind: 'tasks', id: 't2', updatedAt: 400, deleted: true }] });
    const r = await call(KEY_A, { since: cursorA });
    const t2 = r.json.changes.find(c => c.id === 't2');
    assert.equal(t2.deleted, true);
    assert.equal(t2.body, null);
    // An older edit can't resurrect it
    await call(KEY_A, { changes: [task('t2', 'Budget again', 350)] });
    const all = await call(KEY_A, { since: 0 });
    assert.equal(all.json.changes.find(c => c.id === 't2').deleted, true);
  });

  await t.test('pages never split a revision and never skip rows', async () => {
    const KEY_C = 'TD-ZZZZZ-YYYYY-XXXXX-WWWWW';
    const total = 1700;
    for (let off = 0; off < total; off += MAX_CHANGES) {
      const batch = Array.from({ length: Math.min(MAX_CHANGES, total - off) }, (_, n) => task('p' + (off + n), 'Item ' + (off + n), 10));
      assert.equal((await call(KEY_C, { changes: batch })).status, 200);
    }
    const seen = new Set();
    let cursor = 0, pages = 0, more = true;
    while (more) {
      const r = await call(KEY_C, { since: cursor });
      r.json.changes.forEach(c => seen.add(c.id));
      assert.ok(r.json.changes.length <= PULL_LIMIT);
      cursor = r.json.cursor; more = r.json.hasMore; pages++;
      assert.ok(pages < 10, 'pagination terminates');
    }
    assert.equal(seen.size, total);
    assert.ok(pages >= 2);
  });

  await t.test('concurrent pushes keep revisions ordered per desk', async () => {
    const KEY_D = 'TD-11111-22222-33333-44444';
    const start = (await call(KEY_D, { since: 0 })).json.cursor;
    await Promise.all(Array.from({ length: 12 }, (_, n) => call(KEY_D, { changes: [task('c' + n, 'Concurrent ' + n, 50 + n)] })));
    const r = await call(KEY_D, { since: start });
    assert.equal(r.json.changes.length, 12);
    const revs = r.json.changes.map(c => c.rev);
    assert.equal(new Set(revs).size, 12, 'each push gets its own revision');
  });

  await t.test('cursor ahead of the server resets', async () => {
    const r = await call(KEY_A, { since: 10_000_000 });
    assert.equal(r.json.reset, true);
    assert.ok(r.json.changes.length >= 2);
  });

  await t.test('ALLOW_NEW_DESKS=false blocks unknown keys only', async () => {
    const env = { ALLOW_NEW_DESKS: 'false' };
    assert.equal((await call('TD-99999-88888-77777-66666', {}, env)).status, 403);
    assert.equal((await call(KEY_A, {}, env)).status, 200);
  });

  await t.test('the key itself is never stored', async () => {
    const rows = await query('select desk from desks', []);
    assert.ok(rows.every(r => !r.desk.includes('7K3QX')));
  });

  await pool.end();
});
