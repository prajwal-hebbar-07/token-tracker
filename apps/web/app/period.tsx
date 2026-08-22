"use client";

import { createContext, type ReactNode, useContext, useState } from "react";
import { DayPicker, dayDate, type IsoDay } from "./day-picker";

// A single day is addressed by its own local calendar date, which is exactly what
// the API takes as the period, so the picker needs no second query parameter.
export type DayPeriod = IsoDay;
export type Period = "today" | "month" | "all" | DayPeriod;

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

const options: Array<{ value: Period; label: string }> = [
  { value: "today", label: "Today" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

export function isDay(period: Period): period is DayPeriod {
  return dayPattern.test(period);
}

export function dayLabel(period: DayPeriod): string {
  return dayDate(period).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function periodLabel(period: Period): string {
  if (period === "today") return "today";
  if (period === "month") return "this month";
  if (period === "all") return "all time";
  return dayLabel(period);
}

export function periodEyebrow(period: Period): string {
  if (period === "today") return "TODAY'S SPEND";
  if (period === "month") return "CURRENT MONTH SPEND";
  if (period === "all") return "ALL-TIME SPEND";
  return `SPEND ON ${dayLabel(period).toUpperCase()}`;
}

interface PeriodState {
  period: Period;
  setPeriod: (period: Period) => void;
}

const PeriodContext = createContext<PeriodState | null>(null);

// The selected period lives in the root layout, which stays mounted while the
// page segment swaps, so moving between the dashboard and the projects page
// keeps whatever period was picked. Every launch starts on today's spend, which
// is the number the app is opened to read.
export function PeriodProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [period, setPeriod] = useState<Period>("today");

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
      <DayPicker disabled={disabled} onSelect={setPeriod} selected={isDay(period) ? period : null} />
    </div>
  );
}
