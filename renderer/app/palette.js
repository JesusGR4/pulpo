"use strict";

/* ============ paleta de comandos (⌘P) ============ */
// Índice único de TODO lo accionable de la app. Cada entrada es {group, label, hint, run}: el
// grupo solo agrupa visualmente y entra en el texto buscable. Añadir una acción a la app =
// añadir una línea aquí; no hace falta tocar el atajo ni el render.
//
// Las entradas se calculan en cada pulsación (no se cachean) porque casi todas dependen del
// estado vivo: PR abierta, apartados habilitados, repos configurados, proveedor.

/** PRs abiertas del bucket actual: saltar a su detalle por número o título. */
function paletteEntriesPRs() {
  return state.openPrs.map((pr) => ({
    group: t("Pull requests"),
    label: `#${pr.number} ${pr.title}`,
    hint: `${pr.headRefName} → ${pr.baseRefName}`,
    run: () => exitHistoryToPR(pr.number),
  }));
}

/**
 * Acciones sobre la PR abierta en el panel de detalle. Solo aparecen si hay detalle abierto y
 * respetan los MISMOS guards que los botones de renderDetail(): la paleta no es una puerta
 * trasera para hacer lo que la UI no deja.
 */
function paletteEntriesCurrentPR() {
  const pr = state.detailPR;
  if (!pr) return [];
  const group = t("PR #{n}", { n: pr.number });
  const entries = [];
  const add = (label, hint, run) => entries.push({ group, label, hint, run });
  const open = pr.state === "OPEN";
  const mine = pr.author?.login === state.me?.login;

  if (open) add(t("Abrir en Rider / VS Code"), t("worktree en la rama de la PR"), () => openPrInEditor(pr));
  if (canMerge(pr)) add(t("Merge (merge commit)"), t("pide confirmación"), () => confirmMerge(pr));
  if (open) add(t("Review con IA"), t("lanza /mr-review-gitlab en Ghostty, como en Agents"), () => launchAiReview(pr));
  if (open && mine) {
    add(
      pr.isDraft ? t("Marcar lista para review") : t("Convertir a borrador"),
      t("cambia el estado de la PR"),
      () => toggleDraftState(pr),
    );
  }
  if (pr.state === "MERGED") add(t("Revertir"), t("crea revert (PR en GitHub, commit en GitLab)"), () => revertPRModal(pr));

  if (state.drafts.length) {
    add(t("Publicar borradores"), t("{n} pendientes", { n: state.drafts.length }), () => openPublishModal());
    add(t("Ver borradores"), t("visor de borradores locales"), () => openDraftsViewer());
  }
  const glPending = state.conversation?.pendingDrafts || 0;
  if (glPending) add(t("Publicar en GitLab"), t("{n} pendientes", { n: glPending }), () => publishGitlabDrafts());

  const goTab = (tab) => () => { state.detailTab = tab; renderDetail(); };
  if (state.detailTab !== "conv") add(t("Ir a: Conversación"), t("pestaña del detalle"), goTab("conv"));
  if (state.detailTab !== "changes") add(t("Ir a: Cambios"), t("pestaña del detalle"), goTab("changes"));

  add(t("Copiar rama"), pr.headRefName, () => copyText(pr.headRefName));
  add(t("Copiar URL"), pr.url || "", () => copyText(pr.url));
  if (pr.url) add(t("Abrir en el navegador"), providerName(), () => window.monstro.openExternal(pr.url));
  add(t("Cerrar el detalle"), "Esc", closeDetail);
  return entries;
}

/** Apartados del menú lateral: la misma lista que MENU_SECTIONS, filtrada por sectionEnabled(). */
function paletteEntriesSections() {
  const group = t("Ir a");
  const entries = [];
  const add = (section, label, hint, run) => {
    if (sectionEnabled(section)) entries.push({ group, label: t("Ir a: {label}", { label }), hint, run });
  };
  add("historico", t("Grafo"), t("grafo de ramas"), enterHistory);
  add("milestones", t("Milestones"), t("tareas por persona"), () => enterMilestones("tasks"));
  add("milestones", t("Milestones · Resumen"), t("resumen del milestone"), () => enterMilestones("summary"));
  add("soporte", t("Incidencias"), t("incidencias del proyecto"), () => enterSupport("incidencias"));
  add("soporte", t("Ops"), t("operaciones del proyecto"), () => enterSupport("operaciones"));
  add("releases", t("Releases · Ramas"), t("generar release branches"), () => enterReleases("branches"));
  add("releases", t("Releases · Publicar"), t("crear tag + release"), () => enterReleases("publish"));
  add("releases", t("Releases · Pipelines"), t("estado de despliegue por proyecto"), () => enterReleases("pipelines"));
  add("entornos", t("Entornos"), t("salud de los entornos por proyecto"), () => enterEnvironments());
  add("validacion", t("Validación"), t("tablero de MRs: aprobar, probar en dev y validar"), () => enterValidation());
  add("local", t("Trabajo local · Empezar tarea"), t("elegir Epic/Issue → plan → agentes"), () => enterLocal("empezar"));
  add("local", t("Trabajo local · Crear tarea"), t("Issue/Epic + MR desde local"), () => enterLocal("crear"));
  add("local", t("Trabajo local · Vincular tarea"), t("vincular local a una tarea existente"), () => enterLocal("vincular"));
  add("local", t("Trabajo local · Histórico"), t("trabajos creados desde Monstro"), () => enterLocal("historico"));
  add("propuestas", t("Propuestas"), t("correos de propuestas → Epic"), () => enterProposals());
  add("usuarios", t("Usuarios"), t("usuarios de Cognito por email o id"), () => enterCognito());

  const bucketSection = (b) => (["merged", "closed"].includes(b) ? "historial" : "prs");
  const buckets = [
    ["open", t("Merge requests"), "1"],
    ["merged", t("Fusionadas"), "2"],
    ["closed", t("Cerradas"), "3"],
  ];
  for (const [bucket, label, key] of buckets) {
    add(bucketSection(bucket), label, key, () => switchBucket(bucket));
  }
  return entries;
}

/** Cambio de repositorio (incluida la vista agregada de todos). */
function paletteEntriesRepos() {
  const group = t("Repositorio");
  const repos = state.config?.repos || [];
  const entries = repos.length > 1
    ? [{ group, label: t("Repo: Todos los repos"), hint: t("vista agregada"), run: () => switchRepo(ALL_REPOS) }]
    : [];
  return entries.concat(
    repos.map((repo) => ({ group, label: t("Repo: {repo}", { repo }), hint: t("cambiar repositorio"), run: () => switchRepo(repo) })),
  );
}

/** Comprueba si hay versión nueva y lo cuenta por toast (la versión larga vive en Ajustes). */
async function paletteCheckUpdates() {
  toast(t("Comprobando actualizaciones…"));
  try {
    const r = await window.monstro.checkUpdates();
    if (r.error) return toast(t("No se pudo comprobar: {detail}", { detail: r.error }), "err");
    if (r.newer) return toast(t("Hay una versión nueva: {v}", { v: `v${r.latest}` }), "ok", () => window.monstro.openExternal(r.url));
    toast(t("Ya tienes la última versión (v{v})", { v: r.latest || r.current }), "ok");
  } catch (err) {
    toast(t("No se pudo comprobar: {detail}", { detail: String(err.message || err) }), "err");
  }
}

/** Ajustes de aplicación que ya existen en la pantalla de Ajustes, accesibles sin abrirla. */
function paletteEntriesApp() {
  const group = t("Aplicación");
  const entries = [];
  const add = (label, hint, run) => entries.push({ group, label, hint, run });
  add(t("Refrescar"), "R", refresh);
  add(t("Filtrar la lista"), t("foco en el buscador"), () => $("#search").focus());
  add(t("Ajustes"), t("configuración de la app"), openSettings);
  add(t("Atajos de teclado"), "?", openCheatsheet);
  add(t("Buscar actualizaciones"), t("comprueba si hay versión nueva"), paletteCheckUpdates);

  const setUiTheme = (uiTheme) => async () => {
    state.config = await window.monstro.setConfig({ uiTheme });
    applyUiTheme(uiTheme);
  };
  const uiTheme = state.config?.uiTheme || "default";
  if (uiTheme !== "default") add(t("Tema: Por defecto"), t("aspecto de la interfaz"), setUiTheme("default"));
  if (uiTheme !== "liquid-glass") add(t("Tema: Liquid Glass"), t("aspecto de la interfaz"), setUiTheme("liquid-glass"));

  const lang = currentLang();
  if (lang !== "es") add(t("Idioma: Español"), t("idioma de la interfaz"), () => setLanguage("es"));
  if (lang !== "en") add(t("Idioma: English"), t("idioma de la interfaz"), () => setLanguage("en"));
  return entries;
}

// Con 50 PRs abiertas, cualquier texto corto ("ir", "re") matchea decenas de títulos y las
// acciones quedarían enterradas fuera del listado. Las PRs entran capadas; las acciones, todas:
// para llegar a una PR concreta se afina con el número, para llegar a una acción no siempre se
// sabe su nombre exacto.
const PALETTE_MAX_PRS = 6;

/** Entradas que pasan el filtro, con las PRs capadas y en orden estable de grupos. */
function paletteEntries(query = "") {
  const q = query.trim().toLowerCase();
  const matches = (e) => !q || `${e.group} ${e.label} ${e.hint}`.toLowerCase().includes(q);
  return [
    ...paletteEntriesCurrentPR().filter(matches),
    ...paletteEntriesPRs().filter(matches).slice(0, PALETTE_MAX_PRS),
    ...paletteEntriesSections().filter(matches),
    ...paletteEntriesRepos().filter(matches),
    ...paletteEntriesApp().filter(matches),
  ];
}

function openPalette() {
  const root = $("#modal-root");
  let results = [];
  let cursor = 0;
  root.innerHTML = `
    <div class="modal-backdrop" id="palette-backdrop">
      <div class="palette">
        <input type="text" id="palette-input" placeholder="${esc(t("Busca PRs, apartados o acciones…  (Esc para cerrar)"))}" autocomplete="off" />
        <div id="palette-results"></div>
      </div>
    </div>`;
  const input = $("#palette-input");
  const resultsBox = $("#palette-results");

  const renderResults = () => {
    // El grupo entra en el texto buscable: "repo" saca los repos, "pr" las acciones de la PR abierta.
    results = paletteEntries(input.value);
    cursor = Math.min(cursor, Math.max(0, results.length - 1));
    let lastGroup = null;
    resultsBox.innerHTML = results
      .map((e, i) => {
        const header = e.group === lastGroup ? "" : `<div class="palette-group">${esc(e.group)}</div>`;
        lastGroup = e.group;
        return `${header}<div class="palette-item ${i === cursor ? "active" : ""}" data-i="${i}">
          <span>${esc(e.label)}</span><span class="muted">${esc(e.hint)}</span>
        </div>`;
      })
      .join("") || `<div class="palette-item muted">${esc(t("Sin resultados"))}</div>`;
    resultsBox.querySelectorAll(".palette-item[data-i]").forEach((el) =>
      el.addEventListener("click", () => {
        root.innerHTML = "";
        results[Number(el.dataset.i)]?.run();
      }),
    );
    resultsBox.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", () => { cursor = 0; renderResults(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { cursor = Math.min(cursor + 1, results.length - 1); renderResults(); event.preventDefault(); }
    if (event.key === "ArrowUp") { cursor = Math.max(cursor - 1, 0); renderResults(); event.preventDefault(); }
    if (event.key === "Enter") { const entry = results[cursor]; root.innerHTML = ""; entry?.run(); }
    if (event.key === "Escape") root.innerHTML = "";
  });
  $("#palette-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "palette-backdrop") root.innerHTML = "";
  });
  renderResults();
  input.focus();
}
