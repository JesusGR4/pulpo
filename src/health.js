"use strict";

/**
 * Veredicto de la sonda de salud de un entorno, como función pura para poder probarlo sin red
 * (scripts/test-health-verdict.js).
 *
 * Son TRES estados a propósito. La tentación es "2xx = sano", y es falso: una SPA sirve su
 * index.html con 200 en CUALQUIER ruta, incluida una que no existe (verificado contra
 * dashboard.opensalud.es: /health, /status y /esto-no-existe devuelven los tres 200 text/html).
 * Un 200 con HTML solo demuestra que el servidor web está en pie, no que la aplicación funcione.
 * Por eso ese caso es `unknown` (ámbar) y no `up`: un health check que miente es peor que no tener
 * ninguno, porque te hace ignorar la alarma real.
 *
 * `up` requiere una prueba positiva: una respuesta que no sea HTML (una API devolviendo JSON), que
 * el cuerpo contenga el texto esperado que se haya configurado, o —para una SPA— que el bundle JS que
 * enlaza su index.html se descargue de verdad. Eso último pilla el fallo típico de un front estático:
 * index nuevo apuntando a assets que no existen (o al revés), con el index sirviéndose tan pancho.
 *
 * `bundle` = resultado de pedir el script de bundleUrl(): {ok, httpStatus, contentType, path} o null
 * si el index no enlaza ningún script propio.
 */
function healthVerdict({ ok, httpStatus, contentType = "", expect = "", bodyMatched = null, bundle = null }) {
  if (!ok) return { status: "down", note: `HTTP ${httpStatus}` };
  if (expect) {
    return bodyMatched ? { status: "up", note: "" } : { status: "down", note: "No aparece el texto esperado" };
  }
  if (!HTML_RE.test(contentType)) return { status: "up", note: "" };
  if (!bundle) {
    return { status: "unknown", note: "Responde HTML sin script propio que comprobar. Configura una ruta de sonda." };
  }
  // Un asset que vuelve como HTML es el catch-all de la SPA (index.html con 200), no el bundle.
  if (bundle.ok && !HTML_RE.test(bundle.contentType || "")) return { status: "up", note: `bundle ${bundle.path} OK` };
  return { status: "down", note: `No carga el bundle ${bundle.path} (HTTP ${bundle.httpStatus})` };
}

const HTML_RE = /text\/html/i;

/**
 * El script que demuestra que el front desplegado está entero: el primer `<script type="module">` del
 * mismo origen (el entry de Vite/Nuxt), o si no hay, el primer `<script src>` del mismo origen. Los
 * de otro origen (CDN, analítica) no dicen nada de nuestro despliegue. `pageUrl` = URL final tras
 * redirecciones. null si no hay ninguno.
 * ponytail: regex sobre el HTML, no un parser; aguanta los index de Vite/Nuxt/WordPress de hoy.
 */
function bundleUrl(html, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const scripts = [...String(html).matchAll(/<script\b([^>]*)>/gi)]
    .map(([, attrs]) => {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      if (!src) return null;
      let url;
      try {
        url = new URL(src, pageUrl);
      } catch {
        return null;
      }
      return url.origin === origin ? { url: url.toString(), module: /\btype\s*=\s*["']module["']/i.test(attrs) } : null;
    })
    .filter(Boolean);
  return (scripts.find((x) => x.module) || scripts[0])?.url || null;
}

module.exports = { healthVerdict, bundleUrl };
