"use strict";

function cherryPickSettingsCard(cfg) {
  const cp = cfg.cherryPick || {};
  const branches = cp.branches || [];
  return `
    <div class="settings-card">
      <h4>${icon("cherry")} ${t("Cherry-pick de hotfix")}</h4>
      <p class="muted">${t("Las MR cuya rama origen empiece por el prefijo y vayan a la release branch ofrecen, tras el merge, replicar su contenido a otras ramas (te pregunta primero, nunca automático).")}</p>
      <div class="add-repo">
        <input type="text" id="cp-prefix" value="${esc(cp.prefix || "")}" placeholder="hotfix/" />
        <span class="muted" style="align-self:center">${t("prefijo de rama origen")}</span>
      </div>
      <label style="display:block;margin:8px 0">
        <input type="checkbox" id="cp-sibling" ${cp.siblingMx ? "checked" : ""} />
        ${t("Añadir también la rama hermana de la release branch destino (mx ⇄ sin mx)")}
      </label>
      <p class="muted">${t("Ramas destino fijas (además de la hermana -mx):")}</p>
      <div id="cp-branch-lines">
        ${branches.map((b) => `<div class="repo-line">${esc(b)} <button class="btn" data-cp-del="${esc(b)}">${t("Quitar")}</button></div>`).join("") || `<p class="muted">${t("— ninguna —")}</p>`}
      </div>
      <div class="add-repo">
        <input type="text" id="cp-new-branch" placeholder="development" />
        <button class="btn btn-accent" id="cp-add-branch">${t("Añadir rama")}</button>
      </div>
      <div class="add-repo">
        <button class="btn" id="cp-save">${t("Guardar prefijo y opción")}</button>
      </div>
    </div>`;
}

const THEMES = [
  { id: "one-dark", label: "One Dark Pro" },
  { id: "dracula", label: "Dracula" },
  { id: "github-light", label: "GitHub Light" },
];

/** Filas de muestra (con add/del/ctx) para previsualizar el tema de sintaxis en Ajustes. */
function themePreviewRows() {
  const hl = (code, family) =>
    window.monstroHL ? window.monstroHL.highlightLine(code, family) : esc(code);
  const rows = [
    { cls: "diff-ctx", sign: " ", fam: "c", code: `// Suma dos números y devuelve el total` },
    { cls: "diff-del", sign: "−", fam: "c", code: `function add(a, b) { return a - b; }` },
    { cls: "diff-add", sign: "+", fam: "c", code: `const add = (a, b) => a + b; // 42, "ok", true` },
    { cls: "diff-ctx", sign: " ", fam: "c", code: `class Calc extends Base { value = 3.14; }` },
    { cls: "diff-ctx", sign: " ", fam: "hash", code: `def total(items): return sum(items)  # Python` },
  ];
  return rows
    .map(
      (r) =>
        `<tr class="diff-line ${r.cls}"><td class="code"><span class="sign">${r.sign}</span>${hl(r.code, r.fam)}</td></tr>`,
    )
    .join("");
}

function openSettings() {
  const root = $("#settings-root");
  root.classList.remove("hidden");
  const cfg = state.config;
  root.innerHTML = `
    <div class="settings-inner">
      <button class="btn" id="settings-back">${icon("arrow-left")} ${t("Volver")}</button>
      <h2 style="margin-top:14px">${t("Ajustes")}</h2>
      <div class="settings-card">
        <h4>${t("Proveedor")}</h4>
        <p class="muted">${t("Actual:")} <b>${providerName()}</b>${isGitlab() ? ` · <code>${esc(cfg.gitlabBaseUrl || "https://gitlab.com")}</code>` : ""}.</p>
        ${isGitlab() ? `<div class="add-repo">
          <input type="text" id="gitlab-base" placeholder="${t("URL base (self-hosted)")}" value="${esc(cfg.gitlabBaseUrl || "https://gitlab.com")}" />
          <button class="btn" id="save-gitlab-base">${t("Guardar URL")}</button>
        </div>` : ""}
        <div class="add-repo">
          <button class="btn" id="switch-provider" data-target="${isGitlab() ? "github" : "gitlab"}">${t("Cambiar a {name}", { name: isGitlab() ? "GitHub" : "GitLab" })}</button>
        </div>
        <p class="muted">${t("Cambiar de proveedor reinicia el onboarding (repos y token se piden de nuevo).")}</p>
      </div>
      <div class="settings-card">
        <h4>${t("Repositorios")}</h4>
        <div id="repo-lines">
          ${cfg.repos.map((r) => `<div class="repo-line">${esc(r)} <button class="btn" data-del="${esc(r)}">${t("Quitar")}</button></div>`).join("")}
        </div>
        <details id="repo-suggest-details" class="fold">
          <summary>${t("Buscar mis repositorios")}</summary>
          <p class="muted">${t("Los mismos que te propone el onboarding al iniciar la aplicación. Marca o desmarca para añadirlos o quitarlos.")}</p>
          <div id="repo-suggest" class="repo-picker"><div class="empty">${t("Buscando tus repositorios…")}</div></div>
        </details>
        <div class="add-repo">
          <input type="text" id="new-repo" placeholder="${repoPlaceholder()}" />
          <button class="btn btn-accent" id="add-repo">${t("Añadir")}</button>
        </div>
      </div>
      ${isGitlab() ? `<div class="settings-card">
        <h4>${icon("rocket")} ${t("Proyectos de releases")}</h4>
        <p class="muted">${t("Qué proyectos se ofrecen en los selectores de Ramas y Publicar. Sin ninguno marcado se ofrecen todos los del grupo.")}</p>
        <details id="rel-projects-details" class="fold">
          <summary>${t("Elegir proyectos")}</summary>
          <div id="rel-projects" class="ms-proj-filter"><span class="muted">${t("Cargando proyectos del grupo…")}</span></div>
        </details>
      </div>` : ""}
      <div class="settings-card">
        <h4>${t("Token de {name}", { name: providerName() })}</h4>
        <p class="muted">${t("Origen actual:")} <b>${esc(state.authSource || t("ninguno"))}</b>. ${t("Orden:")} <code>${isGitlab() ? "GITLAB_TOKEN" : "GITHUB_TOKEN"}</code> → <code>${isGitlab() ? "glab CLI" : "gh auth token"}</code> → ${t("token manual.")}</p>
        <div class="add-repo">
          <input type="password" id="manual-token" placeholder="${cfg.hasManualToken ? t("•••••••• (guardado)") : isGitlab() ? t("glpat-… (opcional)") : t("ghp_… (opcional)")}" />
          <button class="btn" id="save-token">${t("Guardar")}</button>
        </div>
      </div>
      ${isGitlab() ? `<div class="settings-card">
        <h4>${icon("inbox")} ${t("Bandeja de propuestas")}</h4>
        <p class="muted">${t("Cuenta de Outlook donde llegan las propuestas. Necesita un registro de aplicación en Azure AD como cliente público con el permiso Mail.ReadWrite.")}</p>
        <details class="mail-help fold">
          <summary>${t("¿De dónde saco el Client ID?")}</summary>
          <ol>
            <li>${t("Abre el portal de Azure → Microsoft Entra ID → Registros de aplicaciones → Nuevo registro.")}</li>
            <li>${t("Ponle nombre (p.ej. Monstro) y deja el Redirect URI VACÍO: el flujo por código de dispositivo no usa ninguno.")}</li>
            <li>${t("Tras registrar, copia el «Id. de aplicación (cliente)» → ese es el Client ID, y el «Id. de directorio (inquilino)» → ese es el Tenant. Es obligatorio salvo que registres la app como multiinquilino: con «common» falla (AADSTS50059).")}</li>
            <li>${t("Permisos de API → Agregar permiso → Microsoft Graph → Permisos delegados → Mail.ReadWrite.")}</li>
            <li>${t("Autenticación → Configuración avanzada → «Permitir flujos de cliente público» = Sí. Sin esto el código de dispositivo falla.")}</li>
            <li>${t("Si tu organización lo exige, pide a un administrador que conceda el consentimiento.")}</li>
          </ol>
          <button class="btn" id="open-azure">${t("Abrir registros de aplicaciones en Azure")}</button>
        </details>
        <div class="add-repo">
          <input type="text" id="mail-client-id" placeholder="${t("Client ID de Azure")}" value="${esc(cfg.mail?.clientId || "")}" />
          <label for="mail-client-id" class="muted" style="align-self:center;flex:0 0 14em">${t("Client ID = «Id. de aplicación (cliente)»")}</label>
        </div>
        <div class="add-repo">
          <input type="text" id="mail-tenant" placeholder="${t("Tenant (common)")}" value="${esc(cfg.mail?.tenant || "")}" />
          <label for="mail-tenant" class="muted" style="align-self:center;flex:0 0 14em">${t("Tenant = «Id. de directorio (inquilino)»")}</label>
        </div>
        <div class="add-repo">
          <input type="text" id="mail-folder" placeholder="${t("Carpeta (inbox)")}" value="${esc(cfg.mail?.folder || "")}" />
          <label for="mail-folder" class="muted" style="align-self:center;flex:0 0 14em">${t("Carpeta del buzón")}</label>
        </div>
        <div class="add-repo">
          <button class="btn" id="save-mail">${t("Guardar")}</button>
        </div>
      </div>` : ""}
      <div class="settings-card">
        <h4>${icon("compass")} ${t("Apartados del menú")}</h4>
        <p class="muted">${t("Activa u oculta secciones de la barra lateral. Tiene que quedar al menos una.")}</p>
        <div id="settings-sections" class="repo-picker"></div>
      </div>
      <div class="settings-card">
        <h4>${icon("bot")} ${t("IA (Review con IA)")}</h4>
        <p class="muted" id="ai-status-line">${t("Comprobando backend…")}</p>
        <div class="add-repo">
          <select id="ai-model" disabled><option>${t("Cargando modelos…")}</option></select>
          <select id="ai-effort" disabled></select>
        </div>
        <p class="muted">${t("Modelo y esfuerzo se aplican a cada review (API directa o CLI de Claude Code). Cada borrador queda etiquetado con lo que lo generó.")}</p>
        <button class="btn" id="test-ai">${t("Probar conexión con Claude")}</button>
      </div>
      <div class="settings-card">
        <h4>${t("Refresco automático")}</h4>
        <div class="add-repo">
          <input type="number" id="poll-seconds" min="15" value="${cfg.pollSeconds}" />
          <span class="muted" style="align-self:center">${t("segundos")}</span>
        </div>
      </div>
      ${isGitlab() ? cherryPickSettingsCard(cfg) : ""}
      <div class="settings-card">
        <h4>${icon("circle-arrow-up")} ${t("Actualizaciones")}</h4>
        <p class="muted">${t("Versión instalada:")} <b>v${esc(cfg.appVersion || "?")}</b></p>
        <label style="display:block;margin:8px 0">
          <input type="checkbox" id="check-updates" ${cfg.checkUpdates ? "checked" : ""} />
          ${t("Comprobar al iniciar si hay una versión nueva")}
        </label>
        <div class="add-repo">
          <button class="btn" id="check-updates-now">${t("Buscar actualizaciones ahora")}</button>
        </div>
        <p class="muted" id="update-status"></p>
      </div>
      <div class="settings-card">
        <h4>${icon("languages")} ${t("Idioma")}</h4>
        <p class="muted">${t("Idioma de la interfaz. Por defecto sigue el idioma del sistema.")}</p>
        <div class="add-repo">
          <select id="app-language">
            <option value="system" ${!cfg.language ? "selected" : ""}>${t("Sistema")}</option>
            <option value="es" ${cfg.language === "es" ? "selected" : ""}>Español</option>
            <option value="en" ${cfg.language === "en" ? "selected" : ""}>English</option>
          </select>
        </div>
      </div>
      <div class="settings-card">
        <h4>${icon("sun-moon")} ${t("Tema de interfaz")}</h4>
        <p class="muted">${t("Aspecto visual general de la aplicación.")}</p>
        <div class="add-repo">
          <select id="ui-theme">
            <option value="default" ${(cfg.uiTheme || "default") === "default" ? "selected" : ""}>${t("Por defecto")}</option>
            <option value="liquid-glass" ${(cfg.uiTheme || "default") === "liquid-glass" ? "selected" : ""}>Liquid Glass</option>
          </select>
        </div>
      </div>
      <div class="settings-card">
        <h4>${icon("palette")} ${t("Tema de sintaxis")}</h4>
        <p class="muted">${t("Colores del resaltado de código en la pantalla de Cambios.")}</p>
        <div class="add-repo">
          <select id="syntax-theme">
            ${THEMES.map((th) => `<option value="${th.id}" ${(cfg.theme || "one-dark") === th.id ? "selected" : ""}>${esc(th.label)}</option>`).join("")}
          </select>
        </div>
        <div class="theme-preview" data-syntax-theme="${esc(cfg.theme || "one-dark")}" id="theme-preview">
          <table class="diff-table">${themePreviewRows()}</table>
        </div>
      </div>
      <div class="settings-card">
        <h4>${t("Reglas de la casa")}</h4>
        <p class="muted">pull → <b>rebase</b> · merge → <b>merge commit</b> · squash → <b style="text-decoration:line-through">${t("jamás")}</b>. ${t("No configurable. A propósito.")}</p>
      </div>
    </div>`;

  $("#settings-back").addEventListener("click", async () => {
    const pollSeconds = parseInt($("#poll-seconds").value, 10);
    if (Number.isInteger(pollSeconds) && pollSeconds >= 15 && pollSeconds !== cfg.pollSeconds) {
      state.config = await window.monstro.setConfig({ pollSeconds });
      schedulePoll();
    }
    root.classList.add("hidden");
    root.innerHTML = "";
    // Si el usuario quitó todos los repos, volvemos al picker del onboarding.
    if (!state.config.repos.length) boot();
  });
  $("#add-repo").addEventListener("click", async () => {
    const value = $("#new-repo").value.trim();
    if (!repoRe().test(value)) return toast(t("Formato esperado: {fmt}", { fmt: repoPlaceholder() }), "err");
    state.config = await window.monstro.setConfig({ repos: [...cfg.repos, value] });
    renderRepoSelect();
    openSettings();
  });
  $("#switch-provider")?.addEventListener("click", async () => {
    const target = $("#switch-provider").dataset.target;
    // Cambiar de proveedor vacía repos y token: el onboarding los pedirá de nuevo.
    state.config = await window.monstro.setConfig({ provider: target, repos: [] });
    state.repo = null;
    root.classList.add("hidden");
    root.innerHTML = "";
    boot();
  });
  $("#save-gitlab-base")?.addEventListener("click", async () => {
    const base = $("#gitlab-base").value.trim();
    if (!/^https:\/\/[\w.-]+/.test(base)) return toast(t("URL no válida (https://…)"), "err");
    state.config = await window.monstro.setConfig({ gitlabBaseUrl: base });
    toast(t("URL base guardada"), "ok");
    boot();
  });
  // Se recablea también tras tocar el picker de sugerencias, que reescribe #repo-lines.
  const wireRepoDelete = () => {
    root.querySelectorAll("[data-del]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        state.config = await window.monstro.setConfig({ repos: state.config.repos.filter((r) => r !== btn.dataset.del) });
        if (state.repo === btn.dataset.del) state.repo = state.config.repos[0] || null;
        renderRepoSelect();
        openSettings();
      }),
    );
  };
  wireRepoDelete();
  $("#save-token").addEventListener("click", async () => {
    state.config = await window.monstro.setConfig({ token: $("#manual-token").value });
    toast(t("Token guardado"), "ok");
    boot();
  });
  // Deep link a la lista de registros de aplicaciones: ahorra tres saltos de menú en el portal.
  $("#open-azure")?.addEventListener("click", () =>
    window.monstro.openExternal("https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"),
  );
  $("#save-mail")?.addEventListener("click", async () => {
    state.config = await window.monstro.setConfig({
      mail: { clientId: $("#mail-client-id").value, tenant: $("#mail-tenant").value, folder: $("#mail-folder").value },
    });
    toast(t("Bandeja de propuestas guardada"), "ok");
  });
  // Con sesión de Outlook, la carpeta pasa a ser un desplegable con las carpetas reales del buzón.
  // Mismo id, así el guardado no cambia; sin sesión (o si Graph falla) se queda como texto libre.
  if ($("#mail-folder")) {
    window.monstro
      .mailStatus()
      .then((s) => (s.connected ? window.monstro.mailFolders() : []))
      .then((paths) => {
        const input = $("#mail-folder");
        if (!input || !paths.length) return;
        const current = input.value.trim() || "inbox";
        const selected = paths.find((p) => p.toLowerCase() === current.toLowerCase()) || current;
        const options = paths.includes(selected) ? paths : [selected, ...paths];
        input.outerHTML = `<select id="mail-folder">${options.map((p) => `<option ${p === selected ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>`;
      })
      .catch(() => {});
  }
  // Repos sugeridos por el token — el mismo picker del onboarding, para no teclear paths a mano.
  // Perezoso (viewerRepos pega a la API) y con la lista viva en state.config: cada clic guarda.
  const renderRepoSuggestions = (suggestions) => {
    const el = $("#repo-suggest");
    const names = [...new Set([...suggestions.map((s) => s.nameWithOwner), ...state.config.repos])];
    if (!names.length) {
      el.innerHTML = `<div class="empty">${t("No encontré repos accesibles con tu token — añade uno a mano abajo.")}</div>`;
      return;
    }
    const isPrivate = new Map(suggestions.map((s) => [s.nameWithOwner, s.isPrivate]));
    const chosen = new Set(state.config.repos);
    el.innerHTML = names
      .map(
        (name) => `<button class="repo-option ${chosen.has(name) ? "selected" : ""}" data-suggest="${esc(name)}">
          <span class="repo-check">${chosen.has(name) ? icon("check") : ""}</span>
          <span class="repo-name">${esc(name)}</span>
          ${isPrivate.get(name) ? `<span class="chip chip-draft">${t("privado")}</span>` : ""}
        </button>`,
      )
      .join("");
    el.querySelectorAll("[data-suggest]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const name = btn.dataset.suggest;
        const next = chosen.has(name) ? state.config.repos.filter((x) => x !== name) : [...state.config.repos, name];
        state.config = await window.monstro.setConfig({ repos: next });
        // El repo activo puede haberse quedado fuera: cae al primero que quede (o a ninguno).
        if (!state.config.repos.includes(state.repo)) state.repo = state.config.repos[0] || null;
        renderRepoSelect();
        renderRepoSuggestions(suggestions);
        $("#repo-lines").innerHTML = state.config.repos
          .map((r) => `<div class="repo-line">${esc(r)} <button class="btn" data-del="${esc(r)}">${t("Quitar")}</button></div>`)
          .join("");
        wireRepoDelete();
      }),
    );
  };
  $("#repo-suggest-details")?.addEventListener("toggle", async (event) => {
    const box = event.target;
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = "1";
    const suggestions = await window.monstro.suggestRepos().catch(() => []);
    renderRepoSuggestions(suggestions || []);
  });
  // Proyectos ofrecidos en Releases (Ramas y Publicar comparten lista). Carga perezosa al desplegar:
  // groupProjects proxea los avatares del grupo y es lento, no vale la pena al abrir Ajustes.
  const renderRelProjects = () => {
    const el = $("#rel-projects");
    const all = [...(state.milestones.projects?.values() || [])].filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name));
    const visible = state.config.releases?.visibleProjects;
    const isOn = (path) => !Array.isArray(visible) || visible.includes(path);
    el.innerHTML = all
      .map((p) => `<button class="ms-proj-chip ${isOn(p.path) ? "" : "off"}" data-rel-proj="${esc(p.path)}"
        title="${isOn(p.path) ? t("Se ofrece · clic para ocultar") : t("Oculto · clic para ofrecer")}">
        ${projectIconHtml(p.path)}<span class="ms-proj-name">${esc(p.name)}</span>
      </button>`)
      .join("");
    const save = async (next) => {
      // Lista vacía = "todos": un selector sin ningún proyecto no sirve para nada.
      state.config = await window.monstro.setConfig({ releases: { visibleProjects: next && next.length ? next : null } });
      state.releases.defaults = null; // la vista de Releases relee la lista al volver a entrar
      renderRelProjects();
    };
    el.querySelectorAll("[data-rel-proj]").forEach((chip) =>
      chip.addEventListener("click", () => {
        const path = chip.dataset.relProj;
        const current = Array.isArray(visible) ? visible : all.map((p) => p.path);
        save(current.includes(path) ? current.filter((x) => x !== path) : [...current, path]);
      }),
    );
  };
  $("#rel-projects-details")?.addEventListener("toggle", async (event) => {
    const box = event.target;
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = "1";
    await ensureProjects();
    renderRelProjects();
  });
  // Apartados del menú: edición en vivo (mínimo 1). Guarda y reaplica visibilidad sin recargar.
  const secSel = new Set(cfg.sections || availableSectionKeys());
  const renderSecToggles = () => {
    const el = $("#settings-sections");
    el.innerHTML = sectionToggleRows(secSel);
    wireSectionToggles(el, secSel, async () => {
      state.config = await window.monstro.setConfig({ sections: [...secSel] });
      applyMenuVisibility();
      renderSecToggles();
    }, 1);
  };
  renderSecToggles();
  $("#check-updates").addEventListener("change", async (event) => {
    state.config = await window.monstro.setConfig({ checkUpdates: event.target.checked });
  });
  $("#check-updates-now").addEventListener("click", async () => {
    const btn = $("#check-updates-now");
    const line = $("#update-status");
    btn.disabled = true;
    btn.textContent = t("Comprobando…");
    try {
      const r = await window.monstro.checkUpdates();
      if (r.error) line.textContent = t("No se pudo comprobar: {detail}", { detail: r.error });
      else if (r.newer) line.innerHTML = `${icon("sparkles")} ${t("Hay una versión nueva: {v}", { v: `v${esc(r.latest)}` })} — <a href="#" id="update-link">${t("descargar")} ${icon("external-link")}</a>`;
      else line.textContent = t("Ya tienes la última versión (v{v})", { v: r.latest || r.current });
      $("#update-link")?.addEventListener("click", (e) => { e.preventDefault(); window.monstro.openExternal(r.url); });
    } finally {
      btn.disabled = false;
      btn.textContent = t("Buscar actualizaciones ahora");
    }
  });
  $("#app-language").addEventListener("change", (event) => {
    const value = event.target.value;
    setLanguage(value === "system" ? null : value);
  });
  $("#ui-theme").addEventListener("change", async (event) => {
    const uiTheme = event.target.value;
    state.config = await window.monstro.setConfig({ uiTheme });
    applyUiTheme(uiTheme);
  });
  $("#syntax-theme").addEventListener("change", async (event) => {
    const theme = event.target.value;
    // Preview instantáneo antes de persistir.
    $("#theme-preview").dataset.syntaxTheme = theme;
    state.config = await window.monstro.setConfig({ theme });
    applyTheme(theme);
  });

  // --- Cherry-pick de hotfix (solo GitLab) ---
  const saveCherryPick = async (partial) => {
    const cp = { ...(state.config.cherryPick || {}), ...partial };
    state.config = await window.monstro.setConfig({ cherryPick: cp });
  };
  $("#cp-save")?.addEventListener("click", async () => {
    const prefix = $("#cp-prefix").value.trim();
    if (!prefix) return toast(t("El prefijo no puede estar vacío"), "err");
    await saveCherryPick({ prefix, siblingMx: $("#cp-sibling").checked });
    toast(t("Cherry-pick configurado"), "ok");
    openSettings();
  });
  $("#cp-add-branch")?.addEventListener("click", async () => {
    const value = $("#cp-new-branch").value.trim();
    if (!BRANCH_RE.test(value)) return toast(t("Nombre de rama no válido"), "err");
    const branches = [...new Set([...(cfg.cherryPick?.branches || []), value])];
    await saveCherryPick({ branches });
    openSettings();
  });
  root.querySelectorAll("[data-cp-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const branches = (cfg.cherryPick?.branches || []).filter((b) => b !== btn.dataset.cpDel);
      await saveCherryPick({ branches });
      openSettings();
    }),
  );

  window.monstro.aiStatus().then((s) => {
    const line = $("#ai-status-line");
    if (line) line.innerHTML = s.backend
      ? `${icon("check")} <b>${esc(s.backend)}</b> — ${esc(s.detail)}`
      : `${icon("x")} ${esc(s.detail)}`;

    const modelSel = $("#ai-model");
    const effortSel = $("#ai-effort");
    if (!modelSel || !effortSel || !Array.isArray(s.models)) return;
    let currentEffort = s.effort;
    const renderEfforts = (modelId) => {
      const info = s.models.find((m) => m.id === modelId);
      if (!info || !info.efforts.length) {
        effortSel.innerHTML = `<option value="">${t("esfuerzo: no aplicable")}</option>`;
        effortSel.disabled = true;
        return;
      }
      const selected = info.efforts.includes(currentEffort) ? currentEffort : "high";
      effortSel.innerHTML = info.efforts
        .map((e) => `<option value="${e}" ${e === selected ? "selected" : ""}>${t("esfuerzo: {level}", { level: e })}</option>`)
        .join("");
      effortSel.disabled = false;
    };
    modelSel.innerHTML = s.models
      .map((m) => `<option value="${esc(m.id)}" ${m.id === s.model ? "selected" : ""}>${esc(m.label)}</option>`)
      .join("");
    modelSel.disabled = false;
    renderEfforts(s.model);
    modelSel.addEventListener("change", async () => {
      renderEfforts(modelSel.value);
      const payload = { aiModel: modelSel.value };
      if (effortSel.value) payload.aiEffort = effortSel.value;
      state.config = await window.monstro.setConfig(payload);
      toast(`${t("Review con IA:")} ${modelSel.value}${effortSel.value ? ` · ${t("esfuerzo {level}", { level: effortSel.value })}` : ""}`, "ok");
    });
    effortSel.addEventListener("change", async () => {
      if (!effortSel.value) return;
      currentEffort = effortSel.value;
      state.config = await window.monstro.setConfig({ aiEffort: effortSel.value });
      toast(`${t("Review con IA:")} ${t("esfuerzo {level}", { level: effortSel.value })}`, "ok");
    });
  }).catch(() => {});
  $("#test-ai").addEventListener("click", async () => {
    const btn = $("#test-ai");
    btn.disabled = true;
    btn.textContent = t("Probando… (puede tardar ~30s)");
    try {
      const result = await window.monstro.aiPing();
      toast(result.ok ? t("IA OK vía {backend}", { backend: result.backend }) : t("IA no disponible: {detail}", { detail: result.detail }), result.ok ? "ok" : "err");
      const line = $("#ai-status-line");
      if (line) line.innerHTML = `${icon(result.ok ? "check" : "x")} <b>${esc(result.backend || t("sin backend"))}</b> — ${esc(result.detail)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = t("Probar conexión con Claude");
    }
  });
}

/* ============ apartados del menú (onboarding + Ajustes) ============ */

// Presets de rol: pre-marcan un conjunto de apartados; el usuario luego afina. "todo" se calcula
// como availableSectionKeys(). Solo se aplican las claves válidas para el proveedor actual.
const SECTION_PRESETS = {
  desarrollo: ["prs", "validacion", "historial", "historico", "milestones", "releases", "local", "propuestas"],
  operaciones: ["soporte", "milestones", "historico", "entornos", "usuarios"],
};

/** Filas de toggles (botón por apartado, estilo .repo-option) reutilizadas en onboarding y Ajustes. */
function sectionToggleRows(selected) {
  return availableSectionKeys()
    .map((key) => {
      const sec = MENU_SECTIONS[key];
      const on = selected.has(key);
      return `<button class="repo-option section-option ${on ? "selected" : ""}" data-section="${key}">
        <span class="repo-check">${on ? icon("check") : ""}</span>
        <span class="section-ico">${icon(sec.icon)}</span>
        <span class="repo-name">${t(sec.label)}</span>
      </button>`;
    })
    .join("");
}

/** Cablea los clicks de los toggles. min = nº mínimo de apartados que deben quedar activos. */
function wireSectionToggles(scope, selected, onChange, min = 0) {
  scope.querySelectorAll("[data-section]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.section;
      if (selected.has(key)) {
        if (selected.size <= min) return; // no dejar el menú por debajo del mínimo
        selected.delete(key);
      } else selected.add(key);
      onChange();
    }),
  );
}

/** Paso final del onboarding: elegir qué apartados del menú incluir (con presets de rol). */
async function renderSectionPicker() {
  const selected = new Set(availableSectionKeys()); // por defecto, todo marcado
  const presetKeys = (name) =>
    (name === "todo" ? availableSectionKeys() : SECTION_PRESETS[name]).filter((k) => availableSectionKeys().includes(k));
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">${mascot(64)}</div>
      <h2>${t("¿Qué apartados quieres ver?")}</h2>
      <p class="muted">${t("Activa solo lo que uses — podrás cambiarlo cuando quieras en Ajustes {icon}. Empieza por un perfil:", { icon: icon("settings") })}</p>
      <div class="provider-choice section-presets">
        <button class="repo-option" data-preset="desarrollo"><span class="repo-name">${icon("code")} ${t("Desarrollo")}</span></button>
        <button class="repo-option" data-preset="operaciones"><span class="repo-name">${icon("life-buoy")} ${t("Operaciones")}</span></button>
        <button class="repo-option" data-preset="todo"><span class="repo-name">${icon("sparkles")} ${t("Todo")}</span></button>
      </div>
      <div id="section-picker" class="repo-picker"></div>
      <div class="welcome-actions">
        <button class="btn btn-accent" id="section-start">${t("Continuar")}</button>
      </div>
    </div>`;

  const pickEl = $("#section-picker");
  const startBtn = $("#section-start");
  const renderRows = () => {
    pickEl.innerHTML = sectionToggleRows(selected);
    wireSectionToggles(pickEl, selected, renderRows);
    startBtn.disabled = !selected.size;
  };
  list.querySelectorAll("[data-preset]").forEach((btn) =>
    btn.addEventListener("click", () => {
      selected.clear();
      presetKeys(btn.dataset.preset).forEach((k) => selected.add(k));
      list.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("selected", b === btn));
      renderRows();
    }),
  );
  startBtn.addEventListener("click", async () => {
    if (!selected.size) return;
    state.config = await window.monstro.setConfig({ sections: [...selected] });
    boot();
  });
  renderRows();
  notifySelftestOnce();
}

/* ============ bienvenida / onboarding ============ */

/** Primer paso del onboarding: elegir proveedor (GitHub o GitLab). */
async function renderProviderChooser() {
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">${mascot(64)}</div>
      <h2>${t("¿Con qué trabajas?")}</h2>
      <p class="muted">${t("Elige tu proveedor. Podrás cambiarlo luego en Ajustes {icon}.", { icon: icon("settings") })}</p>
      <div class="provider-choice">
        <button class="repo-option provider-option" data-provider="github">
          <span class="repo-name">GitHub</span>
        </button>
        <button class="repo-option provider-option" data-provider="gitlab">
          <span class="repo-name">GitLab</span>
        </button>
      </div>
      <div class="add-repo picker-manual" id="gitlab-base-row" style="display:none">
        <input type="text" id="gitlab-base-input" placeholder="${t("URL de GitLab (self-hosted): https://gitlab.miempresa.com")}" />
      </div>
      <div class="welcome-actions">
        <button class="btn btn-accent" id="provider-continue" disabled>${t("Continuar")}</button>
      </div>
    </div>`;

  let chosen = null;
  const baseRow = $("#gitlab-base-row");
  const continueBtn = $("#provider-continue");
  list.querySelectorAll("[data-provider]").forEach((btn) =>
    btn.addEventListener("click", () => {
      chosen = btn.dataset.provider;
      list.querySelectorAll(".provider-option").forEach((b) => b.classList.toggle("selected", b === btn));
      baseRow.style.display = chosen === "gitlab" ? "" : "none";
      continueBtn.disabled = false;
    }),
  );
  continueBtn.addEventListener("click", async () => {
    if (!chosen) return;
    const partial = { provider: chosen };
    if (chosen === "gitlab") {
      const base = $("#gitlab-base-input").value.trim();
      if (base) {
        if (!/^https:\/\/[\w.-]+/.test(base)) return toast(t("URL no válida (https://…)"), "err");
        partial.gitlabBaseUrl = base;
      }
    }
    state.config = await window.monstro.setConfig(partial);
    boot();
  });
  notifySelftestOnce();
}

async function renderWelcome() {
  const aiStatus = await window.monstro.aiStatus().catch(() => ({ backend: null, detail: "" }));
  const aiOk = Boolean(aiStatus.backend);
  const gitlab = isGitlab();
  const envVar = gitlab ? "GITLAB_TOKEN" : "GITHUB_TOKEN";
  const cliCmd = gitlab ? "glab auth login" : "gh auth login";
  // Enlace exacto a la creación del token, con nombre y permisos mínimos ya prerellenados.
  const base = gitlab ? (state.config.gitlabBaseUrl || "https://gitlab.com").replace(/\/+$/, "") : "https://github.com";
  const patUrl = gitlab
    ? `${base}/-/user_settings/personal_access_tokens?name=Monstro&scopes=api,read_user`
    : "https://github.com/settings/tokens/new?description=Monstro&scopes=repo,read:org";
  const scopes = gitlab ? "api, read_user" : "repo, read:org";
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">${mascot(64)}</div>
      <h2>${t("Conecta {name}", { name: providerName() })}</h2>
      <p class="muted">${t("Dos clics: crea un token y pégalo aquí. Monstro lo guarda solo en tu equipo (cifrado, 0600); nunca se envía a nadie.")}</p>

      <div class="setup-step">
        <div class="setup-mark">1</div>
        <div>
          <b>${t("Crea el token")}</b>
          <p class="muted">${t("Abre la página (ya con el nombre y los permisos {scopes} preparados), genera el token y cópialo.", { scopes })}</p>
          <button class="btn btn-accent" id="welcome-open-pat">${t("Crear token en {name}", { name: providerName() })} ${icon("external-link")}</button>
        </div>
      </div>

      <div class="setup-step">
        <div class="setup-mark">2</div>
        <div>
          <b>${t("Pega el token")}</b>
          <div class="add-repo" style="margin-top:6px">
            <input type="password" id="welcome-token" placeholder="${gitlab ? "glpat-…" : "ghp_…"}" />
            <button class="btn btn-accent" id="welcome-save-token">${t("Conectar")}</button>
          </div>
        </div>
      </div>

      <div class="setup-step ${aiOk ? "ok" : ""}">
        <div class="setup-mark">3</div>
        <div>
          <b>${t("Conecta Claude")}</b> <span class="chip ${aiOk ? "chip-open" : "chip-draft"}">${aiOk ? t("listo") : t("opcional")}</span>
          <p class="muted">${aiOk
            ? t("Detectado: {detail} — las funciones de IA de Monstro (resúmenes, propuestas…) ya funcionan.", { detail: esc(aiStatus.detail) })
            : `${t("Para las funciones de IA de Monstro (resúmenes, propuestas…): instala")} <a href="#" data-ext="https://claude.com/claude-code">Claude Code</a> ${t("y ábrelo una vez para autenticarte (Monstro usará tu sesión), o exporta")} <code>ANTHROPIC_API_KEY</code>.`}</p>
        </div>
      </div>

      <details class="welcome-alt fold">
        <summary>${t("¿Prefieres la terminal?")}</summary>
        <p class="muted">${t("Si tienes el CLI oficial, Monstro coge el token solo:")} <code>${cliCmd}</code>. ${t("O exporta")} <code>${envVar}</code>. ${t("Después pulsa Reintentar.")}</p>
        <button class="btn" id="welcome-retry">${t("He hecho login — Reintentar")}</button>
      </details>
      <p class="muted small-print">${t("¿Dudas?")} <code>npm run doctor</code> ${t("en la terminal diagnostica todo esto por ti.")}</p>
    </div>`;
  $("#welcome-open-pat").addEventListener("click", () => window.monstro.openExternal(patUrl));
  $("#welcome-save-token").addEventListener("click", async () => {
    const token = $("#welcome-token").value.trim();
    if (!token) return toast(t("Pega primero el token"), "err");
    state.config = await window.monstro.setConfig({ token });
    const auth = await window.monstro.authStatus().catch(() => ({ ok: false }));
    if (!auth.ok) return toast(t("El token no funcionó — revisa los permisos y cópialo de nuevo"), "err");
    boot();
  });
  $("#welcome-retry")?.addEventListener("click", boot);
  list.querySelectorAll("[data-ext]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      window.monstro.openExternal(a.dataset.ext);
    }),
  );
}

/** Paso final del onboarding: GitHub conectado pero sin repos elegidos todavía. */
async function renderRepoPicker() {
  const selected = new Set();
  let suggestions = [];
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">${mascot(64)}</div>
      <h2>${t("¿Qué repositorios quieres ver?")}</h2>
      <p class="muted">${t("Conectado como")} <b>${esc(state.me?.login || "?")}</b>. ${t("Marca los repos que Monstro vigilará — podrás cambiarlos cuando quieras en Ajustes {icon}.", { icon: icon("settings") })}</p>
      <div id="repo-picker" class="repo-picker"><div class="empty">${t("Buscando tus repositorios…")}</div></div>
      <div class="add-repo picker-manual">
        <input type="text" id="picker-manual-input" placeholder="${t("¿Falta alguno? Escríbelo: {fmt}", { fmt: repoPlaceholder() })}" />
        <button class="btn" id="picker-manual-add">${t("Añadir")}</button>
      </div>
      <div class="welcome-actions">
        <button class="btn btn-accent" id="picker-start" disabled>${t("Empezar")}</button>
      </div>
    </div>`;

  const rowsEl = $("#repo-picker");
  const startBtn = $("#picker-start");

  const renderRows = () => {
    const names = [...new Set([...suggestions.map((s) => s.nameWithOwner), ...selected])];
    if (!names.length) {
      rowsEl.innerHTML = `<div class="empty">${t("No encontré repos accesibles con tu token — añade uno a mano abajo.")}</div>`;
    } else {
      const isPrivate = new Map(suggestions.map((s) => [s.nameWithOwner, s.isPrivate]));
      rowsEl.innerHTML = names
        .map(
          (name) => `
        <button class="repo-option ${selected.has(name) ? "selected" : ""}" data-repo="${esc(name)}">
          <span class="repo-check">${selected.has(name) ? icon("check") : ""}</span>
          <span class="repo-name">${esc(name)}</span>
          ${isPrivate.get(name) ? `<span class="chip chip-draft">${t("privado")}</span>` : ""}
        </button>`,
        )
        .join("");
      rowsEl.querySelectorAll("[data-repo]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const name = btn.dataset.repo;
          if (selected.has(name)) selected.delete(name);
          else selected.add(name);
          renderRows();
        }),
      );
    }
    startBtn.disabled = !selected.size;
    startBtn.textContent = selected.size
      ? t("Empezar con {n} {unit}", { n: selected.size, unit: selected.size === 1 ? t("repositorio") : t("repositorios") })
      : t("Empezar");
  };

  startBtn.addEventListener("click", async () => {
    if (!selected.size) return;
    state.config = await window.monstro.setConfig({ repos: [...selected] });
    state.repo = null;
    boot();
  });
  const addManual = () => {
    const input = $("#picker-manual-input");
    const value = input.value.trim();
    if (!repoRe().test(value)) return toast(t("Formato esperado: {fmt}", { fmt: repoPlaceholder() }), "err");
    selected.add(value);
    input.value = "";
    renderRows();
  };
  $("#picker-manual-add").addEventListener("click", addManual);
  $("#picker-manual-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addManual();
  });

  try {
    suggestions = await window.monstro.suggestRepos();
  } catch {
    /* sin sugerencias no pasa nada: queda la entrada manual */
  }
  renderRows();
  notifySelftestOnce();
}

/* ============ vista milestones (solo GitLab) ============ */
