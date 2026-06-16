"use strict";

/**
 * Review con IA: analiza el diff de una PR y devuelve comentarios de review
 * estructurados (en inglés) que Pulpo convierte en BORRADORES locales — nunca
 * se publica nada sin que el usuario pulse Publicar.
 *
 * Backends, en orden:
 *  1. ANTHROPIC_API_KEY presente → SDK oficial de Anthropic con structured
 *     outputs (JSON estricto garantizado por schema).
 *  2. CLI de Claude Code (`claude -p --output-format json`) → usa la sesión
 *     ya autenticada del usuario; el JSON se extrae del campo `result`.
 */

const { spawn } = require("child_process");
const { execFileSync } = require("child_process");
const config = require("./config");

/**
 * Catálogo de modelos para la review. Los IDs valen tal cual para los dos
 * backends (API y `claude --model`). `efforts` lista los niveles que ese
 * modelo acepta en output_config.effort / --effort; vacío = no soportado
 * (Haiku tampoco soporta thinking adaptativo, así que se omite ahí).
 */
const AI_MODELS = {
  "claude-opus-4-8": { label: "Claude Opus 4.8", efforts: ["low", "medium", "high", "xhigh", "max"] },
  "claude-sonnet-4-6": { label: "Claude Sonnet 4.6", efforts: ["low", "medium", "high", "max"] },
  "claude-haiku-4-5": { label: "Claude Haiku 4.5", efforts: [] },
};
const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_EFFORT = "high";
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Modelo + esfuerzo efectivos: lo configurado, saneado contra el catálogo. */
function aiSettings() {
  const cfg = config.load();
  const model = AI_MODELS[cfg.aiModel] ? cfg.aiModel : DEFAULT_MODEL;
  const efforts = AI_MODELS[model].efforts;
  const effort = efforts.includes(cfg.aiEffort)
    ? cfg.aiEffort
    : efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : null;
  return { model, effort };
}

const MAX_DIFF_CHARS = 70_000;
const CLI_TIMEOUT_MS = 12 * 60 * 1000;
// Sin MCP servers ni persistencia de sesión: arranque más rápido y sin tocar
// el historial de Claude Code del usuario. La review es un one-shot sin tools.
const CLI_ARGS = [
  "-p",
  "--output-format", "json",
  "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}',
  "--no-session-persistence",
];

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Concise overall review summary in English (markdown allowed).",
    },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path exactly as it appears in the diff." },
          line: { type: "integer", description: "Line number the comment anchors to." },
          side: { type: "string", enum: ["LEFT", "RIGHT"] },
          body: { type: "string", description: "The review comment, in English." },
        },
        required: ["path", "line", "side", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "comments"],
  additionalProperties: false,
};

function buildPrompt({ title, body, diffText, truncated }) {
  return `You are a senior software engineer reviewing a colleague's pull request. Review the diff below and produce focused, actionable review comments.

Rules:
- Write everything in English (comments and summary).
- Focus on real issues: correctness bugs, edge cases, race conditions, security, performance, misleading names, dead code. Avoid style nits and empty praise.
- At most 8 inline comments — only the ones worth a human's attention. If the change looks good, return few or zero comments and say so in the summary.
- Each inline comment anchors to a line VISIBLE IN THE DIFF: use side "RIGHT" with the new-file line number for added/context lines, or side "LEFT" with the old-file line number for deleted lines. Use the exact file path shown in the diff.
- Be concrete: say what is wrong and what you would do instead.
${truncated ? "- Note: the diff was truncated for length; mention that in the summary.\n" : ""}
Respond with ONLY a JSON object matching this shape (no prose, no code fences):
{"summary": string, "comments": [{"path": string, "line": integer, "side": "LEFT"|"RIGHT", "body": string}]}

# Pull request
Title: ${title}

Description:
${body || "(no description)"}

# Diff
${diffText}`;
}

function buildDiffText(files) {
  const parts = [];
  let used = 0;
  let truncated = false;
  for (const file of files) {
    if (!file.patch) continue;
    const header = `--- a/${file.previousFilename || file.filename}\n+++ b/${file.filename}\n`;
    const chunk = header + file.patch + "\n";
    if (used + chunk.length > MAX_DIFF_CHARS) {
      truncated = true;
      break;
    }
    parts.push(chunk);
    used += chunk.length;
  }
  return { diffText: parts.join("\n"), truncated };
}

/* ---------- backend 1: SDK oficial (requiere ANTHROPIC_API_KEY) ---------- */

async function generateViaSdk(prompt, model, effort) {
  const Anthropic = require("@anthropic-ai/sdk").default;
  const client = new Anthropic();
  const request = {
    model,
    max_tokens: 16000,
    output_config: { format: { type: "json_schema", schema: REVIEW_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  };
  if (AI_MODELS[model].efforts.length) {
    request.thinking = { type: "adaptive" };
    if (effort) request.output_config.effort = effort;
  }
  const response = await client.messages.create(request);
  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Empty response from the Anthropic API");
  return JSON.parse(text);
}

/* ---------- backend 2: CLI de Claude Code (sesión del usuario) ---------- */

function claudeCliPath() {
  try {
    return execFileSync("/bin/sh", ["-lc", "command -v claude"], { encoding: "utf8", timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

function generateViaCli(prompt, cliPath, model, effort) {
  const args = [...CLI_ARGS, "--model", model];
  if (effort) args.push("--effort", effort);
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, CLI_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(
          new Error(
            `La review tardó más de ${CLI_TIMEOUT_MS / 60000} min y se canceló (PR muy grande). ` +
              "Reintenta, o exporta ANTHROPIC_API_KEY para usar la API directa (más rápida).",
          ),
        );
      }
      if (code !== 0) return reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 300)}`));
      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) return reject(new Error(`claude CLI error: ${String(envelope.result).slice(0, 300)}`));
        resolve(extractJson(envelope.result));
      } catch (err) {
        reject(new Error(`Could not parse claude CLI output: ${err.message}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Tolerante con cercos ```json y prosa accidental alrededor del objeto. */
function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in the model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

/* ---------- API pública ---------- */

async function generateReview({ title, body, files }) {
  const { diffText, truncated } = buildDiffText(files);
  if (!diffText) throw new Error("La PR no tiene diff revisable (¿binarios?)");
  const prompt = buildPrompt({ title, body, diffText, truncated });

  const { model, effort } = aiSettings();
  if (process.env.ANTHROPIC_API_KEY) {
    return { review: normalize(await generateViaSdk(prompt, model, effort)), backend: "anthropic-sdk", model, effort };
  }
  const cliPath = claudeCliPath();
  if (cliPath) {
    return { review: normalize(await generateViaCli(prompt, cliPath, model, effort)), backend: "claude-cli", model, effort };
  }
  throw new Error(
    "Sin backend de IA: exporta ANTHROPIC_API_KEY o instala/loguea el CLI de Claude Code (`claude`).",
  );
}

function normalize(review) {
  return {
    summary: typeof review.summary === "string" ? review.summary : "",
    comments: (Array.isArray(review.comments) ? review.comments : [])
      .filter((c) => c && typeof c.path === "string" && Number.isInteger(c.line) && typeof c.body === "string")
      .map((c) => ({ path: c.path, line: c.line, side: c.side === "LEFT" ? "LEFT" : "RIGHT", body: c.body }))
      .slice(0, 12),
  };
}

/** Estado del backend de IA, para onboarding y ajustes. */
function backendStatus() {
  const { model, effort } = aiSettings();
  const base = {
    model,
    effort,
    models: Object.entries(AI_MODELS).map(([id, m]) => ({ id, label: m.label, efforts: m.efforts })),
  };
  if (process.env.ANTHROPIC_API_KEY) {
    return { ...base, backend: "anthropic-sdk", detail: "ANTHROPIC_API_KEY presente — SDK oficial" };
  }
  const cliPath = claudeCliPath();
  if (cliPath) {
    let version = "";
    try {
      version = execFileSync(cliPath, ["--version"], { encoding: "utf8", timeout: 5000 }).trim().split("\n")[0];
    } catch {
      /* la versión es decorativa */
    }
    return { ...base, backend: "claude-cli", detail: `Claude Code CLI en ${cliPath}${version ? ` (${version})` : ""}` };
  }
  return { ...base, backend: null, detail: "Sin backend: exporta ANTHROPIC_API_KEY o instala Claude Code y haz login" };
}

/** Prueba ligera del backend (para el botón "Probar IA" de Ajustes). */
async function ping() {
  const status = backendStatus();
  if (!status.backend) return { ...status, ok: false };
  const { model, effort } = aiSettings();
  try {
    if (status.backend === "anthropic-sdk") {
      const Anthropic = require("@anthropic-ai/sdk").default;
      await new Anthropic().models.retrieve(model);
      return { ...status, ok: true };
    }
    const result = await generateViaCli(
      'Reply with ONLY this JSON and nothing else: {"ok": true}',
      claudeCliPath(),
      model,
      effort,
    );
    return { ...status, ok: result.ok === true };
  } catch (err) {
    return { ...status, ok: false, detail: `${status.detail} — fallo: ${String(err.message || err).slice(0, 200)}` };
  }
}

function isAiModel(id) {
  return Boolean(AI_MODELS[id]);
}

function isAiEffort(level) {
  return ALL_EFFORTS.includes(level);
}

module.exports = { generateReview, backendStatus, ping, isAiModel, isAiEffort };
