"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Aggregate {
  messageCount: number;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  cost: number;
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
  models: Array<Aggregate & {
    model: string;
    provider: string;
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    cacheReadPricePerMillion: number | null;
    cacheWritePricePerMillion: number | null;
  }>;
  workspaces: Array<Aggregate & { folder: string }>;
  agents: Array<Aggregate & { agentType: string }>;
  categories: Array<Aggregate & { category: string }>;
  daily: Array<{ day: string; cost: number; messages: number; tokens: number }>;
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const preciseMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fullNumber = new Intl.NumberFormat("en-US");

function isDashboard(value: unknown): value is Dashboard {
  if (!value || typeof value !== "object") return false;
  if (
    !("summary" in value) ||
    !("models" in value) ||
    !("workspaces" in value) ||
    !("agents" in value) ||
    !("categories" in value) ||
    !("daily" in value)
  ) {
    return false;
  }
  const summary = value.summary;
  return Boolean(
    summary &&
      typeof summary === "object" &&
      "cost" in summary &&
      typeof summary.cost === "number" &&
      Array.isArray(value.models) &&
      Array.isArray(value.workspaces) &&
      Array.isArray(value.agents) &&
      Array.isArray(value.categories) &&
      Array.isArray(value.daily),
  );
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const payload: unknown = await response.json();
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
      message = payload.error;
    }
    throw new Error(message);
  }
  return payload;
}

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    const payload = await requestJson("/api/dashboard");
    if (!isDashboard(payload)) throw new Error("The API returned an invalid dashboard response");
    setDashboard(payload);
  }, []);

  useEffect(() => {
    let active = true;
    loadDashboard()
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
    try {
      await requestJson("/api/import", { method: "POST" });
      await loadDashboard();
      setNotice("Oh My Pi usage imported successfully.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not import Oh My Pi usage");
    } finally {
      setImporting(false);
    }
  }, [loadDashboard]);

  const recentDays = dashboard?.daily.slice(-14) ?? [];
  const maxDailyCost = Math.max(0, ...recentDays.map((day) => day.cost));
  const costParts = useMemo(() => {
    if (!dashboard) return [];
    const input = dashboard.models.reduce((sum, model) => sum + model.inputCost, 0);
    const output = dashboard.models.reduce((sum, model) => sum + model.outputCost, 0);
    const cacheRead = dashboard.models.reduce((sum, model) => sum + model.cacheReadCost, 0);
    const cacheWrite = dashboard.models.reduce((sum, model) => sum + model.cacheWriteCost, 0);
    return [
      { label: "Input", value: input, tone: "violet" },
      { label: "Output", value: output, tone: "orange" },
      { label: "Cache read", value: cacheRead, tone: "cyan" },
      { label: "Cache write", value: cacheWrite, tone: "lime" },
    ];
  }, [dashboard]);

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
          <button className="fetchButton" type="button" onClick={fetchUsage} disabled={importing}>
            {importing ? "Fetching…" : "Fetch Oh My Pi data"}
          </button>
        </div>
      </header>

      {error && <div className="alert errorAlert">{error}</div>}
      {notice && <div className="alert successAlert">{notice}</div>}

      {loading ? (
        <section className="emptyState"><div className="spinner" /><p>Loading saved usage…</p></section>
      ) : !dashboard || dashboard.summary.messageCount === 0 ? (
        <section className="emptyState">
          <p className="emptyKicker">NO SAVED USAGE</p>
          <h2>Your local ledger is empty.</h2>
          <p>Fetch reads <code>~/.omp/stats.db</code> once and saves a snapshot in this app. Nothing runs in the background.</p>
          <button className="fetchButton large" type="button" onClick={fetchUsage} disabled={importing}>
            {importing ? "Fetching…" : "Fetch usage now"}
          </button>
        </section>
      ) : (
        <>
          <section className="hero">
            <div>
              <p className="eyebrow">RECORDED SPEND</p>
              <div className="totalSpend">{money.format(dashboard.summary.cost)}</div>
              <p className="range">
                {dashboard.summary.firstMessageAt
                  ? `${new Date(dashboard.summary.firstMessageAt).toLocaleDateString()} — ${new Date(dashboard.summary.lastMessageAt ?? dashboard.generatedAt).toLocaleDateString()}`
                  : "No dated messages"}
              </p>
            </div>
            <div className="heroNote">
              Oh My Pi recorded costs are used when available. MiniMax-M3 is estimated from official standard pay-as-you-go rates, which double above 512k input tokens.
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

          <section className="splitGrid">
            <article className="panel">
              <div className="panelHeading">
                <div><p className="eyebrow">LAST 14 ACTIVE DAYS</p><h2>Daily spend</h2></div>
                <span>{recentDays.length} days</span>
              </div>
              <div className="barChart">
                {recentDays.map((day) => (
                  <div className="barRow" key={day.day}>
                    <time dateTime={day.day}>{new Date(`${day.day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>
                    <div className="barTrack"><div className="barFill" style={{ width: `${maxDailyCost ? Math.max(2, (day.cost / maxDailyCost) * 100) : 0}%` }} /></div>
                    <strong>{money.format(day.cost)}</strong>
                  </div>
                ))}
              </div>
            </article>

            <article className="panel">
              <div className="panelHeading"><div><p className="eyebrow">BILLING MIX</p><h2>Where cost came from</h2></div></div>
              <div className="costList">
                {costParts.map((part) => {
                  const share = dashboard.summary.cost ? (part.value / dashboard.summary.cost) * 100 : 0;
                  return (
                    <div className="costItem" key={part.label}>
                      <div className="costLabel"><span className={`legend ${part.tone}`} />{part.label}<strong>{money.format(part.value)}</strong></div>
                      <div className="shareTrack"><div className={`shareFill ${part.tone}`} style={{ width: `${share}%` }} /></div>
                      <small>{share.toFixed(1)}% of spend</small>
                    </div>
                  );
                })}
              </div>
            </article>
          </section>

          <section className="panel sectionPanel">
            <div className="panelHeading">
              <div><p className="eyebrow">WORK CATEGORIES</p><h2>Spend by activity</h2></div>
              <span>Estimated from user requests</span>
            </div>
            <div className="categoryGrid">
              {dashboard.categories.map((category, index) => {
                const share = dashboard.summary.cost
                  ? (category.cost / dashboard.summary.cost) * 100
                  : 0;
                return (
                  <article className="categoryCard" key={category.category}>
                    <div className="categoryTop">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{money.format(category.cost)}</strong>
                    </div>
                    <h3>{category.category}</h3>
                    <p>{fullNumber.format(category.messageCount)} messages · {compactNumber.format(category.totalTokens)} tokens</p>
                    <div className="categoryTrack">
                      <div style={{ width: `${share}%` }} />
                    </div>
                    <small>{share.toFixed(1)}% of total spend</small>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="panel sectionPanel">
            <div className="panelHeading">
              <div><p className="eyebrow">MODEL ECONOMICS</p><h2>Usage and effective price</h2></div>
              <span>USD per 1M tokens</span>
            </div>
            <div className="tableWrap">
              <table>
                <thead><tr><th>Model</th><th>Spend</th><th>Tokens</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th></tr></thead>
                <tbody>
                  {dashboard.models.map((model) => (
                    <tr key={`${model.provider}/${model.model}`}>
                      <td>
                        <strong>{model.model}</strong>
                        <small>
                          {model.provider}
                          {model.model.toLowerCase() === "minimax-m3" ? " · MiniMax estimate" : ""}
                        </small>
                      </td>
                      <td className="moneyCell">{money.format(model.cost)}</td>
                      <td>{compactNumber.format(model.totalTokens)}<small>{fullNumber.format(model.messageCount)} messages</small></td>
                      <td>{model.inputPricePerMillion === null ? "—" : preciseMoney.format(model.inputPricePerMillion)}</td>
                      <td>{model.outputPricePerMillion === null ? "—" : preciseMoney.format(model.outputPricePerMillion)}</td>
                      <td>{model.cacheReadPricePerMillion === null ? "—" : preciseMoney.format(model.cacheReadPricePerMillion)}</td>
                      <td>{model.cacheWritePricePerMillion === null ? "—" : preciseMoney.format(model.cacheWritePricePerMillion)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="splitGrid lowerGrid">
            <article className="panel">
              <div className="panelHeading"><div><p className="eyebrow">WORKSPACES</p><h2>Spend by project</h2></div><span>{dashboard.workspaces.length} tracked</span></div>
              <div className="rankList">
                {dashboard.workspaces.map((workspace, index) => (
                  <div className="rankRow" key={workspace.folder}>
                    <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                    <div className="rankName"><strong>{workspace.folder.replace(/^-/, "").replaceAll("-", " · ")}</strong><small>{workspace.sessionCount} sessions · {compactNumber.format(workspace.totalTokens)} tokens</small></div>
                    <div className="rankSpend"><strong>{money.format(workspace.cost)}</strong><small>{dashboard.summary.cost ? ((workspace.cost / dashboard.summary.cost) * 100).toFixed(1) : "0.0"}%</small></div>
                  </div>
                ))}
              </div>
            </article>

            <article className="panel">
              <div className="panelHeading"><div><p className="eyebrow">PROCESSES</p><h2>Spend by agent type</h2></div></div>
              <div className="agentGrid">
                {dashboard.agents.map((agent) => (
                  <div className="agentCard" key={agent.agentType}>
                    <span>{agent.agentType.replaceAll("_", " ")}</span>
                    <strong>{money.format(agent.cost)}</strong>
                    <small>{fullNumber.format(agent.messageCount)} messages · {compactNumber.format(agent.totalTokens)} tokens</small>
                  </div>
                ))}
              </div>
            </article>
          </section>
        </>
      )}
    </main>
  );
}
