"use strict";

// Handlers IPC de entornos: listado por proyecto y sonda HTTP de salud.
// Se registran desde wireIpc() en src/main.js.

const { ipcMain } = require("electron");
const config = require("../config");
const health = require("../health");
const provider = require("../provider");

const gh = () => provider.current();

function register() {
  ipcMain.handle("env:list", async (_event, { projectId }) => {
    const PATH_RE = /^[\w.-]+(\/[\w.-]+)+$|^\d+$/;
    if (typeof projectId !== "string" || !PATH_RE.test(projectId)) throw new Error("Proyecto no válido");
    return gh().projectEnvironments(projectId);
  });

  // Sonda de salud de un entorno (capa 2). Vive en el main porque el renderer está sandboxed y la CSP
  // le prohíbe salir a hosts externos. `url` viene del external_url de GitLab (validamos protocolo);
  // el PATH y el texto esperado salen de CONFIG, no del renderer.
  //
  // GOTCHA que motiva el veredicto de tres estados: las SPA sirven index.html con 200 en CUALQUIER
  // ruta (verificado: dashboard.opensalud.es devuelve 200 en /health y en /esto-no-existe). Un 200
  // con content-type HTML NO demuestra que la app esté sana — solo que nginx está en pie. Por eso
  // "responde HTML pero no se puede verificar" es `unknown` (ámbar), nunca `up`. Un health check que
  // miente es peor que no tenerlo. Para salir de ahí, la sonda pide el bundle JS que enlaza el index
  // (health.bundleUrl): si se descarga, el front está entero.
  ipcMain.handle("env:health", async (_event, { url, project }) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("URL no válida");
    const cfg = config.load();
    const probePath = cfg.environments?.healthPaths?.[project] || "";
    const expect = cfg.environments?.healthExpect?.[project] || "";
    let target;
    try {
      target = new URL(probePath, url.endsWith("/") ? url : `${url}/`).toString();
    } catch {
      throw new Error("URL no válida");
    }
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(target, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "monstro-app" } });
      const ms = Date.now() - started;
      const type = res.headers.get("content-type") || "";
      let bodyMatched = null;
      let bundle = null;
      if (expect && res.ok) bodyMatched = (await res.text()).slice(0, 200000).includes(expect);
      else if (res.ok && /text\/html/i.test(type)) {
        // SPA sin texto esperado: el 200 no prueba nada, así que se pide el bundle que enlaza el index.
        const src = health.bundleUrl((await res.text()).slice(0, 200000), res.url || target);
        if (src) {
          const a = await fetch(src, { signal: ctrl.signal, headers: { "User-Agent": "monstro-app" } });
          a.body?.cancel().catch(() => {});
          bundle = { ok: a.ok, httpStatus: a.status, contentType: a.headers.get("content-type") || "", path: new URL(src).pathname };
        }
      }
      const { status, note } = health.healthVerdict({
        ok: res.ok,
        httpStatus: res.status,
        contentType: type,
        expect,
        bodyMatched,
        bundle,
      });
      return { status, httpStatus: res.status, ms, contentType: type, url: target, note };
    } catch (err) {
      const aborted = err.name === "AbortError";
      return {
        status: "down",
        httpStatus: 0,
        ms: Date.now() - started,
        url: target,
        note: aborted ? "Sin respuesta (timeout 8s)" : String(err.message || err),
      };
    } finally {
      clearTimeout(timer);
    }
  });

}

module.exports = { register };
