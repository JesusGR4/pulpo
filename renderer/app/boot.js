"use strict";

function renderRepoSelect() {
  const select = $("#repo-select");
  const repos = state.config?.repos || [];
  select.hidden = repos.length < 2; // con un solo repo no hay nada que elegir
  const allOption = repos.length > 1
    ? `<option value="${ALL_REPOS}" ${state.repo === ALL_REPOS ? "selected" : ""}>${t("Todos los repos")}</option>`
    : "";
  select.innerHTML = allOption + repos
    .map((r) => `<option value="${esc(r)}" ${r === state.repo ? "selected" : ""}>${esc(r)}</option>`)
    .join("");
}

/** Aplica el tema de sintaxis al <body> (lo consume css/prs.css vía [data-syntax-theme]). */
function applyTheme(theme) {
  document.body.dataset.syntaxTheme = theme || "one-dark";
}

/** Aplica el tema visual de interfaz al <body> (lo consume css/theme-glass.css vía [data-ui-theme]). */
function applyUiTheme(uiTheme) {
  document.body.dataset.uiTheme = uiTheme || "default";
}

let updating = false;
/**
 * Actualiza la app al pulsar el toast de versión nueva. Lo que pasa después depende de la
 * plataforma y lo decide `src/updater.js`: en Windows instala y reinicia, en macOS baja el .dmg,
 * lo abre y CIERRA la app (la firma ad-hoc impide el update in-place, y con Monstro abierta macOS
 * no deja arrastrarla a Aplicaciones — el porqué está en ese módulo).
 */
async function startUpdate(info) {
  if (updating) return; // el toast vive 9s: clicks de más no lanzan otra descarga
  updating = true;
  const label = (extra = "") => t("Descargando v{v}…{extra}", { v: info.latest, extra });
  const el = toast(label(), "", null, true);
  const off = window.monstro.onUpdateProgress((p) => {
    el.textContent = label(` ${p}%`);
  });
  try {
    const r = await window.monstro.installUpdate();
    if (!r?.ok) throw new Error(r.error || t("error desconocido"));
    el.remove();
    if (r.mode === "restart") toast(t("Actualizada — reiniciando…"), "ok");
    else if (r.mode === "dmg") toast(t("v{v} descargada — cerrando Monstro, arrástrala a Aplicaciones", { v: info.latest }), "ok");
  } catch (err) {
    el.remove();
    // Con enlace a la release: si la descarga falla, al menos que pueda bajarla a mano.
    toast(t("No se pudo actualizar: {e}", { e: String(err.message || err) }), "err", () => window.monstro.openExternal(info.url));
  } finally {
    off();
    updating = false;
  }
}

const SPLASH_AT = Date.now();
function hideSplash() {
  const el = document.getElementById("splash");
  if (!el || el.dataset.hiding) return;
  el.dataset.hiding = "1";
  // Garantiza un mínimo visible para que se aprecie la animación, sin alargar arranques lentos.
  const wait = Math.max(0, 750 - (Date.now() - SPLASH_AT));
  setTimeout(() => {
    el.classList.add("splash-out");
    setTimeout(() => el.remove(), 500);
  }, wait);
}
// Red de seguridad: si el arranque se cuelga (p. ej. red caída), no dejes al usuario atrapado tras el splash.
setTimeout(hideSplash, 8000);

async function boot() {
  // Solo macOS reserva el hueco de los traffic lights; en Windows/Linux se oculta vía CSS.
  document.body.classList.toggle("is-mac", window.monstro.platform === "darwin");
  // Marca del topbar = mascota (icono del dock) + nombre. Inyectada aquí para no duplicar el SVG.
  const brand = document.querySelector(".brand");
  if (brand) brand.innerHTML = `${mascot(22)} <strong>Monstro</strong>`;
  // Ruta dedicada para capturar el propio splash (lo deja visible y termina ahí).
  if (IS_SELFTEST && SELFTEST_ROUTE === "splash") {
    const splashCfg = await window.monstro.getConfig();
    applyTheme(splashCfg.theme);
    applyUiTheme(splashCfg.uiTheme);
    notifySelftestOnce();
    return;
  }
  // En el resto del selftest el splash taparía la captura: fuera de inmediato, sin fundido.
  if (IS_SELFTEST) document.getElementById("splash")?.remove();
  state.config = await window.monstro.getConfig();
  applyTheme(state.config.theme);
  applyUiTheme(state.config.uiTheme);
  // Idioma (ES por defecto / del sistema): fija LANG y traduce el chrome estático del index.html.
  applyLang(state.config);
  localizeStatic();
  // Rutas de captura de las pantallas de onboarding (no dependen de tener token/repos reales).
  if (IS_SELFTEST && SELFTEST_ROUTE === "onboarding-token") { document.getElementById("splash")?.remove(); await renderWelcome(); notifySelftestOnce(); return; }
  if (IS_SELFTEST && SELFTEST_ROUTE === "onboarding-sections") { document.getElementById("splash")?.remove(); await renderSectionPicker(); return; }
  // Instalación nueva (sin proveedor ni repos): primero elegimos GitHub o GitLab.
  // Los instalados de antes (con repos pero sin provider) siguen en GitHub por defecto.
  if (!state.config.provider && !state.config.repos.length) {
    await renderProviderChooser();
    hideSplash();
    return;
  }
  const remembered = state.config.lastRepo;
  state.repo =
    (state.repo && state.config.repos.includes(state.repo) && state.repo) ||
    (remembered === ALL_REPOS && state.config.repos.length > 1 && ALL_REPOS) ||
    (state.config.repos.includes(remembered) && remembered) ||
    (state.config.repos.length > 1 ? ALL_REPOS : state.config.repos[0]) ||
    null;
  // Instalaciones antiguas pueden recordar un bucket ya eliminado (mine/review/draft): esos caen en "open".
  const lastBucket = state.config.lastBucket;
  if (lastBucket && !IS_SELFTEST) state.bucket = ["merged", "closed"].includes(lastBucket) ? lastBucket : "open";
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  document.querySelector(`[data-bucket="${state.bucket}"]`)?.classList.add("active");
  state.draftKeys = new Set(await window.monstro.draftsKeys().catch(() => []));
  renderRepoSelect();
  // Visibilidad del menú: oculta lo que no aplica al proveedor (GitLab-only) y lo que el usuario no eligió.
  applyMenuVisibility();

  const auth = await window.monstro.authStatus();
  state.authSource = auth.source;
  if (auth.ok) {
    state.me = { login: auth.login, avatarUrl: auth.avatarUrl };
    $("#me").innerHTML = `<img src="${esc(auth.avatarUrl)}" alt="" /> ${esc(auth.login)}`;
  } else {
    $("#me").innerHTML = "";
    await renderWelcome();
    notifySelftestOnce();
    hideSplash();
    return;
  }
  if (!state.config.repos.length) {
    await renderRepoPicker();
    hideSplash();
    return;
  }
  // Último paso del onboarding: elegir qué apartados del menú incluir (null = aún no preguntado).
  if (state.config.sections == null && !IS_SELFTEST) {
    await renderSectionPicker();
    hideSplash();
    return;
  }
  // Si la sección del bucket activo está deshabilitada (p. ej. un perfil de operaciones sin PRs),
  // aterriza en el primer apartado disponible en vez de pintar una lista de PRs oculta.
  const activeSection = ["merged", "closed"].includes(state.bucket) ? "historial" : "prs";
  if (!sectionEnabled(activeSection)) {
    const landing = firstAvailableLanding();
    if (landing) {
      hideSplash();
      schedulePoll();
      landing();
      return;
    }
  }
  await refresh();
  hideSplash();
  schedulePoll();
  initSessions();
  // Aviso de versión nueva al arrancar. Click en el toast → actualiza (ver startUpdate).
  if (!IS_SELFTEST && state.config.checkUpdates) {
    window.monstro.checkUpdates().then((r) => {
      if (r?.newer) toast(t("Versión nueva disponible: v{v} — pulsa para actualizar", { v: r.latest }), "ok", () => startUpdate(r));
    }).catch(() => {});
  }
  if (IS_SELFTEST && SELFTEST_ROUTE === "history") enterHistory();
  if (IS_SELFTEST && SELFTEST_ROUTE === "merged") switchBucket("merged");
  if (IS_SELFTEST && SELFTEST_ROUTE === "milestones") enterMilestones("tasks");
  if (IS_SELFTEST && SELFTEST_ROUTE === "support") enterSupport("incidencias");
  if (IS_SELFTEST && SELFTEST_ROUTE === "ops") enterSupport("operaciones");
  if (IS_SELFTEST && SELFTEST_ROUTE === "milestones-summary") runMilestonesSummarySelftest();
  if (IS_SELFTEST && SELFTEST_ROUTE === "releases") enterReleases();
  if (IS_SELFTEST && SELFTEST_ROUTE === "releases-publish") enterReleases("publish");
  if (IS_SELFTEST && SELFTEST_ROUTE === "releases-pipelines") enterReleases("pipelines");
  if (IS_SELFTEST && SELFTEST_ROUTE === "entornos") enterEnvironments();
  if (IS_SELFTEST && SELFTEST_ROUTE.startsWith("validacion")) {
    // `validacion-detail` abre el panel de la tarjeta con más MRs.
    state.validation.selftestDetail = SELFTEST_ROUTE === "validacion-detail";
    enterValidation();
  }
  if (IS_SELFTEST && SELFTEST_ROUTE.startsWith("usuarios")) {
    // `usuarios-q:<texto>` entra ya buscando ese texto.
    state.cognito.q = SELFTEST_ROUTE.startsWith("usuarios-q:") ? SELFTEST_ROUTE.slice("usuarios-q:".length) : "";
    enterCognito();
  }
  if (IS_SELFTEST && SELFTEST_ROUTE === "propuestas") enterProposals();
  if (IS_SELFTEST && SELFTEST_ROUTE.startsWith("palette")) {
    openPalette();
    // `palette-q:<texto>` abre la paleta ya filtrada, para capturar grupos que no caben arriba.
    const query = SELFTEST_ROUTE.startsWith("palette-q:") ? SELFTEST_ROUTE.slice("palette-q:".length) : "";
    if (query) {
      $("#palette-input").value = query;
      $("#palette-input").dispatchEvent(new Event("input"));
    }
  }
  if (IS_SELFTEST && SELFTEST_ROUTE.startsWith("ajustes")) {
    openSettings();
    // La tarjeta de la bandeja queda muy por debajo del viewport y la captura solo ve lo visible.
    if (SELFTEST_ROUTE === "ajustes-propuestas") {
      $(".mail-help")?.setAttribute("open", "");
      $(".mail-help")?.scrollIntoView({ block: "center" });
    }
    // Los toggles se pintan tras openSettings(), así que hay que esperar al frame siguiente.
    if (SELFTEST_ROUTE === "ajustes-secciones") {
      requestAnimationFrame(() => $("#settings-sections")?.lastElementChild?.scrollIntoView({ block: "center" }));
    }
  }
  if (IS_SELFTEST && SELFTEST_ROUTE === "local") runLocalSelftest();
  if (IS_SELFTEST && SELFTEST_ROUTE === "local-vincular") runLocalLinkSelftest();
  if (IS_SELFTEST && (SELFTEST_ROUTE === "local-historico" || SELFTEST_ROUTE === "local-historico-detail")) runLocalHistorySelftest();
  if (IS_SELFTEST && SELFTEST_ROUTE === "local-list") runLocalListSelftest();
  if (IS_SELFTEST && SELFTEST_ROUTE === "sessions") runSessionsSelftest();
  if (IS_SELFTEST && SELFTEST_ROUTE.startsWith("sessions-q:")) runSessionsSelftest(SELFTEST_ROUTE.slice("sessions-q:".length));
  if (IS_SELFTEST && SELFTEST_ROUTE === "sessions-mr") runSessionsMrSelftest();
  // `sessions-view[:<texto>][#summary|plan|changes]`
  if (IS_SELFTEST && /^sessions-view([:#]|$)/.test(SELFTEST_ROUTE)) runSessionsViewSelftest(SELFTEST_ROUTE.slice("sessions-view".length));
  if (IS_SELFTEST && SELFTEST_ROUTE === "sessions-launch") runSessionsLaunchSelftest();
  if (IS_SELFTEST && SELFTEST_ROUTE === "sessions-implement") runSessionsImplementSelftest();
  if (IS_SELFTEST && (SELFTEST_ROUTE === "local-empezar" || SELFTEST_ROUTE === "local-plan")) runLocalStartSelftest();
  if (IS_SELFTEST && SELFTEST_ROUTE === "local-agents") runLocalAgentsSelftest();
}

// Selftest del listado agrupado: entra en Crear y deja la lista (repos agrupados por repo base) visible.
async function runLocalListSelftest() {
  state.selftestNotified = true;
  try {
    await enterLocal("crear");
    const gl = (state.local.repos || []).filter((r) => r.gitlabPath).slice(0, 1);
    gl.forEach((r) => state.local.selected.add(r.dir));
    renderLocal();
  } catch (err) {
    console.error("[selftest] local-list failed:", err);
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce();
  }
}

// Selftest del histórico: siembra entradas de ejemplo (no toca disco) para capturar la vista.
async function runLocalHistorySelftest() {
  state.selftestNotified = true;
  try {
    await enterLocal("historico");
    const base = "https://gitlab.openhealth.es";
    state.local.history = [
      { id: "s1", ts: new Date().toISOString(), kind: "tarea", title: "Exportar pedidos a CSV", projectPath: "OpenSaludGroup/dashboard",
        issue: { iid: 142, projectPath: "OpenSaludGroup/dashboard", url: `${base}/OpenSaludGroup/dashboard/-/issues/142`, title: "Exportar pedidos a CSV" },
        mr: { number: 318, projectPath: "OpenSaludGroup/dashboard", url: `${base}/OpenSaludGroup/dashboard/-/merge_requests/318` },
        commit: { sha: "a1b2c3d4e5f6", url: `${base}/OpenSaludGroup/dashboard/-/commit/a1b2c3d4e5f6` },
        steps: [{ ok: true, text: "Rama feature creada: feature/exportar-pedidos" }, { ok: true, text: 'Commit creado: a1b2c3d4 — "Añade exportación de pedidos"' }, { ok: true, text: "Push de feature/exportar-pedidos a origin: ok" }] },
      { id: "s2", ts: new Date(Date.now() - 3600e3).toISOString(), kind: "epic", title: "Unificar autenticación SSO",
        epic: { iid: 27, url: `${base}/OpenSaludGroup/epics/-/issues/27`, title: "Unificar autenticación SSO" },
        results: [
          { ok: true, projectPath: "OpenSaludGroup/dashboard", task: { iid: 143, url: `${base}/OpenSaludGroup/dashboard/-/issues/143` }, mr: { number: 319, url: `${base}/OpenSaludGroup/dashboard/-/merge_requests/319` }, commit: { sha: "bb22cc33", url: `${base}/x/-/commit/bb22cc33` },
            steps: [{ ok: true, text: "Commit creado: bb22cc33 — \"Integra SSO\"" }, { ok: true, text: "Push de development a origin: ok" }] },
          { ok: false, projectPath: "libraries/JWTToken", error: "push rechazado: la rama development está protegida" },
        ] },
      { id: "s3", ts: new Date(Date.now() - 86400e3).toISOString(), kind: "vincular", title: "Corrige caché de catálogo",
        issue: { iid: 90, projectPath: "OpenSaludGroup/dashboard", isEpic: false, url: `${base}/OpenSaludGroup/dashboard/-/issues/90`, title: "Corrige caché de catálogo" },
        results: [{ ok: true, projectPath: "OpenSaludGroup/dashboard", mr: { number: 320, url: `${base}/OpenSaludGroup/dashboard/-/merge_requests/320` }, commit: null,
          steps: [{ ok: true, text: "Sin cambios locales que commitear" }, { ok: true, text: "Push de fix/cache a origin: ok" }] }] },
    ];
    state.local.historyStatus = {
      "mr:OpenSaludGroup/dashboard#318": { state: "merged", merged: true },
      "issue:OpenSaludGroup/dashboard#142": { state: "opened", closed: false, labels: ["finished"] },
      "mr:OpenSaludGroup/dashboard#319": { state: "opened", merged: false },
      "issue:OpenSaludGroup/dashboard#143": { state: "opened", closed: false, labels: ["pending check"] },
      "mr:OpenSaludGroup/dashboard#320": { state: "merged", merged: true },
      "issue:OpenSaludGroup/dashboard#90": { state: "closed", closed: true, labels: [] },
    };
    if (SELFTEST_ROUTE === "local-historico-detail") state.local.historyDetail = state.local.history[1]; // la epic con un fallo
    renderLocal();
  } catch (err) {
    console.error("[selftest] local-historico failed:", err);
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce();
  }
}

// Selftest del flujo Vincular: abre la pestaña y el formulario con 2 proyectos (sin buscar/crear nada).
async function runLocalLinkSelftest() {
  state.selftestNotified = true;
  try {
    await enterLocal("vincular");
    const gl = (state.local.repos || []).filter((r) => r.gitlabPath).slice(0, 2);
    if (gl.length) openLocalLinkForm(gl.map((r) => r.dir));
  } catch (err) {
    console.error("[selftest] local-vincular failed:", err);
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce();
  }
}

// Selftest de Trabajo local: abre la pestaña Crear y el formulario del primer repo casado, para
// capturar el form (no dispara IA ni creación real). Suprime el notify temprano hasta tenerlo pintado.
async function runLocalSelftest() {
  state.selftestNotified = true;
  try {
    await enterLocal("crear");
    // Dos proyectos casados → captura el formulario de Epic (lo nuevo de la Fase 3).
    const gl = (state.local.repos || []).filter((r) => r.gitlabPath).slice(0, 2);
    if (gl.length >= 2) openLocalForm(gl.map((r) => r.dir));
    else if (gl.length === 1) openLocalForm(gl[0].dir);
    // Siembra markdown en la 1ª descripción y abre "Vista previa" para que la captura muestre el preview.
    const ta = list.querySelector("#lf-desc-0");
    if (ta) {
      ta.value = "## Propósito\nPermitir **exportar pedidos** a CSV desde el panel de administración.\n\n- Expone el endpoint `GET /pedidos/export`\n- [ ] Verificar permisos del usuario";
      ta.closest(".md-field")?.querySelector('.md-tab[data-tab="preview"]')?.click();
    }
    // Marca un par de etiquetas y lleva la sección de meta a la vista para la captura.
    if (state.local.form) { state.local.form.labels = new Set(["professional user", "high priority"]); state.local.form.milestoneId = 55; renderLocal(); }
    list.querySelector(".lf-meta")?.scrollIntoView({ block: "center" });
  } catch (err) {
    console.error("[selftest] local failed:", err);
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce();
  }
}

// Selftest de "Empezar tarea" (OPE-20): siembra tareas de ejemplo (sin red) y pinta el picker; en la
// ruta local-plan abre el form y siembra un plan ya generado. No dispara IA ni creación real.
async function runLocalStartSelftest() {
  state.selftestNotified = true;
  try {
    state.view = "local";
    state.local.tab = "empezar";
    document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
    $("#bucket-local-empezar")?.classList.add("active");
    try { const { rootDir, repos } = await window.monstro.localRepos(); state.local.rootDir = rootDir || "~/repositories"; state.local.repos = repos || []; }
    catch { state.local.rootDir = "~/repositories"; state.local.repos = []; }
    const base = "https://gitlab.openhealth.es";
    state.local.tasks = [
      { iid: 142, projectPath: "OpenSaludGroup/dashboard", title: "Exportar pedidos a CSV", description: "Permitir exportar el listado de pedidos a CSV desde el panel.", url: `${base}/OpenSaludGroup/dashboard/-/issues/142`, isEpic: false, labels: ["professional user", "high priority"], priority: 0 },
      { iid: 27, projectPath: "OpenSaludGroup/epics", title: "Unificar autenticación SSO", description: "Unificar el login SSO entre el dashboard y las apps de cliente.", url: `${base}/OpenSaludGroup/epics/-/issues/27`, isEpic: true, labels: ["medium priority"], priority: 1 },
      { iid: 90, projectPath: "OpenSaludGroup/dashboard", title: "Corrige caché de catálogo", description: "El catálogo no se invalida al cambiar precios.", url: `${base}/OpenSaludGroup/dashboard/-/issues/90`, isEpic: false, labels: ["low priority"], priority: 2 },
    ];
    state.local.tasksLoading = false;
    if (SELFTEST_ROUTE === "local-plan") {
      // Siembra repos locales + remotos seleccionables para que el mapeo plan→repo tenga opciones.
      state.config = { ...(state.config || {}), repos: ["OpenSaludGroup/dashboard", "OpenSaludGroup/mobile"] };
      state.local.repos = [
        { name: "dashboard", dir: "/r/dashboard", remote: "x", gitlabPath: "OpenSaludGroup/dashboard" },
        { name: "mobile", dir: "/r/mobile", remote: "x", gitlabPath: "OpenSaludGroup/mobile" },
      ];
      await openLocalPlanForm(state.local.tasks[1]); // la Epic SSO
      const pf = state.local.planForm;
      if (pf) {
        pf.indications = "Mantener compatibilidad con los tokens actuales.";
        pf.plan = {
          objectives: ["Login SSO único entre dashboard y apps de cliente", "No romper sesiones activas"],
          requirements: ["Mismo proveedor OIDC en todos los proyectos", "Refresco de token transparente"],
          tests: ["Login desde dashboard propaga sesión a la app de cliente", "Token caducado se refresca sin re-login"],
          projects: [
            { name: "OpenSaludGroup/dashboard", tasks: ["Integrar cliente OIDC", "Exponer endpoint de refresco"] },
            { name: "Frontend de citas (petición de consulta)", tasks: ["Consumir el SSO del dashboard", "Persistir el refresh token de forma segura"] },
          ],
          model: "claude-opus-4-8", effort: "max", backend: "anthropic-sdk",
        };
        renderLocal();
      }
    } else {
      renderLocal();
    }
  } catch (err) {
    console.error("[selftest] local-empezar failed:", err);
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce();
  }
}

// Selftest de la vista del run en vivo (fase 3): siembra un run con timeline de ejemplo (sin lanzar
// agentes reales) y lo pinta, para capturar la línea de tiempo + estados + acciones.
async function runLocalAgentsSelftest() {
  state.selftestNotified = true;
  try {
    state.view = "local";
    state.local.tab = "empezar";
    document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
    $("#bucket-local-empezar")?.classList.add("active");
    const t = (k, text, extra) => ({ kind: k, text, ts: Date.now(), ...extra });
    state.local.runView = {
      id: "run-demo", title: "Unificar autenticación SSO", url: "https://gitlab.openhealth.es/OpenSaludGroup/epics/-/issues/27", isEpic: true, status: "failed",
      projects: [
        { dir: "/r/dashboard", name: "OpenSaludGroup/dashboard", gitlabPath: "OpenSaludGroup/dashboard", model: "claude-opus-4-8", effort: "high", rationale: "Cambio central y delicado en el login.", branch: "feat/unificar-autenticacion-sso", worktree: "/r/dashboard/.worktrees/unificar-sso-abc", status: "failed", error: "claude salió con código 1: Input must be provided either through stdin or as a prompt argument", pending: 0, timeline: [
          t("say", "Reviso cómo está montado el login actual."),
          t("tool", "Lee auth/login.service.ts"),
          t("result", "El agente falló al arrancar.", { ok: false }),
        ] },
        { dir: "/r/mobile", name: "OpenSaludGroup/mobile", gitlabPath: "OpenSaludGroup/mobile", model: "claude-sonnet-4-6", effort: "medium", rationale: "Integración acotada, no necesita Opus.", branch: "feat/unificar-autenticacion-sso", worktree: "/r/mobile/.worktrees/unificar-sso-def", status: "done", pending: 0, finalized: true, mr: { number: 321, projectPath: "OpenSaludGroup/mobile", url: "https://gitlab.openhealth.es/OpenSaludGroup/mobile/-/merge_requests/321" }, timeline: [
          t("tool", "Lee src/auth/store.ts"),
          t("tool", "Edit src/auth/sso.ts"),
          t("tool", "Ejecuta: npm test"),
          t("result", "Integración del SSO del dashboard completada y commiteada.", { ok: true }),
        ] },
      ],
    };
    state.local.mrStatuses = { "/r/mobile": { state: "merged", merged: true } };
    renderLocal();
  } catch (err) {
    console.error("[selftest] local-agents failed:", err);
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce();
  }
}

// Selftest E2E del resumen: abre Milestones · Resumen, dispara la generación con IA (real) y solo
// captura cuando termina. Bloquea el notify automático de renderMilestones poniendo
// selftestNotified=true hasta que el resumen está pintado.
async function runMilestonesSummarySelftest() {
  state.selftestNotified = true; // suprime el notify temprano del board/loading
  try {
    await enterMilestones("summary");
    const m = state.milestones;
    await ensureProjects(); // iconos de proyecto listos para la captura
    // Reutiliza el resumen ya persistido si existe (no re-gasta tokens al repetir el selftest).
    if (m.selectedTitle && !loadSummary(m.selectedTitle)) await generateMilestoneSummary(m.selectedTitle);
    renderMilestones();
    // Lleva el inicio del resumen (cabecera + filtro de proyectos + primeras filas) al viewport.
    list.querySelector(".ms-summary")?.scrollIntoView({ block: "start" });
  } catch (err) {
    console.error("[selftest] summary failed:", err);
  } finally {
    state.selftestNotified = false;
    notifySelftestOnce(); // captura pase lo que pase
  }
}

$("#refresh").addEventListener("click", refresh);
$("#settings-btn").addEventListener("click", openSettings);
$("#repo-select").addEventListener("change", (event) => {
  if (event.target.value === ALL_REPOS && state.view === "history") {
    state.view = "prs";
    document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
    document.querySelector('[data-bucket="open"]')?.classList.add("active");
    state.bucket = "open";
  }
  switchRepo(event.target.value);
});
$("#search").addEventListener("input", (event) => {
  state.search = event.target.value;
  if (state.view === "milestones") renderMilestones();
  else if (["releases", "local", "support", "environments", "cognito", "validation"].includes(state.view)) {/* estas vistas no usan el buscador global */}
  else renderList();
});
document.querySelectorAll(".bucket[data-bucket]").forEach((btn) =>
  btn.addEventListener("click", () => switchBucket(btn.dataset.bucket)),
);
$("#bucket-history").addEventListener("click", enterHistory);
$("#bucket-milestones").addEventListener("click", () => enterMilestones("tasks"));
$("#bucket-milestones-summary").addEventListener("click", () => enterMilestones("summary"));
$("#bucket-entornos").addEventListener("click", () => enterEnvironments());
$("#bucket-validacion").addEventListener("click", () => enterValidation());
$("#bucket-usuarios").addEventListener("click", () => enterCognito());
$("#bucket-propuestas").addEventListener("click", () => enterProposals());
$("#bucket-support").addEventListener("click", () => enterSupport("incidencias"));
$("#bucket-ops").addEventListener("click", () => enterSupport("operaciones"));
$("#bucket-releases").addEventListener("click", () => enterReleases("branches"));
$("#bucket-releases-publish").addEventListener("click", () => enterReleases("publish"));
$("#bucket-releases-pipelines").addEventListener("click", () => enterReleases("pipelines"));
if (window.monstro.onAgentEvent) wireAgentEvents();
$("#bucket-local-empezar").addEventListener("click", () => enterLocal("empezar"));
$("#bucket-local-crear").addEventListener("click", () => enterLocal("crear"));
$("#bucket-local-vincular").addEventListener("click", () => enterLocal("vincular"));
$("#bucket-local-historico").addEventListener("click", () => enterLocal("historico"));

// Primer apartado habilitado (en orden de menú) y su acción de entrada. Para aterrizar cuando el
// apartado por defecto (PRs) está oculto por la configuración del usuario.
function firstAvailableLanding() {
  const order = [
    ["prs", () => switchBucket("open")],
    ["historial", () => switchBucket("merged")],
    ["historico", () => enterHistory()],
    ["milestones", () => enterMilestones("tasks")],
    ["soporte", () => enterSupport("incidencias")],
    ["releases", () => enterReleases("branches")],
    ["entornos", () => enterEnvironments()],
    ["validacion", () => enterValidation()],
    ["local", () => enterLocal("empezar")],
    ["propuestas", () => enterProposals()],
    ["usuarios", () => enterCognito()],
  ];
  const found = order.find(([key]) => sectionEnabled(key));
  return found ? found[1] : null;
}

function switchBucket(bucket) {
  state.view = "prs";
  state.bucket = bucket;
  if (!IS_SELFTEST) window.monstro.setConfig({ lastBucket: bucket }).catch(() => {});
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  document.querySelector(`[data-bucket="${bucket}"]`)?.classList.add("active");
  closeDetail();
  refresh();
}

function switchRepo(repo) {
  state.repo = repo;
  if (!IS_SELFTEST) window.monstro.setConfig({ lastRepo: repo }).catch(() => {});
  state.openPrs = [];
  state.prSnapshot = null;
  state.history = { branches: [], enabled: new Set(), layout: null, rows: [], loading: false, selectedOid: null };
  renderRepoSelect();
  closeDetail();
  if (state.view === "history") loadHistory();
  // Milestones, Releases, Soporte y Trabajo local son de grupo/proyecto fijo, no por repo: el cambio no las afecta.
  else if (!["milestones", "releases", "local", "support", "environments", "validation"].includes(state.view)) refresh();
}

/* ============ atajos de teclado ============ */
function visiblePRRows() {
  return [...list.querySelectorAll(".pr-row")];
}

function moveCursor(delta) {
  const rows = visiblePRRows();
  if (!rows.length) return;
  state.cursor = Math.max(0, Math.min(rows.length - 1, state.cursor + delta));
  rows.forEach((r, i) => r.classList.toggle("cursor", i === state.cursor));
  rows[state.cursor].scrollIntoView({ block: "nearest" });
}

function openCheatsheet() {
  const root = $("#modal-root");
  const rows = [
    ["⌘P", t("Paleta de comandos: todas las acciones de la app")],
    ["j / k", t("Moverse por la lista")],
    ["Enter", t("Abrir la PR seleccionada")],
    ["1 – 3", t("Merge requests · Fusionadas · Cerradas")],
    ["h", t("Histórico (grafo de ramas)")],
    ["m", t("Milestones (tareas por persona · GitLab)")],
    ["r", t("Refrescar")],
    ["Esc", t("Cerrar el panel")],
    ["?", t("Esta chuleta")],
  ];
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${icon("keyboard")} ${esc(t("Atajos de teclado"))}</h3>
        <table class="cheatsheet">${rows.map(([key, what]) => `<tr><td><kbd>${key}</kbd></td><td>${esc(what)}</td></tr>`).join("")}</table>
        <div class="modal-actions"><button class="btn" id="modal-cancel">${esc(t("Cerrar"))}</button></div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
}

document.addEventListener("keydown", (event) => {
  // ⌘P es el atajo oficial (⌘K se mantiene por costumbre). preventDefault también evita
  // que ⌘P abra el diálogo de impresión de Chromium.
  if ((event.metaKey || event.ctrlKey) && ["p", "k"].includes(event.key.toLowerCase())) {
    event.preventDefault();
    openPalette();
    return;
  }
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (typing) return;
  if (event.key === "?") return openCheatsheet();
  if (event.key === "Escape") return viewingId() ? hideDetail() : closeDetail(); // de la ficha, al tablero
  if (event.key === "r") return refresh();
  if (event.key === "j") return moveCursor(1);
  if (event.key === "k") return moveCursor(-1);
  if (event.key === "Enter" && state.view === "prs" && state.cursor >= 0) {
    const row = visiblePRRows()[state.cursor];
    if (row) openDetail(Number(row.dataset.number));
    return;
  }
  if (event.key === "h" && sectionEnabled("historico")) return enterHistory();
  if (event.key === "m" && sectionEnabled("milestones")) return enterMilestones();
  const bucketByDigit = { 1: "open", 2: "merged", 3: "closed" };
  const digitBucket = bucketByDigit[event.key];
  if (digitBucket && sectionEnabled(["merged", "closed"].includes(digitBucket) ? "historial" : "prs")) switchBucket(digitBucket);
});

boot();
