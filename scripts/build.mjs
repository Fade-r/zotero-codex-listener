// ZIP store format: no build dependencies, and only addon/ is packaged.
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'addon/manifest.json'), 'utf8'));
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
async function files(dir, prefix = '') {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(path.join(dir, entry.name), name + '/'));
    else if (entry.isFile()) result.push([name, await readFile(path.join(dir, entry.name))]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
const local = [], central = []; let offset = 0;
const entries = await files(path.join(root, 'addon'));
for (const [name, data] of entries) {
  const filename = Buffer.from(name), crc = crc32(data);
  const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6);
  h.writeUInt16LE(33, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(filename.length, 26);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8);
  c.writeUInt16LE(33, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42);
  local.push(h, filename, data); central.push(c, filename); offset += h.length + filename.length + data.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
await mkdir(path.join(root, 'dist'), { recursive: true });
const output = path.join(root, `dist/zotero-codex-listener-${manifest.version}.xpi`);
await writeFile(output, Buffer.concat([...local, directory, end]));
console.log(output);
