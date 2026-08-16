"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "token-tracker.hidden-limits";

export interface LimitFilterProvider {
  provider: string;
  account: string | null;
  windows: Array<{ id: string; label: string }>;
}

// The same provider shows up once per authenticated account, and those cards
// repeat window ids like "anthropic:5h", so neither the provider nor the window
// identifies a quota on its own.
export function limitKey(provider: string, account: string | null, windowId: string): string {
  return `${provider}/${account ?? "default"}/${windowId}`;
}

function readStored(): Record<string, true> {
  const hidden: Record<string, true> = {};
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing modes can refuse storage entirely. Showing every quota
    // is the harmless fallback.
    return hidden;
  }
  if (raw === null) return hidden;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return hidden;
  }
  if (!Array.isArray(parsed)) return hidden;
  for (const entry of parsed) {
    if (typeof entry === "string") hidden[entry] = true;
  }
  return hidden;
}

function writeStored(hidden: Record<string, true>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.keys(hidden)));
  } catch {
    // The choice stays in memory for this session; nothing else depends on it.
  }
}

export interface HiddenLimits {
  hidden: Record<string, true>;
  setKeysHidden: (keys: string[], hide: boolean) => void;
  showEvery: () => void;
}

export function useHiddenLimits(): HiddenLimits {
  // Starts empty so the server-rendered markup and the first client render
  // agree; the stored choice is applied on mount, well before the dashboard
  // fetch resolves and the panel has anything to draw.
  const [hidden, setHidden] = useState<Record<string, true>>({});

  useEffect(() => {
    const stored = readStored();
    if (Object.keys(stored).length > 0) setHidden(stored);
  }, []);

  const setKeysHidden = useCallback((keys: string[], hide: boolean) => {
    setHidden((current) => {
      const next = { ...current };
      for (const key of keys) {
        if (hide) next[key] = true;
        else delete next[key];
      }
      writeStored(next);
      return next;
    });
  }, []);

  const showEvery = useCallback(() => {
    setHidden(() => {
      writeStored({});
      return {};
    });
  }, []);

  return { hidden, setKeysHidden, showEvery };
}

export function LimitFilter({
  providers,
  hidden,
  setKeysHidden,
  showEvery,
}: Readonly<{ providers: LimitFilterProvider[] } & HiddenLimits>) {
  const hiddenCount = providers.reduce(
    (total, entry) =>
      total +
      entry.windows.filter((quota) => hidden[limitKey(entry.provider, entry.account, quota.id)]).length,
    0,
  );

  return (
    <details className="limitFilter">
      <summary>
        Visible limits
        {hiddenCount > 0 && <span className="limitFilterCount">{hiddenCount} hidden</span>}
      </summary>
      <div className="limitFilterMenu">
        <div className="limitFilterTop">
          <strong>Show these quotas</strong>
          <button type="button" onClick={showEvery} disabled={hiddenCount === 0}>
            Reset
          </button>
        </div>
        {providers.map((entry) => {
          const keys = entry.windows.map((quota) => limitKey(entry.provider, entry.account, quota.id));
          const shownCount = keys.filter((key) => !hidden[key]).length;
          return (
            <div className="limitFilterGroup" key={`${entry.provider}/${entry.account ?? "default"}`}>
              <label className="limitFilterOption group">
                <input
                  type="checkbox"
                  checked={shownCount > 0}
                  // Some but not all shown reads as a partial choice.
                  ref={(node) => {
                    if (node) node.indeterminate = shownCount > 0 && shownCount < keys.length;
                  }}
                  onChange={() => setKeysHidden(keys, shownCount > 0)}
                />
                <span>
                  {entry.provider}
                  <small>{entry.account ?? "single account"}</small>
                </span>
              </label>
              {entry.windows.map((quota) => {
                const key = limitKey(entry.provider, entry.account, quota.id);
                return (
                  <label className="limitFilterOption" key={key}>
                    <input
                      type="checkbox"
                      checked={!hidden[key]}
                      onChange={(event) => setKeysHidden([key], !event.target.checked)}
                    />
                    <span>{quota.label}</span>
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
    </details>
  );
}
