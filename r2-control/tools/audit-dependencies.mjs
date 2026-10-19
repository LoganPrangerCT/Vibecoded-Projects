// Read-only known-advisory lookup for the exact public crate versions in Cargo.lock.
// This is an OSV database query, not proof that unlisted vulnerabilities are absent.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';
const lock = await readFile(new URL('../Cargo.lock', import.meta.url), 'utf8');
const packages = lock.split('[[package]]').slice(1).map(block => ({
  name: /^name = "([^"]+)"/m.exec(block)?.[1],
  version: /^version = "([^"]+)"/m.exec(block)?.[1],
  source: /^source = "([^"]+)"/m.exec(block)?.[1]
})).filter(p => p.source?.startsWith('registry+'));
async function json(url, options = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(60000)});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
const results = [];
for (let offset = 0; offset < packages.length; offset += 100) {
  const batch = packages.slice(offset, offset + 100);
  const response = await json('https://api.osv.dev/v1/querybatch', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({queries: batch.map(p => ({package: {name: p.name, ecosystem: 'crates.io'}, version: p.version}))})
  });
  if (response.results?.length !== batch.length) throw new Error('Incomplete OSV response');
  for (let i = 0; i < batch.length; i++) {
    if (response.results[i].next_page_token) throw new Error('OSV result pagination requires follow-up');
    results.push({...batch[i], advisories: response.results[i].vulns || []});
  }
}
const ids = [...new Set(results.flatMap(p => p.advisories.map(v => v.id)))];
const advisories = [];
for (const id of ids) advisories.push(await json('https://api.osv.dev/v1/vulns/' + encodeURIComponent(id)));
const report = {
  checkedAt: new Date().toISOString(), source: 'https://api.osv.dev/v1/querybatch',
  lockSha256: createHash('sha256').update(lock).digest('hex'),
  scope: 'All registry packages in Cargo.lock, including target-specific and build dependencies; reachability not inferred.',
  packages: results, advisories
};
const output = process.argv[2] ? resolve(process.argv[2]) : new URL('../data/dependency-advisories.json', import.meta.url);
await mkdir(output instanceof URL ? new URL('.', output) : dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({packages: packages.length, matches: results.filter(p => p.advisories.length).map(p => ({name: p.name, version: p.version, ids: p.advisories.map(v => v.id)})), advisories: advisories.map(v => ({id: v.id, summary: v.summary, withdrawn: v.withdrawn}))}, null, 2));
