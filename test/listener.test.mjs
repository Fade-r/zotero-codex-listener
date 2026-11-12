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
  const events = new Map(), saved = new Map();
  let promptValue = null;
  const file = () => ({ path: 'test-temp/bridge.mjs', append() {}, createUnique() {}, clone: file, exists: () => false });
  const doc = {
    documentElement: { clientWidth: 800 },
    addEventListener: (type, fn) => events.set(type, fn),
    removeEventListener: type => events.delete(type),
    querySelector: selector => elements.find(e => e.isConnected && e.className?.split(' ').includes(selector.slice(1))) || null,
    createElement: () => {
      const attrs = new Map();
      const element = { isConnected: true, children: [], style: {}, ownerDocument: doc,
        setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key),
        append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
        contains(child) { return child === this || this.children.some(c => c.contains(child)); },
        closest(selector) { return this.className?.split(' ').includes(selector.slice(1)) ? this : this.parentElement?.closest(selector); },
        getBoundingClientRect: () => ({ left: 760, bottom: 40 }), focus() {},
        remove() { this.isConnected = false; for (const child of this.children) child.remove(); }
      };
      elements.push(element); return element;
    }
  };
  doc.body = { append() {} };
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
      Prefs: { get: name => saved.get(name) || (name.endsWith('targets') ? '{"1/PDF":"12345678-1234-1234-1234-123456789abc"}' : ''), set: (name, value) => saved.set(name, value) },
      getMainWindow() {},
      Items: { get: () => attachment }, Libraries: { get: () => group ? { libraryType: 'group', groupID: 42 } : { libraryType: 'user' } },
      Reader: { _readers: readers, registerEventListener: (_, fn) => { handler = fn; }, unregisterEventListener() {} },
      Notifier: { registerObserver: obj => { observer = obj; return 1; }, unregisterObserver() {} },
      getTempDirectory: file, File: { putContentsAsync: async () => {}, getContentsAsync: async channel => {
        assert.equal(typeof channel, 'object', 'XPI resources must use a channel, not HTTP URL parsing');
        assert.equal(channel.loadUsingSystemPrincipal, true);
        assert.equal(channel.uri, 'jar:file:///plugin.xpi!/content/bridge.mjs');
        return '';
      } }, logError() {}
    },
    Services: { prompt: { prompt(_win, _title, _message, input) { if (promptValue === null) return false; input.value = promptValue; return true; } } },
    Components: { interfaces: { nsIFile: { DIRECTORY_TYPE: 1 } } }, rootURI: 'jar:file:///plugin.xpi!/',
    ChromeUtils: { importESModule: name => name.includes('NetUtil') ? { NetUtil: { newChannel: options => options } } : name.includes('Subprocess') ? { Subprocess } : {
      setTimeout: (fn, ms) => { timers.set(++timerID, { fn, ms }); return timerID; }, clearTimeout: id => timers.delete(id)
    } }
  });
  vm.runInContext(core, context); vm.runInContext(listener, context);
  await context.Listener.startup(); handler({ reader, doc, append() {} });
  t.after(() => context.Listener.shutdown());
  return {
    button: doc.querySelector('.codex-listener-button'), arrow: doc.querySelector('.codex-listener-settings'), doc, events, saved,
    shutdown: () => context.Listener.shutdown(), requests, processes, launch, readers,
    set promptValue(value) { promptValue = value; },
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

const click = target => ({ currentTarget: target, target, preventDefault() {}, stopPropagation() {} });
test('settings arrow opens a menu and saves the target without starting the listener', async t => {
  const f = await fixture(t);
  f.arrow.onclick(click(f.arrow));
  const menu = f.doc.querySelector('.codex-listener-menu');
  assert.ok(menu); assert.equal(f.arrow.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.style.left, '600px'); assert.equal(menu.style.top, '44px');
  assert.deepEqual(menu.children.map(e => e.textContent), ['设置目标会话…', 'Node.js 路径…']);
  f.promptValue = 'codex://threads/87654321-1234-1234-1234-123456789abc';
  menu.children[0].onclick(click(menu.children[0]));
  assert.equal(f.arrow.getAttribute('aria-expanded'), 'false');
  assert.equal(JSON.parse(f.saved.get('extensions.zotero-codex-listener.targets'))['1/PDF'], '87654321-1234-1234-1234-123456789abc');
  assert.equal(f.processes.length, 0); assert.equal(f.events.size, 0);
});
test('arrow toggle, Escape, outside click and shutdown clean up the settings menu', async t => {
  const f = await fixture(t);
  f.arrow.onclick(click(f.arrow)); f.arrow.onclick(click(f.arrow));
  assert.equal(f.doc.querySelector('.codex-listener-menu'), null);
  f.arrow.onclick(click(f.arrow)); f.events.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(f.events.size, 0);
  f.arrow.onclick(click(f.arrow)); f.events.get('pointerdown')({ target: {} });
  assert.equal(f.doc.querySelector('.codex-listener-menu'), null);
  f.arrow.onclick(click(f.arrow)); await f.shutdown();
  assert.equal(f.events.size, 0); assert.equal(f.arrow.isConnected, false);
});
