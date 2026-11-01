import { useEffect, useRef, useState } from 'react';
import type { Action } from '../App';

export const PERMANENT_CONFIRM_WORD = 'DELETE';

interface Props {
  count: number;
  action: Action;
  query: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({ count, action, query, onCancel, onConfirm }: Props) {
  const [typed, setTyped] = useState('');
  const ref = useRef<HTMLDialogElement>(null);
  const permanent = action === 'delete';
  const noun = `${count.toLocaleString()} message${count === 1 ? '' : 's'}`;
  const canConfirm = !permanent || typed === PERMANENT_CONFIRM_WORD;

  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);

  return (
    <dialog ref={ref} className={permanent ? 'confirm danger' : 'confirm'} onCancel={onCancel} aria-labelledby="confirm-title">
      <h2 id="confirm-title">{permanent ? `Permanently delete ${noun}?` : `Move ${noun} to Trash?`}</h2>
      {permanent ? (
        <p>
          <strong>This cannot be undone.</strong> The {noun} will be deleted immediately and permanently, skipping Trash.
          They cannot be recovered from Gmail.
        </p>
      ) : (
        <p>The {noun} will be moved to Gmail's Trash, where they can be restored for 30 days.</p>
      )}
      <p className="hint">
        Query: <code>{query}</code>
      </p>
      {permanent ? (
        <label className="field">
          <span>
            Type <strong>{PERMANENT_CONFIRM_WORD}</strong> to confirm
          </span>
          <input type="text" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </label>
      ) : null}
      <div className="buttons">
        <button type="button" onClick={onCancel} autoFocus={!permanent}>
          Cancel
        </button>
        <button type="button" className={permanent ? 'danger' : 'primary'} disabled={!canConfirm} onClick={onConfirm}>
          {permanent ? `Permanently delete ${noun}` : `Move ${noun} to Trash`}
        </button>
      </div>
    </dialog>
  );
}
