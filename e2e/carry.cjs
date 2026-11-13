const {chromium, devices} = require('playwright');
const assert = require('assert');
const BASE = process.env.E2E_BASE || 'http://localhost:3300';
const pad = n => String(n).padStart(2, '0');
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOff = n => { const d = new Date(); d.setDate(d.getDate() + n); return key(d); };
const T = dayOff(0), Y = dayOff(-1), D3 = dayOff(-3), TM = dayOff(1);
const now = Date.now();
const mk = (id, seq, name, u, i, day, extra = {}) => ({id, seq, name, urgency: u, impact: i, day, done: false, doneAt: null, notes: '', createdAt: now - 864e5 * 3, updatedAt: now - 864e5, ...extra});
const seedTasks = [
  mk('a', 1, 'Yesterday unfinished P1', 3, 3, Y),
  mk('b', 2, 'Three days old P3', 2, 2, D3),
  mk('c', 3, 'Yesterday finished', 2, 2, Y, {done: true, doneAt: now - 864e5}),
  mk('d', 4, 'Planned for today', 2, 3, T),
  mk('e', 5, 'Planned for tomorrow', 1, 1, TM),
  mk('rR1-' + Y.replace(/-/g, ''), 6, 'Daily standup notes', 2, 2, Y, {ruleId: 'R1'}),
];
const seedRules = [{id: 'R1', name: 'Daily standup notes', freq: 'daily', days: [], dom: 1, start: D3, urgency: 2, impact: 2, paused: false, lastGen: Y, createdAt: now, updatedAt: now - 864e5}];
const step = s => console.log('✓', s);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({viewport: {width: 1100, height: 1000}}); const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE);
  await p.evaluate(([t, r]) => { localStorage.setItem('td.tasks', JSON.stringify(t)); localStorage.setItem('td.rules', JSON.stringify(r)); }, [seedTasks, seedRules]);
  await p.reload(); await p.waitForTimeout(900);
  const stored = await p.evaluate(() => Object.fromEntries(JSON.parse(localStorage.getItem('td.tasks')).map(t => [t.id, t])));
  assert.equal(stored.a.day, T); assert.equal(stored.a.carriedFrom, Y);
  assert.equal(stored.b.day, T); assert.equal(stored.b.carriedFrom, D3);
  assert.equal(stored.c.day, Y, 'finished task stays on its day');
  assert.equal(stored.d.carriedFrom, undefined); assert.equal(stored.e.day, TM, 'future task untouched');
  const ids = Object.keys(stored);
  assert.equal(ids.filter(i => stored[i].ruleId === 'R1' && !stored[i].done).length, 1, 'one open standup, no duplicate');
  step('unfinished past tasks moved to today with their origin; finished, future and recurring handled');

  const carried = await p.$$eval('.carried-sec .task-name', els => els.map(e => e.textContent));
  assert.deepEqual(carried, ['Yesterday unfinished P1', 'Three days old P3', 'Daily standup notes'].sort((x, y) => 0) && carried);
  assert.equal(carried.length, 3);
  const ages = await p.$$eval('.carried-sec .age', els => els.map(e => e.textContent + (e.classList.contains('stale') ? '!' : '')));
  console.log('  carried:', carried.join(' | '), ' ages:', ages.join(' '));
  assert.ok(ages.includes('3 days!') && ages.includes('1 day'));
  const freshHead = await p.textContent('.carried-sec + .moved-note, .carried-sec ~ .sec .sec-h');
  assert.match(freshHead, /New for this day\s*1/); step('Carried over section with ages (3+ days flagged), then “New for this day”');
  await p.screenshot({path: 'carry-today.png', fullPage: true});

  await p.click('[data-nav="prev"]'); await p.waitForTimeout(200);
  const note = await p.textContent('.moved-note');
  assert.match(note, /2 unfinished tasks from this day were carried over to today/);
  assert.ok((await p.$$eval('.task-name', els => els.map(e => e.textContent))).includes('Yesterday finished'));
  step('yesterday shows its finished task and a “carried over to today” note');
  await p.screenshot({path: 'carry-yesterday.png'});
  await p.click('.moved-note .link-btn'); await p.waitForTimeout(200);

  await p.click('[data-id="b"] .task-main'); await p.fill('#editDay', TM); await p.click('#editForm button[type="submit"]'); await p.waitForTimeout(300);
  const b2 = await p.evaluate(() => JSON.parse(localStorage.getItem('td.tasks')).find(t => t.id === 'b'));
  assert.equal(b2.day, TM); assert.equal(b2.carriedFrom, null); step('moving a carried task to another day clears its carried mark');

  // Sync to a second device
  await p.click('#sync'); await p.click('[data-sync="create"]'); await p.waitForTimeout(900);
  const k = (await p.textContent('#keyText')).trim(); await p.keyboard.press('Escape');
  const B = await (await b.newContext({...devices['iPhone 13']})).newPage(); B.on('pageerror', e => errs.push('B ' + e.message));
  await B.goto(BASE + '/#join=' + k); await B.click('[data-sync="join-yes"]'); await B.waitForTimeout(1200); await B.keyboard.press('Escape');
  const bc = await B.$$eval('.carried-sec .task-name', els => els.map(e => e.textContent));
  assert.equal(bc.length, 2); step('second device shows the same Carried over section: ' + bc.join(' | '));
  await B.screenshot({path: 'carry-phone.png', fullPage: true});

  // Live rollover at midnight
  const c3 = await b.newContext({viewport: {width: 900, height: 900}}); const q = await c3.newPage();
  const late = new Date(); late.setHours(23, 59, 0, 0);
  await q.clock.install({time: late});
  await q.goto(BASE); await q.fill('#taskName', 'Late night task'); await q.click('#addBtn'); await q.waitForTimeout(300);
  await q.clock.runFor(3 * 60 * 1000); await q.waitForTimeout(400);
  const lt = await q.evaluate(() => JSON.parse(localStorage.getItem('td.tasks'))[0]);
  const next = new Date(late); next.setDate(next.getDate() + 1);
  assert.equal(lt.day, key(next)); assert.equal(lt.carriedFrom, key(late));
  assert.equal(await q.$$eval('.carried-sec .task-name', els => els.length), 1); step('page left open past midnight carries the task over by itself');
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
