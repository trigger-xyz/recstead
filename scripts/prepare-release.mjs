import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/** @type {{ name: string; version: string; publishConfig?: { access?: string; tag?: string; registry?: string } }} */
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
/** @type {{ version: string; filename: string; tarballSha256: string; integrity: string; files: string[] }} */
const checked = JSON.parse(await readFile('.artifacts/package-check.json', 'utf8'));
assert.equal(manifest.name, 'recstead');
assert.match(manifest.version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
assert.equal(checked.version, manifest.version);
assert.equal(checked.filename, `${manifest.name}-${manifest.version}.tgz`);
assert.equal(manifest.publishConfig?.access, 'public');
assert.equal(manifest.publishConfig?.tag, 'next');
assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/');
const artifact = `./.artifacts/${checked.filename}`;
const hash = createHash('sha256').update(await readFile(artifact)).digest('hex');
assert.equal(hash, checked.tarballSha256, 'The tarball changed after its consumer checks.');
const publishCommand = `npm publish ${artifact} --access public --tag next --registry=https://registry.npmjs.org/`;
const report = {
  preparedAt: new Date().toISOString(), name: manifest.name, version: manifest.version,
  artifact, sha256: hash, integrity: checked.integrity, files: checked.files,
  tag: 'next', registry: manifest.publishConfig.registry, published: false,
  publishCommand,
  remainingChecks: ['Review the recorded browser evidence and documented alpha limitations.', 'Commit and push reviewed public source, then check hosted CI.', 'Confirm the intended npm account, verified email, publishing 2FA and current name availability.', 'Reconfirm artifact hash and explicit publication authorization.'],
};
await writeFile('.artifacts/release-candidate.json', JSON.stringify(report, null, 2) + '\n');
console.log(`Prepared ${manifest.name}@${manifest.version}\nSHA-256 ${hash}\nPublication has not run. After the remaining release checks:\n${publishCommand}`);
