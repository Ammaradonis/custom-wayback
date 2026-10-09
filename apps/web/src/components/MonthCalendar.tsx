/**
 * MonthCalendar — responsive month/year picker with coverage density dots.
 *
 * Features (per plan §2.3):
 *  - Modern month-grid (not a wall of timestamps).
 *  - Month/year dropdown navigation above the grid.
 *  - Per-day density dot: none / light / medium / heavy capture buckets.
 *  - Days with zero captures are dimmed; future days are disabled.
 *  - Selected day highlighted with accent colour.
 *  - On mobile (<640 px) rendered inside a bottom-sheet (thumb-reachable).
 *  - On desktop rendered inside a Radix Popover.
 */

import { useState, useCallback, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, CalendarDays, X } from "lucide-react";
import type { DayCoverage } from "@custom-wayback/shared";
import { cn } from "@/lib/utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MonthCalendarProps {
  domain: string;
  selectedDay: string | null;
  onChange: (day: string) => void;
  coverage: DayCoverage[];
  isLoading?: boolean;
  onMonthChange?: (year: number, month: number) => void;
  initialYear?: number;
  initialMonth?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function firstWeekdayOfMonth(year: number, month: number): number {
  return new Date(year, month - 1, 1).getDay();
}

function padDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dotClass(captureCount: number): string {
  if (captureCount === 0) return "";
  if (captureCount <= 2) return "bg-accent/40";
  if (captureCount <= 5) return "bg-accent/70";
  return "bg-accent";
}

function captureLabel(captureCount: number): string {
  if (captureCount === 0) return "no captures";
  if (captureCount === 1) return "1 capture";
  return `${captureCount} captures`;
}

// ── Inner calendar grid ───────────────────────────────────────────────────────

interface CalendarGridProps {
  year: number;
  month: number; // 1-based
  selectedDay: string | null;
  coverage: DayCoverage[];
  isLoading: boolean;
  /** Called when the user clicks a day cell (with a YYYY-MM-DD string). */
  onDaySelect: (day: string) => void;
  /** Called when prev/next month buttons or dropdowns navigate the grid. */
  onNavigate: (year: number, month: number) => void;
  onClose?: () => void;
}

function CalendarGrid({
  year,
  month,
  selectedDay,
  coverage,
  isLoading,
  onDaySelect,
  onNavigate,
  onClose,
}: CalendarGridProps) {
  const coverageMap = new Map(coverage.map((c) => [c.day, c.captureCount]));
  const totalDays = daysInMonth(year, month);
  const startWeekday = firstWeekdayOfMonth(year, month);
  const today = new Date().toISOString().slice(0, 10);
  const todayYM = today.slice(0, 7);
  const thisYM = `${year}-${String(month).padStart(2, "0")}`;

  const cells: Array<{ day: number } | null> = [
    ...Array<null>(startWeekday).fill(null),
    ...Array.from({ length: totalDays }, (_, i) => ({ day: i + 1 })),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: currentYear - 1995 }, (_, i) => 1996 + i);

  function prevMonth() {
    const y = month === 1 ? year - 1 : year;
    const m = month === 1 ? 12 : month - 1;
    onNavigate(y, m);
  }

  function nextMonth() {
    const y = month === 12 ? year + 1 : year;
    const m = month === 12 ? 1 : month + 1;
    onNavigate(y, m);
  }

  return (
    <div className="flex flex-col gap-3 w-full select-none">
      {/* ── Navigation row ── */}
      <div className="flex items-center gap-1">
        <button
          data-compact
          onClick={prevMonth}
          aria-label="Previous month"
          className="h-9 w-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div className="flex-1 flex items-center justify-center gap-1.5">
          {/* Month dropdown — bg-background so text is readable in dark mode */}
          <select
            value={month}
            onChange={(e) => onNavigate(year, Number(e.target.value))}
            className="h-8 rounded-md border border-input bg-background text-foreground px-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer"
            aria-label="Select month"
          >
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>{name}</option>
            ))}
          </select>

          {/* Year dropdown */}
          <select
            value={year}
            onChange={(e) => onNavigate(Number(e.target.value), month)}
            className="h-8 rounded-md border border-input bg-background text-foreground px-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer"
            aria-label="Select year"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        <button
          data-compact
          onClick={nextMonth}
          aria-label="Next month"
          disabled={thisYM >= todayYM}
          className="h-9 w-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>

        {onClose && (
          <button
            data-compact
            onClick={onClose}
            aria-label="Close calendar"
            className="h-9 w-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors ml-1"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ── Weekday headers ── */}
      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAYS.map((wd) => (
          <div
            key={wd}
            className="h-8 flex items-center justify-center text-[11px] font-medium text-muted-foreground"
          >
            {wd}
          </div>
        ))}
      </div>

      {/* ── Day cells ── */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((cell, i) => {
          if (!cell) {
            return <div key={`blank-${i}`} className="h-10" />;
          }

          const dayStr = padDay(year, month, cell.day);
          const count = coverageMap.get(dayStr) ?? 0;
          const isSelected = dayStr === selectedDay;
          const isToday = dayStr === today;
          const isFuture = dayStr > today;
          const hasCapture = count > 0;

          if (isLoading) {
            return <div key={dayStr} className="h-10 rounded-lg bg-muted animate-pulse" />;
          }

          return (
            <button
              key={dayStr}
              data-compact
              onClick={() => {
                if (!isFuture && hasCapture) onDaySelect(dayStr);
              }}
              disabled={isFuture || !hasCapture}
              aria-label={`${dayStr}, ${captureLabel(count)}`}
              aria-pressed={isSelected}
              className={cn(
                "h-10 rounded-lg flex flex-col items-center justify-center gap-0.5 text-sm font-medium transition-colors duration-150",
                "disabled:opacity-30 disabled:cursor-not-allowed",
                !hasCapture && !isFuture && "opacity-40",
                hasCapture && !isSelected && "hover:bg-muted cursor-pointer",
                isSelected && "bg-accent text-accent-foreground shadow-sm",
                isToday && !isSelected && "ring-1 ring-accent ring-offset-1 ring-offset-background",
              )}
            >
              <span className="leading-none text-[13px]">{cell.day}</span>
              {count > 0 && (
                <span
                  className={cn(
                    "h-1 w-1 rounded-full",
                    isSelected ? "bg-accent-foreground/60" : dotClass(count),
                  )}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center gap-3 pt-1 text-[11px] text-muted-foreground flex-wrap">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-accent/40 inline-block" />
          1–2
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-accent/70 inline-block" />
          3–5
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-accent inline-block" />
          6+
        </span>
        <span className="ml-auto">
          {coverage.filter((c) => c.captureCount > 0).length} days captured
        </span>
      </div>
    </div>
  );
}

// ── Main exported component ───────────────────────────────────────────────────

export function MonthCalendar({
  domain,
  selectedDay,
  onChange,
  coverage,
  isLoading = false,
  onMonthChange,
  initialYear,
  initialMonth,
}: MonthCalendarProps) {
  const now = new Date();
  const [year, setYear] = useState(initialYear ?? now.getFullYear());
  const [month, setMonth] = useState(initialMonth ?? now.getMonth() + 1);
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Sync displayed month when external selection changes.
  useEffect(() => {
    if (selectedDay) {
      const parts = selectedDay.split("-");
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      if (Number.isFinite(y) && Number.isFinite(m)) {
        setYear(y);
        setMonth(m);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDay]);

  /** Pure grid navigation — never selects a day, never closes the picker. */
  const handleNavigate = useCallback(
    (y: number, m: number) => {
      setYear(y);
      setMonth(m);
      onMonthChange?.(y, m);
    },
    [onMonthChange],
  );

  /** User tapped a day cell — select it and close. */
  const handleDaySelect = useCallback(
    (day: string) => {
      onChange(day);
      setOpen(false);
    },
    [onChange],
  );

  const selectedLabel = selectedDay
    ? new Date(selectedDay + "T00:00:00").toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Pick a day";

  const gridProps = {
    year,
    month,
    selectedDay,
    coverage,
    isLoading,
    onDaySelect: handleDaySelect,
    onNavigate: handleNavigate,
  };

  const trigger = (
    <button
      aria-label={`Open calendar. Selected: ${selectedLabel}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      className="flex items-center gap-1.5 h-9 rounded-md border border-input bg-transparent px-3 text-sm hover:bg-muted transition-colors"
    >
      <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
      <span className="text-foreground">{selectedLabel}</span>
    </button>
  );

  if (isMobile) {
    return (
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-background border-t border-border p-5 shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom duration-200"
            style={{ paddingBottom: "calc(1.25rem + var(--sai-bottom))" }}
            aria-describedby={undefined}
          >
            <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-muted" aria-hidden />
            <Dialog.Title className="sr-only">Pick a day for {domain}</Dialog.Title>
            <CalendarGrid {...gridProps} onClose={() => setOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className="z-50 w-[19rem] rounded-xl border border-border bg-background p-4 shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-150"
        >
          <CalendarGrid {...gridProps} />
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
