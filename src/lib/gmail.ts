// Minimal Gmail REST client with retry/backoff, plus the batch runner used to
// trash or delete messages. Everything here is plain fetch so it can be tested
// with a mocked fetch and no Google account.

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Gmail rejects batchModify/batchDelete calls with more than 1000 ids. */
export const MAX_BATCH_SIZE = 1000;
export const DEFAULT_BATCH_SIZE = 500;

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** The access token expired or was revoked; the user must sign in again. */
export class AuthExpiredError extends GmailApiError {}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

async function errorReason(res: Response): Promise<{ message: string; reason?: string }> {
  try {
    const body = await res.json();
    const err = body?.error;
    return {
      message: err?.message ?? `HTTP ${res.status}`,
      reason: err?.errors?.[0]?.reason ?? err?.status,
    };
  } catch {
    return { message: `HTTP ${res.status}` };
  }
}

/** 429, rate-limit 403s and transient 5xx are worth retrying. */
export function isRetryable(status: number, reason?: string): boolean {
  if (status === 429) return true;
  if (status === 403) return reason !== undefined && RATE_LIMIT_REASONS.has(reason);
  return status === 500 || status === 502 || status === 503 || status === 504;
}

export function backoffDelay(attempt: number, opts: RetryOptions = {}, retryAfter?: string | null): number {
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 32000;
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, max);
  const jitter = (opts.random ?? Math.random)() * base;
  return Math.min(base * 2 ** attempt + jitter, max);
}

export interface MessageSummary {
  id: string;
  date: string;
  from: string;
  subject: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
}

export interface ListOptions {
  labelIds?: string[];
  signal?: AbortSignal;
  onProgress?: (count: number) => void;
}

export class GmailClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly getToken: () => string,
    private readonly retry: RetryOptions = {},
    fetchFn?: typeof fetch,
  ) {
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const maxRetries = this.retry.maxRetries ?? 6;
    const wait = this.retry.sleep ?? sleep;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new CancelledError();
      let res: Response;
      try {
        res = await this.fetchFn(`${API}${path}`, {
          ...init,
          signal,
          headers: {
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers,
            Authorization: `Bearer ${this.getToken()}`,
          },
        });
      } catch (err) {
        if (signal?.aborted) throw new CancelledError();
        // Network failure: retry like a transient server error.
        if (attempt >= maxRetries) throw err;
        await wait(backoffDelay(attempt, this.retry), signal);
        continue;
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const { message, reason } = await errorReason(res);
      if (res.status === 401) throw new AuthExpiredError(message, 401, reason);
      if (!isRetryable(res.status, reason) || attempt >= maxRetries) {
        throw new GmailApiError(message, res.status, reason);
      }
      await wait(backoffDelay(attempt, this.retry, res.headers.get('Retry-After')), signal);
    }
  }

  async getProfile(): Promise<{ emailAddress: string; messagesTotal: number }> {
    return this.request('/profile');
  }

  async listLabels(): Promise<GmailLabel[]> {
    const body = await this.request<{ labels?: GmailLabel[] }>('/labels');
    return body.labels ?? [];
  }

  /**
   * Returns every matching message id. Paginates to the end because
   * `resultSizeEstimate` is not reliable enough to state as an exact count.
   */
  async listMessageIds(q: string, opts: ListOptions = {}): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, maxResults: '500', fields: 'messages/id,nextPageToken' });
      for (const id of opts.labelIds ?? []) params.append('labelIds', id);
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.request<{ messages?: { id: string }[]; nextPageToken?: string }>(
        `/messages?${params}`,
        {},
        opts.signal,
      );
      for (const m of page.messages ?? []) ids.push(m.id);
      opts.onProgress?.(ids.length);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return ids;
  }

  async getMessageSummary(id: string, signal?: AbortSignal): Promise<MessageSummary> {
    const params = new URLSearchParams({ format: 'metadata', fields: 'id,internalDate,payload/headers' });
    for (const h of ['From', 'Subject']) params.append('metadataHeaders', h);
    const msg = await this.request<{
      id: string;
      internalDate?: string;
      payload?: { headers?: { name: string; value: string }[] };
    }>(`/messages/${encodeURIComponent(id)}?${params}`, {}, signal);
    const header = (name: string) =>
      msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
    return {
      id: msg.id,
      date: msg.internalDate ? new Date(Number(msg.internalDate)).toLocaleString() : '',
      from: header('From'),
      subject: header('Subject'),
    };
  }

  async getMessageSummaries(ids: string[], signal?: AbortSignal, concurrency = 5): Promise<MessageSummary[]> {
    const results: MessageSummary[] = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        results[i] = await this.getMessageSummary(ids[i], signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    return results;
  }

  /** Moves messages to Trash (recoverable for 30 days). */
  async trash(ids: string[], signal?: AbortSignal): Promise<void> {
    await this.request('/messages/batchModify', {
      method: 'POST',
      body: JSON.stringify({ ids, addLabelIds: ['TRASH'] }),
    }, signal);
  }

  /** Permanently deletes messages. Requires the https://mail.google.com/ scope. */
  async permanentlyDelete(ids: string[], signal?: AbortSignal): Promise<void> {
    await this.request('/messages/batchDelete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }, signal);
  }
}

export interface BatchProgress {
  processed: number;
  failed: number;
  total: number;
}

export interface BatchResult extends BatchProgress {
  cancelled: boolean;
  /** Set when the run stopped early because sign-in expired. */
  authExpired: boolean;
  errors: string[];
}

export interface BatchOptions {
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: BatchProgress) => void;
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('Batch size must be a positive integer.');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs `action` over `ids` in batches. A batch that still fails after the
 * client's retries is counted as failed and the run continues; cancellation and
 * an expired sign-in stop the run.
 */
export async function runInBatches(
  ids: string[],
  action: (batch: string[], signal?: AbortSignal) => Promise<void>,
  opts: BatchOptions = {},
): Promise<BatchResult> {
  const size = Math.min(opts.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  const result: BatchResult = {
    processed: 0,
    failed: 0,
    total: ids.length,
    cancelled: false,
    authExpired: false,
    errors: [],
  };
  const report = () => opts.onProgress?.({ processed: result.processed, failed: result.failed, total: result.total });

  for (const batch of chunk(ids, size)) {
    if (opts.signal?.aborted) {
      result.cancelled = true;
      break;
    }
    try {
      await action(batch, opts.signal);
      result.processed += batch.length;
    } catch (err) {
      if (err instanceof CancelledError || opts.signal?.aborted) {
        // The in-flight request may or may not have reached Gmail; it is not counted.
        result.cancelled = true;
        break;
      }
      result.failed += batch.length;
      result.errors.push(err instanceof Error ? err.message : String(err));
      if (err instanceof AuthExpiredError) {
        result.authExpired = true;
        break;
      }
    }
    report();
  }
  report();
  return result;
}
