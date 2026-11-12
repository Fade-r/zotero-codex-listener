import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const core = await readFile(new URL('../addon/content/core.js', import.meta.url), 'utf8');
const listener = await readFile(new URL('../addon/content/listener.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Exercise the actual listener with Zotero events, a delayed subprocess and a fake clock.
async function fixture(t, { delayedStart = false, delayedSend = false, group = false } = {}) {
  const timers = new Map(), requests = [], processes = [], elements = [];
  let timerID = 0, observer, handler, annotations = [], failSend = false;
  const launch = deferred();
  const file = () => ({ path: 'test-temp/bridge.mjs', append() {}, createUnique() {}, clone: file, exists: () => false });
  const doc = {
    querySelector: () => elements.find(e => e.isConnected) || null,
    createElement: () => {
      const element = { isConnected: true, style: {}, setAttribute() {}, remove() { this.isConnected = false; }, ownerDocument: doc };
      elements.push(element); return element;
    }
  };
  const paper = { key: 'PAPER', libraryID: 1, isRegularItem: () => true, getNotes: () => [], getField: () => 'Synthetic paper' };
  const attachment = { key: 'PDF', libraryID: 1, parentItem: paper, getAnnotations: () => annotations };
  const reader = { itemID: 1 }, readers = [reader];
  const Subprocess = {
    pathSearch: async () => 'node',
    async call() {
      if (delayedStart) await launch.promise;
      let read;
      const process = {
        killed: false,
        stdout: { readString: () => new Promise(resolve => { read = resolve; }) },
        stderr: { readString: async () => '' },
        async kill() { this.killed = true; read?.(''); },
        reply(input, error) { read(JSON.stringify({ id: input.id, ...(error ? { error } : { result: { connected: true, sent: true } }) }) + '\n'); },
        stdin: { async write(line) {
          const input = JSON.parse(line); requests.push(input);
          if (input.action === 'status' || !delayedSend) queueMicrotask(() => process.reply(input, input.action === 'send' && failSend ? 'synthetic failure' : null));
        } }
      };
      processes.push(process); return process;
    }
  };
  const context = vm.createContext({
    Zotero: {
      Prefs: { get: name => name.endsWith('targets') ? '{"1/PDF":"12345678-1234-1234-1234-123456789abc"}' : '', set() {} },
      Items: { get: () => attachment }, Libraries: { get: () => group ? { libraryType: 'group', groupID: 42 } : { libraryType: 'user' } },
      Reader: { _readers: readers, registerEventListener: (_, fn) => { handler = fn; }, unregisterEventListener() {} },
      Notifier: { registerObserver: obj => { observer = obj; return 1; }, unregisterObserver() {} },
      getTempDirectory: file, File: { putContentsAsync: async () => {}, getContentsAsync: async () => '' }, logError() {}
    },
    Services: {}, Components: { interfaces: { nsIFile: { DIRECTORY_TYPE: 1 } } }, rootURI: '',
    ChromeUtils: { importESModule: name => name.includes('Subprocess') ? { Subprocess } : {
      setTimeout: (fn, ms) => { timers.set(++timerID, { fn, ms }); return timerID; }, clearTimeout: id => timers.delete(id)
    } }
  });
  vm.runInContext(core, context); vm.runInContext(listener, context);
  await context.Listener.startup(); handler({ reader, doc, append() {} });
  t.after(() => context.Listener.shutdown());
  return {
    button: elements[0], requests, processes, launch, readers,
    set annotations(value) { annotations = value; }, set failSend(value) { failSend = value; },
    event: () => observer.notify('modify', 'item'), close: () => { readers.length = 0; observer.notify('close', 'tab'); },
    async run(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } await tick(); },
    sends: () => requests.filter(r => r.action === 'send')
  };
}
const annotation = comment => ({ key: 'ANN', libraryID: 1, annotationType: 'highlight', annotationText: 'Synthetic quote', annotationComment: comment, annotationPageLabel: '2' });
const payload = request => JSON.parse(request.prompt.slice(request.prompt.indexOf('{')));

test('baseline is silent; changes and deleted text are delivered once', async t => {
  const f = await fixture(t); f.annotations = [annotation('old')];
  await f.button.onclick(); await f.run(1500); assert.equal(f.sends().length, 0);
  f.annotations = [annotation('new')]; f.event(); await f.run(1500);
  assert.equal(payload(f.sends()[0]).changes[0].after.comment, 'new');
  f.annotations = []; f.event(); await f.run(1500);
  assert.equal(payload(f.sends()[1]).changes[0].before.text, 'Synthetic quote');
  await f.run(1500); assert.equal(f.sends().length, 2);
  await f.button.onclick(); f.event(); await f.run(1500);
  assert.equal(f.processes[0].killed, true); assert.equal(f.sends().length, 2);
});
test('edits made during delivery are sent in the next batch', async t => {
  const f = await fixture(t, { delayedSend: true }); await f.button.onclick();
  f.annotations = [annotation('first')]; f.event(); await f.run(1500);
  f.annotations = [annotation('second')]; f.event(); await f.run(1500);
  assert.equal(f.sends().length, 1);
  f.processes[0].reply(f.sends()[0]); await tick(); await f.run(1500);
  assert.equal(payload(f.sends()[1]).changes[0].after.comment, 'second');
});
test('stopping during subprocess startup kills the late process', async t => {
  const f = await fixture(t, { delayedStart: true }); const starting = f.button.onclick();
  await tick(); await f.button.onclick(); f.launch.resolve(); await starting;
  assert.equal(f.processes[0].killed, true); assert.equal(f.requests.length, 0);
  assert.equal(f.button.textContent, '○ 监听');
});
test('delivery failure stops listening without retrying', async t => {
  const f = await fixture(t); await f.button.onclick(); f.failSend = true;
  f.annotations = [annotation('new')]; f.event(); await f.run(1500); await f.run(1500);
  assert.equal(f.sends().length, 1); assert.equal(f.processes[0].killed, true);
  assert.equal(f.button.textContent, '● 已停止');
});
test('closing the reader stops the helper', async t => {
  const f = await fixture(t); await f.button.onclick(); f.close(); await f.run(0);
  assert.equal(f.processes[0].killed, true); assert.equal(f.button.textContent, '○ 监听');
});
test('group annotations use a group PDF link', async t => {
  const f = await fixture(t, { group: true }); await f.button.onclick();
  f.annotations = [annotation('new')]; f.event(); await f.run(1500);
  assert.equal(payload(f.sends()[0]).changes[0].after.link, 'zotero://open-pdf/groups/42/items/PDF?annotation=ANN');
});
