# Instrucciones a Inversionistas — Liquitech

(Display name is "Instrucciones a Inversionistas"; the internal package id / appId
is still `utilidades-va6s` / `co.salde.utilidadesva6s` — keep those stable.)

Electron desktop app (Windows) that processes a payment-tape / investment Excel,
emails a per-investor report (Excel attached), and registers one accounting
journal per investor in Siigo. Began as a single self-contained HTML file.

## Structure
- `renderer/index.html` — entire UI + logic (classic `<script>`, module-global functions). This is the live app.
- `renderer/vendor/xlsx-js-style.min.js` — spreadsheet engine (SheetJS 0.18.5 **+ cell styles**), loaded via `<script src>`; replaced the old inlined community SheetJS (which silently dropped `.s` styles). Kept in `devDependencies`; the app loads the vendored copy, not `node_modules`.
- `Utilidades_Va6s (3) (1).html` — original standalone source, kept for reference; do not edit.
- `electron/main.js` — main process; IPC for mail (nodemailer SMTP), NIT→email directory, and Siigo REST.
- `electron/preload.js` — contextBridge exposes `window.api.*` (contextIsolation on, no nodeIntegration).
- `renderer/fonts/` — Poppins woff2 bundled offline. `build/icon.ico` / `icon.png` — Liquitech brand icon.

## App model
- **Identity = Nombre + NIT**, not NIT alone — some investors share a NIT (BTG/Skandia). `invId = name + "~|~" + nit` (`INV_SEP` must stay printable). `directory.json` and the Siigo-accounts store are keyed by `invId`; `migrateStoresOnce()` in main.js re-keys legacy NIT-keyed data.
- **Tabs** (`nav-tabs`): **Configuración** (`panelConfig`), **Operación** (`panelApp`), **Siigo** (`panelSiigo`) e **Instrucciones mensuales** (`panelMensual`). The old `.tab` code-preview tabs were removed.
- **Agregar una pantalla**: botón `.nav-tab[data-panel="X"]` + div `.nav-panel#X`; `showTab()` alterna `.active`. Reutiliza `.card`/`.drop`/`.btn`/`.status-pill`/`.cfg-field` y los tokens `--accent`/`--tint`/`--grad-brand`.
- **Payment tape splits by *fuente de fondeo*** (`runIndividual`): empty → per-investor report (Excel + email + Siigo *restitución*); non-empty (e.g. BANCO DE OCCIDENTE) → bank *"Abono a crédito financiero"* — email grouped by N° de obligación (shows only obligación + valor, **no Excel attached**); Siigo = 1 crédito total + 1 débito per obligación. **Exception:** a bank can also appear as the *inversionista titular* with an empty fuente; if its `NIT inversionista` is in the configured `siigoBankNits` list (Configuración → Siigo, campo "NITs de bancos"), that row is also routed to the bank/*abono a crédito* flow (keyed by investor name, NIT from the titular). Empty list = old behavior.
- The per-investor `.xlsx` from `buildIndividualBlob` **is** the investor email attachment (same blob for download and send).
- **Siigo journals** (`createJournal`, main.js): NIT sin dígito de verificación (`nitNoDV`); investor = débito (per-investor account) + crédito fija `11200507` / tercero `890903938`; bank = global `bankDebitAccount`; descriptions ≤100 chars.
- **Distribuir Payment Tape** output keeps only the original sheet + `Base Distribuida` (Tabla Inversionistas / Instruccion / Det_ sheets are no longer generated).
- **Instrucciones mensuales** (`panelMensual`, funciones `mz*`): sube varios `payment_tape_distribution_AAAA-MM-DD.csv` → Excel con 3 hojas (Detalle, Resumen con fórmulas **SUMIFS**, Notas). Fecha de instrucción = del NOMBRE del archivo; liquidación/aplicación se copian **sin recalcular**. Lógica pura en `mz*`, UI aparte. Los campos de periodo **"hasta" son INCLUSIVOS** en la UI (el día escrito cuenta): `mzReadDateInputs` suma +1 día y `mzSetDateInputs` muestra −1, porque `crit` y los SUMIFS trabajan con límite **exclusivo** (`<=` en las celdas de criterio del Excel, que muestran el último día incluido). No vuelvas "hasta" exclusivo: botaba el último día del mes (p. ej. las liquidaciones del 31).
- **Agregar un campo de config de Siigo** toca 6 sitios: `getSiigoConfigPublic` + `saveSiigoConfig` (main.js), y el default de `SIIGO_CFG` + `refreshReady` + carga del input + payload de guardado (index.html).

## Excel deliverables (styling)
- Corporate look lives in `styleReportSheet()` (index.html): title band, indigo header, zebra rows, Total row. Palette `XLC`; fonts **Segoe UI** (títulos/encabezados) + **Calibri** (datos), Windows-native — do **not** use Poppins in Excel (not installed on Windows).
- Both deliverables start at row 4: título (fila 1), subtítulo (fila 2), encabezado (fila 3), datos desde la 4.
- Writer supports styles, number formats, `!cols`/`!rows`/`!merges`/`!autofilter`, and **fórmulas por celda** (`{t:"n", f:"SUMIFS(…)"}` — sin valor en caché, Excel recalcula al abrir). It does **NOT** support `!freeze` panes or sheet tab color (the old `!freeze` was already a no-op).

## Commands
- `npm start` — run the app locally in Electron.
- `npm run dist` — build the Windows NSIS installer into `dist/`.
- The distributable `.exe` is built by GitHub Actions (`windows-latest`) via `.github/workflows/build-windows.yml`.

## Conventions
- UI text and code comments are in **Spanish**. Keep it that way.
- Liquitech brand: `--accent #775CF8`, `--accent-2 #3974F7`, `--ink #1D1D1B`; Poppins.
- Excel dates are stored as **serials** (epoch `Date.UTC(1899,11,30)`).
- Colombian holiday / business-day logic (Emiliani law + Easter) lives in `renderer/index.html`.

## Preview & testing
- Preview the renderer without Electron: `python3 -m http.server` inside `renderer/`, open it, and stub `window.api` (`getSettings`/`getDirectory`/`siigoGetAccounts`) for demo data.
- Run a real deliverable in-browser: set `currentFile` to a `File` (fetch a CSV served from `renderer/`) then call `runIndividual()` / `runDistribuir()`; inspect `individualResults` / `resultBlob`.
- Verify written cell styles offline in Node: `require("<abs>/node_modules/xlsx-js-style")`, write a file, `unzip` it, inspect `xl/styles.xml` (the reader does **not** rehydrate `.s`, so re-reading a blob won't show styles).
- Don't return large base64 from `javascript_tool` (overflows context) — it's saved to a file; decode with Python.
- After an Edit, the Browser pane may pin to the `file://` preview — open a **new tab** for `http://localhost:8797`.
- Config/send buttons show "Disponible en la app instalada" in a plain browser (no `window.api`); they only work inside Electron.
- DOM integration tests via `javascript_tool` run even when the Browser pane is hidden; for full-page screenshots, front the tab and resize the viewport tall.
- **Test headless del renderer**: `node_modules/.bin/electron tmp.js`, donde `tmp.js` abre un `BrowserWindow` oculto (`contextIsolation:true`), hace `loadFile(renderer/index.html)` y luego `webContents.executeJavaScript(...)` para llamar las funciones module-global reales (`mz*`, `runIndividual`, `XLSX.write`…) + `webContents.on("console-message", …)` para capturar errores JS y violaciones de CSP. No necesita `window.api` para lógica pura.

## Gotchas
- **Never commit** `Ejemplo…xlsx` or payment tapes (real NITs/amounts) — now gitignored (`payment_tape*`, `*_Distribuido.xlsx`, `renderer/__tmp_*`).
- `index.html` tiene una **CSP estricta** (`default-src 'none'`): nada de scripts/estilos/fuentes externas ni CDN, ni `fetch` desde el renderer (todo I/O por `window.api` IPC), y **sin `'unsafe-eval'`** (nada de `eval`/`new Function`, ni en libs vendidas).
- Lee hojas con `readWorkbookFromFile` (CSV → `file.text()` UTF-8 → `XLSX.read(type:"string")`): da acentos correctos y números/fechas tipados. Leer un CSV como buffer crudo desconfigura la codificación (mojibake) y los tipos (números como texto).
- Publishing the branded demo as an Artifact is blocked by the auto-mode classifier → deliver demo HTML via `SendUserFile` instead.
- git author identity is unconfigured (commits show the Mac hostname); the user can set `git config user.name/user.email`.
- Not installed on this machine: `brew`, `poppler`/`pdftoppm`, `gh`. Use PyMuPDF (`fitz`) + PIL for PDF/image work.
- Credentials (Gmail app password; Siigo username / access key / Partner-Id) are entered by the **user in-app** and encrypted with Electron `safeStorage` (DPAPI on Windows). Never enter, hardcode, or commit them. Siigo cannot be tested without the user's real credentials.
