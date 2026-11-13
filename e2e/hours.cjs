// TRUCE working hours, the Dropped state, and habits.
const {chromium, devices} = require('playwright');
const assert = require('assert');
const BASE = process.env.E2E_BASE || 'http://localhost:3300';
const step = s => console.log('✓', s);
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
const pad = n => String(n).padStart(2, '0');
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
(async () => {
  const b = await chromium.launch(); const errs = [];
  const page = async (opts = {}) => { const c = await b.newContext({viewport: {width: 1200, height: 1000}, ...opts}); const p = await c.newPage();
    p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); return p; };
  const stored = (p, name) => p.evaluate(n => JSON.parse(localStorage.getItem('td.tasks') || '[]').find(t => t.name === n), name);
  const chip = (p, name) => p.textContent(`#view .task:has-text("${name}") .tc`);
  const add = async (p, name, u, i) => { await p.fill('#taskName', name); if (u) await p.click(`label[for="add-u-${u}"]`); if (i) await p.click(`label[for="add-i-${i}"]`); await p.click('#addBtn'); await p.waitForTimeout(150); };
  const jump = async (p, ms) => { await p.clock.fastForward(ms); await p.clock.runFor(61000); await p.waitForTimeout(150); };

  // ---------- working hours: Friday 17:00, Mon–Fri 09:00–18:00 ----------
  const A = await page();
  await A.clock.install({time: new Date(2026, 10, 13, 17, 0, 0)});      // Fri 13 Nov 2026, 5:00 pm
  await A.goto(BASE); await A.waitForTimeout(300);
  await A.click('#openMore'); await A.waitForTimeout(200);
  assert.equal(await A.isChecked('#whOn'), false, 'default is 24 hours');
  await A.check('#whOn');
  assert.deepEqual(await A.$$eval('#whDays [aria-pressed="true"]', e => e.map(x => x.dataset.wd)), ['1', '2', '3', '4', '5']);
  await A.fill('#whFrom', '18:00'); await A.click('#truceForm button[type="submit"]');
  assert.match(await A.textContent('#toast'), /start time before the end time/);
  await A.fill('#whFrom', '09:00'); await A.fill('#whTo', '18:00');
  await A.screenshot({path: 'hours-settings.png'});
  await A.click('#truceForm button[type="submit"]'); await A.waitForTimeout(200);
  assert.match(await A.textContent('#toast'), /New tickets run Mon–Fri, 9:00 AM to 6:00 PM/);
  await A.click('#moreClose');
  step('Settings: working hours default to 24 h; custom days and times validate and save');

  await add(A, 'Late Friday outage', 3, 3);
  let t = await stored(A, 'Late Friday outage');
  assert.deepEqual(t.truce.wh, {d: [1, 2, 3, 4, 5], f: 540, t: 1080}); assert.equal(t.truce.res, 4 * HOUR);
  assert.equal(await chip(A, 'Late Friday outage'), 'Respond in 15 min');
  await A.click('#view .task:has-text("Late Friday outage") .task-main'); await A.waitForTimeout(100); await A.keyboard.press('Escape'); await A.waitForTimeout(100);
  await jump(A, 2.5 * HOUR - 61000);                                       // Fri 7:30 pm
  assert.equal(await chip(A, 'Late Friday outage'), 'Resolve in 3 h · off the clock');
  await jump(A, 14.5 * HOUR + 2 * DAY + 30 * MIN - 61000);                 // Mon 10:30 am
  assert.equal(await chip(A, 'Late Friday outage'), 'Resolve in 1 h 30 min');
  await A.click('#view .task:has-text("Late Friday outage") .task-main'); await A.waitForTimeout(100);
  const box = await A.textContent('#editTruce');
  assert.match(box, /clock runs Mon–Fri, 9:00 AM to 6:00 PM/); assert.match(box, /1 h 30 min left · due 12:00 PM/);
  await A.screenshot({path: 'hours-sheet.png'}); await A.keyboard.press('Escape');
  step('a P1 opened Friday 5 pm: 1 h counted Friday, clock off all weekend, due Monday noon');

  await add(A, 'Write the report', 2, 3);                                  // P2: 1 h / 1 day
  t = await stored(A, 'Write the report');
  assert.equal(t.truce.res, 9 * HOUR, '1 day = one 9-hour working day');
  await A.click('#view .task:has-text("Write the report") .task-main'); await A.waitForTimeout(100);
  assert.match(await A.textContent('#editTruce'), /Resolution\s*1 work day/); await A.keyboard.press('Escape');
  await add(A, 'Plan the quarter', 1, 2);                                  // P4: 1 day / 1 week
  assert.equal((await stored(A, 'Plan the quarter')).truce.res, 45 * HOUR, '1 week = five 9-hour days');
  step('with working hours, 1 day means one working day and 1 week means five');

  // ---------- Dropped ----------
  const D = await page();
  await D.goto(BASE); await D.waitForTimeout(300);
  await add(D, 'Finish me'); await add(D, 'Never mind this one');
  await D.click('#view .task:has-text("Never mind this one") .task-main'); await D.click('#editDrop'); await D.waitForTimeout(200);
  assert.match(await D.textContent('#toast'), /Dropped T-002\. It stays in your history/);
  assert.equal(await D.textContent('.dropped-sec .task:has-text("Never mind this one") .stamp'), 'Dropped');
  assert.equal(await D.$('.dropped-sec .tc'), null, 'no TRUCE verdict on a dropped ticket');
  await D.click('#view .task:has-text("Finish me") .check'); await D.waitForTimeout(200);
  await D.screenshot({path: 'dropped-day.png', fullPage: true});
  await D.click('#tab-done'); await D.waitForTimeout(300);
  assert.match(await D.textContent('#doneTitle'), /^1 done/);
  assert.match(await D.textContent('.tile'), /^1/);
  assert.equal(await D.$$eval('#doneResults .task', e => e.length), 1);
  await D.click('[data-dropped]'); await D.waitForTimeout(150);
  assert.match(await D.textContent('#doneTitle'), /^1 dropped/);
  assert.equal(await D.textContent('#doneResults .task .task-name'), 'Never mind this one');
  await D.click('#doneResults .task .check'); await D.waitForTimeout(200);
  t = await stored(D, 'Never mind this one');
  assert.ok(!t.done && !t.dropped); assert.match(await D.textContent('#doneTitle'), /^0 dropped/);
  step('Drop closes a ticket without counting it as done; Done tab can list dropped tickets; ticking one reopens it');

  // ---------- Logged after the fact ----------
  const I = await page();
  await I.goto(BASE); await I.waitForTimeout(300);
  await add(I, 'Already did this', 3, 3); await I.click('#view .task:has-text("Already did this") .check'); await I.waitForTimeout(250);
  assert.equal(await chip(I, 'Already did this'), 'Logged after the fact');
  assert.doesNotMatch(await I.textContent('#toast'), /TRUCE/);
  assert.doesNotMatch(await I.textContent('#view .task:has-text("Already did this") .task-meta'), /took/);
  await I.evaluate(() => { const now = Date.now(), a = JSON.parse(localStorage.getItem('td.tasks'));
    a.push({id: 'late', seq: 2, name: 'Real late one', urgency: 3, impact: 3, day: a[0].day, done: true, createdAt: now - 6 * 36e5, doneAt: now - 36e5, updatedAt: 1, truce: {start: now - 6 * 36e5, resp: 9e5, res: 4 * 36e5}});
    localStorage.setItem('td.tasks', JSON.stringify(a)); });
  await I.reload(); await I.waitForTimeout(500);
  await add(I, 'Next P1', 3, 3);
  const nx = await stored(I, 'Next P1');
  assert.equal(nx.truce.learnedRes, 3 * MIN, 'only the real miss (1 h over) is learned: 5% of 60 min');
  await I.click('#tab-done'); await I.waitForTimeout(300);
  assert.match(await I.textContent('[aria-label="TRUCE"]'), /resolved within TRUCE \(0\/1\)/);
  assert.match(await I.textContent('#doneTitle'), /^2 done/);
  step('a ticket ticked off within a minute counts as done but not towards TRUCE, the learned factor or time-to-done');

  // ---------- Habits ----------
  const H = await page();
  await H.goto(BASE);
  const now = Date.now(), d0 = new Date(), dk = n => { const d = new Date(d0); d.setDate(d.getDate() + n); return key(d); };
  const rule = {id: 'H1', name: 'Meditate', freq: 'daily', days: [], dom: 1, start: dk(-5), urgency: 2, impact: 1, habit: true, paused: false, lastGen: dk(-1), createdAt: now, updatedAt: 1};
  const plain = {id: 'R2', name: 'Check dashboards', freq: 'daily', days: [], dom: 1, start: dk(-5), urgency: 2, impact: 2, paused: false, lastGen: dk(-1), createdAt: now, updatedAt: 1};
  const inst = (r, n, seq) => ({id: 'r' + r.id + '-' + dk(n).replace(/-/g, ''), ruleId: r.id, seq, name: r.name, urgency: r.urgency, impact: r.impact, day: dk(n), done: false, doneAt: null, notes: '', createdAt: now - DAY, updatedAt: 1});
  await H.evaluate(([r, t]) => { localStorage.setItem('td.rules', JSON.stringify(r)); localStorage.setItem('td.tasks', JSON.stringify(t)); }, [[rule, plain], [inst(rule, -1, 1), inst(plain, -1, 2)]]);
  await H.reload();
  await H.waitForFunction(() => { const t = JSON.parse(localStorage.getItem('td.tasks') || '[]'); return t.some(x => x.ruleId === 'H1' && !x.done) && t.some(x => x.ruleId === 'R2' && x.truce); }, null, {timeout: 8000});
  await H.waitForTimeout(400);
  const all = await H.evaluate(() => JSON.parse(localStorage.getItem('td.tasks')));
  const yest = all.find(x => x.ruleId === 'H1' && x.missed), today = all.find(x => x.ruleId === 'H1' && !x.done);
  assert.ok(yest && yest.dropped && yest.done, 'yesterday’s habit is recorded as missed');
  assert.ok(today && today.day === dk(0) && today.noTruce && !today.truce, 'a fresh copy for today, no TRUCE');
  assert.equal(all.filter(x => x.ruleId === 'R2').length, 1); assert.equal(all.find(x => x.ruleId === 'R2').day, dk(0));
  assert.deepEqual(await H.$$eval('.carried-sec .task-name', e => e.map(x => x.textContent)), ['Check dashboards']);
  assert.equal(await H.$('#view .task:has-text("Meditate") .tc'), null);
  assert.match(await H.textContent('#view .task:has-text("Meditate") .rep'), /Habit · Every day/);
  step('a missed habit is recorded as missed, not carried over; today gets a fresh copy with no TRUCE; ordinary recurring tasks still carry');

  await H.click('[data-nav="prev"]'); await H.waitForTimeout(150);
  assert.equal(await H.textContent('.dropped-sec .task:has-text("Meditate") .stamp'), 'Missed');
  await H.click('.dropped-sec .task:has-text("Meditate") .check'); await H.waitForTimeout(200);
  assert.match(await H.textContent('#toast'), /^Marked done for /);
  assert.equal(await H.textContent('#view .task:has-text("Meditate") .stamp'), 'Done');
  await H.click('#tab-done'); await H.waitForTimeout(300);
  const strip = await H.$$eval('.habit:has-text("Meditate") .hs', e => e.map(x => x.classList[1]));
  assert.equal(strip[26], 'done'); assert.equal(strip[27], 'pending'); assert.equal(strip[25], 'missed');
  step('ticking a missed habit marks it done for that day, and the habit strip shows it');

  await H.click('#tab-day'); await H.click('#openRecur'); await H.waitForTimeout(400);
  await H.fill('#ruleName', 'Stretch'); await H.click('label[for="rule-freq-daily"]'); await H.check('#ruleHabit');
  await H.screenshot({path: 'habit-form.png'});
  await H.click('#ruleForm button[type="submit"]'); await H.waitForTimeout(700);
  assert.match(await H.textContent('#ruleList'), /Stretch.*Habit · Every day/s);
  assert.ok((await stored(H, 'Stretch')).noTruce);
  step('the recurring form has a habit switch');

  const P = await page({...devices['iPhone 13']});
  await P.goto(BASE); await P.click('#sync'); await P.waitForTimeout(200); await P.check('#whOn'); await P.waitForTimeout(100);
  assert.ok(await P.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await (await P.$('#trucePanel')).screenshot({path: 'hours-phone.png'});
  step('working-hours settings fit a phone');
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
