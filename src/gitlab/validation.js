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

const MERGED_QUERY = `query($path: ID!, $after: Time, $cursor: String) {
  project(fullPath: $path) {
    mergeRequests(state: merged, targetBranches: ["development"], mergedAfter: $after, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { iid title webUrl sourceBranch description updatedAt mergedAt mergeCommitSha author { username } approvedBy { nodes { username } } }
    }
  }
}`;

const DAY = 86400e3;

/**
 * Lo que hace falta para saber si una MR está en lo desplegado en `sha` (ver rules.mrInProduction):
 * los commits de development que la tag NO tiene (`missing`), los cherry-picks `-x` de los commits que
 * SOLO tiene la tag (`cherried`, el caso de una tag cortada de una rama `rb/`) y "autor|título" de la
 * historia de la tag (`deployedTitles`, para el mismo cambio rebaseado sin `-x`). `base` = el
 * merge-base con development: nada mergeado antes puede faltar.
 */
async function prodContext(id, sha) {
  const [toDev, onlyTag, base] = await Promise.all([
    api("GET", `/projects/${id}/repository/compare?from=${sha}&to=development`),
    api("GET", `/projects/${id}/repository/compare?from=development&to=${sha}`),
    api("GET", `/projects/${id}/repository/merge_base?refs[]=${sha}&refs[]=development`),
  ]);
  const missing = new Set((toDev?.commits || []).map((c) => c.id));
  const cherried = rules.cherryOrigins((onlyTag?.commits || []).map((c) => c.message));
  const deployedTitles = new Set();
  // ponytail: historia de la tag desde 60 días antes del merge-base, tope 3 páginas (300 commits).
  const since = new Date(Date.parse(base.committed_date) - 60 * DAY).toISOString();
  for (let page = 1; page <= 3; page++) {
    const list = await api("GET", `/projects/${id}/repository/commits?ref_name=${sha}&since=${since}&per_page=100&page=${page}`).catch(() => []);
    for (const c of list || []) deployedTitles.add(`${c.author_email}|${c.title}`);
    if (!list || list.length < 100) break;
  }
  return { missing, cherried, deployedTitles, baseDate: base.committed_date };
}

/**
 * MRs mergeadas a development que NO están en producción ES (rules.mrInProduction: ancestro de la tag
 * desplegada, cherry-pick o mismo cambio rebaseado). Sin límite de fecha: el corte es el merge-base de
 * lo desplegado con development (si la tag sale de una `rb/`, el punto donde se cortó la rama), y nada
 * mergeado antes puede faltar. Un repo sin despliegues en `production` (opensalud) no aporta nada.
 * Cada MR sale con `prod` a medias ({ byTag, mxPending }); `prodLookup` completa la tag y el ▶ después.
 */
async function pendingProduction(repo) {
  const id = proj(repo);
  const lastProd = async (env) =>
    (await api("GET", `/projects/${id}/deployments?environment=${env}&status=success&order_by=finished_at&sort=desc&per_page=1`).catch(() => []))[0] || null;
  const [es, mx] = await Promise.all([lastProd("production"), lastProd("production-mx")]);
  if (!es) return [];
  const [esCtx, mxCtx, waiting] = await Promise.all([
    prodContext(id, es.sha),
    mx ? prodContext(id, mx.sha).catch(() => null) : null,
    // El ▶ de producción de cada tag es su deployment `blocked` (o `running` si ya se pulsó): el nombre
    // del job cambia en cada proyecto (deploy, deploy:prod, deploy_production, deploy-nuxt…).
    Promise.all(["blocked", "running"].map((s) => api("GET", `/projects/${id}/deployments?environment=production&status=${s}&order_by=created_at&sort=desc&per_page=50`).catch(() => []))),
  ]);
  if (!esCtx.missing.size) return [];
  const byTag = new Map();
  for (const d of waiting.flat()) if (d.deployable && !byTag.has(d.ref)) byTag.set(d.ref, { id: d.deployable.id, name: d.deployable.name, status: d.deployable.status });
  // Un día de margen: la fecha del commit no es la de su merge.
  const after = new Date(Date.parse(esCtx.baseDate) - DAY).toISOString();
  const nodes = [];
  // ponytail: tope de 10 páginas (1000 MRs) por si producción llevase muchísimo sin desplegarse.
  for (let page = 0, cursor = null; page < 10; page++) {
    const conn = (await graphql(MERGED_QUERY, { path: repo, after, cursor }))?.project?.mergeRequests;
    nodes.push(...(conn?.nodes || []));
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  // Candidatas: su merge commit no es ancestro de la tag. Para descartar las que llegaron por otro
  // camino (cherry-pick, rebase) hacen falta sus commits: 1 REST por candidata.
  const candidates = nodes.filter((n) => n.mergeCommitSha && esCtx.missing.has(n.mergeCommitSha));
  const withCommits = await mapLimit(candidates, 8, async (n) => ({
    n,
    commits: (await api("GET", `/projects/${id}/merge_requests/${n.iid}/commits?per_page=100`).catch(() => [])) || [],
  }));
  const pending = withCommits.filter(({ n, commits }) => !rules.mrInProduction({ mergeSha: n.mergeCommitSha, commits }, esCtx));
  return pending.map(({ n, commits }) => ({
    ...mergedMr(repo, n),
    prod: { tag: null, checked: false, mxPending: mxCtx ? !rules.mrInProduction({ mergeSha: n.mergeCommitSha, commits }, mxCtx) : false, byTag },
  }));
}

function mergedMr(repo, n) {
  return {
    key: `${repo.split("/").pop()}!${n.iid}`,
    repo,
    iid: Number(n.iid),
    title: n.title,
    url: n.webUrl,
    merged: true,
    mergedAt: n.mergedAt,
    mergeSha: n.mergeCommitSha,
    draft: false,
    approved: true,
    approvedBy: (n.approvedBy?.nodes || []).map((u) => u.username),
    author: n.author?.username || null,
    branch: n.sourceBranch,
    updatedAt: n.updatedAt,
    citations: rules.parseCitations(n.description),
    pipeline: null,
    jobs: [],
  };
}

// Tag de producción que ya contiene el merge (y su ▶ de prod) o, sin tag, el ▶ publicar-tag-produccion
// del pipeline de development de ese merge.
async function prodLookup(mr, byTag) {
  const id = proj(mr.repo);
  const refs = await api("GET", `/projects/${id}/repository/commits/${mr.mergeSha}/refs?type=tag&per_page=100`).catch(() => []);
  const tag = rules.productionTag((refs || []).map((r) => r.name));
  const prod = { tag, mxPending: mr.prod.mxPending, checked: true, deployJob: null, publishJob: null };
  if (tag) prod.deployJob = byTag?.get(tag) || null;
  else {
    const [p] = (await api("GET", `/projects/${id}/pipelines?sha=${mr.mergeSha}&ref=development&per_page=1`).catch(() => [])) || [];
    const jobs = p ? await api("GET", `/projects/${id}/pipelines/${p.id}/jobs?per_page=100`).catch(() => []) : [];
    const j = (jobs || []).find((x) => x.name === "publicar-tag-produccion");
    prod.publishJob = j ? { id: j.id, name: j.name, status: j.status } : null;
  }
  return prod;
}

// ponytail: solo related_issues. closes_issues ("Closes #N") no lo usaba ninguna de las ~60 MRs
// (medido 2026-11-04) y doblaba las llamadas; si se empieza a usar, sumarlo aquí.
async function linkedIssues(mr) {
  const list = await api("GET", `/projects/${proj(mr.repo)}/merge_requests/${mr.iid}/related_issues`).catch(() => []);
  const seen = new Map();
  for (const i of list) if (i?.web_url && !seen.has(i.web_url)) seen.set(i.web_url, { url: i.web_url, title: i.title });
  return [...seen.values()];
}

// Columna, avisos y planes de una MR (se rehace cuando llega la info de producción de una mergeada).
function classify(mr) {
  const info = rules.mrStage(mr);
  mr.stage = info.stage;
  mr.stageIndex = rules.STAGES.indexOf(info.stage);
  mr.flow = info.flow;
  mr.sub = info.sub;
  mr.warnings = info.warnings;
  mr.flowJobs = info.jobs;
  // Plan para soltarla en cada columna posterior (la tarjeta junta los de sus MRs); en una mergeada,
  // su único paso hacia producción.
  mr.toward = rules.STAGES.map((_s, i) => rules.planToward(mr, info, i));
  mr.prodPlan = info.prodPlan || null;
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
  const guard = (repo, what) => (err) => {
    errors.push({ repo, error: `${what}${String(err.message || err)}` });
    return [];
  };
  const [who, perRepo] = await Promise.all([viewer().catch(() => null), mapLimit(repos, 8, (repo) => repoMRs(repo).catch(guard(repo, "")))]);
  // Producción va aparte y DESPUÉS de las abiertas (deployments + compare + mergeadas: ~15 s en frío;
  // en paralelo competía con ellas y la primera foto pasaba de ~2 a ~7 s). Sus MRs se suman al llegar.
  const mergedLater = mapLimit(repos, 8, (repo) => pendingProduction(repo).catch(guard(repo, "producción: ")));
  const me = who?.login;
  const mrs = [];
  const tagJobs = new Map(); // ▶ de producción por tag de cada repo: lo usa prodLookup y no viaja al renderer
  let loaded = 0;
  let last = 0;
  let total = 0;
  const snapshot = () => ({ cards: rules.groupTasks(mrs), errors, loaded, total });
  const push = (force) => {
    // Reagrupar es barato, repintar no tanto: como mucho un tablero parcial cada ~0,7 s.
    if (!force && Date.now() - last < 700) return;
    last = Date.now();
    onProgress(snapshot());
  };
  const add = (list) => {
    for (const mr of list) {
      if (mr.prod?.byTag) {
        tagJobs.set(mr.key, mr.prod.byTag);
        delete mr.prod.byTag;
      }
      mr.approvedByMe = !!me && mr.approvedBy.includes(me);
      const cached = issueCache.get(mr.key);
      mr.linked = cached?.updatedAt === mr.updatedAt;
      mr.issues = mr.linked ? cached.issues : [];
      Object.assign(mr, rules.taskAndEpic(mr));
      classify(mr);
      mrs.push(mr);
    }
    // Pendiente = sin issues en caché o (mergeada) sin su tag/▶ de producción comprobados.
    const pending = list.filter((mr) => !mr.linked || (mr.merged && !mr.prod.checked));
    total += list.length;
    loaded += list.length - pending.length;
    push(true);
    return mapLimit(pending, 12, async (mr) => {
      const [issues, prod] = await Promise.all([mr.linked ? mr.issues : linkedIssues(mr), mr.merged ? prodLookup(mr, tagJobs.get(mr.key)) : null]);
      mr.issues = issues;
      issueCache.set(mr.key, { updatedAt: mr.updatedAt, issues });
      Object.assign(mr, rules.taskAndEpic(mr));
      if (prod) {
        mr.prod = prod;
        classify(mr);
      }
      loaded++;
      push(false);
    });
  };
  await Promise.all([add(perRepo.flat()), mergedLater.then((merged) => add(merged.flat()))]);
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
