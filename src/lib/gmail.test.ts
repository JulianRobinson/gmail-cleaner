import { describe, expect, it, vi } from 'vitest';
import {
  AuthExpiredError,
  CancelledError,
  GmailApiError,
  GmailClient,
  MAX_BATCH_SIZE,
  backoffDelay,
  chunk,
  isRetryable,
  runInBatches,
} from './gmail';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function apiError(status: number, reason: string): Response {
  return json(status, { error: { code: status, message: `${reason} happened`, errors: [{ reason }] } });
}

function makeClient(responses: (Response | Error)[], retry = {}) {
  const sleeps: number[] = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  const client = new GmailClient(
    () => 'token-123',
    {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0,
      ...retry,
    },
    fetchMock as unknown as typeof fetch,
  );
  return { client, fetchMock, sleeps };
}

describe('isRetryable', () => {
  it('retries 429, rate-limit 403s and transient 5xx', () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(403, 'rateLimitExceeded')).toBe(true);
    expect(isRetryable(403, 'userRateLimitExceeded')).toBe(true);
    expect(isRetryable(503)).toBe(true);
  });

  it('does not retry permission or client errors', () => {
    expect(isRetryable(403, 'insufficientPermissions')).toBe(false);
    expect(isRetryable(403)).toBe(false);
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(404)).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and caps', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 32000, random: () => 0 };
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, opts))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 32000,
    ]);
  });

  it('adds jitter up to one base delay', () => {
    expect(backoffDelay(1, { baseDelayMs: 1000, random: () => 0.5 })).toBe(2500);
  });

  it('honours Retry-After seconds', () => {
    expect(backoffDelay(0, { random: () => 0 }, '7')).toBe(7000);
  });
});

describe('GmailClient.request', () => {
  it('sends the bearer token', async () => {
    const { client, fetchMock } = makeClient([json(200, { emailAddress: 'a@b.com', messagesTotal: 1 })]);
    await client.getProfile();
    const init = fetchMock.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
  });

  it('backs off on 429 and rate-limit 403, then succeeds', async () => {
    const { client, fetchMock, sleeps } = makeClient([
      json(429, { error: { message: 'slow down' } }),
      apiError(403, 'userRateLimitExceeded'),
      json(200, { labels: [] }),
    ]);
    await expect(client.listLabels()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('uses Retry-After when present', async () => {
    const { client, sleeps } = makeClient([
      json(429, { error: { message: 'slow down' } }, { 'Retry-After': '3' }),
      json(200, { labels: [] }),
    ]);
    await client.listLabels();
    expect(sleeps).toEqual([3000]);
  });

  it('retries network errors', async () => {
    const { client, fetchMock } = makeClient([new TypeError('Failed to fetch'), json(200, { labels: [] })]);
    await client.listLabels();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries', async () => {
    const { client, fetchMock, sleeps } = makeClient(
      [json(429, {}), json(429, {}), json(429, {})],
      { maxRetries: 2 },
    );
    await expect(client.listLabels()).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it('does not retry a permission 403', async () => {
    const { client, fetchMock } = makeClient([apiError(403, 'insufficientPermissions')]);
    const err = await client.permanentlyDelete(['a']).catch((e) => e);
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err.reason).toBe('insufficientPermissions');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('raises AuthExpiredError on 401', async () => {
    const { client } = makeClient([json(401, { error: { message: 'Invalid Credentials' } })]);
    await expect(client.listLabels()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('stops waiting when cancelled during backoff', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => json(429, {}));
    const client = new GmailClient(() => 't', { baseDelayMs: 60_000, random: () => 0 }, fetchMock as unknown as typeof fetch);
    const pending = client.request('/labels', {}, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GmailClient endpoints', () => {
  it('paginates messages.list to the end', async () => {
    const { client, fetchMock } = makeClient([
      json(200, { messages: [{ id: '1' }, { id: '2' }], nextPageToken: 'p2' }),
      json(200, { messages: [{ id: '3' }], nextPageToken: 'p3' }),
      json(200, {}),
    ]);
    const progress: number[] = [];
    const ids = await client.listMessageIds('before:1 -is:starred', {
      labelIds: ['Label_1'],
      onProgress: (n) => progress.push(n),
    });
    expect(ids).toEqual(['1', '2', '3']);
    expect(progress).toEqual([2, 3, 3]);
    const urls = fetchMock.mock.calls.map((c) => new URL(String(c[0])));
    expect(urls[0].searchParams.get('q')).toBe('before:1 -is:starred');
    expect(urls[0].searchParams.getAll('labelIds')).toEqual(['Label_1']);
    expect(urls[0].searchParams.get('maxResults')).toBe('500');
    expect(urls[0].searchParams.has('pageToken')).toBe(false);
    expect(urls[1].searchParams.get('pageToken')).toBe('p2');
    expect(urls[2].searchParams.get('pageToken')).toBe('p3');
  });

  it('trashes via batchModify adding TRASH', async () => {
    const { client, fetchMock } = makeClient([new Response(null, { status: 204 })]);
    await client.trash(['a', 'b']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/messages\/batchModify$/);
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toEqual({ ids: ['a', 'b'], addLabelIds: ['TRASH'] });
  });

  it('permanently deletes via batchDelete', async () => {
    const { client, fetchMock } = makeClient([new Response(null, { status: 204 })]);
    await client.permanentlyDelete(['a']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/messages\/batchDelete$/);
    expect(JSON.parse(String(init!.body))).toEqual({ ids: ['a'] });
  });

  it('reads sample metadata', async () => {
    const { client } = makeClient([
      json(200, {
        id: 'm1',
        internalDate: String(Date.UTC(2020, 0, 1)),
        payload: { headers: [{ name: 'From', value: 'A <a@b.com>' }, { name: 'Subject', value: 'Hi' }] },
      }),
    ]);
    const [m] = await client.getMessageSummaries(['m1']);
    expect(m).toMatchObject({ id: 'm1', from: 'A <a@b.com>', subject: 'Hi' });
    expect(m.date).not.toBe('');
  });
});

describe('chunk', () => {
  it('splits into fixed-size batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe('runInBatches', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);

  it('processes every id in batches no larger than the API limit', async () => {
    const seen: number[] = [];
    const result = await runInBatches(ids(2500), async (batch) => {
      seen.push(batch.length);
    }, { batchSize: 5000 });
    expect(seen).toEqual([MAX_BATCH_SIZE, MAX_BATCH_SIZE, 500]);
    expect(result).toMatchObject({ processed: 2500, failed: 0, total: 2500, cancelled: false });
  });

  it('reports progress after each batch', async () => {
    const progress: number[] = [];
    await runInBatches(ids(5), async () => {}, { batchSize: 2, onProgress: (p) => progress.push(p.processed) });
    expect(progress).toEqual([2, 4, 5, 5]);
  });

  it('counts a failed batch and continues', async () => {
    let call = 0;
    const result = await runInBatches(ids(6), async () => {
      if (call++ === 1) throw new GmailApiError('boom', 500);
    }, { batchSize: 2 });
    expect(result).toMatchObject({ processed: 4, failed: 2, cancelled: false, errors: ['boom'] });
  });

  it('stops when cancelled between batches', async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await runInBatches(ids(6), async () => {
      calls++;
      controller.abort();
    }, { batchSize: 2, signal: controller.signal });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ processed: 2, failed: 0, cancelled: true });
  });

  it('stops without counting the in-flight batch when cancelled mid-request', async () => {
    const controller = new AbortController();
    const result = await runInBatches(ids(4), async () => {
      controller.abort();
      throw new CancelledError();
    }, { batchSize: 2, signal: controller.signal });
    expect(result).toMatchObject({ processed: 0, failed: 0, cancelled: true });
  });

  it('stops when sign-in expires', async () => {
    let calls = 0;
    const result = await runInBatches(ids(6), async () => {
      calls++;
      if (calls === 2) throw new AuthExpiredError('expired', 401);
    }, { batchSize: 2 });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ processed: 2, failed: 2, authExpired: true, cancelled: false });
  });

  it('retries rate limits end-to-end through the client', async () => {
    const { client, fetchMock, sleeps } = makeClient([
      new Response(null, { status: 204 }),
      apiError(403, 'rateLimitExceeded'),
      json(429, {}),
      new Response(null, { status: 204 }),
    ]);
    const result = await runInBatches(ids(3), (batch, signal) => client.trash(batch, signal), { batchSize: 2 });
    expect(result).toMatchObject({ processed: 3, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1000, 2000]);
  });
});
