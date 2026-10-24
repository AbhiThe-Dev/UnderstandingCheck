import { stemmer } from 'stemmer';

const STOPWORDS = new Set(
  `a an the and or but if then else of to in on at by for with from into onto about as is are was were be been
  being it its this that these those there here we i you he she they them us our your their my me him her
  do does did done doing have has had having will would should could can may might must shall just so very
  really also too not no yes yeah ok okay sure all any some each every other another than such only own same
  what which who whom whose when where why how up down out over under again further once more most less
  get got gets make makes made go goes going went thing things stuff way like well right now think know
  want need needs let lets i'll we'll i'm it's that's don't doesn't didn't won't can't shouldn't wouldn't
  isn't aren't wasn't weren't let's gonna wanna kind sort bit lot actually basically probably maybe`
    .split(/\s+/)
    .filter(Boolean),
);

/** Domain-generic words that appear everywhere and carry little retrieval signal. */
const GENERIC = new Set(
  ['user', 'system', 'feature', 'code', 'app', 'data', 'thing', 'time', 'team', 'work', 'page', 'button', 'today', 'yesterday', 'tomorrow', 'week', 'day', 'call', 'meet', 'idea', 'plan', 'part', 'case', 'one', 'two', 'new', 'old', 'existing', 'current', 'good', 'great', 'fine', 'sound'].map(
    (w) => stemmer(w),
  ),
);

/** Small synonym table so common shorthand reaches the same stems as code identifiers. */
const SYNONYMS: Record<string, string[]> = {
  auth: ['authent'],
  login: ['authent', 'login'],
  signin: ['authent'],
  log: [],
  admin: ['admin'],
  admins: ['admin'],
  perms: ['permiss'],
};

export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function words(text: string): string[] {
  const out: string[] = [];
  for (const tok of text.match(/[A-Za-z][A-Za-z0-9']*/g) ?? []) {
    // "sendReceipt" mentioned in a meeting should reach the same terms as the identifier.
    if (/[a-z][A-Z]/.test(tok)) out.push(...splitIdentifier(tok));
    else out.push(tok.toLowerCase().replace(/'s$/, ''));
  }
  return out;
}

export function stem(word: string): string {
  return stemmer(word.toLowerCase());
}

/** Content terms: lowercased, stopwords removed, stemmed, synonyms expanded. */
export function contentTerms(text: string, opts: { keepGeneric?: boolean } = {}): string[] {
  const out = new Set<string>();
  for (const w of words(text)) {
    if (STOPWORDS.has(w) || w.length < 3) continue;
    const syn = SYNONYMS[w];
    if (syn) {
      syn.forEach((s) => out.add(s));
      continue;
    }
    const s = stem(w);
    if (!opts.keepGeneric && GENERIC.has(s)) continue;
    out.add(s);
  }
  return [...out];
}

/** Distinct non-stopword words in order of first use, unstemmed (for keyword search outside the index). */
export function keywords(text: string, max = 8): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    if (STOPWORDS.has(w) || w.length < 3 || GENERIC.has(stem(w)) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

export function identifierTerms(id: string): string[] {
  return splitIdentifier(id)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
    .map(stem);
}

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `quote` appears (after normalization) inside `source`. */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const q = normalizeForMatch(quote);
  return q.length > 0 && normalizeForMatch(source).includes(q);
}

// ---------- Discourse markers ----------

const AGREEMENT_RE =
  /^\s*(yes|yeah|yep|yup|sure|ok|okay|agreed|i agree|sounds good|sounds great|sounds right|got it|makes sense|perfect|great|works for me|that works|fine|exactly|definitely|absolutely|correct|right|cool|love it|let's do (it|that)|go for it|ship it|deal)\b/i;
const DISAGREEMENT_RE =
  /\b(i disagree|i don't think (so|that|we)|that's not (right|what)|we don't need|we do not need|we shouldn't|we should not|no need (for|to)|not necessary|i'd rather not|let's not|i don't want|that won't work|that doesn't work)\b|^\s*no\b/i;
const PROPOSAL_RE =
  /\b(i'll|we'll|i will|we will|i'm going to|we're going to|let's|i can|we can|we could|i could|my plan is|the plan is|i'd|i would|we'd)\b/i;
const IMPLEMENTATION_VERB_RE =
  /\b(set|sets|setting|change|changing|update|updating|flip|flipping|reset|revert|reverting|reuse|re-use|use|using|call|calling|add|adding|remove|removing|delete|deleting|mark|marking|toggle|move|moving|store|save|wire|hook|implement|build|put|create|write|switch|keep)\b/i;
const REQUIREMENT_RE =
  /\b(should|must|needs? to|need a way|has to|have to|we want|i want|want to|allow|let (admins?|administrators?|users?|agents?|people|customers?)|ability to|able to|requirement|support for|is required)\b/i;
const CORRECTION_RE = /\b(actually|wait|correction|i mean|to clarify|on second thought|change of plan|scratch that|let me rephrase|thinking about it more)\b/i;
const REVERSAL_RE =
  /\b(undo|undoes|undoing|undone|revert|reverts|reverting|reverse|reverses|reversing|roll ?back|rolls back|rolling back|cancel|cancels|cancelling|canceling|un-?approve|retract|rescind|back to)\b/i;
const REUSE_RE =
  /\b(reuse|re-use|reusing|use the existing|use our existing|using the existing|leverage the existing|leverage our|piggyback on|plug into the existing|just call the existing|call the existing|go through the existing|use the same)\b\s*(.*)$/i;
const NEGATION_RE = /\b(no|not|don't|do not|doesn't|does not|never|without|shouldn't|should not|won't|can't|cannot|no need|skip|drop|nothing)\b/i;

export type Marker =
  | 'agreement'
  | 'disagreement'
  | 'proposal'
  | 'implementation'
  | 'requirement'
  | 'question'
  | 'correction'
  | 'reversal'
  | 'reuse';

export function markers(text: string): Set<Marker> {
  const m = new Set<Marker>();
  const t = text.trim();
  if (AGREEMENT_RE.test(t) && !/\bbut\b/i.test(t.slice(0, 40))) m.add('agreement');
  if (DISAGREEMENT_RE.test(t)) m.add('disagreement');
  if (PROPOSAL_RE.test(t)) m.add('proposal');
  if (IMPLEMENTATION_VERB_RE.test(t)) m.add('implementation');
  if (REQUIREMENT_RE.test(t)) m.add('requirement');
  if (/\?\s*$/.test(t)) m.add('question');
  if (CORRECTION_RE.test(t)) m.add('correction');
  if (REVERSAL_RE.test(t)) m.add('reversal');
  if (REUSE_RE.test(t)) m.add('reuse');
  return m;
}

export function reversalWord(text: string): string | null {
  const m = text.match(REVERSAL_RE);
  return m ? m[1]!.toLowerCase() : null;
}

/** The phrase after a reuse marker, e.g. "authentication system for partner logins". */
export function reuseTarget(text: string): string | null {
  const m = text.match(REUSE_RE);
  return m ? (m[2] ?? '').trim() : null;
}

/** "for partner logins" → "partner logins" (the purpose the reused code will serve). */
export function purposePhrase(text: string): string | null {
  const m = text.match(/\bfor (the )?([a-z][a-z0-9 -]{2,40}?)(?:[.,!?]|$| so | because | and )/i);
  return m ? m[2]!.trim() : null;
}

export function isNegated(text: string): boolean {
  return NEGATION_RE.test(text);
}

/** True when the utterance is little more than an agreement token ("Sounds good."). */
export function isBareAgreement(text: string): boolean {
  if (!AGREEMENT_RE.test(text)) return false;
  const rest = contentTerms(text.replace(AGREEMENT_RE, ''));
  return rest.length <= 2;
}

export function leadingYesNo(text: string): 'yes' | 'no' | null {
  const t = text.trim().toLowerCase();
  if (/^(yes|yeah|yep|yup|sure|correct|of course|definitely|absolutely)\b/.test(t)) return 'yes';
  if (/^(no|nope|nah|not really|definitely not|absolutely not)\b/.test(t)) return 'no';
  return null;
}

// ---------- English helpers for question templates ----------

export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

const IRREGULAR_PAST: Record<string, string> = {
  send: 'sent',
  pay: 'paid',
  make: 'made',
  set: 'set',
  put: 'put',
  run: 'ran',
  issue: 'issued',
};

export function pastTense(verb: string): string {
  const v = verb.toLowerCase();
  if (IRREGULAR_PAST[v]) return IRREGULAR_PAST[v];
  if (v.endsWith('e')) return `${v}d`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ied`;
  return `${v}ed`;
}

export function thirdPerson(verb: string): string {
  const v = verb.toLowerCase();
  if (/(s|sh|ch|x|z|o)$/.test(v)) return `${v}es`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ies`;
  return `${v}s`;
}

const REVERSAL_PRESENT: Record<string, string> = {
  undo: 'undoes',
  undoes: 'undoes',
  undoing: 'undoes',
  undone: 'undoes',
  revert: 'reverts',
  reverts: 'reverts',
  reverting: 'reverts',
  reverse: 'reverses',
  reverses: 'reverses',
  reversing: 'reverses',
  rollback: 'rolls back',
  'roll back': 'rolls back',
  'rolls back': 'rolls back',
  'rolling back': 'rolls back',
  cancel: 'cancels',
  cancels: 'cancels',
  cancelling: 'cancels',
  canceling: 'cancels',
  unapprove: 'reverses',
  'un-approve': 'reverses',
  retract: 'retracts',
  rescind: 'rescinds',
  'back to': 'reverts',
};

const REVERSAL_PARTICIPLE: Record<string, string> = {
  undoes: 'undone',
  reverts: 'reverted',
  reverses: 'reversed',
  'rolls back': 'rolled back',
  cancels: 'cancelled',
  retracts: 'retracted',
  rescinds: 'rescinded',
};

export function reversalPresent(word: string | null): string {
  return (word && REVERSAL_PRESENT[word]) || 'reverses';
}

const REVERSAL_GERUND: Record<string, string> = {
  undoes: 'Undoing',
  reverts: 'Reverting',
  reverses: 'Reversing',
  'rolls back': 'Rolling back',
  cancels: 'Cancelling',
  retracts: 'Retracting',
  rescinds: 'Rescinding',
};

export function reversalGerund(word: string | null): string {
  return REVERSAL_GERUND[reversalPresent(word)] ?? 'Reversing';
}

export function reversalParticiple(word: string | null): string {
  return REVERSAL_PARTICIPLE[reversalPresent(word)] ?? 'reversed';
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
