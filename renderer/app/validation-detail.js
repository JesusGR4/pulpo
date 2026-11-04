"use strict";

// Detalle de una tarjeta del tablero de Validación (renderer/app/validation.js):
//  - clic en la tarjeta → ficha flotante (popover) anclada a ella, con los ▶ de cada MR en línea;
//  - «Abrir completo» → panel acoplado abajo con pestañas (Resumen · Pipelines · Producción).
// Aquí viven también las acciones de producción: ▶ publicar-tag-produccion y ▶ desplegar la tag.

let valDocListeners = false;

const valAllMrs = () => (state.validation.cards || []).flatMap((c) => c.mrs);

function valSubLabel(m) {
  if (!m.sub) return "";
  if (m.sub === "tagged") return t("en tag {tag}", { tag: m.prod.tag });
  return t(VAL_SUB[m.sub] || m.sub);
}

function valStatusLine(m) {
  const stage = t(VAL_STAGES[m.stageIndex].label);
  const sub = valSubLabel(m);
  return `${esc(stage)}${sub ? ` · ${esc(sub)}` : ""}`;
}

// El único paso hacia producción de una MR mergeada: botón, o por qué no se puede.
function valProdStep(m) {
  const plan = m.prodPlan;
  if (!plan) return "";
  const a = plan.actions[0];
  if (a) return `<button class="btn val-btn-prod" data-prod="${esc(m.key)}">${icon("play")}${a.job === "publicar-tag-produccion" ? t("Publicar tag") : t("Prod ES")}</button>`;
  return plan.blocked ? `<span class="val-muted">${esc(t(VAL_BLOCKED[plan.blocked] || plan.blocked))}</span>` : "";
}

// Acciones de la tarjeta entera: pasar a la siguiente columna (hasta «Probada»), Mergear, abrir la tarea.
function valCardActions(card) {
  const idx = VAL_STAGES.findIndex((s) => s.key === card.stage);
  const next = idx < VAL_LAST_DROP ? idx + 1 : null;
  return [
    next !== null ? `<button class="btn btn-primary" data-val-next="${next}">${icon("arrow-right")}${t("Pasar a «{s}»", { s: t(VAL_STAGES[next].label) })}</button>` : "",
    card.mrs.some((m) => m.stage === "tested") ? `<button class="btn btn-primary" data-val-merge>${icon("git-merge")}${t("Mergear")}</button>` : "",
    card.task ? `<button class="btn" data-url="${esc(card.task.url)}">${t("Abrir tarea")}</button>` : "",
  ].join("");
}

function valCardMeta(card) {
  const ref = card.task ? `<span class="val-ref">${esc(valIssueRef(card.task.url))}</span>` : `<span class="val-loose">${t("Sin tarea")}</span>`;
  return `${ref}<span class="val-stage val-stage-${card.stage}">${esc(t(VAL_STAGES.find((s) => s.key === card.stage).label))}</span>`;
}

function valPopoverHtml(card) {
  const mrs = card.mrs
    .map(
      (m) => `<li>
        <div class="val-pop-mr">
          <span><button class="val-link val-iid" data-url="${esc(m.url)}">!${m.iid}</button> <span class="val-repo">${esc(valProject(m.repo))}</span></span>
          <span class="val-pop-sub">${valStatusLine(m)}${m.warnings.length ? ` · <span class="val-warn-text">${esc(m.warnings.map((w) => t(VAL_WARNINGS[w] || w)).join(" · "))}</span>` : ""}</span>
        </div>
        ${valProdStep(m)}
      </li>`,
    )
    .join("");
  const actions = valCardActions(card);
  return `<div class="val-pop" id="val-pop" role="dialog" aria-label="${esc(card.title)}">
    <div class="val-pop-head">${valCardMeta(card)}
      <button class="val-link" data-val-dock>${t("Abrir completo")}</button>
      <button class="icon-btn" data-val-close title="${t("Cerrar")}">${icon("x")}</button>
    </div>
    <h3>${esc(card.title)}</h3>
    <ul class="val-pop-mrs">${mrs}</ul>
    ${actions ? `<div class="val-pop-actions">${actions}</div>` : ""}
  </div>`;
}

function valDockTab(card, tab) {
  const job = (j) => (j ? `<span class="val-job val-job-${j.status}" title="${esc(j.status)}">${esc(j.name)}</span>` : "");
  if (tab === "pipelines") {
    return card.mrs
      .map(
        (m) => `<div class="val-dock-row">
          <button class="val-link val-iid" data-url="${esc(m.url)}">!${m.iid}</button><span class="val-repo">${esc(valProject(m.repo))}</span>
          ${m.pipeline?.url ? `<button class="val-link" data-url="${esc(m.pipeline.url)}">${icon("workflow")}${t("pipeline")}</button>` : `<span class="val-muted">${m.merged ? t("mergeada") : t("sin pipeline")}</span>`}
          ${m.flow ? [m.flowJobs.gate, m.flowJobs.deploy, m.flowJobs.validate].map(job).join("") : ""}
        </div>`,
      )
      .join("");
  }
  if (tab === "produccion") {
    const rows = card.mrs
      .filter((m) => m.merged)
      .map(
        (m) => `<tr>
          <td><button class="val-link val-iid" data-url="${esc(m.url)}">!${m.iid}</button> <span class="val-repo">${esc(valProject(m.repo))}</span></td>
          <td><code>${esc((m.mergeSha || "").slice(0, 8))}</code></td>
          <td class="${m.prod.tag ? "val-ok" : "val-muted"}">${esc(m.prod.tag || (m.prod.checked ? t("sin tag") : t("comprobando")))}</td>
          <td class="val-muted">${m.sub === "deploying" ? t("desplegando") : t("sin desplegar")}</td>
          <td class="${m.prod.mxPending ? "val-muted" : "val-ok"}">${m.prod.mxPending ? t("pendiente") : t("al día")}</td>
          <td class="val-right">${valProdStep(m)}</td>
        </tr>`,
      )
      .join("");
    return `<table class="val-prod-table">
      <thead><tr><th>${t("MR")}</th><th>${t("Merge")}</th><th>${t("Tag")}</th><th>${t("Prod ES")}</th><th>${t("Prod MX")}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
  return card.mrs
    .map(
      (m) => `<div class="val-dmr">
        <div class="val-dmr-head">
          <button class="val-link val-iid" data-url="${esc(m.url)}">!${m.iid}</button>
          <span class="val-repo">${esc(valProject(m.repo))}</span>
          <span class="val-stage val-stage-${m.stage}">${valStatusLine(m)}</span>
        </div>
        <div class="val-dmr-title">${esc(m.title)}</div>
        <div class="val-dmr-meta"><span>${icon("check")}${m.approvedBy.length ? esc(m.approvedBy.join(", ")) : t("sin Approve")}</span></div>
        ${m.warnings.length ? `<div class="val-dmr-warns">${valWarnings(m)}</div>` : ""}
      </div>`,
    )
    .join("");
}

function valDockHtml(card) {
  const hasProd = card.mrs.some((m) => m.merged);
  const tabs = [["resumen", t("Resumen")], ["pipelines", t("Pipelines")], ...(hasProd ? [["produccion", t("Producción")]] : [])];
  const v = state.validation;
  const tab = tabs.some(([k]) => k === v.tab) ? v.tab : hasProd && card.stage === "merged" ? "produccion" : "resumen";
  const idx = VAL_STAGES.findIndex((s) => s.key === card.stage);
  const steps = VAL_STAGES.map((s, i) => `<li class="${i <= idx ? `on val-step-${card.stage}` : ""}"><span></span>${t(s.label)}</li>`).join("");
  return `<section class="val-dock" aria-label="${esc(card.title)}">
    <div class="val-dock-tabs">
      ${valCardMeta(card)}
      ${tabs.map(([k, label]) => `<button class="val-tab ${k === tab ? "on" : ""}" data-val-tab="${k}">${label}</button>`).join("")}
      <button class="icon-btn" data-val-close title="${t("Cerrar")}">${icon("x")}</button>
    </div>
    <div class="val-dock-body">
      <div class="val-dock-info">
        ${card.epic ? `<span class="val-epic">${icon("layers")}${esc(card.epic.title)}</span>` : ""}
        <h2>${esc(card.title)}</h2>
        <ol class="val-steps">${steps}</ol>
      </div>
      <div class="val-dock-main">${valDockTab(card, tab)}</div>
      <div class="val-dock-side"><span class="val-side-title">${t("Siguiente paso")}</span>${valCardActions(card) || `<span class="val-muted">${t("Nada que hacer")}</span>`}</div>
    </div>
  </section>`;
}

/** Lo que va encima/debajo del tablero según el modo: ficha flotante o panel acoplado. */
function valOverlayHtml() {
  const card = valSelectedCard();
  if (!card) return "";
  return state.validation.mode === "dock" ? valDockHtml(card) : valPopoverHtml(card);
}

// Coloca la ficha junto a su tarjeta: a la derecha si cabe, si no a la izquierda; sin salirse por abajo.
function positionValPopover() {
  const pop = $("#val-pop");
  const card = list.querySelector(".val-card.selected");
  const view = list.querySelector(".val-view");
  if (!pop || !view) return;
  if (!card) {
    pop.style.visibility = "hidden";
    return;
  }
  const r = card.getBoundingClientRect();
  const vr = view.getBoundingClientRect();
  const gap = 10;
  const right = r.right + gap + pop.offsetWidth <= vr.right;
  const left = right ? r.right - vr.left + gap : r.left - vr.left - gap - pop.offsetWidth;
  const maxTop = window.innerHeight - vr.top - pop.offsetHeight - 12;
  pop.style.left = `${Math.max(0, left)}px`;
  pop.style.top = `${Math.max(0, Math.min(r.top - vr.top, maxTop))}px`;
  pop.style.visibility = "visible";
  pop.classList.toggle("from-left", !right);
}

function closeValDetail() {
  state.validation.selected = null;
  state.validation.mode = "popover";
  renderValidation();
}

function wireValDetail() {
  list.querySelectorAll("[data-url]").forEach((b) =>
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      window.monstro.openExternal(b.dataset.url);
    }),
  );
  list.querySelectorAll("[data-val-close]").forEach((b) => b.addEventListener("click", closeValDetail));
  list.querySelector("[data-val-dock]")?.addEventListener("click", () => {
    state.validation.mode = "dock";
    state.validation.tab = null;
    renderValidation();
  });
  list.querySelectorAll("[data-val-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      state.validation.tab = b.dataset.valTab;
      renderValidation();
    }),
  );
  list.querySelectorAll("[data-val-next]").forEach((b) => b.addEventListener("click", () => confirmValidationMove(valSelectedCard(), Number(b.dataset.valNext))));
  list.querySelectorAll("[data-val-merge]").forEach((b) => b.addEventListener("click", () => confirmValidationMerge(valSelectedCard())));
  list.querySelectorAll("[data-prod]").forEach((b) => b.addEventListener("click", () => confirmValidationProd(b.dataset.prod)));
  if (valDocListeners) return;
  valDocListeners = true;
  // Esc cierra la ficha/el panel; un clic fuera de la ficha (y de las tarjetas) la cierra.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.view === "validation" && state.validation.selected && !$("#modal-root").innerHTML) closeValDetail();
  });
  document.addEventListener("mousedown", (event) => {
    const v = state.validation;
    if (state.view !== "validation" || v.mode !== "popover" || !v.selected) return;
    if (event.target.closest("#val-pop, .val-card, #modal-root")) return;
    closeValDetail();
  });
  window.addEventListener("resize", positionValPopover);
}

/**
 * Confirmación de un paso a producción de una MR mergeada. Una tag se crea sobre un commit de
 * development, así que se lleva TODO lo mergeado antes en ese repo; desplegar una tag despliega todas
 * las MRs que contiene. Se listan para que no sea una sorpresa.
 */
function confirmValidationProd(key) {
  const m = valAllMrs().find((x) => x.key === key);
  const a = m?.prodPlan?.actions[0];
  if (!a) return;
  const publish = a.job === "publicar-tag-produccion";
  const others = valAllMrs().filter(
    (o) => o.merged && o.repo === m.repo && o.key !== m.key && (publish ? !o.prod.tag && o.mergedAt < m.mergedAt : o.prod.tag === m.prod.tag),
  );
  const title = publish ? t("Publicar tag de producción de !{n}", { n: m.iid }) : t("Desplegar {tag} en producción ES", { tag: m.prod.tag });
  const what = publish
    ? t("Lanza publicar-tag-produccion en el pipeline de development del merge de !{n} ({repo}): crea la siguiente tag YYYY.MM.N sobre ese commit. Desplegar es un paso aparte.", { n: m.iid, repo: valProject(m.repo) })
    : t("Lanza {job} en el pipeline de la tag {tag} ({repo}).", { job: a.job, tag: m.prod.tag, repo: valProject(m.repo) });
  $("#modal-root").innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal val-modal">
        <h3>${esc(title)}</h3>
        <p>${esc(what)}</p>
        ${others.length ? `<p class="val-warn-text">${t("También lleva a producción:")}</p><div class="val-plan">${others.map((o) => `<div class="val-plan-row">${icon("git-merge")}!${o.iid} · ${esc(o.title)}</div>`).join("")}</div>` : ""}
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${publish ? t("Publicar tag") : t("Desplegar")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", closeValModal);
  $("#modal-backdrop").addEventListener("click", (event) => event.target.id === "modal-backdrop" && closeValModal());
  $("#modal-confirm").addEventListener("click", async () => {
    closeValModal();
    const label = publish ? t("publicar-tag-produccion de !{n}", { n: m.iid }) : t("{job} de la tag {tag}", { job: a.job, tag: m.prod.tag });
    let result;
    try {
      await window.monstro.validationAct(m.repo, m.iid, a.kind, a.jobId);
      result = { label, ok: true };
    } catch (err) {
      result = { label, ok: false, error: String(err.message || err) };
    }
    showValidationResults([result]);
    await loadValidation();
  });
}
