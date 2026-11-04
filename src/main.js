"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, BrowserWindow, ipcMain, shell, nativeTheme, Notification, dialog, screen } = require("electron");
const agents = require("./agents");
const ai = require("./ai");
const config = require("./config");
const drafts = require("./drafts");
const health = require("./health");
const local = require("./local");
const localHistory = require("./localhistory");
const provider = require("./provider");
const updater = require("./updater");

// Proveedor activo (GitHub o GitLab) según config; se resuelve en cada llamada.
const gh = () => provider.current();

const SELFTEST = process.argv.includes("--selftest");
// os.tmpdir() en vez de /tmp: en Windows /tmp no existe (sería C:\tmp), aquí da %TEMP%.
const SELFTEST_SHOT = path.join(os.tmpdir(), "monstro-selftest.png");
const SELFTEST_ROUTE = (process.argv.find((a) => a.startsWith("--selftest-route=")) || "").split("=")[1] || "list";
// La ruta de resumen espera a una IA (lenta con Opus); la de releases proxea los avatares del grupo
// entero (groupProjects). Ambas necesitan más margen que los 20s por defecto.
const SELFTEST_TIMEOUT_MS =
  SELFTEST_ROUTE === "milestones-summary"
    ? 240000
    : SELFTEST_ROUTE.startsWith("releases") || SELFTEST_ROUTE.startsWith("local") || SELFTEST_ROUTE === "entornos" || SELFTEST_ROUTE.startsWith("validacion")
      ? 60000
      : 20000;

let win = null;

function createWindow() {
  // Media pantalla (mitad de ancho y de alto del área útil) y centrada; en pantallas pequeñas mandan
  // los mínimos. El selftest se queda en 1280×820 para que las capturas salgan siempre iguales.
  const MIN_WIDTH = 980;
  const MIN_HEIGHT = 600;
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: SELFTEST ? 1280 : Math.max(MIN_WIDTH, Math.round(screenWidth / 2)),
    height: SELFTEST ? 820 : Math.max(MIN_HEIGHT, Math.round(screenHeight / 2)),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    center: true,
    title: "Monstro",
    // hiddenInset + traffic lights son solo macOS. En Windows/Linux dejamos el marco nativo
    // (con sus botones minimizar/maximizar/cerrar); si no, la ventana se quedaría sin controles.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 } } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1f24" : "#f6f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Sin throttling en background: el polling sigue vivo y capturePage (selftest)
      // siempre obtiene un frame fresco aunque la ventana no esté en primer plano.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), {
    query: {
      selftest: SELFTEST ? "1" : "0",
      selftest_route: SELFTEST_ROUTE,
      seed_draft: process.argv.includes("--seed-draft") ? "1" : "0",
      // Override de idioma para previsualizar/capturar la UI en otro idioma (--lang=en).
      lang: (process.argv.find((a) => a.startsWith("--lang=")) || "").split("=")[1] || "",
    },
  });

  // OPE-20 fase 3: los agentes emiten eventos de timeline/estado al renderer por este canal.
  agents.init((type, payload) => { if (win && !win.isDestroyed()) win.webContents.send(type, payload); });

  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// rootDir efectivo (config, o ~/repositories bajo selftest para la captura) + valida que `dir`
// cuelgue de él. Seguridad: el renderer nunca puede pedir una ruta arbitraria fuera del raíz.
function localRootGuard(dir) {
  const root = config.load().local.rootDir || (SELFTEST ? path.join(app.getPath("home"), "repositories") : null);
  if (!root || !dir || !path.resolve(dir).startsWith(path.resolve(root) + path.sep)) {
    throw new Error("Ruta fuera del directorio raíz configurado");
  }
  return root;
}

// Plan → Markdown para publicarlo como nota en la Epic/Issue de GitLab (OPE-20: que no se pierda y
// lo vea todo el equipo). GitLab renderiza la nota como markdown (la "preview" que pide el usuario).
function planMarkdown({ title, indications, objectives, requirements, tests, projects }) {
  const bullets = (arr) => (arr || []).map((x) => `- ${x}`).join("\n");
  const sec = (h, arr) => ((arr || []).length ? `\n### ${h}\n${bullets(arr)}\n` : "");
  const projs = (projects || [])
    .map((p) => `\n**${p.name}**${p.model ? ` _(agente: ${p.model}${p.effort ? ` · ${p.effort}` : ""})_` : ""}\n${bullets(p.tasks)}`)
    .join("\n");
  return `## 🤖 Plan de trabajo (Monstro)\n\n_Plan aprobado y lanzado a los agentes el ${new Date().toLocaleString("es-ES")}._\n${indications ? `\n> **Indicaciones:** ${indications}\n` : ""}${sec("🎯 Objetivos", objectives)}${sec("📋 Requisitos", requirements)}${projects && projects.length ? `\n### 📦 Trabajo por proyecto\n${projs}\n` : ""}${sec("🧪 Pruebas", tests)}`;
}

// Prepara la rama de una MR en un repo local: (opcional) crea una rama feature, commitea los cambios
// sin commitear (SIEMPRE que el working tree esté sucio — no se salta en silencio aunque no haya
// mensaje: usa el fallback) con el "#<iid>" al final para linkar el commit, y hace push. Devuelve
// {branch, commit:{sha,url}|null, steps:[]} — `steps` es el log de pasos para la vista de detalle.
async function prepareLocalBranch(dir, projectPath, { sourceBranch, newBranch, commitMessage, issueIid, push, fallbackMessage }) {
  const branchRe = /^[\w./-]{1,200}$/;
  const steps = [];
  let branch = sourceBranch;
  if (newBranch) {
    if (!branchRe.test(newBranch)) throw new Error("Nombre de rama nueva no válido");
    await local.createLocalBranch(dir, newBranch);
    branch = newBranch;
    steps.push({ ok: true, text: `Rama feature creada: ${newBranch}` });
  }
  let commit = null;
  const dirty = await local.isDirty(dir);
  if (dirty) {
    // Importante: aunque no haya mensaje, NO nos saltamos el commit (era el bug del push silencioso).
    const msgBase = (commitMessage && String(commitMessage).trim()) || (fallbackMessage && String(fallbackMessage).trim()) || "Cambios de la tarea";
    const full = issueIid ? `${msgBase}\n\n#${issueIid}` : msgBase;
    commit = await local.commitAll(dir, full);
    if (commit) {
      const base = (config.load().gitlabBaseUrl || "").replace(/\/+$/, "");
      commit.url = `${base}/${projectPath}/-/commit/${commit.sha}`;
      steps.push({ ok: true, text: `Commit creado: ${commit.sha.slice(0, 8)} — "${msgBase}"` });
    } else {
      steps.push({ ok: false, text: "Había cambios pero no se pudo crear el commit" });
    }
  } else {
    steps.push({ ok: true, text: "Sin cambios locales que commitear" });
  }
  if (push) {
    const res = await local.pushBranch(dir, branch);
    const upToDate = /up-to-date|up to date/i.test(res.output || "");
    steps.push({ ok: true, text: upToDate ? `Push de ${branch}: la rama ya estaba al día en origin` : `Push de ${branch} a origin: ok` });
  } else {
    steps.push({ ok: true, text: "Push omitido (desmarcado)" });
  }
  return { branch, commit, steps };
}

function wireIpc() {
  // ctx = lo único que los módulos de ipc no pueden requerir por su cuenta. `win` va como
  // getter porque se reasigna al crear la ventana.
  const ctx = {
    get win() { return win; },
    SELFTEST,
    localRootGuard,
    prepareLocalBranch,
    planMarkdown,
  };
  require("./ipc/config").register(ctx);
  require("./ipc/local").register(ctx);
  require("./ipc/agents").register(ctx);
  require("./ipc/local-history").register(ctx);
  require("./ipc/prs").register(ctx);
  require("./ipc/milestones").register(ctx);
  require("./ipc/releases").register(ctx);
  require("./ipc/env").register(ctx);
  require("./ipc/validation").register(ctx);
  require("./ipc/cognito").register(ctx);
  require("./ipc/mail").register(ctx);
  require("./ipc/system").register(ctx);
  require("./ipc/sessions").register(ctx);
  require("./ipc/local-run").register(ctx);
}

function wireSelftest() {
  let done = false;
  const finish = async (reason) => {
    if (done || !win) return;
    done = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1300)); // deja asentar fuentes/avatares
      const bodyLength = await win.webContents.executeJavaScript("document.body.innerHTML.length");
      // doble rAF: garantiza que el último DOM se ha pintado/compuesto antes de capturar
      await win.webContents.executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const image = await win.webContents.capturePage();
      fs.writeFileSync(SELFTEST_SHOT, image.toPNG());
      console.log(`[selftest] screenshot: ${SELFTEST_SHOT} (reason=${reason}, bodyHTML=${bodyLength} chars)`);
    } catch (err) {
      console.error("[selftest] capture failed:", err);
    } finally {
      app.quit();
    }
  };
  ipcMain.once("selftest:render-complete", () => finish("render-complete"));
  setTimeout(() => finish("timeout"), SELFTEST_TIMEOUT_MS);
}

app.whenReady().then(() => {
  const dockIcon = path.join(__dirname, "..", "assets", "icon-512.png");
  if (process.platform === "darwin" && fs.existsSync(dockIcon)) app.dock.setIcon(dockIcon);
  wireIpc();
  if (SELFTEST) wireSelftest();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
