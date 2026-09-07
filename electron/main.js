// ==============================================================================
//  Utilidades Va6s — proceso principal de Electron
//  - Sirve el HTML (renderer/index.html) como app de escritorio.
//  - Guarda la configuración de correo con la contraseña CIFRADA por el sistema
//    operativo (DPAPI en Windows / Keychain en macOS) vía safeStorage.
//  - Envía los reportes por SMTP de Gmail con el Excel adjunto (nodemailer).
//  - Mantiene un directorio persistente inversionista(NIT) -> correo.
// ==============================================================================
const { app, BrowserWindow, ipcMain, safeStorage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

// ---- Rutas de datos del usuario (persisten entre sesiones y actualizaciones) ----
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const directoryPath = () => path.join(app.getPath("userData"), "directory.json");

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (_) { return fallback; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

// ---- Configuración de correo ---------------------------------------------------
// settings.json: { fromEmail, fromName, passwordEnc (base64), passwordPlain? }
function loadSettingsRaw() { return readJson(settingsPath(), {}); }

function getSettingsPublic() {
  const s = loadSettingsRaw();
  return {
    fromEmail: s.fromEmail || "",
    fromName: s.fromName || "",
    hasPassword: !!(s.passwordEnc || s.passwordPlain),
  };
}

function getPassword() {
  const s = loadSettingsRaw();
  if (s.passwordEnc) {
    try {
      const buf = Buffer.from(s.passwordEnc, "base64");
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    } catch (_) { /* cae al plano si existe */ }
  }
  return s.passwordPlain || "";
}

function saveSettings({ fromEmail, fromName, appPassword }) {
  const s = loadSettingsRaw();
  s.fromEmail = (fromEmail || "").trim();
  s.fromName = (fromName || "").trim();
  // Solo actualiza la contraseña si se envió una nueva (no vacía).
  if (typeof appPassword === "string" && appPassword.trim().length) {
    const pass = appPassword.trim();
    delete s.passwordPlain;
    if (safeStorage.isEncryptionAvailable()) {
      s.passwordEnc = safeStorage.encryptString(pass).toString("base64");
    } else {
      // Sin cifrado del SO disponible: se guarda en claro como último recurso.
      delete s.passwordEnc;
      s.passwordPlain = pass;
    }
  }
  writeJson(settingsPath(), s);
  return getSettingsPublic();
}

function makeTransport() {
  const s = loadSettingsRaw();
  const pass = getPassword();
  if (!s.fromEmail || !pass) {
    throw new Error("Falta configurar el correo remitente o la contraseña de aplicación.");
  }
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: s.fromEmail, pass },
  });
}

// ---- Directorio inversionista(NIT) -> correo -----------------------------------
function loadDirectory() { return readJson(directoryPath(), {}); }

function setDirectoryEntry({ nit, email, name }) {
  const d = loadDirectory();
  const key = String(nit || "").trim();
  if (!key) return d;
  if (email) d[key] = { email: String(email).trim(), name: name || (d[key] && d[key].name) || "" };
  else delete d[key];
  writeJson(directoryPath(), d);
  return d;
}

function importDirectory(entries) {
  const d = loadDirectory();
  for (const e of entries || []) {
    const key = String(e.nit || "").trim();
    if (key && e.email) d[key] = { email: String(e.email).trim(), name: e.name || "" };
  }
  writeJson(directoryPath(), d);
  return d;
}

// ---- IPC -----------------------------------------------------------------------
ipcMain.handle("settings:get", () => getSettingsPublic());
ipcMain.handle("settings:save", (_e, payload) => saveSettings(payload || {}));

ipcMain.handle("mail:verify", async () => {
  try {
    const t = makeTransport();
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle("mail:send", async (_e, { to, subject, body, filename, contentBase64 }) => {
  try {
    const s = loadSettingsRaw();
    const t = makeTransport();
    const from = s.fromName ? `"${s.fromName}" <${s.fromEmail}>` : s.fromEmail;
    const attachments = filename && contentBase64
      ? [{ filename, content: Buffer.from(contentBase64, "base64") }]
      : [];
    const info = await t.sendMail({ from, to, subject, text: body, attachments });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle("dir:get", () => loadDirectory());
ipcMain.handle("dir:setEntry", (_e, payload) => setDirectoryEntry(payload || {}));
ipcMain.handle("dir:import", (_e, entries) => importDirectory(entries));
ipcMain.handle("shell:openExternal", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ---- Ventana -------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Utilidades Va6s",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
