import type { Effect, EffectCategory } from './types';
import { splitIdentifier, stem, thirdPerson } from './text';

/**
 * Generic vocabulary that maps identifier words to side-effect categories.
 * Ordered by consequence: the first matching category wins.
 */
const CATEGORY_WORDS: [EffectCategory, string[]][] = [
  ['permission', ['grant', 'revoke', 'permission', 'permissions', 'role', 'roles', 'access', 'admin', 'privilege', 'privileges', 'authorize', 'elevate', 'entitle', 'entitlement', 'session', 'token', 'acl']],
  ['financial', ['charge', 'refund', 'pay', 'payment', 'payout', 'invoice', 'credit', 'debit', 'transfer', 'billing', 'bill', 'ledger', 'price', 'subscription', 'wallet', 'balance']],
  ['irreversible', ['delete', 'destroy', 'purge', 'drop', 'erase', 'wipe', 'terminate', 'deactivate', 'ban']],
  ['external', ['send', 'email', 'mail', 'notify', 'notification', 'webhook', 'publish', 'post', 'sms', 'slack', 'enqueue', 'emit', 'dispatch', 'push', 'broadcast', 'track']],
  ['data', ['update', 'save', 'insert', 'create', 'set', 'write', 'persist', 'increment', 'record', 'store', 'upsert', 'mark', 'assign', 'audit']],
];

/** Calls that are never interesting side effects. */
const IGNORED_CALLEES = new Set([
  'log', 'warn', 'error', 'info', 'debug', 'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every',
  'includes', 'indexOf', 'slice', 'splice', 'concat', 'join', 'split', 'trim', 'toString', 'toLowerCase',
  'toUpperCase', 'parse', 'stringify', 'keys', 'values', 'entries', 'assign', 'freeze', 'now', 'resolve',
  'reject', 'then', 'catch', 'finally', 'require', 'expect', 'toBe', 'toEqual', 'describe', 'it', 'test',
  'beforeEach', 'afterEach', 'toHaveBeenCalled', 'toHaveBeenCalledWith', 'fn', 'push', 'pop', 'shift',
  'has', 'get', 'add', 'Error', 'Date', 'String', 'Number', 'Boolean', 'Array', 'Promise', 'Math',
  // Bare collection methods (Map/Set) are bookkeeping, not business side effects.
  'set', 'delete', 'clear',
]);

/** Assigned properties that are bookkeeping, not business state. */
const IGNORED_ASSIGN_TARGETS = new Set(['updatedAt', 'modifiedAt', 'length', 'id']);

export const CONSEQUENCE_WEIGHT: Record<EffectCategory | 'business_rule', number> = {
  permission: 1.0,
  financial: 1.0,
  irreversible: 0.9,
  business_rule: 0.7,
  external: 0.6,
  data: 0.4,
};

/** Leading verbs that read or compute rather than change state. */
const READ_VERBS = new Set([
  'find', 'get', 'fetch', 'load', 'read', 'lookup', 'query', 'list', 'is', 'has', 'can', 'check', 'verify',
  'validate', 'compute', 'calculate', 'format', 'build', 'to', 'parse', 'render', 'should', 'ensure', 'assert',
  'select', 'count', 'search', 'resolve', 'hash', 'compare', 'normalize', 'map',
]);

/** Persistence verbs: `saveInvoice` stores a record, it does not move money. */
const PERSIST_VERBS = new Set(['save', 'update', 'insert', 'write', 'persist', 'store', 'upsert', 'record', 'audit']);

export function classifyCall(callee: string): EffectCategory | null {
  if (IGNORED_CALLEES.has(callee)) return null;
  const parts = splitIdentifier(callee);
  if (parts.length > 0 && READ_VERBS.has(parts[0]!)) return null;
  for (const [category, vocab] of CATEGORY_WORDS) {
    if (!parts.some((p) => vocab.includes(p))) continue;
    // Persisting a financial/external record is a data write; permission changes stay permission changes.
    if (PERSIST_VERBS.has(parts[0]!) && (category === 'financial' || category === 'external')) return 'data';
    return category;
  }
  return null;
}

export function classifyAssignment(property: string): EffectCategory | null {
  if (IGNORED_ASSIGN_TARGETS.has(property)) return null;
  const parts = splitIdentifier(property);
  for (const [category, vocab] of CATEGORY_WORDS.slice(0, 3)) {
    if (parts.some((p) => vocab.includes(p))) return category;
  }
  return 'data';
}

export function rankCategory(c: EffectCategory): number {
  return CONSEQUENCE_WEIGHT[c];
}

const LEADING_VERBS = new Set([
  'grant', 'revoke', 'issue', 'send', 'create', 'add', 'set', 'notify', 'charge', 'post', 'record', 'update',
  'mark', 'emit', 'publish', 'enqueue', 'insert', 'save', 'write', 'delete', 'remove', 'apply', 'assign', 'give',
  'elevate', 'email', 'track', 'push', 'dispatch', 'start', 'open', 'log', 'make', 'register', 'trigger',
]);

/**
 * Function names are conventionally verbObject: `grantAccess` → { verb: "grant", object: "access" },
 * `postToAccountingWebhook` → { verb: "post", object: "accounting webhook", preposition: "to" }.
 */
export function humanizeCallee(name: string): { verb: string | null; object: string; preposition: string | null } {
  const parts = splitIdentifier(name);
  if (parts.length > 1 || LEADING_VERBS.has(parts[0] ?? '')) {
    const rest = parts.slice(1);
    const preposition = ['to', 'for', 'with', 'from', 'into', 'on'].includes(rest[0] ?? '') ? rest.shift()! : null;
    const object = rest.filter((p) => !['the', 'a', 'an'].includes(p)).join(' ');
    return { verb: parts[0]!, object, preposition };
  }
  return { verb: null, object: parts.join(' '), preposition: null };
}

const NOTIFY_VERBS = new Set(['notify', 'alert', 'ping', 'email', 'message']);

/** Human-readable name for what an effect touches, e.g. "access", "store credit", "approval email". */
export function effectObject(effect: Effect): string {
  if (effect.kind === 'assign') return splitIdentifier(effect.target).join(' ');
  const h = humanizeCallee(effect.target);
  if (h.verb && NOTIFY_VERBS.has(h.verb)) return h.object ? `${h.object} notification` : 'notification';
  return h.object || splitIdentifier(effect.target).join(' ');
}

/** Present-tense description, e.g. "grants access", "sends approval email", "sets status to 'approved'". */
export function describeEffect(effect: Effect): string {
  if (effect.kind === 'assign') {
    const value = effect.value ? ` to ${effect.value}` : '';
    return `sets ${splitIdentifier(effect.target).join(' ')}${value}`;
  }
  const { verb, object, preposition } = humanizeCallee(effect.target);
  if (verb) return [thirdPerson(verb), preposition, object].filter(Boolean).join(' ');
  return `calls ${effect.target}`;
}

/**
 * Words a participant might use when talking about this effect (stemmed). `exclude` removes terms
 * that name the surrounding operation itself (e.g. "approval" for effects inside approveApplication).
 */
export function effectKeywords(effect: Effect, exclude: string[] = [], opts: { withCategoryWords?: boolean } = {}): string[] {
  const skip = new Set(exclude);
  const parts = splitIdentifier(effect.target);
  // Drop only the leading verb of a call ("send" in sendApprovalEmail), keep the object words.
  const objectWords = effect.kind === 'call' && parts.length > 1 ? parts.slice(1) : parts;
  const base = objectWords.filter((w) => !['to', 'for', 'with', 'from'].includes(w));
  const extra: Record<EffectCategory, string[]> = {
    permission: ['access', 'permission', 'revoke', 'grant', 'privilege', 'role', 'session', 'login', 'logged'],
    financial: ['credit', 'refund', 'money', 'charge', 'payment', 'balance', 'reimburse'],
    irreversible: ['delete', 'remove', 'purge', 'gone'],
    external: ['email', 'notify', 'notification', 'message', 'tell', 'webhook', 'informed'],
    data: [],
  };
  // Category words ("login", "notify") help link replies, but are too broad to prove an effect was discussed.
  const all = [...base, ...(opts.withCategoryWords && effect.kind === 'call' ? extra[effect.category] : [])];
  return [...new Set(all.map(stem))].filter((t) => !skip.has(t));
}

/** First argument name of a call effect, e.g. `grantAccess(application.applicantId)` → "applicant". */
export function beneficiaryOf(effect: Effect): string | null {
  const m = effect.text.match(/\(([^,)]*)/);
  if (!m) return null;
  const arg = m[1]!.trim();
  const last = arg.split('.').pop() ?? '';
  const cleaned = splitIdentifier(last.replace(/(Id|Ids|Email|Address|Phone)$/, '')).join(' ');
  if (!cleaned || /^(this|args?|input|params?|options|opts|ctx|req|data|amount)$/.test(cleaned)) return null;
  return cleaned;
}

/** `user.isStaff` → "the account is staff"; best effort, falls back to the raw expression. */
export function humanizeCondition(condition: string): string {
  const inner = condition.replace(/^\(|\)$/g, '').trim();
  const m = inner.match(/^(!)?(?:[a-z][A-Za-z0-9]*\.)?(is|has|can)([A-Z][A-Za-z0-9]*)$/);
  if (m) {
    const neg = m[1] ? ' not' : '';
    const pred = splitIdentifier(m[3]!).join(' ');
    return m[2] === 'is' ? `the account is${neg} ${pred}` : `the account ${m[2] === 'has' ? 'has' : 'can'}${neg} ${pred}`;
  }
  return `\`${inner}\``;
}
