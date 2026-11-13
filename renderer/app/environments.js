"use strict";

// Vista de Entornos (solo GitLab): matriz proyecto × entorno con dos señales por celda.
//
//   Capa 1 (GitLab, siempre): estado del ÚLTIMO despliegue de cada entorno + qué ref/tag lleva y
//   desde cuándo. Responde a "¿qué versión hay en producción-mx y fue bien el deploy?".
//
//   Capa 2 (sonda HTTP, solo si el entorno tiene external_url): un GET desde el main process al
//   entorno. Responde a "¿está viva la app AHORA?", que la capa 1 no sabe: un deploy verde de hace
//   tres semanas no dice nada del estado actual.
//
// Las dos son necesarias y ninguna sustituye a la otra. El veredicto de la sonda tiene TRES estados
// a propósito (up/unknown/down) porque una SPA devuelve 200 con index.html en cualquier ruta: sin
// una ruta de sonda que devuelva algo que no sea HTML, lo honesto es "no verificable", no "sano".

// Orden de columnas por tier (mismo criterio que el backend) para que la matriz se lea de izquierda
// (lo pronto) a derecha (producción).
const ENV_TIER_RANK = { development: 0, testing: 1, staging: 2, production: 3, other: 4 };

async function enterEnvironments() {
  if (!isGitlab()) {
    toast(t("La vista de Entornos solo está disponible en GitLab"), "");
    return;
  }
  state.view = "environments";
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $("#bucket-entornos")?.classList.add("active");
  await loadEnvironments();
}

// Siembra la selección de proyectos una vez por sesión: la recordada en config.environments si la
// hay; si no, los proyectos de release por defecto (releases.defaultProjectIds), que son justo los
// que se despliegan. NO se hereda releases.selectedProjects: eso es "lo último que se publicó", un
// conjunto circunstancial que a menudo es un solo proyecto.
function seedEnvSelection() {
  const e = state.environments;
  if (e.seeded) return;
  const existing = new Set(e.projects.map((p) => p.path));
  const saved = state.config?.environments?.selectedProjects;
  if (Array.isArray(saved)) {
    for (const path of saved) if (existing.has(path)) e.selected.add(path);
  } else {
    const defIds = new Set((state.config?.releases?.defaultProjectIds || []).map(String));
    for (const p of e.projects) if (defIds.has(String(p.id))) e.selected.add(p.path);
  }
  e.seeded = true;
}

function saveEnvSelection() {
  if (IS_SELFTEST) return;
  window.monstro.setConfig({ environments: { selectedProjects: [...state.environments.selected] } }).catch(() => {});
}

async function loadEnvironments() {
  const e = state.environments;
  e.loading = true;
  renderEnvironments();
  try {
    await ensureProjects();
    e.projects = [...(state.milestones.projects?.values() || [])]
      .filter((p) => !p.archived)
      .sort((a, b) => a.name.localeCompare(b.name));
    seedEnvSelection();
    e.loading = false;
    renderEnvironments();
    await refreshEnvData();
  } catch (err) {
    e.loading = false;
    list.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

// Carga los entornos de los proyectos seleccionados. De 4 en 4: cada proyecto son 1+M llamadas a
// GitLab, así que en serie se hace eterno con 8 proyectos y todo a la vez son ~48 peticiones de
// golpe contra un self-hosted. ponytail: pool fijo, sin librería; sin caché entre entradas a la
// vista — si molesta, cachear por proyecto con TTL.
const ENV_CONCURRENCY = 4;

async function refreshEnvData() {
  const e = state.environments;
  const paths = e.projects.filter((p) => e.selected.has(p.path)).map((p) => p.path);
  e.data = new Map();
  e.health = new Map();
  e.settled = false; // hasta que acaben datos Y sondas (el selftest espera a esto)
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      try {
        e.data.set(path, await window.monstro.projectEnvironments(path));
      } catch (err) {
        e.data.set(path, { error: String(err.message || err) });
      }
      renderEnvironments();
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENV_CONCURRENCY, queue.length) }, worker));
  await probeEnvHealth();
  e.settled = true;
  renderEnvironments();
}

// Capa 2: sonda HTTP de cada entorno que tenga external_url. En paralelo pero acotado, y siempre
// después de tener los entornos (necesitamos las URLs). Un fallo de sonda nunca tumba la vista.
async function probeEnvHealth() {
  const e = state.environments;
  const targets = [];
  for (const [path, envs] of e.data) {
    if (!Array.isArray(envs)) continue;
    for (const env of envs) if (env.externalUrl) targets.push({ path, env });
  }
  if (!targets.length) return;
  e.probing = true;
  renderEnvironments();
  await Promise.all(
    targets.map(async ({ path, env }) => {
      const res = await window.monstro.envHealth(env.externalUrl, path).catch((err) => ({
        status: "down",
        note: String(err.message || err),
      }));
      e.health.set(`${path}|${env.name}`, res);
    }),
  );
  e.probing = false;
  renderEnvironments();
}

// Semáforo de la capa 1. Aquí `deployment` es SIEMPRE el último despliegue con éxito (projectEnvironments
// filtra por status=success), así que solo hay dos verdictos: sano o rancio. `stale` = el deploy fue
// bien pero hace demasiado: ámbar, porque un entorno congelado meses suele ser un olvido, no una virtud.
function deployVerdict(deployment, staleDays) {
  if (!deployment) return { cls: "none", ico: "·", label: t("Sin despliegues") };
  const days = deployment.deployedAt ? (Date.now() - new Date(deployment.deployedAt).getTime()) / 86400000 : 0;
  if (deployment.deployedAt && days > staleDays) return { cls: "stale", ico: icon("check"), label: t("Desplegado hace mucho") };
  return { cls: "ok", ico: icon("check"), label: t("Desplegado correctamente") };
}

// Slot de dev (tier development): réplica de `isDevBusy` de delivery-flow (scripts/dev-slot.cjs), que es
// quien de verdad bloquea: mientras esto diga "ocupado", el ▶ aprobar-para-probar de otra MR falla. Se
// libera cuando QA valida (pipeline en success tras validar-qa-para-mergear), la MR pasa a Draft, se
// mergea o se cierra. Si la regla cambia allí, cambia aquí.
function devSlotVerdict(slot) {
  const mr = slot.mr;
  if (!mr) return { busy: false, reason: t("sin MR abierta") };
  if (mr.state === "merged") return { busy: false, reason: t("MR fusionada") };
  if (mr.state !== "opened") return { busy: false, reason: t("MR cerrada") };
  if (mr.draft) return { busy: false, reason: t("MR en Draft") };
  if (!mr.pipeline) return { busy: false, reason: t("MR sin pipeline") };
  if (mr.pipeline === "success") return { busy: false, reason: t("validada por QA") };
  return { busy: true, reason: t("pendiente de QA (pipeline {status})", { status: mr.pipeline }) };
}

function devSlotLinksHtml(slot) {
  const link = (url, ico, text, title) =>
    `<button class="env-link" data-url="${esc(url)}" title="${esc(title)}">${icon(ico)}${esc(text)}</button>`;
  const links = [
    slot.mr && link(slot.mr.url, "git-pull-request", `!${slot.mr.iid}`, slot.mr.title),
    slot.task && link(slot.task.url, "square-check", `#${slot.task.iid}`, slot.task.title),
    slot.epic && link(slot.epic.url, "layers", `Epic #${slot.epic.iid}`, slot.epic.title),
  ].filter(Boolean);
  return links.length ? `<div class="env-links">${links.join("")}</div>` : "";
}

// Función y no mapa constante: icon() se llama al pintar, no al cargar, porque test-env-mirror.js
// evalúa este fichero en un vm sin icons.js.
function healthIcon(status) {
  if (status === "up") return icon("circle-check");
  if (status === "unknown") return icon("circle-question-mark");
  return icon("circle-x");
}

// Punto de salud (capa 2). Sin URL no pintamos nada: mejor un hueco que un icono gris que se
// confunda con "caído".
function healthDotHtml(path, env) {
  if (!env.externalUrl) return "";
  const h = state.environments.health.get(`${path}|${env.name}`);
  if (!h) {
    return `<span class="env-health probing" title="${t("Comprobando…")}">${icon("loader-circle", "spin")}</span>`;
  }
  const detail = [h.httpStatus ? `HTTP ${h.httpStatus}` : "", h.ms != null ? `${h.ms} ms` : "", h.note || ""]
    .filter(Boolean)
    .join(" · ");
  return `<span class="env-health ${esc(h.status)}" title="${esc(`${env.externalUrl} — ${detail}`)}">${healthIcon(h.status)}</span>`;
}

// Entornos espejo (config `environments.mirrors`): un entorno que no despliega nada por su cuenta
// porque lo que corre ahí es el despliegue de otro (mismo artefacto, distinto bucket/dominio). Se
// copia SOLO el despliegue, y solo si el destino no tiene uno propio: en cuanto alguien le añada su
// job de deploy, `env.deployment` deja de ser nulo y el espejo se desactiva sin tocar nada.
function mirrored(env, envs, sourceName) {
  if (!sourceName || env.deployment) return env;
  const source = envs.find((x) => x.name === sourceName);
  if (!source?.deployment) return env;
  return { ...env, deployment: source.deployment, mirrorOf: sourceName };
}

function envCellHtml(path, env, staleDays) {
  const slot = env.devSlot;
  const sv = slot && devSlotVerdict(slot);
  // En dev manda el candado (¿quién lo tiene?), no lo rancio: dev cambia de manos cada pocos días.
  const v = sv
    ? sv.busy
      ? { cls: "busy", ico: icon("lock"), label: `${t("Dev ocupado")}: ${sv.reason}` }
      : { cls: "free", ico: icon("lock-open"), label: `${t("Dev libre")}: ${sv.reason}` }
    : deployVerdict(env.deployment, staleDays);
  const d = env.deployment;
  const refText = slot?.branch || d?.ref;
  const ref = refText ? `<code class="env-ref">${esc(refText)}</code>` : `<span class="env-ref muted">—</span>`;
  const when = d?.deployedAt ? timeAgo(d.deployedAt) : "";
  const tip = [
    v.label,
    slot?.mr ? `!${slot.mr.iid} ${slot.mr.title}${slot.mr.author ? ` (${slot.mr.author})` : ""}` : "",
    env.mirrorOf ? t("mismo despliegue que {env}", { env: env.mirrorOf }) : "",
    refText ? `${t("ref")}: ${refText}` : "",
    d?.user ? `${t("por")} ${d.user}` : "",
    d?.sha || "",
  ]
    .filter(Boolean)
    .join(" · ");
  const url = d?.pipelineUrl || env.externalUrl || env.webUrl || "";
  // Dos líneas: el ref (que es lo que se viene a leer: qué versión hay ahí) manda en la primera y
  // se queda con todo el ancho; el resto baja a una segunda línea en gris.
  return `<td class="env-cell">
    <button class="env-box ${v.cls}" ${url ? `data-url="${esc(url)}"` : "disabled"} title="${esc(tip)}">
      <span class="env-box-top"><span class="env-ico">${v.ico}</span>${ref}</span>
      <span class="env-box-bot">
        <span class="env-when">${esc(when)}</span>
        ${env.mirrorOf ? `<span class="env-mirror">${icon("arrow-left-right")} ${esc(env.mirrorOf)}</span>` : ""}
        ${healthDotHtml(path, env)}
      </span>
    </button>
    ${slot ? devSlotLinksHtml(slot) : ""}
  </td>`;
}

function renderEnvironments() {
  if (state.view !== "environments") return;
  const e = state.environments;
  if (e.loading) {
    list.innerHTML = `<div class="loading">${t("Cargando proyectos…")}</div>`;
    return;
  }
  const projects = e.projects.filter((p) => e.selected.has(p.path));
  const staleDays = state.config?.environments?.staleDays || 45;

  // El grupo tiene ~40 proyectos: la barra de chips entera se comía media pantalla y la matriz, que
  // es lo que se viene a mirar, quedaba debajo del pliegue. Va dentro de un <details> nativo, abierto
  // solo mientras no haya nada seleccionado (que es cuando de verdad hay que elegir).
  const chipsHtml = e.projects
    .map((p) => {
      const off = !e.selected.has(p.path);
      return `<button class="ms-proj-chip ${off ? "off" : ""}" data-path="${esc(p.path)}"
        title="${off ? t("Excluido · clic para incluir") : t("Incluido · clic para excluir")}">
        ${projectIconHtml(p.path)}<span class="ms-proj-name">${esc(p.name)}</span>
      </button>`;
    })
    .join("");
  const pickerOpen = e.pickerOpen ?? projects.length === 0;

  // Columnas = unión de los entornos de todos los proyectos, ordenada por tier. Así los proyectos
  // que no tienen un entorno concreto dejan el hueco vacío en su sitio, alineado con el resto.
  const colMap = new Map();
  for (const envs of e.data.values()) {
    if (!Array.isArray(envs)) continue;
    for (const env of envs) if (!colMap.has(env.name)) colMap.set(env.name, env.tier);
  }
  const cols = [...colMap.entries()]
    .sort((a, b) => (ENV_TIER_RANK[a[1]] ?? 9) - (ENV_TIER_RANK[b[1]] ?? 9) || a[0].localeCompare(b[0]))
    .map(([name]) => name);

  const rowsHtml = projects
    .map((p) => {
      const envs = e.data.get(p.path);
      const mirrors = state.config?.environments?.mirrors?.[p.path] || {};
      const cells = !envs
        ? `<td class="env-cell" colspan="${Math.max(1, cols.length)}"><span class="env-loading">${t("Cargando…")}</span></td>`
        : envs.error
          ? `<td class="env-cell" colspan="${Math.max(1, cols.length)}"><span class="env-err">${esc(envs.error)}</span></td>`
          : cols
              .map((name) => {
                const env = envs.find((x) => x.name === name);
                if (!env) return `<td class="env-cell empty"></td>`;
                return envCellHtml(p.path, mirrored(env, envs, mirrors[name]), staleDays);
              })
              .join("");
      return `<tr>
        <th class="env-proj">${projectIconHtml(p.path)}<span class="env-proj-name">${esc(p.name)}</span></th>
        ${cells}
      </tr>`;
    })
    .join("");

  const headHtml = cols.map((name) => `<th class="env-col">${esc(name)}</th>`).join("");
  const table = projects.length
    ? `<table class="env-table">
        <thead><tr><th class="env-proj"></th>${headHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>`
    : `<div class="empty">${t("Selecciona al menos un proyecto")}</div>`;

  list.innerHTML = `
    <div class="ms-filters env-filters">
      <details class="env-picker" ${pickerOpen ? "open" : ""}>
        <summary>${t("Proyectos")} <span class="env-picker-n">${t("{n} seleccionados", { n: projects.length })}</span></summary>
        <div class="ms-proj-chips">${chipsHtml}</div>
      </details>
      <div class="env-bar">
        <span class="env-legend">
          <span class="env-key ok">${icon("check")}</span> ${t("desplegado")}
          <span class="env-key stale">${icon("check")}</span> ${t("rancio")}
          <span class="env-key busy">${icon("lock")}</span> ${t("dev ocupado")}
          <span class="env-key free">${icon("lock-open")}</span> ${t("dev libre")}
          <span class="env-sep">·</span>
          <span class="env-health up">${healthIcon("up")}</span> ${t("responde")}
          <span class="env-health unknown">${healthIcon("unknown")}</span> ${t("sin verificar")}
          <span class="env-health down">${healthIcon("down")}</span> ${t("caído")}
        </span>
        ${e.probing ? `<span class="muted">${t("Comprobando salud…")}</span>` : ""}
        <button id="env-refresh" class="icon-btn" title="${t("Refrescar")}">${icon("refresh-cw")}</button>
      </div>
    </div>
    ${table}`;

  const picker = list.querySelector(".env-picker");
  picker?.addEventListener("toggle", () => {
    e.pickerOpen = picker.open; // sobrevive a los re-render de refreshEnvData
  });
  list.querySelectorAll(".ms-proj-chip[data-path]").forEach((chip) =>
    chip.addEventListener("click", () => {
      const path = chip.dataset.path;
      if (e.selected.has(path)) e.selected.delete(path);
      else e.selected.add(path);
      saveEnvSelection();
      renderEnvironments();
      refreshEnvData();
    }),
  );
  list.querySelectorAll(".env-box[data-url], .env-link[data-url]").forEach((btn) =>
    btn.addEventListener("click", () => window.monstro.openExternal(btn.dataset.url)),
  );
  $("#env-refresh")?.addEventListener("click", refreshEnvData);

  // El selftest captura cuando la matriz está COMPLETA. Se mira `settled` (lo pone refreshEnvData al
  // terminar del todo) y no "hay datos y no se está sondeando": entre que acaba la carga y arranca
  // probeEnvHealth hay un instante con probing=false que disparaba la captura sin ninguna sonda hecha.
  if (e.settled) notifySelftestOnce();
}
