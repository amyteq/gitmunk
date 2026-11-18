// GitHub facts per task (§9): one GraphQL query per tick, turned into the per-issue facts `advance` reads.
// Reuses selectTask (refine) and reviewEvidence (merge); GitHub text is data and never reaches a command line
// except as a GraphQL variable. Also reads and writes the body the ledger lives in.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAutoRegions, selectTask } from '../../dev-refine-issue/scripts/check-refinement.mjs';
import { reviewEvidence } from '../../dev-merge/scripts/check-merge.mjs';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// A failed `gh` call or a GraphQL error throws this; the loop turns it into one `github-unavailable` event
// and retries next tick. No partial facts are ever returned.
export class GithubUnavailable extends Error {}

const PR_FIELDS = `fragment pr on PullRequest {
  number state merged createdAt mergedAt headRefOid author { login } baseRepository { nameWithOwner }
  commits(last: 1) { nodes { commit { committedDate } } }
  statusCheckRollup { state }
  comments(last: 100) { nodes { body authorAssociation createdAt url author { login } } }
  reviews(last: 50) { nodes { state submittedAt authorAssociation url author { login } commit { oid } } }
}`;

const ISSUE_FIELDS = `body authorAssociation editor { login }
  comments(last: 100) { totalCount nodes { databaseId body authorAssociation createdAt url author { login } } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { ...pr } }
  timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 20) { nodes { ... on CrossReferencedEvent { willCloseTarget source { ... on PullRequest { ...pr } } } } }`;

export function factsQuery(repo, issues) {
  const [owner, name] = repo.split('/');
  for (const n of issues) if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`bad issue number ${n}`);
  const fields = issues.map((n) => `issue_${n}: issue(number: ${n}) { ${ISSUE_FIELDS} }`).join('\n    ');
  const query = `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}\n${PR_FIELDS}`;
  return { query, variables: { owner, name } };
}

const run = (gh, args) => {
  const r = gh(args);
  if (r.code !== 0) throw new GithubUnavailable(`gh ${args.slice(0, 2).join(' ')} exited ${r.code}: ${String(r.stderr).trim()}`);
  try { return JSON.parse(r.stdout); } catch { throw new GithubUnavailable('gh returned unreadable JSON'); }
};
const graphql = (gh, args) => {
  const res = run(gh, ['api', 'graphql', ...args]);
  if (res.errors?.length) throw new GithubUnavailable(`GraphQL error: ${JSON.stringify(res.errors).slice(0, 300)}`);
  return res.data;
};

// ---- The source the ledger lives in (§6): an issue or discussion body, or an issue or discussion comment ----
// A discussion comment source also carries `nodeId`, its GraphQL id.

const restPath = (repo, src) => (src.kind === 'comment' ? `repos/${repo}/issues/comments/${src.id}` : `repos/${repo}/issues/${src.number}`);
const repoVars = (repo) => { const [owner, name] = repo.split('/'); return ['-f', `owner=${owner}`, '-f', `name=${name}`]; };
const READ_DISCUSSION = 'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { id body authorAssociation author { login } } } }';
const UPDATE_DISCUSSION = 'mutation($id: ID!, $body: String!) { updateDiscussion(input: { discussionId: $id, body: $body }) { discussion { id } } }';
const READ_DISCUSSION_COMMENT = 'query($id: ID!) { node(id: $id) { ... on DiscussionComment { body authorAssociation author { login } } } }';
const UPDATE_DISCUSSION_COMMENT = 'mutation($id: ID!, $body: String!) { updateDiscussionComment(input: { commentId: $id, body: $body }) { comment { id } } }';
const ADD_DISCUSSION_COMMENT = 'mutation($id: ID!, $body: String!) { addDiscussionComment(input: { discussionId: $id, body: $body }) { comment { id databaseId } } }';
const SOURCE_KIND = 'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { __typename } discussion(number: $number) { id } } }';
const DISCUSSION_COMMENTS = 'query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { discussion(number: $number) { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id databaseId } } } } }';
const inDiscussion = (src) => src.kind === 'comment' && src.parent?.kind === 'discussion';
const authorOf = (login, association) => ({ author: login ?? '', association });

export const sourceUrl = (repo, src) => (src.kind === 'comment'
  ? `https://github.com/${repo}/${src.parent?.kind === 'discussion' ? `discussions/${src.parent.number}#discussioncomment-` : `issues/${src.parent?.number}#issuecomment-`}${src.id}`
  : `https://github.com/${repo}/${src.kind === 'discussion' ? 'discussions' : 'issues'}/${src.number}`);

/** → { body, author, association }, plus `id` (its node id) for a discussion. Throws GithubUnavailable. */
export function readSource({ repo, src, gh }) {
  if (inDiscussion(src)) {
    const c = graphql(gh, ['-f', `query=${READ_DISCUSSION_COMMENT}`, '-f', `id=${src.nodeId}`])?.node;
    if (!c) throw new GithubUnavailable(`discussion comment ${src.id} not found`);
    return { body: c.body ?? '', ...authorOf(c.author?.login, c.authorAssociation) };
  }
  if (src.kind !== 'discussion') {
    const r = run(gh, ['api', restPath(repo, src)]);
    return { body: r.body ?? '', ...authorOf(r.user?.login, r.author_association) };
  }
  const d = graphql(gh, ['-f', `query=${READ_DISCUSSION}`, ...repoVars(repo), '-F', `number=${src.number}`])?.repository?.discussion;
  if (!d) throw new GithubUnavailable(`discussion #${src.number} not found`);
  return { body: d.body ?? '', id: d.id, ...authorOf(d.author?.login, d.authorAssociation) };
}

// `fn(file)` with `body` in a file of a private temporary directory, so the text never becomes argv.
function withBodyFile(body, fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-batch-body-'));
  const file = join(tmp, 'body.md');
  try {
    writeFileSync(file, body);
    return fn(file);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Replaces the whole body. It reaches gh as `body=@<file>`, never as argv text. */
export function writeSource({ repo, src, body, gh }) {
  withBodyFile(body, (file) => {
    if (inDiscussion(src)) graphql(gh, ['-f', `query=${UPDATE_DISCUSSION_COMMENT}`, '-f', `id=${src.nodeId}`, '-F', `body=@${file}`]);
    else if (src.kind !== 'discussion') run(gh, ['api', '-X', 'PATCH', restPath(repo, src), '-F', `body=@${file}`]);
    else graphql(gh, ['-f', `query=${UPDATE_DISCUSSION}`, '-f', `id=${readSource({ repo, src, gh }).id}`, '-F', `body=@${file}`]);
  });
}

/** A new comment by the signed-in account on `parent` ({ kind: 'issue' | 'discussion', number }) → it as a source. */
export function createComment({ repo, parent, body, gh }) {
  const src = withBodyFile(body, (file) => {
    if (parent.kind === 'issue') return { id: run(gh, ['api', '-X', 'POST', `repos/${repo}/issues/${parent.number}/comments`, '-F', `body=@${file}`]).id };
    const id = readSource({ repo, src: parent, gh }).id;
    const c = graphql(gh, ['-f', `query=${ADD_DISCUSSION_COMMENT}`, '-f', `id=${id}`, '-F', `body=@${file}`])?.addDiscussionComment?.comment;
    return { id: c?.databaseId, nodeId: c?.id };
  });
  // The id names the batch's state directory: never trust it to be a number.
  if (!Number.isSafeInteger(src.id) || src.id < 1) throw new GithubUnavailable(`unexpected comment id ${JSON.stringify(src.id)}`);
  return { kind: 'comment', id: src.id, parent, ...(src.nodeId && { nodeId: src.nodeId }) };
}

/** 'issue' | 'discussion' | 'pull-request' | null for number N. gh exits 1 when one lookup is NOT_FOUND; the other answers. */
export function sourceKind({ repo, number, gh }) {
  const r = gh(['api', 'graphql', '-f', `query=${SOURCE_KIND}`, ...repoVars(repo), '-F', `number=${number}`]);
  let res = null;
  try { res = JSON.parse(r.stdout); } catch { /* below */ }
  if (!res?.data || res.errors?.some((e) => e.type !== 'NOT_FOUND')) throw new GithubUnavailable(`gh api graphql exited ${r.code}: ${String(r.stderr).trim()}`);
  const kind = res.data.repository?.issueOrPullRequest?.__typename;
  return kind === 'Issue' ? 'issue' : kind === 'PullRequest' ? 'pull-request' : res.data.repository?.discussion ? 'discussion' : null;
}

/** The node id of discussion #number's comment with database id `id`, paging its comments; null when absent. */
export function discussionCommentNode({ repo, number, id, gh }) {
  for (let after = null; ;) {
    const page = graphql(gh, ['-f', `query=${DISCUSSION_COMMENTS}`, ...repoVars(repo), '-F', `number=${number}`, ...(after ? ['-f', `after=${after}`] : [])])
      ?.repository?.discussion?.comments;
    if (!page) throw new GithubUnavailable(`discussion #${number} not found`);
    const hit = page.nodes.find((n) => n.databaseId === id);
    if (hit) return hit.id;
    if (!page.pageInfo.hasNextPage) return null;
    after = page.pageInfo.endCursor;
  }
}

/** raw = { repo, repository: { issue_<N>: node }, extra: { <N>: REST comments } }; throws GithubUnavailable. */
export function fetchFacts({ repo, issues, gh }) {
  const { query, variables } = factsQuery(repo, issues);
  const res = run(gh, ['api', 'graphql', '-f', `query=${query}`, ...Object.entries(variables).flatMap(([k, v]) => ['-f', `${k}=${v}`])]);
  if (res.errors?.length || !res.data?.repository) throw new GithubUnavailable(`GraphQL error: ${JSON.stringify(res.errors ?? 'no data').slice(0, 300)}`);
  const extra = {};
  for (const n of issues) {
    const node = res.data.repository[`issue_${n}`];
    if (!node) throw new GithubUnavailable(`issue #${n} not found`);
    // shortcut: a full REST re-read replaces the GraphQL page when it overflowed; fine until comment counts need streaming.
    if (node.comments.totalCount > 100) extra[n] = run(gh, ['api', '--paginate', '--slurp', `repos/${repo}/issues/${n}/comments`]).flat();
  }
  return { repo, repository: res.data.repository, extra };
}

const time = (x) => String(x ?? '');
const newest = (times) => times.filter(Boolean).reduce((a, b) => (b > a ? b : a), '') || null;
const firstLine = (body) => String(body ?? '').split(/\r\n|\n|\r/)[0].trim();
const isTrusted = (c, login) => TRUSTED.has(c.association) || c.author === login;
const byTime = (a, b) => (time(a.createdAt) < time(b.createdAt) ? -1 : time(a.createdAt) > time(b.createdAt) ? 1 : 0);

const normalizeGql = (c) => ({ id: c.databaseId, author: c.author?.login ?? '', association: c.authorAssociation, createdAt: c.createdAt, body: c.body ?? '', url: c.url });
const normalizeRest = (c) => ({ id: c.id, author: c.user?.login ?? '', association: c.author_association, createdAt: c.created_at, body: c.body ?? '', url: c.html_url });

// The first `/goal ` line in the fenced block under **Goal prompt** in the AUTO region's `## Execution` section.
function goalLine(body) {
  const { regions, problems } = findAutoRegions(body);
  if (problems.length || regions.length !== 1) return null;
  const rows = body.slice(regions[0].contentStart, regions[0].contentEnd).split(/\r\n|\n|\r/);
  let state = 'seek-section';
  for (const row of rows) {
    const t = row.trim();
    if (state === 'seek-section') { if (t === '## Execution') state = 'seek-goal'; continue; }
    if (state === 'seek-goal') {
      if (/^#{1,2} /.test(t)) return null;
      if (t.startsWith('**Goal prompt**')) state = 'seek-fence';
    } else if (state === 'seek-fence') {
      if (/^#{1,2} /.test(t)) return null;
      if (t.startsWith('```')) state = 'in-fence';
    } else if (t.startsWith('```')) return null;
    else if (t.startsWith('/goal ')) return t;
  }
  return null;
}

const REPORT = /^<!-- dev-review-pr: \S+ round=(\d+) phase=([a-z-]+) -->$/;
const REVIEW_PHASES = new Set(['review', 'closing-review', 'final-review']);

function prFacts(pr, login) {
  const comments = pr.comments.nodes;
  const reviews = pr.reviews.nodes;
  const head = pr.commits.nodes[0]?.commit?.committedDate ?? null;
  const reports = comments
    .filter((c) => isTrusted({ association: c.authorAssociation, author: c.author?.login }, login) && REPORT.test(firstLine(c.body)))
    .sort(byTime);
  const latest = reports.at(-1);
  const latestReview = reports.filter((c) => REVIEW_PHASES.has(firstLine(c.body).match(REPORT)[2])).at(-1);
  const unfenced = (latestReview?.body ?? '').replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  const rollup = pr.statusCheckRollup?.state;
  const marker = latest ? firstLine(latest.body).match(REPORT) : null;
  return {
    number: pr.number, state: pr.state, merged: pr.merged, head: pr.headRefOid,
    checks: !rollup ? 'none' : rollup === 'PENDING' || rollup === 'EXPECTED' ? 'pending' : 'done',
    evidence: reviewEvidence({ headRefOid: pr.headRefOid, comments, reviews }),
    round: marker ? Number(marker[1]) : null,
    phase: marker ? marker[2] : null,
    reviewEnded: unfenced.match(/^Verdict:\s*(blocked|budget-exhausted)\b/m)?.[1] ?? null,
    lastActivity: newest([...comments.map((c) => c.createdAt), ...reviews.map((r) => r.submittedAt), head]),
  };
}

/** IssueFacts for one issue of `raw`. `sessions` are the row's session records, `pr` the PR its ledger row names. */
export function issueFacts(raw, issue, { repo, login, sessions = [], pr: rowPr = null }) {
  const node = raw.repository[`issue_${issue}`];
  const rest = raw.extra?.[issue];
  const comments = rest ? rest.map(normalizeRest) : node.comments.nodes.map(normalizeGql);
  const task = selectTask({
    repo, issue, login, scanComplete: comments.length >= node.comments.totalCount, issueBody: node.body ?? '',
    comments: comments.map(({ id, author, body }) => ({ id, author, body })),
  });

  const mine = comments.filter((c) => isTrusted(c, login)).sort(byTime);
  const vRe = new RegExp(`^<!-- dev-batch:verdict issue=${issue} revision=(\\d+) state=(ready|owner|not-ready) -->$`);
  const v = mine.filter((c) => vRe.test(firstLine(c.body))).at(-1);
  const vm = v && firstLine(v.body).match(vRe);
  const verdict = vm ? { revision: Number(vm[1]), state: vm[2], at: v.createdAt } : null;

  const q = mine.filter((c) => firstLine(c.body) === `<!-- dev-batch:owner issue=${issue} -->`).at(-1);
  const ownerQuestion = q ? { url: q.url, at: q.createdAt } : null;
  // §11: after the question, no agent marker, posted while no session of the row ran (an open window has to: null).
  const during = (t) => sessions.some(({ startedAt: from, endedAt: to }) => Date.parse(t) >= Date.parse(from) && (!to || Date.parse(t) <= Date.parse(to)));
  const a = q && mine.find((c) => time(c.createdAt) > time(q.createdAt) && !/<!-- dev-[a-z-]+/.test(c.body) && !during(c.createdAt));
  const ownerAnswer = a ? { at: a.createdAt } : null;

  // C1: the task's own PR, by the signed-in login into this repository. The row's PR stays unless it was closed
  // unmerged, or it only mentions the issue and a closing PR now exists; otherwise a closing PR, else a cross-reference
  // that will close the issue or came after the implement session started. A PR merged before the row's first launch
  // is never this batch's work.
  const since = (list) => list.map((x) => x.startedAt).filter(Boolean).sort()[0] ?? null;
  const after = (t, from) => !!from && Date.parse(t) >= Date.parse(from);
  const ours = (p) => !!p?.number && p.author?.login === login && p.baseRepository?.nameWithOwner?.toLowerCase() === repo.toLowerCase();
  const live = (p) => p.state === 'OPEN' || (p.merged && after(p.mergedAt, since(sessions)));
  const closing = node.closedByPullRequestsReferences.nodes.filter((p) => ours(p) && live(p));
  const refs = node.timelineItems.nodes.filter(({ source: p, willCloseTarget }) => ours(p) && live(p)
    && ((p.state === 'OPEN' && willCloseTarget) || after(p.createdAt, since(sessions.filter((x) => x.stage === 'implement'))))).map((t) => t.source);
  const kept = rowPr && [...node.closedByPullRequestsReferences.nodes, ...(closing.length ? [] : node.timelineItems.nodes.map((t) => t.source))]
    .find((p) => ours(p) && p.number === rowPr && p.state !== 'CLOSED');
  const best = kept || (closing.length ? closing : refs).sort((x, y) => y.number - x.number)[0];
  const pr = best ? prFacts(best, login) : null;

  // I3 (§11): the /goal line runs with permission mode auto, so it counts only from a body last written by a trusted
  // hand (a trusted author, or a last editor who is the signed-in login or trusted here), and only when it names the
  // current task comment, as dev-refine-issue writes it ("/goal Execute from <permalink>. …").
  const trusted = new Set(comments.filter((c) => TRUSTED.has(c.association)).map((c) => c.author)).add(login);
  const taskUrl = task.action === 'use-current' && `https://github.com/${repo}/issues/${issue}#issuecomment-${task.commentId}`;
  const line = taskUrl && (TRUSTED.has(node.authorAssociation) || trusted.has(node.editor?.login)) ? goalLine(node.body ?? '') : null;
  const goal = line && [...line.matchAll(/https:\/\/github\.com\/\S+?#issuecomment-\d+/g)].some((m) => m[0] === taskUrl) ? line : null;

  return {
    task, goal, verdict, ownerQuestion, ownerAnswer, pr,
    lastActivity: newest([...comments.map((c) => c.createdAt), pr?.lastActivity]),
  };
}
