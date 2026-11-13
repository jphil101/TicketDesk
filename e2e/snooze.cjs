const {chromium, devices} = require('playwright');
const assert = require('assert'), fs = require('fs');
const BASE = process.env.E2E_BASE || 'http://localhost:3300', step = s => console.log('✓', s);
const pad = n => String(n).padStart(2, '0');
const dk = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const [name, opts] of [['desktop', {viewport: {width: 1200, height: 900}, acceptDownloads: true}], ['phone', {...devices['iPhone 13'], colorScheme: 'dark'}]]) {
    const p = await (await b.newContext(opts)).newPage();
    p.on('pageerror', e => errs.push(name + ': ' + e.message));
    await p.goto(BASE);
    await p.evaluate(t => localStorage.setItem('td.tasks', JSON.stringify(t)), [{id: 'a', seq: 1, name: 'Pay the plumber', urgency: 2, impact: 2, day: dk(-1), done: false, doneAt: null, notes: '', createdAt: Date.now() - 864e5, updatedAt: 1}]);
    await p.reload(); await p.waitForTimeout(500);
    const snz = async (reason, pick) => {
      if (await p.isVisible('[data-id="a"] .snz')) await p.click('[data-id="a"] .snz');
      else { await p.click('[data-id="a"] .task-main'); await p.click('#editSnooze'); }   // phones: from the ticket sheet
      await p.waitForTimeout(150);
      assert.equal(await p.evaluate(() => document.activeElement.id), 'snzReason', 'reason box gets focus');
      if (reason !== null) await p.fill('#snzReason', reason);
      if (pick) { await p.fill('#snzDay', pick); await p.click('#snoozePop [data-snz="pick"]'); } else await p.press('#snzReason', 'Enter');
      await p.waitForTimeout(250);
    };
    await snz('   ', null);
    assert.ok(await p.isVisible('#snzErr')); assert.equal((await p.evaluate(() => JSON.parse(localStorage.getItem('td.tasks'))[0])).day, dk(0), 'blank reason: not snoozed');
    await p.keyboard.press('Escape');
    step(`${name}: a blank reason is refused`);
    await snz('Waiting for the invoice', null);           // Enter = first option (tomorrow)
    let t = await p.evaluate(() => JSON.parse(localStorage.getItem('td.tasks'))[0]);
    assert.equal(t.day, dk(1)); assert.equal(t.comments.length, 1); assert.equal(t.comments[0].text, 'Waiting for the invoice'); assert.equal(t.comments[0].to, dk(1));
    // bring it back to today to snooze again with "pick a day"
    await p.evaluate(() => { const a = JSON.parse(localStorage.getItem('td.tasks')); a[0].day = a[0].day; localStorage.setItem('td.tasks', JSON.stringify(a)); });
    await p.click('[data-nav="next"]'); await p.waitForTimeout(150);
    await snz('Plumber away till Friday', dk(4));
    t = await p.evaluate(() => JSON.parse(localStorage.getItem('td.tasks'))[0]);
    assert.equal(t.day, dk(4)); assert.equal(t.comments.length, 2);
    step(`${name}: reasons saved as comments (Enter = tomorrow; picked day works)`);
    await p.click('[data-nav="today"]'); for (let i = 0; i < 4; i++) await p.click('[data-nav="next"]'); await p.waitForTimeout(150);
    const d = await p.$('[data-id="a"] .t-notes');
    assert.ok(d && !(await d.evaluate(e => e.open)), 'collapsed by default');
    assert.equal(await p.textContent('[data-id="a"] .t-notes summary'), '2 comments');
    await p.click('[data-id="a"] .t-notes summary'); await p.waitForTimeout(100);
    const items = await p.$$eval('[data-id="a"] .t-notes li span', e => e.map(x => x.textContent));
    assert.deepEqual(items, ['Waiting for the invoice', 'Plumber away till Friday']);
    await p.evaluate(() => dispatchEvent(new Event('focus'))); await p.click('[data-nav="prev"]'); await p.click('[data-nav="next"]'); await p.waitForTimeout(100);
    assert.ok(await p.$eval('[data-id="a"] .t-notes', e => e.open), 'stays open across re-renders');
    await p.$eval('[data-id="a"]', e => e.scrollIntoView());
    await (await p.$('[data-id="a"]')).screenshot({path: `s-notes-${name}.png`});
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    step(`${name}: collapsed “2 comments” section under the ticket, bullet list when opened, remembers open state`);
    if (await p.isVisible('[data-id="a"] .snz')) await p.click('[data-id="a"] .snz'); else { await p.click('[data-id="a"] .task-main'); await p.click('#editSnooze'); }
    await p.fill('#snzReason', 'one more'); await p.press('#snzReason', 'Enter'); await p.waitForTimeout(200);
    await p.click('#toast button'); await p.waitForTimeout(200);
    t = await p.evaluate(() => JSON.parse(localStorage.getItem('td.tasks'))[0]);
    assert.equal(t.comments.length, 2); assert.equal(t.day, dk(4));
    step(`${name}: undo removes the snooze and its comment`);
    if (name === 'desktop') {
      await p.click('#openMore'); const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#expCsv')]);
      const csv = fs.readFileSync(await dl.path(), 'utf8');
      assert.match(csv, /Comments\r\n/); assert.match(csv, /snoozed to \d{4}-\d{2}-\d{2}: Waiting for the invoice \| .*Plumber away till Friday/);
      step('exports include the comments');
    }
  }
  console.log('errors:', errs.length ? errs : 'none'); await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
