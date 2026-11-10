// Prints the questions visitors have asked Darren LLM, oldest first.
//   npm run questions            (everything still stored; entries expire after 90 days)
//   npm run questions -- --json  (raw JSON instead of a readable list)
// Reads straight from Workers KV with your own wrangler login; there is no public endpoint.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrangler = (args) =>
  execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const jsonFrom = (text) => JSON.parse(text.slice(text.search(/[\[{]/)));

const keys = jsonFrom(wrangler(['kv', 'key', 'list', '--binding', 'RATE_LIMIT', '--prefix', 'q:', '--remote'])).map((k) => k.name);
if (!keys.length) {
  console.log('No questions logged yet.');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'dllm-'));
const rows = [];
try {
  for (let i = 0; i < keys.length; i += 100) {
    const file = join(dir, 'keys.json');
    writeFileSync(file, JSON.stringify(keys.slice(i, i + 100)));
    const got = jsonFrom(wrangler(['kv', 'bulk', 'get', file, '--binding', 'RATE_LIMIT', '--remote']));
    for (const [, value] of Object.entries(got)) {
      try { rows.push(typeof value === 'string' ? JSON.parse(value) : value); } catch { /* skip malformed */ }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

rows.sort((a, b) => String(a.t).localeCompare(String(b.t)));
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`${rows.length} question${rows.length === 1 ? '' : 's'}\n`);
  for (const r of rows) {
    const when = new Date(r.t).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
    console.log(`${when}  [visitor ${r.v}${r.n > 1 ? `, follow-up #${r.n}` : ''}]\n  ${String(r.q).replace(/\n/g, ' ')}\n`);
  }
}
