import type { ChangeEvent } from 'react';
import { CATEGORIES, type Filters, type LabelChoice, type ReadState, type SizeUnit } from '../lib/query';

interface Props {
  filters: Filters;
  labels: LabelChoice[];
  disabled: boolean;
  onChange: (filters: Filters) => void;
}

export function FilterForm({ filters, labels, disabled, onChange }: Props) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => onChange({ ...filters, [key]: value });
  const text = (key: 'from' | 'to' | 'subject' | 'hasWords' | 'excludeWords' | 'raw' | 'largerThan' | 'smallerThan') =>
    (e: ChangeEvent<HTMLInputElement>) => set(key, e.target.value);

  return (
    <fieldset className="filters" disabled={disabled}>
      <legend>Filters</legend>

      <label className="field required">
        <span>Delete mail received before</span>
        <input type="date" required value={filters.beforeDate} onChange={(e) => set('beforeDate', e.target.value)} />
        <small>Midnight at the start of this day, in your local time zone.</small>
      </label>

      <div className="grid">
        <label className="field">
          <span>From</span>
          <input type="text" placeholder="name or address; comma-separate several" value={filters.from} onChange={text('from')} />
        </label>
        <label className="field">
          <span>To</span>
          <input type="text" placeholder="name or address; comma-separate several" value={filters.to} onChange={text('to')} />
        </label>
        <label className="field">
          <span>Subject contains</span>
          <input type="text" value={filters.subject} onChange={text('subject')} />
        </label>
        <label className="field">
          <span>Has the words</span>
          <input type="text" placeholder='e.g. invoice "order shipped"' value={filters.hasWords} onChange={text('hasWords')} />
        </label>
        <label className="field">
          <span>Doesn't have</span>
          <input type="text" placeholder="words to exclude" value={filters.excludeWords} onChange={text('excludeWords')} />
        </label>
        <label className="field">
          <span>Label</span>
          <select
            value={filters.label?.id ?? ''}
            onChange={(e) => set('label', labels.find((l) => l.id === e.target.value) ?? null)}
          >
            <option value="">Any label</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Category</span>
          <select value={filters.category} onChange={(e) => set('category', e.target.value as Filters['category'])}>
            <option value="">Any category</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c[0].toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Read status</span>
          <select value={filters.readState} onChange={(e) => set('readState', e.target.value as ReadState)}>
            <option value="any">Read or unread</option>
            <option value="read">Read only</option>
            <option value="unread">Unread only</option>
          </select>
        </label>
        <div className="field">
          <span>Larger than</span>
          <div className="size">
            <input type="number" min="1" step="1" inputMode="numeric" value={filters.largerThan} onChange={text('largerThan')} aria-label="Larger than" />
            <select value={filters.largerUnit} onChange={(e) => set('largerUnit', e.target.value as SizeUnit)} aria-label="Larger than unit">
              <option value="K">KB</option>
              <option value="M">MB</option>
            </select>
          </div>
        </div>
        <div className="field">
          <span>Smaller than</span>
          <div className="size">
            <input type="number" min="1" step="1" inputMode="numeric" value={filters.smallerThan} onChange={text('smallerThan')} aria-label="Smaller than" />
            <select value={filters.smallerUnit} onChange={(e) => set('smallerUnit', e.target.value as SizeUnit)} aria-label="Smaller than unit">
              <option value="K">KB</option>
              <option value="M">MB</option>
            </select>
          </div>
        </div>
      </div>

      <div className="checks">
        <label>
          <input type="checkbox" checked={filters.hasAttachment} onChange={(e) => set('hasAttachment', e.target.checked)} />
          Has attachment
        </label>
        <label>
          <input type="checkbox" checked={filters.excludeStarred} onChange={(e) => set('excludeStarred', e.target.checked)} />
          Protect starred mail
        </label>
        <label>
          <input type="checkbox" checked={filters.excludeImportant} onChange={(e) => set('excludeImportant', e.target.checked)} />
          Protect mail marked important
        </label>
      </div>

      <label className="field">
        <span>Extra Gmail search syntax (advanced)</span>
        <input type="text" placeholder="e.g. -label:receipts older_than:2y" value={filters.raw} onChange={text('raw')} />
        <small>
          Added to the query as-is, ANDed with the filters above.{' '}
          <a href="https://support.google.com/mail/answer/7190" target="_blank" rel="noreferrer">
            Search operators
          </a>
        </small>
      </label>
    </fieldset>
  );
}
