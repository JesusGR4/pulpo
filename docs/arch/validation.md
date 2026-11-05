# Validación — tablero Kanban de MRs (solo GitLab)

`state.view === "validation"`, `renderer/app/validation.js` + `css/validation.css`. Main: `src/gitlab/validation.js`
(fetch + acciones), `src/validation-rules.js` (reglas PURAS, sin red: `node scripts/test-validation.js`),
IPC `validation:board` / `validation:act` (`src/ipc/validation.js`).

## Qué entra

MRs **abiertas hacia `development`** (draft y no draft) de `config.repos`. Fuera las que van a `rb/*`.
Coste: 1 GraphQL por repo (MRs + `approved` + jobs del head pipeline, `retried: false`) + 2 REST por MR
(`closes_issues`, `related_issues`: GraphQL no los expone). ~20 s con ~60 MRs; sin auto-refresh.

**GOTCHA**: en GitLab 18.6 `Pipeline` no tiene `webUrl` (es `path`) y los jobs dan `webPath`: se cuelgan del
origen de la URL de la MR.

## Columnas (`mrStage`)

Del flujo de `OpenSaludGroup/delivery-flow` (su README: «el Approve de GitLab ya no lanza nada»):

| Columna | 2.x (`aprobar-para-probar` → `desplegar-en-dev` → `validar-qa-para-mergear`) | 1.x (`deploy:dev` → `qa:validado`) |
|---|---|---|
| Sin aprobar | `approved=false` | igual |
| Aprobada | approved + `aprobar-para-probar` manual (failed → aviso) | approved + `deploy:dev` manual/created |
| En pruebas | `aprobar-para-probar` success, validar sin success (sub: desplegando / en dev / despliegue fallido) | `deploy:dev` en marcha/success/failed |
| Probada | `validar-qa-para-mergear` success | `qa:validado` success |
| Sin producción | mergeada, sin estar en prod ES (ver abajo) | igual |

- Si el pipeline va por delante del Approve, **manda el pipeline** + aviso «sin Approve».
- Sin flujo de QA (pipeline antiguo) o sin pipeline: aviso, no pasan de Aprobada.
- Un push nuevo = pipeline nuevo = la MR **vuelve a Aprobada** (hay que pulsar el ▶ otra vez). Es correcto.

## Tareas (`groupTasks`)

Tarea de una MR = issue del MISMO proyecto (el del número de la rama, `features/459-…` → #459). Epic = issue del
proyecto `epics`. Una tarjeta une (union-find) MRs que comparten tarea, que se citan (`proyecto!N`/URL, como
`ver-mrs-hermanas`) o que enlazan la tarea de otra desde OTRO proyecto. **Los enlaces del mismo proyecto no unen**
(api!849 enlaza #434/#440 de otras tareas). La tarjeta va en la columna de su MR **más atrasada**.

## Acciones (`planToward`)

Solo hacia delante (el drop en columnas anteriores no se acepta). Cada MR trae `toward[i]` = `{ actions, blocked }`:
Approve si falta (y no lo di yo ya), ▶/↻ del job puerta (`aprobar-para-probar` o `deploy:dev`), ▶/↻ de validar
(solo si ya está **en dev**: no se encadena con el despliegue). Draft → bloqueada (aprobar-para-probar falla).
El drop (o «Pasar a…» del panel) abre SIEMPRE una confirmación con las acciones desmarcables y las MRs bloqueadas
con su motivo; se ejecuta MR a MR, sin atomicidad, y si una acción de una MR falla se omiten las siguientes de esa
MR. Resultado por acción y recarga. «Mergear» (Probada) = `pr:merge` existente, merge commit.

## Sin producción (5ª columna, `pendingProduction` + `prodLookup`)

MRs **mergeadas** a development que no están en prod ES, **sin límite de fecha**: el corte natural es lo
desplegado. Por repo: último deployment `success` de `production` (y de `production-mx`) → `prodContext` →
MRs mergeadas desde el **merge-base** de ese sha con development (GraphQL `mergedAfter`, paginado) → descarte
con `rules.mrInProduction`. Un repo sin deployments en `production` (opensalud) no aporta nada. Sale de la
columna al estar en prod ES; MX es solo aviso («falta prod MX»), con la misma regla.

**GOTCHA: «su merge commit es ancestro de la tag» NO basta.** Hay tags cortadas de una rama `rb/` (landing
2026.10.6 sale de `rb/102026`) a la que el código llega con OTRO sha. Una MR está en prod si su merge commit o
todos sus commits están en la tag: tal cual, como origen de un cherry-pick `-x` (mensajes de los commits que
solo tiene la tag) o, sin `-x`, el mismo cambio rebaseado (mismo autor y título en la historia de la tag;
heurístico). Por lo mismo, la ventana es el merge-base y no la fecha del commit desplegado: la punta de una `rb/`
es reciente y dejaría fuera lo mergeado en development después de cortarla. Coste extra: 2 compare + merge-base
+ historia por entorno y repo, y 1 REST (commits) por MR candidata.

Paso de cada una (`prodStage`): `commits/:sha/refs?type=tag` → la tag `YYYY.MM.N` más antigua que la contiene.
- Con tag → ▶ su job de producción = el deployment **`blocked`** de esa tag en `production`. **GOTCHA**: el
  nombre del job cambia en cada proyecto (`deploy`, `deploy:prod`, `deploy_production`, `deploy-nuxt`…), no se
  busca por nombre.
- Sin tag → ▶ `publicar-tag-produccion` del pipeline de development de su merge. **La tag se crea sobre ese
  commit y se lleva todo lo mergeado antes**; desplegar una tag despliega todas las MRs que contiene: la
  confirmación lista las demás.

A esta columna **no se arrastra**: se llega con «Mergear» desde Probada. Va en paralelo y DESPUÉS de las
abiertas (en paralelo competía con ellas: primera foto de ~2 a ~7 s); ~15 s más en frío.

## Detalle de una tarjeta (`renderer/app/validation-detail.js`)

Clic = **ficha flotante** anclada a la tarjeta (a la derecha si cabe, si no a la izquierda), con el ▶ de
producción de cada MR en línea y «Pasar a…» / «Mergear» / «Abrir tarea». «Abrir completo» = **panel acoplado
abajo** con pestañas Resumen · Pipelines · Producción y «Siguiente paso». Esc o clic fuera cierran la ficha.
`state.validation.selected` es la key de una MR (las tarjetas se reagrupan y cambian de key al enlazar).

Selftest: `--selftest-route=validacion`, `validacion-detail` (ficha) y `validacion-dock` (panel). Datos reales.
