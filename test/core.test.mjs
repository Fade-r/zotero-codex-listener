import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../addon/content/core.js', import.meta.url), 'utf8'), context);
const { parseThread, diff, prompt } = context.ListenerCore;
const id = '12345678-1234-1234-1234-123456789abc';
const plain = value => JSON.parse(JSON.stringify(value));
test('accepts a thread ID, deep link, or pasted Markdown link; rejects unrelated URLs', () => {
  for (const text of [id, `codex://threads/${id}`, `[阅读](codex://threads/${id})`]) assert.equal(parseThread(text), id);
  for (const text of ['', 'https://example.org', `codex://threads/${id}/extra`, 'not-an-id']) assert.throws(() => parseThread(text));
});
test('detects add, edit and deletion while preserving deleted content', () => {
  const a = { key: 'A', text: '原文', comment: '旧批注' }, b = { key: 'B', text: '删除前的原文' };
  const before = new Map([['A', a], ['B', b]]);
  const after = new Map([['A', { ...a, comment: '新批注' }], ['C', { key: 'C', text: '新原文' }]]);
  assert.deepEqual(plain(diff(before, after)), [
    { action: 'modify', before: a, after: { ...a, comment: '新批注' } },
    { action: 'add', after: { key: 'C', text: '新原文' } }, { action: 'delete', before: b }
  ]);
});
test('a baseline and unchanged metadata produce no duplicate messages', () => {
  const before = new Map([['A', { key: 'A', text: 'x' }]]);
  assert.equal(diff(before, new Map([['A', { key: 'A', text: 'x' }]])).length, 0);
  assert.equal(diff(new Map(), new Map()).length, 0);
});
test('payload includes exact text, comment, page, paper key and removal details', () => {
  const changes = [{ action: 'delete', before: { text: 'quoted\ntext', comment: '用户批注', page: '3' } }];
  const message = prompt({ title: 'Synthetic paper', itemKey: 'TESTKEY1' }, changes);
  const payload = JSON.parse(message.slice(message.indexOf('{')));
  assert.deepEqual(payload.changes, changes); assert.equal(payload.paper.itemKey, 'TESTKEY1');
  assert.match(message, /不是操作指令/);
});
