// Compiles the filter form into a single Gmail search query.
// Syntax reference: https://support.google.com/mail/answer/7190

export const CATEGORIES = ['primary', 'promotions', 'social', 'updates', 'forums'] as const;
export type Category = (typeof CATEGORIES)[number];

export type ReadState = 'any' | 'read' | 'unread';
export type SizeUnit = 'K' | 'M';

export interface LabelChoice {
  id: string;
  name: string;
  type: 'system' | 'user';
}

export interface Filters {
  /** Required. Local calendar date (YYYY-MM-DD); mail received before its midnight matches. */
  beforeDate: string;
  from: string;
  to: string;
  subject: string;
  hasWords: string;
  excludeWords: string;
  label: LabelChoice | null;
  category: Category | '';
  hasAttachment: boolean;
  largerThan: string;
  largerUnit: SizeUnit;
  smallerThan: string;
  smallerUnit: SizeUnit;
  readState: ReadState;
  excludeStarred: boolean;
  excludeImportant: boolean;
  raw: string;
}

export function emptyFilters(): Filters {
  return {
    beforeDate: '',
    from: '',
    to: '',
    subject: '',
    hasWords: '',
    excludeWords: '',
    label: null,
    category: '',
    hasAttachment: false,
    largerThan: '',
    largerUnit: 'M',
    smallerThan: '',
    smallerUnit: 'M',
    readState: 'any',
    excludeStarred: true,
    excludeImportant: true,
    raw: '',
  };
}

export class FilterError extends Error {}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses YYYY-MM-DD, rejecting impossible dates such as 2025-02-30. */
export function parseDate(value: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(value.trim());
  if (!m) throw new FilterError('Enter a date as YYYY-MM-DD.');
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new FilterError(`${value} is not a valid date.`);
  }
  return { year, month, day };
}

/** Offset (ms) of `timeZone` from UTC at the instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Epoch seconds of midnight at the start of `date` in `timeZone`
 * (the browser's zone when omitted). Gmail reads `before:YYYY/MM/DD` in
 * Pacific time, so the query uses this absolute timestamp instead.
 */
export function localMidnightEpoch(date: string, timeZone?: string): number {
  const { year, month, day } = parseDate(date);
  if (!timeZone) return Math.floor(new Date(year, month - 1, day, 0, 0, 0, 0).getTime() / 1000);
  const wallAsUtc = Date.UTC(year, month - 1, day);
  let guess = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  // Re-check once in case a DST transition lies between the two instants.
  const corrected = wallAsUtc - zoneOffsetMs(guess, timeZone);
  if (corrected !== guess) guess = corrected;
  return Math.floor(guess / 1000);
}

const BARE_TERM = /^[\p{L}\p{N}._@]+$/u;
const OPERATOR_WORDS = new Set(['OR', 'AND', 'AROUND']);

/**
 * Renders one user-supplied term so Gmail treats it literally. Double quotes
 * cannot be escaped in Gmail search, so they are dropped; anything that is not
 * a plain word or address is wrapped in quotes.
 */
export function quoteTerm(value: string): string {
  const cleaned = value.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (BARE_TERM.test(cleaned) && !OPERATOR_WORDS.has(cleaned.toUpperCase())) return cleaned;
  return `"${cleaned}"`;
}

/** Splits free text into words, keeping "quoted phrases" together. */
export function tokenize(value: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const token = (m[1] ?? m[2]).trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function addressTerm(operator: 'from' | 'to', value: string): string {
  const parts = value
    .split(',')
    .map((v) => quoteTerm(v))
    .filter(Boolean)
    .map((v) => `${operator}:${v}`);
  if (parts.length === 0) return '';
  return parts.length === 1 ? parts[0] : `{${parts.join(' ')}}`;
}

function sizeTerm(operator: 'larger' | 'smaller', value: string, unit: SizeUnit, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new FilterError(`${label} must be a whole number greater than zero.`);
  }
  return `${operator}:${Number(trimmed)}${unit}`;
}

/** Gmail's canonical label search form: lowercase, with spaces and separators as hyphens. */
export function labelTerm(label: LabelChoice): string {
  if (label.type === 'system') return `in:${label.id.toLowerCase()}`;
  const slug = label.name
    .toLowerCase()
    .replace(/[\s/&(){}"]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `label:${slug}`;
}

export interface BuildOptions {
  /** IANA zone for interpreting `beforeDate`; defaults to the browser's zone. */
  timeZone?: string;
}

export function buildQuery(filters: Filters, options: BuildOptions = {}): string {
  if (!filters.beforeDate.trim()) throw new FilterError('A delete-before date is required.');
  const terms: string[] = [`before:${localMidnightEpoch(filters.beforeDate, options.timeZone)}`];

  terms.push(addressTerm('from', filters.from));
  terms.push(addressTerm('to', filters.to));

  const subject = quoteTerm(filters.subject);
  if (subject) terms.push(`subject:${subject}`);

  for (const word of tokenize(filters.hasWords)) terms.push(quoteTerm(word));
  for (const word of tokenize(filters.excludeWords)) {
    const term = quoteTerm(word);
    if (term) terms.push(`-${term}`);
  }

  if (filters.label) terms.push(labelTerm(filters.label));
  if (filters.category) terms.push(`category:${filters.category}`);
  if (filters.hasAttachment) terms.push('has:attachment');
  terms.push(sizeTerm('larger', filters.largerThan, filters.largerUnit, 'Larger than'));
  terms.push(sizeTerm('smaller', filters.smallerThan, filters.smallerUnit, 'Smaller than'));
  if (filters.readState === 'read') terms.push('is:read');
  if (filters.readState === 'unread') terms.push('is:unread');
  if (filters.excludeStarred) terms.push('-is:starred');
  if (filters.excludeImportant) terms.push('-is:important');

  const raw = filters.raw.trim();
  if (raw) terms.push(`(${raw})`);

  return terms.filter(Boolean).join(' ');
}
