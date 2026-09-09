// ==============================================================================
//  Instrucciones a Inversionistas — proceso principal de Electron
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
    signatureHtml: s.signatureHtml || "",
    logoDataUrl: s.signatureLogo
      ? ("data:" + (s.signatureLogoType || "image/png") + ";base64," + s.signatureLogo)
      : "",
  };
}

// Texto plano -> HTML seguro (para el cuerpo del correo cuando se envía en HTML).
function textToHtml(t) {
  return String(t == null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r\n|\r|\n/g, "<br>");
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

function saveSettings({ fromEmail, fromName, appPassword, signatureHtml, signatureLogo, signatureLogoClear }) {
  const s = loadSettingsRaw();
  s.fromEmail = (fromEmail || "").trim();
  s.fromName = (fromName || "").trim();
  // Firma HTML (se agrega al final de cada correo).
  if (typeof signatureHtml === "string") s.signatureHtml = signatureHtml;
  // Logo de la firma: viene como data URL; se guarda tipo + base64. `clear` lo quita.
  if (signatureLogoClear) {
    delete s.signatureLogo; delete s.signatureLogoType;
  } else if (typeof signatureLogo === "string" && signatureLogo.startsWith("data:")) {
    const m = signatureLogo.match(/^data:([^;]+);base64,(.*)$/);
    if (m) { s.signatureLogoType = m[1]; s.signatureLogo = m[2]; }
  }
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

// ---- Directorio inversionista(Nombre + NIT) -> correos -------------------------
// directory.json: { [invId]: { name, nit, emails:[..] } }.
// Identidad = Nombre + NIT (dos inversionistas distintos pueden compartir el mismo
// NIT, p. ej. BTG y Skandia). Se migra el formato antiguo (clave = NIT).
const INV_SEP = "~|~"; // separador seguro (nunca aparece en nombres ni NITs)
function invId(name, nit) { return String(name || "").trim() + INV_SEP + String(nit || "").trim(); }
function normEmails(e) {
  let emails = Array.isArray(e && e.emails) ? e.emails.slice() : (e && e.email ? [e.email] : []);
  emails = emails.map((x) => String(x || "").trim()).filter(Boolean);
  return emails.filter((v, i) => emails.indexOf(v) === i); // sin duplicados, en orden
}
// Re-indexa por invId(name, nit); tolera el formato antiguo (clave = NIT, sin campo `nit`).
function loadDirectory() {
  const raw = readJson(directoryPath(), {});
  const out = {};
  for (const k of Object.keys(raw)) {
    const e = raw[k] || {};
    const name = (e.name || "").trim();
    const nit = (e.nit !== undefined && e.nit !== null ? String(e.nit) : String(k)).trim();
    out[invId(name, nit)] = { name, nit, emails: normEmails(e) };
  }
  return out;
}

// Guarda por (nombre + NIT). Si `emails` es undefined, conserva los actuales. `_delete` borra.
function setDirectoryEntry({ name, nit, emails, _delete }) {
  const d = loadDirectory();
  const nm = String(name || "").trim();
  const nt = String(nit || "").trim();
  if (!nm && !nt) return d;
  const id = invId(nm, nt);
  if (_delete) { delete d[id]; writeJson(directoryPath(), d); return d; }
  const cur = d[id] || { name: nm, nit: nt, emails: [] };
  const newEmails = (emails !== undefined) ? normEmails({ emails }) : cur.emails;
  d[id] = { name: nm, nit: nt, emails: newEmails };
  writeJson(directoryPath(), d);
  return d;
}

function importDirectory(entries) {
  const d = loadDirectory();
  for (const e of entries || []) {
    const nm = String(e.name || "").trim();
    const nt = String(e.nit || "").trim();
    if (!nm && !nt) continue;
    d[invId(nm, nt)] = { name: nm, nit: nt, emails: normEmails(e) };
  }
  writeJson(directoryPath(), d);
  return d;
}

// Inversionistas que vienen de fábrica (Nombre + NIT). Sin correos ni cuentas:
// esos los completa el usuario en la app. Dos pares comparten NIT a propósito.
const DEFAULT_INVESTORS = [
  ["CREDICORP CAPITAL DERECHOS ECONÓMICOS 2026", "901238753"],
  ['FONDO DE INVERSION COLECTIVA CERRADO "BTG PACTUAL CREDITO" II', "900155109"],
  ["Liquitech S.A.S", "901228343"],
  ["PATRIMONIOS AUTÓNOMOS SKANDIA SOCIEDAD FIDUCIARIA - PA LIQUITECH ALIANZA", "830057062"],
  ["PATRIMONIOS AUTONOMOS SKANDIA SOCIEDAD FIDUCIARIA S.A.", "830057062"],
  ["SEMPLI S.A.S", "900995954"],
  ["CREDICORP CAPITAL FACTORING", "900192261"],
  ['FONDO DE INVERSION COLECTIVA CERRADO "BTG PACTUAL CREDITO"', "900155109"],
  ["Tinello Capital S A S", "900884741"],
  ["BANCO DE OCCIDENTE S.A", "890300279"],
  ["VESTAS S.A.S", "900579376"],
];

// Siembra el directorio con los inversionistas de fábrica SOLO en la primera
// ejecución (cuando aún no existe directory.json). Después el usuario manda:
// no se re-siembra ni se “resucita” lo que borre.
function seedDirectoryOnce() {
  const p = directoryPath();
  if (fs.existsSync(p)) return;
  const d = {};
  for (const [name, nit] of DEFAULT_INVESTORS) {
    d[invId(name, nit)] = { name: name.trim(), nit: String(nit).trim(), emails: [] };
  }
  writeJson(p, d);
}

// Migración única: re-indexa directorio y cuentas Siigo al formato { [invId]: ... }.
function migrateStoresOnce() {
  try {
    const dRaw = readJson(directoryPath(), {});
    const dKeys = Object.keys(dRaw);
    if (dKeys.length && !dKeys.every((k) => k.indexOf(INV_SEP) !== -1)) {
      writeJson(directoryPath(), loadDirectory()); // loadDirectory ya re-indexa a invId
    }
  } catch (_) {}
  try {
    const sRaw = readJson(siigoAccountsPath(), {});
    const sKeys = Object.keys(sRaw);
    if (sKeys.length && !sKeys.every((k) => k.indexOf(INV_SEP) !== -1)) {
      const dir = loadDirectory(); // { invId: {name, nit, emails} }
      const nameByNit = {};
      for (const id of Object.keys(dir)) {
        const e = dir[id];
        if (e.nit && e.name && !nameByNit[e.nit]) nameByNit[e.nit] = e.name;
      }
      const out = {};
      for (const k of sKeys) {
        if (k.indexOf(INV_SEP) !== -1) { out[k] = sRaw[k]; continue; }
        const nit = String(k).trim();
        const name = nameByNit[nit] || "";
        out[invId(name, nit)] = Object.assign({ name, nit }, sRaw[k]);
      }
      writeJson(siigoAccountsPath(), out);
    }
  } catch (_) {}
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
    creditAccount: s.siigoCreditAccount || "",   // cuenta crédito fija (p. ej. 11200507)
    creditNit: s.siigoCreditNit || "",           // tercero fijo de la línea crédito (sin DV)
    bankDebitAccount: s.siigoBankDebitAccount || "", // cuenta débito para abonos a crédito (banco, p. ej. 21052504)
  };
}
// NIT sin dígito de verificación (900.123.456-1 -> 900123456)
function nitNoDV(nit) { return String(nit || "").split("-")[0].replace(/\D/g, ""); }
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
function saveSiigoConfig({ partnerId, username, accessKey, documentId, creditAccount, creditNit, bankDebitAccount }) {
  const s = loadSettingsRaw();
  s.siigoPartnerId = (partnerId || "").trim();
  s.siigoUsername = (username || "").trim();
  if (documentId !== undefined) s.siigoDocumentId = String(documentId || "").trim();
  if (creditAccount !== undefined) s.siigoCreditAccount = String(creditAccount || "").trim();
  if (creditNit !== undefined) s.siigoCreditNit = nitNoDV(creditNit);
  if (bankDebitAccount !== undefined) s.siigoBankDebitAccount = String(bankDebitAccount || "").trim();
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

// Cuentas contables por inversionista (Nombre + NIT): { [invId]: { name, nit, debit, credit } }
function loadSiigoAccounts() { return readJson(siigoAccountsPath(), {}); }
function setSiigoAccount({ name, nit, debit, credit }) {
  const d = loadSiigoAccounts();
  const nm = String(name || "").trim();
  const nt = String(nit || "").trim();
  if (!nm && !nt) return d;
  const key = invId(nm, nt);
  const cur = d[key] || {};
  const entry = {
    name: nm, nit: nt,
    debit: (debit != null ? String(debit).trim() : (cur.debit || "")),
    credit: (credit != null ? String(credit).trim() : (cur.credit || "")),
  };
  if (!entry.debit && !entry.credit) delete d[key];
  else d[key] = entry;
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

    const sig = (s.signatureHtml || "").trim();
    const mail = { from, to, subject, attachments };
    if (sig) {
      let sigHtml = sig;
      if (s.signatureLogo) {
        // Logo incrustado (inline) via Content-ID: no depende de imágenes externas.
        const cid = "sig-logo";
        attachments.push({
          filename: "logo",
          content: Buffer.from(s.signatureLogo, "base64"),
          contentType: s.signatureLogoType || "image/png",
          cid,
        });
        const img = '<img src="cid:' + cid + '" alt="logo" style="max-height:72px;border:0;display:block">';
        sigHtml = sigHtml.includes("{{logo}}") ? sigHtml.replace(/\{\{logo\}\}/g, img) : (img + "<br>" + sigHtml);
      }
      mail.html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1D1D1B;line-height:1.5">'
        + textToHtml(body) + "<br><br>" + sigHtml + "</div>";
      const plainSig = sig.replace(/\{\{logo\}\}/g, "").replace(/<br\s*\/?>(?=\s*<br)?/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
      mail.text = body + (plainSig ? "\n\n" + plainSig : "");
    } else {
      mail.text = body;
    }
    const info = await t.sendMail(mail);
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

    const md0 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(p2.date || ""));
    const fechaTxt0 = md0 ? (Number(md0[3]) + "/" + md0[2] + "/" + md0[1]) : String(p2.date || "");
    const trunc100 = (t) => (t.length > 100 ? t.slice(0, 100) : t);

    // ---- Modo BANCO (abono a crédito financiero): crédito total + un débito por obligación ----
    if (p2.mode === "bank") {
      const creditAccount = String(p2.creditAccount || s.siigoCreditAccount || "").trim();
      const creditNit = nitNoDV(p2.creditNit || s.siigoCreditNit || "");
      const debitAccount = String(p2.bankDebitAccount || s.siigoBankDebitAccount || "").trim();
      const fuenteNit = nitNoDV(p2.fuenteNit || "");
      const fuente = p2.fuenteName || "";
      const lines = (Array.isArray(p2.lines) ? p2.lines : [])
        .map((l) => ({ obligacion: String(l.obligacion || "").trim(), value: Number(l.value) || 0 }))
        .filter((l) => l.value > 0);
      if (!creditAccount || !creditNit) return { ok: false, error: "Falta la cuenta/tercero de crédito fijos (configúralos en Siigo)." };
      if (!debitAccount) return { ok: false, error: "Falta la cuenta débito para abonos a crédito (configúrala en Siigo)." };
      if (!fuenteNit) return { ok: false, error: "Falta el NIT de la fuente de fondeo." };
      if (!lines.length) return { ok: false, error: "No hay obligaciones con monto para registrar." };
      if (!p2.date) return { ok: false, error: "Falta la fecha del comprobante." };
      let total = 0; for (const l of lines) total += l.value;
      if (!(total > 0)) return { ok: false, error: "El total debe ser mayor que cero." };
      const numbers = lines.map((l) => l.obligacion).filter(Boolean).join("-");
      const creditDesc = trunc100("Abono a crédito financiero " + fuente + " No. " + numbers);
      const items = [
        { account: { code: creditAccount, movement: "Credit" }, value: total, description: creditDesc, customer: { identification: creditNit, branch_office: 0 } },
        ...lines.map((l) => ({
          account: { code: debitAccount, movement: "Debit" }, value: l.value,
          description: trunc100("Abono a crédito financiero " + fuente + " No. " + l.obligacion),
          customer: { identification: fuenteNit, branch_office: 0 },
        })),
      ];
      const payloadB = { document: { id: Number(docId) }, date: p2.date, items, observations: creditDesc };
      const rb = await siigoFetch("/v1/journals", { method: "POST", body: JSON.stringify(payloadB) });
      if (!rb.ok) return { ok: false, error: siigoErr(rb) };
      const db = rb.data || {};
      return { ok: true, id: db.id, number: db.number || db.name || (db.document && db.document.number) || db.id };
    }

    // Débito = cuenta del inversionista + NIT del inversionista (sin dígito de verificación).
    // Crédito = cuenta y tercero FIJOS (globales, configurados en la pantalla de Siigo).
    const debitAccount  = String(p2.debit || "").trim();
    const creditAccount = String(p2.creditAccount || s.siigoCreditAccount || "").trim();
    const creditNit     = nitNoDV(p2.creditNit || s.siigoCreditNit || "");
    const investorNit   = nitNoDV(p2.nit || "");
    if (!debitAccount) return { ok: false, error: "Falta la cuenta débito de este inversionista (configúrala en el directorio)." };
    if (!creditAccount) return { ok: false, error: "Falta la cuenta crédito fija (configúrala en la pantalla de Siigo)." };
    if (!creditNit) return { ok: false, error: "Falta el tercero de la línea crédito (configúralo en la pantalla de Siigo)." };

    const v = Number(p2.value);
    if (!(v > 0)) return { ok: false, error: "El monto debe ser mayor que cero." };
    if (!p2.date) return { ok: false, error: "Falta la fecha del comprobante." };

    // Fecha para la descripción: D/MM/YYYY (p. ej. 3/08/2026)
    const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(p2.date));
    const fechaTxt = md ? (Number(md[3]) + "/" + md[2] + "/" + md[1]) : String(p2.date);
    let desc = "Restitución de cartera recaudada " + (p2.name || "") + " Instrucción (" + fechaTxt + ")";
    if (desc.length > 100) desc = desc.slice(0, 100);

    const payload = {
      document: { id: Number(docId) },
      date: p2.date,
      items: [
        { account: { code: debitAccount, movement: "Debit" }, value: v, description: desc,
          customer: { identification: investorNit || creditNit, branch_office: 0 } },
        { account: { code: creditAccount, movement: "Credit" }, value: v, description: desc,
          customer: { identification: creditNit, branch_office: 0 } },
      ],
      observations: desc,
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
    title: "Instrucciones a Inversionistas",
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

app.whenReady().then(() => {
  try { seedDirectoryOnce(); } catch (_) {}
  try { migrateStoresOnce(); } catch (_) {}
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
