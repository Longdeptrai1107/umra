import { contextBridge, ipcRenderer } from 'electron';
const argument = process.argv.find(value => value.startsWith('--umra-bootstrap='));
const bootstrap = argument ? JSON.parse(decodeURIComponent(argument.substring('--umra-bootstrap='.length))) : null;
contextBridge.exposeInMainWorld('umra', { bootstrap,
  chooseFile: (kind: 'runtime' | 'emulator' | 'game') => ipcRenderer.invoke('umra:choose-file', kind),
});
