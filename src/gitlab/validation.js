"use strict";

// Tablero de Validación (solo GitLab): las MRs abiertas hacia development de los repos
// configurados, agrupadas por tarea y colocadas en su columna por src/validation-rules.js.
// Coste: 1 GraphQL por repo (MRs + Approve + jobs del head pipeline) + 2 REST por MR (sus issues:
// GraphQL no expone closes_issues/related_issues).

const { api, graphql, mapLimit, proj, viewer } = require("./core");
const rules = require("../validation-rules");

const MR_QUERY = `query($path: ID!) {
  project(fullPath: $path) {
    mergeRequests(state: opened, targetBranches: ["development"], first: 100) {
      nodes {
        iid title draft approved webUrl sourceBranch description updatedAt
        author { username }
        approvedBy { nodes { username } }
        headPipeline { status path jobs(retried: false, first: 100) { nodes { id name status webPath } } }
      }
    }
  }
}`;

const gidNumber = (gid) => Number(String(gid).split("/").pop());

async function repoMRs(repo) {
  const data = await graphql(MR_QUERY, { path: repo });
  return (data?.project?.mergeRequests?.nodes || []).map((n) => {
    const hp = n.headPipeline;
    // Pipeline y job solo dan rutas relativas en GraphQL: se cuelgan del origen de la MR.
    const abs = (p) => (p ? new URL(p, n.webUrl).toString() : null);
    return {
      key: `${repo.split("/").pop()}!${n.iid}`,
      repo,
      iid: Number(n.iid),
      title: n.title,
      url: n.webUrl,
      draft: !!n.draft,
      approved: !!n.approved,
      approvedBy: (n.approvedBy?.nodes || []).map((u) => u.username),
      author: n.author?.username || null,
      branch: n.sourceBranch,
      updatedAt: n.updatedAt,
      citations: rules.parseCitations(n.description),
      pipeline: hp ? { status: String(hp.status).toLowerCase(), url: abs(hp.path) } : null,
      jobs: (hp?.jobs?.nodes || []).map((j) => ({ id: gidNumber(j.id), name: j.name, status: String(j.status).toLowerCase(), url: abs(j.webPath) })),
    };
  });
}

// ponytail: solo related_issues. closes_issues ("Closes #N") no lo usaba ninguna de las ~60 MRs
// (medido 2026-11-04) y doblaba las llamadas; si se empieza a usar, sumarlo aquí.
async function linkedIssues(mr) {
  const list = await api("GET", `/projects/${proj(mr.repo)}/merge_requests/${mr.iid}/related_issues`).catch(() => []);
  const seen = new Map();
  for (const i of list) if (i?.web_url && !seen.has(i.web_url)) seen.set(i.web_url, { url: i.web_url, title: i.title });
  return [...seen.values()];
}

// Issues enlazados por MR ("proyecto!iid" → { updatedAt, issues }): editar la descripción cambia
// updatedAt, así que solo se vuelven a pedir los de las MRs que han cambiado. Vive lo que la app.
const issueCache = new Map();

/**
 * { cards, errors, loaded, total }: una tarjeta por tarea (o MR suelta) con sus MRs, columna y planes
 * por destino. La columna sale de GraphQL (~1 s); los issues (tareas/epics) son 1 REST por MR, así
 * que `onProgress` recibe el tablero en cuanto hay columnas y otra vez según se van enlazando.
 */
async function validationBoard(repos, onProgress = () => {}) {
  const errors = [];
  const [who, perRepo] = await Promise.all([
    viewer().catch(() => null),
    mapLimit(repos, 8, (repo) =>
      repoMRs(repo).catch((err) => {
        errors.push({ repo, error: String(err.message || err) });
        return [];
      }),
    ),
  ]);
  const me = who?.login;
  const mrs = perRepo.flat();
  for (const mr of mrs) {
    mr.approvedByMe = !!me && mr.approvedBy.includes(me);
    const cached = issueCache.get(mr.key);
    mr.linked = cached?.updatedAt === mr.updatedAt;
    mr.issues = mr.linked ? cached.issues : [];
    Object.assign(mr, rules.taskAndEpic(mr));
    const info = rules.mrStage(mr);
    mr.stage = info.stage;
    mr.stageIndex = rules.STAGES.indexOf(info.stage);
    mr.flow = info.flow;
    mr.sub = info.sub;
    mr.warnings = info.warnings;
    mr.flowJobs = info.jobs;
    // Plan para soltarla en cada columna posterior (la tarjeta junta los de sus MRs).
    mr.toward = rules.STAGES.map((_s, i) => rules.planToward(mr, info, i));
  }
  const pending = mrs.filter((mr) => !mr.linked);
  let loaded = mrs.length - pending.length;
  const snapshot = () => ({ cards: rules.groupTasks(mrs), errors, loaded, total: mrs.length });
  if (pending.length) onProgress(snapshot());
  let last = Date.now();
  await mapLimit(pending, 12, async (mr) => {
    mr.issues = await linkedIssues(mr);
    issueCache.set(mr.key, { updatedAt: mr.updatedAt, issues: mr.issues });
    Object.assign(mr, rules.taskAndEpic(mr));
    loaded++;
    // Reagrupar es barato, repintar no tanto: como mucho un tablero parcial cada ~0,7 s.
    if (Date.now() - last > 700) {
      last = Date.now();
      onProgress(snapshot());
    }
  });
  return snapshot();
}

/** Una acción del tablero sobre una MR: approve, ▶ (play) o ↻ (retry) de un job de su pipeline. */
async function validationAct(repo, iid, kind, jobId) {
  const id = proj(repo);
  if (kind === "approve") {
    await api("POST", `/projects/${id}/merge_requests/${iid}/approve`);
    return { ok: true };
  }
  const j = await api("POST", `/projects/${id}/jobs/${jobId}/${kind === "retry" ? "retry" : "play"}`);
  return { ok: true, jobId: j.id, status: j.status, url: j.web_url || null };
}

module.exports = { validationBoard, validationAct };
