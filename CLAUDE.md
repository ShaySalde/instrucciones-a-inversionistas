# Instrucciones a Inversionistas — Liquitech

(Display name is "Instrucciones a Inversionistas"; the internal package id / appId
is still `utilidades-va6s` / `co.salde.utilidadesva6s` — keep those stable.)

Electron desktop app (Windows) that processes a payment-tape / investment Excel,
emails a per-investor report (Excel attached), and registers one accounting
journal per investor in Siigo. Began as a single self-contained HTML file.

## Structure
- `renderer/index.html` — entire UI + logic (classic `<script>`, module-global functions), SheetJS (XLSX) embedded. This is the live app.
- `Utilidades_Va6s (3) (1).html` — original standalone source, kept for reference; do not edit.
- `electron/main.js` — main process; IPC for mail (nodemailer SMTP), NIT→email directory, and Siigo REST.
- `electron/preload.js` — contextBridge exposes `window.api.*` (contextIsolation on, no nodeIntegration).
- `renderer/fonts/` — Poppins woff2 bundled offline. `build/icon.ico` / `icon.png` — Liquitech brand icon.

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
- Config/send buttons show "Disponible en la app instalada" in a plain browser (no `window.api`); they only work inside Electron.
- DOM integration tests via `javascript_tool` run even when the Browser pane is hidden; for full-page screenshots, front the tab and resize the viewport tall.

## Gotchas
- Not installed on this machine: `brew`, `poppler`/`pdftoppm`, `gh`. Use PyMuPDF (`fitz`) + PIL for PDF/image work.
- Credentials (Gmail app password; Siigo username / access key / Partner-Id) are entered by the **user in-app** and encrypted with Electron `safeStorage` (DPAPI on Windows). Never enter, hardcode, or commit them. Siigo cannot be tested without the user's real credentials.
