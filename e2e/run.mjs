// Runs the browser test suites against local servers it starts itself.
//   E2E_DATABASE_URL=postgres://localhost:5432/ticketdesk_e2e npm run e2e            (all suites)
//   E2E_DATABASE_URL=… npm run e2e -- truce snooze                                    (some)
// Needs a throwaway Postgres database and Playwright with Chromium
// (npm install --no-save playwright && npx playwright install chromium).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.dirname(here);
const SUITES = ['sync', 'carry', 'guests', 'batch', 'insights', 'truce', 'snooze', 'safety', 'hours'];
const want = process.argv.slice(2).filter(a => !a.startsWith('-'));
const suites = want.length ? want : SUITES;
const db = process.env.E2E_DATABASE_URL;
if (!db) { console.error('Set E2E_DATABASE_URL to a throwaway Postgres database.'); process.exit(2); }
const PORT = Number(process.env.E2E_PORT) || 3300;
const BASE = `http://localhost:${PORT}`, NODB = `http://localhost:${PORT + 1}`;

// The no-database server must not see any *DATABASE_URL / *POSTGRES_URL variable.
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/DATABASE_URL|POSTGRES_URL/.test(k)));
const servers = [
  spawn(process.execPath, ['dev-server.mjs'], { cwd: root, stdio: 'ignore', env: { ...clean, PORT: String(PORT), DATABASE_URL: db, DB_DRIVER: 'pg', ALLOW_HTTP_PUSH: '1', RESEND_API_KEY: 're_test', RESEND_API_URL: 'http://127.0.0.1:3399/emails' } }),
  spawn(process.execPath, ['dev-server.mjs'], { cwd: root, stdio: 'ignore', env: { ...clean, PORT: String(PORT + 1) } }),
];
const stop = () => servers.forEach(s => s.kill());
process.on('exit', stop); process.on('SIGINT', () => process.exit(130));

async function up(url) {
  for (let i = 0; i < 50; i++) { try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 200)); } }
  throw new Error('Server did not start: ' + url);
}
const out = path.join(here, 'out'); mkdirSync(out, { recursive: true });
const run = name => new Promise(resolve => {
  const p = spawn(process.execPath, [path.join(here, name + '.cjs')], { cwd: out, stdio: 'inherit', env: { ...process.env, E2E_BASE: BASE, E2E_BASE_NODB: NODB, E2E_DATABASE_URL: db } });
  p.on('exit', code => resolve(code === 0));
});

await up(BASE); await up(NODB);
const failed = [];
for (const name of suites) {
  console.log(`\n── ${name} ──`);
  let ok = await run(name);
  if (!ok) { console.log(`   retrying ${name} once`); ok = await run(name); }
  if (!ok) failed.push(name);
}
console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : `\nAll ${suites.length} browser suites passed.`);
process.exit(failed.length ? 1 : 0);
