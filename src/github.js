"use strict";

const { execFileSync } = require("child_process");
const config = require("./config");

const GQL_URL = "https://api.github.com/graphql";
const REST_URL = "https://api.github.com";

let cachedToken = null;
let cachedTokenSource = null;

function resolveToken() {
  if (cachedToken) return { token: cachedToken, source: cachedTokenSource };

  if (process.env.GITHUB_TOKEN) {
    cachedToken = process.env.GITHUB_TOKEN.trim();
    cachedTokenSource = "env:GITHUB_TOKEN";
    return { token: cachedToken, source: cachedTokenSource };
  }
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 }).trim();
    if (out) {
      cachedToken = out;
      cachedTokenSource = "gh CLI";
      return { token: cachedToken, source: cachedTokenSource };
    }
  } catch {
    /* gh no disponible o sin login: probamos config */
  }
  const stored = config.load().token;
  if (stored) {
    cachedToken = stored;
    cachedTokenSource = "config.json";
    return { token: cachedToken, source: cachedTokenSource };
  }
  return { token: null, source: null };
}

function invalidateTokenCache() {
  cachedToken = null;
  cachedTokenSource = null;
}

async function gql(query, variables) {
  const { token } = resolveToken();
  if (!token) throw new Error("NO_TOKEN");
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "pulpo-app",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message);
  return payload.data;
}

async function rest(method, path, body) {
  const { token } = resolveToken();
  if (!token) throw new Error("NO_TOKEN");
  const res = await fetch(`${REST_URL}${path}`, {
    method,
    headers: {
      Authorization: `bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pulpo-app",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

const PR_LIST_FIELDS = `
  id number title url isDraft state createdAt updatedAt
  baseRefName headRefName isCrossRepository
  repository { nameWithOwner }
  headRepository { nameWithOwner }
  author { login avatarUrl }
  mergeable mergeStateStatus reviewDecision
  additions deletions changedFiles
  comments { totalCount }
  labels(first: 6) { nodes { name color } }
  reviewRequests(first: 10) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } }
  }
  latestReviews(first: 10) { nodes { databaseId author { login avatarUrl } state } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

async function viewer() {
  const data = await gql(`query { viewer { login avatarUrl } }`);
  return data.viewer;
}

/** Repos accesibles del usuario (recientes primero), para el picker del onboarding. */
async function viewerRepos() {
  const data = await gql(
    `query {
       viewer {
         repositories(
           first: 50
           orderBy: { field: PUSHED_AT, direction: DESC }
           affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
         ) {
           nodes { nameWithOwner isPrivate isArchived }
         }
       }
     }`,
  );
  return data.viewer.repositories.nodes
    .filter((r) => !r.isArchived)
    .map((r) => ({ nameWithOwner: r.nameWithOwner, isPrivate: r.isPrivate }));
}

async function listPRs(repoFullName, states) {
  const [owner, name] = repoFullName.split("/");
  const data = await gql(
    `query ($owner: String!, $name: String!, $states: [PullRequestState!]) {
       repository(owner: $owner, name: $name) {
         pullRequests(states: $states, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
           nodes { ${PR_LIST_FIELDS} }
         }
       }
     }`,
    { owner, name, states },
  );
  if (!data.repository) throw new Error(`Repo no accesible: ${repoFullName}`);
  return data.repository.pullRequests.nodes;
}

/** PRs agregadas de varios repos (vista "Todos") vía search. */
async function searchPRs(repoFullNames, states) {
  const stateQualifier = { OPEN: "is:open", MERGED: "is:merged", CLOSED: "is:closed is:unmerged" }[states[0]] || "is:open";
  const repoQualifiers = repoFullNames.map((r) => `repo:${r}`).join(" ");
  const data = await gql(
    `query ($q: String!) {
       search(query: $q, type: ISSUE, first: 50) {
         nodes { ... on PullRequest { ${PR_LIST_FIELDS} } }
       }
     }`,
    { q: `is:pr ${stateQualifier} ${repoQualifiers} sort:updated-desc` },
  );
  return data.search.nodes.filter((n) => n && n.number);
}

async function prDetail(repoFullName, number) {
  const [owner, name] = repoFullName.split("/");
  const data = await gql(
    `query ($owner: String!, $name: String!, $number: Int!) {
       repository(owner: $owner, name: $name) {
         pullRequest(number: $number) {
           ${PR_LIST_FIELDS}
           body
           bodyHTML
           commits(last: 1) {
             nodes { commit { statusCheckRollup { state contexts(first: 30) { nodes {
               __typename
               ... on CheckRun { name conclusion status detailsUrl }
               ... on StatusContext { context state targetUrl }
             } } } } }
           }
         }
       }
     }`,
    { owner, name, number },
  );
  return data.repository.pullRequest;
}

/** Merge SIEMPRE con merge commit. Squash y rebase-merge no existen en esta casa. */
async function mergePR(repoFullName, number, { deleteBranch, headRefName, isCrossRepository }) {
  const result = await rest("PUT", `/repos/${repoFullName}/pulls/${number}/merge`, {
    merge_method: "merge",
  });
  let branchDeleted = false;
  if (deleteBranch && !isCrossRepository) {
    try {
      await rest("DELETE", `/repos/${repoFullName}/git/refs/heads/${encodeURIComponent(headRefName)}`);
      branchDeleted = true;
    } catch {
      /* la rama puede estar protegida o ya borrada: no es fatal */
    }
  }
  return { merged: result.merged === true, sha: result.sha, branchDeleted };
}

/** Update branch SIEMPRE con rebase (así se hacen los pull aquí). */
async function updateBranchRebase(prNodeId) {
  const data = await gql(
    `mutation ($id: ID!) {
       updatePullRequestBranch(input: { pullRequestId: $id, updateMethod: REBASE }) {
         pullRequest { number mergeStateStatus }
       }
     }`,
    { id: prNodeId },
  );
  return data.updatePullRequestBranch.pullRequest;
}

/* ---------- histórico (grafo de commits) ---------- */

const HISTORY_COMMIT_FIELDS = `
  oid abbreviatedOid messageHeadline committedDate
  author { name user { login avatarUrl } }
  parents(first: 3) { nodes { oid } }
  associatedPullRequests(first: 1) { nodes { number title state } }
`;

async function defaultBranch(repoFullName) {
  const [owner, name] = repoFullName.split("/");
  const data = await gql(
    `query ($owner: String!, $name: String!) {
       repository(owner: $owner, name: $name) { defaultBranchRef { name } }
     }`,
    { owner, name },
  );
  return data.repository?.defaultBranchRef?.name || "main";
}

/** Historia de varias ramas en una sola query (aliases b0..bn con variables). */
async function branchHistories(repoFullName, branchSpecs) {
  const [owner, name] = repoFullName.split("/");
  const varDefs = branchSpecs.map((_, i) => `$r${i}: String!, $n${i}: Int!`).join(", ");
  const aliases = branchSpecs
    .map(
      (_, i) => `b${i}: ref(qualifiedName: $r${i}) {
        name target { ... on Commit { oid history(first: $n${i}) { nodes { ${HISTORY_COMMIT_FIELDS} } } } }
      }`,
    )
    .join("\n");
  const variables = { owner, name };
  branchSpecs.forEach((spec, i) => {
    variables[`r${i}`] = `refs/heads/${spec.name}`;
    variables[`n${i}`] = spec.depth;
  });
  const data = await gql(
    `query ($owner: String!, $name: String!, ${varDefs}) {
       repository(owner: $owner, name: $name) { ${aliases} }
     }`,
    variables,
  );
  const branches = [];
  const commitsByOid = new Map();
  branchSpecs.forEach((_, i) => {
    const ref = data.repository[`b${i}`];
    if (!ref?.target) return;
    branches.push({ name: ref.name, headOid: ref.target.oid });
    for (const commit of ref.target.history.nodes) {
      if (!commitsByOid.has(commit.oid)) commitsByOid.set(commit.oid, commit);
    }
  });
  return { branches, commits: [...commitsByOid.values()] };
}

/* ---------- diff + conversación ---------- */

async function prFiles(repoFullName, number) {
  const files = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await rest("GET", `/repos/${repoFullName}/pulls/${number}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files.map((f) => ({
    filename: f.filename,
    previousFilename: f.previous_filename || null,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch || null,
  }));
}

async function prConversation(repoFullName, number) {
  const [owner, name] = repoFullName.split("/");
  const data = await gql(
    `query ($owner: String!, $name: String!, $number: Int!) {
       repository(owner: $owner, name: $name) {
         pullRequest(number: $number) {
           headRefOid
           comments(first: 60) { totalCount nodes { author { login avatarUrl } bodyHTML createdAt } }
           reviewThreads(first: 60) {
             nodes {
               id path line startLine isResolved isOutdated viewerCanResolve viewerCanUnresolve
               comments(first: 20) { nodes { databaseId author { login avatarUrl } bodyHTML createdAt } }
             }
           }
         }
       }
     }`,
    { owner, name, number },
  );
  return data.repository.pullRequest;
}

async function addIssueComment(repoFullName, number, body) {
  return rest("POST", `/repos/${repoFullName}/issues/${number}/comments`, { body });
}

async function addInlineComment(repoFullName, number, { body, commitId, path, side, line }) {
  return rest("POST", `/repos/${repoFullName}/pulls/${number}/comments`, {
    body,
    commit_id: commitId,
    path,
    side,
    line,
  });
}

async function replyToThread(repoFullName, number, commentDatabaseId, body) {
  return rest("POST", `/repos/${repoFullName}/pulls/${number}/comments/${commentDatabaseId}/replies`, { body });
}

/** Resuelve o reabre un hilo de review (mutations de GraphQL sobre el node id del hilo). */
async function setThreadResolved(threadId, resolved) {
  if (resolved) {
    const data = await gql(
      `mutation ($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`,
      { id: threadId },
    );
    return data.resolveReviewThread.thread;
  }
  const data = await gql(
    `mutation ($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`,
    { id: threadId },
  );
  return data.unresolveReviewThread.thread;
}

/**
 * Publica de golpe una review con todos los borradores: comentarios inline +
 * body general + veredicto (COMMENT / APPROVE / REQUEST_CHANGES).
 */
async function submitReview(repoFullName, number, { commitId, event, body, comments }) {
  const payload = { event };
  if (commitId) payload.commit_id = commitId;
  if (body) payload.body = body;
  if (comments?.length) {
    payload.comments = comments.map((c) => ({ path: c.path, side: c.side, line: c.line, body: c.body }));
  }
  return rest("POST", `/repos/${repoFullName}/pulls/${number}/reviews`, payload);
}

/** Descarta una review publicada (quitar tu aprobación). GitHub exige un mensaje. */
async function dismissReview(repoFullName, number, reviewId, message) {
  return rest("PUT", `/repos/${repoFullName}/pulls/${number}/reviews/${reviewId}/dismissals`, { message });
}

/* ---------- acciones sobre el grafo ---------- */

async function createBranch(repoFullName, branchName, sha) {
  return rest("POST", `/repos/${repoFullName}/git/refs`, { ref: `refs/heads/${branchName}`, sha });
}

/** "Volver atrás": mueve la punta de la rama a un commit anterior (force update). */
async function forceUpdateBranch(repoFullName, branchName, sha) {
  return rest("PATCH", `/repos/${repoFullName}/git/refs/heads/${encodeURIComponent(branchName)}`, {
    sha,
    force: true,
  });
}

/**
 * Stub de paridad: el cherry-pick post-merge de hotfix es una feature solo-GitLab
 * (la UI la oculta cuando provider !== "gitlab"). GitHub no tiene endpoint único de
 * cherry-pick para una MR; si alguien la invoca aquí, fallamos explícito en vez de
 * romper en silencio. Mantiene la interfaz idéntica entre proveedores.
 */
async function cherryPick() {
  throw new Error("El cherry-pick de hotfix solo está disponible en GitLab.");
}

/**
 * Stubs de paridad: la vista de Milestones es una feature solo-GitLab
 * (la UI la oculta cuando provider !== "gitlab"). Si alguien las invoca aquí,
 * fallamos explícito en vez de romper en silencio. Mantiene la interfaz idéntica.
 */
async function listMilestones() {
  throw new Error("La vista de Milestones solo está disponible en GitLab.");
}

async function milestoneIssues() {
  throw new Error("La vista de Milestones solo está disponible en GitLab.");
}

async function groupLabels() {
  throw new Error("La vista de Milestones solo está disponible en GitLab.");
}

async function updateIssue() {
  throw new Error("La vista de Milestones solo está disponible en GitLab.");
}

async function revertPullRequest(prNodeId) {
  const data = await gql(
    `mutation ($id: ID!) {
       revertPullRequest(input: { pullRequestId: $id }) {
         revertPullRequest { number url }
       }
     }`,
    { id: prNodeId },
  );
  return data.revertPullRequest.revertPullRequest;
}

/** Alterna una PR entre borrador y lista para review. */
async function setPrDraft(prNodeId, toDraft) {
  if (toDraft) {
    const data = await gql(
      `mutation ($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }`,
      { id: prNodeId },
    );
    return data.convertPullRequestToDraft.pullRequest;
  }
  const data = await gql(
    `mutation ($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }`,
    { id: prNodeId },
  );
  return data.markPullRequestReadyForReview.pullRequest;
}

async function prNodeId(repoFullName, number) {
  const [owner, name] = repoFullName.split("/");
  const data = await gql(
    `query ($owner: String!, $name: String!, $number: Int!) {
       repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
     }`,
    { owner, name, number },
  );
  return data.repository.pullRequest.id;
}

module.exports = {
  resolveToken,
  invalidateTokenCache,
  viewer,
  viewerRepos,
  listPRs,
  searchPRs,
  prDetail,
  mergePR,
  updateBranchRebase,
  defaultBranch,
  branchHistories,
  prFiles,
  prConversation,
  addIssueComment,
  addInlineComment,
  replyToThread,
  setThreadResolved,
  submitReview,
  dismissReview,
  createBranch,
  forceUpdateBranch,
  cherryPick,
  revertPullRequest,
  setPrDraft,
  prNodeId,
  listMilestones,
  milestoneIssues,
  groupLabels,
  updateIssue,
};
