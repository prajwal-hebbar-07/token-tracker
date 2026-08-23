"use client";

import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { compactNumber, estimatedModels, fullNumber, hiddenModels, money, preciseMoney, priceLabel, requestJson } from "./lib";
import { LimitFilter, limitKey, useHiddenLimits } from "./limit-filter";
import { AppNav } from "./nav";
import { isDay, PeriodTabs, periodEyebrow, periodLabel, usePeriod } from "./period";

interface ModelsReport {
  generatedAt: number;
  models: Array<{
    model: string;
    provider: string;
    cost: number;
    effectivePricePerMillion: number | null;
  }>;
}

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
  if (!("summary" in value) || !("categories" in value)) return false;
  const summary = value.summary;
  return Boolean(
    summary &&
      typeof summary === "object" &&
      "cost" in summary &&
      typeof summary.cost === "number" &&
      Array.isArray(value.categories),
  );
}

function isModelsReport(value: unknown): value is ModelsReport {
  if (!value || typeof value !== "object") return false;
  if (!("models" in value) || !Array.isArray(value.models)) return false;
  return value.models.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (
      "model" in entry &&
      typeof entry.model === "string" &&
      "provider" in entry &&
      typeof entry.provider === "string" &&
      "cost" in entry &&
      typeof entry.cost === "number"
    );
  });
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

type ImportStage = "sessions" | "usage" | "limits";
type StageStatus = { state: "idle" | "loading" | "done" | "error"; message: string | null };

const STAGE_ORDER: ImportStage[] = ["sessions", "usage", "limits"];
const STAGE_LABEL: Record<ImportStage, string> = {
  sessions: "Sync Oh My Pi sessions",
  usage: "Import usage",
  limits: "Read provider limits",
};

function HeroSkeleton() {
  return (
    <section className="hero">
      <div className="heroSkeleton">
        <div className="skeleton skeletonText" style={{ width: 110, marginBottom: 10 }} />
        <div className="skeleton skeletonBig" style={{ width: 280, height: 72, marginBottom: 14 }} />
        <div className="skeleton skeletonText" style={{ width: 180 }} />
      </div>
      <div className="skeleton heroNoteSkeleton" />
    </section>
  );
}

function StatGridSkeleton() {
  return (
    <section className="statGrid" aria-label="Usage summary">
      {[1, 2, 3, 4].map((i) => (
        <article className="statCard" key={i}>
          <div className="skeleton skeletonText" style={{ width: "70%" }} />
          <div className="skeleton skeletonNumber" style={{ width: "55%", marginTop: 8 }} />
          <div className="skeleton skeletonText" style={{ width: "80%", marginTop: 6 }} />
        </article>
      ))}
    </section>
  );
}

function CategoryGridSkeleton() {
  return (
    <section className="panel sectionPanel">
      <div className="panelHeading">
        <div>
          <div className="skeleton skeletonText" style={{ width: 120, marginBottom: 8 }} />
          <div className="skeleton skeletonText" style={{ width: 220, height: 18 }} />
        </div>
        <div className="skeleton skeletonText" style={{ width: 160 }} />
      </div>
      <div className="categoryGrid">
        {[1, 2, 3, 4].map((i) => (
          <article className="categoryCard" key={i}>
            <div className="categoryCardTop">
              <div className="skeleton skeletonText" style={{ width: 28 }} />
              <div className="skeleton skeletonText" style={{ width: 44 }} />
            </div>
            <div className="skeleton skeletonText" style={{ width: "75%", marginTop: 12 }} />
            <div className="skeleton skeletonText" style={{ width: "60%", marginTop: 8 }} />
            <div className="categoryTrack" aria-hidden="true">
              <div className="skeleton" style={{ width: "50%", height: 6, borderRadius: 3 }} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function LimitsSkeleton() {
  return (
    <section className="panel sectionPanel" aria-label="Provider limits">
      <div className="panelHeading">
        <div>
          <div className="skeleton skeletonText" style={{ width: 110, marginBottom: 8 }} />
          <div className="skeleton skeletonText" style={{ width: 140, height: 18 }} />
        </div>
        <div className="skeleton skeletonText" style={{ width: 160 }} />
      </div>
      <div className="limitGrid">
        <article className="limitCard">
          <div className="limitCardTop">
            <div className="skeleton skeletonText" style={{ width: 90 }} />
            <div className="skeleton skeletonText" style={{ width: 60 }} />
          </div>
          <div className="skeleton skeletonText" style={{ width: 110, marginTop: 4 }} />
          <div className="limitRows">
            {[1, 2].map((i) => (
              <div className="limitRow" key={i}>
                <div className="limitRowTop">
                  <div className="skeleton skeletonText" style={{ width: 100 }} />
                  <div className="skeleton skeletonText" style={{ width: 80 }} />
                </div>
                <div className="limitTrack">
                  <div className="skeleton" style={{ width: "40%", height: 6, borderRadius: 3 }} />
                </div>
                <div className="skeleton skeletonText" style={{ width: 120, marginTop: 4 }} />
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

function ModelDeckSkeleton() {
  return (
    <section className="panel sectionPanel">
      <div className="panelHeading">
        <div>
          <div className="skeleton skeletonText" style={{ width: 120, marginBottom: 8 }} />
          <div className="skeleton skeletonText" style={{ width: 200, height: 18 }} />
        </div>
        <div className="skeleton skeletonText" style={{ width: 200 }} />
      </div>
      <div className="modelDeck">
        {[1, 2, 3, 4].map((i) => (
          <article className="modelCard" key={i}>
            <div className="modelCardTop">
              <div className="skeleton skeletonText" style={{ width: 28 }} />
            </div>
            <div className="skeleton modelRingSkeleton" />
            <div className="skeleton skeletonText" style={{ width: "70%", marginTop: 14 }} />
            <div className="skeleton skeletonText" style={{ width: "50%", marginTop: 6 }} />
            <div className="skeleton skeletonText" style={{ width: "45%", marginTop: 14 }} />
            <div className="priceMeter" aria-hidden="true">
              <div className="skeleton" style={{ width: "60%", height: 6, borderRadius: 3 }} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <HeroSkeleton />
      <StatGridSkeleton />
      <CategoryGridSkeleton />
      <LimitsSkeleton />
    </>
  );
}

// The window is created once per app launch, so this module is evaluated once
// per launch too: the flag makes the automatic import fire on opening the app
// and never again, not even when the page segment remounts after navigating to
// the projects page and back.
let autoFetched = false;

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [modelsReport, setModelsReport] = useState<ModelsReport | null>(null);
  const { period } = usePeriod();
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const { hidden, setKeysHidden, showEvery } = useHiddenLimits();

  const [stages, setStages] = useState<Record<ImportStage, StageStatus>>({
    sessions: { state: "idle", message: null },
    usage: { state: "idle", message: null },
    limits: { state: "idle", message: null },
  });

  const resetStages = useCallback(() => {
    setStages({
      sessions: { state: "idle", message: null },
      usage: { state: "idle", message: null },
      limits: { state: "idle", message: null },
    });
  }, []);

  const setStage = useCallback((stage: ImportStage, status: StageStatus) => {
    setStages((current) => ({ ...current, [stage]: status }));
  }, []);

  const loadDashboard = useCallback(async (): Promise<Dashboard> => {
    const payload = await requestJson(`/api/dashboard?period=${period}`);
    if (!isDashboard(payload)) throw new Error("The API returned an invalid dashboard response");
    return payload;
  }, [period]);

  const loadModels = useCallback(async (): Promise<ModelsReport> => {
    const payload = await requestJson(`/api/models?period=${period}`);
    if (!isModelsReport(payload)) throw new Error("The API returned an invalid models response");
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

  useEffect(() => {
    let active = true;
    setModelsReport(null);
    setModelsLoading(true);
    loadModels()
      .then((payload) => {
        if (active) setModelsReport(payload);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load the model matrix");
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadModels]);

  const fetchUsage = useCallback(async () => {
    setImporting(true);
    setError(null);
    setNotice(null);
    setWarnings([]);
    resetStages();
    let accumulatedWarnings: string[] = [];
    let failedStage: ImportStage | null = null;
    try {
      for (const stage of STAGE_ORDER) {
        failedStage = stage;
        setStage(stage, { state: "loading", message: null });
        const payload = await requestJson(`/api/import?stage=${stage}`, { method: "POST" });
        const stageWarnings = importWarnings(payload);
        accumulatedWarnings.push(...stageWarnings);
        setStage(stage, { state: "done", message: null });
        // Refresh the dashboard and model matrix as soon as usage lands so the
        // numbers appear incrementally instead of waiting for the whole pipeline.
        if (stage === "usage") {
          setDashboard(await loadDashboard());
          setModelsReport(await loadModels());
        }
        if (stage === "limits") {
          setDashboard(await loadDashboard());
        }
      }
      failedStage = null;
      setWarnings(accumulatedWarnings);
      if (accumulatedWarnings.length === 0) {
        setNotice("Oh My Pi sessions synced, limits refreshed, usage imported.");
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not import Oh My Pi usage";
      if (failedStage !== null) {
        setStage(failedStage, { state: "error", message });
      }
      setError(message);
    } finally {
      setImporting(false);
    }
  }, [loadDashboard, loadModels, resetStages, setStage]);

  // Opening the app imports once on its own, so what is on screen is what Oh My
  // Pi has recorded without the button having to be pressed. Every later refresh
  // stays manual. The flag lives outside the component, so a period change or a
  // return from the projects page re-runs this effect without re-importing.
  useEffect(() => {
    if (autoFetched) return;
    autoFetched = true;
    void fetchUsage();
  }, [fetchUsage]);
  // Command/Ctrl+R reloads the data from Oh My Pi instead of reloading the page,
  // so the keyboard shortcut runs the same fetch pipeline as the button.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || (event.key !== "r" && event.key !== "R")) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      if (importing) return;
      void fetchUsage();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fetchUsage, importing]);

  const limits = dashboard?.limits ?? null;
  // A card whose every window is hidden has nothing left to say, so it goes too.
  const visibleProviders = (limits?.providers ?? []).flatMap((provider) => {
    const windows = provider.windows.filter(
      (quota) => !hidden[limitKey(provider.provider, provider.account, quota.id)],
    );
    return windows.length === 0 && provider.windows.length > 0 ? [] : [{ ...provider, windows }];
  });
  const models = modelsReport?.models.filter((model) => !hiddenModels[model.model]) ?? [];
  const categories = dashboard?.categories ?? [];
  const prices = models.flatMap((model) =>
    model.effectivePricePerMillion === null ? [] : [model.effectivePricePerMillion],
  );
  const priciest = prices.length === 0 ? 0 : Math.max(...prices);
  const cheapest = prices.length === 0 ? 0 : Math.min(...prices);
  // Extremes are only worth calling out when there is something to compare against.
  const rankable = prices.length > 1 && priciest > cheapest;

  const usageReady = !importing || stages.usage.state === "done";
  const limitsReady = !importing || stages.limits.state === "done";
  const modelsReady = modelsReport !== null;
  const showSkeletonDashboard = importing && !usageReady;

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
      {importing && (
        <div className="fetchStatus" aria-live="polite" aria-busy="true">
          <span className="spinner" />
          <span>
            {STAGE_LABEL[STAGE_ORDER.find((stage) => stages[stage].state === "loading") ?? "sessions"]}…
          </span>
        </div>
      )}
      {warnings.map((entry) => (
        <div className="alert warningAlert" key={entry}>{entry}</div>
      ))}

      {loading ? (
        <section className="emptyState"><div className="spinner" /><p>Loading saved usage…</p></section>
      ) : showSkeletonDashboard ? (
        <DashboardSkeleton />
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
              Oh My Pi recorded costs are used when available. MiniMax-M3, Kimi K2.6, and Kimi K3 are billed as free by Ollama Cloud, so they are estimated from official standard pay-as-you-go rates; MiniMax rates double above 512k input tokens.
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
            limitsReady ? (
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
            ) : (
              <LimitsSkeleton />
            )
          )}

          {modelsReady ? (
            <section className="panel sectionPanel">
              <div className="panelHeading">
                <div><p className="eyebrow">MODEL ECONOMICS</p><h2>Usage and effective price</h2></div>
                <span>RING = SHARE OF SPEND · BAR = PRICE VS PRICIEST</span>
              </div>
              <div className="modelDeck">
                {models.map((model, index) => {
                  const price = model.effectivePricePerMillion;
                  const label = priceLabel(price);
                  const share = dashboard?.summary.cost ? (model.cost / dashboard.summary.cost) * 100 : 0;
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
          ) : (
            <ModelDeckSkeleton />
          )}
        </>
      )}
    </main>
  );
}
