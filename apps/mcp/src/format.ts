import type { Dashboard, ModelsReport, ProjectsReport } from "@token-tracker/api/dist/db.js";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function share(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

export function formatUsage(
  period: string,
  dashboard: Dashboard,
  models: ModelsReport,
  projects: ProjectsReport,
): string {
  const lines: string[] = [];
  lines.push(`# Token usage (${period})`);
  lines.push(`Spend: ${money.format(dashboard.summary.cost)}`);
  lines.push(
    `Tokens: ${compact.format(dashboard.summary.totalTokens)} · messages ${compact.format(dashboard.summary.messageCount)} · sessions ${dashboard.summary.sessionCount}`,
  );
  if (dashboard.lastSync) {
    lines.push(`Last imported: ${new Date(dashboard.lastSync.completedAt).toLocaleString()}`);
  } else {
    lines.push("Last imported: never — call refresh_usage first.");
  }

  if (dashboard.limits && dashboard.limits.providers.length > 0) {
    lines.push("", "## Account limits");
    for (const provider of dashboard.limits.providers) {
      const account = provider.account ? ` · ${provider.account}` : "";
      const plan = provider.plan ? ` · ${provider.plan}` : "";
      lines.push(`- ${provider.provider}${account}${plan}`);
      for (const window of provider.windows) {
        const used = window.used === null ? "—" : window.unit === "usd" ? money.format(window.used) : String(window.used);
        const limit = window.limit === null
          ? ""
          : ` / ${window.unit === "usd" ? money.format(window.limit) : String(window.limit)}`;
        const pct = window.usedFraction === null ? "" : ` (${Math.round(window.usedFraction * 100)}%)`;
        lines.push(`  ${window.label}: ${used}${limit}${pct}`);
      }
    }
  }

  if (dashboard.categories.length > 0) {
    lines.push("", "## Categories");
    for (const category of dashboard.categories) {
      lines.push(
        `- ${category.category}: ${compact.format(category.totalTokens)} tokens · ${share(category.totalTokens, dashboard.summary.totalTokens)}`,
      );
    }
  }

  if (models.models.length > 0) {
    lines.push("", "## Models");
    for (const model of models.models.slice(0, 8)) {
      const price = model.effectivePricePerMillion === null
        ? "unpriced"
        : `${money.format(model.effectivePricePerMillion)} / 1M`;
      lines.push(`- ${model.model} (${model.provider}): ${money.format(model.cost)} · ${price}`);
    }
  }

  if (projects.projects.length > 0) {
    lines.push("", "## Projects");
    for (const project of projects.projects.slice(0, 8)) {
      lines.push(
        `- ${project.name}: ${money.format(project.cost)} · ${compact.format(project.totalTokens)} tokens`,
      );
    }
  }

  if (dashboard.summary.messageCount === 0) {
    lines.push("", "No usage in this period. Call refresh_usage if the snapshot may be stale.");
  }

  return lines.join("\n");
}

export function formatImport(warnings: string[], newRecords: number | undefined): string {
  const lines = ["Usage import finished."];
  if (newRecords !== undefined) lines.push(`New records: ${newRecords}`);
  if (warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}
