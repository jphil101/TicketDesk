const {chromium, devices} = require('playwright');
const assert = require('assert'), fs = require('fs');
const BASE = process.env.E2E_BASE || 'http://localhost:3300';
const step = s => console.log('✓', s);
const pad = n => String(n).padStart(2, '0');
const dayAt = (n, h = 9, m = 0) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, m, 0, 0); return d; };
const dk = n => { const d = dayAt(n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const now = Date.now();
const T = (id, seq, name, u, i, o) => ({id, seq, name, urgency: u, impact: i, day: o.day, done: !!o.doneAt, doneAt: o.doneAt || null, notes: '', createdAt: o.createdAt, updatedAt: now, ...(o.extra || {})});
const tasks = [];
let seq = 1;
for (let n = -20; n <= -1; n++) if (n !== -5 && n !== -12)
  tasks.push(T('m' + (-n), seq++, 'Meditate', 2, 1, {day: dk(n), createdAt: +dayAt(n, 6), doneAt: +dayAt(n, 7, 30), extra: {ruleId: 'R1'}}));
tasks.push(T('rent', seq++, 'Pay rent', 3, 2, {day: dk(-5), createdAt: +dayAt(-7, 10), doneAt: +dayAt(-5, 10)}));
tasks.push(T('bug', seq++, 'Fix login bug', 3, 3, {day: dk(-2), createdAt: +dayAt(-2, 9), doneAt: +dayAt(-2, 12)}));
tasks.push(T('old', seq++, 'Old report', 2, 2, {day: dk(-40), createdAt: +dayAt(-41, 9), doneAt: +dayAt(-40, 9)}));
tasks.push(T('g1', seq++, 'Guest asked thing', 2, 2, {day: dk(0), createdAt: now - 3600e3, extra: {fromGuest: true, requestedAt: now - 7200e3, notes: 'Requested by Sam'}}));
tasks.push(T('wk', seq++, 'Week old task', 1, 2, {day: dk(0), createdAt: now - 6 * 864e5}));
tasks.push(T('anc', seq++, 'Ancient task', 2, 3, {day: dk(0), createdAt: now - 20 * 864e5}));
const rules = [{id: 'R1', name: 'Meditate', freq: 'daily', days: [], dom: 1, start: dk(-20), urgency: 2, impact: 1, paused: false, lastGen: dk(-1), createdAt: now, updatedAt: now}];

(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({viewport: {width: 1200, height: 1000}, acceptDownloads: true}); const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE);
  await p.evaluate(([t, r]) => { localStorage.setItem('td.tasks', JSON.stringify(t)); localStorage.setItem('td.rules', JSON.stringify(r)); }, [tasks, rules]);
  await p.goto(BASE + '/#done'); await p.reload(); await p.waitForTimeout(900);

  const tiles = await p.$$eval('.tile', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  console.log('  tiles:', tiles.join(' | '));
  assert.match(tiles[0], /^20 done · last 30 days/);
  assert.match(tiles[1], /^0\.7 per day/);
  assert.match(tiles[2], /^11 day streak/);
  step('summary tiles: 20 done in 30 days, 0.7/day, 11-day streak');
  const cells = await p.$$eval('.heat .hc', els => els.map(e => ({cls: e.className, tt: e.dataset.tt})));
  assert.equal(cells.length, 26 * 7);
  assert.match(cells[cells.length - 1].cls, /today/, 'today is the last square');
  const label = k => p.evaluate(k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short'}); }, k);
  const cellFor = async n => cells.find(c => c.tt.startsWith(label_[n]));
  const label_ = {}; for (const n of [-1, -2, -12, -30, -40]) label_[n] = await label(dk(n));
  const at = n => cells.find(c => c.tt.startsWith(label_[n] + ':') || c.tt.startsWith(label_[n] + ' '));
  assert.match(at(-12).cls, /\bidle\b/); assert.match(at(-12).tt, /open, none closed/);
  assert.match(at(-30).cls, /\bl0\b/); assert.match(at(-30).tt, /no tickets/);
  assert.match(at(-2).cls, /\bl4\b/); assert.match(at(-2).tt, /2 closed · \d+ still open/);
  assert.match(at(-1).cls, /\bl[1-4]\b/);
  assert.match(at(-40).cls, /\bl[1-4]\b/);
  assert.match(cells[cells.length - 1].tt, /\(today\): \d+ open, none closed/);
  const geo = await p.$eval('.heat', g => { const r = g.getBoundingClientRect(), cs = [...g.querySelectorAll('.hc')].map(c => c.getBoundingClientRect()); return {past: Math.max(...cs.map(c => c.right)) - r.right, sizes: new Set(cs.map(c => Math.round(c.width))).size, cell: Math.round(cs[0].width), last: cs[cs.length - 1].right >= Math.max(...cs.map(c => c.right)) - 0.5 && cs[cs.length - 1].bottom >= Math.max(...cs.map(c => c.bottom)) - 0.5}; });
  assert.ok(geo.past <= 0.5 && geo.sizes === 1 && geo.last, JSON.stringify(geo));
  assert.match(await p.textContent('.ins .note'), /^21 closed on 20 days · \d+ days with open tickets but nothing closed/);
  step('grid: 26×7 equal squares, today bottom-right, states: none / open-none-closed / closed (by count)');

  const habit = await p.$eval('.habit', e => e.innerText.replace(/\s+/g, ' '));
  assert.match(habit, /Meditate Every day/); assert.match(habit, /4 in a row · 90%/);
  const strip = await p.$$eval('.habit .hs', els => els.map(e => e.classList[1]));
  assert.equal(strip.length, 28);
  assert.equal(strip.filter(s => s === 'done').length, 18); assert.equal(strip.filter(s => s === 'missed').length, 2); assert.equal(strip[27], 'pending');
  step('habit row: 18 done, 2 missed, due today, 4 in a row, 90%');

  const aging = await p.$$eval('.ab-row', els => els.slice(0, 5).map(e => e.innerText.replace(/\s+/g, ' ')));
  assert.deepEqual(aging.map(x => x.match(/(\d+)$/)[1]), ['2', '0', '1', '0', '1']);
  assert.match(await p.textContent('.oldest .old-item'), /Ancient task.*open 20 d/);
  const ttd = await p.$$eval('.ins-row .ab-row.p1, .ins-row .ab-row.p2', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
  assert.ok(ttd.some(x => /P1 Critical 3 h/.test(x)) && ttd.some(x => /P2 High 2 d/.test(x)), ttd.join(';'));
  step('aging buckets (2 / 0 / 1 / 0 / 1) and time to done by priority (P1 3 h, P2 2 d)');
  await p.screenshot({path: 'i-done-desktop.png', fullPage: true});

  await p.hover('.heat .hc.today'); await p.waitForTimeout(100);
  assert.match(await p.textContent('.tt'), /\(today\): \d+ open, none closed$/); step('calendar tooltip on hover');

  await p.click('.oldest .old-item'); await p.waitForTimeout(200);
  assert.match(await p.textContent('#editTimes'), /Opened .* · ?|Opened .*Open for 20 d/);
  assert.match(await p.textContent('#editTimes'), /Open for 20 d/);
  await p.keyboard.press('Escape');
  await p.click('#view .task:has-text("Pay rent") .task-main'); await p.waitForTimeout(200);
  const pr = await p.textContent('#editTimes');
  assert.match(pr, /Opened .*10:00/); assert.match(pr, /Done .* · took 2 d/); await p.keyboard.press('Escape');
  assert.match(await p.textContent('#view .task:has-text("Fix login bug") .task-meta'), /took 3 h/);
  step('opened / done times and time taken shown in the ticket sheet and the Done list');

  await p.fill('#doneSearch', 'pay'); await p.waitForTimeout(200);
  assert.match(await p.textContent('#doneTitle'), /^1/); assert.match(await p.textContent('.ins .note'), /^1 closed on 1 day/);
  await p.fill('#doneSearch', ''); await p.waitForTimeout(150);
  step('search narrows the calendar and totals (habit-by-name view)');

  const dl = async (which) => { await p.click('#doneExport'); const [d] = await Promise.all([p.waitForEvent('download'), p.click(`#exportPop [data-exp="${which}"]`)]); return {name: d.suggestedFilename(), text: fs.readFileSync(await d.path(), 'utf8').replace(/^﻿/, '')}; };
  const c = await dl('completed');
  const lines = c.text.split('\r\n');
  assert.match(c.name, /^ticket-desk-completed-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(lines[0], 'Ticket,Task,Priority,Urgency,Impact,Opened,Done,Hours to done,Planned day,Carried from,Repeats,From guest,Notes,Response target (h),Responded after (h),Response met,Resolution target (h),Resolved after excl. pauses (h),Resolution met,Paused (h),Pause reasons,Comments');
  assert.equal(lines.length - 1, 20);
  const rent = lines.find(l => l.includes('Pay rent')).split(',');
  assert.equal(rent[7], '48.0'); assert.match(rent[5], /^\d{4}-\d{2}-\d{2} 10:00$/);
  assert.match(lines.find(l => l.includes('Meditate')), /Meditate \(Every day\)/);
  const d = await dl('daily');
  const dlines = d.text.split('\r\n');
  assert.equal(dlines[0], 'Date,Weekday,Done,P1,P2,P3,P4,P5,Habit: Meditate');
  assert.equal(dlines.length - 1, 30);
  const row = k => dlines.find(l => l.startsWith(dk(k))).split(',');
  assert.equal(row(-5)[8], '0'); assert.equal(row(-4)[8], '1'); assert.equal(row(-5)[2], '1');
  step('export: completed tickets (20 rows, local times, hours to done) and daily totals with a habit column');

  const P = await (await b.newContext({...devices['iPhone 13']})).newPage();
  P.on('pageerror', e => errs.push('phone ' + e.message));
  await P.goto(BASE);
  await P.evaluate(([t, r]) => { localStorage.setItem('td.tasks', JSON.stringify(t)); localStorage.setItem('td.rules', JSON.stringify(r)); }, [tasks, rules]);
  await P.goto(BASE + '/#done'); await P.reload(); await P.waitForTimeout(900);
  const sw = await P.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw[0] <= sw[1], 'no sideways scroll on phone ' + sw);
  await P.screenshot({path: 'i-done-phone.png', fullPage: true});
  const cellPhone = await P.$eval('.heat .hc', c => Math.round(c.getBoundingClientRect().width)); assert.equal(await P.$$eval('.heat .hc', e => e.length), 15 * 7);
  assert.ok(cellPhone >= 16, 'phone squares are big enough to tap: ' + cellPhone);
  for (const [w, scheme] of [[1200, 'dark'], [390, 'dark'], [360, 'light']]) {
    const Q = await (await b.newContext({viewport: {width: w, height: 900}, colorScheme: scheme, isMobile: w < 500, hasTouch: w < 500})).newPage();
    await Q.goto(BASE); await Q.evaluate(([t, r]) => { localStorage.setItem('td.tasks', JSON.stringify(t)); localStorage.setItem('td.rules', JSON.stringify(r)); }, [tasks, rules]);
    await Q.goto(BASE + '/#done'); await Q.reload(); await Q.waitForTimeout(700);
    const o = await Q.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert.ok(o, 'no overflow at ' + w);
    const el = await Q.$('.ins'); await el.screenshot({path: `i-cal-${w}-${scheme}.png`});
  }
  step('fits a phone screen without sideways scrolling');
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
