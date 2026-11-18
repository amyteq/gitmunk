// Session names and launch prompts (spec §9, §11). Pure functions.

const SUFFIX = { refine: (n) => `i${n}r`, implement: (n) => `i${n}a`, review: (_, m) => `pr${m}`, merge: (_, m) => `pr${m}m` };
const tail = (attempt) => (attempt > 1 ? String(attempt) : '');

export function sessionName({ abbr, stage, issue, pr, attempt = 1 }) {
  if (!SUFFIX[stage]) throw new Error(`unknown stage: ${stage}`);
  return `${abbr}-${SUFFIX[stage](issue, pr)}${tail(attempt)}`;
}

/** A comment source is named after its parent issue or discussion (src.parent). */
export function coordinatorName({ abbr, src, k = 1 }) {
  const s = src.kind === 'comment' ? src.parent : src;
  if (!s) throw new Error('a comment source needs a parent');
  return `${abbr}-${s.kind === 'discussion' ? 'd' : 'i'}${s.number}c${k > 1 ? k : ''}`;
}

export function nextFreeName(base, takenNames) {
  let name = base;
  for (let n = 2; takenNames.has(name); n++) name = `${base}${n}`;
  return name;
}

export const DECISION_POLICY =
  'Decision policy: for a decision that can be reversed and stays inside the issue\'s scope, take the recommended option, record it on the issue as "default in use until the owner changes it", and continue. Stop with state=owner for a decision that deletes data, spends money, touches security or credentials, deploys, or widens the scope.';

export function stagePrompt({ stage, issue, pr, goal, settings = {}, authorization, ledgerUrl }) {
  switch (stage) {
    case 'refine': return `/dev-refine-issue ${issue}\n\n${DECISION_POLICY}`;
    case 'implement':
      if (typeof goal !== 'string' || !goal.startsWith('/goal ')) throw new Error('the issue has no /goal line to launch');
      return goal;
    case 'review': return `/dev-review-pr pr=${pr} ${settings.rounds} ${settings.reviewer} ${settings.writer}`;
    case 'merge':
      return `/dev-merge pr=${pr} issues=${issue} cleanup=own -- Squash merge PR #${pr} under the owner authorization quoted here: "${authorization}" (${ledgerUrl}). Leave the dev-batch ledger region between its markers unchanged; the batch loop updates it.`;
    default: throw new Error(`unknown stage: ${stage}`);
  }
}

export function appendedScope({ stage, issue, settings = {}, authorization, extra, coordinator = false }) {
  const parts = [];
  if (authorization) parts.push(`Owner authorization, quoted verbatim: "${authorization}". It covers every action of this stage and no other.`);
  else parts.push('No owner authorization is recorded: take no action that needs one.');
  parts.push(DECISION_POLICY);
  parts.push(coordinator
    ? 'Never block on an owner question: post it on the source and keep waiting on events.'
    : `To ask the owner a question, post it on the issue with the first line <!-- dev-batch:owner issue=${issue} --> and end your session; do not wait for an answer.`);
  if (stage === 'refine') parts.push(`As your last step post exactly one verdict comment whose first line is <!-- dev-batch:verdict issue=${issue} revision=<R> state=ready|owner|not-ready --> (R is the revision of the task comment you refined), followed by one plain sentence.`);
  if (stage === 'review') {
    const c = (k) => [settings[`${k}_model`] && `model ${settings[`${k}_model`]}`, settings[`${k}_effort`] && `effort ${settings[`${k}_effort`]}`].filter(Boolean).join(', ') || 'the CLI defaults';
    parts.push(`The owner's choice for the review phases: reviewer ${settings.reviewer}: ${c('reviewer')}; writer ${settings.writer}: ${c('writer')}.`);
  }
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}
