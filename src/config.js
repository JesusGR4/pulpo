"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  // Proveedor: "github" | "gitlab". null = el onboarding aún no ha preguntado.
  provider: null,
  // Base de la API de GitLab (gitlab.com o instancia self-hosted). Solo se usa con provider "gitlab".
  gitlabBaseUrl: "https://gitlab.com",
  // Sin repos de fábrica: el onboarding ofrece los repos accesibles del usuario.
  repos: [],
  pollSeconds: 60,
  // Tema de resaltado de sintaxis del diff (pantalla Cambios): "one-dark" | "dracula" | "github-light".
  theme: "one-dark",
  aiModel: "claude-opus-4-8",
  aiEffort: "high",
  lastRepo: null,
  lastBucket: null,
  // Token manual SOLO como último recurso; lo normal es el CLI (gh/glab) o la env var.
  token: null,
  // Cherry-pick de hotfix tras merge (solo GitLab). Las MR de hotfix/* van a la release branch;
  // su contenido se replica a otras ramas (development + la rama hermana -mx, derivada del destino).
  cherryPick: {
    // Prefijo de rama origen que dispara el ofrecimiento de cherry-pick.
    prefix: "hotfix/",
    // Ramas destino fijas que siempre se proponen.
    branches: ["development"],
    // Además, proponer la rama hermana de la release branch destino (mx ⇄ sin mx).
    siblingMx: true,
  },
  // Vista de Milestones (solo GitLab): foto por persona de las tareas (issues) de un milestone de grupo.
  milestones: {
    // Grupo de GitLab del que leer milestones e issues. null = derivar del primer segmento de repos[].
    group: null,
    // Labels que representan el ESTADO del flujo de trabajo (se muestran como chips de filtro).
    // El resto de labels del issue se tratan como categorías/prioridades y no filtran el flujo.
    statusLabels: [
      "in development",
      "checking",
      "pending check",
      "pending check by issuer",
      "pending check in pruebas",
      "waiting",
      "needs fixing",
      "needs enhancements",
      "finished",
    ],
    // Labels de "terminada pero no cerrada" (la fase de comprobación): se ocultan por
    // defecto (chip en modo "ocultar") y alimentan la métrica "En comprobar". Un issue
    // abierto con cualquiera de estas no cuenta como pendiente. Editable por instancia.
    doneLabels: ["finished", "pending check", "pending check by issuer", "pending check in pruebas"],
  },
};

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    const cfg = { ...DEFAULTS, ...parsed };
    // Merge profundo de cherryPick: un guardado parcial no debe pisar los defaults del resto de claves.
    cfg.cherryPick = { ...DEFAULTS.cherryPick, ...(parsed.cherryPick || {}) };
    // Merge profundo de milestones: un guardado parcial no debe pisar los defaults del resto de claves.
    cfg.milestones = { ...DEFAULTS.milestones, ...(parsed.milestones || {}) };
    return cfg;
  } catch {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const next = { ...load(), ...partial };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

module.exports = { load, save, configPath };
