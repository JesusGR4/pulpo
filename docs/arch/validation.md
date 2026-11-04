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

Selftest: `--selftest-route=validacion` y `validacion-detail` (abre la tarjeta con más MRs). Datos reales.
