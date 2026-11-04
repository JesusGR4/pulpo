"use strict";

// Vista de Validación (solo GitLab): tablero Sin aprobar → Aprobada → En pruebas → Probada con las
// tareas (y sus MRs) de los repos configurados. La columna la decide el main (src/validation-rules.js)
// con el Approve de GitLab y los jobs de delivery-flow; una tarea va con su MR más atrasada.
// Arrastrar hacia delante (o el botón del panel) abre SIEMPRE una confirmación con lo que se va a
// ejecutar en GitLab, MR a MR y sin atomicidad; hacia atrás no se puede.

const VAL_STAGES = [
  { key: "unapproved", label: "Sin aprobar", ico: "circle-dashed", hint: "Código pendiente de revisión" },
  { key: "approved", label: "Aprobada", ico: "circle-check", hint: "Al soltar: Approve en GitLab" },
  { key: "testing", label: "En pruebas", ico: "flask-conical", hint: "Al soltar: Approve + aprobar-para-probar" },
  { key: "tested", label: "Probada", ico: "badge-check", hint: "Validada por QA · falta el merge" },
];

const VAL_WARNINGS = {
  draft: "Draft",
  "no-pipeline": "sin pipeline",
  "no-flow": "sin flujo de QA",
  "gate-failed": "aprobar-para-probar falló",
  "deploy-failed": "el despliegue en dev falló",
  "validate-failed": "la validación de QA falló",
  "no-approve": "sin Approve",
};

const VAL_BLOCKED = {
  "no-flow": "su pipeline no tiene flujo de QA",
  draft: "está en Draft",
  "missing-job": "su pipeline no tiene ese job",
  "job-waiting": "el job espera a un paso anterior del pipeline",
  "job-busy": "el job ya está en marcha",
  "job-unavailable": "el job no se puede lanzar",
  "not-in-dev": "aún no está desplegada en dev",
};

const VAL_SUB = { deploying: "desplegando", "in-dev": "en dev", "deploy-failed": "despliegue fallido" };

let valDragKey = null;

async function enterValidation() {
  if (!isGitlab()) {
    toast(t("La vista de Validación solo está disponible en GitLab"), "");
    return;
  }
  state.view = "validation";
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $("#bucket-validacion")?.classList.add("active");
  await loadValidation();
}

async function loadValidation() {
  const v = state.validation;
  v.loading = true;
  renderValidation();
  try {
    const res = await window.monstro.validationBoard();
    v.cards = res.cards;
    v.errors = res.errors || [];
    if (v.selected && !v.cards.some((c) => c.key === v.selected)) v.selected = null;
    if (v.selftestDetail) v.selected = [...v.cards].sort((a, b) => b.mrs.length - a.mrs.length)[0]?.key || null;
  } catch (err) {
    v.cards = [];
    v.errors = [{ repo: "", error: String(err.message || err) }];
  }
  v.loading = false;
  renderValidation();
}

const valCard = (key) => state.validation.cards?.find((c) => c.key === key) || null;
function valIssueRef(url) {
  const n = /\/-\/(?:issues|work_items)\/(\d+)/.exec(url || "")?.[1];
  return n ? `#${n}` : "";
}
const valProject = (repo) => repo.split("/").pop();

function valWarnings(mr) {
  return mr.warnings.map((w) => `<span class="val-warn val-warn-${w}">${esc(t(VAL_WARNINGS[w] || w))}</span>`).join("");
}

function valCardHtml(card) {
  const sel = state.validation.selected === card.key;
  const top = card.task
    ? `<span class="val-ref">${esc(valIssueRef(card.task.url))}</span>`
    : `<span class="val-loose">${t("Sin tarea")}</span>`;
  const epic = card.epic ? `<span class="val-epic" title="${esc(card.epic.title)}">${icon("layers")}${esc(card.epic.title)}</span>` : "";
  const mrs = card.mrs
    .map(
      (m) => `<li class="val-mr">
        <span class="val-dot val-dot-${m.stage}" title="${esc(t(VAL_STAGES[m.stageIndex].label))}"></span>
        <span class="val-iid">!${m.iid}</span>
        <span class="val-repo">${esc(valProject(m.repo))}</span>
        ${m.warnings.length ? `<span class="val-mr-warn" title="${esc(m.warnings.map((w) => t(VAL_WARNINGS[w] || w)).join(" · "))}">${icon("triangle-alert")}</span>` : ""}
      </li>`,
    )
    .join("");
  return `<article class="val-card ${card.task ? "" : "loose"} ${sel ? "selected" : ""}" draggable="true" data-key="${esc(card.key)}">
    <div class="val-card-top">${icon("grip-vertical")}${top}${epic}</div>
    <div class="val-card-title">${esc(card.title)}</div>
    <ul class="val-mrs">${mrs}</ul>
  </article>`;
}

function valDetailHtml(card) {
  const idx = VAL_STAGES.findIndex((s) => s.key === card.stage);
  const steps = VAL_STAGES.map((s, i) => `<li class="${i <= idx ? `on val-step-${card.stage}` : ""}"><span></span>${t(s.label)}</li>`).join("");
  const job = (j) => (j ? `<span class="val-job val-job-${j.status}" title="${esc(j.status)}">${esc(j.name)}</span>` : "");
  const mrs = card.mrs
    .map((m) => {
      const jobs = m.flow ? [m.flowJobs.gate, m.flowJobs.deploy, m.flowJobs.validate] : [];
      return `<div class="val-dmr">
        <div class="val-dmr-head">
          <button class="val-link" data-url="${esc(m.url)}">!${m.iid}</button>
          <span class="val-repo">${esc(valProject(m.repo))}</span>
          <span class="val-stage val-stage-${m.stage}">${esc(t(VAL_STAGES[m.stageIndex].label))}${m.sub ? ` · ${esc(t(VAL_SUB[m.sub]))}` : ""}</span>
        </div>
        <div class="val-dmr-title">${esc(m.title)}</div>
        <div class="val-dmr-meta">
          <span>${icon("check")}${m.approvedBy.length ? esc(m.approvedBy.join(", ")) : t("sin Approve")}</span>
          ${m.pipeline?.url ? `<button class="val-link" data-url="${esc(m.pipeline.url)}">${icon("workflow")}${t("pipeline")}</button>` : ""}
          ${jobs.map(job).join("")}
        </div>
        ${m.warnings.length ? `<div class="val-dmr-warns">${valWarnings(m)}</div>` : ""}
      </div>`;
    })
    .join("");
  const next = idx < VAL_STAGES.length - 1 ? VAL_STAGES[idx + 1] : null;
  const actions = [
    next ? `<button class="btn btn-primary" id="val-next" data-target="${idx + 1}">${icon("arrow-right")}${t("Pasar a «{s}»", { s: t(next.label) })}</button>` : "",
    card.mrs.some((m) => m.stage === "tested") ? `<button class="btn btn-primary" id="val-merge">${icon("git-merge")}${t("Mergear")}</button>` : "",
    card.task ? `<button class="btn" id="val-task" data-url="${esc(card.task.url)}">${t("Abrir tarea")}</button>` : "",
  ].join("");
  return `<div class="val-detail-head">
      <button class="icon-btn val-detail-close" id="val-close" title="${t("Cerrar")}">${icon("x")}</button>
      <div class="val-detail-meta">${card.task ? `<span class="val-ref">${esc(valIssueRef(card.task.url))}</span>` : `<span class="val-loose">${t("Sin tarea")}</span>`}${card.epic ? `<span class="val-epic">${icon("layers")}${esc(card.epic.title)}</span>` : ""}</div>
      <h2>${esc(card.title)}</h2>
    </div>
    <ol class="val-steps">${steps}</ol>
    <div class="val-dmrs">${mrs}</div>
    <div class="val-detail-actions">${actions}</div>`;
}

function renderValidation() {
  if (state.view !== "validation") return;
  const v = state.validation;
  if (v.loading && !v.cards) {
    list.innerHTML = `<div class="loading">${t("Cargando MRs y pipelines…")}</div>`;
    return;
  }
  const cards = v.cards || [];
  const cols = VAL_STAGES.map((s) => {
    const mine = cards.filter((c) => c.stage === s.key);
    return `<section class="val-col val-col-${s.key}" data-stage="${s.key}">
      <header><span class="val-col-ico">${icon(s.ico)}</span>${t(s.label)}<span class="val-count">${mine.length}</span><small>${t(s.hint)}</small></header>
      <div class="val-col-body">${mine.map(valCardHtml).join("") || `<div class="val-empty">${t("Nada aquí")}</div>`}</div>
    </section>`;
  }).join("");
  const errors = v.errors.map((e) => `<div class="val-error">${icon("triangle-alert")}${esc(e.repo ? `${e.repo}: ${e.error}` : e.error)}</div>`).join("");
  const nMrs = cards.reduce((n, c) => n + c.mrs.length, 0);
  list.innerHTML = `<div class="val-view">
    <div class="val-head">
      <div><h1>${t("Validación")}</h1><span class="muted">${t("{c} tarjetas · {m} MRs abiertas hacia development", { c: cards.length, m: nMrs })}</span></div>
      <button class="icon-btn" id="val-refresh" title="${t("Recargar")}">${icon("refresh-cw", v.loading ? "spin" : "")}</button>
    </div>
    ${errors}
    <div class="val-layout">
      <div class="val-board">${cols}</div>
      ${valCard(v.selected) ? `<aside class="val-detail">${valDetailHtml(valCard(v.selected))}</aside>` : ""}
    </div>
  </div>`;
  wireValidation();
}

function wireValidation() {
  $("#val-refresh")?.addEventListener("click", () => loadValidation());
  $("#val-close")?.addEventListener("click", () => {
    state.validation.selected = null;
    renderValidation();
  });
  list.querySelectorAll(".val-link, #val-task").forEach((b) => b.addEventListener("click", () => window.monstro.openExternal(b.dataset.url)));
  list.querySelectorAll(".val-card").forEach((el) => {
    el.addEventListener("click", () => {
      state.validation.selected = el.dataset.key;
      renderValidation();
    });
    el.addEventListener("dragstart", (event) => {
      valDragKey = el.dataset.key;
      event.dataTransfer.setData("text/plain", el.dataset.key);
      event.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => {
      valDragKey = null;
      el.classList.remove("dragging");
    });
  });
  list.querySelectorAll(".val-col").forEach((col) => {
    const target = VAL_STAGES.findIndex((s) => s.key === col.dataset.stage);
    // Solo hacia delante: si la columna no es posterior, no se acepta el drop.
    const accepts = () => {
      const card = valCard(valDragKey);
      return card && target > VAL_STAGES.findIndex((s) => s.key === card.stage);
    };
    col.addEventListener("dragover", (event) => {
      if (!accepts()) return;
      event.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", (event) => {
      event.preventDefault();
      col.classList.remove("drag-over");
      const card = valCard(event.dataTransfer.getData("text/plain"));
      if (card) confirmValidationMove(card, target);
    });
  });
  $("#val-next")?.addEventListener("click", (event) => confirmValidationMove(valCard(state.validation.selected), Number(event.currentTarget.dataset.target)));
  $("#val-merge")?.addEventListener("click", () => confirmValidationMerge(valCard(state.validation.selected)));
}

function valActionLabel(a, m) {
  const mr = `!${m.iid} ${valProject(m.repo)}`;
  if (a.kind === "approve") return t("Approve de {mr}", { mr });
  if (a.kind === "retry") return t("Reintentar {job} en {mr}", { job: a.job, mr });
  return t("Lanzar {job} en {mr}", { job: a.job, mr });
}

function closeValModal() {
  $("#modal-root").innerHTML = "";
}

// Confirmación: lista de acciones (marcadas, desmarcables) y de MRs que no pueden llegar (por qué).
function confirmValidationMove(card, target) {
  if (!card) return;
  const items = [];
  const blocked = [];
  for (const m of card.mrs) {
    const plan = m.toward[target];
    plan.actions.forEach((a) => items.push({ m, a }));
    if (plan.blocked) blocked.push(`!${m.iid} ${valProject(m.repo)}: ${t(VAL_BLOCKED[plan.blocked] || plan.blocked)}`);
  }
  const stage = t(VAL_STAGES[target].label);
  if (!items.length) {
    toast(blocked.length ? t("No se puede pasar a «{s}»: {why}", { s: stage, why: blocked.join(" · ") }) : t("Nada que hacer"), "err");
    return;
  }
  $("#modal-root").innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal val-modal">
        <h3>${t("Mover a «{s}»", { s: stage })}</h3>
        <p>${esc(card.title)} · ${t("se ejecuta en GitLab, una acción tras otra")}</p>
        <div class="val-plan">
          ${items.map((it, i) => `<label class="val-plan-row"><input type="checkbox" data-i="${i}" checked />${esc(valActionLabel(it.a, it.m))}</label>`).join("")}
          ${blocked.map((b) => `<div class="val-plan-row blocked">${icon("ban")}${esc(b)}</div>`).join("")}
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Ejecutar")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", closeValModal);
  $("#modal-backdrop").addEventListener("click", (event) => event.target.id === "modal-backdrop" && closeValModal());
  $("#modal-confirm").addEventListener("click", async () => {
    const chosen = [...document.querySelectorAll(".val-plan input:checked")].map((el) => items[Number(el.dataset.i)]);
    closeValModal();
    const failedMrs = new Set();
    const results = [];
    for (const { m, a } of chosen) {
      const label = valActionLabel(a, m);
      // Si una acción de esta MR falla, las siguientes de la misma MR no tienen sentido.
      if (failedMrs.has(m.key)) {
        results.push({ label, ok: false, error: t("omitida: falló la acción anterior de esta MR") });
        continue;
      }
      try {
        await window.monstro.validationAct(m.repo, m.iid, a.kind, a.jobId);
        results.push({ label, ok: true });
      } catch (err) {
        failedMrs.add(m.key);
        results.push({ label, ok: false, error: String(err.message || err) });
      }
    }
    showValidationResults(results);
    await loadValidation();
  });
}

function confirmValidationMerge(card) {
  const ready = (card?.mrs || []).filter((m) => m.stage === "tested");
  if (!ready.length) return;
  $("#modal-root").innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal val-modal">
        <h3>${t("Mergear {n} MRs", { n: ready.length })}</h3>
        <p>${t("Con <b>merge commit</b>, una tras otra.")}</p>
        <div class="val-plan">${ready.map((m) => `<div class="val-plan-row">${icon("git-merge")}!${m.iid} ${esc(valProject(m.repo))} · ${esc(m.branch)}</div>`).join("")}</div>
        <label><input type="checkbox" id="del-branch" checked /> ${t("Borrar la rama tras el merge")}</label>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-confirm">${t("Confirmar merge")}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", closeValModal);
  $("#modal-backdrop").addEventListener("click", (event) => event.target.id === "modal-backdrop" && closeValModal());
  $("#modal-confirm").addEventListener("click", async () => {
    const deleteBranch = $("#del-branch").checked;
    closeValModal();
    const results = [];
    for (const m of ready) {
      const label = `!${m.iid} ${valProject(m.repo)}`;
      try {
        const res = await window.monstro.mergePR({ repo: m.repo, number: m.iid, deleteBranch, headRefName: m.branch, isCrossRepository: false });
        results.push({ label, ok: !!res.merged, error: res.merged ? "" : t("Merge no completado") });
      } catch (err) {
        results.push({ label, ok: false, error: String(err.message || err) });
      }
    }
    showValidationResults(results);
    await loadValidation();
  });
}

function showValidationResults(results) {
  const okCount = results.filter((r) => r.ok).length;
  $("#modal-root").innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal val-modal">
        <h3>${okCount === results.length ? t("Hecho") : t("{ok} de {n} acciones hechas", { ok: okCount, n: results.length })}</h3>
        <div class="val-plan">${results
          .map((r) => `<div class="val-plan-row ${r.ok ? "ok" : "err"}">${icon(r.ok ? "circle-check" : "circle-x")}<span>${esc(r.label)}${r.error ? ` · ${esc(r.error)}` : ""}</span></div>`)
          .join("")}</div>
        <div class="modal-actions"><button class="btn btn-primary" id="modal-cancel">${t("Cerrar")}</button></div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", closeValModal);
}
