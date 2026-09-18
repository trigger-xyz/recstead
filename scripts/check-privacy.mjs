import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, sep } from 'node:path';
/** @param {string[]} args @returns {string} */
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const tracked = new Set(git('ls-files', '-z').split('\0').filter(Boolean));
const candidates = new Set([...tracked, ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)]);
const forbidden = /^(?:\.private|work|outputs|m0|node_modules|\.artifacts)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.npmrc$/;
/** @param {string} name @param {string} text @param {string} location */
function inspect(name, text, location) {
  assert(!/\/Users\/[^/\s]+\//.test(text), `Personal absolute path in ${location}: ${name}`);
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text), `Private key in ${location}: ${name}`);
  assert(!/\bnpm_[A-Za-z0-9]{30,}\b/.test(text), `Possible npm credential in ${location}: ${name}`);
}
const root = realpathSync('.');
for (const name of candidates) {
  assert(name === '.env.example' || !forbidden.test(name), `Private or generated material is visible to Git: ${name}`);
  // Check the index too: a clean worktree file must not mask staged private data.
  if (tracked.has(name)) inspect(name, git('show', `:${name}`), 'Git index');
  if (!existsSync(name)) continue;
  const target = realpathSync(name);
  assert(target.startsWith(root + sep), `Public file points outside the repository: ${name}`);
  assert(!target.startsWith(resolve('.private') + sep), `Public file points into the private archive: ${name}`);
  if (lstatSync(name).isDirectory()) continue;
  inspect(name, readFileSync(name, 'utf8'), 'worktree');
}
assert.equal(git('ls-files', '--', '.private').trim(), '', 'Private archive must never be tracked');
assert.equal(git('check-ignore', '.private/README.md').trim(), '.private/README.md');
console.log(`Git index and worktree privacy boundary verified across ${candidates.size} public files.`);
