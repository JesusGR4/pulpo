"use strict";

/* ============ estado ============ */
const IS_SELFTEST = new URLSearchParams(location.search).get("selftest") === "1";
const SELFTEST_ROUTE = new URLSearchParams(location.search).get("selftest_route") || "list";

const state = {
  config: null,
  me: null,
  authSource: null,
  repo: null,
  view: "prs", // "prs" | "history" | "milestones"
  bucket: "open",
  prs: [],
  openPrs: [],
  selected: null,
  detailRepo: null, // repo real del PR abierto (difiere de state.repo en la vista "Todos")
  detailTab: "conv", // "conv" | "changes"
  detailPR: null,
  conversation: null,
  files: null,
  drafts: [], // borradores locales del PR abierto (no tocan GitHub hasta publicar)
  search: "",
  loading: false,
  pollTimer: null,
  selftestNotified: false,
  selftestOpenedDetail: false,
  history: { branches: [], enabled: new Set(), layout: null, rows: [], loading: false, selectedOid: null },
  // Vista de Milestones (solo GitLab): tareas (issues) del milestone agrupadas por persona.
  // filters.status: Map<label, "include"|"exclude"> (chip tri-estado); se siembra con doneLabels en "exclude".
  milestones: { list: [], selectedTitle: null, issues: [], loading: false, labels: [], selected: new Set(), filters: { status: new Map(), showClosed: false, showUnassigned: false, seeded: false } },
  prSnapshot: null, // nº → {reviewDecision, checks, reviewMe} para detectar cambios y notificar
  cursor: -1, // selección con teclado (j/k) en la lista
  draftKeys: new Set(), // "owner/repo#n" con borradores guardados → badge 📝 en la lista
  aiGenerating: null, // nº de PR con review IA en curso → el botón persiste en loading entre pestañas
  draftNavIndex: -1, // navegación ↑↓ entre borradores
  editingDraftId: null, // borrador en edición → su tarjeta se pinta como editor
};

const $ = (sel) => document.querySelector(sel);
const list = $("#pr-list");
const detailPane = $("#detail-pane");
const detailContent = $("#detail-content");

/* ============ utilidades ============ */
function esc(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

/* ============ proveedor (GitHub | GitLab) ============ */
const isGitlab = () => state.config?.provider === "gitlab";
const providerName = () => (isGitlab() ? "GitLab" : "GitHub");
// GitLab admite paths anidados (group/sub/project); GitHub solo owner/repo.
const repoRe = () => (isGitlab() ? /^[\w.-]+(\/[\w.-]+)+$/ : /^[\w.-]+\/[\w.-]+$/);
const repoPlaceholder = () => (isGitlab() ? "group/subgroup/project" : "owner/repo");
// Pre-validación de nombres de rama (UX); el backend valida con la misma regla en main.js.
const BRANCH_RE = /^[\w./-]{1,200}$/;

function timeAgo(iso) {
  const seconds = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  const units = [[31536000, "a"], [2592000, "mes"], [604800, "sem"], [86400, "d"], [3600, "h"], [60, "min"]];
  for (const [div, label] of units) {
    if (seconds >= div) {
      const v = Math.floor(seconds / div);
      return `hace ${v} ${label}${label === "mes" && v > 1 ? "es" : ""}`;
    }
  }
  return "ahora";
}

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast("Copiado", "ok"),
    () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("Copiado", "ok");
    },
  );
}

function notifySelftestOnce() {
  if (!state.selftestNotified) {
    state.selftestNotified = true;
    window.pulpo.selftestRenderComplete();
  }
}

const ALL_REPOS = "__all__";

function detailRepo() {
  return state.detailRepo || state.repo;
}

/* ============ borradores ============ */
function draftsKey() {
  return `${detailRepo()}#${state.selected}`;
}

async function saveDrafts() {
  state.drafts = await window.pulpo.draftsSave(draftsKey(), state.drafts);
  state.draftKeys = new Set(await window.pulpo.draftsKeys());
}

async function addDraft(draft) {
  const id = globalThis.crypto?.randomUUID?.() || `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.drafts.push({ id, createdAt: new Date().toISOString(), ...draft });
  await saveDrafts();
  toast("Borrador guardado (solo en tu Mac)", "ok");
}

async function removeDraft(id) {
  state.drafts = state.drafts.filter((d) => d.id !== id);
  await saveDrafts();
}

function draftCard(draft) {
  const where = draft.kind === "inline"
    ? `<code>${esc(draft.path)}</code> · línea ${draft.line} (${draft.side === "LEFT" ? "anterior" : "nueva"})`
    : "comentario general";
  if (state.editingDraftId === draft.id) {
    return `
      <div class="draft-card ${draft.ai ? "ai" : ""} editing" data-draft="${draft.id}">
        <div class="draft-head">✏️ EDITANDO <span class="muted">· ${where}</span></div>
        <textarea class="draft-editor" rows="5">${esc(draft.body)}</textarea>
        <div class="composer-actions">
          <button class="btn draft-edit-cancel">Cancelar</button>
          <button class="btn btn-accent draft-edit-save">Guardar</button>
        </div>
      </div>`;
  }
  const aiMeta = draft.ai && draft.aiModel
    ? ` · ${esc(draft.aiModel)}${draft.aiEffort ? ` · esfuerzo ${esc(draft.aiEffort)}` : ""}`
    : "";
  return `
    <div class="draft-card ${draft.ai ? "ai" : ""}" data-draft="${draft.id}">
      <div class="draft-head">${draft.ai ? "🤖 BORRADOR (IA)" : "📝 BORRADOR"} <span class="muted">· ${where}${aiMeta}</span>
        <button class="draft-edit" title="Editar borrador">✏️</button>
        <button class="draft-pub" title="Publicar solo este borrador en GitHub">↗ Publicar</button>
        <button class="draft-del" title="Eliminar borrador">🗑</button>
      </div>
      <div class="draft-body">${esc(draft.body)}</div>
    </div>`;
}

/* ============ review con IA ============ */
async function generateAiReview(pr) {
  if (state.aiGenerating) return;
  state.aiGenerating = pr.number;
  renderDetail(); // pinta el botón en loading; persiste aunque cambies de pestaña
  toast("Generando review con IA… esto puede tardar un par de minutos", "");
  const repoKey = `${detailRepo()}#${pr.number}`;
  try {
    const files = state.selected === pr.number && state.files
      ? state.files
      : await window.pulpo.prFiles(repoKey.split("#")[0], pr.number);
    if (state.selected === pr.number) state.files = files;
    const { review, backend, model, effort } = await window.pulpo.aiReview(pr.title, pr.body || "", files);

    const anchors = new Set();
    for (const file of files) {
      if (!file.patch) continue;
      for (const line of parsePatch(file.patch)) {
        if (line.type === "add" || line.type === "ctx") anchors.add(`${file.filename}::RIGHT::${line.new}`);
        if (line.type === "del" || line.type === "ctx") anchors.add(`${file.filename}::LEFT::${line.old}`);
      }
    }
    const newDrafts = [];
    const orphaned = [];
    for (const comment of review.comments) {
      if (anchors.has(`${comment.path}::${comment.side}::${comment.line}`)) {
        newDrafts.push({
          id: `ai-${Date.now()}-${newDrafts.length}`,
          createdAt: new Date().toISOString(),
          kind: "inline",
          ai: true,
          aiModel: model,
          aiEffort: effort || null,
          path: comment.path,
          side: comment.side,
          line: comment.line,
          body: comment.body,
        });
      } else {
        orphaned.push(comment);
      }
    }
    const summaryParts = [];
    if (review.summary) summaryParts.push(review.summary);
    if (orphaned.length) {
      summaryParts.push(
        "Comments that could not be anchored to a diff line:\n" +
          orphaned.map((c) => `- **${c.path}:${c.line}** — ${c.body}`).join("\n"),
      );
    }
    if (summaryParts.length) {
      newDrafts.push({
        id: `ai-${Date.now()}-summary`,
        createdAt: new Date().toISOString(),
        kind: "general",
        ai: true,
        aiModel: model,
        aiEffort: effort || null,
        body: summaryParts.join("\n\n---\n\n"),
      });
    }

    // Guarda en la PR que pidió la review, aunque ya estés mirando otra.
    if (state.selected === pr.number) {
      state.drafts.push(...newDrafts);
      await saveDrafts();
      state.detailTab = "changes";
    } else {
      const existing = await window.pulpo.draftsList(repoKey);
      await window.pulpo.draftsSave(repoKey, [...existing, ...newDrafts]);
      state.draftKeys = new Set(await window.pulpo.draftsKeys());
      renderList();
    }
    toast(`IA (${backend} · ${model}${effort ? ` · ${effort}` : ""}): ${newDrafts.length - (summaryParts.length ? 1 : 0)} comentario(s) en línea + resumen, en borradores de #${pr.number}`, "ok");
  } catch (err) {
    toast(`Review con IA falló: ${String(err.message || err)}`, "err");
  } finally {
    state.aiGenerating = null;
    // re-render solo si sigues mirando esa PR (puede haber cambiado mientras generaba)
    if (state.selected === pr.number && state.detailPR) renderDetail();
  }
}

function wireDraftCards(container) {
  container.querySelectorAll(".draft-card .draft-del").forEach((btn) =>
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await removeDraft(btn.closest(".draft-card").dataset.draft);
      renderDetail();
    }),
  );
  container.querySelectorAll(".draft-card .draft-pub").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const draft = state.drafts.find((d) => d.id === btn.closest(".draft-card").dataset.draft);
      if (draft) confirmPublishSingle(draft);
    }),
  );
  container.querySelectorAll(".draft-card .draft-edit").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      state.editingDraftId = btn.closest(".draft-card").dataset.draft;
      renderDetail();
      detailContent.querySelector(".draft-editor")?.focus();
    }),
  );
  container.querySelectorAll(".draft-card.editing").forEach((card) => {
    const id = card.dataset.draft;
    card.querySelector(".draft-edit-cancel").addEventListener("click", () => {
      state.editingDraftId = null;
      renderDetail();
    });
    card.querySelector(".draft-edit-save").addEventListener("click", async () => {
      const body = card.querySelector(".draft-editor").value.trim();
      const draft = state.drafts.find((d) => d.id === id);
      if (draft && body) {
        draft.body = body;
        await saveDrafts();
        toast("Borrador actualizado", "ok");
      }
      state.editingDraftId = null;
      renderDetail();
    });
  });
}

function confirmPublishSingle(draft) {
  const root = $("#modal-root");
  const where = draft.kind === "inline" ? `${draft.path}:${draft.line}` : "comentario general";
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>↗ Publicar este borrador</h3>
        <p class="muted">${esc(where)} — se publica como comentario (sin veredicto). El resto de borradores no se tocan.</p>
        <div class="draft-card ${draft.ai ? "ai" : ""}" style="max-height:180px;overflow-y:auto"><div class="draft-body">${esc(draft.body)}</div></div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Publicar en GitHub</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    root.innerHTML = "";
    try {
      state.conversation = await window.pulpo.prConversation(detailRepo(), state.selected);
      await window.pulpo.submitReview(detailRepo(), state.selected, {
        commitId: state.conversation.headRefOid,
        event: "COMMENT",
        body: draft.kind === "general" ? draft.body : undefined,
        comments: draft.kind === "inline" ? [draft] : [],
      });
      await removeDraft(draft.id);
      toast("Borrador publicado ✓", "ok");
      state.conversation = await window.pulpo.prConversation(detailRepo(), state.selected);
      renderDetail();
    } catch (err) {
      toast(`No se pudo publicar (el borrador sigue guardado): ${String(err.message || err)}`, "err");
    }
  });
}

function draftsBar() {
  if (!state.drafts.length) return "";
  return `
    <div class="drafts-bar">
      <button class="drafts-count" id="drafts-view" title="Ver todos los borradores">📝 <b>${state.drafts.length}</b> borrador${state.drafts.length > 1 ? "es" : ""} sin publicar</button>
      <button class="icon-btn" id="drafts-prev" title="Borrador anterior">↑</button>
      <button class="icon-btn" id="drafts-next" title="Borrador siguiente">↓</button>
      <span style="flex:1"></span>
      <button class="btn" id="drafts-discard">Descartar todos</button>
      <button class="btn btn-primary" id="drafts-publish">Publicar…</button>
    </div>`;
}

function wireDraftsBar() {
  $("#drafts-publish")?.addEventListener("click", openPublishModal);
  $("#drafts-view")?.addEventListener("click", openDraftsViewer);
  $("#drafts-prev")?.addEventListener("click", () => navigateDrafts(-1));
  $("#drafts-next")?.addEventListener("click", () => navigateDrafts(1));
  $("#drafts-discard")?.addEventListener("click", async () => {
    state.drafts = [];
    await saveDrafts();
    toast("Borradores descartados", "");
    renderDetail();
  });
}

/* ============ navegación y visor de borradores ============ */
function orderedDrafts() {
  const fileOrder = new Map((state.files || []).map((f, i) => [f.filename, i]));
  return [...state.drafts].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "inline" ? -1 : 1;
    if (a.kind === "inline") {
      const byFile = (fileOrder.get(a.path) ?? 999) - (fileOrder.get(b.path) ?? 999);
      if (byFile) return byFile;
      return (a.line || 0) - (b.line || 0);
    }
    return 0;
  });
}

async function scrollToDraft(id) {
  const draft = state.drafts.find((d) => d.id === id);
  if (!draft) return;
  const wantedTab = draft.kind === "inline" ? "changes" : "conv";
  if (state.detailTab !== wantedTab) {
    state.detailTab = wantedTab;
    renderDetail();
  }
  // el tab de cambios puede estar cargando el diff: reintenta hasta encontrar la tarjeta
  for (let attempt = 0; attempt < 25; attempt++) {
    const node = detailContent.querySelector(`[data-draft="${CSS.escape(id)}"]`);
    if (node) {
      const fold = node.closest("details");
      if (fold && !fold.open) fold.open = true;
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("flash");
      setTimeout(() => node.classList.remove("flash"), 1600);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function navigateDrafts(direction) {
  const drafts = orderedDrafts();
  if (!drafts.length) return;
  state.draftNavIndex = (state.draftNavIndex + direction + drafts.length) % drafts.length;
  const target = drafts[state.draftNavIndex];
  toast(`Borrador ${state.draftNavIndex + 1} de ${drafts.length}`, "");
  scrollToDraft(target.id);
}

function openDraftsViewer() {
  const root = $("#modal-root");
  const drafts = orderedDrafts();
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal modal-wide">
        <h3>📝 Borradores de #${state.selected} (${drafts.length})</h3>
        <div class="drafts-viewer">
          ${drafts.map((d) => `
            <div class="viewer-row" data-id="${d.id}">
              <div class="viewer-where">${d.ai ? "🤖" : "📝"} ${d.kind === "inline"
                ? `<code>${esc(d.path)}</code>:${d.line} <span class="muted">(${d.side === "LEFT" ? "anterior" : "nueva"})</span>`
                : `<span class="muted">comentario general</span>`}</div>
              <div class="viewer-body">${esc(d.body.length > 220 ? `${d.body.slice(0, 220)}…` : d.body)}</div>
              <div class="viewer-actions">
                <button class="btn viewer-go" data-id="${d.id}">Ir ↗</button>
                <button class="btn viewer-edit" data-id="${d.id}" title="Editar borrador">✏️</button>
                <button class="btn viewer-pub" data-id="${d.id}" title="Publicar solo este borrador">Publicar</button>
                <button class="btn viewer-del" data-id="${d.id}">🗑</button>
              </div>
            </div>`).join("")}
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cerrar</button>
          <button class="btn" id="viewer-discard">Descartar todos</button>
          <button class="btn btn-primary" id="viewer-publish">Publicar…</button>
        </div>
      </div>
    </div>`;
  const close = () => (root.innerHTML = "");
  $("#modal-cancel").addEventListener("click", close);
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") close();
  });
  $("#viewer-publish").addEventListener("click", () => {
    close();
    openPublishModal();
  });
  $("#viewer-discard").addEventListener("click", async () => {
    close();
    state.drafts = [];
    await saveDrafts();
    toast("Borradores descartados", "");
    renderDetail();
  });
  root.querySelectorAll(".viewer-go").forEach((btn) =>
    btn.addEventListener("click", () => {
      close();
      scrollToDraft(btn.dataset.id);
    }),
  );
  root.querySelectorAll(".viewer-pub").forEach((btn) =>
    btn.addEventListener("click", () => {
      const draft = state.drafts.find((d) => d.id === btn.dataset.id);
      close();
      if (draft) confirmPublishSingle(draft);
    }),
  );
  root.querySelectorAll(".viewer-edit").forEach((btn) =>
    btn.addEventListener("click", () => {
      close();
      state.editingDraftId = btn.dataset.id;
      scrollToDraft(btn.dataset.id);
    }),
  );
  root.querySelectorAll(".viewer-del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await removeDraft(btn.dataset.id);
      renderDetail();
      if (state.drafts.length) openDraftsViewer();
      else close();
    }),
  );
}

function openPublishModal() {
  const root = $("#modal-root");
  const inline = state.drafts.filter((d) => d.kind === "inline");
  const general = state.drafts.filter((d) => d.kind === "general");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>Publicar ${state.drafts.length} borrador${state.drafts.length > 1 ? "es" : ""} como review</h3>
        <p class="muted">${inline.length} en línea · ${general.length} general${general.length === 1 ? "" : "es"} — se publican en una sola review.</p>
        <div class="verdict">
          <label><input type="radio" name="verdict" value="COMMENT" checked /> 💬 Comentar</label>
          <label><input type="radio" name="verdict" value="APPROVE" /> ✅ Aprobar</label>
          <label><input type="radio" name="verdict" value="REQUEST_CHANGES" /> ± Pedir cambios</label>
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Publicar en GitHub</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    const event = root.querySelector('input[name="verdict"]:checked').value;
    root.innerHTML = "";
    await publishDrafts(event);
  });
}

async function publishDrafts(event) {
  const pr = state.detailPR;
  try {
    // headRefOid fresco: si la rama avanzó, los comentarios se anclan al último commit
    state.conversation = await window.pulpo.prConversation(detailRepo(), pr.number);
    const inline = state.drafts.filter((d) => d.kind === "inline");
    const general = state.drafts.filter((d) => d.kind === "general");
    await window.pulpo.submitReview(detailRepo(), pr.number, {
      commitId: state.conversation.headRefOid,
      event,
      body: general.map((d) => d.body).join("\n\n---\n\n") || undefined,
      comments: inline,
    });
    state.drafts = [];
    await saveDrafts();
    toast(`Review publicada (${event === "APPROVE" ? "aprobada ✅" : event === "REQUEST_CHANGES" ? "cambios pedidos" : "comentarios"})`, "ok");
    state.conversation = await window.pulpo.prConversation(detailRepo(), pr.number);
    renderDetail();
  } catch (err) {
    toast(`No se pudo publicar (tus borradores siguen guardados): ${String(err.message || err)}`, "err");
  }
}

/* ============ chips ============ */
function stateChip(pr) {
  if (pr.state === "MERGED") return `<span class="chip chip-merged">Fusionada</span>`;
  if (pr.state === "CLOSED") return `<span class="chip chip-closed">Cerrada</span>`;
  if (pr.isDraft) return `<span class="chip chip-draft">Borrador</span>`;
  return `<span class="chip chip-open">Abierta</span>`;
}

function reviewChip(pr) {
  if (pr.state !== "OPEN") return "";
  switch (pr.reviewDecision) {
    case "APPROVED": return `<span class="chip chip-approved">✓ Aprobada</span>`;
    case "CHANGES_REQUESTED": return `<span class="chip chip-changes">± Cambios pedidos</span>`;
    case "REVIEW_REQUIRED": return `<span class="chip chip-review">Falta revisión</span>`;
    default: return "";
  }
}

function mergeStateChip(pr) {
  if (pr.state !== "OPEN") return "";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")
    return `<span class="chip chip-conflict">Conflictos</span>`;
  if (pr.mergeStateStatus === "BEHIND") return `<span class="chip chip-behind">Rama atrasada</span>`;
  return "";
}

function checksIcon(pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup) return "";
  const map = {
    SUCCESS: ["✓", "checks-success", "Checks en verde"],
    FAILURE: ["✗", "checks-failure", "Checks fallando"],
    ERROR: ["✗", "checks-failure", "Checks con error"],
    PENDING: ["●", "checks-pending", "Checks en curso"],
    EXPECTED: ["●", "checks-pending", "Checks esperados"],
  };
  const [icon, cls, title] = map[rollup.state] || ["", "", ""];
  return icon ? `<span class="checks ${cls}" title="${title}">${icon}</span>` : "";
}

/** Avatares con tick verde de quienes han aprobado (estilo Bitbucket). */
function approvalFaces(pr) {
  const approvers = [];
  const seen = new Set();
  for (const review of pr.latestReviews?.nodes || []) {
    if (review.state !== "APPROVED" || !review.author || seen.has(review.author.login)) continue;
    seen.add(review.author.login);
    approvers.push(review.author);
  }
  if (!approvers.length) return "";
  const MAX_FACES = 4;
  const shown = approvers.slice(0, MAX_FACES);
  const extra = approvers.length - shown.length;
  return `
    <span class="facepile" title="Aprobada por ${esc(approvers.map((a) => a.login).join(", "))}">
      ${shown.map((a) => `
        <span class="face">
          <img src="${esc(a.avatarUrl)}" alt="${esc(a.login)}" />
          <span class="face-tick">✓</span>
        </span>`).join("")}
      ${extra > 0 ? `<span class="face face-more">+${extra}</span>` : ""}
    </span>`;
}

function labelPills(pr) {
  return (pr.labels?.nodes || [])
    .map((l) => `<span class="label-pill" style="background:#${l.color}22;color:#${l.color}">${esc(l.name)}</span>`)
    .join("");
}

/* ============ lista de PRs ============ */
function bucketFilter(prs) {
  const login = state.me?.login;
  switch (state.bucket) {
    case "mine": return prs.filter((p) => p.author?.login === login);
    case "review":
      return prs.filter((p) => (p.reviewRequests?.nodes || []).some((n) => n.requestedReviewer?.login === login));
    case "draft": return prs.filter((p) => p.isDraft);
    default: return prs;
  }
}

function searchFilter(prs) {
  const q = state.search.trim().toLowerCase();
  if (!q) return prs;
  return prs.filter((p) =>
    [p.title, p.headRefName, p.baseRefName, p.author?.login, String(p.number)].join(" ").toLowerCase().includes(q),
  );
}

function renderCounts() {
  const open = state.openPrs;
  const login = state.me?.login;
  $("#count-open").textContent = open.length || "";
  $("#count-mine").textContent = open.filter((p) => p.author?.login === login).length || "";
  $("#count-review").textContent =
    open.filter((p) => (p.reviewRequests?.nodes || []).some((n) => n.requestedReviewer?.login === login)).length || "";
  $("#count-draft").textContent = open.filter((p) => p.isDraft).length || "";
}

function renderList() {
  if (state.view !== "prs") return;
  const prs = searchFilter(bucketFilter(state.prs));
  if (state.loading) {
    list.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    return;
  }
  if (!prs.length) {
    list.innerHTML = `<div class="empty"><span class="big">🐙</span>Nada por aquí. Mar en calma.</div>`;
    notifySelftestOnce();
    return;
  }
  list.innerHTML = prs
    .map(
      (pr) => `
      <article class="pr-row ${state.selected === pr.number ? "selected" : ""}" data-number="${pr.number}" data-repo="${esc(pr.repository?.nameWithOwner || state.repo)}">
        <img class="avatar" src="${esc(pr.author?.avatarUrl || "")}" alt="" />
        <div class="pr-title-line">
          ${state.repo === ALL_REPOS ? `<span class="label-pill repo-pill">${esc(pr.repository?.nameWithOwner || "")}</span>` : ""}
          <span class="pr-title">${esc(pr.title)} <span class="pr-number">#${pr.number}</span></span>
          ${labelPills(pr)}
        </div>
        <div class="pr-right">
          ${approvalFaces(pr)} ${checksIcon(pr)} ${reviewChip(pr)} ${mergeStateChip(pr)} ${stateChip(pr)}
        </div>
        <div class="pr-sub">
          <span class="branches">
            <span class="branch" title="${esc(pr.headRefName)}">${esc(pr.headRefName)}</span>
            <span class="arrow">→</span>
            <span class="branch" title="${esc(pr.baseRefName)}">${esc(pr.baseRefName)}</span>
          </span>
          <span class="meta-mini">${esc(pr.author?.login || "?")} · ${timeAgo(pr.updatedAt)} · <span class="checks-success">+${pr.additions ?? 0}</span>/<span class="checks-failure">−${pr.deletions ?? 0}</span> · 💬 ${pr.comments?.totalCount ?? 0}${state.draftKeys.has(`${pr.repository?.nameWithOwner || state.repo}#${pr.number}`) ? " · 📝 borradores" : ""}</span>
        </div>
      </article>`,
    )
    .join("");
  list.querySelectorAll(".pr-row").forEach((row) =>
    row.addEventListener("click", () => openDetail(Number(row.dataset.number), "conv", row.dataset.repo)),
  );

  if (IS_SELFTEST && !state.selftestOpenedDetail && prs.length && (SELFTEST_ROUTE === "list" || SELFTEST_ROUTE === "changes")) {
    state.selftestOpenedDetail = true;
    openDetail(prs[0].number, SELFTEST_ROUTE === "changes" ? "changes" : "conv");
  }
}

/* ============ detalle de PR: shell + tabs ============ */
function canMerge(pr) {
  return (
    pr.state === "OPEN" && !pr.isDraft && pr.mergeable === "MERGEABLE" &&
    ["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus)
  );
}

function mergeBlockReason(pr) {
  if (pr.state !== "OPEN") return "La PR no está abierta";
  if (pr.isDraft) return "Es un borrador";
  if (pr.mergeable === "CONFLICTING") return "Tiene conflictos con la base";
  if (pr.mergeStateStatus === "BEHIND") return "La rama está atrasada: actualiza primero (rebase)";
  if (pr.mergeStateStatus === "BLOCKED") return "Bloqueada por checks o revisiones requeridas";
  return "";
}

async function openDetail(number, tab = "conv", repoOverride = null) {
  state.selected = number;
  state.detailRepo = repoOverride && repoOverride !== ALL_REPOS ? repoOverride : state.repo;
  state.detailTab = tab;
  state.files = null;
  state.conversation = null;
  renderList();
  detailPane.classList.remove("hidden");
  detailPane.classList.toggle("wide", tab === "changes");
  detailContent.innerHTML = `<div class="detail-inner"><div class="loading">Cargando #${number}…</div></div>`;
  try {
    const [pr, conversation, drafts] = await Promise.all([
      window.pulpo.prDetail(detailRepo(), number),
      window.pulpo.prConversation(detailRepo(), number),
      window.pulpo.draftsList(`${detailRepo()}#${number}`),
    ]);
    state.detailPR = pr;
    state.conversation = conversation;
    state.drafts = drafts;
    // seed visual para capturas de selftest: no se persiste
    if (IS_SELFTEST && new URLSearchParams(location.search).get("seed_draft") === "1" && !state.drafts.length) {
      state.drafts.push({ id: "seed", kind: "general", body: "Esto es un borrador local: no está en GitHub.", createdAt: new Date().toISOString() });
      state.drafts.push({ id: "seed-ai", kind: "general", ai: true, aiModel: "claude-opus-4-8", aiEffort: "high", body: "AI draft seeded for screenshots.", createdAt: new Date().toISOString() });
    }
  } catch (err) {
    detailContent.innerHTML = `<div class="detail-inner"><div class="error-box">${esc(String(err.message || err))}</div></div>`;
    notifySelftestOnce();
    return;
  }
  renderDetail();
}

function renderDetail() {
  const pr = state.detailPR;
  if (!pr) return;
  const blockReason = mergeBlockReason(pr);
  const threadCount = state.conversation?.reviewThreads?.nodes?.length ?? 0;
  detailPane.classList.toggle("wide", state.detailTab === "changes");

  detailContent.innerHTML = `
    <div class="detail-inner ${state.detailTab === "changes" ? "detail-full" : ""}">
      <button class="detail-close" id="detail-close" title="Cerrar (Esc)">✕</button>
      <div class="detail-title">${esc(pr.title)} <span class="pr-number">#${pr.number}</span></div>
      <div class="detail-sub">
        ${stateChip(pr)} ${reviewChip(pr)} ${mergeStateChip(pr)}
        <span class="branches">
          <span class="branch">${esc(pr.headRefName)}</span><span class="arrow">→</span><span class="branch">${esc(pr.baseRefName)}</span>
        </span>
      </div>

      <div class="actions">
        <button class="btn btn-accent" id="act-update" ${pr.state !== "OPEN" ? "disabled" : ""}
                title="Actualiza la rama con la base usando rebase">⤴ Update branch (rebase)</button>
        <button class="btn btn-primary" id="act-merge" ${canMerge(pr) ? "" : "disabled"}
                title="${esc(blockReason || "Merge con merge commit")}">⇅ Merge (merge commit)</button>
        ${state.aiGenerating === pr.number
          ? `<button class="btn btn-ai" id="act-ai" disabled><span class="spinner"></span> Generando review…</button>`
          : `<button class="btn btn-ai" id="act-ai" ${pr.state === "OPEN" ? "" : "disabled"}
                title="Genera comentarios de review (en inglés) como borradores: nada se publica hasta que tú lo digas">🤖 Review con IA</button>`}
        ${myApprovedReview(pr) && pr.state === "OPEN"
          ? `<button class="btn" id="act-unapprove"
                title="Descarta tu review aprobada (GitHub lo registra en la PR con el motivo)">↩︎ Quitar aprobación</button>`
          : `<button class="btn" id="act-approve" ${pr.state === "OPEN" && pr.author?.login !== state.me?.login ? "" : "disabled"}
                title="${pr.author?.login === state.me?.login ? "No puedes aprobar tu propia PR" : "Aprobar sin comentarios (pide confirmación)"}">✅ Aprobar</button>`}
        ${pr.state === "OPEN" && pr.author?.login === state.me?.login
          ? `<button class="btn" id="act-draft-toggle" title="${pr.isDraft ? "Marca la PR como lista: notifica a los reviewers" : "Convierte la PR en borrador: deja de pedir reviews"}">${pr.isDraft ? "🚀 Marcar lista para review" : "↩︎ Convertir a borrador"}</button>`
          : ""}
      </div>
      <div class="copy-row">
        <button class="mini-btn" id="copy-branch" title="Copiar nombre de la rama">📋 ${esc(pr.headRefName)}</button>
        <button class="mini-btn" id="copy-checkout" title="Copiar comando para traerte la PR en local">⬇ gh pr checkout ${pr.number}</button>
        <button class="mini-btn" id="copy-url" title="Copiar URL de la PR">🔗 URL</button>
      </div>
      ${blockReason && pr.state === "OPEN" ? `<p class="muted">⚠️ ${esc(blockReason)}</p>` : ""}

      <div class="tabs">
        <button class="tab ${state.detailTab === "conv" ? "active" : ""}" data-tab="conv">
          Conversación <span class="count">${pr.comments?.totalCount ?? 0}</span>
        </button>
        <button class="tab ${state.detailTab === "changes" ? "active" : ""}" data-tab="changes">
          Cambios <span class="count">${pr.changedFiles} ficheros · ${threadCount} hilos${state.drafts.filter((d) => d.kind === "inline").length ? ` · 📝 ${state.drafts.filter((d) => d.kind === "inline").length}` : ""}</span>
        </button>
      </div>

      <div id="tab-body"></div>
      ${draftsBar()}
    </div>`;

  $("#detail-close").addEventListener("click", closeDetail);
  $("#act-update").addEventListener("click", () => updateBranch(pr));
  $("#act-merge").addEventListener("click", () => confirmMerge(pr));
  $("#act-ai").addEventListener("click", () => generateAiReview(pr));
  $("#act-approve")?.addEventListener("click", () => confirmApprove(pr));
  $("#act-unapprove")?.addEventListener("click", () => confirmUnapprove(pr));
  $("#act-draft-toggle")?.addEventListener("click", async () => {
    const btn = $("#act-draft-toggle");
    btn.disabled = true;
    try {
      const result = await window.pulpo.setPrDraft(pr.id, !pr.isDraft);
      toast(result.isDraft ? `#${pr.number} convertida a borrador` : `#${pr.number} lista para review 🚀`, "ok");
      await refresh();
      openDetail(pr.number, state.detailTab);
    } catch (err) {
      toast(`No se pudo cambiar el estado: ${String(err.message || err)}`, "err");
      btn.disabled = false;
    }
  });
  $("#copy-branch").addEventListener("click", () => copyText(pr.headRefName));
  $("#copy-checkout").addEventListener("click", () => copyText(`gh pr checkout ${pr.number}`));
  $("#copy-url").addEventListener("click", () => copyText(pr.url));
  wireDraftsBar();
  detailContent.querySelectorAll(".tab").forEach((tabBtn) =>
    tabBtn.addEventListener("click", () => {
      state.detailTab = tabBtn.dataset.tab;
      renderDetail();
    }),
  );

  if (state.detailTab === "conv") renderConversationTab();
  else renderChangesTab();
}

function closeDetail() {
  state.selected = null;
  state.detailPR = null;
  detailPane.classList.add("hidden");
  detailPane.classList.remove("wide");
  renderList();
}

/* ============ tab conversación ============ */
function commentBlock(comment) {
  return `
    <div class="comment">
      <div class="comment-head">
        <img src="${esc(comment.author?.avatarUrl || "")}" alt="" />
        <b>${esc(comment.author?.login || "?")}</b>
        <span class="muted">${timeAgo(comment.createdAt)}</span>
      </div>
      <div class="comment-body pr-body">${comment.bodyHTML || ""}</div>
    </div>`;
}

function renderConversationTab() {
  const pr = state.detailPR;
  const conv = state.conversation;
  const comments = conv?.comments?.nodes || [];
  const generalDrafts = state.drafts.filter((d) => d.kind === "general");
  const inlineDraftCount = state.drafts.length - generalDrafts.length;
  const longDescription = (pr.bodyHTML || "").length > 1500;
  $("#tab-body").innerHTML = `
    ${generalDrafts.length || inlineDraftCount
      ? `<div class="section-h">Tus borradores (${state.drafts.length})</div>
         ${generalDrafts.map(draftCard).join("")}
         ${inlineDraftCount ? `<p class="muted">…y ${inlineDraftCount} en línea en la pestaña <a href="#" id="goto-changes">Cambios</a>.</p>` : ""}`
      : ""}
    <div class="section-h">Comentarios (${comments.length})</div>
    ${comments.map(commentBlock).join("") || `<p class="muted">Nadie ha dicho nada todavía.</p>`}
    <div class="composer">
      <textarea id="new-comment" rows="3" placeholder="Escribe un comentario… se guarda como borrador hasta que publiques"></textarea>
      <div class="composer-actions">
        <button class="btn btn-accent" id="send-comment">📝 Guardar borrador</button>
      </div>
    </div>
    <details class="desc-fold" ${longDescription ? "" : "open"}>
      <summary class="section-h">Descripción${longDescription ? " (clic para desplegar)" : ""}</summary>
      <div class="pr-body">${pr.bodyHTML || "<p class='muted'>Sin descripción.</p>"}</div>
    </details>`;
  $("#goto-changes")?.addEventListener("click", (event) => {
    event.preventDefault();
    state.detailTab = "changes";
    renderDetail();
  });
  wireExternalLinks();
  wireDraftCards($("#tab-body"));
  $("#send-comment").addEventListener("click", async () => {
    const body = $("#new-comment").value.trim();
    if (!body) return;
    await addDraft({ kind: "general", body });
    renderDetail();
  });
  notifySelftestOnce();
}

/* ============ tab cambios (diff + comentarios inline) ============ */
function parsePatch(patch) {
  const lines = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(raw);
      oldLine = Number(m?.[1] ?? 0);
      newLine = Number(m?.[2] ?? 0);
      lines.push({ type: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ type: "add", new: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      lines.push({ type: "del", old: oldLine++, text: raw.slice(1) });
    } else if (raw.startsWith("\\")) {
      lines.push({ type: "meta", text: raw });
    } else {
      lines.push({ type: "ctx", old: oldLine++, new: newLine++, text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
  }
  return lines;
}

function threadsByAnchor() {
  const map = new Map();
  const orphans = new Map(); // path -> threads outdated / sin línea
  for (const thread of state.conversation?.reviewThreads?.nodes || []) {
    if (thread.line && !thread.isOutdated) {
      map.set(`${thread.path}::${thread.line}`, [...(map.get(`${thread.path}::${thread.line}`) || []), thread]);
    } else {
      orphans.set(thread.path, [...(orphans.get(thread.path) || []), thread]);
    }
  }
  return { map, orphans };
}

function threadBlock(thread) {
  const comments = thread.comments?.nodes || [];
  const first = comments[0];
  const resolveBtn = !thread.id
    ? ""
    : thread.isResolved
      ? (thread.viewerCanUnresolve ? `<button class="btn thread-resolve" data-resolve-id="${esc(thread.id)}" data-resolved="false" title="Reabre la conversación en GitHub">↺ Reabrir</button>` : "")
      : (thread.viewerCanResolve ? `<button class="btn thread-resolve resolve-ok" data-resolve-id="${esc(thread.id)}" data-resolved="true" title="Marca la conversación como resuelta en GitHub">✓ Resolver</button>` : "");
  return `
    <div class="thread ${thread.isResolved ? "resolved" : ""}">
      ${thread.isResolved ? `<div class="thread-tag">✓ Resuelto</div>` : ""}
      ${comments.map(commentBlock).join("")}
      <div class="thread-reply">
        <textarea rows="2" placeholder="Responder…"></textarea>
        <button class="btn" data-reply="${first?.databaseId ?? ""}">Responder</button>
        ${resolveBtn}
      </div>
    </div>`;
}

function diffLineRow(file, line, anchored) {
  if (line.type === "hunk") {
    return `<tr class="diff-hunk"><td colspan="3">${esc(line.text)}</td></tr>`;
  }
  if (line.type === "meta") {
    return `<tr class="diff-meta"><td colspan="3">${esc(line.text)}</td></tr>`;
  }
  const cls = line.type === "add" ? "diff-add" : line.type === "del" ? "diff-del" : "diff-ctx";
  const sign = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
  const commentLine = line.type === "del" ? line.old : line.new;
  const side = line.type === "del" ? "LEFT" : "RIGHT";
  const codeHtml = window.pulpoHL
    ? window.pulpoHL.highlightLine(line.text, window.pulpoHL.familyFromFilename(file.filename))
    : esc(line.text);
  const threadsHtml = (anchored.get(`${file.filename}::${line.new}`) || [])
    .map(threadBlock)
    .map((html) => `<tr class="diff-thread-row"><td colspan="3">${html}</td></tr>`)
    .join("");
  const draftsHtml = state.drafts
    .filter((d) => d.kind === "inline" && d.path === file.filename && d.side === side && d.line === commentLine)
    .map(draftCard)
    .map((html) => `<tr class="diff-thread-row"><td colspan="3">${html}</td></tr>`)
    .join("");
  return `
    <tr class="diff-line ${cls}" data-path="${esc(file.filename)}" data-line="${commentLine ?? ""}" data-side="${side}">
      <td class="gutter">${line.old ?? ""}</td>
      <td class="gutter">${line.new ?? ""}<button class="add-comment" title="Comentar esta línea (borrador)">+</button></td>
      <td class="code"><span class="sign">${sign}</span>${codeHtml}</td>
    </tr>${threadsHtml}${draftsHtml}`;
}

function renderChangesTab() {
  const files = state.files;
  if (!files) {
    $("#tab-body").innerHTML = `<div class="loading">Cargando diff…</div>`;
    window.pulpo.prFiles(detailRepo(), state.detailPR.number).then((loaded) => {
      state.files = loaded;
      if (state.detailTab === "changes") renderChangesTab();
    }).catch((err) => {
      $("#tab-body").innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
      notifySelftestOnce();
    });
    return;
  }

  const { map: anchored, orphans } = threadsByAnchor();
  const statusIcon = { added: "🟢", removed: "🔴", modified: "🟡", renamed: "🔵" };

  // Comentarios (hilos de GitHub) y borradores locales por fichero, para el índice lateral.
  const commentsPerFile = new Map();
  const unresolvedPerFile = new Map();
  for (const thread of state.conversation?.reviewThreads?.nodes || []) {
    const count = thread.comments?.nodes?.length || 0;
    commentsPerFile.set(thread.path, (commentsPerFile.get(thread.path) || 0) + count);
    if (!thread.isResolved) unresolvedPerFile.set(thread.path, (unresolvedPerFile.get(thread.path) || 0) + count);
  }
  const draftsPerFile = new Map();
  for (const draft of state.drafts) {
    if (draft.kind === "inline") draftsPerFile.set(draft.path, (draftsPerFile.get(draft.path) || 0) + 1);
  }

  const navRows = files
    .map((file, fi) => {
      const comments = commentsPerFile.get(file.filename) || 0;
      const unresolved = unresolvedPerFile.get(file.filename) || 0;
      const draftCount = draftsPerFile.get(file.filename) || 0;
      return `
      <button class="file-nav-row" data-target="diff-f${fi}" title="${esc(file.filename)}">
        <span class="status-ico">${statusIcon[file.status] || "⚪"}</span>
        <span class="file-nav-name">${esc(file.filename)}</span>
        ${comments ? `<span class="file-nav-badge badge-comments ${unresolved ? "" : "all-resolved"}" title="${unresolved ? `${unresolved} comentario(s) sin resolver` : "Todos los hilos resueltos"}">💬 ${comments}</span>` : ""}
        ${draftCount ? `<span class="file-nav-badge badge-drafts" title="${draftCount} borrador(es) local(es)">📝 ${draftCount}</span>` : ""}
      </button>`;
    })
    .join("");

  $("#tab-body").innerHTML = `
    <div class="changes-layout">
      <nav class="file-nav">
        <div class="file-nav-h">Ficheros (${files.length}) ·
          <span class="checks-success">+${files.reduce((s, f) => s + f.additions, 0)}</span>/<span class="checks-failure">−${files.reduce((s, f) => s + f.deletions, 0)}</span>
        </div>
        ${navRows}
      </nav>
      <div class="changes-body">
    ${files
      .map((file, fi) => {
        const orphanThreads = (orphans.get(file.filename) || []).map(threadBlock).join("");
        const comments = commentsPerFile.get(file.filename) || 0;
        return `
        <details class="diff-file" id="diff-f${fi}" ${fi < 6 ? "open" : ""}>
          <summary>
            <span class="status-ico">${statusIcon[file.status] || "⚪"}</span>
            <span class="diff-path">${esc(file.previousFilename ? `${file.previousFilename} → ` : "")}${esc(file.filename)}</span>
            ${comments ? `<span class="file-nav-badge badge-comments">💬 ${comments}</span>` : ""}
            <span class="muted"><span class="checks-success">+${file.additions}</span> / <span class="checks-failure">−${file.deletions}</span></span>
          </summary>
          ${file.patch
            ? `<table class="diff-table">${parsePatch(file.patch).map((l) => diffLineRow(file, l, anchored)).join("")}</table>`
            : `<p class="muted" style="padding:10px 14px">Sin diff disponible (binario o demasiado grande).</p>`}
          ${orphanThreads ? `<div class="orphan-threads"><div class="section-h">Hilos en versiones anteriores</div>${orphanThreads}</div>` : ""}
        </details>`;
      })
      .join("")}
      </div>
    </div>`;

  // índice lateral: saltar al fichero (abriendo su diff)
  $("#tab-body").querySelectorAll(".file-nav-row").forEach((row) =>
    row.addEventListener("click", () => {
      const target = document.getElementById(row.dataset.target);
      if (!target) return;
      target.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#tab-body").querySelectorAll(".file-nav-row").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
    }),
  );

  // comentar en línea
  $("#tab-body").querySelectorAll(".add-comment").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const tr = btn.closest("tr");
      openInlineComposer(tr);
    }),
  );
  // responder hilos
  $("#tab-body").querySelectorAll("[data-reply]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const ta = btn.parentElement.querySelector("textarea");
      const body = ta.value.trim();
      if (!body || !btn.dataset.reply) return;
      btn.disabled = true;
      try {
        await window.pulpo.replyThread(detailRepo(), state.detailPR.number, Number(btn.dataset.reply), body);
        toast("Respuesta publicada", "ok");
        state.conversation = await window.pulpo.prConversation(detailRepo(), state.detailPR.number);
        renderChangesTab();
      } catch (err) {
        toast(`No se pudo responder: ${String(err.message || err)}`, "err");
        btn.disabled = false;
      }
    }),
  );
  // resolver / reabrir hilos
  $("#tab-body").querySelectorAll(".thread-resolve").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const resolved = btn.dataset.resolved === "true";
      btn.disabled = true;
      try {
        await window.pulpo.resolveThread(btn.dataset.resolveId, resolved);
        toast(resolved ? "Conversación resuelta ✓" : "Conversación reabierta", "ok");
        state.conversation = await window.pulpo.prConversation(detailRepo(), state.detailPR.number);
        renderChangesTab();
      } catch (err) {
        toast(`No se pudo ${resolved ? "resolver" : "reabrir"}: ${String(err.message || err)}`, "err");
        btn.disabled = false;
      }
    }),
  );
  wireExternalLinks();
  wireDraftCards($("#tab-body"));
  notifySelftestOnce();
}

function openInlineComposer(tr) {
  document.querySelectorAll(".inline-composer-row").forEach((row) => row.remove());
  const { path, line, side } = tr.dataset;
  if (!line) return;
  const row = document.createElement("tr");
  row.className = "inline-composer-row";
  row.innerHTML = `
    <td colspan="3">
      <div class="composer inline">
        <div class="muted" style="margin-bottom:6px">📝 Borrador en <code>${esc(path)}</code> línea ${esc(line)} (${side === "LEFT" ? "versión anterior" : "versión nueva"}) — no se publica hasta que tú lo digas</div>
        <textarea rows="3" placeholder="Tu comentario…"></textarea>
        <div class="composer-actions">
          <button class="btn cancel">Cancelar</button>
          <button class="btn btn-accent send">📝 Guardar borrador</button>
        </div>
      </div>
    </td>`;
  tr.after(row);
  row.querySelector("textarea").focus();
  row.querySelector(".cancel").addEventListener("click", () => row.remove());
  row.querySelector(".send").addEventListener("click", async () => {
    const body = row.querySelector("textarea").value.trim();
    if (!body) return;
    await addDraft({ kind: "inline", path, side, line: Number(line), body });
    renderDetail();
  });
}

function wireExternalLinks() {
  detailContent.querySelectorAll(".pr-body a, [data-ext]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      const url = a.dataset.ext || a.href;
      if (url?.startsWith("http")) window.pulpo.openExternal(url);
    }),
  );
}

/* ============ acciones PR ============ */
async function updateBranch(pr) {
  const btn = $("#act-update");
  btn.disabled = true;
  btn.textContent = "Rebasando…";
  try {
    await window.pulpo.updateBranch(pr.id);
    toast(`#${pr.number}: rama actualizada con rebase`, "ok");
    await refresh();
    openDetail(pr.number, state.detailTab);
  } catch (err) {
    toast(`Update falló: ${String(err.message || err)}`, "err");
    btn.disabled = false;
    btn.textContent = "⤴ Update branch (rebase)";
  }
}

/** Mi review APPROVED más reciente en la PR, si existe (para poder retirarla). */
function myApprovedReview(pr) {
  return (
    (pr.latestReviews?.nodes || []).find(
      (review) => review.author?.login === state.me?.login && review.state === "APPROVED",
    ) || null
  );
}

function confirmUnapprove(pr) {
  const review = myApprovedReview(pr);
  if (!review?.databaseId) return toast("No encuentro tu review aprobada (refresca e inténtalo)", "err");
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>↩︎ Quitar aprobación de #${pr.number}</h3>
        <p>${esc(pr.title)}</p>
        <p class="muted">Tu review aprobada se descarta: la PR deja de contar con tu ✓. GitHub lo registra en la conversación junto al motivo.</p>
        <input type="text" id="dismiss-reason" placeholder="Motivo (opcional)" style="width:100%;margin-top:8px" class="modal-input" />
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Quitar aprobación</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    const message = $("#dismiss-reason").value.trim() || "Aprobación retirada desde Pulpo";
    root.innerHTML = "";
    try {
      await window.pulpo.dismissReview(detailRepo(), pr.number, review.databaseId, message);
      toast(`Aprobación retirada de #${pr.number}`, "ok");
      await refresh();
      openDetail(pr.number, state.detailTab);
    } catch (err) {
      toast(`No se pudo retirar: ${String(err.message || err)}`, "err");
    }
  });
}

function confirmApprove(pr) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>✅ Aprobar #${pr.number}</h3>
        <p>${esc(pr.title)}</p>
        <p class="muted">Publica una review de aprobación sin comentarios. Si tienes borradores pendientes, no se tocan.</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Aprobar</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    root.innerHTML = "";
    try {
      await window.pulpo.submitReview(detailRepo(), pr.number, { event: "APPROVE" });
      toast(`#${pr.number} aprobada ✅`, "ok");
      await refresh();
      openDetail(pr.number, state.detailTab);
    } catch (err) {
      toast(`No se pudo aprobar: ${String(err.message || err)}`, "err");
    }
  });
}

function confirmMerge(pr) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>Merge de #${pr.number}</h3>
        <p><b>${esc(pr.headRefName)}</b> → <b>${esc(pr.baseRefName)}</b> con <b>merge commit</b>.</p>
        <p class="muted">Squash no es una opción. Nunca lo fue.</p>
        ${pr.isCrossRepository ? "" : `<label><input type="checkbox" id="del-branch" checked /> Borrar la rama tras el merge</label>`}
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-confirm">Confirmar merge</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
  $("#modal-confirm").addEventListener("click", async () => {
    const deleteBranch = $("#del-branch")?.checked ?? false;
    root.innerHTML = "";
    try {
      const res = await window.pulpo.mergePR({
        repo: detailRepo(),
        number: pr.number,
        deleteBranch,
        headRefName: pr.headRefName,
        isCrossRepository: pr.isCrossRepository,
      });
      toast(res.merged ? `#${pr.number} fusionada (merge commit)${res.branchDeleted ? " · rama borrada" : ""}` : "Merge no completado", res.merged ? "ok" : "err");
      // Tras un merge de hotfix/* (solo GitLab), ofrecer replicar el contenido a otras ramas.
      // En su propio try: un fallo aquí no debe mostrar "Merge falló" (el merge ya fue bien).
      if (res.merged && res.sha && shouldOfferCherryPick(pr)) {
        try {
          await offerCherryPick(pr, res.sha);
        } catch (cpErr) {
          toast(`No se pudo ofrecer el cherry-pick: ${String(cpErr.message || cpErr)}`, "err");
        }
      }
      closeDetail();
      await refresh();
    } catch (err) {
      toast(`Merge falló: ${String(err.message || err)}`, "err");
    }
  });
}

/* ============ cherry-pick de hotfix tras merge (solo GitLab) ============ */

/** ¿Esta MR mergeada dispara el ofrecimiento de cherry-pick? */
function shouldOfferCherryPick(pr) {
  if (!isGitlab()) return false;
  const cp = state.config?.cherryPick;
  const prefix = cp?.prefix?.trim();
  if (!prefix) return false;
  return String(pr.headRefName || "").startsWith(prefix);
}

/** Deriva la rama hermana de una release branch: mx ⇄ sin mx. null si no aplica. */
function siblingMxBranch(base) {
  if (!base) return null;
  // Solo tiene sentido sobre release branches (convención rb/…) o ramas ya -mx.
  if (!(/(^|\/)rb\//.test(base) || base.endsWith("-mx"))) return null;
  return base.endsWith("-mx") ? base.slice(0, -"-mx".length) : `${base}-mx`;
}

/** Ramas destino propuestas para el cherry-pick, derivadas de la config y del destino del merge. */
function cherryPickTargets(pr) {
  const cp = state.config?.cherryPick || {};
  const base = pr.baseRefName;
  const targets = [...(cp.branches || [])];
  if (cp.siblingMx) {
    const sibling = siblingMxBranch(base);
    if (sibling) targets.push(sibling);
  }
  // Sin duplicados y sin la propia rama destino del merge (ya tiene el contenido).
  return [...new Set(targets)].filter((b) => b && b !== base);
}

/**
 * Pregunta como precaución (nunca auto-dispara): hace dry-run de cada rama destino,
 * muestra el resultado por-rama y deja confirmar/desmarcar antes de aplicar de verdad.
 */
async function offerCherryPick(pr, sha) {
  const repo = detailRepo();
  const targets = cherryPickTargets(pr);
  if (!targets.length) return;

  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="cp-backdrop">
      <div class="modal">
        <h3>Cherry-pick de #${pr.number}</h3>
        <p class="muted"><b>${esc(pr.headRefName)}</b> se mergeó en <b>${esc(pr.baseRefName)}</b>. ¿Replico su contenido a estas ramas?</p>
        <p class="muted">Comprobando conflictos…</p>
      </div>
    </div>`;

  // Dry-run en paralelo: anticipa conflictos / ramas protegidas antes de escribir nada.
  const checks = await Promise.all(
    targets.map((branch) => window.pulpo.cherryPick(repo, sha, branch, true)),
  );

  await new Promise((resolve) => {
    const rows = checks
      .map((c, i) => {
        const ok = c.ok;
        const id = `cp-b-${i}`;
        const status = ok
          ? `<span class="checks-success">✓ aplica limpio</span>`
          : `<span class="checks-failure">✗ ${esc(c.error || "conflicto")}</span>`;
        return `<label class="cp-row"><input type="checkbox" id="${id}" data-branch="${esc(c.branch)}" ${ok ? "checked" : ""} /> <b>${esc(c.branch)}</b> — ${status}</label>`;
      })
      .join("");
    root.innerHTML = `
      <div class="modal-backdrop" id="cp-backdrop">
        <div class="modal">
          <h3>Cherry-pick de #${pr.number}</h3>
          <p class="muted"><b>${esc(pr.headRefName)}</b> → <b>${esc(pr.baseRefName)}</b>. Replica el contenido a:</p>
          <div class="cp-targets">${rows}</div>
          <div class="modal-actions">
            <button class="btn" id="cp-skip">Ahora no</button>
            <button class="btn btn-primary" id="cp-go">Hacer cherry-pick</button>
          </div>
        </div>
      </div>`;

    const close = () => {
      root.innerHTML = "";
      resolve();
    };
    $("#cp-skip").addEventListener("click", close);
    $("#cp-backdrop").addEventListener("click", (event) => {
      if (event.target.id === "cp-backdrop") close();
    });
    $("#cp-go").addEventListener("click", async () => {
      const branches = [...root.querySelectorAll(".cp-targets input:checked")].map((el) => el.dataset.branch);
      root.innerHTML = "";
      if (!branches.length) return resolve();
      // No atómico entre ramas: aplicamos en secuencia y reportamos por-rama.
      const results = [];
      for (const branch of branches) {
        results.push(await window.pulpo.cherryPick(repo, sha, branch, false));
      }
      const ok = results.filter((r) => r.ok).map((r) => r.branch);
      const failed = results.filter((r) => !r.ok);
      if (ok.length) toast(`Cherry-pick OK: ${ok.join(", ")}`, "ok");
      for (const f of failed) toast(`Cherry-pick falló en ${f.branch}: ${f.error}`, "err");
      resolve();
    });
  });
}

/* ============ vista histórico ============ */
async function enterHistory() {
  if (state.repo === ALL_REPOS) {
    toast("El histórico es por repositorio: elige uno en el selector", "");
    return;
  }
  state.view = "history";
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $("#bucket-history").classList.add("active");
  await loadHistory();
}

function historyBranchSpecs() {
  const enabled = [...state.history.enabled];
  return enabled.map((name) => ({ name, depth: ["main", "master", "develop"].includes(name) ? 80 : 30 }));
}

async function loadHistory() {
  const h = state.history;
  h.loading = true;
  renderHistory();
  try {
    if (!h.branches.length) {
      const def = await window.pulpo.defaultBranch(state.repo);
      const candidates = new Set([def, "develop"]);
      for (const pr of state.openPrs.slice(0, 10)) {
        if (!pr.isCrossRepository) candidates.add(pr.headRefName);
        candidates.add(pr.baseRefName);
      }
      h.branches = [...candidates].slice(0, 14);
      h.enabled = new Set([def, "develop"].filter((b) => h.branches.includes(b)));
      if (!h.enabled.size) h.enabled = new Set(h.branches.slice(0, 2));
    }
    const { branches, commits } = await window.pulpo.historyGraph(state.repo, historyBranchSpecs());
    h.layout = window.PulpoGraph.computeLayout(commits, branches);
    h.loading = false;
    renderHistory();
  } catch (err) {
    h.loading = false;
    list.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

function renderHistory() {
  if (state.view !== "history") return;
  const h = state.history;
  if (h.loading) {
    list.innerHTML = `<div class="loading">Tejiendo el grafo…</div>`;
    return;
  }
  if (!h.layout) return;

  const chips = h.branches
    .map(
      (name) => `<button class="branch-chip ${h.enabled.has(name) ? "on" : ""}" data-branch="${esc(name)}">${esc(name)}</button>`,
    )
    .join("");
  const { svg, width } = window.PulpoGraph.renderSVG(h.layout);
  const rowsHtml = h.layout.rows
    .map((row, i) => {
      const c = row.commit;
      const pr = c.associatedPullRequests?.nodes?.[0];
      const author = c.author?.user?.login || c.author?.name || "?";
      return `
      <div class="graph-row ${h.selectedOid === c.oid ? "selected" : ""}" data-oid="${c.oid}" data-row="${i}">
        ${row.refs.map((r) => `<span class="branch ref-pill">${esc(r)}</span>`).join("")}
        <span class="graph-msg" title="${esc(c.messageHeadline)}">${esc(c.messageHeadline)}</span>
        ${pr ? `<button class="pr-pill" data-pr="${pr.number}" title="${esc(pr.title)}">#${pr.number}</button>` : ""}
        <span class="graph-meta">${esc(author)} · ${timeAgo(c.committedDate)} · <code>${c.abbreviatedOid}</code></span>
      </div>`;
    })
    .join("");

  list.innerHTML = `
    <div class="history-toolbar">
      <div class="branch-chips">${chips}</div>
      <button class="icon-btn" id="history-refresh" title="Recargar grafo">⟳</button>
    </div>
    <div class="graph-wrap">
      <div class="graph-svg" style="width:${width}px">${svg}</div>
      <div class="graph-rows">${rowsHtml}</div>
    </div>`;

  list.querySelectorAll(".branch-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const name = chip.dataset.branch;
      if (h.enabled.has(name)) h.enabled.delete(name);
      else h.enabled.add(name);
      if (!h.enabled.size) h.enabled.add(name);
      loadHistory();
    }),
  );
  $("#history-refresh").addEventListener("click", () => loadHistory());
  list.querySelectorAll(".graph-row").forEach((row) =>
    row.addEventListener("click", () => openCommitPanel(row.dataset.oid)),
  );
  list.querySelectorAll(".pr-pill").forEach((pill) =>
    pill.addEventListener("click", (event) => {
      event.stopPropagation();
      exitHistoryToPR(Number(pill.dataset.pr));
    }),
  );
  notifySelftestOnce();
}

function exitHistoryToPR(number) {
  state.view = "prs";
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  document.querySelector('[data-bucket="open"]').classList.add("active");
  state.bucket = "open";
  refresh().then(() => openDetail(number));
}

function openCommitPanel(oid) {
  const h = state.history;
  h.selectedOid = oid;
  const row = h.layout.rows.find((r) => r.commit.oid === oid);
  if (!row) return;
  const c = row.commit;
  const pr = c.associatedPullRequests?.nodes?.[0];
  renderHistory();
  detailPane.classList.remove("hidden", "wide");
  detailContent.innerHTML = `
    <div class="detail-inner">
      <button class="detail-close" id="detail-close">✕</button>
      <div class="detail-title">${esc(c.messageHeadline)}</div>
      <div class="detail-sub">
        ${row.refs.map((r) => `<span class="branch">${esc(r)}</span>`).join("")}
        ${row.isMerge ? `<span class="chip chip-merged">merge</span>` : ""}
        <code>${c.abbreviatedOid}</code>
      </div>
      <dl class="meta-grid">
        <dt>Autor</dt><dd>${esc(c.author?.user?.login || c.author?.name || "?")}</dd>
        <dt>Fecha</dt><dd>${new Date(c.committedDate).toLocaleString("es-ES")}</dd>
        <dt>SHA</dt><dd><code>${c.oid}</code></dd>
        ${pr ? `<dt>PR</dt><dd><button class="pr-pill" id="commit-pr">#${pr.number} · ${esc(pr.title)}</button></dd>` : ""}
      </dl>

      <div class="section-h">Acciones</div>
      <div class="actions" style="flex-direction:column;align-items:stretch">
        <button class="btn" id="cp-copy">📋 Copiar SHA</button>
        <button class="btn" id="cp-branch">🌱 Crear rama desde aquí…</button>
        <button class="btn" id="cp-reset">⏪ Mover una rama a este commit…</button>
        ${pr && pr.state === "MERGED" ? `<button class="btn btn-danger" id="cp-revert">↩️ Revertir #${pr.number} (${isGitlab() ? "commit de revert" : "crea PR de revert"})</button>` : ""}
      </div>
      <p class="muted">“Mover una rama” reescribe la punta de la rama (force). Pulpo te pedirá confirmación escrita; aún así, úsalo sabiendo lo que haces.</p>
    </div>`;

  $("#detail-close").addEventListener("click", () => {
    h.selectedOid = null;
    detailPane.classList.add("hidden");
    renderHistory();
  });
  $("#cp-copy").addEventListener("click", () => copyText(c.oid));
  $("#cp-branch").addEventListener("click", () => createBranchModal(c));
  $("#cp-reset").addEventListener("click", () => resetBranchModal(c));
  $("#commit-pr")?.addEventListener("click", () => exitHistoryToPR(pr.number));
  $("#cp-revert")?.addEventListener("click", () => revertPRModal(pr));
}

function createBranchModal(commit) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>🌱 Crear rama en <code>${commit.abbreviatedOid}</code></h3>
        <input type="text" id="nb-name" placeholder="feature/mi-rama" style="width:100%;margin-top:8px" class="modal-input" />
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-accent" id="modal-confirm">Crear rama</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-confirm").addEventListener("click", async () => {
    const name = $("#nb-name").value.trim();
    if (!name) return;
    root.innerHTML = "";
    try {
      await window.pulpo.createBranch(state.repo, name, commit.oid);
      toast(`Rama ${name} creada en ${commit.abbreviatedOid}`, "ok");
      state.history.branches = [];
      loadHistory();
    } catch (err) {
      toast(`No se pudo crear: ${String(err.message || err)}`, "err");
    }
  });
}

function resetBranchModal(commit) {
  const root = $("#modal-root");
  const options = state.history.branches
    .map((b) => `<option value="${esc(b)}">${esc(b)}</option>`)
    .join("");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>⏪ Mover rama a <code>${commit.abbreviatedOid}</code></h3>
        <p class="muted">Esto hace un <b>force update</b> de la referencia: la rama pasará a apuntar a este commit y lo que tenga por delante se pierde de la rama. Las ramas protegidas lo rechazarán.</p>
        <select id="rb-branch" class="modal-input" style="width:100%;margin-top:8px">${options}</select>
        <input type="text" id="rb-confirm" placeholder="Escribe el nombre exacto de la rama para confirmar" style="width:100%;margin-top:8px" class="modal-input" />
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-danger" id="modal-confirm">Mover rama (force)</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-confirm").addEventListener("click", async () => {
    const branch = $("#rb-branch").value;
    const typed = $("#rb-confirm").value.trim();
    if (typed !== branch) return toast("El nombre no coincide: no muevo nada", "err");
    root.innerHTML = "";
    try {
      await window.pulpo.forceUpdateBranch(state.repo, branch, commit.oid);
      toast(`${branch} ahora apunta a ${commit.abbreviatedOid}`, "ok");
      loadHistory();
    } catch (err) {
      toast(`Force update falló: ${String(err.message || err)}`, "err");
    }
  });
}

function revertPRModal(pr) {
  const root = $("#modal-root");
  // GitLab no abre MR de revert: crea un commit de revert directo en la rama destino.
  const gitlab = isGitlab();
  const desc = gitlab
    ? "Crea un <b>commit de revert</b> directo en la rama destino (GitLab no abre una MR de revert)."
    : "Crea una <b>PR de revert</b> (no toca la rama directamente). La revisas y la fusionas como cualquier otra.";
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>↩️ Revertir #${pr.number}</h3>
        <p>${desc}</p>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-danger" id="modal-confirm">${gitlab ? "Crear commit de revert" : "Crear PR de revert"}</button>
        </div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-confirm").addEventListener("click", async () => {
    root.innerHTML = "";
    try {
      const revert = await window.pulpo.revertPR(state.repo, pr.number);
      if (revert.number) {
        toast(`PR de revert creada: #${revert.number}`, "ok");
        exitHistoryToPR(revert.number);
      } else {
        toast("Commit de revert creado", "ok");
        if (revert.url) window.pulpo.openExternal(revert.url);
      }
    } catch (err) {
      toast(`Revert falló: ${String(err.message || err)}`, "err");
    }
  });
}

/* ============ notificaciones (estilo Gitify) ============ */
function checksStateOf(pr) {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || "NONE";
}

function reviewRequestedToMe(pr) {
  return (pr.reviewRequests?.nodes || []).some((n) => n.requestedReviewer?.login === state.me?.login);
}

function detectAndNotify(openPrs) {
  const login = state.me?.login;
  const snapshot = new Map();
  for (const pr of openPrs) {
    snapshot.set(pr.number, {
      reviewDecision: pr.reviewDecision,
      checks: checksStateOf(pr),
      reviewMe: reviewRequestedToMe(pr),
      title: pr.title,
      mine: pr.author?.login === login,
    });
  }
  const previous = state.prSnapshot;
  state.prSnapshot = snapshot;
  window.pulpo.dockBadge(String([...snapshot.values()].filter((s) => s.reviewMe).length || ""));
  if (!previous) return; // primera carga: sin spam

  for (const [number, now] of snapshot) {
    const before = previous.get(number);
    if (now.reviewMe && !(before?.reviewMe)) {
      window.pulpo.notify(`Te piden review · #${number}`, now.title);
    }
    if (!before || !now.mine) continue;
    if (now.reviewDecision === "APPROVED" && before.reviewDecision !== "APPROVED") {
      window.pulpo.notify(`✅ Aprobada · #${number}`, now.title);
    }
    if (now.reviewDecision === "CHANGES_REQUESTED" && before.reviewDecision !== "CHANGES_REQUESTED") {
      window.pulpo.notify(`± Cambios pedidos · #${number}`, now.title);
    }
    if (["FAILURE", "ERROR"].includes(now.checks) && !["FAILURE", "ERROR"].includes(before.checks)) {
      window.pulpo.notify(`✗ Checks en rojo · #${number}`, now.title);
    }
  }
}

/* ============ datos ============ */
function bucketStates() {
  if (state.bucket === "merged") return ["MERGED"];
  if (state.bucket === "closed") return ["CLOSED"];
  return ["OPEN"];
}

async function refresh() {
  if (!state.repo) return;
  if (state.view === "history") return loadHistory();
  state.loading = true;
  renderList();
  try {
    const prs = state.repo === ALL_REPOS
      ? await window.pulpo.searchPRs(state.config.repos, bucketStates())
      : await window.pulpo.listPRs(state.repo, bucketStates());
    state.prs = prs;
    if (bucketStates()[0] === "OPEN") {
      state.openPrs = prs;
      detectAndNotify(prs);
    } else if (!state.openPrs.length) {
      window.pulpo.listPRs(state.repo, ["OPEN"]).then((open) => {
        state.openPrs = open;
        renderCounts();
      }).catch(() => {});
    }
    state.loading = false;
    renderCounts();
    renderList();
    // la ruta merged del selftest notifica aquí: con los datos del bucket ya pintados
    if (IS_SELFTEST && SELFTEST_ROUTE === "merged" && state.bucket === "merged") notifySelftestOnce();
    refreshOpenDetailSilently();
  } catch (err) {
    state.loading = false;
    list.innerHTML = `<div class="error-box">No pude cargar ${esc(state.repo)}:<br>${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

/** Refresca el detalle abierto en cada poll, sin pisar nada si estás escribiendo. */
async function refreshOpenDetailSilently() {
  if (!state.selected || !state.detailPR || state.view !== "prs") return;
  const typing = ["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName) ||
    detailContent.querySelector(".inline-composer-row");
  if (typing) return;
  try {
    const [pr, conversation] = await Promise.all([
      window.pulpo.prDetail(detailRepo(), state.selected),
      window.pulpo.prConversation(detailRepo(), state.selected),
    ]);
    const changed = JSON.stringify([pr.mergeStateStatus, pr.reviewDecision, checksStateOf(pr), conversation.comments.totalCount]) !==
      JSON.stringify([state.detailPR.mergeStateStatus, state.detailPR.reviewDecision, checksStateOf(state.detailPR), state.conversation?.comments?.totalCount]);
    state.detailPR = pr;
    state.conversation = conversation;
    if (changed) renderDetail();
  } catch {
    /* el siguiente poll lo reintenta */
  }
}

function schedulePoll() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refresh, (state.config?.pollSeconds || 60) * 1000);
}

/* ============ ajustes ============ */

/** Tarjeta de Ajustes para el cherry-pick de hotfix (solo GitLab). */
function cherryPickSettingsCard(cfg) {
  const cp = cfg.cherryPick || {};
  const branches = cp.branches || [];
  return `
    <div class="settings-card">
      <h4>Cherry-pick de hotfix 🍒</h4>
      <p class="muted">Las MR cuya rama origen empiece por el prefijo y vayan a la release branch ofrecen, tras el merge, replicar su contenido a otras ramas (te pregunta primero, nunca automático).</p>
      <div class="add-repo">
        <input type="text" id="cp-prefix" value="${esc(cp.prefix || "")}" placeholder="hotfix/" />
        <span class="muted" style="align-self:center">prefijo de rama origen</span>
      </div>
      <label style="display:block;margin:8px 0">
        <input type="checkbox" id="cp-sibling" ${cp.siblingMx ? "checked" : ""} />
        Añadir también la rama hermana de la release branch destino (mx ⇄ sin mx)
      </label>
      <p class="muted">Ramas destino fijas (además de la hermana -mx):</p>
      <div id="cp-branch-lines">
        ${branches.map((b) => `<div class="repo-line">${esc(b)} <button class="btn" data-cp-del="${esc(b)}">Quitar</button></div>`).join("") || `<p class="muted">— ninguna —</p>`}
      </div>
      <div class="add-repo">
        <input type="text" id="cp-new-branch" placeholder="development" />
        <button class="btn btn-accent" id="cp-add-branch">Añadir rama</button>
      </div>
      <div class="add-repo">
        <button class="btn" id="cp-save">Guardar prefijo y opción</button>
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
    window.pulpoHL ? window.pulpoHL.highlightLine(code, family) : esc(code);
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
      <button class="btn" id="settings-back">← Volver</button>
      <h2 style="margin-top:14px">Ajustes</h2>
      <div class="settings-card">
        <h4>Proveedor</h4>
        <p class="muted">Actual: <b>${providerName()}</b>${isGitlab() ? ` · <code>${esc(cfg.gitlabBaseUrl || "https://gitlab.com")}</code>` : ""}.</p>
        ${isGitlab() ? `<div class="add-repo">
          <input type="text" id="gitlab-base" placeholder="URL base (self-hosted)" value="${esc(cfg.gitlabBaseUrl || "https://gitlab.com")}" />
          <button class="btn" id="save-gitlab-base">Guardar URL</button>
        </div>` : ""}
        <div class="add-repo">
          <button class="btn" id="switch-provider" data-target="${isGitlab() ? "github" : "gitlab"}">Cambiar a ${isGitlab() ? "GitHub 🐙" : "GitLab 🦊"}</button>
        </div>
        <p class="muted">Cambiar de proveedor reinicia el onboarding (repos y token se piden de nuevo).</p>
      </div>
      <div class="settings-card">
        <h4>Repositorios</h4>
        <div id="repo-lines">
          ${cfg.repos.map((r) => `<div class="repo-line">${esc(r)} <button class="btn" data-del="${esc(r)}">Quitar</button></div>`).join("")}
        </div>
        <div class="add-repo">
          <input type="text" id="new-repo" placeholder="${repoPlaceholder()}" />
          <button class="btn btn-accent" id="add-repo">Añadir</button>
        </div>
      </div>
      <div class="settings-card">
        <h4>Token de ${providerName()}</h4>
        <p class="muted">Origen actual: <b>${esc(state.authSource || "ninguno")}</b>. Orden: <code>${isGitlab() ? "GITLAB_TOKEN" : "GITHUB_TOKEN"}</code> → <code>${isGitlab() ? "glab CLI" : "gh auth token"}</code> → token manual.</p>
        <div class="add-repo">
          <input type="password" id="manual-token" placeholder="${cfg.hasManualToken ? "•••••••• (guardado)" : isGitlab() ? "glpat-… (opcional)" : "ghp_… (opcional)"}" />
          <button class="btn" id="save-token">Guardar</button>
        </div>
      </div>
      <div class="settings-card">
        <h4>IA (Review con IA 🤖)</h4>
        <p class="muted" id="ai-status-line">Comprobando backend…</p>
        <div class="add-repo">
          <select id="ai-model" disabled><option>Cargando modelos…</option></select>
          <select id="ai-effort" disabled></select>
        </div>
        <p class="muted">Modelo y esfuerzo se aplican a cada review (API directa o CLI de Claude Code). Cada borrador queda etiquetado con lo que lo generó.</p>
        <button class="btn" id="test-ai">Probar conexión con Claude</button>
      </div>
      <div class="settings-card">
        <h4>Refresco automático</h4>
        <div class="add-repo">
          <input type="number" id="poll-seconds" min="15" value="${cfg.pollSeconds}" />
          <span class="muted" style="align-self:center">segundos</span>
        </div>
      </div>
      ${isGitlab() ? cherryPickSettingsCard(cfg) : ""}
      <div class="settings-card">
        <h4>Tema de sintaxis 🎨</h4>
        <p class="muted">Colores del resaltado de código en la pantalla de Cambios.</p>
        <div class="add-repo">
          <select id="syntax-theme">
            ${THEMES.map((t) => `<option value="${t.id}" ${(cfg.theme || "one-dark") === t.id ? "selected" : ""}>${esc(t.label)}</option>`).join("")}
          </select>
        </div>
        <div class="theme-preview" data-syntax-theme="${esc(cfg.theme || "one-dark")}" id="theme-preview">
          <table class="diff-table">${themePreviewRows()}</table>
        </div>
      </div>
      <div class="settings-card">
        <h4>Reglas de la casa</h4>
        <p class="muted">pull → <b>rebase</b> · merge → <b>merge commit</b> · squash → <b style="text-decoration:line-through">jamás</b>. No configurable. A propósito.</p>
      </div>
    </div>`;

  $("#settings-back").addEventListener("click", async () => {
    const pollSeconds = parseInt($("#poll-seconds").value, 10);
    if (Number.isInteger(pollSeconds) && pollSeconds >= 15 && pollSeconds !== cfg.pollSeconds) {
      state.config = await window.pulpo.setConfig({ pollSeconds });
      schedulePoll();
    }
    root.classList.add("hidden");
    root.innerHTML = "";
    // Si el usuario quitó todos los repos, volvemos al picker del onboarding.
    if (!state.config.repos.length) boot();
  });
  $("#add-repo").addEventListener("click", async () => {
    const value = $("#new-repo").value.trim();
    if (!repoRe().test(value)) return toast(`Formato esperado: ${repoPlaceholder()}`, "err");
    state.config = await window.pulpo.setConfig({ repos: [...cfg.repos, value] });
    renderRepoSelect();
    openSettings();
  });
  $("#switch-provider")?.addEventListener("click", async () => {
    const target = $("#switch-provider").dataset.target;
    // Cambiar de proveedor vacía repos y token: el onboarding los pedirá de nuevo.
    state.config = await window.pulpo.setConfig({ provider: target, repos: [] });
    state.repo = null;
    root.classList.add("hidden");
    root.innerHTML = "";
    boot();
  });
  $("#save-gitlab-base")?.addEventListener("click", async () => {
    const base = $("#gitlab-base").value.trim();
    if (!/^https:\/\/[\w.-]+/.test(base)) return toast("URL no válida (https://…)", "err");
    state.config = await window.pulpo.setConfig({ gitlabBaseUrl: base });
    toast("URL base guardada", "ok");
    boot();
  });
  root.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      state.config = await window.pulpo.setConfig({ repos: cfg.repos.filter((r) => r !== btn.dataset.del) });
      if (state.repo === btn.dataset.del) state.repo = state.config.repos[0] || null;
      renderRepoSelect();
      openSettings();
    }),
  );
  $("#save-token").addEventListener("click", async () => {
    state.config = await window.pulpo.setConfig({ token: $("#manual-token").value });
    toast("Token guardado", "ok");
    boot();
  });
  $("#syntax-theme").addEventListener("change", async (event) => {
    const theme = event.target.value;
    // Preview instantáneo antes de persistir.
    $("#theme-preview").dataset.syntaxTheme = theme;
    state.config = await window.pulpo.setConfig({ theme });
    applyTheme(theme);
  });

  // --- Cherry-pick de hotfix (solo GitLab) ---
  const saveCherryPick = async (partial) => {
    const cp = { ...(state.config.cherryPick || {}), ...partial };
    state.config = await window.pulpo.setConfig({ cherryPick: cp });
  };
  $("#cp-save")?.addEventListener("click", async () => {
    const prefix = $("#cp-prefix").value.trim();
    if (!prefix) return toast("El prefijo no puede estar vacío", "err");
    await saveCherryPick({ prefix, siblingMx: $("#cp-sibling").checked });
    toast("Cherry-pick configurado", "ok");
    openSettings();
  });
  $("#cp-add-branch")?.addEventListener("click", async () => {
    const value = $("#cp-new-branch").value.trim();
    if (!BRANCH_RE.test(value)) return toast("Nombre de rama no válido", "err");
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

  window.pulpo.aiStatus().then((s) => {
    const line = $("#ai-status-line");
    if (line) line.innerHTML = s.backend
      ? `✓ <b>${esc(s.backend)}</b> — ${esc(s.detail)}`
      : `✗ ${esc(s.detail)}`;

    const modelSel = $("#ai-model");
    const effortSel = $("#ai-effort");
    if (!modelSel || !effortSel || !Array.isArray(s.models)) return;
    let currentEffort = s.effort;
    const renderEfforts = (modelId) => {
      const info = s.models.find((m) => m.id === modelId);
      if (!info || !info.efforts.length) {
        effortSel.innerHTML = `<option value="">esfuerzo: no aplicable</option>`;
        effortSel.disabled = true;
        return;
      }
      const selected = info.efforts.includes(currentEffort) ? currentEffort : "high";
      effortSel.innerHTML = info.efforts
        .map((e) => `<option value="${e}" ${e === selected ? "selected" : ""}>esfuerzo: ${e}</option>`)
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
      state.config = await window.pulpo.setConfig(payload);
      toast(`Review con IA: ${modelSel.value}${effortSel.value ? ` · esfuerzo ${effortSel.value}` : ""}`, "ok");
    });
    effortSel.addEventListener("change", async () => {
      if (!effortSel.value) return;
      currentEffort = effortSel.value;
      state.config = await window.pulpo.setConfig({ aiEffort: effortSel.value });
      toast(`Review con IA: esfuerzo ${effortSel.value}`, "ok");
    });
  }).catch(() => {});
  $("#test-ai").addEventListener("click", async () => {
    const btn = $("#test-ai");
    btn.disabled = true;
    btn.textContent = "Probando… (puede tardar ~30s)";
    try {
      const result = await window.pulpo.aiPing();
      toast(result.ok ? `IA OK vía ${result.backend}` : `IA no disponible: ${result.detail}`, result.ok ? "ok" : "err");
      const line = $("#ai-status-line");
      if (line) line.innerHTML = `${result.ok ? "✓" : "✗"} <b>${esc(result.backend || "sin backend")}</b> — ${esc(result.detail)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Probar conexión con Claude";
    }
  });
}

/* ============ bienvenida / onboarding ============ */

/** Primer paso del onboarding: elegir proveedor (GitHub o GitLab). */
async function renderProviderChooser() {
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">🐙</div>
      <h2>¿Con qué trabajas?</h2>
      <p class="muted">Elige tu proveedor. Podrás cambiarlo luego en Ajustes ⚙.</p>
      <div class="provider-choice">
        <button class="repo-option provider-option" data-provider="github">
          <span class="repo-name">🐙 GitHub</span>
        </button>
        <button class="repo-option provider-option" data-provider="gitlab">
          <span class="repo-name">🦊 GitLab</span>
        </button>
      </div>
      <div class="add-repo picker-manual" id="gitlab-base-row" style="display:none">
        <input type="text" id="gitlab-base-input" placeholder="URL de GitLab (self-hosted): https://gitlab.miempresa.com" />
      </div>
      <div class="welcome-actions">
        <button class="btn btn-accent" id="provider-continue" disabled>Continuar</button>
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
        if (!/^https:\/\/[\w.-]+/.test(base)) return toast("URL no válida (https://…)", "err");
        partial.gitlabBaseUrl = base;
      }
    }
    state.config = await window.pulpo.setConfig(partial);
    boot();
  });
  notifySelftestOnce();
}

async function renderWelcome() {
  const aiStatus = await window.pulpo.aiStatus().catch(() => ({ backend: null, detail: "" }));
  const aiOk = Boolean(aiStatus.backend);
  const gitlab = isGitlab();
  const cliCmd = gitlab ? "brew install glab && glab auth login" : "brew install gh && gh auth login";
  const cliName = gitlab ? "CLI oficial de GitLab (glab)" : "CLI oficial de GitHub";
  const envVar = gitlab ? "GITLAB_TOKEN" : "GITHUB_TOKEN";
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">🐙</div>
      <h2>Bienvenido a Pulpo</h2>
      <p class="muted">Dos pasos y listo. Pulpo no guarda credenciales: usa las sesiones que ya tienes.</p>

      <div class="setup-step bad">
        <div class="setup-mark">1</div>
        <div>
          <b>Conecta ${providerName()}</b> <span class="chip chip-closed">pendiente</span>
          <p class="muted">La vía fácil es el ${cliName} — Pulpo coge el token de ahí:</p>
          <pre class="setup-cmd">${cliCmd}</pre>
          <p class="muted">Alternativas: exporta <code>${envVar}</code>, o pega un token en Ajustes ⚙.</p>
        </div>
      </div>

      <div class="setup-step ${aiOk ? "ok" : ""}">
        <div class="setup-mark">2</div>
        <div>
          <b>Conecta Claude</b> <span class="chip ${aiOk ? "chip-open" : "chip-draft"}">${aiOk ? "listo" : "opcional"}</span>
          <p class="muted">${aiOk
            ? `Detectado: ${esc(aiStatus.detail)} — el botón 🤖 Review con IA ya funciona.`
            : `Para el botón 🤖 Review con IA: instala <a href="#" data-ext="https://claude.com/claude-code">Claude Code</a> y ábrelo una vez para autenticarte (Pulpo usará tu sesión), o exporta <code>ANTHROPIC_API_KEY</code>.`}</p>
        </div>
      </div>

      <div class="welcome-actions">
        <button class="btn btn-accent" id="welcome-retry">He hecho login — Reintentar</button>
        <button class="btn" id="welcome-settings">Abrir Ajustes ⚙</button>
      </div>
      <p class="muted small-print">¿Dudas? <code>npm run doctor</code> en la terminal diagnostica todo esto por ti.</p>
    </div>`;
  $("#welcome-retry").addEventListener("click", boot);
  $("#welcome-settings").addEventListener("click", openSettings);
  list.querySelectorAll("[data-ext]").forEach((a) =>
    a.addEventListener("click", (event) => {
      event.preventDefault();
      window.pulpo.openExternal(a.dataset.ext);
    }),
  );
}

/** Paso final del onboarding: GitHub conectado pero sin repos elegidos todavía. */
async function renderRepoPicker() {
  const selected = new Set();
  let suggestions = [];
  list.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">🐙</div>
      <h2>¿Qué repositorios quieres ver?</h2>
      <p class="muted">Conectado como <b>${esc(state.me?.login || "?")}</b>. Marca los repos que Pulpo vigilará — podrás cambiarlos cuando quieras en Ajustes ⚙.</p>
      <div id="repo-picker" class="repo-picker"><div class="empty">Buscando tus repositorios…</div></div>
      <div class="add-repo picker-manual">
        <input type="text" id="picker-manual-input" placeholder="¿Falta alguno? Escríbelo: ${repoPlaceholder()}" />
        <button class="btn" id="picker-manual-add">Añadir</button>
      </div>
      <div class="welcome-actions">
        <button class="btn btn-accent" id="picker-start" disabled>Empezar</button>
      </div>
    </div>`;

  const rowsEl = $("#repo-picker");
  const startBtn = $("#picker-start");

  const renderRows = () => {
    const names = [...new Set([...suggestions.map((s) => s.nameWithOwner), ...selected])];
    if (!names.length) {
      rowsEl.innerHTML = `<div class="empty">No encontré repos accesibles con tu token — añade uno a mano abajo.</div>`;
    } else {
      const isPrivate = new Map(suggestions.map((s) => [s.nameWithOwner, s.isPrivate]));
      rowsEl.innerHTML = names
        .map(
          (name) => `
        <button class="repo-option ${selected.has(name) ? "selected" : ""}" data-repo="${esc(name)}">
          <span class="repo-check">${selected.has(name) ? "✓" : ""}</span>
          <span class="repo-name">${esc(name)}</span>
          ${isPrivate.get(name) ? `<span class="chip chip-draft">privado</span>` : ""}
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
      ? `Empezar con ${selected.size} ${selected.size === 1 ? "repositorio" : "repositorios"}`
      : "Empezar";
  };

  startBtn.addEventListener("click", async () => {
    if (!selected.size) return;
    state.config = await window.pulpo.setConfig({ repos: [...selected] });
    state.repo = null;
    boot();
  });
  const addManual = () => {
    const input = $("#picker-manual-input");
    const value = input.value.trim();
    if (!repoRe().test(value)) return toast(`Formato esperado: ${repoPlaceholder()}`, "err");
    selected.add(value);
    input.value = "";
    renderRows();
  };
  $("#picker-manual-add").addEventListener("click", addManual);
  $("#picker-manual-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addManual();
  });

  try {
    suggestions = await window.pulpo.suggestRepos();
  } catch {
    /* sin sugerencias no pasa nada: queda la entrada manual */
  }
  renderRows();
  notifySelftestOnce();
}

/* ============ vista milestones (solo GitLab) ============ */
async function enterMilestones() {
  if (!isGitlab()) {
    toast("La vista de Milestones solo está disponible en GitLab", "");
    return;
  }
  state.view = "milestones";
  closeDetail();
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  $("#bucket-milestones")?.classList.add("active");
  await loadMilestones();
}

async function loadMilestones() {
  const m = state.milestones;
  // Por defecto, las labels "terminada no cerrada" arrancan ocultas (chip en "excluir").
  if (!m.filters.seeded) {
    for (const label of state.config?.milestones?.doneLabels || []) m.filters.status.set(label, "exclude");
    m.filters.seeded = true;
  }
  m.loading = true;
  renderMilestones();
  try {
    if (!m.list.length) m.list = await window.pulpo.listMilestones();
    if (!m.labels.length) m.labels = await window.pulpo.groupLabels().catch(() => []);
    if (!m.selectedTitle && m.list.length) m.selectedTitle = pickCurrentMilestone(m.list);
    // Traemos SIEMPRE todo (incl. cerradas): las métricas To do / pending check se calculan
    // contra las cerradas/terminadas, así que las necesitamos aunque no se muestren. El filtro
    // "Mostrar cerradas" pasa a ser solo de visualización. Limitado por milestone, no es el grupo
    // entero. ponytail: si un milestone supera el cap de 500 (apiAll), las métricas se quedan cortas.
    m.issues = m.selectedTitle ? await window.pulpo.milestoneIssues(m.selectedTitle, true) : [];
    m.loading = false;
    renderMilestones();
  } catch (err) {
    m.loading = false;
    list.innerHTML = `<div class="error-box">${esc(String(err.message || err))}</div>`;
    notifySelftestOnce();
  }
}

// Milestone "vigente": descartamos los claramente futuros (empiezan después de hoy) y
// pasados (vencieron antes de hoy); entre los que quedan, el que contiene hoy en su rango,
// si no el primero vigente, y como último recurso el primero de la lista. Fechas ISO
// (YYYY-MM-DD) se comparan como string sin problema.
function pickCurrentMilestone(list) {
  const today = new Date().toISOString().slice(0, 10);
  const live = list.filter((ms) => {
    if (ms.startDate && ms.startDate > today) return false; // futuro
    if (ms.dueDate && ms.dueDate < today) return false; // pasado
    return true;
  });
  const containing = live.find((ms) => (!ms.startDate || ms.startDate <= today) && (!ms.dueDate || ms.dueDate >= today));
  return (containing || live[0] || list[0])?.title || null;
}

// Reparte cada issue en sus asignados (un issue con N asignados aparece en N personas:
// cada quien ve su tarea pendiente). Los huérfanos caen en "Sin asignar".
function groupIssuesByAssignee(issues) {
  const UNASSIGNED = "__unassigned__";
  const groups = new Map();
  for (const iss of issues) {
    const targets = iss.assignees.length ? iss.assignees : [{ username: UNASSIGNED, name: "Sin asignar", avatarUrl: null }];
    for (const a of targets) {
      if (!groups.has(a.username)) groups.set(a.username, { ...a, issues: [] });
      groups.get(a.username).issues.push(iss);
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.username === UNASSIGNED) return 1;
    if (b.username === UNASSIGNED) return -1;
    return a.name.localeCompare(b.name);
  });
}

// Clave estable de un issue (los issues se leen del grupo, así que combinamos proyecto+iid).
function issueKey(iss) {
  return `${iss.projectId}#${iss.iid}`;
}

function milestoneCard(iss, statusSet) {
  const chips = iss.labels
    .map((l) => {
      const isStatus = statusSet.has(l.name);
      const style = l.color ? `style="background:${l.color};color:${l.textColor || "#fff"}"` : "";
      return `<span class="ms-label ${isStatus ? "status" : ""}" ${style}>${esc(l.name)}</span>`;
    })
    .join("");
  const key = issueKey(iss);
  const selected = state.milestones.selected.has(key);
  return `
    <div class="ms-task ${iss.state === "closed" ? "closed" : ""} ${selected ? "selected" : ""}" draggable="true"
         data-key="${esc(key)}" data-project="${iss.projectId}" data-iid="${iss.iid}">
      <div class="ms-task-top">
        <input type="checkbox" class="ms-task-check" ${selected ? "checked" : ""} title="Seleccionar" />
        <button class="ms-task-title" data-url="${esc(iss.webUrl)}" title="Abrir en GitLab">
          ${esc(iss.title)} <span class="ms-iid">#${iss.iid}</span>
        </button>
      </div>
      ${chips ? `<div class="ms-task-labels">${chips}</div>` : ""}
    </div>`;
}

// Las "pending check*" (comprobación) y "finished" (terminada) viven ambas en doneLabels;
// las separamos por nombre: las que contienen "pending check" son comprobación, el resto (finished) terminada.
function splitDoneLabels(doneLabels) {
  const pendingCheck = new Set();
  const finished = new Set();
  for (const l of doneLabels) (l.toLowerCase().includes("pending check") ? pendingCheck : finished).add(l);
  return { pendingCheck, finished };
}

// Métricas sobre un conjunto de issues (todas las que se le pasen; el llamador filtra a las
// ASIGNADAS). Categorías mutuamente excluyentes:
//   C = cerradas · F = abiertas con "finished" · P = abiertas con "pending check*" · T = abiertas resto (to do)
// Indicadores de AVANCE (cuánto se ha completado, no cuánto falta), base "hecho" = C + F:
//   Terminadas  = base / (base + T)   cerradas/finished sobre el total a hacer
//   Comprobadas = base / (base + P)   ya comprobadas sobre comprobadas + las que esperan comprobación
function milestoneMetrics(issues, pendingCheckSet, finishedSet) {
  let C = 0, F = 0, P = 0, T = 0;
  for (const iss of issues) {
    if (iss.state === "closed") { C++; continue; }
    const names = iss.labels.map((l) => l.name);
    if (names.some((n) => finishedSet.has(n))) F++;
    else if (names.some((n) => pendingCheckSet.has(n))) P++;
    else T++;
  }
  const base = C + F;
  const pct = (count, total) => (total ? Math.round((100 * count) / total) : 0);
  return {
    doneCount: base, doneTotal: base + T, donePct: pct(base, base + T),
    checkedCount: base, checkedTotal: base + P, checkedPct: pct(base, base + P),
  };
}

// Info del filtro de estado: explica los tres estados (sin filtro → solo estas → ocultas) con
// una animación que va resaltando cada uno en orden, mostrando el ciclo del clic.
function statusFilterHelp() {
  return `<span class="ms-filter-info" tabindex="0" title="Cómo funciona el filtro de etiquetas"><span class="ms-filter-i">i</span><div class="ms-filter-pop">
      <div class="msfh-title">Clic en una etiqueta para ciclar el filtro:</div>
      <div class="msfh-states">
        <span class="msfh-state st1">
          <span class="msfh-chip neutral"><span class="lbl">etiqueta</span></span>
          <span class="msfh-cap">Sin filtro</span>
        </span>
        <span class="msfh-arr">→</span>
        <span class="msfh-state st2">
          <span class="msfh-chip inc"><span class="chk">✓</span> <span class="lbl">etiqueta</span></span>
          <span class="msfh-cap">Solo estas</span>
        </span>
        <span class="msfh-arr">→</span>
        <span class="msfh-state st3">
          <span class="msfh-chip exc"><span class="ex">✕</span> <span class="lbl">etiqueta</span></span>
          <span class="msfh-cap">Ocultas</span>
        </span>
      </div>
    </div></span>`;
}

// Negro o blanco según la luminancia del color de fondo, para que el texto SIEMPRE se lea
// encima del color del label (sea cual sea). Fórmula perceptual (rec. 601).
function readableText(hex) {
  const h = (hex || "").replace("#", "");
  if (h.length < 6) return "#fff";
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#fff";
}

// Indicadores Terminadas/Comprobadas como pastillas. En la cabecera del milestone se muestra
// también el número (showCount); en la de cada persona solo el % (n/m en el tooltip).
function metricChips(mm, showCount = false) {
  const chip = (cls, icon, count, total, pct, name) => {
    const num = showCount ? `<span class="ms-chip-n">${count}/${total}</span> ` : "";
    return `<span class="ms-chip ${cls}" title="${name} ${count}/${total}">${icon} ${num}${pct}%</span>`;
  };
  return (
    chip("term", "✓", mm.doneCount, mm.doneTotal, mm.donePct, "Terminadas") +
    chip("check", "◉", mm.checkedCount, mm.checkedTotal, mm.checkedPct, "Comprobadas")
  );
}

function renderMilestones() {
  if (state.view !== "milestones") return;
  const m = state.milestones;
  if (m.loading) {
    list.innerHTML = `<div class="loading">Cargando milestone…</div>`;
    return;
  }

  const statusLabels = state.config?.milestones?.statusLabels || [];
  const statusSet = new Set(statusLabels);
  const { pendingCheck: pendingCheckSet, finished: finishedSet } = splitDoneLabels(state.config?.milestones?.doneLabels || []);
  const search = state.search.trim().toLowerCase();

  // Filtros tri-estado: incluir (solo estas) y excluir (ocultar estas).
  const includes = [];
  const excludes = new Set();
  for (const [label, mode] of m.filters.status) {
    if (mode === "include") includes.push(label);
    else if (mode === "exclude") excludes.add(label);
  }

  const visible = m.issues.filter((iss) => {
    if (!m.filters.showClosed && iss.state === "closed") return false;
    if (!m.filters.showUnassigned && !iss.assignees.length) return false;
    const names = iss.labels.map((l) => l.name);
    if (excludes.size && names.some((n) => excludes.has(n))) return false;
    if (includes.length && !names.some((n) => includes.includes(n))) return false;
    if (search && !`${iss.title} ${names.join(" ")}`.toLowerCase().includes(search)) return false;
    return true;
  });

  // Las métricas se calculan SIEMPRE sobre el conjunto completo de ASIGNADAS (no sobre lo
  // filtrado ni sobre las sin asignar): ocultar un estado no debe poner su % a cero.
  const assignedIssues = m.issues.filter((iss) => iss.assignees.length);
  const allByMember = new Map(groupIssuesByAssignee(m.issues).map((g) => [g.username, g.issues]));
  const milestoneMM = milestoneMetrics(assignedIssues, pendingCheckSet, finishedSet);

  // Chips de estado con el color real del label: neutro = solo borde; incluir = relleno + ✓ verde;
  // excluir = sin relleno, ✕ roja y texto tachado.
  const labelColors = new Map(m.labels.map((l) => [l.name, l]));
  const statusChips = statusLabels
    .map((label) => {
      const mode = m.filters.status.get(label);
      const lab = labelColors.get(label);
      const color = lab?.color || "var(--text-muted)";
      const cls = mode === "include" ? "on" : mode === "exclude" ? "off" : "";
      // Relleno: texto en blanco/negro según contraste con el color. Sin relleno: texto en --text
      // (siempre legible sobre el fondo del tema), el color queda en el borde.
      const style =
        mode === "include"
          ? `background:${color};color:${readableText(lab?.color)};border-color:${color}`
          : `background:transparent;color:var(--text);border-color:${color}`;
      const icon = mode === "include" ? `<span class="chk">✓</span> ` : mode === "exclude" ? `<span class="ex">✕</span> ` : "";
      const hint = mode === "include" ? "Solo estas · clic: ocultar" : mode === "exclude" ? "Ocultas · clic: quitar filtro" : "Clic: solo estas";
      return `<button class="ms-status-chip ${cls}" data-label="${esc(label)}" style="${style}" title="${hint}">${icon}<span class="lbl">${esc(label)}</span></button>`;
    })
    .join("");

  const groups = groupIssuesByAssignee(visible);
  const boardHtml = groups.length
    ? groups
        .map((g) => {
          const gm = milestoneMetrics(allByMember.get(g.username) || [], pendingCheckSet, finishedSet);
          return `
        <section class="ms-group ms-drop" data-username="${esc(g.username)}" data-userid="${g.id || ""}">
          <header class="ms-group-head">
            ${g.avatarUrl ? `<img class="ms-avatar" src="${esc(g.avatarUrl)}" alt="" />` : `<span class="ms-avatar ph">∅</span>`}
            <span class="ms-group-name">${esc(g.name)}</span>
            <span class="ms-group-chips">${metricChips(gm)}</span>
            <span class="ms-group-count">${g.issues.length}</span>
          </header>
          <div class="ms-tasks">${g.issues.map((iss) => milestoneCard(iss, statusSet)).join("")}</div>
        </section>`;
        })
        .join("")
    : `<div class="empty">No hay tareas que mostrar con estos filtros.</div>`;

  // Solo seguimos contando como seleccionadas las que siguen visibles.
  const visibleKeys = new Set(visible.map(issueKey));
  for (const k of [...m.selected]) if (!visibleKeys.has(k)) m.selected.delete(k);
  const selCount = m.selected.size;

  const railHtml = m.list
    .map((ms) => {
      const current = ms.title === m.selectedTitle;
      // Los chips de métricas (genéricos del milestone) van bajo el nombre, solo en el actual.
      const metrics = current ? `<span class="ms-rail-metrics">${metricChips(milestoneMM, true)}</span>` : "";
      const due = ms.dueDate ? `<span class="ms-rail-due">vence ${esc(ms.dueDate)}</span>` : "";
      return `<button class="ms-rail-item ms-drop-ms ${current ? "current" : ""}" data-msid="${ms.id}" data-title="${esc(ms.title)}" title="Clic: ver este milestone · soltar issues aquí para moverlas">
        <span class="ms-rail-name">${esc(ms.title)}</span>
        ${metrics || due ? `<span class="ms-rail-sub">${metrics}${due}</span>` : ""}
      </button>`;
    })
    .join("");

  list.innerHTML = `
    <div class="ms-rail">${railHtml || `<span class="muted">Sin milestones activos</span>`}</div>
    <div class="ms-filters">
      ${statusFilterHelp()}
      ${statusChips ? `<div class="ms-status-bar">${statusChips}</div>` : ""}
      <div class="ms-toggles">
        <label class="ms-closed-toggle"><input type="checkbox" id="ms-show-closed" ${m.filters.showClosed ? "checked" : ""} /> Mostrar cerradas</label>
        <label class="ms-closed-toggle"><input type="checkbox" id="ms-show-unassigned" ${m.filters.showUnassigned ? "checked" : ""} /> Mostrar sin asignar</label>
        <span class="ms-counter">${visible.length} tarea${visible.length === 1 ? "" : "s"}</span>
        <button class="icon-btn" id="ms-refresh" title="Recargar">⟳</button>
      </div>
    </div>
    <div class="ms-bulk-bar ${selCount ? "" : "hidden"}">
      <span class="ms-bulk-count">${selCount} seleccionada${selCount === 1 ? "" : "s"}</span>
      <button class="btn" id="ms-bulk-labels">Etiquetas…</button>
      <button class="btn" id="ms-bulk-milestone">Milestone…</button>
      <button class="btn ghost" id="ms-bulk-clear">Quitar selección</button>
    </div>
    <div class="ms-board">${boardHtml}</div>`;

  // Clic en una tarjeta del rail = ver ese milestone (además de ser drop target para mover issues).
  list.querySelectorAll(".ms-drop-ms").forEach((item) =>
    item.addEventListener("click", () => {
      if (item.dataset.title === m.selectedTitle) return;
      m.selectedTitle = item.dataset.title;
      m.issues = [];
      m.selected.clear();
      loadMilestones();
    }),
  );
  $("#ms-show-closed")?.addEventListener("change", (event) => {
    // Las cerradas ya están en m.issues (se traen siempre para las métricas): solo es display.
    m.filters.showClosed = event.target.checked;
    renderMilestones();
  });
  $("#ms-show-unassigned")?.addEventListener("change", (event) => {
    m.filters.showUnassigned = event.target.checked;
    renderMilestones();
  });
  $("#ms-refresh")?.addEventListener("click", () => {
    m.list = [];
    m.issues = [];
    loadMilestones();
  });
  list.querySelectorAll(".ms-status-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      // Ciclo tri-estado: neutro → incluir → excluir → neutro.
      const label = chip.dataset.label;
      const mode = m.filters.status.get(label);
      if (!mode) m.filters.status.set(label, "include");
      else if (mode === "include") m.filters.status.set(label, "exclude");
      else m.filters.status.delete(label);
      renderMilestones();
    }),
  );
  list.querySelectorAll(".ms-task-title").forEach((btn) =>
    btn.addEventListener("click", (event) => {
      event.stopPropagation(); // no seleccionar la tarjeta al abrir en GitLab
      window.pulpo.openExternal(btn.dataset.url);
    }),
  );

  // Selección múltiple: checkbox por issue.
  list.querySelectorAll(".ms-task-check").forEach((box) =>
    box.addEventListener("change", (event) => {
      const key = event.target.closest(".ms-task").dataset.key;
      if (event.target.checked) m.selected.add(key);
      else m.selected.delete(key);
      renderMilestones();
    }),
  );

  wireMilestoneDragDrop(list);

  $("#ms-bulk-clear")?.addEventListener("click", () => {
    m.selected.clear();
    renderMilestones();
  });
  $("#ms-bulk-labels")?.addEventListener("click", openBulkLabelsModal);
  $("#ms-bulk-milestone")?.addEventListener("click", openBulkMilestoneModal);

  notifySelftestOnce();
}

// Aplica un patch (objeto, o función issue→patch) a un conjunto de issues por su clave.
// Secuencial y NO atómico: si falla a medias, unas quedan aplicadas y otras no (se reporta).
async function applyIssuePatch(keys, patchOrFn) {
  const m = state.milestones;
  let ok = 0;
  let fail = 0;
  for (const key of keys) {
    const iss = m.issues.find((i) => issueKey(i) === key);
    if (!iss) continue;
    const patch = typeof patchOrFn === "function" ? patchOrFn(iss) : patchOrFn;
    if (!patch) continue;
    try {
      await window.pulpo.updateIssue(iss.projectId, iss.iid, patch);
      ok++;
    } catch {
      fail++;
    }
  }
  m.selected.clear();
  m.issues = []; // fuerza refetch de las tareas del milestone actual
  await loadMilestones();
  if (fail) toast(`${ok} aplicada${ok === 1 ? "" : "s"}, ${fail} fallaron`, "err");
  else if (ok) toast(`${ok} tarea${ok === 1 ? "" : "s"} actualizada${ok === 1 ? "" : "s"}`, "ok");
}

function wireMilestoneDragDrop(list) {
  list.querySelectorAll(".ms-task").forEach((card) =>
    card.addEventListener("dragstart", (event) => {
      const key = card.dataset.key;
      const sel = state.milestones.selected;
      // Si arrastras una seleccionada, mueve toda la selección; si no, solo esa.
      const keys = sel.has(key) ? [...sel] : [key];
      const fromUserId = card.closest(".ms-drop")?.dataset.userid || "";
      event.dataTransfer.setData("text/plain", JSON.stringify({ keys, fromUserId }));
      event.dataTransfer.effectAllowed = "move";
    }),
  );

  const readPayload = (event) => {
    try {
      return JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch {
      return null;
    }
  };

  // Drop sobre una persona: reasignar (quita al de origen, añade al destino, conserva el resto).
  list.querySelectorAll(".ms-drop").forEach((col) => {
    col.addEventListener("dragover", (event) => {
      event.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", (event) => {
      event.preventDefault();
      col.classList.remove("drag-over");
      const payload = readPayload(event);
      if (!payload) return;
      const fromId = Number(payload.fromUserId) || null;
      const targetId = col.dataset.userid ? Number(col.dataset.userid) : null;
      if (fromId && fromId === targetId) return; // misma columna, nada que hacer
      applyIssuePatch(payload.keys, (iss) => {
        let ids = iss.assignees.map((a) => a.id);
        if (fromId) ids = ids.filter((id) => id !== fromId);
        if (targetId && !ids.includes(targetId)) ids.push(targetId);
        return { assigneeIds: ids };
      });
    });
  });

  // Drop sobre un milestone del rail: mover el issue a ese milestone.
  list.querySelectorAll(".ms-drop-ms").forEach((item) => {
    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      item.classList.add("drag-over");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      item.classList.remove("drag-over");
      const payload = readPayload(event);
      if (!payload) return;
      applyIssuePatch(payload.keys, { milestoneId: Number(item.dataset.msid) });
    });
  });
}

// Modal de etiquetas en bloque: chips tri-estado (neutro → añadir → quitar → neutro).
function openBulkLabelsModal() {
  const m = state.milestones;
  const keys = [...m.selected];
  if (!keys.length) return;
  const selectedIssues = m.issues.filter((i) => m.selected.has(issueKey(i)));
  // Estado inicial = labels que TODAS las seleccionadas ya tienen (badge relleno de partida).
  // Marcar = el label estará presente en todas; desmarcar = se quitará de todas.
  const initial = new Set(m.labels.filter((l) => selectedIssues.every((i) => i.labels.some((x) => x.name === l.name))).map((l) => l.name));
  const chosen = new Set(initial);
  const root = $("#modal-root");

  // Badge con el color real del label: relleno si está marcado, solo borde si no.
  const badge = (l) => {
    const on = chosen.has(l.name);
    const c = l.color || "var(--accent)";
    const style = on
      ? `background:${c};color:${l.textColor || "#fff"};border:1px solid ${c}`
      : `background:transparent;color:${c};border:1px solid ${c}`;
    return `<button class="ms-label-pick" data-name="${esc(l.name)}" style="${style}">${esc(l.name)}</button>`;
  };
  const renderChips = (filter = "") => {
    const f = filter.trim().toLowerCase();
    return m.labels.filter((l) => !f || l.name.toLowerCase().includes(f)).map(badge).join("");
  };

  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal modal-wide">
        <h3>Etiquetas · ${keys.length} seleccionada${keys.length === 1 ? "" : "s"}</h3>
        <p class="muted">Las rellenas se aplicarán a todas; las que quites se eliminarán de todas.</p>
        <input type="text" class="modal-input" id="ms-label-search" placeholder="Buscar etiqueta…" />
        <div class="ms-label-pick-list" id="ms-label-list">${renderChips()}</div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancelar</button>
          <button class="btn btn-primary" id="modal-apply">Aplicar</button>
        </div>
      </div>
    </div>`;

  const close = () => (root.innerHTML = "");
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") close();
  });
  $("#modal-cancel").addEventListener("click", close);
  $("#ms-label-search").addEventListener("input", (event) => {
    $("#ms-label-list").innerHTML = renderChips(event.target.value);
    wireRows();
  });
  const wireRows = () =>
    root.querySelectorAll(".ms-label-pick").forEach((row) =>
      row.addEventListener("click", () => {
        const name = row.dataset.name;
        if (chosen.has(name)) chosen.delete(name);
        else chosen.add(name);
        $("#ms-label-list").innerHTML = renderChips($("#ms-label-search").value);
        wireRows();
      }),
    );
  wireRows();
  $("#modal-apply").addEventListener("click", () => {
    const addLabels = [...chosen].filter((n) => !initial.has(n));
    const removeLabels = [...initial].filter((n) => !chosen.has(n));
    close();
    if (addLabels.length || removeLabels.length) applyIssuePatch(keys, { addLabels, removeLabels });
  });
}

// Modal para mover las seleccionadas a otro milestone (o quitarlo).
function openBulkMilestoneModal() {
  const m = state.milestones;
  const keys = [...m.selected];
  if (!keys.length) return;
  const root = $("#modal-root");
  const items = m.list
    .map((ms) => `<button class="ms-label-row" data-msid="${ms.id}"><span>${esc(ms.title)}</span>${ms.dueDate ? `<span class="muted">${esc(ms.dueDate)}</span>` : ""}</button>`)
    .join("");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>Mover a milestone · ${keys.length} seleccionada${keys.length === 1 ? "" : "s"}</h3>
        <div class="ms-label-list">
          ${items}
          <button class="ms-label-row off" data-msid="0"><span>Sin milestone</span></button>
        </div>
        <div class="modal-actions"><button class="btn" id="modal-cancel">Cancelar</button></div>
      </div>
    </div>`;
  const close = () => (root.innerHTML = "");
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") close();
  });
  $("#modal-cancel").addEventListener("click", close);
  root.querySelectorAll(".ms-label-row").forEach((row) =>
    row.addEventListener("click", () => {
      const msid = Number(row.dataset.msid);
      close();
      applyIssuePatch(keys, { milestoneId: msid || null });
    }),
  );
}

/* ============ arranque ============ */
function renderRepoSelect() {
  const select = $("#repo-select");
  const repos = state.config?.repos || [];
  const allOption = repos.length > 1
    ? `<option value="${ALL_REPOS}" ${state.repo === ALL_REPOS ? "selected" : ""}>⭐ Todos los repos</option>`
    : "";
  select.innerHTML = allOption + repos
    .map((r) => `<option value="${esc(r)}" ${r === state.repo ? "selected" : ""}>${esc(r)}</option>`)
    .join("");
}

/** Aplica el tema de sintaxis al <body> (lo consume styles.css vía [data-syntax-theme]). */
function applyTheme(theme) {
  document.body.dataset.syntaxTheme = theme || "one-dark";
}

async function boot() {
  state.config = await window.pulpo.getConfig();
  applyTheme(state.config.theme);
  // Instalación nueva (sin proveedor ni repos): primero elegimos GitHub o GitLab.
  // Los instalados de antes (con repos pero sin provider) siguen en GitHub por defecto.
  if (!state.config.provider && !state.config.repos.length) {
    await renderProviderChooser();
    return;
  }
  const remembered = state.config.lastRepo;
  state.repo =
    (state.repo && state.config.repos.includes(state.repo) && state.repo) ||
    (remembered === ALL_REPOS && state.config.repos.length > 1 && ALL_REPOS) ||
    (state.config.repos.includes(remembered) && remembered) ||
    state.config.repos[0] ||
    null;
  if (state.config.lastBucket && !IS_SELFTEST) state.bucket = state.config.lastBucket;
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  document.querySelector(`[data-bucket="${state.bucket}"]`)?.classList.add("active");
  state.draftKeys = new Set(await window.pulpo.draftsKeys().catch(() => []));
  renderRepoSelect();
  // La vista de Milestones es solo GitLab: no pintar una entrada muerta en GitHub.
  if (!isGitlab()) {
    $("#nav-milestones-section")?.classList.add("hidden");
    $("#bucket-milestones")?.classList.add("hidden");
  }

  const auth = await window.pulpo.authStatus();
  state.authSource = auth.source;
  if (auth.ok) {
    state.me = { login: auth.login, avatarUrl: auth.avatarUrl };
    $("#me").innerHTML = `<img src="${esc(auth.avatarUrl)}" alt="" /> ${esc(auth.login)}`;
  } else {
    $("#me").innerHTML = "";
    await renderWelcome();
    notifySelftestOnce();
    return;
  }
  if (!state.config.repos.length) {
    await renderRepoPicker();
    return;
  }
  await refresh();
  schedulePoll();
  if (IS_SELFTEST && SELFTEST_ROUTE === "history") enterHistory();
  if (IS_SELFTEST && SELFTEST_ROUTE === "merged") switchBucket("merged");
  if (IS_SELFTEST && SELFTEST_ROUTE === "milestones") enterMilestones();
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
  else renderList();
});
document.querySelectorAll(".bucket[data-bucket]").forEach((btn) =>
  btn.addEventListener("click", () => switchBucket(btn.dataset.bucket)),
);
$("#bucket-history").addEventListener("click", enterHistory);
$("#bucket-milestones").addEventListener("click", enterMilestones);
/* ============ paleta de comandos (⌘K) ============ */
function paletteEntries() {
  const entries = [];
  for (const pr of state.openPrs) {
    entries.push({
      label: `#${pr.number} ${pr.title}`,
      hint: `${pr.headRefName} → ${pr.baseRefName}`,
      run: () => exitHistoryToPR(pr.number),
    });
  }
  entries.push({ label: "Ir a: Histórico", hint: "grafo de ramas", run: enterHistory });
  if (isGitlab()) entries.push({ label: "Ir a: Milestones", hint: "tareas por persona", run: enterMilestones });
  for (const [bucket, label] of [["open", "Abiertas"], ["mine", "Mías"], ["review", "Para revisar"], ["draft", "Borradores"], ["merged", "Fusionadas"], ["closed", "Cerradas"]]) {
    entries.push({ label: `Ir a: ${label}`, hint: "bucket", run: () => switchBucket(bucket) });
  }
  if ((state.config?.repos || []).length > 1) {
    entries.push({ label: "Repo: ⭐ Todos los repos", hint: "vista agregada", run: () => switchRepo(ALL_REPOS) });
  }
  for (const repo of state.config?.repos || []) {
    entries.push({ label: `Repo: ${repo}`, hint: "cambiar repositorio", run: () => switchRepo(repo) });
  }
  entries.push({ label: "Refrescar", hint: "R", run: refresh });
  entries.push({ label: "Ajustes", hint: "⚙", run: openSettings });
  return entries;
}

function switchBucket(bucket) {
  state.view = "prs";
  state.bucket = bucket;
  if (!IS_SELFTEST) window.pulpo.setConfig({ lastBucket: bucket }).catch(() => {});
  document.querySelectorAll(".bucket").forEach((b) => b.classList.remove("active"));
  document.querySelector(`[data-bucket="${bucket}"]`)?.classList.add("active");
  closeDetail();
  refresh();
}

function switchRepo(repo) {
  state.repo = repo;
  if (!IS_SELFTEST) window.pulpo.setConfig({ lastRepo: repo }).catch(() => {});
  state.openPrs = [];
  state.prSnapshot = null;
  state.history = { branches: [], enabled: new Set(), layout: null, rows: [], loading: false, selectedOid: null };
  renderRepoSelect();
  closeDetail();
  if (state.view === "history") loadHistory();
  // Milestones es de grupo (global), no por repo: el cambio de repo no la afecta.
  else if (state.view !== "milestones") refresh();
}

function openPalette() {
  const root = $("#modal-root");
  let results = [];
  let cursor = 0;
  root.innerHTML = `
    <div class="modal-backdrop" id="palette-backdrop">
      <div class="palette">
        <input type="text" id="palette-input" placeholder="Busca PRs, repos o acciones…  (Esc para cerrar)" autocomplete="off" />
        <div id="palette-results"></div>
      </div>
    </div>`;
  const input = $("#palette-input");
  const resultsBox = $("#palette-results");

  const renderResults = () => {
    const q = input.value.trim().toLowerCase();
    results = paletteEntries().filter((e) => !q || `${e.label} ${e.hint}`.toLowerCase().includes(q)).slice(0, 12);
    cursor = Math.min(cursor, Math.max(0, results.length - 1));
    resultsBox.innerHTML = results
      .map(
        (e, i) => `<div class="palette-item ${i === cursor ? "active" : ""}" data-i="${i}">
          <span>${esc(e.label)}</span><span class="muted">${esc(e.hint)}</span>
        </div>`,
      )
      .join("") || `<div class="palette-item muted">Sin resultados</div>`;
    resultsBox.querySelectorAll(".palette-item[data-i]").forEach((el) =>
      el.addEventListener("click", () => {
        root.innerHTML = "";
        results[Number(el.dataset.i)]?.run();
      }),
    );
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
    ["⌘K", "Paleta de comandos (PRs, repos, acciones)"],
    ["j / k", "Moverse por la lista"],
    ["Enter", "Abrir la PR seleccionada"],
    ["1 – 6", "Abiertas · Mías · Para revisar · Borradores · Fusionadas · Cerradas"],
    ["h", "Histórico (grafo de ramas)"],
    ["m", "Milestones (tareas por persona · GitLab)"],
    ["r", "Refrescar"],
    ["Esc", "Cerrar el panel"],
    ["?", "Esta chuleta"],
  ];
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>⌨️ Atajos de teclado</h3>
        <table class="cheatsheet">${rows.map(([key, what]) => `<tr><td><kbd>${key}</kbd></td><td>${what}</td></tr>`).join("")}</table>
        <div class="modal-actions"><button class="btn" id="modal-cancel">Cerrar</button></div>
      </div>
    </div>`;
  $("#modal-cancel").addEventListener("click", () => (root.innerHTML = ""));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") root.innerHTML = "";
  });
}

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (typing) return;
  if (event.key === "?") return openCheatsheet();
  if (event.key === "Escape") return closeDetail();
  if (event.key === "r") return refresh();
  if (event.key === "j") return moveCursor(1);
  if (event.key === "k") return moveCursor(-1);
  if (event.key === "Enter" && state.view === "prs" && state.cursor >= 0) {
    const row = visiblePRRows()[state.cursor];
    if (row) openDetail(Number(row.dataset.number));
    return;
  }
  if (event.key === "h") return enterHistory();
  if (event.key === "m" && isGitlab()) return enterMilestones();
  const bucketByDigit = { 1: "open", 2: "mine", 3: "review", 4: "draft", 5: "merged", 6: "closed" };
  if (bucketByDigit[event.key]) switchBucket(bucketByDigit[event.key]);
});

boot();
