#!/usr/bin/env node
"use strict";

/**
 * Entornos: «el último despliegue» es el que TERMINÓ último, no el que se creó último.
 *
 * GitLab crea el registro de despliegue cuando se crea el pipeline y lo actualiza cuando el job termina.
 * Un `desplegar-en-dev` manual (▶ días después) conserva el `created_at` del pipeline: caso real del 13-nov,
 * launcher !1044 (creado el 10-nov, terminado el 13-nov 09:55) aparecía por debajo de !1043 (creado el 11-nov)
 * y Entornos enseñaba la rama equivocada en dev. La instancia ordena por `finished_at` aunque no lo devuelva
 * en el JSON: la hora del despliegue sale de `updated_at`.
 *
 * `node scripts/test-env-deployments.js`
 */

const Module = require("module");
const path = require("path");
const assert = require("assert");

// Un GitLab de mentira que ordena de verdad según `order_by` (con `finished_at` oculto, como la instancia real).
const DEPLOYMENTS = [
  { id: 12116, status: "success", ref: "refs/merge-requests/1043/head", sha: "92e7fb86aaaa", created_at: "2026-11-11T15:01:16.790Z", updated_at: "2026-11-11T15:08:13.296Z", _finished: "2026-11-11T15:08:13.200Z" },
  { id: 12081, status: "success", ref: "refs/merge-requests/1044/head", sha: "95ba220cbbbb", created_at: "2026-11-10T14:37:48.881Z", updated_at: "2026-11-13T09:55:25.880Z", _finished: "2026-11-13T09:55:25.798Z" },
  { id: 12142, status: "skipped", ref: "refs/merge-requests/940/head", sha: "866e5be8cccc", created_at: "2026-11-12T13:57:21.836Z", updated_at: "2026-11-12T13:57:21.926Z", _finished: null },
];
const requests = [];
const fakeApi = async (_method, url) => {
  requests.push(url);
  if (url.endsWith("/environments?per_page=100")) return [{ id: 15, name: "development", tier: "development", state: "stopped" }];
  if (url.includes("/deployments?")) {
    const q = new URLSearchParams(url.split("?")[1]);
    const key = { created_at: "created_at", updated_at: "updated_at", finished_at: "_finished" }[q.get("order_by")];
    if (!key) throw new Error("order_by no válido");
    return DEPLOYMENTS.filter((d) => !q.get("status") || d.status === q.get("status"))
      .sort((a, b) => String(b[key]).localeCompare(String(a[key])))
      .slice(0, Number(q.get("per_page")))
      .map(({ _finished, ...d }) => d);
  }
  throw new Error(`petición no prevista: ${url}`); // devSlot cae al catch y deja el slot en null
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./core") return { api: fakeApi, proj: encodeURIComponent };
  if (request === "./issues") return { isEpicUrl: () => false };
  return realLoad.call(this, request, parent, isMain);
};
const { projectEnvironments } = require(path.join(__dirname, "..", "src", "gitlab", "environments.js"));
Module._load = realLoad;

(async () => {
  const [dev] = await projectEnvironments("OpenSaludGroup/openhealthcare-launcher");
  const d = dev.deployment;
  assert.ok(d, "development debería tener despliegue");
  assert.strictEqual(d.ref, "refs/merge-requests/1044/head", `enseña ${d.ref}: gana el creado más tarde, no el terminado más tarde`);
  assert.strictEqual(d.sha, "95ba220c");
  assert.strictEqual(d.deployedAt, "2026-11-13T09:55:25.880Z", "«hace X» cuenta desde que terminó, no desde que se creó el pipeline");
  assert.ok(requests.some((u) => u.includes("status=success") && u.includes("order_by=finished_at")));
  console.log("test-env-deployments: ok");
})().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
