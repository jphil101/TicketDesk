const {chromium, devices} = require('playwright');
const assert = require('assert');
const BASE = process.env.E2E_BASE || 'http://localhost:3300';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async (name, opts) => { const c = await b.newContext(opts); const p = await c.newPage();
    p.on('pageerror', e => errs.push(name + ' pageerror: ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|Failed to load resource/.test(m.text())) errs.push(name + ': ' + m.text()); });
    return {c, p}; };
  const names = p => p.$$eval('#view .task-name', els => els.map(e => e.textContent));
  const add = async (p, name, u = 'High', i = 'High') => { await p.fill('#taskName', name); await p.click(`label[for="add-u-${['Low','Med','High'].indexOf(u)+1}"]`); await p.click(`label[for="add-i-${['Low','Med','High'].indexOf(i)+1}"]`); await p.click('#addBtn'); };
  const syncNow = async p => { await p.evaluate(() => dispatchEvent(new Event('focus'))); await p.waitForTimeout(700); };
  const pill = p => p.textContent('#syncText');
  const step = (s) => console.log('✓', s);

  const A = await mk('A', {viewport: {width: 1200, height: 900}});
  await A.p.goto(BASE); await A.p.waitForTimeout(400);
  assert.equal(await pill(A.p), 'This device');
  await add(A.p, 'Fix login redirect on Safari'); await add(A.p, 'Review Q4 budget draft', 'Med', 'High');
  assert.deepEqual((await names(A.p)).length, 2); step('device A works offline-first with no key');

  await A.p.click('#sync'); await A.p.click('[data-sync="create"]'); await A.p.waitForTimeout(900);
  const key = (await A.p.textContent('#keyText')).trim();
  assert.match(key, /^TD-[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  assert.equal(await pill(A.p), 'Synced'); step('turn on sync → key ' + key.slice(0, 9) + '…, pill Synced');
  await A.p.screenshot({path: 'e2e-A-sync-sheet.png'});
  await A.p.keyboard.press('Escape');

  const B = await mk('B', {...devices['iPhone 13']});
  await B.p.goto(BASE + '/#join=' + key); await B.p.waitForTimeout(500);
  assert.ok(await B.p.isVisible('[data-sync="join-yes"]')); await B.p.screenshot({path: 'e2e-B-join.png'});
  await B.p.click('[data-sync="join-yes"]'); await B.p.waitForTimeout(900);
  assert.equal(B.p.url(), BASE + '/#day', 'join key removed from the address bar');
  assert.deepEqual((await names(B.p)).sort(), ['Fix login redirect on Safari', 'Review Q4 budget draft']); step('device B joined from link and pulled both tasks');
  await B.p.keyboard.press('Escape');

  // B completes one, A sees it
  const id1 = await B.p.$eval('.task', li => li.dataset.id);
  await B.p.click(`[data-id="${id1}"] .check`); await B.p.waitForTimeout(800);
  await syncNow(A.p);
  assert.ok(await A.p.$(`[data-id="${id1}"].done`), 'A sees done'); step('done on B shows on A');

  // A deletes the other, B sees it gone
  const id2 = await A.p.$eval('.task:not(.done)', li => li.dataset.id);
  await A.p.hover(`[data-id="${id2}"] .task-inner`); await A.p.click(`[data-id="${id2}"] .del`); await A.p.waitForTimeout(800);
  await syncNow(B.p);
  assert.equal(await B.p.$(`[data-id="${id2}"]`), null); step('delete on A removes it on B');

  // Undo after delete restores everywhere (tombstone is newer, restore must be newer still)
  await A.p.click('#toast button'); await A.p.waitForTimeout(800); await syncNow(B.p);
  assert.ok(await B.p.$(`[data-id="${id2}"]`), 'undo restores on B'); step('undo of a delete reaches B');

  // Offline on B
  await B.c.setOffline(true);
  await add(B.p, 'Written on the train', 'Low', 'Med'); await B.p.waitForTimeout(800);
  assert.equal(await pill(B.p), 'Offline');
  await B.p.reload().catch(() => {}); await B.p.waitForTimeout(800);
  assert.ok((await names(B.p)).includes('Written on the train'), 'survives reload while offline (service worker + local copy)');
  await B.c.setOffline(false); await B.p.evaluate(() => dispatchEvent(new Event('online'))); await B.p.waitForTimeout(1200);
  assert.equal(await pill(B.p), 'Synced');
  await syncNow(A.p);
  assert.ok((await names(A.p)).includes('Written on the train')); step('offline edit on B (survives reload) syncs to A when back online');

  // Recurring: created on A, instance must not duplicate on B
  await A.p.click('#openRecur'); await A.p.waitForTimeout(300);
  await A.p.fill('#ruleName', 'Check monitoring dashboards'); await A.p.click('label[for="rule-freq-daily"]'); await A.p.click('#ruleForm button[type="submit"]');
  await A.p.waitForTimeout(1200);
  await syncNow(B.p); await B.p.waitForTimeout(800);
  const countB = (await names(B.p)).filter(n => n === 'Check monitoring dashboards').length;
  const countA = (await names(A.p)).filter(n => n === 'Check monitoring dashboards').length;
  assert.equal(countA, 1); assert.equal(countB, 1); step('recurring task appears once on both devices');

  // Same ticket edited on both, last write wins
  const id3 = id1;
  await A.p.click(`[data-id="${id3}"] .task-main`); await A.p.fill('#editName', 'Edited on A'); await A.p.click('#editForm button[type="submit"]'); await A.p.waitForTimeout(300);
  await B.p.waitForTimeout(50);
  await B.p.click(`[data-id="${id3}"] .task-main`); await B.p.fill('#editName', 'Edited on B later'); await B.p.click('#editForm button[type="submit"]');
  await B.p.waitForTimeout(1000); await syncNow(A.p); await syncNow(B.p);
  assert.equal(await A.p.textContent(`[data-id="${id3}"] .task-name`), 'Edited on B later');
  assert.equal(await B.p.textContent(`[data-id="${id3}"] .task-name`), 'Edited on B later'); step('concurrent edits converge to the later one');

  // A third device typing the key
  const C = await mk('C', {viewport: {width: 800, height: 900}});
  await C.p.goto(BASE); await C.p.click('#sync'); await C.p.click('[data-sync="have"]');
  await C.p.fill('#joinKey', key.toLowerCase().replace(/-/g, ' ')); await C.p.click('#joinForm button[type="submit"]'); await C.p.waitForTimeout(1200);
  await C.p.keyboard.press('Escape');
  const nA = (await names(A.p)).length, nC = (await names(C.p)).length;
  assert.equal(nC, nA); step(`typed key (lower-case, spaces) links device C: ${nC} tickets match A`);

  // Unlink C
  await C.p.click('#sync'); await C.p.click('[data-sync="unlink"]'); await C.p.click('[data-sync="unlink-yes"]'); await C.p.waitForTimeout(300);
  assert.equal(await pill(C.p), 'This device'); assert.equal((await names(C.p)).length, 0); step('unlink clears device C, A keeps its data: ' + (await names(A.p)).length);

  // Wrong / unconfigured server
  const D = await mk('D', {viewport: {width: 800, height: 900}});
  await D.p.goto((process.env.E2E_BASE_NODB || 'http://localhost:3301') + '/#join=' + key); await D.p.click('[data-sync="join-yes"]'); await D.p.waitForTimeout(900);
  assert.equal(await pill(D.p), 'Sync off'); await D.p.screenshot({path: 'e2e-D-unconfigured.png'}); step('server without a database shows “Sync off” and keeps working locally');

  await A.p.keyboard.press('Escape').catch(()=>{});
  await A.p.screenshot({path: 'e2e-A-day.png', fullPage: true});
  await B.p.screenshot({path: 'e2e-B-day.png', fullPage: true});
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
