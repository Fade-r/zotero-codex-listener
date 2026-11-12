/* global Zotero, Services, ChromeUtils, Components, rootURI, ListenerCore */
var Listener = (() => {
  const ID = 'zotero-codex-listener@fade-r.github.io';
  const PREF = 'extensions.zotero-codex-listener.';
  const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
  const buttons = new Map();
  const menus = new Set();
  let active = null, starting = null, epoch = 0, observer, timer, heartbeat, bridgeFile, rpc;
  let lastError = '', errorItem = null;
  const pref = name => Zotero.Prefs.get(PREF + name, true) || '';
  const save = (name, value) => Zotero.Prefs.set(PREF + name, value, true);
  const key = item => `${item.libraryID}/${item.key}`;
  const targets = () => { try { return JSON.parse(pref('targets') || '{}'); } catch { return {}; } };

  async function nodeCommand() {
    if (pref('node')) return pref('node');
    const environment = Subprocess.getEnvironment();
    // Windows exposes Path, while Subprocess.pathSearch reads PATH case-sensitively.
    const path = Object.entries(environment).find(([name]) => name.toUpperCase() === 'PATH')?.[1] || '';
    try { return await Subprocess.pathSearch('node.exe', { ...environment, PATH: path }); }
    catch { throw new Error('找不到 Node.js。请安装 Node.js 22+，或在 ▾ → Node.js 路径中填写 node.exe 的完整路径。'); }
  }

  class Bridge {
    pending = new Map();
    sequence = 0;
    closed = false;
    async start() {
      const command = await nodeCommand();
      this.process = await Subprocess.call({ command, arguments: [bridgeFile.path], stderr: 'pipe' });
      if (this.closed) { await this.process.kill(); throw new Error('监听已停止'); }
      this.read().catch(error => this.close(error));
      (async () => { while (await this.process.stderr.readString()) {} })().catch(() => {});
      return this;
    }
    async read() {
      let buffer = '';
      while (!this.closed) {
        const chunk = await this.process.stdout.readString();
        if (!chunk) throw new Error('本地连接已退出');
        buffer += chunk;
        if (buffer.length > 300000) throw new Error('本地响应过大');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
        }
      }
    }
    call(input) {
      if (this.closed) return Promise.reject(new Error('本地连接已关闭'));
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('连接超时；发送结果可能未知，请检查目标会话'));
        }, 20000);
        this.pending.set(id, { resolve, reject, timer });
        this.process.stdin.write(JSON.stringify({ ...input, id }) + '\n').catch(error => this.close(error));
      });
    }
    close(error = new Error('监听已停止')) {
      if (this.closed) return;
      this.closed = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      this.process?.kill().catch(() => {});
    }
  }

  function snapshot(itemID) {
    const attachment = Zotero.Items.get(itemID);
    if (!attachment || attachment.deleted) throw new Error('当前 PDF 已移除');
    const paper = attachment.parentItem || attachment;
    const library = Zotero.Libraries.get(attachment.libraryID);
    const libraryPath = library.libraryType === 'group' ? `groups/${library.groupID}` : 'library';
    const result = new Map();
    for (const item of attachment.getAnnotations()) {
      if (item.deleted) continue;
      result.set(key(item), {
        key: item.key, kind: 'annotation', type: item.annotationType,
        text: item.annotationText || '', comment: item.annotationComment || '',
        page: item.annotationPageLabel || '', color: item.annotationColor || '',
        position: item.annotationPosition || '',
        link: `zotero://open-pdf/${libraryPath}/items/${attachment.key}?annotation=${item.key}`
      });
    }
    for (const id of paper.isRegularItem() ? paper.getNotes() : []) {
      const item = Zotero.Items.get(id);
      if (item && !item.deleted) result.set(key(item), { key: item.key, kind: 'note', html: item.getNote() });
    }
    return result;
  }

  function render() {
    for (const [button, itemID] of buttons) {
      if (!button.isConnected) { buttons.delete(button); continue; }
      const running = active?.itemID === itemID;
      const connecting = starting?.itemID === itemID;
      const error = errorItem === itemID && lastError;
      button.textContent = connecting ? '◌ 连接中' : running ? (active.sending ? '● 发送中' : '● 监听中') : error ? '● 已停止' : '○ 监听';
      button.style.color = error ? '#bc3838' : running ? '#278243' : 'inherit';
      button.setAttribute('aria-pressed', String(running));
      button.title = [error || (connecting ? '点击取消连接' : running ? '点击停止监听；已投递消息可能仍在处理中' : '点击开始监听'),
        '点击旁边的箭头设置目标会话', running ? `目标：${active.threadId}` : ''].filter(Boolean).join('\n');
    }
  }

  function stop() {
    epoch++;
    clearTimeout(timer); clearTimeout(heartbeat);
    active = null; starting = null; rpc?.close(); rpc = null;
    render();
  }
  function fail(itemID, error) {
    stop(); errorItem = itemID; lastError = error.message || String(error); render();
    Zotero.logError(error);
    Services.prompt.alert(Zotero.getMainWindow(), 'Codex 监听已停止', lastError);
  }
  function ask(title, message, value = '') {
    const input = { value };
    return Services.prompt.prompt(Zotero.getMainWindow(), title, message, input, null, {}) ? input.value : null;
  }
  function configure(reader) {
    const attachment = Zotero.Items.get(reader.itemID), stored = targets();
    const value = ask('目标 Codex 会话', '粘贴 codex://threads/… 链接或会话 ID', stored[key(attachment)] || '');
    if (value === null) return false;
    const threadId = ListenerCore.parseThread(value);
    if (active?.itemID === reader.itemID || starting?.itemID === reader.itemID) stop();
    stored[key(attachment)] = threadId; save('targets', JSON.stringify(stored));
    errorItem = null; lastError = ''; render(); return true;
  }
  function menu(event, reader) {
    event.preventDefault(); event.stopPropagation();
    const anchor = event.currentTarget, doc = anchor.ownerDocument;
    const wasOpen = anchor.getAttribute('aria-expanded') === 'true';
    for (const close of menus) close();
    if (wasOpen) return;
    const popup = doc.createElement('div'); popup.className = 'codex-listener-menu';
    popup.setAttribute('role', 'menu');
    const close = () => {
      popup.remove(); anchor.setAttribute('aria-expanded', 'false');
      doc.removeEventListener('pointerdown', dismiss, true); doc.removeEventListener('keydown', keydown, true); menus.delete(close);
    };
    const dismiss = event => { if (!popup.contains(event.target) && !anchor.contains(event.target)) close(); };
    const keydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); anchor.focus(); } };
    const rect = anchor.getBoundingClientRect();
    popup.style.cssText = 'position:fixed;z-index:10000;padding:4px;border:1px solid #999;border-radius:5px;background:Canvas;color:CanvasText;box-shadow:0 2px 8px #0003;';
    popup.style.left = `${Math.max(4, Math.min(rect.left, doc.documentElement.clientWidth - 200))}px`;
    popup.style.top = `${rect.bottom + 4}px`;
    for (const [label, action] of [
      ['设置目标会话…', () => configure(reader)],
      ['Node.js 路径…', () => { const value = ask('Node.js', '通常留空即可自动查找；也可填 node.exe 的完整路径', pref('node')); if (value !== null) { stop(); save('node', value.trim()); } }]
    ]) {
      const option = doc.createElement('button'); option.textContent = label;
      option.setAttribute('role', 'menuitem');
      option.style.cssText = 'display:block;border:0;background:transparent;color:inherit;padding:7px 12px;width:100%;text-align:left;cursor:pointer;';
      option.onclick = event => { event.preventDefault(); event.stopPropagation(); close(); try { action(); } catch (error) { fail(reader.itemID, error); } };
      popup.append(option);
    }
    doc.body.append(popup);
    anchor.setAttribute('aria-expanded', 'true');
    menus.add(close);
    doc.addEventListener('pointerdown', dismiss, true);
    doc.addEventListener('keydown', keydown, true);
  }
  function attach(reader, doc, append) {
    if (doc.querySelector('.codex-listener-button')) return;
    const control = doc.createElement('div'); control.className = 'codex-listener-control';
    control.style.cssText = 'display:inline-flex;align-items:center;';
    const button = doc.createElement('button'); button.className = 'toolbar-button codex-listener-button';
    button.style.cssText = 'width:auto;min-width:70px;padding:0 7px;font-size:12px;white-space:nowrap;';
    button.onclick = async () => {
      if (active?.itemID === reader.itemID || starting?.itemID === reader.itemID) { stop(); return; }
      try { await start(reader); } catch (error) { fail(reader.itemID, error); }
    };
    const arrow = doc.createElement('button'); arrow.className = 'toolbar-button codex-listener-settings';
    arrow.textContent = '▾'; arrow.title = '监听设置';
    arrow.setAttribute('aria-label', '监听设置'); arrow.setAttribute('aria-haspopup', 'menu'); arrow.setAttribute('aria-expanded', 'false');
    arrow.style.cssText = 'width:22px;min-width:22px;padding:0;font-size:12px;';
    arrow.onclick = event => menu(event, reader);
    control.append(button, arrow); append(control); buttons.set(button, reader.itemID); render();
  }
  const toolbar = ({ reader, doc, append }) => attach(reader, doc, append);
  function attachExisting() {
    for (const reader of Zotero.Reader._readers) {
      const doc = reader._iframeWindow?.document;
      const appearance = doc?.getElementById('appearance');
      if (appearance) attach(reader, doc, button => appearance.parentNode.insertBefore(button, appearance));
    }
  }

  async function start(reader) {
    const attachment = Zotero.Items.get(reader.itemID);
    if (!targets()[key(attachment)] && !configure(reader)) return;
    stop(); lastError = ''; errorItem = null;
    const generation = epoch;
    starting = { itemID: reader.itemID }; render();
    const before = snapshot(reader.itemID), paper = attachment.parentItem || attachment;
    const connection = new Bridge();
    rpc = connection;
    try {
      await connection.start();
      if (generation !== epoch) { connection.close(); return; }
      await connection.call({ action: 'status' });
    } catch (error) { if (generation === epoch) fail(reader.itemID, error); return; }
    if (generation !== epoch) { connection.close(); return; }
    starting = null; active = {
      itemID: reader.itemID, threadId: targets()[key(attachment)], before, sending: false,
      paper: { title: paper.getField('title'), libraryID: paper.libraryID, itemKey: paper.key, attachmentKey: attachment.key }
    };
    render(); schedule(); pulse(generation);
  }
  function schedule() {
    clearTimeout(timer);
    if (active) timer = setTimeout(() => void flush(), 1500);
  }
  async function flush() {
    const current = active, connection = rpc;
    if (!current || current.sending) return;
    try {
      const after = snapshot(current.itemID), changes = ListenerCore.diff(current.before, after);
      if (!changes.length) return;
      current.sending = true; render();
      const text = ListenerCore.prompt(current.paper, changes);
      await connection.call({ action: 'send', threadId: current.threadId, prompt: text });
      if (active !== current) return;
      current.before = after; current.sending = false; render(); schedule();
    } catch (error) { if (active === current) fail(current.itemID, error); }
  }
  async function pulse(generation) {
    heartbeat = setTimeout(async () => {
      if (!active || generation !== epoch) return;
      const current = active;
      try {
        if (!Zotero.Reader._readers.some(reader => reader.itemID === current.itemID)) { stop(); return; }
        if (!current.sending) await rpc.call({ action: 'status' });
        if (active === current) pulse(generation);
      } catch (error) { if (active === current) fail(current.itemID, error); }
    }, 10000);
  }
  function checkReader() {
    const current = active || starting;
    if (current && !Zotero.Reader._readers.some(reader => reader.itemID === current.itemID)) stop();
  }
  async function startup() {
    const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
    const channel = NetUtil.newChannel({ uri: rootURI + 'content/bridge.mjs', loadUsingSystemPrincipal: true });
    const source = await Zotero.File.getContentsAsync(channel, 'UTF-8');
    const directory = Zotero.getTempDirectory(); directory.append('zotero-codex-listener');
    directory.createUnique(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
    bridgeFile = directory.clone(); bridgeFile.append('bridge.mjs');
    await Zotero.File.putContentsAsync(bridgeFile.path, source);
    Zotero.Reader.registerEventListener('renderToolbar', toolbar, ID);
    observer = Zotero.Notifier.registerObserver({ notify(event, type) {
      if (type === 'tab') { setTimeout(checkReader, 0); return; }
      if (active && ['add', 'modify', 'delete', 'trash'].includes(event)) schedule();
    } }, ['item', 'tab'], 'codex-listener');
    attachExisting();
  }
  async function shutdown() {
    stop();
    Zotero.Reader.unregisterEventListener('renderToolbar', toolbar);
    if (observer) Zotero.Notifier.unregisterObserver(observer);
    for (const close of menus) close();
    for (const button of buttons.keys()) button.closest('.codex-listener-control')?.remove(); buttons.clear();
    if (bridgeFile?.exists()) { const parent = bridgeFile.parent; bridgeFile.remove(false); parent.remove(false); }
  }
  return { startup, shutdown, attachExisting, checkReader };
})();
