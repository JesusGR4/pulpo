#!/usr/bin/env node
"use strict";

// Reglas del tablero de Validación (src/validation-rules.js): columna de cada MR según Approve +
// jobs de delivery-flow, plan de acciones al soltar y agrupación en tareas. Casos sacados de MRs
// reales de OpenSaludGroup. `node scripts/test-validation.js`

const assert = require("assert");
const { mrStage, planToward, groupTasks, taskAndEpic, parseCitations } = require("../src/validation-rules");

const v2 = (gate, deploy = "created", validate = "created") => [
  { id: 1, name: "aprobar-para-probar", status: gate },
  { id: 2, name: "desplegar-en-dev", status: deploy },
  { id: 3, name: "validar-qa-para-mergear", status: validate },
];
const mr = (over) => ({ approved: false, draft: false, pipeline: { status: "manual" }, jobs: v2("manual"), ...over });
const plan = (m, target) => planToward(m, mrStage(m), target);
const kinds = (p) => p.actions.map((a) => `${a.kind}${a.job ? `:${a.job}` : ""}`);

// 2.x sin Approve ni ▶ → Sin aprobar; soltar en En pruebas = approve + ▶ aprobar-para-probar.
{
  const m = mr({});
  assert.strictEqual(mrStage(m).stage, "unapproved");
  assert.deepStrictEqual(kinds(plan(m, 1)), ["approve"]);
  assert.deepStrictEqual(kinds(plan(m, 2)), ["approve", "play:aprobar-para-probar"]);
  assert.strictEqual(plan(m, 3).blocked, "not-in-dev", "validar exige estar ya en dev");
}
// Aprobada (launcher!1000): ▶ aprobar-para-probar sin pulsar.
{
  const m = mr({ approved: true });
  assert.strictEqual(mrStage(m).stage, "approved");
  assert.deepStrictEqual(kinds(plan(m, 2)), ["play:aprobar-para-probar"]);
  assert.deepStrictEqual(plan(m, 1).actions, [], "hacia su propia columna no hace nada");
}
// aprobar-para-probar falló (api!849): sigue en Aprobada con aviso y se reintenta.
{
  const m = mr({ approved: true, jobs: v2("failed", "skipped", "skipped") });
  const info = mrStage(m);
  assert.strictEqual(info.stage, "approved");
  assert.ok(info.warnings.includes("gate-failed"));
  assert.deepStrictEqual(kinds(plan(m, 2)), ["retry:aprobar-para-probar"]);
}
// En pruebas: desplegando → no se puede validar todavía; en dev → ▶ validar.
{
  const deploying = mr({ approved: true, jobs: v2("success", "running") });
  assert.strictEqual(mrStage(deploying).stage, "testing");
  assert.strictEqual(mrStage(deploying).sub, "deploying");
  assert.strictEqual(plan(deploying, 3).blocked, "not-in-dev");
  const inDev = mr({ approved: true, jobs: v2("success", "success", "manual") });
  assert.strictEqual(mrStage(inDev).sub, "in-dev");
  assert.deepStrictEqual(kinds(plan(inDev, 3)), ["play:validar-qa-para-mergear"]);
  const failed = mr({ approved: true, jobs: v2("success", "failed") });
  assert.ok(mrStage(failed).warnings.includes("deploy-failed"));
}
// El pipeline manda sobre el Approve, con aviso.
{
  const info = mrStage(mr({ approved: false, jobs: v2("success", "success", "manual") }));
  assert.strictEqual(info.stage, "testing");
  assert.ok(info.warnings.includes("no-approve"));
}
// Probada.
assert.strictEqual(mrStage(mr({ approved: true, jobs: v2("success", "success", "success") })).stage, "tested");

// 1.x (launcher!940): ▶ deploy:dev + qa:validado. En dashboard deploy:dev espera a un build manual.
{
  const v1 = (deploy, qa = "created") => [{ id: 7, name: "deploy:dev", status: deploy }, { id: 8, name: "qa:validado", status: qa }];
  const m = mr({ approved: true, jobs: v1("manual") });
  assert.strictEqual(mrStage(m).flow, "v1");
  assert.strictEqual(mrStage(m).stage, "approved");
  assert.deepStrictEqual(kinds(plan(m, 2)), ["play:deploy:dev"]);
  assert.strictEqual(plan(mr({ approved: true, jobs: v1("created") }), 2).blocked, "job-waiting");
  assert.strictEqual(mrStage(mr({ approved: true, jobs: v1("success", "manual") })).sub, "in-dev");
  assert.strictEqual(mrStage(mr({ approved: true, jobs: v1("success", "success") })).stage, "tested");
}
// Sin flujo de QA (pipeline antiguo, api!898) y sin pipeline: no pasan de Aprobada.
{
  const old = mr({ approved: true, jobs: [{ id: 9, name: "test", status: "success" }] });
  assert.ok(mrStage(old).warnings.includes("no-flow"));
  assert.strictEqual(plan(old, 2).blocked, "no-flow");
  assert.ok(mrStage(mr({ pipeline: null, jobs: [] })).warnings.includes("no-pipeline"));
}
// Draft: se puede aprobar, pero aprobar-para-probar fallaría.
{
  const p = plan(mr({ draft: true }), 2);
  assert.deepStrictEqual(kinds(p), ["approve"]);
  assert.strictEqual(p.blocked, "draft");
}
// Ya la aprobé yo pero faltan otras aprobaciones: no se repite el Approve.
assert.deepStrictEqual(kinds(plan(mr({ approvedByMe: true }), 1)), []);

// Tarea y Epic: la tarea es el issue del mismo proyecto con el número de la rama.
{
  const t = taskAndEpic({
    repo: "OpenSaludGroup/openhealthcareapi",
    branch: "features/447-permitir-especialidad",
    issues: [
      { url: "https://gl/OpenSaludGroup/openhealthcareapi/-/issues/487", title: "Subir la API a .NET 10" },
      { url: "https://gl/OpenSaludGroup/openhealthcareapi/-/work_items/447", title: "Permitir especialidad" },
      { url: "https://gl/OpenSaludGroup/epics/-/issues/226", title: "Epic especialidad" },
    ],
  });
  assert.strictEqual(t.task.title, "Permitir especialidad");
  assert.strictEqual(t.epic.title, "Epic especialidad");
}
assert.deepStrictEqual(parseCitations("Va con openhealthcareapi!881 y https://gl/OpenSaludGroup/dashboard/-/merge_requests/35").sort(), ["dashboard!35", "openhealthcareapi!881"]);

// Agrupación: issue de OTRO proyecto une (dashboard!226 → api#447); del MISMO proyecto, no
// (api!849 enlaza #434, la tarea de api!835); una cita une; la tarjeta va con su MR más atrasada.
{
  const api = "OpenSaludGroup/openhealthcareapi";
  const dash = "OpenSaludGroup/dashboard";
  const u = (repo, n) => ({ url: `https://gl/${repo}/-/work_items/${n}`, title: `${repo}#${n}` });
  const mk = (key, repo, task, issues, stageIndex, citations = []) => ({ key, repo, title: key, task, issues, citations, stageIndex });
  const cards = groupTasks([
    mk("openhealthcareapi!849", api, u(api, 447), [u(api, 447), u(api, 434)], 1),
    mk("openhealthcareapi!835", api, u(api, 434), [u(api, 434)], 0),
    mk("dashboard!226", dash, u(dash, 130), [u(dash, 130), u(api, 447)], 0),
    mk("dashboard!300", dash, null, [], 2, ["openhealthcareapi!849"]),
    mk("dashboard!301", dash, null, [], 3),
  ]);
  const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));
  assert.deepStrictEqual(Object.keys(byKey).sort(), ["dashboard!226,dashboard!300,openhealthcareapi!849", "dashboard!301", "openhealthcareapi!835"]);
  assert.strictEqual(byKey["dashboard!226,dashboard!300,openhealthcareapi!849"].stage, "unapproved");
  assert.strictEqual(byKey["dashboard!301"].task, null, "MR suelta");
  assert.strictEqual(byKey["dashboard!301"].stage, "tested");
}

// Sin producción: con tag → ▶ el deployment blocked de producción; sin tag → ▶ publicar-tag-produccion.
{
  const { productionTag } = require("../src/validation-rules");
  const merged = (prod) => mrStage({ merged: true, prod });
  const tagged = merged({ tag: "2026.11.3", deployJob: { id: 56462, name: "deploy", status: "manual" } });
  assert.strictEqual(tagged.stage, "merged");
  assert.strictEqual(tagged.sub, "tagged");
  assert.deepStrictEqual(tagged.prodPlan.actions, [{ kind: "play", jobId: 56462, job: "deploy" }]);
  const noTag = merged({ tag: null, publishJob: { id: 9, name: "publicar-tag-produccion", status: "manual" }, mxPending: true });
  assert.strictEqual(noTag.sub, "no-tag");
  assert.strictEqual(noTag.prodPlan.actions[0].job, "publicar-tag-produccion");
  assert.ok(noTag.warnings.includes("mx-pending"));
  assert.strictEqual(merged({ tag: null, publishJob: null }).prodPlan.blocked, "no-publish-job", "CI sin release_tag");
  assert.strictEqual(merged({ tag: "2026.11.3", deployJob: { id: 1, name: "deploy", status: "running" } }).sub, "deploying");
  // Arrastrar a Sin producción no hace nada: se llega mergeando.
  assert.strictEqual(plan(mr({ approved: true, jobs: v2("success", "success", "success") }), 4).blocked, "merge-first");
  // La tag más antigua que contiene el commit (orden numérico, sin las -mx).
  assert.strictEqual(productionTag(["2026.11.10", "2026.11.3-mx", "2026.11.9", "rb/102026/x", "2026.10.11"]), "2026.10.11");
  assert.strictEqual(productionTag(["2026.11.3-mx"]), null);
}

// ¿En producción? Casos reales de landing-profesionales con prod ES = 2026.10.6, cortada de rb/102026.
{
  const { mrInProduction, cherryOrigins } = require("../src/validation-rules");
  const ctx = {
    missing: new Set(["c69fcf97aa", "e4474031aa", "5fac9df8aa", "f00aa"]),
    cherried: cherryOrigins(["Merge branch 'features/41-seo' into 'development'\n\n(cherry picked from commit c69fcf97aa)", "fix: otra cosa"]),
    deployedTitles: new Set(["javier@x|fix(landing): un solo scroll al grid"]),
  };
  // !60: su merge commit se cherry-pickeó con -x a rb/102026.
  assert.ok(mrInProduction({ mergeSha: "c69fcf97aa", commits: [{ id: "f00aa", title: "seo", author_email: "javier@x" }] }, ctx));
  // !47: el mismo commit, rebaseado y sin -x (otro sha, mismo autor y título en la tag).
  assert.ok(mrInProduction({ mergeSha: "b1", commits: [{ id: "e4474031aa", title: "fix(landing): un solo scroll al grid", author_email: "javier@x" }] }, ctx));
  // Sus commits ya están en la tag tal cual (no salen en el compare).
  assert.ok(mrInProduction({ mergeSha: "b2", commits: [{ id: "ya-en-la-tag", title: "x", author_email: "javier@x" }] }, ctx));
  // !62: mergeada después del corte de la rb, sin rastro en la tag → pendiente.
  assert.ok(!mrInProduction({ mergeSha: "5fac9df8aa", commits: [{ id: "5fac9df8aa", title: "ci: delivery-flow", author_email: "javier@x" }] }, ctx));
  // Mismo título de OTRO autor no vale; sin commits conocidos, tampoco.
  assert.ok(!mrInProduction({ mergeSha: "b3", commits: [{ id: "e4474031aa", title: "fix(landing): un solo scroll al grid", author_email: "otra@x" }] }, ctx));
  assert.ok(!mrInProduction({ mergeSha: "b4", commits: [] }, ctx));
}

console.log("test-validation: ok");
