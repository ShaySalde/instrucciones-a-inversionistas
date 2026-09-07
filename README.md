# Instrucciones a Inversionistas — App de escritorio

App de escritorio (Electron) que procesa el *payment tape* de inversión y **envía a cada
inversionista su reporte por correo, con el Excel ya adjunto**, desde una cuenta de Gmail /
Google Workspace.

Conserva las 3 operaciones originales (Limpieza, Distribuir Payment Tape, Excel individual)
y añade envío real de correo con adjunto + un directorio de correos por NIT.

---

## 1. Requisitos para enviar correos (Gmail)

El envío usa el SMTP de Gmail con una **contraseña de aplicación** (no tu contraseña normal):

1. La cuenta debe tener **verificación en 2 pasos** activada.
2. Entra a **https://myaccount.google.com/apppasswords** y genera una contraseña de aplicación
   (16 dígitos). *(Dentro de la app, el enlace "¿Cómo la genero?" te lleva ahí.)*
3. En la app, abre **⚙ Configuración de correo** y escribe:
   - **Correo (remitente):** tu dirección `@salde.co` (o la cuenta desde la que enviarás).
   - **Nombre para el "De":** p. ej. *Área de Tesorería*.
   - **Contraseña de aplicación:** los 16 dígitos generados.
4. Pulsa **Guardar** y luego **Probar conexión**. Debe decir *Conexión OK ✓*.

> La contraseña se guarda **cifrada en tu equipo** (DPAPI en Windows) mediante `safeStorage` de
> Electron. Nunca se envía a ningún servidor salvo `smtp.gmail.com` al momento de enviar.

---

## 2. Cómo se usa

1. **⚙ Configuración de correo** (una sola vez): configura Gmail como arriba.
2. **Elige la operación** → **📧 Excel individual por inversionista**.
3. **Selecciona el archivo** (payment tape `.xlsx`/`.csv`) y pulsa **▶ Procesar**.
4. En **3 · Envío de correos por inversionista**:
   - El correo de cada inversionista se autocompleta desde el **directorio por NIT** (si ya lo
     enviaste antes). Puedes editarlo; se guarda para la próxima.
   - **📧 Enviar** manda ese reporte con el Excel adjunto.
   - **📨 Enviar a todos** manda el lote completo (pide confirmación; omite los que no tengan
     correo válido; deja una pausa entre envíos para respetar los límites de Gmail).

Límites orientativos de Gmail: ~500 destinatarios/día (cuenta normal) o ~2.000/día (Workspace).

---

## 3. Ejecutar en desarrollo (en esta Mac)

```bash
npm install
npm start
```

## 4. Generar el instalador de Windows (.exe)

### Opción recomendada — GitHub Actions (compila en Windows real)

1. Crea un repositorio en GitHub y sube esta carpeta:
   ```bash
   git init
   git add .
   git commit -m "Instrucciones a Inversionistas desktop"
   git branch -M main
   git remote add origin https://github.com/<tu-usuario>/<tu-repo>.git
   git push -u origin main
   ```
2. En GitHub, pestaña **Actions** → el flujo *Build Windows Installer* corre solo con el push
   (o ejecútalo manualmente con **Run workflow**).
3. Al terminar, descarga el artefacto **Instrucciones-a-Inversionistas-Windows-Installer** — contiene
   `Instrucciones-a-Inversionistas-Setup-1.0.0.exe`. Ese es el instalador para Windows.

### Opción alternativa — compilar en un PC Windows

En un Windows con Node instalado:
```bash
npm install
npm run dist
```
El instalador queda en `dist/Instrucciones-a-Inversionistas-Setup-1.0.0.exe`.

---

## 5. Estructura

```
electron/main.js     Proceso principal: ventana, envío SMTP, credenciales cifradas, directorio
electron/preload.js  Puente seguro renderer ↔ backend (contextIsolation)
renderer/index.html  Interfaz (HTML original adaptado: configuración, directorio, envío real)
package.json         Dependencias + configuración de electron-builder (instalador NSIS)
.github/workflows/   Compilación automática del .exe en Windows
```

Datos guardados en la carpeta de datos de usuario de la app:
`settings.json` (config de correo, contraseña cifrada) y `directory.json` (NIT → correo).
