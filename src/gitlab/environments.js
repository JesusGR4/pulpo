"use strict";

// vista de Entornos: entornos de un proyecto con su último despliegue, ordenados por tier.
// Parte de la implementación del proveedor GitLab — ver src/gitlab.js para la interfaz pública.

const { api, proj } = require("./core");
const { isEpicUrl } = require("./issues");

const TIER_RANK = { development: 0, testing: 1, staging: 2, production: 3, other: 4 };

/**
 * Entornos de un proyecto con su ÚLTIMO despliegue (vista de Entornos).
 *
 * GOTCHA verificado contra la instancia: `GET /environments` NO devuelve `last_deployment` (solo el
 * detalle por entorno lo trae). En vez de N llamadas al detalle, una a `/deployments?environment=`
 * por entorno.
 *
 * GOTCHA 2 (lo que motivó este cambio): pedir el "último despliegue" a secas MIENTE. Un entorno
 * acumula por encima del último deploy real un montón de `blocked` (jobs `when: manual` que nadie ha
 * lanzado), `created`/`canceled` (pushes de ramas sueltas que disparan el pipeline) y `skipped`.
 * Ninguno de esos desplegó NADA: production salía con `rb/072026` (un job manual sin lanzar) cuando
 * lo que corre de verdad es el tag `2026.06.2`. La ÚNICA señal fiable de "qué versión hay ahí" es el
 * último despliegue con `status=success`, así que filtramos por eso EN LA API (no en cliente: el
 * success real puede estar decenas de deployments más abajo). Si no hay ninguno → "Sin despliegues".
 *
 * Coste: 1 + M llamadas por proyecto (M = entornos), las M en paralelo. Pensado para refresco bajo
 * demanda, NO para el poll. NO lanza por entorno: un fallo deja ese entorno sin deploy, no tumba la fila.
 */

async function projectEnvironments(projectId) {
  const id = proj(String(projectId));
  // Sin `states=available`: delivery-flow deja `development` en `stopped` tras cada pipeline de MR y aun
  // así es lo que corre en dev. Del resto, solo los vivos (`mx` del dashboard está parado y muerto).
  const all = await api("GET", `/projects/${id}/environments?per_page=100`);
  const envs = (all || []).filter((e) => e.state === "available" || e.tier === "development");
  const out = await Promise.all(
    envs.map(async (e) => {
      let deployment = null;
      try {
        const ds = await api(
          "GET",
          `/projects/${id}/deployments?environment=${encodeURIComponent(e.name)}&status=success&order_by=created_at&sort=desc&per_page=1`,
        );
        const d = (ds || [])[0];
        if (d) {
          deployment = {
            status: d.status, // siempre "success" (lo filtra la query); lo dejamos por claridad
            ref: d.ref || null,
            sha: d.sha ? String(d.sha).slice(0, 8) : null,
            createdAt: d.created_at || null,
            user: d.user?.name || null,
            pipelineUrl: d.deployable?.pipeline?.web_url || null,
          };
        }
      } catch {
        deployment = null;
      }
      return {
        name: e.name,
        tier: e.tier || "other",
        state: e.state,
        externalUrl: e.external_url || null,
        webUrl: e.project?.web_url ? `${e.project.web_url}/-/environments/${e.id}` : null,
        deployment,
        devSlot: e.tier === "development" && deployment?.ref ? await devSlot(id, deployment.ref).catch(() => null) : null,
      };
    }),
  );
  return out.sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || a.name.localeCompare(b.name));
}

// Las pipelines de MR registran el ref de la MR, no la rama.
const MR_REF = /^refs\/merge-requests\/(\d+)\/head$/;

/**
 * Quién tiene el slot de dev: la MR desplegada (con su estado y pipeline, para que el renderer decida
 * si está ocupado) y la tarea/epic que cita. Misma lectura que `holderFromDeployments`/`checkBusy` de
 * delivery-flow (scripts/dev-slot.cjs): un ref de MR es esa MR; una rama, su MR abierta. La rama
 * `development` es la base, no ocupa nada. Coste: 1-2 llamadas por la MR + 2 por sus issues.
 */
async function devSlot(id, ref) {
  const m = MR_REF.exec(ref);
  let iid = m?.[1];
  if (!m && ref !== "development") {
    const [open] = (await api("GET", `/projects/${id}/merge_requests?source_branch=${encodeURIComponent(ref)}&state=opened&per_page=1`)) || [];
    iid = open?.iid;
  }
  if (!iid) return { branch: ref, mr: null, task: null, epic: null };
  const mr = await api("GET", `/projects/${id}/merge_requests/${iid}`);
  // closes_issues = "Closes #N"; related_issues = las citadas en la descripción (ahí suele ir la Epic).
  const lists = await Promise.all(
    ["closes_issues", "related_issues"].map((k) => api("GET", `/projects/${id}/merge_requests/${iid}/${k}`).catch(() => [])),
  );
  const issues = lists.flat().filter(Boolean);
  const pick = (i) => (i ? { iid: i.iid, title: i.title, url: i.web_url } : null);
  return {
    branch: mr.source_branch || ref,
    mr: {
      iid: mr.iid,
      title: mr.title,
      url: mr.web_url,
      state: mr.state, // opened | merged | closed (GitLab tal cual: solo lo lee environments.js)
      draft: !!mr.draft,
      pipeline: mr.head_pipeline?.status || null,
      author: mr.author?.username || null,
    },
    task: pick(issues.find((i) => !isEpicUrl(i.web_url))),
    epic: pick(issues.find((i) => isEpicUrl(i.web_url))),
  };
}

/**
 * Pipelines de despliegue de un proyecto, ancladas a sus releases (OPE-25). Devuelve la lista de
 * releases recientes (para el selector "ver anteriores") y, para el `ref`/tag pedido (o la última
 * release si no se pasa), su pipeline + jobs. Los jobs `manual` son lanzables; cada job lleva su
 * web_url para abrir el log en GitLab. NO atómico por proyecto: el renderer llama uno por proyecto.
 * Solo GitLab.
 */

module.exports = {
  TIER_RANK,
  projectEnvironments,
};
