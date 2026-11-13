// Recently deleted, changing the sync key, and the complete backup.
const {chromium, devices} = require('playwright');
const assert = require('assert'), fs = require('fs');
const BASE = process.env.E2E_BASE || 'http://localhost:3300';
const step = s => console.log('✓', s);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const page = async (name, opts = {}) => { const c = await b.newContext({viewport: {width: 1200, height: 950}, acceptDownloads: true, ...opts}); const p = await c.newPage();
    p.on('pageerror', e => errs.push(name + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(name + ': ' + m.text()); });
    return p; };
  const names = p => p.$$eval('#view .task-name', els => els.map(e => e.textContent));
  const syncNow = async p => { await p.evaluate(() => dispatchEvent(new Event('focus'))); await p.waitForTimeout(900); };
  const add = async (p, name) => { await p.fill('#taskName', name); await p.click('#addBtn'); await p.waitForTimeout(150); };
  const openSettings = async p => { if (!(await p.isVisible('#moreDlg'))) { await p.click('#sync'); await p.waitForTimeout(250); } };
  const closeSettings = async p => { if (await p.isVisible('#moreDlg')) { await p.click('#moreClose'); await p.waitForTimeout(100); } };

  const A = await page('A');
  await A.goto(BASE);
  await openSettings(A); await A.click('[data-sync="create"]'); await A.waitForTimeout(900);
  const key1 = (await A.textContent('#keyText')).trim(); await closeSettings(A);
  await add(A, 'Keep this one'); await add(A, 'Delete this one'); await A.waitForTimeout(700);
  const B = await page('B', {...devices['iPhone 13']});
  await B.goto(BASE + '/#join=' + key1); await B.click('[data-sync="join-yes"]'); await B.waitForTimeout(1200); await closeSettings(B);
  assert.equal((await names(B)).length, 2);

  // ----- Recently deleted -----
  await A.hover('.task:has-text("Delete this one") .task-inner'); await A.click('.task:has-text("Delete this one") .del'); await A.waitForTimeout(700);
  assert.deepEqual(await names(A), ['Keep this one']);
  await syncNow(B); assert.deepEqual(await names(B), ['Keep this one']);
  await openSettings(B);
  assert.match(await B.textContent('#trashPanel'), /Delete this one.*deleted just now · 30 days left/s);
  await B.click('#trashPanel [data-trash-act="restore"]'); await B.waitForTimeout(800); await closeSettings(B);
  assert.equal((await names(B)).length, 2);
  await syncNow(A); assert.equal((await names(A)).length, 2);
  step('deleted ticket waits in Recently deleted on every device; restoring from the phone brings it back everywhere');

  await A.hover('.task:has-text("Delete this one") .task-inner'); await A.click('.task:has-text("Delete this one") .del'); await A.waitForTimeout(200);
  await A.click('#toast button'); await A.waitForTimeout(300);
  assert.equal((await names(A)).length, 2);
  await openSettings(A); assert.match(await A.textContent('#trashPanel'), /Nothing deleted/); await closeSettings(A);
  step('Undo right after deleting restores it and empties Recently deleted');

  await A.hover('.task:has-text("Delete this one") .task-inner'); await A.click('.task:has-text("Delete this one") .del'); await A.waitForTimeout(200);
  await openSettings(A); await A.click('#trashPanel [data-trash-act="purge"]'); await A.waitForTimeout(800);
  assert.match(await A.textContent('#trashPanel'), /Nothing deleted/); await closeSettings(A);
  await syncNow(B); await openSettings(B); assert.match(await B.textContent('#trashPanel'), /Nothing deleted/); await closeSettings(B);
  assert.deepEqual(await names(B), ['Keep this one']);
  step('Delete forever removes it from every device');

  // old trash expires by itself
  const L = await page('L');
  await L.goto(BASE);
  const old = {id: 'z1', task: {id: 'z1', seq: 9, name: 'Ancient', urgency: 2, impact: 2, day: '2026-01-01', done: false}, deletedAt: Date.now() - 31 * 864e5, updatedAt: 1};
  const fresh = {...old, id: 'z2', task: {...old.task, id: 'z2', name: 'Recent'}, deletedAt: Date.now() - 29 * 864e5};
  await L.evaluate(t => localStorage.setItem('td.trash', JSON.stringify(t)), [old, fresh]);
  await L.reload(); await L.waitForTimeout(700);
  const left = await L.evaluate(() => JSON.parse(localStorage.getItem('td.trash')).map(x => x.task.name));
  assert.deepEqual(left, ['Recent']); step('deleted tickets are removed for good after 30 days');

  // ----- Complete backup -----
  await openSettings(A);
  await A.fill('input[name="res-2"]', '2d'); await A.click('#truceForm button[type="submit"]'); await A.waitForTimeout(300);
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('#expJson')]);
  const backupPath = await dl.path(), backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(backup.settings.find(x => x.id === 'truce').targets[2].res, 2 * 864e5);
  await closeSettings(A);
  const N = await page('N'); await N.goto(BASE); await openSettings(N);
  await N.setInputFiles('#impFile', backupPath); await N.waitForTimeout(500);
  assert.equal(await N.inputValue('input[name="res-2"]'), '2d', 'open Settings screen updates straight away');
  step('backup file now includes your TRUCE targets, and importing restores them');

  // ----- Change sync key -----
  await syncNow(A); await openSettings(A);
  await A.click('[data-sync="rekey"]'); await A.waitForTimeout(100);
  assert.match(await A.textContent('#syncPanel'), /current key stops working straight away/);
  await A.screenshot({path: 'safety-rekey.png'});
  await A.click('[data-sync="rekey-yes"]'); await A.waitForTimeout(1500);
  const key2 = (await A.textContent('#keyText')).trim();
  assert.notEqual(key2, key1); assert.match(key2, /^TD-[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  assert.equal(await A.textContent('#syncText'), 'Synced'); await closeSettings(A);
  await add(A, 'Added after the key change'); await A.waitForTimeout(800);
  step('Change sync key: new key shown, device stays synced');

  await syncNow(B);
  assert.equal(await B.textContent('#syncText'), 'Key rejected');
  await openSettings(B);
  assert.match(await B.textContent('#syncPanel'), /sync key was replaced with a new one/);
  await B.screenshot({path: 'safety-replaced.png'});
  await B.fill('#joinKey', key2); await B.click('#joinForm button[type="submit"]'); await B.waitForTimeout(1500); await closeSettings(B);
  assert.equal(await B.textContent('#syncText'), 'Synced');
  assert.deepEqual((await names(B)).sort(), ['Added after the key change', 'Keep this one']);
  step('the other device is told the key was replaced, and re-links with the new key');

  const X = await page('X');
  await X.goto(BASE + '/#join=' + key1); await X.click('[data-sync="join-yes"]'); await X.waitForTimeout(1200);
  assert.equal(await X.textContent('#syncText'), 'Key rejected'); assert.equal((await names(X)).length, 0);
  step('the old key no longer opens the desk');

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
