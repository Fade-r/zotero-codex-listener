// Small stdio adapter for the Codex desktop app's local named pipe (Windows).
// This is an internal desktop interface, not the public app-server protocol.
import net from 'node:net';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export function request(pipe, method, params, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let buffer = Buffer.alloc(0), done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex 响应超时；发送结果未知，请检查会话后再重试。')), timeout);
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new Error('Codex 连接已断开')));
    socket.on('connect', () => {
      const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
      socket.write(Buffer.concat([header, data]));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) return finish(new Error('Codex 返回内容过大'));
      if (buffer.length < length + 4) return;
      try {
        const message = JSON.parse(buffer.subarray(4, length + 4).toString());
        if (message.id !== 1) throw new Error('Codex 响应标识不匹配');
        finish(message.error ? new Error(message.error.message) : null, message.result);
      } catch (error) { finish(error); }
    });
  });
}

export async function findPipe() {
  if (process.platform !== 'win32') throw new Error('当前版本仅支持 Windows Codex 桌面端');
  const names = (await readdir('\\\\.\\pipe\\')).filter(name => /^codex-app-tools-[\da-f-]+$/i.test(name));
  const candidates = [];
  for (const name of names) {
    const pipe = `\\\\.\\pipe\\${name}`;
    try {
      const catalog = await request(pipe, 'tools/list', { threadStartKind: 'default' }, 2000);
      const tool = catalog.tools?.find(item => item.name === 'send_message_to_thread');
      if (tool) candidates.push({ pipe, namespace: tool.namespace });
    } catch { /* Ignore stale pipes. Never start a second Codex app server. */ }
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? '检测到多个 Codex 实例，请只保留一个' : '未连接 Codex 桌面端，请先打开 Codex');
  return candidates[0];
}

export async function handle(input) {
  if (!['status', 'send'].includes(input.action)) throw new Error('未知操作');
  const connection = await findPipe();
  if (input.action === 'status') return { connected: true };
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.threadId || '')) throw new Error('无效会话 ID');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 200000) throw new Error('消息为空或过长');
  const result = await request(connection.pipe, 'tools/call', {
    namespace: connection.namespace,
    tool: 'send_message_to_thread',
    arguments: { threadId: input.threadId, hostId: 'local', prompt: input.prompt },
    callerSource: 'codex', hostId: 'local', threadId: input.threadId,
    callId: `zotero-${randomUUID()}`, turnId: `zotero-${randomUUID()}`
  });
  if (!result?.success) {
    throw new Error(result?.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n') || 'Codex 拒绝接收消息');
  }
  return { sent: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  lines.on('line', line => {
    chain = chain.then(async () => {
      let input;
      try {
        if (line.length > 250000) throw new Error('请求过大');
        input = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id: input.id, result: await handle(input) }) + '\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ id: input?.id, error: error.message }) + '\n');
      }
    });
  });
}
