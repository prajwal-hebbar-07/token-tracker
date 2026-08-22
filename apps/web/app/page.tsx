"use client";

import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { compactNumber, estimatedModels, fullNumber, hiddenModels, money, preciseMoney, priceLabel, requestJson } from "./lib";
import { LimitFilter, limitKey, useHiddenLimits } from "./limit-filter";
import { AppNav } from "./nav";
import { isDay, PeriodTabs, periodEyebrow, periodLabel, usePeriod } from "./period";

interface Dashboard {
  generatedAt: number;
  lastSync: {
    completedAt: number;
    sourceRecords: number;
    newRecords: number;
    totalRecords: number;
  } | null;
  summary: {
    messageCount: number;
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    cost: number;
    firstMessageAt: number | null;
    lastMessageAt: number | null;
  };
  models: Array<{
    model: string;
    provider: string;
    cost: number;
    effectivePricePerMillion: number | null;
  }>;
  categories: Array<{
    category: string;
    messageCount: number;
    totalTokens: number;
  }>;
  limits: {
    capturedAt: number;
    generatedAt: number | null;
    providers: Array<{
      provider: string;
      account: string | null;
      plan: string | null;
      fetchedAt: number | null;
      windows: Array<{
        id: string;
        label: string;
        unit: string;
        status: string;
        used: number | null;
        limit: number | null;
        remaining: number | null;
        usedFraction: number | null;
        resetsAt: number | null;
      }>;
      notes: string[];
    }>;
  } | null;
}

function isDashboard(value: unknown): value is Dashboard {
  if (!value || typeof value !== "object") return false;
  if (!("summary" in value) || !("models" in value) || !("categories" in value)) return false;
  const summary = value.summary;
  return Boolean(
    summary &&
      typeof summary === "object" &&
      "cost" in summary &&
      typeof summary.cost === "number" &&
      Array.isArray(value.models) &&
      Array.isArray(value.categories),
  );
}

function importWarnings(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || !("warnings" in payload)) return [];
  if (!Array.isArray(payload.warnings)) return [];
  return payload.warnings.filter((entry): entry is string => typeof entry === "string");
}

function formatLimitAmount(value: number | null, unit: string): string {
  if (value === null) return "—";
  if (unit === "usd") return preciseMoney.format(value);
  if (unit === "percent") return `${Math.round(value)}%`;
  return fullNumber.format(value);
}

function limitTone(quota: { status: string; usedFraction: number | null }): string {
  if (quota.status !== "ok") return "critical";
  const used = quota.usedFraction ?? 0;
  if (used >= 0.9) return "critical";
  return used >= 0.7 ? "warn" : "safe";
}

// The window is created once per app launch, so this module is evaluated once
// per launch too: the flag makes the automatic import fire on opening the app
// and never again, not even when the page segment remounts after navigating to
// the projects page and back.
let autoFetched = false;

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const { period } = usePeriod();
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const { hidden, setKeysHidden, showEvery } = useHiddenLimits();

  const loadDashboard = useCallback(async (): Promise<Dashboard> => {
    const payload = await requestJson(`/api/dashboard?period=${period}`);
    if (!isDashboard(payload)) throw new Error("The API returned an invalid dashboard response");
    return payload;
  }, [period]);

  useEffect(() => {
    let active = true;
    setDashboard(null);
    setLoading(true);
    setError(null);
    loadDashboard()
      .then((payload) => {
        if (active) setDashboard(payload);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load the dashboard");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadDashboard]);

  const fetchUsage = useCallback(async () => {
    setImporting(true);
    setError(null);
    setNotice(null);
    setWarnings([]);
    try {
      const payload = await requestJson("/api/import", { method: "POST" });
      setDashboard(await loadDashboard());
      const syncWarnings = importWarnings(payload);
      setWarnings(syncWarnings);
      if (syncWarnings.length === 0) setNotice("Oh My Pi sessions synced, limits refreshed, usage imported.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not import Oh My Pi usage");
    } finally {
      setImporting(false);
    }
  }, [loadDashboard]);

  // Opening the app imports once on its own, so what is on screen is what Oh My
  // Pi has recorded without the button having to be pressed. Every later refresh
  // stays manual. The flag lives outside the component, so a period change or a
  // return from the projects page re-runs this effect without re-importing.
  useEffect(() => {
    if (autoFetched) return;
    autoFetched = true;
    void fetchUsage();
  }, [fetchUsage]);

  const limits = dashboard?.limits ?? null;
  // A card whose every window is hidden has nothing left to say, so it goes too.
  const visibleProviders = (limits?.providers ?? []).flatMap((provider) => {
    const windows = provider.windows.filter(
      (quota) => !hidden[limitKey(provider.provider, provider.account, quota.id)],
    );
    return windows.length === 0 && provider.windows.length > 0 ? [] : [{ ...provider, windows }];
  });
  const models = dashboard?.models.filter((model) => !hiddenModels[model.model]) ?? [];
  const categories = dashboard?.categories ?? [];
  const prices = models.flatMap((model) =>
    model.effectivePricePerMillion === null ? [] : [model.effectivePricePerMillion],
  );
  const priciest = prices.length === 0 ? 0 : Math.max(...prices);
  const cheapest = prices.length === 0 ? 0 : Math.min(...prices);
  // Extremes are only worth calling out when there is something to compare against.
  const rankable = prices.length > 1 && priciest > cheapest;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brandMark">TT</div>
          <div>
            <p className="eyebrow">LOCAL USAGE</p>
            <h1>Token Tracker</h1>
          </div>
        </div>
        <div className="headerActions">
          <div className="syncMeta">
            <span className="statusDot" />
            {dashboard?.lastSync
              ? `Last fetched ${new Date(dashboard.lastSync.completedAt).toLocaleString()}`
              : "Not fetched yet"}
          </div>
          <button className="fetchButton" type="button" onClick={fetchUsage} disabled={loading || importing}>
            {importing ? "Fetching…" : "Fetch Oh My Pi data"}
          </button>
        </div>
      </header>

      <div className="controlBar">
        <AppNav />
        <PeriodTabs disabled={importing} />
      </div>

      {error && <div className="alert errorAlert">{error}</div>}
      {notice && <div className="alert successAlert">{notice}</div>}
      {warnings.map((entry) => (
        <div className="alert warningAlert" key={entry}>{entry}</div>
      ))}

      {loading ? (
        <section className="emptyState"><div className="spinner" /><p>Loading saved usage…</p></section>
      ) : !dashboard ? (
        <section className="emptyState">
          <p className="emptyKicker">USAGE UNAVAILABLE</p>
          <h2>Could not load this period.</h2>
          <p>Use the fetch button above to update the saved data and try again.</p>
        </section>
      ) : dashboard.summary.messageCount === 0 ? (
        <section className="emptyState">
          <p className="emptyKicker">NO USAGE THIS PERIOD</p>
          <h2>No usage recorded for {periodLabel(period)}.</h2>
          <p>Fetch reads <code>~/.omp/stats.db</code> and updates the saved snapshot in this app.</p>
          <button className="fetchButton large" type="button" onClick={fetchUsage} disabled={importing}>
            {importing ? "Fetching…" : "Fetch usage now"}
          </button>
        </section>
      ) : (
        <>
          <section className="hero">
            <div>
              <p className="eyebrow">{periodEyebrow(period)}</p>
              <div className="totalSpend">{money.format(dashboard.summary.cost)}</div>
              <p className="range">
                {isDay(period)
                  ? periodLabel(period)
                  : period === "today"
                    ? `Today · ${new Date(dashboard.generatedAt).toLocaleDateString()}`
                    : period === "month"
                      ? new Date(dashboard.generatedAt).toLocaleDateString(undefined, { month: "long", year: "numeric" })
                      : dashboard.summary.firstMessageAt
                        ? `${new Date(dashboard.summary.firstMessageAt).toLocaleDateString()} — ${new Date(dashboard.summary.lastMessageAt ?? dashboard.generatedAt).toLocaleDateString()}`
                        : "No dated messages"}
              </p>
            </div>
            <div className="heroNote">
              Oh My Pi recorded costs are used when available. MiniMax-M3 and Kimi K2.6 are billed as free by Ollama Cloud, so they are estimated from official standard pay-as-you-go rates; MiniMax rates double above 512k input tokens.
            </div>
          </section>

          <section className="statGrid" aria-label="Usage summary">
            <article className="statCard">
              <span>Total tokens</span>
              <strong>{compactNumber.format(dashboard.summary.totalTokens)}</strong>
              <small>{fullNumber.format(dashboard.summary.totalTokens)} processed</small>
            </article>
            <article className="statCard">
              <span>Messages</span>
              <strong>{compactNumber.format(dashboard.summary.messageCount)}</strong>
              <small>model responses</small>
            </article>
            <article className="statCard">
              <span>Sessions</span>
              <strong>{fullNumber.format(dashboard.summary.sessionCount)}</strong>
              <small>across all workspaces</small>
            </article>
            <article className="statCard">
              <span>Cache reads</span>
              <strong>{compactNumber.format(dashboard.summary.cacheReadTokens)}</strong>
              <small>{compactNumber.format(dashboard.summary.cacheWriteTokens)} cache writes</small>
            </article>
          </section>
          <section className="panel sectionPanel">
            <div className="panelHeading">
              <div><p className="eyebrow">TOKEN CATEGORIES</p><h2>What the tokens worked on</h2></div>
              <span>ESTIMATED FROM USER REQUESTS</span>
            </div>
            <div className="categoryGrid">
              {categories.map((category, index) => {
                const share = dashboard.summary.totalTokens
                  ? (category.totalTokens / dashboard.summary.totalTokens) * 100
                  : 0;
                return (
                  <article className={`categoryCard tone${index % 4}`} key={category.category}>
                    <div className="categoryCardTop">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{share.toFixed(1)}%</strong>
                    </div>
                    <h3>{category.category}</h3>
                    <p>{compactNumber.format(category.totalTokens)} tokens · {fullNumber.format(category.messageCount)} messages</p>
                    <div className="categoryTrack" aria-hidden="true">
                      <div style={{ width: `${share}%` }} />
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {/* Quotas are a single live reading from each provider, so they say nothing
              about a day that has already passed. */}
          {!isDay(period) && (
            <section className="panel sectionPanel" aria-label="Provider limits">
              <div className="panelHeading">
                <div><p className="eyebrow">PROVIDER QUOTAS</p><h2>Account limits</h2></div>
                <div className="panelHeadingSide">
                  <span>{limits ? `Read ${new Date(limits.capturedAt).toLocaleString()}` : "Not read yet"}</span>
                  {limits && limits.providers.length > 0 && (
                    <LimitFilter
                      providers={limits.providers}
                      hidden={hidden}
                      setKeysHidden={setKeysHidden}
                      showEvery={showEvery}
                    />
                  )}
                </div>
              </div>
              {!limits || limits.providers.length === 0 ? (
                <p className="limitNote">No authenticated accounts reported limits. Fetch reads <code>omp usage --json</code>.</p>
              ) : visibleProviders.length === 0 ? (
                <p className="limitNote">Every quota is hidden. Use <em>Visible limits</em> above to bring some back.</p>
              ) : (
                <div className="limitGrid">
                  {visibleProviders.map((provider) => (
                    <article className="limitCard" key={`${provider.provider}/${provider.account ?? "default"}`}>
                      <div className="limitCardTop">
                        <strong>{provider.provider}</strong>
                        {provider.plan && <span className="limitPlan">{provider.plan}</span>}
                      </div>
                      <small>{provider.account ?? "single account"}</small>
                      {provider.windows.length === 0 ? (
                        <p className="limitNote">{provider.notes[0] ?? "This provider exposes no quota API."}</p>
                      ) : (
                        <div className="limitRows">
                          {provider.windows.map((quota) => {
                            const tone = limitTone(quota);
                            const share = quota.usedFraction === null
                              ? 0
                              : Math.min(100, Math.max(0, quota.usedFraction * 100));
                            return (
                              <div className="limitRow" key={quota.id}>
                                <div className="limitRowTop">
                                  <span>{quota.label}</span>
                                  <strong className={tone}>
                                    {formatLimitAmount(quota.used, quota.unit)}
                                    {quota.limit === null ? "" : ` / ${formatLimitAmount(quota.limit, quota.unit)}`}
                                  </strong>
                                </div>
                                <div className="limitTrack">
                                  <div className={`limitFill ${tone}`} style={{ width: `${share}%` }} />
                                </div>
                                <small>
                                  {quota.remaining === null ? "" : `${formatLimitAmount(quota.remaining, quota.unit)} left`}
                                  {quota.resetsAt === null ? "" : ` · resets ${new Date(quota.resetsAt).toLocaleString()}`}
                                  {quota.status === "ok" ? "" : ` · ${quota.status}`}
                                </small>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="panel sectionPanel">
            <div className="panelHeading">
              <div><p className="eyebrow">MODEL ECONOMICS</p><h2>Usage and effective price</h2></div>
              <span>RING = SHARE OF SPEND · BAR = PRICE VS PRICIEST</span>
            </div>
            <div className="modelDeck">
              {models.map((model, index) => {
                const price = model.effectivePricePerMillion;
                const label = priceLabel(price);
                const share = dashboard.summary.cost ? (model.cost / dashboard.summary.cost) * 100 : 0;
                const priceShare = priciest > 0 && price !== null ? (price / priciest) * 100 : 0;
                const badge = !rankable || price === null
                  ? null
                  : price === priciest
                    ? "Priciest"
                    : price === cheapest
                      ? "Best value"
                      : null;
                return (
                  <article className={`modelCard tone${index % 4}`} key={`${model.provider}/${model.model}`}>
                    <div className="modelCardTop">
                      <span className="modelRank">{String(index + 1).padStart(2, "0")}</span>
                      {badge && <span className="modelBadge">{badge}</span>}
                    </div>

                    <div className="modelRing" style={{ "--share": share } as CSSProperties}>
                      <div className="modelRingTrack" />
                      <div className="modelRingValue">
                        <strong>{label.value}</strong>
                        <small>{label.caption}</small>
                      </div>
                    </div>

                    <h3>{model.model}</h3>
                    <p className="modelProvider">
                      {model.provider}
                      {estimatedModels[model.model.toLowerCase()] ? " · estimated" : ""}
                    </p>

                    <div className="modelSpend">
                      <strong>{money.format(model.cost)}</strong>
                      {share >= 0.05 && <span>{share.toFixed(1)}% of spend</span>}
                    </div>

                    <div className="priceMeter" aria-hidden="true">
                      <div style={{ width: `${priceShare}%` }} />
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
