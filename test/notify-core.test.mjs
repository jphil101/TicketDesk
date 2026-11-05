// Notifications against a real Postgres, with a local fake push service and a fake email API.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { handleSync } from '../lib/sync-core.js';
import { handleGuest } from '../lib/guest-core.js';
import { handleNotify, handleDigest, DIGEST_UTC, localDay } from '../lib/notify-core.js';

const ece = createRequire(import.meta.url)('http_ece');
const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

test('digest schedule in vercel.json matches the app', () => {
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
  const [min, hour] = v.crons.find(c => c.path === '/api/digest').schedule.split(' ');
  assert.equal(`${hour.padStart(2, '0')}:${min.padStart(2, '0')}`, DIGEST_UTC);
});

test('local day follows the time zone', () => {
  const t = new Date('2026-11-05T22:30:00Z');
  assert.equal(localDay('UTC', t), '2026-11-05');
  assert.equal(localDay('Asia/Kolkata', t), '2026-11-06');
  assert.equal(localDay('America/Los_Angeles', t), '2026-11-05');
  assert.equal(localDay('Not/AZone', t), '2026-11-05');
});

test('notifications', { skip }, async t => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const query = (s, p) => pool.query(s, p).then(r => r.rows);

  // fake push service: records and decrypts what it receives
  const got = [];
  const devices = {};
  const pushSrv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const id = req.url.split('/').pop(), d = devices[id];
      if (id === 'gone') { res.writeHead(410); return res.end(); }
      let payload = null;
      try { payload = JSON.parse(ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: d.ecdh, authSecret: d.auth }).toString()); } catch {}
      got.push({ id, auth: req.headers.authorization || '', payload });
      res.writeHead(201); res.end();
    });
  });
  // fake Resend
  const mails = [];
  const mailSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { mails.push({ auth: req.headers.authorization, ...JSON.parse(b) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"x"}'); });
  });
  await new Promise(r => pushSrv.listen(0, r)); await new Promise(r => mailSrv.listen(0, r));
  const PUSH = `http://127.0.0.1:${pushSrv.address().port}/push/`;
  const env = { ALLOW_HTTP_PUSH: '1', RESEND_API_KEY: 're_test', RESEND_API_URL: `http://127.0.0.1:${mailSrv.address().port}/emails` };
  const device = id => {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); const auth = crypto.randomBytes(16);
    devices[id] = { ecdh, auth };
    return { endpoint: PUSH + id, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') } };
  };
  const OWNER = 'Bearer TD-RRRRR-SSSSS-TTTTT-VVVVV';
  const owner = (body, e = env) => handleNotify({ query, auth: OWNER, body, env: e });
  await handleSync({ query, auth: OWNER, body: { since: 0 } });
  await query('delete from push_subs', []); await query('delete from desk_settings', []);

  const phone = device('phone'), laptop = device('laptop');

  await t.test('status creates push keys once and reports nothing on yet', async () => {
    const s1 = await owner({ action: 'status', endpoint: phone.endpoint });
    const s2 = await owner({ action: 'status' });
    assert.equal(s1.status, 200);
    assert.equal(s1.json.publicKey, s2.json.publicKey, 'keys are stable');
    assert.equal(s1.json.device, null);
    assert.equal(s1.json.emailAvailable, true);
    assert.equal((await owner({ action: 'status' }, {})).json.emailAvailable, false);
    assert.equal((await handleNotify({ query, auth: undefined, body: { action: 'status' }, env })).status, 401);
  });

  await t.test('subscribe validates input and stores preferences', async () => {
    assert.equal((await owner({ action: 'subscribe', subscription: { endpoint: 'ftp://x', keys: phone.keys } })).status, 400);
    assert.equal((await owner({ action: 'subscribe', subscription: phone }, {})).status, 400, 'http endpoints only allowed in tests');
    assert.equal((await owner({ action: 'subscribe', subscription: phone, tz: 'Asia/Kolkata', prefs: { guest: true, digest: true } })).status, 200);
    assert.equal((await owner({ action: 'subscribe', subscription: laptop, tz: 'Asia/Kolkata', prefs: { guest: false, digest: true } })).status, 200);
    assert.deepEqual((await owner({ action: 'status', endpoint: laptop.endpoint })).json.device.prefs, { guest: false, digest: true });
  });

  await t.test('test push is delivered and decrypts', async () => {
    got.length = 0;
    const r = await owner({ action: 'test', endpoint: phone.endpoint });
    assert.deepEqual(r.json, { sent: 1, failed: 0 });
    assert.equal(got[0].id, 'phone');
    assert.match(got[0].auth, /^vapid t=/);
    assert.equal(got[0].payload.body, 'Notifications are working on this device.');
  });

  await t.test('a guest ticket notifies devices that want it, and emails', async () => {
    await owner({ action: 'email', address: 'me@example.com', guest: true, digest: true, tz: 'Asia/Kolkata' });
    assert.equal((await owner({ action: 'email', address: 'not-an-email' })).status, 400);
    const link = await handleGuest({ query, auth: OWNER, body: { action: 'create', mode: 'submit', ttlMinutes: 60 }, env });
    got.length = 0; mails.length = 0;
    const s = await handleGuest({ query, auth: 'Guest ' + link.json.token, body: { action: 'submit', name: 'Printer jammed', urgency: 3, impact: 3, from: 'Sam' }, env });
    assert.equal(s.status, 200); assert.match(s.json.id, /^g/);
    assert.deepEqual(got.map(g => g.id), ['phone'], 'laptop opted out of guest alerts');
    assert.equal(got[0].payload.title, 'New ticket from Sam');
    assert.equal(got[0].payload.body, 'P1 Critical · Printer jammed');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to[0], 'me@example.com');
    assert.equal(mails[0].auth, 'Bearer re_test');
    assert.match(mails[0].subject, /Printer jammed/);

    // guest can see the status of what they sent
    const info = await handleGuest({ query, auth: 'Guest ' + link.json.token, body: { action: 'info', ids: [s.json.id, 'gnotreal123'] }, env });
    assert.deepEqual(info.json.statuses, { [s.json.id]: 'waiting', gnotreal123: 'reviewed' });
    const now = Date.now();
    await handleSync({ query, auth: OWNER, body: { changes: [{ kind: 'requests', id: s.json.id, updatedAt: now + 5, body: { id: s.json.id, name: 'Printer jammed', urgency: 3, impact: 3, status: 'added', resolvedAt: now } }] } });
    const info2 = await handleGuest({ query, auth: 'Guest ' + link.json.token, body: { action: 'info', ids: [s.json.id] }, env });
    assert.equal(info2.json.statuses[s.json.id], 'added');
    const st = await handleGuest({ query, auth: OWNER, body: { action: 'status' }, env });
    assert.equal(st.json.pending, 0, 'resolved requests no longer count as pending');
  });

  await t.test('daily summary: once per local day, skips empty desks, respects opt-outs', async () => {
    const day = localDay('Asia/Kolkata');
    await handleSync({ query, auth: OWNER, body: { changes: [
      { kind: 'tasks', id: 'd1', updatedAt: 1, body: { id: 'd1', name: 'Pay invoice', urgency: 3, impact: 3, day, done: false } },
      { kind: 'tasks', id: 'd2', updatedAt: 1, body: { id: 'd2', name: 'Old thing', urgency: 2, impact: 2, day: '2020-01-01', done: false } },
      { kind: 'tasks', id: 'd3', updatedAt: 1, body: { id: 'd3', name: 'Done thing', urgency: 1, impact: 1, day, done: true } },
    ] } });
    got.length = 0; mails.length = 0;
    const r = await handleDigest({ query, env });
    assert.deepEqual(r.json, { pushed: 2, emailed: 1, skipped: 0 });
    assert.match(got[0].payload.body, /^2 open today \(1 P1\) · 1 carried over$/);
    assert.match(mails[0].text, /P1  Pay invoice/);
    assert.match(mails[0].text, /Old thing  \(carried over\)/);
    assert.doesNotMatch(mails[0].text, /Done thing/);
    const again = await handleDigest({ query, env });
    assert.deepEqual(again.json, { pushed: 0, emailed: 0, skipped: 3 }, 'not twice on the same day');

    await owner({ action: 'prefs', endpoint: phone.endpoint, prefs: { guest: true, digest: false } });
    await query('update push_subs set last_digest = null', []); await query('update desk_settings set last_digest = null', []);
    got.length = 0;
    await handleDigest({ query, env });
    assert.deepEqual(got.map(g => g.id), ['laptop'], 'phone opted out of the summary');
  });

  await t.test('CRON_SECRET is enforced when set', async () => {
    assert.equal((await handleDigest({ query, env: { ...env, CRON_SECRET: 's3cret' } })).status, 401);
    assert.equal((await handleDigest({ query, auth: 'Bearer s3cret', env: { ...env, CRON_SECRET: 's3cret' } })).status, 200);
  });

  await t.test('dead subscriptions are removed; unsubscribe works', async () => {
    const gone = device('gone');
    await owner({ action: 'subscribe', subscription: gone, tz: 'UTC' });
    const r = await owner({ action: 'test' });
    assert.equal(r.json.failed, 1);
    assert.equal((await query('select 1 from push_subs where endpoint = $1', [gone.endpoint])).length, 0);
    await owner({ action: 'unsubscribe', endpoint: laptop.endpoint });
    assert.equal((await owner({ action: 'status', endpoint: laptop.endpoint })).json.device, null);
  });

  pushSrv.close(); mailSrv.close();
  await pool.end();
});
