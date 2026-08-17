"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "./lib";

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

// The choice is stored by the app's own API rather than in the window's
// localStorage: the desktop app binds an ephemeral loopback port, so every
// launch is a new origin with an empty storage bucket. The database is the only
// thing that outlives the port.
async function readStored(): Promise<Record<string, true>> {
  const hidden: Record<string, true> = {};
  let payload: unknown;
  try {
    payload = await requestJson("/api/preferences");
  } catch {
    // Showing every quota is the harmless fallback for an unreachable API; the
    // dashboard reports the failure through its own error banner anyway.
    return hidden;
  }
  if (!payload || typeof payload !== "object" || !("hiddenLimits" in payload)) return hidden;
  const stored = payload.hiddenLimits;
  if (!Array.isArray(stored)) return hidden;
  for (const entry of stored) {
    if (typeof entry === "string") hidden[entry] = true;
  }
  return hidden;
}

function writeStored(hidden: Record<string, true>): void {
  void requestJson("/api/preferences", {
    body: JSON.stringify({ hiddenLimits: Object.keys(hidden) }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  }).catch(() => {
    // The choice stays in memory for this session; nothing else depends on it.
  });
}

export interface HiddenLimits {
  hidden: Record<string, true>;
  setKeysHidden: (keys: string[], hide: boolean) => void;
  showEvery: () => void;
}

export function useHiddenLimits(): HiddenLimits {
  // Starts empty so the server-rendered markup and the first client render
  // agree; the stored choice arrives on mount, well before the dashboard fetch
  // resolves and the panel has anything to draw.
  const [hidden, setHidden] = useState<Record<string, true>>({});
  // A choice made before the stored one arrives is the newer one, so it must not
  // be overwritten by the reply that is already in flight.
  const edited = useRef(false);

  useEffect(() => {
    let active = true;
    void readStored().then((stored) => {
      if (active && !edited.current) setHidden(stored);
    });
    return () => {
      active = false;
    };
  }, []);

  const setKeysHidden = useCallback((keys: string[], hide: boolean) => {
    edited.current = true;
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
    edited.current = true;
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
