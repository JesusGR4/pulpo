"use strict";

// Handlers IPC del tablero de Validación (solo GitLab). Se registran desde wireIpc() en src/main.js.
// Los repos salen de la config, no del renderer; una acción solo vale sobre un repo configurado.

const { ipcMain } = require("electron");
const config = require("../config");
const provider = require("../provider");

const gh = () => provider.current();
const KINDS = ["approve", "play", "retry"];

function register(ctx) {
  // Devuelve el tablero completo y, mientras, empuja parciales por "validation:progress" con el
  // `runId` de la petición (el renderer descarta los de una carga anterior).
  ipcMain.handle("validation:board", async (_event, { runId } = {}) =>
    gh().validationBoard(config.load().repos || [], (board) => {
      const win = ctx.win;
      if (win && !win.isDestroyed()) win.webContents.send("validation:progress", { runId, ...board });
    }),
  );

  ipcMain.handle("validation:act", async (_event, { repo, iid, kind, jobId }) => {
    if (!(config.load().repos || []).includes(repo)) throw new Error("Repo no configurado");
    if (!Number.isInteger(iid) || iid < 1) throw new Error("MR no válida");
    if (!KINDS.includes(kind)) throw new Error("Acción no válida");
    if (kind !== "approve" && !(Number.isInteger(jobId) && jobId > 0)) throw new Error("Job no válido");
    return gh().validationAct(repo, iid, kind, jobId);
  });
}

module.exports = { register };
