"use strict";
/**
 * Guarda del candado de dev: devSlotVerdict() en renderer/app/environments.js debe decir lo mismo que
 * `isDevBusy` de delivery-flow (scripts/dev-slot.cjs), que es quien bloquea de verdad el
 * aprobar-para-probar. Si la matriz dice "libre" y el job dice "ocupado", la vista miente.
 *
 * `node scripts/test-dev-slot.js`. Mismo truco vm que test-env-mirror.js.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "renderer", "app", "environments.js"), "utf8");
const context = vm.createContext({ state: { config: {} }, t: (es) => es, esc: (s) => s });
vm.runInContext(SOURCE, context);
const { devSlotVerdict } = context;

const mr = (over) => ({ mr: { iid: 1, state: "opened", draft: false, pipeline: "manual", ...over } });
const busy = (slot) => devSlotVerdict(slot).busy;

assert.strictEqual(busy(mr({})), true, "MR abierta con pipeline sin validar ocupa dev");
assert.strictEqual(busy(mr({ pipeline: "running" })), true);
assert.strictEqual(busy(mr({ pipeline: "failed" })), true, "un pipeline roto sigue ocupando (delivery-flow igual)");
assert.strictEqual(busy(mr({ pipeline: "success" })), false, "validada por QA libera");
assert.strictEqual(busy(mr({ draft: true })), false, "Draft libera");
assert.strictEqual(busy(mr({ state: "merged" })), false, "mergeada libera");
assert.strictEqual(busy(mr({ state: "closed" })), false, "cerrada libera");
assert.strictEqual(busy(mr({ pipeline: null })), false, "sin pipeline libera");
assert.strictEqual(busy({ mr: null }), false, "rama sin MR libera");

console.log("test-dev-slot: OK");
