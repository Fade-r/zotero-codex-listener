/* global Zotero, Services, Components, ChromeUtils */
var listener;
function install() {}
function uninstall() {}
async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  const scope = { Zotero, Services, Components, ChromeUtils, rootURI };
  for (const file of ['core.js', 'listener.js']) {
    Services.scriptloader.loadSubScriptWithOptions(rootURI + 'content/' + file, {
      target: scope, charset: 'UTF-8', ignoreCache: true, allowUnsafeURL: true
    });
  }
  listener = scope.Listener;
  await listener.startup();
}
async function shutdown() { await listener?.shutdown(); listener = null; }
function onMainWindowLoad() { listener?.attachExisting(); }
function onMainWindowUnload() { listener?.checkReader(); }
