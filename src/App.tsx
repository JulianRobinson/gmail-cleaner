import { useEffect, useMemo, useRef, useState } from 'react';
import { FilterForm } from './components/FilterForm';
import { ConfirmDialog } from './components/ConfirmDialog';
import { FULL_SCOPE, MODIFY_SCOPE, clientId, requestToken, revokeToken, type AccessToken } from './lib/auth';
import {
  AuthExpiredError,
  CancelledError,
  GmailClient,
  runInBatches,
  type BatchProgress,
  type BatchResult,
  type MessageSummary,
} from './lib/gmail';
import { FilterError, buildQuery, emptyFilters, type Filters, type LabelChoice } from './lib/query';

export type Action = 'trash' | 'delete';

const SAMPLE_SIZE = 25;
const SYSTEM_LABELS_OFFERED = new Set(['INBOX', 'SENT']);

interface Preview {
  query: string;
  labelIds: string[];
  ids: string[];
  sample: MessageSummary[];
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'counting'; found: number }
  | { kind: 'previewed' }
  | { kind: 'confirming' }
  | { kind: 'running'; progress: BatchProgress }
  | { kind: 'done'; result: BatchResult; action: Action };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function App() {
  const [token, setToken] = useState<AccessToken | null>(null);
  const [email, setEmail] = useState('');
  const [labels, setLabels] = useState<LabelChoice[]>([]);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [action, setAction] = useState<Action>('trash');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const tokenRef = useRef<string>('');
  tokenRef.current = token?.accessToken ?? '';

  const client = useMemo(() => new GmailClient(() => tokenRef.current), []);

  const busy = phase.kind === 'counting' || phase.kind === 'running';

  const query = useMemo(() => {
    try {
      return { text: buildQuery(filters), error: '' };
    } catch (err) {
      return { text: '', error: err instanceof FilterError ? err.message : errorMessage(err) };
    }
  }, [filters]);

  // Any filter change invalidates an earlier preview so the confirmed count always matches the query.
  useEffect(() => {
    setPreview(null);
    setPhase((p) => (p.kind === 'previewed' || p.kind === 'done' ? { kind: 'idle' } : p));
  }, [filters]);

  // The range reaches today when it has no end or ends today or later.
  const reachesToday = useMemo(() => {
    if (!filters.startDate && !filters.endDate) return false;
    if (!filters.endDate) return true;
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return filters.endDate >= todayStr;
  }, [filters.startDate, filters.endDate]);

  function handleAuthError(err: unknown): boolean {
    if (err instanceof AuthExpiredError) {
      setToken(null);
      setPreview(null);
      setError('Your Google sign-in expired. Sign in again to continue.');
      return true;
    }
    return false;
  }

  async function signIn() {
    setError('');
    try {
      const t = await requestToken(MODIFY_SCOPE, 'select_account');
      if (!t.hasModify) {
        setError('Gmail access was not granted. Sign in again and allow the requested permission.');
        await revokeToken(t.accessToken);
        return;
      }
      tokenRef.current = t.accessToken;
      setToken(t);
      const [profile, rawLabels] = await Promise.all([client.getProfile(), client.listLabels()]);
      setEmail(profile.emailAddress);
      setLabels(
        rawLabels
          .filter((l) => l.type === 'user' || SYSTEM_LABELS_OFFERED.has(l.id))
          .map((l) => ({ id: l.id, name: l.type === 'system' ? l.name[0] + l.name.slice(1).toLowerCase() : l.name, type: l.type }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'system' ? -1 : 1)),
      );
    } catch (err) {
      if (!handleAuthError(err)) setError(errorMessage(err));
    }
  }

  async function signOut() {
    abortRef.current?.abort();
    if (token) await revokeToken(token.accessToken);
    setToken(null);
    setEmail('');
    setLabels([]);
    setPreview(null);
    setAction('trash');
    setPhase({ kind: 'idle' });
  }

  async function grantFullScope() {
    setError('');
    try {
      const t = await requestToken(FULL_SCOPE);
      if (!t.hasFull) {
        setError('Permanent-delete permission was not granted. Moving to Trash is still available.');
        return;
      }
      tokenRef.current = t.accessToken;
      setToken(t);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function runPreview() {
    if (!query.text) return;
    setError('');
    setPreview(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'counting', found: 0 });
    const labelIds = filters.label ? [filters.label.id] : [];
    try {
      const ids = await client.listMessageIds(query.text, {
        labelIds,
        signal: controller.signal,
        onProgress: (found) => setPhase({ kind: 'counting', found }),
      });
      const sample = await client.getMessageSummaries(ids.slice(0, SAMPLE_SIZE), controller.signal);
      setPreview({ query: query.text, labelIds, ids, sample });
      setPhase({ kind: 'previewed' });
    } catch (err) {
      setPhase({ kind: 'idle' });
      if (err instanceof CancelledError || controller.signal.aborted) return;
      if (!handleAuthError(err)) setError(errorMessage(err));
    }
  }

  async function execute() {
    if (!preview) return;
    const chosen = action;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'running', progress: { processed: 0, failed: 0, total: preview.ids.length } });
    const result = await runInBatches(
      preview.ids,
      (batch, signal) => (chosen === 'delete' ? client.permanentlyDelete(batch, signal) : client.trash(batch, signal)),
      { signal: controller.signal, onProgress: (progress) => setPhase({ kind: 'running', progress }) },
    );
    setPreview(null);
    setPhase({ kind: 'done', result, action: chosen });
    if (result.authExpired) setToken(null);
  }

  if (!clientId()) {
    return (
      <main>
        <h1>Gmail Cleaner</h1>
        <p className="error">
          <code>VITE_GOOGLE_CLIENT_ID</code> is not set. Copy <code>.env.example</code> to <code>.env</code>, add your OAuth
          client ID, and restart <code>npm run dev</code>. See the README for setup steps.
        </p>
      </main>
    );
  }

  return (
    <main>
      <header>
        <h1>Gmail Cleaner</h1>
        {token ? (
          <div className="account">
            <span>{email || 'Signed in'}</span>
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          </div>
        ) : null}
      </header>

      {error ? <p className="error" role="alert">{error}</p> : null}

      {!token ? (
        <section className="intro">
          <p>
            Find old mail with filters, preview exactly what matches, then move it to Trash. Everything runs in this browser
            tab; no server sees your mail or your sign-in.
          </p>
          <button type="button" className="primary" onClick={signIn}>
            Sign in with Google
          </button>
        </section>
      ) : (
        <>
          <FilterForm filters={filters} labels={labels} disabled={busy} onChange={setFilters} />

          <section className="query">
            <h2>Gmail search query</h2>
            {query.error ? <p className="hint">{query.error}</p> : <code className="query-text">{query.text}</code>}
            {reachesToday && !query.error ? (
              <p className="warning">This range runs up to today, so recent mail will match too.</p>
            ) : null}
            {!filters.excludeStarred || !filters.excludeImportant ? (
              <p className="warning">A protection is off: starred or important mail can be included.</p>
            ) : null}
          </section>

          <section className="action">
            <h2>Action</h2>
            <label>
              <input type="radio" name="action" checked={action === 'trash'} onChange={() => setAction('trash')} disabled={busy} />
              Move to Trash (recoverable from Gmail Trash for 30 days)
            </label>
            <label>
              <input type="radio" name="action" checked={action === 'delete'} onChange={() => setAction('delete')} disabled={busy} />
              Permanently delete (cannot be undone)
            </label>
            {action === 'delete' && !token.hasFull ? (
              <div className="warning">
                <p>Permanent delete needs an extra Gmail permission (full mail access). Grant it, or switch back to Trash.</p>
                <button type="button" onClick={grantFullScope} disabled={busy}>
                  Grant permanent-delete permission
                </button>
              </div>
            ) : null}
          </section>

          <div className="buttons">
            <button type="button" className="primary" onClick={runPreview} disabled={busy || !query.text}>
              Preview matches
            </button>
            {phase.kind === 'counting' ? (
              <>
                <span>Counting… {phase.found.toLocaleString()} found so far</span>
                <button type="button" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </button>
              </>
            ) : null}
          </div>

          {preview && (phase.kind === 'previewed' || phase.kind === 'confirming') ? (
            <section className="preview">
              <h2>
                {preview.ids.length.toLocaleString()} matching message{preview.ids.length === 1 ? '' : 's'}
              </h2>
              {preview.ids.length === 0 ? (
                <p>Nothing matches these filters.</p>
              ) : (
                <>
                  <p className="hint">
                    Showing the first {preview.sample.length} (newest first).
                  </p>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>From</th>
                          <th>Subject</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.sample.map((m) => (
                          <tr key={m.id}>
                            <td>{m.date}</td>
                            <td>{m.from}</td>
                            <td>{m.subject || <em>(no subject)</em>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    className={action === 'delete' ? 'danger' : 'primary'}
                    disabled={action === 'delete' && !token.hasFull}
                    onClick={() => setPhase({ kind: 'confirming' })}
                  >
                    {action === 'delete' ? 'Permanently delete' : 'Move to Trash'} {preview.ids.length.toLocaleString()}{' '}
                    message{preview.ids.length === 1 ? '' : 's'}…
                  </button>
                </>
              )}
            </section>
          ) : null}

          {phase.kind === 'confirming' && preview ? (
            <ConfirmDialog
              count={preview.ids.length}
              action={action}
              query={preview.query}
              onCancel={() => setPhase({ kind: 'previewed' })}
              onConfirm={execute}
            />
          ) : null}

          {phase.kind === 'running' ? (
            <section className="progress">
              <h2>{action === 'delete' ? 'Permanently deleting' : 'Moving to Trash'}…</h2>
              <progress
                max={phase.progress.total}
                value={phase.progress.processed + phase.progress.failed}
              />
              <p>
                {(phase.progress.processed + phase.progress.failed).toLocaleString()} of {phase.progress.total.toLocaleString()}
                {phase.progress.failed ? ` (${phase.progress.failed.toLocaleString()} failed)` : ''}
              </p>
              <button type="button" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            </section>
          ) : null}

          {phase.kind === 'done' ? <Summary result={phase.result} action={phase.action} /> : null}
        </>
      )}

      {phase.kind === 'done' && !token ? <Summary result={phase.result} action={phase.action} /> : null}
    </main>
  );
}

function Summary({ result, action }: { result: BatchResult; action: Action }) {
  const notAttempted = result.total - result.processed - result.failed;
  return (
    <section className="summary" role="status">
      <h2>{result.cancelled ? 'Stopped' : 'Finished'}</h2>
      <ul>
        <li>
          {action === 'delete' ? 'Permanently deleted' : 'Moved to Trash'}: {result.processed.toLocaleString()}
        </li>
        <li>Failed: {result.failed.toLocaleString()}</li>
        {notAttempted > 0 ? <li>Not attempted: {notAttempted.toLocaleString()}</li> : null}
      </ul>
      {result.cancelled ? (
        <p className="hint">Cancelled. A batch that was in flight when you cancelled may still have been applied by Gmail.</p>
      ) : null}
      {result.authExpired ? <p className="error">Your sign-in expired during the run. Sign in again and preview to continue.</p> : null}
      {result.errors.length ? (
        <details>
          <summary>Errors</summary>
          <ul>
            {[...new Set(result.errors)].map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {action === 'trash' && result.processed > 0 ? (
        <p className="hint">Trashed mail stays recoverable in Gmail's Trash for 30 days.</p>
      ) : null}
    </section>
  );
}
