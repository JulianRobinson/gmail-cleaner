import { describe, expect, it } from 'vitest';
import {
  FilterError,
  buildQuery,
  emptyFilters,
  labelTerm,
  localMidnightEpoch,
  parseDate,
  quoteTerm,
  tokenize,
  type Filters,
} from './query';

function filters(overrides: Partial<Filters> = {}): Filters {
  return { ...emptyFilters(), beforeDate: '2024-01-15', ...overrides };
}

const UTC = { timeZone: 'UTC' };

describe('localMidnightEpoch', () => {
  it('uses midnight UTC for the UTC zone', () => {
    expect(localMidnightEpoch('2024-01-15', 'UTC')).toBe(Date.UTC(2024, 0, 15) / 1000);
  });

  it('uses local midnight, not Pacific time, for other zones', () => {
    // 2024-01-15 00:00 in New York (EST, UTC-5) is 05:00 UTC.
    expect(localMidnightEpoch('2024-01-15', 'America/New_York')).toBe(Date.UTC(2024, 0, 15, 5) / 1000);
    // 2024-01-15 00:00 in Tokyo (UTC+9) is 15:00 UTC the previous day.
    expect(localMidnightEpoch('2024-01-15', 'Asia/Tokyo')).toBe(Date.UTC(2024, 0, 14, 15) / 1000);
    // Pacific itself still works.
    expect(localMidnightEpoch('2024-01-15', 'America/Los_Angeles')).toBe(Date.UTC(2024, 0, 15, 8) / 1000);
  });

  it('accounts for daylight saving time', () => {
    // New York is on EDT (UTC-4) in July.
    expect(localMidnightEpoch('2024-07-04', 'America/New_York')).toBe(Date.UTC(2024, 6, 4, 4) / 1000);
    // Day of the spring-forward transition (2024-03-10): midnight is still EST.
    expect(localMidnightEpoch('2024-03-10', 'America/New_York')).toBe(Date.UTC(2024, 2, 10, 5) / 1000);
    // Day after the transition: midnight is EDT.
    expect(localMidnightEpoch('2024-03-11', 'America/New_York')).toBe(Date.UTC(2024, 2, 11, 4) / 1000);
    // Southern hemisphere: Sydney is on AEDT (UTC+11) in January.
    expect(localMidnightEpoch('2024-01-15', 'Australia/Sydney')).toBe(Date.UTC(2024, 0, 14, 13) / 1000);
  });

  it('handles zones where midnight itself is skipped by DST', () => {
    // Santiago springs forward at 00:00 -> 01:00 on 2024-09-08; the day starts at 01:00 local (04:00 UTC).
    const epoch = localMidnightEpoch('2024-09-08', 'America/Santiago');
    expect([Date.UTC(2024, 8, 8, 3) / 1000, Date.UTC(2024, 8, 8, 4) / 1000]).toContain(epoch);
  });

  it('uses the runtime zone when none is given', () => {
    expect(localMidnightEpoch('2024-01-15')).toBe(new Date(2024, 0, 15).getTime() / 1000);
  });
});

describe('parseDate', () => {
  it('rejects malformed and impossible dates', () => {
    expect(() => parseDate('2024/01/15')).toThrow(FilterError);
    expect(() => parseDate('2024-02-30')).toThrow(FilterError);
    expect(() => parseDate('2023-02-29')).toThrow(FilterError);
    expect(parseDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
  });
});

describe('quoteTerm', () => {
  it('leaves plain words and addresses bare', () => {
    expect(quoteTerm('invoice')).toBe('invoice');
    expect(quoteTerm('alice@example.com')).toBe('alice@example.com');
  });

  it('quotes phrases and terms with special characters', () => {
    expect(quoteTerm('order shipped')).toBe('"order shipped"');
    expect(quoteTerm('re:invoice')).toBe('"re:invoice"');
    expect(quoteTerm('-label:x')).toBe('"-label:x"');
    expect(quoteTerm("don't")).toBe('"don\'t"');
  });

  it('drops embedded double quotes, which Gmail cannot escape', () => {
    expect(quoteTerm('say "hello" now')).toBe('"say hello now"');
    expect(quoteTerm('"')).toBe('');
    expect(quoteTerm('"  "')).toBe('');
  });

  it('quotes bare search operators so they are matched literally', () => {
    expect(quoteTerm('OR')).toBe('"OR"');
    expect(quoteTerm('and')).toBe('"and"');
  });

  it('collapses whitespace', () => {
    expect(quoteTerm('  a   b  ')).toBe('"a b"');
  });
});

describe('tokenize', () => {
  it('splits on whitespace and keeps quoted phrases', () => {
    expect(tokenize('invoice "order shipped" receipt')).toEqual(['invoice', 'order shipped', 'receipt']);
  });

  it('tolerates an unterminated quote', () => {
    expect(tokenize('a "b c')).toEqual(['a', 'b c']);
  });
});

describe('labelTerm', () => {
  it('normalizes user labels to Gmail form', () => {
    expect(labelTerm({ id: 'Label_1', name: 'Work/Old Projects', type: 'user' })).toBe('label:work-old-projects');
  });

  it('maps system labels to in:', () => {
    expect(labelTerm({ id: 'INBOX', name: 'Inbox', type: 'system' })).toBe('in:inbox');
  });
});

describe('buildQuery', () => {
  it('requires a date', () => {
    expect(() => buildQuery(emptyFilters(), UTC)).toThrow(FilterError);
  });

  it('includes the default protections', () => {
    expect(buildQuery(filters(), UTC)).toBe(`before:${Date.UTC(2024, 0, 15) / 1000} -is:starred -is:important`);
  });

  it('omits protections when switched off', () => {
    expect(buildQuery(filters({ excludeStarred: false, excludeImportant: false }), UTC)).toBe(
      `before:${Date.UTC(2024, 0, 15) / 1000}`,
    );
  });

  it('never emits the date-string before: form', () => {
    expect(buildQuery(filters(), { timeZone: 'Asia/Tokyo' })).not.toMatch(/before:\d{4}\//);
  });

  it('compiles every filter', () => {
    const q = buildQuery(
      filters({
        from: 'news@shop.com',
        to: 'Jane Doe',
        subject: 'Your "weekly" deals',
        hasWords: 'sale "50% off"',
        excludeWords: 'receipt "order confirmation"',
        label: { id: 'Label_7', name: 'Shopping', type: 'user' },
        category: 'promotions',
        hasAttachment: true,
        largerThan: '5',
        largerUnit: 'M',
        smallerThan: '500',
        smallerUnit: 'K',
        readState: 'read',
        raw: 'older_than:1y OR is:muted',
      }),
      UTC,
    );
    expect(q).toBe(
      [
        `before:${Date.UTC(2024, 0, 15) / 1000}`,
        'from:news@shop.com',
        'to:"Jane Doe"',
        'subject:"Your weekly deals"',
        'sale',
        '"50% off"',
        '-receipt',
        '-"order confirmation"',
        'label:shopping',
        'category:promotions',
        'has:attachment',
        'larger:5M',
        'smaller:500K',
        'is:read',
        '-is:starred',
        '-is:important',
        '(older_than:1y OR is:muted)',
      ].join(' '),
    );
  });

  it('ORs comma-separated addresses', () => {
    expect(buildQuery(filters({ from: 'a@x.com, b@y.com', excludeStarred: false, excludeImportant: false }), UTC)).toBe(
      `before:${Date.UTC(2024, 0, 15) / 1000} {from:a@x.com from:b@y.com}`,
    );
  });

  it('ignores blank and quote-only inputs', () => {
    expect(
      buildQuery(filters({ from: ' , ', subject: '""', hasWords: '   ', excludeWords: '""', raw: '  ' }), UTC),
    ).toBe(`before:${Date.UTC(2024, 0, 15) / 1000} -is:starred -is:important`);
  });

  it('adds unread', () => {
    expect(buildQuery(filters({ readState: 'unread' }), UTC)).toContain('is:unread');
  });

  it('rejects bad sizes', () => {
    expect(() => buildQuery(filters({ largerThan: '1.5' }), UTC)).toThrow(FilterError);
    expect(() => buildQuery(filters({ smallerThan: '0' }), UTC)).toThrow(FilterError);
    expect(() => buildQuery(filters({ largerThan: '-3' }), UTC)).toThrow(FilterError);
  });
});
