"use strict";

// Implementación del proveedor GitLab. Expone la MISMA interfaz pública que
// src/github.js y normaliza Merge Requests -> forma de "Pull Request" de GitHub,
// que es la que consume el renderer. Soporta gitlab.com y self-hosted (la base
// se lee de config.gitlabBaseUrl). Ver el contrato de enums más abajo: el
// renderer ramifica sobre valores literales exactos, no sobre la forma.

const { execFileSync } = require("child_process");
const config = require("./config");

let cachedToken = null;
let cachedTokenSource = null;

function settings() {
  const cfg = config.load();
  const base = (cfg.gitlabBaseUrl || "https://gitlab.com").replace(/\/+$/, "");
  return { base, apiBase: `${base}/api/v4`, host: new URL(base).host };
}

function resolveToken() {
  if (cachedToken) return { token: cachedToken, source: cachedTokenSource };

  if (process.env.GITLAB_TOKEN) {
    cachedToken = process.env.GITLAB_TOKEN.trim();
    cachedTokenSource = "env:GITLAB_TOKEN";
    return { token: cachedToken, source: cachedTokenSource };
  }
  try {
    const { host } = settings();
    // OJO: en glab el flag es --host; -h es --help (devolvería el texto de ayuda).
    const out = execFileSync("glab", ["config", "get", "token", "--host", host], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (out) {
      cachedToken = out;
      cachedTokenSource = "glab CLI";
      return { token: cachedToken, source: cachedTokenSource };
    }
  } catch {
    /* glab no disponible o sin login: probamos config */
  }
  const stored = config.load().token;
  if (stored) {
    cachedToken = stored;
    cachedTokenSource = "config.json";
    return { token: cachedToken, source: cachedTokenSource };
  }
  return { token: null, source: null };
}

function invalidateTokenCache() {
  cachedToken = null;
  cachedTokenSource = null;
}

async function api(method, path, body) {
  const { token } = resolveToken();
  if (!token) throw new Error("NO_TOKEN");
  const { apiBase } = settings();
  const headers = { "PRIVATE-TOKEN": token, "User-Agent": "pulpo-app" };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return json;
}

/** Recorre todas las páginas (per_page=100) de un endpoint que devuelve un array. */
async function apiAll(path) {
  const out = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= 5; page++) {
    const batch = await api("GET", `${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (!Array.isArray(batch) || batch.length < 100) break;
  }
  return out;
}

const proj = (repoFullName) => encodeURIComponent(repoFullName);

/* ---------- normalización (forma GitHub) ---------- */

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// GitLab da markdown crudo (no HTML sanitizado). Lo escapamos y respetamos
// saltos de línea: no es markdown renderizado pero es seguro y legible.
function mdToSafeHtml(body) {
  if (!body) return "";
  return `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>`;
}

function mapUser(u) {
  return u ? { login: u.username, avatarUrl: u.avatar_url } : null;
}

function mapState(mrState) {
  if (mrState === "merged") return "MERGED";
  if (mrState === "closed" || mrState === "locked") return "CLOSED";
  return "OPEN";
}

// El renderer habilita el botón merge SOLO si mergeable==="MERGEABLE" y
// mergeStateStatus ∈ {CLEAN,UNSTABLE,HAS_HOOKS}. Traducimos detailed_merge_status
// (GitLab 15.6+) a esos tokens; si no está, caemos a merge_status.
function mapMergeStatus(mr) {
  const detailed = mr.detailed_merge_status;
  const byDetailed = {
    mergeable: ["MERGEABLE", "CLEAN"],
    conflict: ["CONFLICTING", "DIRTY"],
    broken_status: ["CONFLICTING", "DIRTY"],
    need_rebase: ["MERGEABLE", "BEHIND"],
    ci_must_pass: ["MERGEABLE", "BLOCKED"],
    ci_still_running: ["MERGEABLE", "BLOCKED"],
    not_approved: ["MERGEABLE", "BLOCKED"],
    blocked_status: ["MERGEABLE", "BLOCKED"],
    discussions_not_resolved: ["MERGEABLE", "BLOCKED"],
    draft_status: ["MERGEABLE", "BLOCKED"],
    external_status_checks: ["MERGEABLE", "BLOCKED"],
    requested_changes: ["MERGEABLE", "BLOCKED"],
    not_open: ["MERGEABLE", "BLOCKED"],
  };
  if (detailed && byDetailed[detailed]) {
    const [mergeable, mergeStateStatus] = byDetailed[detailed];
    return { mergeable, mergeStateStatus };
  }
  // Fallback: merge_status (can_be_merged / cannot_be_merged / checking / unchecked)
  if (mr.merge_status === "cannot_be_merged") return { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
  if (mr.merge_status === "can_be_merged") return { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
  return { mergeable: "UNKNOWN", mergeStateStatus: "UNSTABLE" };
}

// head_pipeline.status (GitLab) -> statusCheckRollup.state (GitHub).
function mapPipeline(pipeline) {
  if (!pipeline || !pipeline.status) return null;
  const map = {
    success: "SUCCESS",
    failed: "FAILURE",
    canceled: "ERROR",
    skipped: "SUCCESS",
    manual: "PENDING",
    running: "PENDING",
    pending: "PENDING",
    created: "PENDING",
    preparing: "PENDING",
    scheduled: "PENDING",
    waiting_for_resource: "PENDING",
  };
  const state = map[pipeline.status] || "EXPECTED";
  return { state, contexts: { nodes: [] } };
}

// approvals (/approvals) + reviewers -> reviewDecision, latestReviews (facepile),
// reviewRequests (dock badge "awaiting my review").
function mapReviews(mr, approvals) {
  const approvedBy = approvals?.approved_by || [];
  const approvedLogins = new Set(approvedBy.map((a) => a.user?.username));
  const latestReviews = {
    // databaseId (id de usuario) sólo para que el renderer sepa que la review es "desaprobable";
    // dismissReview en GitLab no lo usa (unapprove actúa sobre la MR, no sobre una review).
    nodes: approvedBy.map((a) => ({ databaseId: a.user?.id || null, author: mapUser(a.user), state: "APPROVED" })),
  };
  // Reviewers asignados que aún no han aprobado = revisión pendiente.
  const reviewRequests = {
    nodes: (mr.reviewers || [])
      .filter((u) => !approvedLogins.has(u.username))
      .map((u) => ({ requestedReviewer: { __typename: "User", login: u.username } })),
  };
  let reviewDecision = null;
  if (mr.detailed_merge_status === "requested_changes") reviewDecision = "CHANGES_REQUESTED";
  else if (approvals && approvals.approved === true) reviewDecision = "APPROVED";
  else if ((mr.reviewers || []).length || (approvals && approvals.approvals_required > 0)) reviewDecision = "REVIEW_REQUIRED";
  return { latestReviews, reviewRequests, reviewDecision };
}

function mapLabels(mr) {
  // GitLab da nombres de label; el color real exige otra llamada. Color neutro.
  const details = mr.labels_with_details || mr.label_details;
  if (Array.isArray(details) && details.length && typeof details[0] === "object") {
    return { nodes: details.slice(0, 6).map((l) => ({ name: l.name, color: (l.color || "#888888").replace(/^#/, "") })) };
  }
  return { nodes: (mr.labels || []).slice(0, 6).map((name) => ({ name, color: "888888" })) };
}

// Forma base MR -> PR. `approvals` opcional (enriquecimiento para facepile/decision).
function mapMr(mr, approvals) {
  const repoPath = mr.references?.full ? mr.references.full.split("!")[0] : null;
  const { mergeable, mergeStateStatus } = mapMergeStatus(mr);
  const { latestReviews, reviewRequests, reviewDecision } = mapReviews(mr, approvals);
  const changedFiles = Number.parseInt(mr.changes_count, 10) || 0;
  return {
    id: encodeId(repoPath || projectPathFromRefs(mr), mr.iid),
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    isDraft: Boolean(mr.draft || mr.work_in_progress),
    state: mapState(mr.state),
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    baseRefName: mr.target_branch,
    headRefName: mr.source_branch,
    isCrossRepository: mr.source_project_id !== mr.target_project_id,
    repository: { nameWithOwner: repoPath || projectPathFromRefs(mr) },
    headRepository: { nameWithOwner: repoPath || projectPathFromRefs(mr) },
    author: mapUser(mr.author),
    mergeable,
    mergeStateStatus,
    reviewDecision,
    additions: 0,
    deletions: 0,
    changedFiles,
    comments: { totalCount: mr.user_notes_count ?? 0 },
    labels: mapLabels(mr),
    reviewRequests,
    latestReviews,
    commits: { nodes: [{ commit: { statusCheckRollup: mapPipeline(mr.head_pipeline) } }] },
  };
}

function projectPathFromRefs(mr) {
  // Cuando no viene references.full intentamos sacar el path de web_url.
  try {
    const u = new URL(mr.web_url);
    return u.pathname.replace(/^\//, "").split("/-/")[0];
  } catch {
    return "";
  }
}

/* ---------- id codificado para mutaciones (renderer pasa pr.id) ---------- */

function encodeId(repoFullName, iid) {
  return `gl:${encodeURIComponent(repoFullName)}#${iid}`;
}

function decodeId(id) {
  const m = /^gl:([^#]+)#(\d+)$/.exec(id || "");
  if (!m) throw new Error(`id GitLab no válido: ${id}`);
  return { repo: decodeURIComponent(m[1]), iid: Number(m[2]) };
}

/* ---------- interfaz pública ---------- */

async function viewer() {
  const me = await api("GET", "/user");
  return { login: me.username, avatarUrl: me.avatar_url };
}

async function viewerRepos() {
  // Sin simple=true: necesitamos `visibility` para el chip "privado".
  const projects = await api(
    "GET",
    "/projects?membership=true&order_by=last_activity_at&archived=false&per_page=50",
  );
  return projects.map((p) => ({ nameWithOwner: p.path_with_namespace, isPrivate: p.visibility !== "public" }));
}

const GL_STATE = { OPEN: "opened", MERGED: "merged", CLOSED: "closed" };

async function listPRs(repoFullName, states) {
  const glState = GL_STATE[states[0]] || "opened";
  const mrs = await api(
    "GET",
    `/projects/${proj(repoFullName)}/merge_requests?state=${glState}&order_by=updated_at&per_page=50`,
  );
  // Enriquecemos solo las abiertas con approvals (facepile + decisión de review).
  if (glState === "opened") {
    const approvals = await Promise.all(
      mrs.map((mr) =>
        api("GET", `/projects/${proj(repoFullName)}/merge_requests/${mr.iid}/approvals`).catch(() => null),
      ),
    );
    return mrs.map((mr, i) => mapMr(mr, approvals[i]));
  }
  return mrs.map((mr) => mapMr(mr));
}

async function searchPRs(repoFullNames, states) {
  const lists = await Promise.all(repoFullNames.map((r) => listPRs(r, states).catch(() => [])));
  return lists.flat().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

async function prDetail(repoFullName, number) {
  const mr = await api("GET", `/projects/${proj(repoFullName)}/merge_requests/${number}`);
  const approvals = await api(
    "GET",
    `/projects/${proj(repoFullName)}/merge_requests/${number}/approvals`,
  ).catch(() => null);
  const pr = mapMr(mr, approvals);
  pr.body = mr.description || "";
  pr.bodyHTML = mdToSafeHtml(mr.description);
  return pr;
}

/** Merge SIEMPRE con merge commit (squash:false). Squash no existe en esta casa. */
async function mergePR(repoFullName, number, { deleteBranch, isCrossRepository }) {
  const removeSource = Boolean(deleteBranch) && !isCrossRepository;
  const result = await api("PUT", `/projects/${proj(repoFullName)}/merge_requests/${number}/merge`, {
    squash: false,
    should_remove_source_branch: removeSource,
  });
  return { merged: result.state === "merged", sha: result.merge_commit_sha, branchDeleted: removeSource };
}

/** Update branch SIEMPRE con rebase. */
async function updateBranchRebase(encodedId) {
  const { repo, iid } = decodeId(encodedId);
  await api("PUT", `/projects/${proj(repo)}/merge_requests/${iid}/rebase`);
  return { number: iid };
}

/* ---------- histórico (grafo de commits) ---------- */

async function defaultBranch(repoFullName) {
  const project = await api("GET", `/projects/${proj(repoFullName)}`);
  return project.default_branch || "main";
}

async function branchHistories(repoFullName, branchSpecs) {
  const branches = [];
  const commitsByOid = new Map();
  for (const spec of branchSpecs) {
    const commits = await api(
      "GET",
      `/projects/${proj(repoFullName)}/repository/commits?ref_name=${encodeURIComponent(spec.name)}&per_page=${spec.depth}`,
    ).catch(() => []);
    if (!commits.length) continue;
    branches.push({ name: spec.name, headOid: commits[0].id });
    for (const c of commits) {
      if (commitsByOid.has(c.id)) continue;
      commitsByOid.set(c.id, {
        oid: c.id,
        abbreviatedOid: c.short_id,
        messageHeadline: c.title,
        committedDate: c.committed_date,
        author: { name: c.author_name, user: null },
        parents: { nodes: (c.parent_ids || []).map((oid) => ({ oid })) },
        associatedPullRequests: { nodes: [] },
      });
    }
  }
  return { branches, commits: [...commitsByOid.values()] };
}

/* ---------- diff + conversación ---------- */

function countDiff(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of (diff || "").split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

async function prFiles(repoFullName, number) {
  const diffs = await apiAll(`/projects/${proj(repoFullName)}/merge_requests/${number}/diffs`);
  return diffs.map((d) => {
    const { additions, deletions } = countDiff(d.diff);
    return {
      filename: d.new_path,
      previousFilename: d.renamed_file ? d.old_path : null,
      status: d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified",
      additions,
      deletions,
      patch: d.diff || null,
    };
  });
}

async function prConversation(repoFullName, number) {
  const mr = await api("GET", `/projects/${proj(repoFullName)}/merge_requests/${number}`);
  const discussions = await apiAll(`/projects/${proj(repoFullName)}/merge_requests/${number}/discussions`);
  const comments = [];
  const reviewThreads = [];
  for (const d of discussions) {
    const notes = (d.notes || []).filter((n) => !n.system);
    if (!notes.length) continue;
    const positioned = notes[0].position;
    if (positioned) {
      const pos = notes[0].position;
      reviewThreads.push({
        // id propio (glthread:) para resolver/reabrir la discussion vía setThreadResolved.
        id: `glthread:${encodeURIComponent(repoFullName)}#${number}#${encodeURIComponent(d.id)}`,
        viewerCanResolve: true,
        viewerCanUnresolve: true,
        path: pos.new_path || pos.old_path,
        line: pos.new_line ?? pos.old_line,
        startLine: pos.line_range?.start?.new_line ?? null,
        isResolved: Boolean(notes[0].resolved),
        isOutdated: false,
        // databaseId = id de la DISCUSSION (lo que necesita el reply de GitLab).
        comments: {
          nodes: notes.map((n) => ({
            databaseId: d.id,
            author: mapUser(n.author),
            bodyHTML: mdToSafeHtml(n.body),
            createdAt: n.created_at,
          })),
        },
      });
    } else {
      for (const n of notes) {
        comments.push({ author: mapUser(n.author), bodyHTML: mdToSafeHtml(n.body), createdAt: n.created_at });
      }
    }
  }
  return {
    headRefOid: mr.diff_refs?.head_sha || mr.sha,
    comments: { totalCount: comments.length, nodes: comments },
    reviewThreads: { nodes: reviewThreads },
  };
}

async function addIssueComment(repoFullName, number, body) {
  return api("POST", `/projects/${proj(repoFullName)}/merge_requests/${number}/notes`, { body });
}

/** Resuelve/reabre una discussion de la MR (equivalente GitLab del resolve thread de GitHub). */
async function setThreadResolved(threadId, resolved) {
  const m = /^glthread:([^#]+)#(\d+)#(.+)$/.exec(threadId || "");
  if (!m) throw new Error(`id de hilo GitLab no válido: ${threadId}`);
  return api("PUT", `/projects/${m[1]}/merge_requests/${m[2]}/discussions/${m[3]}`, { resolved });
}

/** "Quitar aprobación": GitLab no tiene dismissal de reviews; equivale a unapprove de la MR. */
async function dismissReview(repoFullName, number) {
  return api("POST", `/projects/${proj(repoFullName)}/merge_requests/${number}/unapprove`);
}

async function diffRefs(repoFullName, number) {
  const mr = await api("GET", `/projects/${proj(repoFullName)}/merge_requests/${number}`);
  return mr.diff_refs || {};
}

function buildPosition(refs, { path, side, line }) {
  const position = {
    position_type: "text",
    base_sha: refs.base_sha,
    head_sha: refs.head_sha,
    start_sha: refs.start_sha,
    new_path: path,
    old_path: path,
  };
  if (side === "LEFT") position.old_line = line;
  else position.new_line = line;
  return position;
}

async function addInlineComment(repoFullName, number, { body, path, side, line }) {
  const refs = await diffRefs(repoFullName, number);
  return api("POST", `/projects/${proj(repoFullName)}/merge_requests/${number}/discussions`, {
    body,
    position: buildPosition(refs, { path, side, line }),
  });
}

async function replyToThread(repoFullName, number, discussionId, body) {
  return api("POST", `/projects/${proj(repoFullName)}/merge_requests/${number}/discussions/${discussionId}/notes`, {
    body,
  });
}

/**
 * Publica de golpe todos los borradores. GitLab no tiene "review batch" como
 * GitHub: emitimos las notas inline (discussions) + nota general + veredicto.
 * APPROVE -> /approve. COMMENT -> solo notas. REQUEST_CHANGES -> nota (caveat).
 */
async function submitReview(repoFullName, number, { event, body, comments }) {
  const base = `/projects/${proj(repoFullName)}/merge_requests/${number}`;
  if (comments?.length) {
    const refs = await diffRefs(repoFullName, number);
    for (const c of comments) {
      await api("POST", `${base}/discussions`, {
        body: c.body,
        position: buildPosition(refs, { path: c.path, side: c.side, line: c.line }),
      });
    }
  }
  if (body) await api("POST", `${base}/notes`, { body });
  if (event === "APPROVE") await api("POST", `${base}/approve`);
  if (event === "REQUEST_CHANGES" && !body) {
    await api("POST", `${base}/notes`, { body: "Se solicitan cambios." });
  }
  return { submitted: true };
}

/* ---------- acciones sobre el grafo ---------- */

async function createBranch(repoFullName, branchName, sha) {
  return api("POST", `/projects/${proj(repoFullName)}/repository/branches`, { branch: branchName, ref: sha });
}

/**
 * GitLab no tiene force-update de ref (a diferencia del PATCH atómico de GitHub).
 * Lo simulamos con borrar+recrear, que NO es atómico: si el POST falla tras el
 * DELETE, la rama queda borrada. Para minimizar el riesgo verificamos que el SHA
 * destino existe ANTES de borrar, y si la recreación falla informamos del SHA
 * para poder recrearla a mano.
 */
async function forceUpdateBranch(repoFullName, branchName, sha) {
  // Falla pronto (sin tocar la rama) si el SHA no existe.
  await api("GET", `/projects/${proj(repoFullName)}/repository/commits/${encodeURIComponent(sha)}`);
  await api("DELETE", `/projects/${proj(repoFullName)}/repository/branches/${encodeURIComponent(branchName)}`);
  try {
    return await api("POST", `/projects/${proj(repoFullName)}/repository/branches`, { branch: branchName, ref: sha });
  } catch (err) {
    throw new Error(`Rama "${branchName}" borrada pero no se pudo recrear en ${sha}: ${err.message}. Recréala a mano.`);
  }
}

/**
 * Cherry-pick del contenido de una MR (el merge commit) sobre otra rama.
 * GitLab acepta el SHA del merge commit y replica el rango completo de la MR,
 * igual que el botón "Cherry-pick" de la UI de la MR.
 * Con dryRun no escribe: sirve para anticipar conflictos antes de ofrecerlo.
 * No lanza: devuelve {branch, ok, error?} para poder reportar por-rama (no atómico entre N ramas).
 */
async function cherryPick(repoFullName, sha, branch, { dryRun = false } = {}) {
  const body = { branch };
  if (dryRun) body.dry_run = true;
  try {
    await api("POST", `/projects/${proj(repoFullName)}/repository/commits/${encodeURIComponent(sha)}/cherry_pick`, body);
    return { branch, ok: true };
  } catch (err) {
    return { branch, ok: false, error: String(err.message || err) };
  }
}

/** GitLab revierte creando un commit directo en la rama destino (no abre MR). */
async function revertPullRequest(encodedId) {
  const { repo, iid } = decodeId(encodedId);
  const mr = await api("GET", `/projects/${proj(repo)}/merge_requests/${iid}`);
  const sha = mr.merge_commit_sha || mr.sha;
  const commit = await api("POST", `/projects/${proj(repo)}/repository/commits/${sha}/revert`, {
    branch: mr.target_branch,
  });
  return { number: null, url: commit.web_url };
}

/** Alterna entre borrador y listo vía prefijo "Draft: " en el título. */
async function setPrDraft(encodedId, toDraft) {
  const { repo, iid } = decodeId(encodedId);
  const mr = await api("GET", `/projects/${proj(repo)}/merge_requests/${iid}`);
  const stripped = mr.title.replace(/^(\[?draft\]?:?\s*|\[?wip\]?:?\s*)/i, "");
  const title = toDraft ? `Draft: ${stripped}` : stripped;
  const updated = await api("PUT", `/projects/${proj(repo)}/merge_requests/${iid}`, { title });
  return { number: iid, isDraft: Boolean(updated.draft || updated.work_in_progress) };
}

/** El renderer pasa repo+number; devolvemos el id codificado que usan las mutaciones. */
async function prNodeId(repoFullName, number) {
  return encodeId(repoFullName, number);
}

/* ---------- milestones (vista de tareas por persona) ---------- */

// Grupo del que leer milestones e issues. Si no hay uno explícito en config,
// se deriva del primer segmento del primer repo (group/sub/project -> group).
function milestonesGroup() {
  const cfg = config.load();
  const explicit = cfg.milestones?.group;
  if (explicit) return explicit;
  const first = (cfg.repos || [])[0] || "";
  return first.split("/")[0] || null;
}

function mapMilestone(m) {
  return {
    id: m.id,
    iid: m.iid,
    title: m.title,
    description: m.description || "",
    dueDate: m.due_date || null,
    startDate: m.start_date || null,
    state: m.state, // "active" | "closed"
    webUrl: m.web_url,
  };
}

function mapAssignee(u) {
  // id numérico necesario para assignee_ids al reasignar; el resto es para pintar.
  return { id: u.id, username: u.username, name: u.name || u.username, avatarUrl: u.avatar_url || null };
}

// Con with_labels_details=true, `labels` llega como objetos {name,color,text_color}.
function mapIssue(issue) {
  const labels = (issue.labels || []).map((l) =>
    typeof l === "string" ? { name: l, color: null, textColor: null } : { name: l.name, color: l.color, textColor: l.text_color },
  );
  const description = issue.description || "";
  return {
    iid: issue.iid,
    projectId: issue.project_id,
    // references.full = "group/project#iid"; nos quedamos con el path del proyecto.
    projectPath: (issue.references?.full || "").replace(/#\d+$/, ""),
    title: issue.title,
    descriptionHtml: mdToSafeHtml(description), // markdown crudo -> HTML seguro (no inyectar sin escapar)
    hasDescription: Boolean(description.trim()),
    state: issue.state, // "opened" | "closed"
    webUrl: issue.web_url,
    labels,
    assignees: (issue.assignees || []).map(mapAssignee),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

async function listMilestones() {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para milestones (revisa repos o config.milestones.group).");
  const ms = await apiAll(`/groups/${encodeURIComponent(group)}/milestones?state=active&include_ancestors=true`);
  return ms.map(mapMilestone);
}

// OJO: el parámetro de la API de issues es `milestone` (título), NO `milestone_title`
// (ese es para el endpoint de milestones); si te equivocas, GitLab lo ignora en silencio
// y te devuelve TODOS los issues del grupo. Por defecto solo abiertas: las cerradas
// (que pueden ser miles en un grupo activo) no deben comerse el límite de paginación.
async function milestoneIssues(milestoneTitle, { includeClosed = false } = {}) {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para milestones (revisa repos o config.milestones.group).");
  const enc = encodeURIComponent(group);
  const mt = encodeURIComponent(milestoneTitle);
  const state = includeClosed ? "all" : "opened";
  const issues = await apiAll(`/groups/${enc}/issues?milestone=${mt}&state=${state}&with_labels_details=true`);
  return issues.map(mapIssue);
}

// Labels del grupo, para poder asignar cualquiera (no solo las de estado configuradas).
async function groupLabels() {
  const group = milestonesGroup();
  if (!group) throw new Error("No hay grupo configurado para milestones (revisa repos o config.milestones.group).");
  const labels = await apiAll(`/groups/${encodeURIComponent(group)}/labels?with_counts=false`);
  return labels.map((l) => ({ name: l.name, color: l.color, textColor: l.text_color }));
}

// Edita un issue (etiquetas / milestone / asignados). Los issues se leen del grupo
// pero las mutaciones van por proyecto. NO es atómico entre varios issues: el llamador
// (renderer) aplica en serie y reporta; un fallo a medias deja unos hechos y otros no.
// patch: { addLabels?, removeLabels?, milestoneId?, assigneeIds? }.
async function updateIssue(projectId, iid, patch) {
  const body = {};
  if (patch.addLabels?.length) body.add_labels = patch.addLabels.join(",");
  if (patch.removeLabels?.length) body.remove_labels = patch.removeLabels.join(",");
  // milestone_id: 0 desasigna el milestone; un id real lo asigna (los de grupo valen).
  if ("milestoneId" in patch) body.milestone_id = patch.milestoneId == null ? 0 : patch.milestoneId;
  if (patch.assigneeIds) body.assignee_ids = patch.assigneeIds.length ? patch.assigneeIds : [0];
  const updated = await api("PUT", `/projects/${projectId}/issues/${iid}`, body);
  return mapIssue(updated);
}

module.exports = {
  resolveToken,
  invalidateTokenCache,
  viewer,
  viewerRepos,
  listPRs,
  searchPRs,
  prDetail,
  mergePR,
  updateBranchRebase,
  defaultBranch,
  branchHistories,
  prFiles,
  prConversation,
  addIssueComment,
  addInlineComment,
  replyToThread,
  setThreadResolved,
  dismissReview,
  submitReview,
  createBranch,
  forceUpdateBranch,
  cherryPick,
  revertPullRequest,
  setPrDraft,
  prNodeId,
  listMilestones,
  milestoneIssues,
  groupLabels,
  updateIssue,
};
