import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('addon/manifest.json', root), 'utf8'));

test('manifest includes the Zotero-required update URL and compatibility fields', () => {
  const app = manifest.applications.zotero;
  for (const field of ['id', 'update_url', 'strict_min_version', 'strict_max_version']) assert.ok(app[field], field);
  assert.equal(new URL(app.update_url).protocol, 'https:');
});
test('built XPI contains the manifest and matches its published update hash', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: fileURLToPath(root) });
  const archive = await readFile(new URL(`dist/zotero-codex-listener-${manifest.version}.xpi`, root));
  const entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(archive.readUInt16LE(offset + 8), 0); // Store method
    const size = archive.readUInt32LE(offset + 18), nameLength = archive.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + archive.readUInt16LE(offset + 28);
    entries.set(archive.subarray(offset + 30, offset + 30 + nameLength).toString(), archive.subarray(start, start + size));
    offset = start + size;
  }
  assert.deepEqual(JSON.parse(entries.get('manifest.json')), manifest);
  assert.ok(entries.has('bootstrap.js'));
  const updates = JSON.parse(await readFile(new URL('updates.json', root), 'utf8'));
  const update = updates.addons[manifest.applications.zotero.id].updates[0];
  assert.equal(update.version, manifest.version);
  assert.equal(update.update_hash, `sha256:${createHash('sha256').update(archive).digest('hex')}`);
  assert.ok(update.update_link.endsWith(`/v${manifest.version}/zotero-codex-listener-${manifest.version}.xpi`));
});
