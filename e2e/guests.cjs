const {chromium, devices} = require('playwright');
const assert = require('assert');
const BASE = process.env.E2E_BASE || 'http://localhost:3300';
const step = s => console.log('✓', s);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const page = async (name, opts) => { const c = await b.newContext(opts); const p = await c.newPage();
    p.on('pageerror', e => errs.push(name + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(name + ': ' + m.text()); });
    return p; };
  const syncNow = async p => { await p.evaluate(() => dispatchEvent(new Event('focus'))); await p.waitForTimeout(800); };
  const names = p => p.$$eval('#view .task-name', els => els.map(e => e.textContent));

  // Owner A, synced
  const A = await page('A', {viewport: {width: 1200, height: 950}});
  await A.goto(BASE);
  await A.click('#openGuests'); await A.waitForTimeout(200);
  assert.match(await A.textContent('#guestPanel'), /need sync turned on/); step('guest links ask for sync first');
  await A.click('[data-g="sync"]'); await A.click('[data-sync="create"]'); await A.waitForTimeout(900);
  const key = (await A.textContent('#keyText')).trim(); await A.keyboard.press('Escape');
  await A.fill('#taskName', 'Owner task with notes'); await A.click('#addBtn'); await A.waitForTimeout(600);

  await A.click('#openGuests'); await A.waitForTimeout(500);
  await A.screenshot({path: 'g-owner-create.png'});
  assert.equal(await A.getAttribute('[data-ttl="60"]', 'aria-pressed'), 'true', '1 hour is the default');
  await A.click('[data-g="create"]'); await A.waitForTimeout(700);
  const link1 = (await A.textContent('#gLinkText')).trim();
  assert.match(link1, /#guest=[A-Za-z0-9_-]{32}$/);
  assert.match(await A.textContent('#guestPanel'), /Guest link is live: Drop-off\. Ends in (59 min|1 h)/);
  assert.ok(await A.$('#gqr svg'), 'QR drawn');
  await A.screenshot({path: 'g-owner-live.png'}); await A.keyboard.press('Escape');
  step('owner creates a 1-hour Drop-off link with QR: ' + link1.slice(-12));

  // Guest
  const G = await page('G', {...devices['iPhone 13']});
  await G.goto(link1); await G.waitForTimeout(700);
  assert.match(await G.textContent('#gPillText'), /Guest · (59 min|1 h) left/);
  assert.equal(await G.$('#gBoard'), null, 'drop-off guests see no board');
  assert.equal(await G.evaluate(() => localStorage.getItem('td.key')), null);
  await G.fill('#gTask', 'Printer jammed on floor 2');
  await G.click('label[for="guest-u-3"]'); await G.click('label[for="guest-i-3"]');
  assert.equal(await G.textContent('#guestControls .ro-p'), 'P1');
  await G.fill('#gFrom', 'Sam'); await G.click('#gSend'); await G.waitForTimeout(700);
  await G.fill('#gTask', 'Order more toner'); await G.click('#gSend'); await G.waitForTimeout(700);
  assert.equal(await G.$$eval('#gSent .req', els => els.length), 2);
  await G.screenshot({path: 'g-guest-dropoff.png', fullPage: true});
  step('guest sends two tickets with priority; sees only what they sent');

  // Owner reviews
  await syncNow(A);
  assert.equal(await A.textContent('#reqBadge'), '2');
  const reqs = await A.$$eval('.inbox-sec .req .task-name', els => els.map(e => e.textContent));
  assert.deepEqual(reqs, ['Printer jammed on floor 2', 'Order more toner']);
  assert.match(await A.textContent('.inbox-sec'), /From Sam/);
  await A.screenshot({path: 'g-owner-inbox.png', fullPage: true});
  await A.click('.inbox-sec .req:first-child [data-req-act="accept"]'); await A.waitForTimeout(400);
  assert.ok((await names(A)).includes('Printer jammed on floor 2'));
  await A.click('.inbox-sec .req [data-req-act="decline"]'); await A.waitForTimeout(300);
  await A.click('#toast button'); await A.waitForTimeout(300);
  assert.equal(await A.$$eval('.inbox-sec .req', els => els.length), 1, 'undo restores the declined request');
  await A.click('.inbox-sec .req [data-req-act="decline"]'); await A.waitForTimeout(600);
  assert.equal(await A.$('.inbox-sec'), null); assert.equal(await A.isVisible('#reqBadge'), false);
  await A.click('.task:has-text("Printer jammed") .task-main'); await A.waitForTimeout(200);
  assert.equal(await A.inputValue('#editNotes'), 'Requested by Sam'); await A.keyboard.press('Escape');
  step('owner accepts one (P1 kept, “Requested by Sam”), declines one with working undo; badge clears');

  // Owner's other device
  const B = await page('B', {viewport: {width: 900, height: 900}});
  await B.goto(BASE + '/#join=' + key); await B.click('[data-sync="join-yes"]'); await B.waitForTimeout(1200); await B.keyboard.press('Escape');
  assert.ok((await names(B)).includes('Printer jammed on floor 2')); assert.equal(await B.$('.inbox-sec'), null);
  step('second owner device has the accepted ticket and an empty inbox');

  // Replace with a view link; old link dies
  await A.click('#openGuests'); await A.waitForTimeout(500);
  await A.click('[data-g="replace"]'); await A.check('input[name="g-mode"][value="view"]'); await A.click('[data-ttl="1440"]');
  await A.click('[data-g="create"]'); await A.waitForTimeout(700);
  const link2 = (await A.textContent('#gLinkText')).trim(); await A.keyboard.press('Escape');
  assert.match(await A.textContent('#guestPanel'), /Drop-off \+ view\. Ends in (1 d|23 h)/);
  await G.reload(); await G.waitForTimeout(700);
  assert.match(await G.textContent('#guestBody'), /This guest link has ended/); step('new link (view, 1 day) replaces the old one, which stops working');

  const G2 = await page('G2', {...devices['iPhone 13']});
  await G2.goto(link2); await G2.waitForTimeout(800);
  const board = await G2.$$eval('#gBoard .task-name', els => els.map(e => e.textContent));
  assert.ok(board.includes('Printer jammed on floor 2') && board.includes('Owner task with notes'));
  assert.equal(await G2.$('#gBoard .check'), null, 'read-only: no checkboxes');
  assert.equal((await G2.content()).includes('Requested by Sam'), false, 'notes never reach guests');
  await G2.screenshot({path: 'g-guest-view.png', fullPage: true});
  step('view guest sees open tickets read-only, without notes');

  // Status seen from the other owner device (created elsewhere)
  await B.click('#openGuests'); await B.waitForTimeout(700);
  assert.match(await B.textContent('#guestPanel'), /made on another device/); step('other owner device shows the live link and can stop it');
  await B.click('[data-g="stop"]'); await B.waitForTimeout(500);
  await G2.fill('#gTask', 'After stop'); await G2.click('#gSend'); await G2.waitForTimeout(600);
  assert.match(await G2.textContent('#guestBody'), /This guest link has ended/); step('stop sharing cuts off a guest mid-session');

  // Client-side expiry at the chosen time
  const A3 = await page('A3', {viewport: {width: 900, height: 900}});
  await A3.goto(BASE + '/#join=' + key); await A3.click('[data-sync="join-yes"]'); await A3.waitForTimeout(1000); await A3.keyboard.press('Escape');
  await A3.click('#openGuests'); await A3.waitForTimeout(500); await A3.click('[data-g="create"]'); await A3.waitForTimeout(600);
  const link3 = (await A3.textContent('#gLinkText')).trim();
  const G3 = await page('G3', {viewport: {width: 500, height: 800}});
  await G3.clock.install(); await G3.goto(link3); await G3.waitForTimeout(600);
  await G3.clock.runFor(61 * 60 * 1000); await G3.waitForTimeout(300);
  assert.match(await G3.textContent('#guestBody'), /This guest link has ended/); step('guest page closes itself when the hour is up');

  // Opening a guest link in the owner's own browser leaves the owner's desk alone
  const before = await A.evaluate(() => localStorage.getItem('td.tasks'));
  await A.goto(link3); await A.waitForSelector('#guestApp', {state: 'visible', timeout: 8000}); assert.equal(await A.isVisible('#view'), false);
  await A.goto(BASE + '/#day'); await A.waitForTimeout(900);
  assert.equal(await A.evaluate(() => localStorage.getItem('td.tasks')), before); assert.equal(await A.textContent('#syncText'), 'Synced');
  step('guest mode in the owner’s own browser does not touch their desk');

  // Header fits on small phones
  for (const w of [320, 360, 375, 390]) {
    const P = await page('w' + w, {viewport: {width: w, height: 700}, isMobile: true, hasTouch: true});
    await P.goto(BASE); await P.evaluate(() => { localStorage.setItem('td.requests', JSON.stringify([{id: 'x', name: 'n', urgency: 1, impact: 1}])); });
    await P.reload(); await P.waitForTimeout(400);
    const r = await P.evaluate(() => ({sw: document.documentElement.scrollWidth, right: Math.max(...[...document.querySelectorAll('.top-acts .hbtn')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect().right))}));
    assert.ok(r.sw <= w && r.right <= w - 8, `width ${w}: ${JSON.stringify(r)}`);
  }
  step('header with Guests button fits at 320, 360, 375 and 390 px');
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
