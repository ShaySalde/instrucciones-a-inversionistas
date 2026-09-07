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
const siigoAccountsPath = () => path.join(app.getPath("userData"), "siigo-accounts.json");

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

// ==============================================================================
//  Integración con Siigo (comprobantes contables)
//  - Credenciales (access key) cifradas en settings.json vía safeStorage.
//  - Cuentas débito/crédito por NIT en siigo-accounts.json.
//  - Autenticación con token Bearer en caché; POST /v1/journals por inversionista.
// ==============================================================================
const SIIGO_BASE = "https://api.siigo.com";
let _siigoToken = null, _siigoTokenExp = 0;

function getSiigoConfigPublic() {
  const s = loadSettingsRaw();
  return {
    partnerId: s.siigoPartnerId || "",
    username: s.siigoUsername || "",
    hasAccessKey: !!(s.siigoAccessKeyEnc || s.siigoAccessKeyPlain),
    documentId: s.siigoDocumentId || "",
    nitLine: s.siigoNitLine || "both",
  };
}
function getSiigoAccessKey() {
  const s = loadSettingsRaw();
  if (s.siigoAccessKeyEnc) {
    try {
      const buf = Buffer.from(s.siigoAccessKeyEnc, "base64");
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    } catch (_) { /* cae al plano si existe */ }
  }
  return s.siigoAccessKeyPlain || "";
}
function saveSiigoConfig({ partnerId, username, accessKey, documentId, nitLine }) {
  const s = loadSettingsRaw();
  s.siigoPartnerId = (partnerId || "").trim();
  s.siigoUsername = (username || "").trim();
  if (documentId !== undefined) s.siigoDocumentId = String(documentId || "").trim();
  if (nitLine !== undefined) s.siigoNitLine = nitLine || "both";
  if (typeof accessKey === "string" && accessKey.trim().length) {
    const k = accessKey.trim();
    delete s.siigoAccessKeyPlain;
    if (safeStorage.isEncryptionAvailable()) s.siigoAccessKeyEnc = safeStorage.encryptString(k).toString("base64");
    else { delete s.siigoAccessKeyEnc; s.siigoAccessKeyPlain = k; }
  }
  writeJson(settingsPath(), s);
  _siigoToken = null; // fuerza re-autenticación con las nuevas credenciales
  return getSiigoConfigPublic();
}

// Cuentas contables por NIT: { [nit]: { debit, credit } }
function loadSiigoAccounts() { return readJson(siigoAccountsPath(), {}); }
function setSiigoAccount({ nit, debit, credit }) {
  const d = loadSiigoAccounts();
  const key = String(nit || "").trim();
  if (!key) return d;
  const cur = d[key] || {};
  d[key] = {
    debit: (debit != null ? String(debit).trim() : (cur.debit || "")),
    credit: (credit != null ? String(credit).trim() : (cur.credit || "")),
  };
  if (!d[key].debit && !d[key].credit) delete d[key];
  writeJson(siigoAccountsPath(), d);
  return d;
}

async function siigoAuth() {
  const s = loadSettingsRaw();
  const username = s.siigoUsername, accessKey = getSiigoAccessKey(), partnerId = s.siigoPartnerId;
  if (!username || !accessKey || !partnerId) {
    throw new Error("Falta configurar usuario API, access key o Partner-Id de Siigo.");
  }
  if (_siigoToken && Date.now() < _siigoTokenExp - 60000) return _siigoToken;
  const res = await fetch(SIIGO_BASE + "/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Partner-Id": partnerId },
    body: JSON.stringify({ username, access_key: accessKey }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error("Autenticación Siigo falló (HTTP " + res.status + "): " +
      (data.Errors ? JSON.stringify(data.Errors) : (data.message || res.statusText || "sin detalle")));
  }
  _siigoToken = data.access_token;
  _siigoTokenExp = Date.now() + ((data.expires_in || 86400) * 1000);
  return _siigoToken;
}
async function siigoFetch(pathname, options = {}) {
  const s = loadSettingsRaw();
  const token = await siigoAuth();
  const res = await fetch(SIIGO_BASE + pathname, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
      "Partner-Id": s.siigoPartnerId,
      ...(options.headers || {}),
    },
  });
  const raw = await res.text();
  let data; try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
  return { ok: res.ok, status: res.status, data };
}
function siigoErr(r) {
  const d = r && r.data;
  const detail = d && (d.Errors || d.errors || d.message || d.raw || d);
  return "HTTP " + (r ? r.status : "?") + ": " + (typeof detail === "string" ? detail : JSON.stringify(detail));
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

// ---- Siigo ----
ipcMain.handle("siigo:getConfig", () => getSiigoConfigPublic());
ipcMain.handle("siigo:saveConfig", (_e, payload) => saveSiigoConfig(payload || {}));
ipcMain.handle("siigo:verify", async () => {
  try { await siigoAuth(); return { ok: true }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
ipcMain.handle("siigo:getDocumentTypes", async () => {
  try {
    const r = await siigoFetch("/v1/document-types?type=Journal");
    if (!r.ok) return { ok: false, error: siigoErr(r) };
    const list = Array.isArray(r.data) ? r.data : (r.data.results || []);
    return { ok: true, types: list.map(t => ({ id: t.id, code: t.code, name: t.name })) };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
ipcMain.handle("siigo:getAccounts", () => loadSiigoAccounts());
ipcMain.handle("siigo:setAccount", (_e, payload) => setSiigoAccount(payload || {}));
ipcMain.handle("siigo:createJournal", async (_e, p) => {
  try {
    const s = loadSettingsRaw();
    const p2 = p || {};
    const docId = p2.documentId || s.siigoDocumentId;
    if (!docId) return { ok: false, error: "Falta el tipo de comprobante (configúralo en Siigo)." };
    if (!p2.debit || !p2.credit) return { ok: false, error: "Faltan las cuentas débito/crédito de este inversionista." };
    const v = Number(p2.value);
    if (!(v > 0)) return { ok: false, error: "El monto debe ser mayor que cero." };
    if (!p2.date) return { ok: false, error: "Falta la fecha del comprobante." };

    const line = p2.nitLine || s.siigoNitLine || "both";
    const ident = String(p2.nit || "").trim();
    const desc = "Monto instruido " + (p2.name || "");
    const mkItem = (code, movement, withCust) => {
      const it = { account: { code: String(code).trim(), movement }, value: v, description: desc };
      if (withCust && ident) it.customer = { identification: ident, branch_office: 0 };
      return it;
    };
    const payload = {
      document: { id: Number(docId) },
      date: p2.date,
      items: [
        mkItem(p2.debit, "Debit", line === "debit" || line === "both"),
        mkItem(p2.credit, "Credit", line === "credit" || line === "both"),
      ],
      observations: "Registrado desde Utilidades Va6s · " + (p2.name || "") + (ident ? (" · NIT " + ident) : ""),
    };
    const r = await siigoFetch("/v1/journals", { method: "POST", body: JSON.stringify(payload) });
    if (!r.ok) return { ok: false, error: siigoErr(r) };
    const d = r.data || {};
    return { ok: true, id: d.id, number: d.number || d.name || (d.document && d.document.number) || d.id };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

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
