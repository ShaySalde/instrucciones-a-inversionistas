// ==============================================================================
//  Puente seguro entre el renderer (HTML) y el proceso principal.
//  El renderer NO tiene acceso a Node; solo a estos métodos expuestos.
// ==============================================================================
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  isElectron: true,

  // Configuración de correo
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (payload) => ipcRenderer.invoke("settings:save", payload),
  verifyMail: () => ipcRenderer.invoke("mail:verify"),
  sendMail: (payload) => ipcRenderer.invoke("mail:send", payload),

  // Directorio inversionista(NIT) -> correo
  getDirectory: () => ipcRenderer.invoke("dir:get"),
  setDirectoryEntry: (payload) => ipcRenderer.invoke("dir:setEntry", payload),
  importDirectory: (entries) => ipcRenderer.invoke("dir:import", entries),

  // Utilidades
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
});
