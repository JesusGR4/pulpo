"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, nativeTheme, Notification } = require("electron");
const ai = require("./ai");
const config = require("./config");
const drafts = require("./drafts");
const provider = require("./provider");

// Proveedor activo (GitHub o GitLab) según config; se resuelve en cada llamada.
const gh = () => provider.current();

const SELFTEST = process.argv.includes("--selftest");
const SELFTEST_SHOT = "/tmp/pulpo-selftest.png";
const SELFTEST_TIMEOUT_MS = 20000;

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 600,
    title: "Pulpo",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1f24" : "#f6f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Sin throttling en background: el polling sigue vivo y capturePage (selftest)
      // siempre obtiene un frame fresco aunque la ventana no esté en primer plano.
      backgroundThrottling: false,
    },
  });
  const routeArg = process.argv.find((a) => a.startsWith("--selftest-route="));
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), {
    query: {
      selftest: SELFTEST ? "1" : "0",
      selftest_route: routeArg ? routeArg.split("=")[1] : "list",
      seed_draft: process.argv.includes("--seed-draft") ? "1" : "0",
    },
  });

  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function wireIpc() {
  ipcMain.handle("auth:status", async () => {
    const { token, source } = gh().resolveToken();
    if (!token) return { ok: false, source: null, login: null };
    try {
      const me = await gh().viewer();
      return { ok: true, source, login: me.login, avatarUrl: me.avatarUrl };
    } catch (err) {
      return { ok: false, source, login: null, error: String(err.message || err) };
    }
  });

  ipcMain.handle("config:get", () => {
    const { token, ...rest } = config.load();
    return { ...rest, hasManualToken: Boolean(token) };
  });

  ipcMain.handle("config:set", (_event, partial) => {
    const allowed = {};
    // GitLab admite paths anidados (group/sub/project); GitHub solo owner/repo.
    const current = config.load();
    const nextProvider = partial.provider === "github" || partial.provider === "gitlab" ? partial.provider : current.provider;
    const repoRe = nextProvider === "gitlab" ? /^[\w.-]+(\/[\w.-]+)+$/ : /^[\w.-]+\/[\w.-]+$/;
    if (Array.isArray(partial.repos)) allowed.repos = partial.repos.filter((r) => repoRe.test(r));
    if (Number.isInteger(partial.pollSeconds) && partial.pollSeconds >= 15) allowed.pollSeconds = partial.pollSeconds;
    if (["one-dark", "dracula", "github-light"].includes(partial.theme)) allowed.theme = partial.theme;
    if (partial.provider === "github" || partial.provider === "gitlab") {
      allowed.provider = partial.provider;
      // Cambiar de proveedor invalida el token: era de otro sitio.
      if (partial.provider !== current.provider) {
        allowed.token = null;
        gh().invalidateTokenCache();
      }
    }
    if (typeof partial.gitlabBaseUrl === "string" && /^https:\/\/[\w.-]+/.test(partial.gitlabBaseUrl.trim())) {
      allowed.gitlabBaseUrl = partial.gitlabBaseUrl.trim().replace(/\/+$/, "");
      gh().invalidateTokenCache();
    }
    if (typeof partial.aiModel === "string" && ai.isAiModel(partial.aiModel)) allowed.aiModel = partial.aiModel;
    if (typeof partial.aiEffort === "string" && ai.isAiEffort(partial.aiEffort)) allowed.aiEffort = partial.aiEffort;
    if (typeof partial.token === "string") {
      allowed.token = partial.token.trim() || null;
      gh().invalidateTokenCache();
    }
    if (typeof partial.lastRepo === "string") allowed.lastRepo = partial.lastRepo;
    if (typeof partial.lastBucket === "string") allowed.lastBucket = partial.lastBucket;
    if (partial.cherryPick && typeof partial.cherryPick === "object") {
      const cp = partial.cherryPick;
      const branchRe = /^[\w./-]{1,200}$/;
      const next = { ...current.cherryPick };
      if (typeof cp.prefix === "string" && cp.prefix.trim()) next.prefix = cp.prefix.trim();
      if (Array.isArray(cp.branches)) next.branches = cp.branches.filter((b) => typeof b === "string" && branchRe.test(b));
      if (typeof cp.siblingMx === "boolean") next.siblingMx = cp.siblingMx;
      allowed.cherryPick = next;
    }
    if (partial.milestones && typeof partial.milestones === "object") {
      const m = partial.milestones;
      const next = { ...current.milestones };
      if (typeof m.group === "string") next.group = m.group.trim() || null;
      else if (m.group === null) next.group = null;
      if (Array.isArray(m.statusLabels)) {
        next.statusLabels = m.statusLabels.filter((l) => typeof l === "string" && l.trim());
      }
      if (Array.isArray(m.doneLabels)) {
        next.doneLabels = m.doneLabels.filter((l) => typeof l === "string" && l.trim());
      }
      allowed.milestones = next;
    }
    const { token, ...rest } = config.save(allowed);
    return { ...rest, hasManualToken: Boolean(token) };
  });

  ipcMain.handle("repos:suggest", async () => gh().viewerRepos());

  ipcMain.handle("prs:list", async (_event, { repo, states }) => gh().listPRs(repo, states));
  ipcMain.handle("prs:search", async (_event, { repos, states }) => gh().searchPRs(repos, states));
  ipcMain.handle("pr:detail", async (_event, { repo, number }) => gh().prDetail(repo, number));
  ipcMain.handle("pr:merge", async (_event, { repo, number, deleteBranch, headRefName, isCrossRepository }) =>
    gh().mergePR(repo, number, { deleteBranch, headRefName, isCrossRepository }),
  );
  ipcMain.handle("pr:updateBranch", async (_event, { nodeId }) => gh().updateBranchRebase(nodeId));

  ipcMain.handle("pr:files", async (_event, { repo, number }) => gh().prFiles(repo, number));
  ipcMain.handle("pr:conversation", async (_event, { repo, number }) => gh().prConversation(repo, number));
  ipcMain.handle("pr:commentIssue", async (_event, { repo, number, body }) =>
    gh().addIssueComment(repo, number, body),
  );
  ipcMain.handle("pr:commentInline", async (_event, { repo, number, comment }) =>
    gh().addInlineComment(repo, number, comment),
  );
  ipcMain.handle("pr:replyThread", async (_event, { repo, number, commentDatabaseId, body }) =>
    gh().replyToThread(repo, number, commentDatabaseId, body),
  );
  ipcMain.handle("pr:resolveThread", async (_event, { threadId, resolved }) =>
    gh().setThreadResolved(String(threadId), Boolean(resolved)),
  );
  ipcMain.handle("pr:submitReview", async (_event, { repo, number, review }) =>
    gh().submitReview(repo, number, review),
  );
  ipcMain.handle("pr:dismissReview", async (_event, { repo, number, reviewId, message }) =>
    gh().dismissReview(repo, number, reviewId, String(message || "")),
  );

  ipcMain.handle("ai:review", async (_event, { title, body, files }) => ai.generateReview({ title, body, files }));
  ipcMain.handle("ai:status", () => ai.backendStatus());
  ipcMain.handle("ai:ping", async () => ai.ping());

  ipcMain.handle("drafts:list", (_event, { key }) => drafts.listFor(key));
  ipcMain.handle("drafts:save", (_event, { key, items }) => drafts.saveFor(key, items));
  ipcMain.handle("drafts:keys", () => drafts.allKeys());

  ipcMain.handle("history:branches", async (_event, { repo }) => gh().defaultBranch(repo));
  ipcMain.handle("history:graph", async (_event, { repo, branchSpecs }) => gh().branchHistories(repo, branchSpecs));
  const BRANCH_RE = /^[\w./-]{1,200}$/;
  ipcMain.handle("git:createBranch", async (_event, { repo, branch, sha }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return gh().createBranch(repo, branch, sha);
  });
  ipcMain.handle("git:forceUpdate", async (_event, { repo, branch, sha }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return gh().forceUpdateBranch(repo, branch, sha);
  });
  ipcMain.handle("pr:cherryPick", async (_event, { repo, sha, branch, dryRun }) => {
    if (!BRANCH_RE.test(branch)) throw new Error("Nombre de rama no válido");
    return gh().cherryPick(repo, sha, branch, { dryRun: Boolean(dryRun) });
  });
  ipcMain.handle("pr:revert", async (_event, { repo, number }) => {
    const nodeId = await gh().prNodeId(repo, number);
    return gh().revertPullRequest(nodeId);
  });
  ipcMain.handle("pr:setDraft", async (_event, { nodeId, toDraft }) => gh().setPrDraft(nodeId, Boolean(toDraft)));

  ipcMain.handle("milestones:list", async () => gh().listMilestones());
  ipcMain.handle("milestones:issues", async (_event, { title, includeClosed }) =>
    gh().milestoneIssues(title, { includeClosed: Boolean(includeClosed) }),
  );
  ipcMain.handle("issues:groupLabels", async () => gh().groupLabels());
  ipcMain.handle("issues:update", async (_event, { projectId, iid, patch }) =>
    gh().updateIssue(projectId, iid, patch || {}),
  );

  ipcMain.handle("shell:open", (_event, url) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
  });

  ipcMain.handle("notify", (_event, { title, body }) => {
    if (Notification.isSupported()) new Notification({ title: String(title), body: String(body) }).show();
  });
  ipcMain.handle("dock:badge", (_event, text) => {
    app.dock?.setBadge(typeof text === "string" ? text : "");
  });
}

function wireSelftest() {
  let done = false;
  const finish = async (reason) => {
    if (done || !win) return;
    done = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1300)); // deja asentar fuentes/avatares
      const bodyLength = await win.webContents.executeJavaScript("document.body.innerHTML.length");
      // doble rAF: garantiza que el último DOM se ha pintado/compuesto antes de capturar
      await win.webContents.executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const image = await win.webContents.capturePage();
      fs.writeFileSync(SELFTEST_SHOT, image.toPNG());
      console.log(`[selftest] screenshot: ${SELFTEST_SHOT} (reason=${reason}, bodyHTML=${bodyLength} chars)`);
    } catch (err) {
      console.error("[selftest] capture failed:", err);
    } finally {
      app.quit();
    }
  };
  ipcMain.once("selftest:render-complete", () => finish("render-complete"));
  setTimeout(() => finish("timeout"), SELFTEST_TIMEOUT_MS);
}

app.whenReady().then(() => {
  const dockIcon = path.join(__dirname, "..", "assets", "icon-512.png");
  if (process.platform === "darwin" && fs.existsSync(dockIcon)) app.dock.setIcon(dockIcon);
  wireIpc();
  if (SELFTEST) wireSelftest();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
