// GitHub facts per task (§9): one GraphQL query per tick, turned into the per-issue facts `advance` reads.
// Reuses selectTask (refine) and reviewEvidence (merge); GitHub text is data and never reaches a command line
// except as a GraphQL variable.
import { findAutoRegions, selectTask } from '../../dev-refine-issue/scripts/check-refinement.mjs';
import { reviewEvidence } from '../../dev-merge/scripts/check-merge.mjs';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// A failed `gh` call or a GraphQL error throws this; the loop turns it into one `github-unavailable` event
// and retries next tick. No partial facts are ever returned.
export class GithubUnavailable extends Error {}

const PR_FIELDS = `fragment pr on PullRequest {
  number state merged headRefOid author { login }
  commits(last: 1) { nodes { commit { committedDate } } }
  statusCheckRollup { state }
  comments(last: 100) { nodes { body authorAssociation createdAt url author { login } } }
  reviews(last: 50) { nodes { state submittedAt authorAssociation url author { login } commit { oid } } }
}`;

const ISSUE_FIELDS = `body
  comments(last: 100) { totalCount nodes { databaseId body authorAssociation createdAt url author { login } } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { ...pr } }
  timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 20) { nodes { ... on CrossReferencedEvent { source { ... on PullRequest { ...pr } } } } }`;

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

/** IssueFacts for one issue of `raw`. `rounds` is accepted for the caller's settings and unused here. */
export function issueFacts(raw, issue, { repo, login, sessionWindows = [] }) {
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
  const during = (t) => sessionWindows.some(({ from, to }) => Date.parse(t) >= Date.parse(from) && (!to || Date.parse(t) <= Date.parse(to)));
  const a = q && mine.find((c) => time(c.createdAt) > time(q.createdAt) && !/<!-- dev-[a-z-]+/.test(c.body) && !during(c.createdAt));
  const ownerAnswer = a ? { at: a.createdAt } : null;

  const prs = new Map();
  for (const n of [...node.closedByPullRequestsReferences.nodes, ...node.timelineItems.nodes.map((t) => t.source)]) {
    if (n?.number && n.author?.login === login && (n.state === 'OPEN' || n.merged)) prs.set(n.number, n);
  }
  const best = [...prs.values()].sort((x, y) => y.number - x.number)[0];
  const pr = best ? prFacts(best, login) : null;

  return {
    task, goal: goalLine(node.body ?? ''), verdict, ownerQuestion, ownerAnswer, pr,
    lastActivity: newest([...comments.map((c) => c.createdAt), pr?.lastActivity]),
  };
}
