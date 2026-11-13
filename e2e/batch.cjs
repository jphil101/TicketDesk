const {chromium, devices} = require('playwright');
const assert = require('assert'), http = require('http'), crypto = require('crypto');
const ece = require('http_ece');
const BASE = process.env.E2E_BASE || 'http://localhost:3300';
const step = s => console.log('✓', s);
const pad = n => String(n).padStart(2, '0');
const dk = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// fake push service + fake email API
const pushes = [], mails = [];
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); const authSecret = crypto.randomBytes(16);
http.createServer((req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => {
  try { pushes.push(JSON.parse(ece.decrypt(Buffer.concat(c), {version: 'aes128gcm', privateKey: ecdh, authSecret}).toString())); } catch (e) { pushes.push({error: e.message}); }
  res.writeHead(201); res.end(); }); }).listen(3398);
http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { mails.push(JSON.parse(b)); res.writeHead(200, {'content-type': 'application/json'}); res.end('{}'); }); }).listen(3399);
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

(async () => {
  const b = await chromium.launch(); const errs = [];
  const page = async (name, opts = {}, init) => { const c = await b.newContext(opts); if (init) await c.addInitScript(init.fn, init.arg); const p = await c.newPage();
    p.on('pageerror', e => errs.push(name + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(name + ': ' + m.text()); });
    return p; };
  const syncNow = async p => { await p.evaluate(() => dispatchEvent(new Event('focus'))); await p.waitForTimeout(900); };

  // Owner with a stand-in for the browser's push service (headless Chromium has none)
  const fakePush = {fn: ({endpoint, p256dh, auth}) => {
    let perm = 'default', sub = null;
    window.Notification = class { static get permission() { return perm; } static async requestPermission() { perm = 'granted'; return perm; } };
    window.PushManager = window.PushManager || function () {};
    const pm = {getSubscription: async () => sub, subscribe: async o => (sub = {endpoint, options: {applicationServerKey: o.applicationServerKey}, toJSON: () => ({endpoint, keys: {p256dh, auth}}), unsubscribe: async () => { sub = null; return true; }})};
    const reg = {pushManager: pm};
    Object.defineProperty(navigator, 'serviceWorker', {configurable: true, value: {ready: Promise.resolve(reg), getRegistration: async () => reg, register: async () => reg, addEventListener() {}}});
  }, arg: {endpoint: 'http://127.0.0.1:3398/push/owner', p256dh: ecdh.getPublicKey('base64url'), auth: authSecret.toString('base64url')}};
  const A = await page('A', {viewport: {width: 1200, height: 1000}}, fakePush);
  await A.goto(BASE);
  await A.click('#openMore'); await A.waitForTimeout(200);
  assert.equal(await A.textContent('#moreTitle'), 'Settings');
  assert.match(await A.textContent('#notifyPanel'), /Turn on sync above/);
  await A.click('[data-sync="create"]'); await A.waitForTimeout(1200);
  assert.ok(await A.isVisible('[data-n="on"]'), 'turn-on button after sync');
  await A.screenshot({path: 'b-settings-off.png'});
  await A.click('[data-n="on"]'); await A.waitForTimeout(900);
  assert.ok(await A.isVisible('[data-pref="guest"]'));
  pushes.length = 0; await A.click('[data-n="test"]');
  assert.ok(await waitFor(() => pushes.length === 1)); assert.equal(pushes[0].body, 'Notifications are working on this device.');
  step('Settings → Notifications: turn on, test push delivered and decrypted');
  await A.fill('#nEmail', 'me@example.com'); await A.click('#emailForm button[type="submit"]'); await A.waitForTimeout(500);
  mails.length = 0; await A.click('[data-n="testmail"]');
  assert.ok(await waitFor(() => mails.length === 1)); assert.equal(mails[0].to[0], 'me@example.com');
  await A.screenshot({path: 'b-settings-on.png'});
  step('email alerts saved; test email delivered');
  await A.keyboard.press('Escape');

  // Guest link and a guest
  await A.click('#openGuests'); await A.waitForTimeout(600); await A.click('[data-g="create"]'); await A.waitForTimeout(700);
  const glink = (await A.textContent('#gLinkText')).trim(); await A.keyboard.press('Escape');
  const G = await page('G', {...devices['iPhone 13']});
  await G.goto(glink); await G.waitForTimeout(700);
  pushes.length = 0; mails.length = 0;
  await G.fill('#gTask', 'Printer jammed'); await G.fill('#gFrom', 'Sam'); await G.click('#gSend'); await G.waitForTimeout(800);
  assert.ok(await waitFor(() => pushes.length === 1 && mails.length === 1));
  assert.equal(pushes[0].title, 'New ticket from Sam'); assert.equal(pushes[0].body, 'P3 Medium · Printer jammed');
  step('guest ticket → instant push and email to the owner');

  await A.click('#openMore'); await A.waitForTimeout(700); await A.click('[data-pref="guest"]'); await A.waitForTimeout(600); await A.keyboard.press('Escape');
  pushes.length = 0; mails.length = 0;
  await G.fill('#gTask', 'Order toner'); await G.click('#gSend'); await G.waitForTimeout(1200);
  assert.equal(pushes.length, 0); assert.equal(mails.length, 1); step('turning off guest alerts on this device stops the push (email still on)');

  // Owner edits one request before adding, declines the other; guest sees both outcomes
  await syncNow(A);
  assert.equal(await A.textContent('#reqBadge'), '2');
  await A.click('.inbox-sec .req:has-text("Order toner") [data-req-act="edit"]');
  await A.fill('#reqName', 'Order toner for floor 2'); await A.click('label[for="req-u-3"]'); await A.click('label[for="req-i-3"]');
  assert.equal(await A.textContent('#reqControls .ro-p'), 'P1');
  await A.screenshot({path: 'b-req-edit.png'});
  await A.click('.req.editing [data-req-act="accept"]'); await A.waitForTimeout(400);
  const added = await A.$eval('.task:has-text("Order toner for floor 2") .pbadge', e => e.textContent);
  assert.equal(added, 'P1');
  await A.click('.inbox-sec .req:has-text("Printer jammed") [data-req-act="decline"]'); await A.waitForTimeout(900);
  assert.equal(await A.isVisible('#reqBadge'), false);
  await G.evaluate(() => dispatchEvent(new Event('focus'))); await G.waitForTimeout(900);
  const st = await G.$$eval('#gSent .req', els => els.map(e => e.querySelector('.task-name').textContent + '=' + e.querySelector('.req-status').textContent));
  assert.deepEqual(st.sort(), ['Order toner=Added', 'Printer jammed=Declined']);
  await G.screenshot({path: 'b-guest-status.png', fullPage: true});
  step('owner edits a request (name + priority) before adding; guest sees Added / Declined');

  // Morning summary
  pushes.length = 0; mails.length = 0;
  const dg = await (await fetch(BASE + '/api/digest')).json();
  assert.ok(dg.pushed >= 1 && dg.emailed >= 1, JSON.stringify(dg));   // older test desks in the shared dev database also get their one summary on a new day
  assert.match(pushes[0].body, /open today/); assert.match(mails[0].text, /Order toner for floor 2/);
  const dg2 = await (await fetch(BASE + '/api/digest')).json();
  assert.equal(dg2.pushed + dg2.emailed, 0); step('daily summary by push and email, never twice in a day');

  // Snooze & stale prompt (local desk)
  const L = await page('L', {viewport: {width: 1100, height: 1000}});
  await L.goto(BASE);
  const now = Date.now();
  await L.evaluate(t => localStorage.setItem('td.tasks', JSON.stringify(t)), [
    {id: 's1', seq: 1, name: 'Ancient task', urgency: 2, impact: 2, day: dk(-6), done: false, doneAt: null, notes: '', createdAt: now, updatedAt: now},
    {id: 's2', seq: 2, name: 'Old drop me', urgency: 1, impact: 2, day: dk(-7), done: false, doneAt: null, notes: '', createdAt: now, updatedAt: now},
    {id: 's3', seq: 3, name: 'Yesterday task', urgency: 3, impact: 2, day: dk(-1), done: false, doneAt: null, notes: '', createdAt: now, updatedAt: now},
  ]);
  await L.reload(); await L.waitForTimeout(800);
  assert.match(await L.textContent('[data-id="s1"] .stale-bar'), /Carried 6 days\. Still relevant\?/);
  assert.equal(await L.$('[data-id="s3"] .stale-bar'), null);
  await L.screenshot({path: 'b-stale.png', fullPage: true});
  await L.click('[data-id="s1"] [data-act="keep"]'); await L.waitForTimeout(300);
  assert.equal(await L.$('[data-id="s1"] .stale-bar'), null);
  await L.click('[data-id="s2"] [data-act="drop"]'); await L.waitForTimeout(300);
  assert.equal(await L.$('.carried-sec [data-id="s2"]'), null); assert.equal(await L.textContent('.dropped-sec [data-id="s2"] .stamp'), 'Dropped');
  step('stale prompt on 5+ day carries: Keep hides it, Drop closes the ticket as Dropped (kept in history)');
  await L.click('[data-id="s3"] .snz'); await L.waitForTimeout(150);
  assert.ok(await L.isVisible('#snoozePop'));
  await L.screenshot({path: 'b-snooze.png'});
  await L.click('#snoozePop [data-snz]'); await L.waitForTimeout(150);
  assert.ok(await L.isVisible('#snzErr'), 'a reason is required');
  assert.ok(await L.isVisible('#snoozePop'), 'menu stays open');
  await L.fill('#snzReason', 'Waiting for the quote'); await L.click('#snoozePop [data-snz]'); await L.waitForTimeout(300);
  const s3 = await L.evaluate(() => JSON.parse(localStorage.getItem('td.tasks')).find(t => t.id === 's3'));
  assert.equal(s3.day, dk(1)); assert.equal(s3.carriedFrom, null);
  assert.equal(await L.$('#view [data-id="s3"]'), null, 'gone from today');
  await L.click('#toast button'); await L.waitForTimeout(500);
  assert.ok(await L.$('.carried-sec [data-id="s3"]'), 'undo brings it back as carried');
  step('snooze menu moves a ticket to tomorrow; undo restores it');

  // Quick capture
  await L.goto(BASE + '/?text=' + encodeURIComponent('Read this https://example.com/long/article?id=7') + '&u=3'); await L.waitForTimeout(600);
  assert.equal(await L.inputValue('#taskName'), 'Read this');
  assert.ok(await L.isChecked('#add-u-3'));
  assert.match(await L.textContent('#captureNote'), /example\.com\/long\/article/);
  assert.equal(await L.evaluate(() => location.search), '', 'address cleaned');
  await L.screenshot({path: 'b-capture.png'});
  await L.click('#addBtn'); await L.waitForTimeout(300);
  const cap = await L.evaluate(() => JSON.parse(localStorage.getItem('td.tasks')).find(t => t.name === 'Read this'));
  assert.equal(cap.notes, 'https://example.com/long/article?id=7'); assert.equal(cap.urgency, 3);
  await L.goto(BASE + '/#new=Call%20the%20bank'); await L.waitForTimeout(500);
  assert.equal(await L.inputValue('#taskName'), 'Call the bank');
  await L.goto(BASE + '/?title=Quarterly%20report&url=https%3A%2F%2Fdocs.example.com%2Fq3'); await L.waitForTimeout(500);
  assert.equal(await L.inputValue('#taskName'), 'Quarterly report'); assert.ok(await L.isVisible('#captureNote'));
  await L.goto(BASE + '/?focus=new'); await L.waitForTimeout(500);
  assert.equal(await L.evaluate(() => document.activeElement.id), 'taskName');
  step('capture: ?text= with link → notes, #new=, Android share (title+url), ?focus=new');

  // Unlink removes the device's push subscription on the server
  const pg = require('pg');
  const db = new pg.Client({connectionString: process.env.E2E_DATABASE_URL}); await db.connect();
  const before = (await db.query(`select count(*)::int n from push_subs where endpoint like '%/push/owner'`)).rows[0].n;
  await A.click('#openMore'); await A.click('[data-sync="unlink"]'); await A.click('[data-sync="unlink-yes"]'); await A.waitForTimeout(800);
  const after = (await db.query(`select count(*)::int n from push_subs where endpoint like '%/push/owner'`)).rows[0].n;
  await db.end();
  assert.equal(before, 1); assert.equal(after, 0); step('unlinking a device also turns off its notifications');

  // Manifest
  const man = await (await fetch(BASE + '/manifest.webmanifest')).json();
  assert.equal(man.share_target.method, 'GET'); assert.equal(man.shortcuts[0].url, '/?focus=new'); step('manifest has the share target and a New ticket shortcut');
  console.log('errors:', errs.length ? errs : 'none');
  await b.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
