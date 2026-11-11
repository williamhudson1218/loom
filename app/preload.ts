import { contextBridge, ipcRenderer, webUtils } from 'electron';

// The page is Loom's own dashboard on localhost. The only thing it needs from
// the OS is the real path of a dropped file; File.path no longer exists.
contextBridge.exposeInMainWorld('loomNative', {
  // The native macOS folder picker; resolves to the chosen absolute path, or '' when cancelled.
  pickFolder: (): Promise<string> => ipcRenderer.invoke('loom:pick-folder'),
  // Accessibility for the "Loom" helper (the Slack reader and terminal scripting), polled.
  axStatus: (): Promise<{ trusted: boolean; helperDown: boolean }> => ipcRenderer.invoke('loom:ax-status'),
  // Shows macOS's Accessibility prompt for that helper (adds its "Loom" row, switched off).
  axRequest: (): Promise<{ trusted: boolean; helperDown: boolean }> => ipcRenderer.invoke('loom:ax-request'),
  // Opens System Settings at Privacy & Security, Accessibility.
  openAccessibility: (): Promise<void> => ipcRenderer.invoke('loom:open-accessibility'),
  pathForFile: (f: File): string => {
    try {
      return webUtils.getPathForFile(f) || '';
    } catch {
      return '';
    }
  },
});
