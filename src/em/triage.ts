import { execFile } from 'node:child_process';
import type { ClaudeRunner } from '../analyzer.ts';
import { readTranscript } from '../transcript.ts';
import type { Agent } from '../types.ts';

export type BlockedTriage =
  | { decision: 'answer'; answer: string; citation: string }
  | { decision: 'escalate'; reason: string };

export interface FastFollow {
  title: string;
  body: string;
}

// Same flags as the analyzer's runner, for the same reasons:
//   --safe-mode              disables customizations INCLUDING hooks, so these
//                            background calls do not fire Will's Stop hook.
//   --no-session-persistence keeps the EM's own calls out of Loom's index.
// Unlike the analyzer's runner, cwd is the session's project dir so the model can
// read that repo's conventions. --safe-mode may suppress auto-loaded CLAUDE.md,
// so the prompts below tell it to open those files itself rather than assume.
export function makeRunner(cwd: string): ClaudeRunner {
  return (prompt: string) =>
    new Promise((resolve, reject) => {
      execFile(
        'claude',
        ['-p', '--safe-mode', '--no-session-persistence', prompt],
        { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 180_000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
}

// Recent conversation text for prompt context, bounded so cost does not scale
// with transcript size.
export function transcriptTail(agent: Agent, jsonlPath: string, turns = 12, cap = 12_000): string {
  const msgs = readTranscript(agent, jsonlPath, { limit: turns });
  const text = msgs.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
  return text.length <= cap ? text : text.slice(-cap);
}

// The final assistant turn — for a session in waiting_on_user, this IS the
// question being asked. Passing the whole tail as "the question" would leave the
// triage model guessing which of several turns it is meant to answer.
export function lastAssistantText(agent: Agent, jsonlPath: string): string {
  const msgs = readTranscript(agent, jsonlPath, { limit: 40 });
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].text.trim()) return msgs[i].text.trim();
  }
  return '';
}

function extractJson(raw: string): any | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function buildBlockedPrompt(question: string, projectDir: string, recent: string): string {
  return [
    'You are an engineering manager standing in for the repo owner, who is away.',
    `A coding session in ${projectDir} is blocked, waiting on an answer.`,
    '',
    'Decide whether you can answer it ON HIS BEHALF, or whether it genuinely needs him.',
    '',
    'You MAY answer only when the answer is DERIVABLE from this repo — read the files',
    'yourself to check: AGENTS.md, CLAUDE.md, docs/README.md and the docs it indexes,',
    'and the surrounding source. Typical answerable questions: which convention or',
    'pattern applies, where a thing belongs, whether something already exists, what',
    'the established naming is.',
    '',
    'You MUST escalate when the question calls for product judgment, picks between',
    'options with no documented default, or touches anything irreversible, external-',
    'facing, or costly (production, money, published artifacts, deletions).',
    '',
    'If you are unsure, ESCALATE. A wrong answer silently steers the work and is far',
    'more expensive than a delayed one.',
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences.',
    'Either: {"decision":"answer","answer":"<what to tell the session>","citation":"<file(s) the answer came from>"}',
    'Or:     {"decision":"escalate","reason":"<one sentence on why this needs him>"}',
    '',
    'An "answer" MUST carry a non-empty citation naming the file(s) you derived it',
    'from. If you cannot cite one, that means you did not derive it — escalate.',
    '',
    'The question:',
    '"""',
    question,
    '"""',
    '',
    'Recent conversation, for context:',
    '"""',
    recent,
    '"""',
  ].join('\n');
}

export function parseBlockedTriage(raw: string): BlockedTriage {
  const obj = extractJson(raw);
  // Every failure path lands on escalate: uncertainty must never auto-send.
  if (!obj) return { decision: 'escalate', reason: 'triage response was unparseable' };
  if (obj.decision === 'answer') {
    const answer = typeof obj.answer === 'string' ? obj.answer.trim() : '';
    const citation = typeof obj.citation === 'string' ? obj.citation.trim() : '';
    if (!answer) return { decision: 'escalate', reason: 'triage returned an empty answer' };
    if (!citation) return { decision: 'escalate', reason: 'triage answered without citing a source' };
    return { decision: 'answer', answer, citation };
  }
  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : 'needs a human decision';
  return { decision: 'escalate', reason };
}

export function buildFastFollowPrompt(transcript: string): string {
  return [
    'A coding session has finished its work. Extract the FAST-FOLLOWS it left behind:',
    'things explicitly deferred, noted as out of scope, flagged as needing a later fix,',
    'or acknowledged as unverified. These become GitHub issues so nothing is lost when',
    'the session closes.',
    '',
    'Do NOT invent work. Do NOT include what the session actually completed. Do NOT',
    'include generic advice ("add more tests") that the session did not itself raise.',
    'If it genuinely left nothing outstanding, return an empty list — that is a normal',
    'and expected result.',
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences:',
    '{"fast_follows":[{"title":"<= 10 words, imperative","body":"what and why, plus any file or error named in the session"}]}',
    '',
    'Transcript:',
    '"""',
    transcript,
    '"""',
  ].join('\n');
}

export function parseFastFollows(raw: string): FastFollow[] {
  const obj = extractJson(raw);
  if (!obj || !Array.isArray(obj.fast_follows)) return [];
  return obj.fast_follows
    .filter((f: any) => f && typeof f.title === 'string' && f.title.trim())
    .map((f: any) => ({ title: String(f.title).trim(), body: typeof f.body === 'string' ? f.body.trim() : '' }));
}

export function buildHandoffPrompt(transcript: string): string {
  return [
    'A coding session has nearly filled its context window and is about to be restarted',
    'fresh. Write the handoff brief that its replacement will receive as its first message.',
    '',
    'Cover, in this order: the original goal; what has already been done (naming the',
    'files); what is left; and any decision or constraint the replacement would',
    'otherwise re-litigate or violate.',
    '',
    'Write it as a direct instruction to the replacement session. Be specific and',
    'concrete — it starts with no memory whatsoever of this work.',
    '',
    'Respond with the brief itself and nothing else: no JSON, no preamble, no fences.',
    '',
    'Transcript:',
    '"""',
    transcript,
    '"""',
  ].join('\n');
}
