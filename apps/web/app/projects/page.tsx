"use client";

import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { compactNumber, fullNumber, hiddenModels, money, priceLabel, requestJson } from "../lib";
import { AppNav } from "../nav";
import { type Period, PeriodTabs, usePeriod } from "../period";

interface ProjectsReport {
  generatedAt: number;
  period: Period;
  totals: {
    cost: number;
    totalTokens: number;
    messageCount: number;
    sessionCount: number;
    projectCount: number;
  };
  models: Array<{
    model: string;
    provider: string;
    cost: number;
    totalTokens: number;
  }>;
  projects: Array<{
    folder: string;
    name: string;
    cost: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    messageCount: number;
    sessionCount: number;
    firstMessageAt: number | null;
    lastMessageAt: number | null;
    effectivePricePerMillion: number | null;
    models: Array<{
      model: string;
      provider: string;
      cost: number;
      totalTokens: number;
      messageCount: number;
    }>;
  }>;
}

const eyebrows: Record<Period, string> = {
  today: "TODAY'S SPEND BY PROJECT",
  month: "CURRENT MONTH SPEND BY PROJECT",
  all: "ALL-TIME SPEND BY PROJECT",
};

function isProjectsReport(value: unknown): value is ProjectsReport {
  if (!value || typeof value !== "object") return false;
  if (!("totals" in value) || !("projects" in value) || !("models" in value)) return false;
  const totals = value.totals;
  return Boolean(
    totals &&
      typeof totals === "object" &&
      "cost" in totals &&
      typeof totals.cost === "number" &&
      Array.isArray(value.projects) &&
      Array.isArray(value.models),
  );
}

function lastActive(timestamp: number | null): string {
  if (timestamp === null) return "no dated messages";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "active today";
  if (days === 1) return "active yesterday";
  if (days < 30) return `active ${days} days ago`;
  return `last active ${new Date(timestamp).toLocaleDateString()}`;
}

export default function ProjectsPage() {
  const [report, setReport] = useState<ProjectsReport | null>(null);
  const { period } = usePeriod();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async (): Promise<ProjectsReport> => {
    const payload = await requestJson(`/api/projects?period=${period}`);
    if (!isProjectsReport(payload)) throw new Error("The API returned an invalid projects response");
    return payload;
  }, [period]);

  useEffect(() => {
    let active = true;
    setReport(null);
    setLoading(true);
    setError(null);
    loadProjects()
      .then((payload) => {
        if (active) setReport(payload);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load the projects");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadProjects]);

  // One tone per model across the whole page, so a colour means the same model on
  // every card. Ordering comes from the report, which is sorted by spend.
  const toneByModel: Record<string, number> = {};
  (report?.models ?? [])
    .filter((entry) => !hiddenModels[entry.model])
    .forEach((entry, index) => {
      toneByModel[entry.model] = index % 4;
    });
  const legend = report?.models.filter((entry) => !hiddenModels[entry.model]) ?? [];
  const projects = report?.projects ?? [];
  const busiest = projects.length === 0 ? 0 : Math.max(...projects.map((project) => project.cost));

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
            {report ? `${fullNumber.format(report.totals.projectCount)} projects tracked` : "Not loaded yet"}
          </div>
        </div>
      </header>

      <div className="controlBar">
        <AppNav />
        <PeriodTabs />
      </div>

      {error && <div className="alert errorAlert">{error}</div>}

      {loading ? (
        <section className="emptyState"><div className="spinner" /><p>Loading project usage…</p></section>
      ) : !report ? (
        <section className="emptyState">
          <p className="emptyKicker">PROJECTS UNAVAILABLE</p>
          <h2>Could not load this period.</h2>
          <p>Fetch new data from the dashboard, then come back.</p>
        </section>
      ) : projects.length === 0 ? (
        <section className="emptyState">
          <p className="emptyKicker">NO PROJECTS THIS PERIOD</p>
          <h2>No project recorded usage for {period === "today" ? "today" : period === "month" ? "this month" : "all time"}.</h2>
          <p>A project is the working directory Oh My Pi recorded for each session.</p>
        </section>
      ) : (
        <>
          <section className="hero">
            <div>
              <p className="eyebrow">{eyebrows[period]}</p>
              <div className="totalSpend">{money.format(report.totals.cost)}</div>
              <p className="range">
                {fullNumber.format(report.totals.projectCount)} projects ·{" "}
                {fullNumber.format(report.totals.sessionCount)} sessions ·{" "}
                {compactNumber.format(report.totals.totalTokens)} tokens
              </p>
            </div>
            <div className="heroNote">
              A project is the working directory Oh My Pi recorded for the session. Every card below
              carries its own model split, so nothing needs to be opened to read it.
            </div>
          </section>

          <section className="panel sectionPanel" aria-label="Spend distribution">
            <div className="panelHeading">
              <div><p className="eyebrow">SPEND DISTRIBUTION</p><h2>Where the money went</h2></div>
              <span>EVERY PROJECT, ONE BAR</span>
            </div>
            <div className="projectSplit" aria-hidden="true">
              {projects.map((project, index) => {
                const share = report.totals.cost ? (project.cost / report.totals.cost) * 100 : 0;
                if (share <= 0) return null;
                return (
                  <div
                    className={`projectSplitSeg tone${index % 4}`}
                    key={project.folder}
                    style={{ width: `${share}%` }}
                    title={`${project.name} · ${money.format(project.cost)}`}
                  />
                );
              })}
            </div>
            <div className="projectSplitKeys">
              {projects.slice(0, 6).map((project, index) => (
                <span className={`projectSplitKey tone${index % 4}`} key={project.folder}>
                  {project.name} · {money.format(project.cost)}
                </span>
              ))}
              {projects.length > 6 && (
                <span className="projectSplitKey muted">+{projects.length - 6} smaller</span>
              )}
            </div>
          </section>

          <section className="panel sectionPanel">
            <div className="panelHeading">
              <div><p className="eyebrow">MODEL LEGEND</p><h2>Models in use this period</h2></div>
              <span>COLOURS MATCH THE SPLIT BARS BELOW</span>
            </div>
            <div className="modelLegend">
              {legend.map((entry) => (
                <span className={`modelLegendItem tone${toneByModel[entry.model] ?? 0}`} key={`${entry.provider}/${entry.model}`}>
                  <i />
                  <strong>{entry.model}</strong>
                  <small>{money.format(entry.cost)}</small>
                </span>
              ))}
            </div>
          </section>

          <section className="panel sectionPanel">
            <div className="panelHeading">
              <div><p className="eyebrow">PROJECT ECONOMICS</p><h2>What each project used and spent</h2></div>
              <span>RING = SHARE OF SPEND · BAR = MODEL SPLIT</span>
            </div>
            <div className="projectGrid">
              {projects.map((project, index) => {
                const share = report.totals.cost ? (project.cost / report.totals.cost) * 100 : 0;
                const label = priceLabel(project.effectivePricePerMillion);
                const visibleModels = project.models.filter((entry) => !hiddenModels[entry.model]);
                const modelTotal = visibleModels.reduce((sum, entry) => sum + entry.cost, 0);
                return (
                  <article className={`projectCard tone${index % 4}`} key={project.folder}>
                    <div className="projectCardTop">
                      <span className="projectRank">{String(index + 1).padStart(2, "0")}</span>
                      {project.cost === busiest && projects.length > 1 && (
                        <span className="modelBadge">Top spend</span>
                      )}
                    </div>

                    <h3 className="projectName" title={project.folder}>{project.name}</h3>
                    <p className="projectMeta">{lastActive(project.lastMessageAt)}</p>

                    <div className="projectHeadline">
                      <div className="modelRing" style={{ "--share": share } as CSSProperties}>
                        <div className="modelRingTrack" />
                        <div className="modelRingValue">
                          <strong>{share.toFixed(1)}%</strong>
                          <small>of spend</small>
                        </div>
                      </div>
                      <div className="projectSpend">
                        <strong>{money.format(project.cost)}</strong>
                        <span>{label.value} {label.caption}</span>
                      </div>
                    </div>

                    <dl className="projectStats">
                      <div>
                        <dt>Tokens</dt>
                        <dd>{compactNumber.format(project.totalTokens)}</dd>
                      </div>
                      <div>
                        <dt>Sessions</dt>
                        <dd>{fullNumber.format(project.sessionCount)}</dd>
                      </div>
                      <div>
                        <dt>Messages</dt>
                        <dd>{compactNumber.format(project.messageCount)}</dd>
                      </div>
                      <div>
                        <dt>Cache reads</dt>
                        <dd>{compactNumber.format(project.cacheReadTokens)}</dd>
                      </div>
                    </dl>

                    <div className="projectModelBar" aria-hidden="true">
                      {visibleModels.map((entry) => {
                        const width = modelTotal ? (entry.cost / modelTotal) * 100 : 0;
                        if (width <= 0) return null;
                        return (
                          <div
                            className={`projectModelSeg tone${toneByModel[entry.model] ?? 0}`}
                            key={`${entry.provider}/${entry.model}`}
                            style={{ width: `${width}%` }}
                          />
                        );
                      })}
                    </div>

                    <ul className="projectModels">
                      {visibleModels.map((entry) => (
                        <li className={`tone${toneByModel[entry.model] ?? 0}`} key={`${entry.provider}/${entry.model}`}>
                          <i />
                          <span>{entry.model}</span>
                          <strong>{money.format(entry.cost)}</strong>
                          <small>{compactNumber.format(entry.totalTokens)} tok</small>
                        </li>
                      ))}
                    </ul>
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
