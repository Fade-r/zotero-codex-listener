import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from '../addon/content/bridge.mjs';
async function fixture(t, respond) {
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\listener-test-${randomUUID()}` : path.join(tmpdir(), `listener-${randomUUID()}.sock`);
  const server = net.createServer(client => {
    let buffer = Buffer.alloc(0);
    client.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        respond(client, JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0))));
      }
    });
    client.on('error', () => {});
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return socket;
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}
test('reads fragmented frames and multibyte content', async t => {
  const socket = await fixture(t, (client, input) => {
    assert.equal(input.method, 'tools/list');
    const data = frame({ jsonrpc: '2.0', id: 1, result: { text: '连接正常' } });
    client.write(data.subarray(0, 2)); setImmediate(() => client.write(data.subarray(2)));
  });
  assert.deepEqual(await request(socket, 'tools/list', {}), { text: '连接正常' });
});
test('surfaces host rejection instead of reporting delivery', async t => {
  const socket = await fixture(t, client => client.write(frame({ id: 1, error: { message: 'target missing' } })));
  await assert.rejects(request(socket, 'tools/call', {}), /target missing/);
});
test('times out without retrying a possibly delivered message', async t => {
  let count = 0; const socket = await fixture(t, () => { count++; });
  await assert.rejects(request(socket, 'tools/call', {}, 50), /结果未知/);
  assert.equal(count, 1);
});
test('rejects oversized frames', async t => {
  const socket = await fixture(t, client => { const h = Buffer.alloc(4); h.writeUInt32LE(9 * 1024 * 1024); client.write(h); });
  await assert.rejects(request(socket, 'tools/list', {}), /过大/);
});
