"use strict";

// Handlers IPC de estado de sesión, configuración, autoactualización y sugerencia de repos.
// Se registran desde wireIpc() en src/main.js.

const { app, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const ai = require("../ai");
const config = require("../config");
const local = require("../local");
const provider = require("../provider");
const updater = require("../updater");

const gh = () => provider.current();

function register(ctx) {
  ipcMain.handle("auth:status", async () => {
    const { token, source } = gh().resolveToken();
    if (!token) return { ok: false, source: null, login: null };
    try {
      const me = await gh().viewer();
      return { ok: true, source, login: me.login, avatarUrl: me.avatarUrl };
    } catch (err) {
      return { ok: false, source, login: null, error: String(err.message || err) };
    }
  });

  ipcMain.handle("config:get", () => {
    const { token, mail, ...rest } = config.load();
    // El refreshToken de Outlook se trata como el token del proveedor: jamás cruza al renderer.
    const mailSafe = { clientId: mail.clientId, tenant: mail.tenant, folder: mail.folder };
    // systemLocale = idioma del SO (BCP-47, p.ej. "es-ES"); el renderer lo usa como
    // idioma por defecto cuando config.language es null.
    return { ...rest, mail: mailSafe, hasManualToken: Boolean(token), systemLocale: app.getLocale(), appVersion: app.getVersion() };
  });

  // Comprueba si hay una versión nueva en las Releases de GitHub. No instala nada — solo informa.
  ipcMain.handle("update:check", () => updater.check());

  // Actualizar (lo dispara el click en el toast de versión nueva). El renderer NO manda ninguna
  // URL: solo pide "actualiza" y updater.js resuelve el asset contra la API del propio repo —
  // descargar y abrir un binario jamás con una ruta que venga del renderer.
  ipcMain.handle("update:install", async () => {
    try {
      return await updater.install((percent) => {
        if (!ctx.win || ctx.win.isDestroyed()) return;
        // Barra de progreso nativa en el Dock/barra de tareas, gratis: el toast solo lleva el %.
        ctx.win.setProgressBar(percent / 100);
        ctx.win.webContents.send("update:progress", percent);
      });
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    } finally {
      if (ctx.win && !ctx.win.isDestroyed()) ctx.win.setProgressBar(-1);
    }
  });

  ipcMain.handle("config:set", (_event, partial) => {
    const allowed = {};
    // GitLab admite paths anidados (group/sub/project); GitHub solo owner/repo.
    const current = config.load();
    const nextProvider = partial.provider === "github" || partial.provider === "gitlab" ? partial.provider : current.provider;
    const repoRe = nextProvider === "gitlab" ? /^[\w.-]+(\/[\w.-]+)+$/ : /^[\w.-]+\/[\w.-]+$/;
    if (Array.isArray(partial.repos)) allowed.repos = partial.repos.filter((r) => repoRe.test(r));
    if (Number.isInteger(partial.pollSeconds) && partial.pollSeconds >= 15) allowed.pollSeconds = partial.pollSeconds;
    if (["one-dark", "dracula", "github-light"].includes(partial.theme)) allowed.theme = partial.theme;
    if (["default", "liquid-glass"].includes(partial.uiTheme)) allowed.uiTheme = partial.uiTheme;
    if (partial.language === "es" || partial.language === "en" || partial.language === null) allowed.language = partial.language;
    if (typeof partial.checkUpdates === "boolean") allowed.checkUpdates = partial.checkUpdates;
    if (partial.provider === "github" || partial.provider === "gitlab") {
      allowed.provider = partial.provider;
      // Cambiar de proveedor invalida el token: era de otro sitio.
      if (partial.provider !== current.provider) {
        allowed.token = null;
        gh().invalidateTokenCache();
      }
    }
    if (typeof partial.gitlabBaseUrl === "string" && /^https:\/\/[\w.-]+/.test(partial.gitlabBaseUrl.trim())) {
      allowed.gitlabBaseUrl = partial.gitlabBaseUrl.trim().replace(/\/+$/, "");
      gh().invalidateTokenCache();
    }
    // Bandeja de propuestas: solo los tres ajustes visibles. El refreshToken lo escribe src/mail.js,
    // nunca el renderer.
    if (partial.mail && typeof partial.mail === "object") {
      const m = {};
      for (const key of ["clientId", "tenant", "folder"]) {
        if (typeof partial.mail[key] === "string") m[key] = partial.mail[key].trim() || null;
      }
      if (Object.keys(m).length) allowed.mail = { ...current.mail, ...m };
    }
    if (typeof partial.aiModel === "string" && ai.isAiModel(partial.aiModel)) allowed.aiModel = partial.aiModel;
    if (typeof partial.aiEffort === "string" && ai.isAiEffort(partial.aiEffort)) allowed.aiEffort = partial.aiEffort;
    if (typeof partial.token === "string") {
      allowed.token = partial.token.trim() || null;
      gh().invalidateTokenCache();
    }
    if (typeof partial.lastRepo === "string") allowed.lastRepo = partial.lastRepo;
    if (typeof partial.lastBucket === "string") allowed.lastBucket = partial.lastBucket;
    // Apartados del menú: enum cerrado de claves; el renderer manda solo las habilitadas.
    if (Array.isArray(partial.sections)) {
      // Espejo de MENU_SECTIONS (renderer/app/core.js). Si añades una sección allí y no aquí, se
      // descarta en silencio al guardar — lo vigila scripts/test-sections-sync.js.
      const SECTION_KEYS = ["prs", "validacion", "historial", "historico", "milestones", "soporte", "releases", "entornos", "local", "propuestas", "usuarios"];
      allowed.sections = partial.sections.filter((s) => SECTION_KEYS.includes(s));
    }
    if (partial.cognito && typeof partial.cognito === "object") {
      const c = partial.cognito;
      const next = { ...current.cognito };
      if (typeof c.profile === "string" && /^[\w.@-]{1,64}$/.test(c.profile)) next.profile = c.profile;
      else if (c.profile === null) next.profile = null;
      if (typeof c.region === "string" && /^[a-z]{2}-[a-z]+-\d$/.test(c.region)) next.region = c.region;
      if (typeof c.poolId === "string" && /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/.test(c.poolId)) next.poolId = c.poolId;
      else if (c.poolId === null) next.poolId = null;
      allowed.cognito = next;
    }
    if (partial.cherryPick && typeof partial.cherryPick === "object") {
      const cp = partial.cherryPick;
      const branchRe = /^[\w./-]{1,200}$/;
      const next = { ...current.cherryPick };
      if (typeof cp.prefix === "string" && cp.prefix.trim()) next.prefix = cp.prefix.trim();
      if (Array.isArray(cp.branches)) next.branches = cp.branches.filter((b) => typeof b === "string" && branchRe.test(b));
      if (typeof cp.siblingMx === "boolean") next.siblingMx = cp.siblingMx;
      allowed.cherryPick = next;
    }
    if (partial.milestones && typeof partial.milestones === "object") {
      const m = partial.milestones;
      const next = { ...current.milestones };
      if (typeof m.group === "string") next.group = m.group.trim() || null;
      else if (m.group === null) next.group = null;
      if (Array.isArray(m.statusLabels)) {
        next.statusLabels = m.statusLabels.filter((l) => typeof l === "string" && l.trim());
      }
      if (Array.isArray(m.doneLabels)) {
        next.doneLabels = m.doneLabels.filter((l) => typeof l === "string" && l.trim());
      }
      allowed.milestones = next;
    }
    if (partial.releases && typeof partial.releases === "object") {
      const r = partial.releases;
      const next = { ...current.releases };
      const branchRe = /^[\w./-]{1,200}$/;
      if (typeof r.sourceBranch === "string" && branchRe.test(r.sourceBranch.trim())) next.sourceBranch = r.sourceBranch.trim();
      if (typeof r.branchPrefix === "string" && /^[\w./-]{0,40}$/.test(r.branchPrefix)) next.branchPrefix = r.branchPrefix;
      // Proyectos: ids del set por defecto (strings) y la última selección recordada (paths/ids).
      const projId = /^[\w.-]+(\/[\w.-]+)*$/;
      if (Array.isArray(r.defaultProjectIds)) {
        next.defaultProjectIds = r.defaultProjectIds.filter((id) => (typeof id === "string" || typeof id === "number") && projId.test(String(id))).map(String);
      }
      if (Array.isArray(r.selectedProjects)) {
        next.selectedProjects = r.selectedProjects.filter((p) => typeof p === "string" && projId.test(p));
      } else if (r.selectedProjects === null) {
        next.selectedProjects = null;
      }
      // Lista blanca de proyectos ofrecidos en los selectores (null = todos los del grupo).
      if (Array.isArray(r.visibleProjects)) {
        next.visibleProjects = r.visibleProjects.filter((p) => typeof p === "string" && projId.test(p));
      } else if (r.visibleProjects === null) {
        next.visibleProjects = null;
      }
      if (r.ouicare && typeof r.ouicare === "object") {
        const o = { ...current.releases.ouicare };
        if (typeof r.ouicare.projectPath === "string" && r.ouicare.projectPath.trim()) o.projectPath = r.ouicare.projectPath.trim();
        if (typeof r.ouicare.webConfigPath === "string" && r.ouicare.webConfigPath.trim()) o.webConfigPath = r.ouicare.webConfigPath.trim();
        if (typeof r.ouicare.appDateKey === "string" && r.ouicare.appDateKey.trim()) o.appDateKey = r.ouicare.appDateKey.trim();
        next.ouicare = o;
      }
      allowed.releases = next;
    }
    if (partial.local && typeof partial.local === "object") {
      const next = { ...current.local };
      // rootDir: ruta absoluta existente o null para limpiar. La validación real es que exista en disco.
      if (typeof partial.local.rootDir === "string" && partial.local.rootDir.trim()) {
        const p = partial.local.rootDir.trim();
        if (path.isAbsolute(p) && fs.existsSync(p)) next.rootDir = p;
      } else if (partial.local.rootDir === null) {
        next.rootDir = null;
      }
      allowed.local = next;
    }
    if (partial.environments && typeof partial.environments === "object") {
      const e = partial.environments;
      const next = { ...current.environments };
      const projId = /^[\w.-]+(\/[\w.-]+)*$/;
      if (Array.isArray(e.selectedProjects)) {
        next.selectedProjects = e.selectedProjects.filter((p) => typeof p === "string" && projId.test(p));
      } else if (e.selectedProjects === null) {
        next.selectedProjects = null;
      }
      // Rutas de sonda y textos esperados: mapa proyecto → string. Descartamos claves que no sean
      // paths de proyecto para que el renderer no pueda meter basura en el config.
      for (const key of ["healthPaths", "healthExpect"]) {
        if (!e[key] || typeof e[key] !== "object") continue;
        const map = {};
        for (const [proj, val] of Object.entries(e[key])) {
          if (projId.test(proj) && typeof val === "string" && val.trim()) map[proj] = val.trim().slice(0, 300);
        }
        next[key] = map;
      }
      if (Number.isInteger(e.staleDays) && e.staleDays >= 1) next.staleDays = e.staleDays;
      allowed.environments = next;
    }
    if (partial.support && typeof partial.support === "object") {
      const next = { ...current.support };
      const pathRe = /^[\w.-]+(\/[\w.-]+)+$/;
      for (const k of ["incidencias", "operaciones"]) {
        const v = partial.support[k];
        if (typeof v === "string") next[k] = v.trim() && pathRe.test(v.trim()) ? v.trim() : "";
      }
      allowed.support = next;
    }
    const { token, ...rest } = config.save(allowed);
    return { ...rest, hasManualToken: Boolean(token) };
  });

  ipcMain.handle("repos:suggest", async () => gh().viewerRepos());

  // Trabajo local → GitLab (OPE-19). Lectura de repos locales bajo config.local.rootDir.
}

module.exports = { register };
