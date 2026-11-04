"use strict";

// Reglas puras del tablero de Validación (sin red ni electron: las prueba scripts/test-validation.js).
// Cada MR cae en una columna según el Approve de GitLab y los jobs del flujo delivery-flow de su
// head pipeline (OpenSaludGroup/delivery-flow, README "El pipeline de una MR"):
//   2.x: ▶ aprobar-para-probar → desplegar-en-dev (automático) → ▶ validar-qa-para-mergear
//   1.x: ▶ deploy:dev → ▶ qa:validado
// Un push nuevo crea un pipeline nuevo y la MR vuelve a "Aprobada": hay que pulsar el ▶ otra vez.

// "merged" = mergeada a development pero aún no en producción ES (se sale de ahí al desplegar).
const STAGES = ["unapproved", "approved", "testing", "tested", "merged"];

const PRODUCTION_TAG = /^(\d{4})\.(\d{2})\.(\d+)$/; // las de MX llevan -mx y no cuentan para ES

const FLOWS = {
  v2: { gate: "aprobar-para-probar", deploy: "desplegar-en-dev", validate: "validar-qa-para-mergear" },
  v1: { gate: null, deploy: "deploy:dev", validate: "qa:validado" },
};

// `created` no está: es "esperando a que acabe lo anterior" (en 1.x, deploy:dev sin lanzar el build).
const RUNNING = ["waiting_for_resource", "preparing", "pending", "running", "scheduled"];

function jobByName(jobs, name) {
  return name ? (jobs || []).find((j) => j.name === name) || null : null;
}

/**
 * Columna de una MR. `mr` = { approved, draft, pipeline, jobs: [{ id, name, status }] } con los
 * status en minúsculas. Devuelve { stage, flow, sub, warnings, jobs: { gate, deploy, validate } }.
 * Si el pipeline va por delante del Approve, manda el pipeline (con aviso "sin Approve").
 */
function mrStage(mr) {
  if (mr.merged) return prodStage(mr);
  const jobs = mr.jobs || [];
  const flowKey = jobByName(jobs, FLOWS.v2.gate) ? "v2" : jobByName(jobs, FLOWS.v1.deploy) ? "v1" : null;
  const flow = flowKey ? FLOWS[flowKey] : null;
  const j = flow
    ? { gate: jobByName(jobs, flow.gate), deploy: jobByName(jobs, flow.deploy), validate: jobByName(jobs, flow.validate) }
    : { gate: null, deploy: null, validate: null };
  const warnings = [];
  if (mr.draft) warnings.push("draft");
  if (!mr.pipeline) warnings.push("no-pipeline");
  else if (!flow) warnings.push("no-flow");

  let stage = mr.approved ? "approved" : "unapproved";
  let sub = null;
  if (flow) {
    const started = flowKey === "v2" ? j.gate?.status === "success" : ["success", "failed", ...RUNNING].includes(j.deploy?.status);
    if (j.validate?.status === "success") stage = "tested";
    else if (started) {
      stage = "testing";
      const d = j.deploy?.status;
      sub = d === "success" ? "in-dev" : d === "failed" ? "deploy-failed" : "deploying";
      if (d === "failed") warnings.push("deploy-failed");
      if (j.validate?.status === "failed") warnings.push("validate-failed");
    } else if (flowKey === "v2" && j.gate?.status === "failed") warnings.push("gate-failed");
    if (STAGES.indexOf(stage) >= 2 && !mr.approved) warnings.push("no-approve");
  }
  return { stage, flow: flowKey, sub, warnings, jobs: j };
}

/**
 * Una MR mergeada que no está en prod ES. `mr.prod` = { tag, deployJob, publishJob, mxPending }:
 * con tag → ▶ el job de producción de esa tag (el deployment `blocked`); sin tag → ▶
 * publicar-tag-produccion del pipeline de development de su merge. Devuelve además `prodPlan`
 * ({ actions, blocked }) con ese único paso.
 */
function prodStage(mr) {
  const p = mr.prod || {};
  const warnings = p.mxPending ? ["mx-pending"] : [];
  // Aún sin saber su tag (llega en la fase progresiva): columna sí, paso todavía no.
  if (p.checked === false) return { stage: "merged", flow: null, sub: "checking", warnings, jobs: {}, prodPlan: { actions: [], blocked: "checking" } };
  const step = p.tag ? jobAction(p.deployJob) : jobAction(p.publishJob);
  let sub = p.tag ? "tagged" : "no-tag";
  if (step.blocked === "job-busy") sub = p.tag ? "deploying" : "tagging";
  const blocked = step.blocked === "missing-job" ? (p.tag ? "no-deploy-job" : "no-publish-job") : step.blocked || null;
  return { stage: "merged", flow: null, sub, warnings, jobs: {}, prodPlan: { actions: step.action ? [step.action] : [], blocked } };
}

/** La tag de producción más antigua de una lista de nombres (la que despliega lo mínimo), o null. */
function productionTag(names) {
  const key = (n) => PRODUCTION_TAG.exec(n).slice(1).map(Number);
  const tags = (names || []).filter((n) => PRODUCTION_TAG.test(n));
  tags.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return tags[0] || null;
}

// Acción sobre un job según su estado: ▶ si espera, ↻ si falló o se canceló; si no, no se puede.
function jobAction(job) {
  if (!job) return { blocked: "missing-job" };
  if (job.status === "manual") return { action: { kind: "play", jobId: job.id, job: job.name } };
  if (["failed", "canceled"].includes(job.status)) return { action: { kind: "retry", jobId: job.id, job: job.name } };
  if (job.status === "created") return { blocked: "job-waiting" };
  if (RUNNING.includes(job.status)) return { blocked: "job-busy" };
  return { blocked: "job-unavailable" };
}

/**
 * Qué hay que hacer en GitLab para llevar una MR (con su `info` de mrStage) hasta la columna
 * `target` (índice en STAGES). Solo hacia delante. Devuelve { actions, blocked } — `blocked` es el
 * motivo (clave) por el que no puede llegar del todo; las acciones previas siguen valiendo.
 */
function planToward(mr, info, target) {
  const from = STAGES.indexOf(info.stage);
  const actions = [];
  if (target <= from) return { actions, blocked: null };
  // A "Sin producción" no se arrastra: se llega mergeando (botón Mergear de Probada).
  if (target === 4) return { actions, blocked: "merge-first" };
  // Ya aprobada por mí pero faltan otras aprobaciones: un segundo Approve lo rechaza GitLab.
  if (target >= 1 && !mr.approved && !mr.approvedByMe) actions.push({ kind: "approve" });
  if (target >= 2 && from < 2) {
    if (!info.flow) return { actions, blocked: "no-flow" };
    if (mr.draft) return { actions, blocked: "draft" };
    const r = jobAction(info.flow === "v2" ? info.jobs.gate : info.jobs.deploy);
    if (r.blocked) return { actions, blocked: r.blocked };
    actions.push(r.action);
  }
  if (target >= 3 && from < 3) {
    // validar exige que dev tenga ya este commit: no se puede encadenar con el despliegue.
    if (from < 2 || info.sub !== "in-dev") return { actions, blocked: "not-in-dev" };
    const r = jobAction(info.jobs.validate);
    if (r.blocked) return { actions, blocked: r.blocked };
    actions.push(r.action);
  }
  return { actions, blocked: null };
}

// Proyecto (path) de una URL de issue/MR de GitLab: lo que va antes de "/-/".
function urlProject(url) {
  const m = /^https?:\/\/[^/]+\/(.+?)\/-\//.exec(url || "");
  return m ? m[1] : null;
}

function isEpicUrl(url) {
  return (urlProject(url) || "").split("/").pop()?.toLowerCase() === "epics";
}

const issueNumber = (url) => Number(/\/-\/(?:issues|work_items)\/(\d+)/.exec(url || "")?.[1]) || null;

// Citas de otras MRs en la descripción (`proyecto!N` o la URL de la MR), como ver-mrs-hermanas.
function parseCitations(text) {
  const out = new Set();
  const s = String(text || "");
  for (const m of s.matchAll(/https?:\/\/[^\s/]+\/((?:[\w.-]+\/)+)-\/merge_requests\/(\d+)/g)) out.add(`${m[1].replace(/\/$/, "").split("/").pop()}!${m[2]}`);
  for (const m of s.matchAll(/([\w.-]+(?:\/[\w.-]+)*)!(\d+)/g)) out.add(`${m[1].split("/").pop()}!${m[2]}`);
  return [...out];
}

/**
 * Tarea y Epic de una MR a partir de sus issues enlazados ({ url, title }). Tarea = el issue del
 * MISMO proyecto (el del número de la rama si lo hay: `features/459-…` → #459). Epic = un issue del
 * proyecto "epics" (el de `epic-343` en la rama si lo hay).
 */
function taskAndEpic(mr) {
  const issues = mr.issues || [];
  const own = issues.filter((i) => urlProject(i.url) === mr.repo && !isEpicUrl(i.url));
  const epics = issues.filter((i) => isEpicUrl(i.url));
  const branchTask = Number(/(?:^|\/)(\d+)-/.exec(mr.branch || "")?.[1]) || null;
  const branchEpic = Number(/epic-(\d+)/.exec(mr.branch || "")?.[1]) || null;
  return {
    task: own.find((i) => issueNumber(i.url) === branchTask) || own[0] || null,
    epic: epics.find((i) => issueNumber(i.url) === branchEpic) || epics[0] || null,
  };
}

/**
 * Agrupa las MRs en tarjetas (tareas). Se unen dos MRs si comparten tarea, si una cita a la otra o
 * si una enlaza la tarea de la otra desde OTRO proyecto (una tarea multi-proyecto). Los enlaces
 * dentro del mismo proyecto no unen: ahí suelen ser "relacionadas", no la misma tarea.
 * ponytail: heurística de enlaces; si junta de más, la fuente buena sería la jerarquía de work items.
 * `mrs` = [{ key: "proyecto!iid", repo, iid, issues, citations, task, … , stageIndex }].
 */
function groupTasks(mrs) {
  const parent = mrs.map((_m, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => (parent[find(a)] = find(b));
  const byKey = new Map(mrs.map((m, i) => [m.key, i]));
  const byTask = new Map();
  mrs.forEach((m, i) => {
    if (!m.task) return;
    if (byTask.has(m.task.url)) union(i, byTask.get(m.task.url));
    else byTask.set(m.task.url, i);
  });
  mrs.forEach((m, i) => {
    for (const c of m.citations || []) if (byKey.has(c)) union(i, byKey.get(c));
    for (const iss of m.issues || []) {
      if (urlProject(iss.url) === m.repo) continue;
      if (byTask.has(iss.url)) union(i, byTask.get(iss.url));
    }
  });
  const groups = new Map();
  mrs.forEach((m, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(m);
  });
  return [...groups.values()].map((list) => {
    const withTask = list.find((m) => m.task);
    const epic = list.find((m) => m.epic)?.epic || null;
    return {
      key: list.map((m) => m.key).sort().join(","),
      task: withTask?.task || null,
      epic,
      title: withTask?.task.title || list[0].title,
      stage: STAGES[Math.min(...list.map((m) => m.stageIndex))],
      mrs: list,
    };
  });
}

module.exports = { STAGES, FLOWS, mrStage, planToward, groupTasks, taskAndEpic, parseCitations, urlProject, isEpicUrl, productionTag };
