"use client";

import { useEffect, useRef, useState } from "react";

export type IsoDay = `${number}-${number}-${number}`;

const weekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

// Local calendar parts throughout, never Date#toISOString: that is UTC, which
// names the previous day west of Greenwich for most of the evening.
function isoDay(date: Date): IsoDay {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}` as IsoDay;
}

export function dayDate(day: IsoDay): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function firstOfMonth(day: IsoDay | null): Date {
  const anchor = day === null ? new Date() : dayDate(day);
  return new Date(anchor.getFullYear(), anchor.getMonth(), 1);
}

// Always six weeks from the Sunday on or before the 1st, so the popover keeps
// one height and the grid never reflows when the month changes.
function monthGrid(month: Date): Date[] {
  const lead = month.getDay();
  return Array.from(
    { length: 42 },
    (_, index) => new Date(month.getFullYear(), month.getMonth(), index + 1 - lead),
  );
}

// The trigger is a tab like the three named windows, and clicking it does one
// thing: it opens this calendar. The reported period changes when a day is
// picked, never on the click that opens the popover.
export function DayPicker({
  selected,
  onSelect,
  disabled = false,
}: Readonly<{ selected: IsoDay | null; onSelect: (day: IsoDay) => void; disabled?: boolean }>) {
  const container = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => firstOfMonth(selected));

  // Anything outside the popover dismisses it, including the other three tabs,
  // so the calendar never sits over the report it is meant to change.
  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent): void {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  const today = isoDay(new Date());
  const thisMonth = firstOfMonth(today);
  const label = selected === null
    ? "Pick a day"
    : dayDate(selected).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

  const tabClasses = ["dayPickerTab"];
  if (open) tabClasses.push("open");
  if (selected !== null) tabClasses.push("active");

  return (
    <div
      className="dayPicker"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
      ref={container}
    >
      <button
        aria-expanded={open}
        className={tabClasses.join(" ")}
        disabled={disabled}
        // A picker reopened on whatever month it was left in is a trap, so every
        // open starts on the chosen day, or on this month when none is chosen.
        onClick={() => {
          setMonth(firstOfMonth(selected));
          setOpen(!open);
        }}
        type="button"
      >
        {label}
      </button>
      {open && (
        <div className="dayPickerMenu" role="dialog" aria-label="Pick a day">
          <div className="dayPickerHead">
            <button
              aria-label="Previous month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              type="button"
            >
              ‹
            </button>
            <strong>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
            <button
              aria-label="Next month"
              // Nothing can have been recorded in a month that has not started.
              disabled={month >= thisMonth}
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              type="button"
            >
              ›
            </button>
          </div>
          <div className="dayPickerWeek" aria-hidden="true">
            {weekdays.map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>
          <div className="dayPickerGrid">
            {monthGrid(month).map((date) => {
              const day = isoDay(date);
              const classes = ["dayPickerDay"];
              if (date.getMonth() !== month.getMonth()) classes.push("outside");
              if (day === today) classes.push("today");
              if (day === selected) classes.push("selected");
              return (
                <button
                  aria-pressed={day === selected}
                  className={classes.join(" ")}
                  // Fixed-width ISO dates sort chronologically as text, so a
                  // future day needs no date arithmetic to recognise.
                  disabled={day > today}
                  key={day}
                  onClick={() => {
                    onSelect(day);
                    setOpen(false);
                  }}
                  type="button"
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
