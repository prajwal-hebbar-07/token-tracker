"use client";

import { createContext, type ReactNode, useContext, useState } from "react";

export type Period = "today" | "month" | "all";

const options: Array<{ value: Period; label: string }> = [
  { value: "today", label: "Today" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

interface PeriodState {
  period: Period;
  setPeriod: (period: Period) => void;
}

const PeriodContext = createContext<PeriodState | null>(null);

// The selected period lives in the root layout, which stays mounted while the
// page segment swaps, so moving between the dashboard and the projects page
// keeps whatever period was picked.
export function PeriodProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [period, setPeriod] = useState<Period>("month");

  return <PeriodContext.Provider value={{ period, setPeriod }}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): PeriodState {
  const state = useContext(PeriodContext);
  if (state === null) throw new Error("usePeriod must be used inside a PeriodProvider");
  return state;
}

export function PeriodTabs({ disabled = false }: Readonly<{ disabled?: boolean }>) {
  const { period, setPeriod } = usePeriod();

  return (
    <div className="periodTabs" aria-label="Usage period">
      {options.map((option) => (
        <button
          type="button"
          aria-pressed={period === option.value}
          className={period === option.value ? "active" : undefined}
          disabled={disabled}
          key={option.value}
          onClick={() => setPeriod(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
