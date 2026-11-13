const {chromium, devices} = require('playwright');
const assert = require('assert'), fs = require('fs');
const BASE = process.env.E2E_BASE || 'http://localhost:3300';
const step = s => console.log('✓', s);
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
const pad = n => String(n).padStart(2, '0');
const dk = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctxFor = async (opts = {}) => { const c = await b.newContext({viewport: {width: 1200, height: 1000}, acceptDownloads: true, ...opts}); const p = await c.newPage();
    p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); return p; };
  const stored = (p, name) => p.evaluate(n => JSON.parse(localStorage.getItem('td.tasks') || '[]').find(t => t.name === n), name);
  const chip = (p, name) => p.textContent(`#view .task:has-text("${name}") .tc`);

  // ---------- one ticket's life, on a controlled clock ----------
  const A = await ctxFor();
  await A.clock.install();
  await A.goto(BASE); await A.waitForTimeout(400);
  await A.fill('#taskName', 'Server down'); await A.click('label[for="add-u-3"]'); await A.click('label[for="add-i-3"]'); await A.click('#addBtn'); await A.waitForTimeout(200);
  let t = await stored(A, 'Server down');
  assert.equal(t.truce.resp, 15 * MIN); assert.equal(t.truce.res, 4 * HOUR);
  assert.ok(await A.isVisible('#view .task:has-text("Server down") .ack'));
  assert.equal(await chip(A, 'Server down'), 'Respond in 15 min');
  step('new P1 ticket gets TRUCE 15 min response / 4 h resolution and an “On it” button');

  await A.clock.runFor(5 * MIN); await A.waitForTimeout(100);
  assert.equal(await chip(A, 'Server down'), 'Respond in 10 min');
  await A.click('#view .task:has-text("Server down") .ack'); await A.waitForTimeout(150);
  assert.match(await A.textContent('#toast'), /On it · responded in 5 min · within TRUCE/);
  assert.equal(await chip(A, 'Server down'), 'Resolve in 3 h 55 min');
  step('countdown ticks; “On it” records response (5 min, within TRUCE)');

  await A.click('#view .task:has-text("Server down") .task-main'); await A.waitForTimeout(150);
  assert.match(await A.textContent('#editTruce'), /Response.*Met in 5 min/s);
  await A.click('[data-tr="pause"]'); await A.selectOption('#pzReason', 'other'); await A.click('[data-tr="dopause"]');
  assert.match(await A.textContent('#toast'), /Say briefly why/);
  await A.selectOption('#pzReason', 'waiting'); await A.fill('#pzNote', 'Sam'); await A.selectOption('#pzFor', String(HOUR));
  await A.screenshot({path: 't-pause-form.png'});
  await A.click('[data-tr="dopause"]'); await A.waitForTimeout(150);
  assert.match(await A.textContent('#editTruce'), /Paused: Waiting on someone else: Sam · resumes/);
  await A.screenshot({path: 't-paused-sheet.png'});
  await A.keyboard.press('Escape');
  assert.match(await chip(A, 'Server down'), /^Paused until/);
  await A.clock.runFor(30 * MIN); await A.waitForTimeout(100);
  assert.match(await chip(A, 'Server down'), /^Paused until/);
  await A.clock.runFor(35 * MIN); await A.waitForTimeout(100);
  assert.equal(await chip(A, 'Server down'), 'Resolve in 3 h 50 min');
  step('pause needs a reason (Other needs details), stops the clock, and resumes by itself after 1 hour');

  await A.clock.runFor(4 * HOUR); await A.waitForTimeout(100);
  assert.equal(await chip(A, 'Server down'), 'TRUCE overdue 10 min');
  await A.click('#view .task:has-text("Server down") .check'); await A.waitForTimeout(60);
  assert.ok(await A.$('canvas.fx'), 'first close: full fanfare');
  assert.match(await A.getAttribute('#toast', 'class'), /celebrate/);
  assert.match(await A.textContent('#toast'), /10 min past TRUCE/);
  await A.screenshot({path: 't-fanfare.png'});
  t = await stored(A, 'Server down');
  step('breach shows as overdue; closing celebrates and reports “10 min past TRUCE”');

  // The tiny learned step: 5% × 10 min = 30 s for the next P1 ticket
  await A.fill('#taskName', 'Next P1'); await A.click('label[for="add-u-3"]'); await A.click('label[for="add-i-3"]'); await A.click('#addBtn'); await A.waitForTimeout(150);
  t = await stored(A, 'Next P1');
  assert.ok(Math.abs(t.truce.learnedRes - 30000) < 500 && t.truce.res === 4 * HOUR + t.truce.learnedRes, JSON.stringify(t.truce));   // the clock keeps real time between steps, so ±0.5 s
  step('one 10-minute miss adds just 30 s to the next P1 resolution target');

  // ---------- learned factor against the formula, with an outlier ----------
  const L = await ctxFor();
  await L.goto(BASE);
  const now = Date.now(), base = DAY;
  const mk = (id, overMs, at) => ({id, seq: Number(id.slice(1)) + 10, name: 'Seed ' + id, urgency: 2, impact: 3, day: dk(-3), done: true, createdAt: at - base - overMs, doneAt: at, ackAt: at - base - overMs + 10 * MIN, updatedAt: now, truce: {start: at - base - overMs, resp: HOUR, res: base, learnedResp: 0, learnedRes: 0}});
  const seed = [mk('s1', 12 * HOUR, now - 5 * DAY), mk('s2', 12 * HOUR, now - 4 * DAY), mk('s3', 12 * HOUR, now - 3 * DAY), mk('s4', 30 * DAY, now - 2 * DAY), mk('s5', -2 * HOUR, now - DAY)];
  await L.evaluate(s => localStorage.setItem('td.tasks', JSON.stringify(s)), seed);
  await L.reload(); await L.waitForTimeout(400);
  // the same formula, independently
  let v = 0; const hist = [];
  for (const o of [12 * HOUR, 12 * HOUR, 12 * HOUR, 30 * DAY, -2 * HOUR]) {
    if (o > 0) { hist.push(Math.min(o, base)); if (hist.length > 10) hist.shift(); v = Math.min(v + 0.05 * hist.reduce((a, c) => a + c, 0) / hist.length, 0.25 * base); } else v *= 0.98;
  }
  await L.fill('#taskName', 'Fresh P2'); await L.click('label[for="add-u-3"]'); await L.click('#addBtn'); await L.waitForTimeout(150);
  t = await stored(L, 'Fresh P2');
  assert.equal(t.truce.res, Math.round(base + v)); assert.ok(v < 0.11 * base, 'even a 30-day outlier stays small: ' + v / HOUR + ' h');
  console.log(`  P2 learned after 3×12 h misses, a 30-day outlier and one on-time close: +${(v / MIN).toFixed(1)} min on a 24 h target`);
  step('learned factor matches the formula; outlier capped; on-time close shrinks it');
  await L.click('#view .task:has-text("Fresh P2") .task-main'); await L.waitForTimeout(100);
  assert.match(await L.textContent('#editTruce'), /incl\. \+2 h 30 min learned/);
  await L.keyboard.press('Escape');

  // Settings: edit targets
  await L.click('#openMore'); await L.waitForTimeout(200);
  assert.match(await L.textContent('#trucePanel'), /\+2 h 30 min learned/);
  await L.fill('input[name="resp-3"]', 'abc'); await L.click('#truceForm button[type="submit"]');
  assert.match(await L.textContent('#toast'), /P3: use a time like/);
  await L.fill('input[name="resp-3"]', '2h'); await L.fill('input[name="res-3"]', '2d'); await L.click('#truceForm button[type="submit"]'); await L.waitForTimeout(150);
  await L.screenshot({path: 't-settings.png'});
  await L.keyboard.press('Escape');
  await L.fill('#taskName', 'P3 thing'); await L.click('#addBtn'); await L.waitForTimeout(150);
  t = await stored(L, 'P3 thing');
  assert.equal(t.truce.resp, 2 * HOUR); assert.equal(t.truce.res, 2 * DAY);
  step('Settings: TRUCE targets validate, save and apply to new tickets');

  // Insights + export
  await L.click('#tab-done'); await L.waitForTimeout(300);
  assert.match(await L.textContent('[aria-label="TRUCE"]'), /resolved within TRUCE \(1\/5\)/);
  await L.click('#doneExport');
  const [d] = await Promise.all([L.waitForEvent('download'), L.click('#exportPop [data-exp="completed"]')]);
  const csv = fs.readFileSync(await d.path(), 'utf8').replace(/^﻿/, '').split('\r\n');
  assert.match(csv[0], /Response target \(h\),Responded after \(h\),Response met,Resolution target \(h\),Resolved after excl\. pauses \(h\),Resolution met,Paused \(h\),Pause reasons,Comments$/);
  assert.match(csv.find(l => l.includes('Seed s5')), /,24\.00,22\.00,yes,/);
  step('Done tab shows TRUCE results; CSV export includes response/resolution/pauses');

  // ---------- celebration schedule ----------
  const sched = async (doneCount, rnd, opts) => {
    const P = await ctxFor(opts); await P.goto(BASE);
    const tasks = Array.from({length: doneCount}, (_, i) => ({id: 'd' + i, seq: i + 1, name: 'Old ' + i, urgency: 2, impact: 2, day: dk(-2), done: true, doneAt: now - 2 * DAY + i, createdAt: now - 3 * DAY, updatedAt: now}));
    tasks.push({id: 'o1', seq: 9001, name: 'Close me', urgency: 2, impact: 2, day: dk(), done: false, doneAt: null, createdAt: now - HOUR, updatedAt: now},
               {id: 'o2', seq: 9002, name: 'Keep me open', urgency: 2, impact: 2, day: dk(), done: false, doneAt: null, createdAt: now - HOUR, updatedAt: now});
    await P.evaluate(t => localStorage.setItem('td.tasks', JSON.stringify(t)), tasks);
    await P.reload(); await P.waitForTimeout(400);
    await P.evaluate(r => { Math.random = () => r; }, rnd);
    await P.click('#view .task:has-text("Close me") .check'); await P.waitForTimeout(60);
    const r = {fx: !!(await P.$('canvas.fx')), banner: await P.$eval('.fx-banner', e => e.textContent).catch(() => null), toast: await P.textContent('#toast'), cls: await P.getAttribute('#toast', 'class')};
    await P.context().close(); return r;
  };
  let r = await sched(98, 0.99);  assert.ok(!r.fx && /^Done: Close me/.test(r.toast) && !/celebrate/.test(r.cls), JSON.stringify(r));
  r = await sched(98, 0.59);  assert.ok(r.fx, '99th close at 60%: random 0.59 celebrates');
  r = await sched(99, 0.99);  assert.ok(r.fx && r.banner === '100th ticket!', '100th is a milestone: ' + JSON.stringify(r));
  r = await sched(340, 0.19); assert.ok(r.fx, '341st at 20%: 0.19 celebrates');
  r = await sched(340, 0.21); assert.ok(!r.fx, '341st at 20%: 0.21 does not');
  step('schedule: 99th close 60% (0.99 → stamp only, 0.59 → fanfare), 100th always (milestone banner), 341st+ fixed at 20%');
  r = await sched(3, 0.99, {reducedMotion: 'reduce'}); assert.ok(!r.fx && /celebrate/.test(r.cls), 'reduced motion: no confetti, toast still celebrates');
  const Off = await ctxFor(); await Off.goto(BASE); await Off.evaluate(() => localStorage.setItem('td.celebrate', 'false'));
  await Off.fill('#taskName', 'Quiet'); await Off.click('#addBtn'); await Off.click('#view .task:has-text("Quiet") .check'); await Off.waitForTimeout(60);
  assert.ok(!(await Off.$('canvas.fx')) && /^Done: Quiet/.test(await Off.textContent('#toast')));
  step('reduced motion: praise without confetti; celebrations can be switched off');

  // ---------- settings sync across devices + phone layout ----------
  const S1 = await ctxFor(); await S1.goto(BASE);
  await S1.click('#sync'); await S1.click('[data-sync="create"]'); await S1.waitForTimeout(900);
  const key = (await S1.textContent('#keyText')).trim();
  await S1.fill('input[name="res-1"]', '6h'); await S1.click('#truceForm button[type="submit"]'); await S1.waitForTimeout(1200);
  const S2 = await ctxFor({...devices['iPhone 13']}); await S2.goto(BASE + '/#join=' + key); await S2.click('[data-sync="join-yes"]'); await S2.waitForTimeout(1400);
  await S2.keyboard.press('Escape'); await S2.click('#sync'); await S2.waitForTimeout(300);
  assert.equal(await S2.inputValue('input[name="res-1"]'), '6h'); await S2.keyboard.press('Escape');
  step('custom TRUCE targets sync to other devices');
  await S2.fill('#taskName', 'Phone ticket with a long name to check the row'); await S2.click('label[for="add-u-3"]'); await S2.click('#addBtn'); await S2.waitForTimeout(300);
  assert.ok(await S2.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await S2.screenshot({path: 't-phone.png'});
  step('ticket row with “On it” and the TRUCE chip fits a phone');
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
