// Den smala bryggan mellan fönstren och huvudprocessen. Inget annat än dessa anrop når Node.
const { contextBridge, ipcRenderer } = require('electron');
const inv = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel, cb) => { const h = (_e, ...a) => cb(...a); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h); };

contextBridge.exposeInMainWorld('api', {
  capabilities: () => inv('app:capabilities'),
  sources: () => inv('sources:list'),
  startRecording: opts => inv('rec:start', opts),
  library: () => inv('lib:list'),
  openEditor: id => inv('lib:open', id),
  load: id => inv('proj:load', id),
  save: (id, project) => inv('proj:save', id, project),
  rename: (id, name) => inv('proj:rename', id, name),
  remove: id => inv('proj:delete', id),
  reveal: id => inv('shell:reveal', id),
  revealPath: p => inv('shell:revealPath', p),
  onHotkeyToggle: cb => on('hotkey:toggle', cb),
  onLibraryChanged: cb => on('lib:changed', cb),
  hud: {
    init: () => inv('hud:init'),
    begin: info => inv('rec:begin', info),
    chunk: (track, data) => ipcRenderer.send('rec:chunk', { track, data }),
    finish: info => inv('rec:finish', info),
    pause: paused => inv('rec:pause', paused),
    fail: message => inv('rec:fail', message),
    requestStop: () => inv('rec:stop-request'),
    requestPause: () => inv('rec:pause-request'),
    onTick: cb => on('hud:tick', cb),
    onStop: cb => on('hud:stop', cb),
    onPauseToggle: cb => on('hud:pause-toggle', cb),
  },
  exporter: {
    begin: () => inv('export:begin'),
    chunk: (token, data) => ipcRenderer.send('export:chunk', { token, data }),
    end: opts => inv('export:end', opts),
    cancel: token => inv('export:cancel', token),
    onProgress: cb => on('export:progress', cb),
  },
});
