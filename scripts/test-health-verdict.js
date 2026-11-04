#!/usr/bin/env node
"use strict";

/**
 * Check mínimo de `healthVerdict`: la sonda de entornos NO puede dar por sano un 200 que solo trae
 * el index.html de una SPA. Es el único fallo que importa de verdad — pintaría verde un entorno con
 * el backend muerto.
 * `node scripts/test-health-verdict.js`
 */

const assert = require("assert");
const { healthVerdict, bundleUrl } = require("../src/health");

// Una API devolviendo JSON: prueba positiva → sano.
assert.strictEqual(healthVerdict({ ok: true, httpStatus: 200, contentType: "application/json" }).status, "up");

// LA TRAMPA: 200 con HTML y sin texto esperado. La SPA responde esto en cualquier ruta, así que no
// demuestra nada → "no verificable", nunca "up".
assert.strictEqual(healthVerdict({ ok: true, httpStatus: 200, contentType: "text/html; charset=utf-8" }).status, "unknown");

// Con texto esperado configurado, el HTML sí se puede verificar en los dos sentidos.
assert.strictEqual(
  healthVerdict({ ok: true, httpStatus: 200, contentType: "text/html", expect: "OK", bodyMatched: true }).status,
  "up",
);
assert.strictEqual(
  healthVerdict({ ok: true, httpStatus: 200, contentType: "text/html", expect: "OK", bodyMatched: false }).status,
  "down",
);

// SPA: el bundle que enlaza el index decide. Se descarga como JS → sano; vuelve como HTML (el
// catch-all sirviendo index.html con 200) o con error → caído, aunque el index responda.
const html = { ok: true, httpStatus: 200, contentType: "text/html" };
const js = { ok: true, httpStatus: 200, contentType: "text/javascript", path: "/assets/index.js" };
assert.strictEqual(healthVerdict({ ...html, bundle: js }).status, "up");
assert.strictEqual(healthVerdict({ ...html, bundle: { ...js, contentType: "text/html" } }).status, "down");
assert.strictEqual(healthVerdict({ ...html, bundle: { ...js, ok: false, httpStatus: 404 } }).status, "down");

// Qué script se comprueba. Index reales (verificados 2026-11-04):
// launcher: scripts propios no-module y de CDN antes del entry de Vite → el module propio.
assert.strictEqual(
  bundleUrl(
    `<script src="/static-appopensalud/consent-default.js"></script>
     <script type="module" src="https://js.jam.dev/recorder.js"></script>
     <script type="module" crossorigin src="/assets/index-CPUHmZzW.js"></script>`,
    "https://desarrollo.opensalud.es/",
  ),
  "https://desarrollo.opensalud.es/assets/index-CPUHmZzW.js",
);
// Sin module propio (WordPress): el primer script del mismo origen, nunca el de CDN.
assert.strictEqual(
  bundleUrl(
    `<script src="https://cdn-cookieyes.com/x.js"></script><script id="a" src="https://www.opensalud.es/wp-includes/hooks.min.js?ver=1"></script>`,
    "https://www.opensalud.es/",
  ),
  "https://www.opensalud.es/wp-includes/hooks.min.js?ver=1",
);
// Solo scripts de terceros o inline: nada que comprobar → null (y el veredicto se queda en unknown).
assert.strictEqual(bundleUrl(`<script>var a=1</script><script src="https://cdn.x/y.js"></script>`, "https://a.es/"), null);

// Errores del servidor: caído, sin matices.
assert.strictEqual(healthVerdict({ ok: false, httpStatus: 502 }).status, "down");
assert.strictEqual(healthVerdict({ ok: false, httpStatus: 404 }).note, "HTTP 404");

console.log("✓ health verdict ok");
