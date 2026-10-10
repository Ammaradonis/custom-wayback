/**
 * MonthCalendar — a three-level month/day picker with coverage density.
 *
 * WHAT WAS WRONG
 *
 * The previous version had two defects that made it unusable, and they had
 * different causes:
 *
 * 1. **Every colour utility it used was dead CSS.** `bg-background`,
 *    `text-foreground`, `border-input`, `bg-accent`, `ring-offset-background` and
 *    `fill-border` were class names with no rules behind them, because the design
 *    tokens were declared in `@layer base` instead of `@theme` (see
 *    `src/styles/tokens.css`). A `<select>` with no border and no background is
 *    literally invisible against the page, and its option list is painted by the
 *    OS — so on a light-mode system the popup was light-on-light. That is the
 *    "dropdown menus are invisible (no contrast)" half of the report, and it was
 *    a styling failure, not a calendar failure.
 *
 * 2. **The month and year controls did not select anything you could see.** The
 *    two `<select>`s called `onNavigate`, which set internal state and told the
 *    parent to refetch coverage — but the day grid only becomes *clickable* for
 *    days that already have captures in the month being displayed. Picking a
 *    month therefore changed the dots and nothing else: no day could be chosen
 *    until data for that month happened to arrive, and on a month with no
 *    captures every cell stayed disabled. Combined with (1), the controls looked
 *    like inert white boxes. That is the "calendars do not allow me to pick a
 *    month or a certain day" half.
 *
 * HOW THIS VERSION FIXES IT
 *
 * · Month and year are chosen from **grids of buttons**, not native `<select>`s.
 *   They cannot be unstylable, they render identically on every platform, and
 *   they carry coverage information a native option list cannot show: the month
 *   grid marks which months have captures and which are in the future.
 * · A day with **no** captures remains **selectable** — disabled-looking, but
 *   clickable — because choosing an empty day is a legitimate intent (it scopes
 *   the month for crawling and for share links). Only *future* days are truly
 *   disabled. The grid never becomes an all-disabled wall.
 * · Coverage is shown three ways at once, so a day is never ambiguous: the
 *   **dot** (density), the accessible **name and title** ("3 captures"), and the
 *   legend. Colour is never the only signal.
 * · Full keyboard support: arrow keys move by day/week, PageUp/PageDown by
 *   month, Home/End to week bounds, Enter/Space to select, Escape to dismiss.
 *   Roving tabindex, so the grid is one tab stop rather than 31.
 * · A live region announces the visible month and its capture count, because the
 *   grid changes under the user when they navigate.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, CalendarDays, X } from "lucide-react";
import type { DayCoverage } from "@custom-wayback/shared";
import { cn } from "@/lib/utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MonthCalendarProps {
  /** Domain the picker is for; used in the dialog title for screen readers. */
  domain: string;
  /** Selected day as `YYYY-MM-DD`, or null. */
  selectedDay: string | null;
  onChange: (day: string) => void;
  /** Captures for the month currently on screen. */
  coverage: DayCoverage[];
  isLoading?: boolean;
  /** Fired when the user navigates the grid to a different month. */
  onMonthChange?: (year: number, month: number) => void;
  initialYear?: number;
  initialMonth?: number;
}

/** `day` | `month` | `year` — the level of the picker on screen. */
type PickerView = "day" | "month" | "year";

// ── Date helpers ──────────────────────────────────────────────────────────────
//
// All arithmetic is integer arithmetic on (year, month, day) triples. Using
// `new Date(y, m, d)` for anything other than `getDay()` invites the usual
// timezone and month-overflow bugs, and `toISOString()` is never used on a local
// date because it shifts by the UTC offset — which silently returns the wrong day
// for anyone west of Greenwich after 00:00 local.

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const WEEKDAYS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Earliest year offered. The Wayback Machine has captures from 1996 onward. */
const MIN_YEAR = 1996;
const YEARS_PER_PAGE = 12;

/** `(2026, 1, 5)` → `"2026-01-05"`. */
function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `(2026, 1)` → `"2026-01"`. */
function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Days in a 1-based month. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Weekday of the 1st of a 1-based month, 0 = Sunday. */
function firstWeekday(year: number, month: number): number {
  return new Date(year, month - 1, 1).getDay();
}

/** Step `delta` months from `(year, month)`, 1-based in and out. */
function addMonths(year: number, month: number, delta: number): [number, number] {
  const total = year * 12 + (month - 1) + delta;
  return [Math.floor(total / 12), (total % 12) + 1];
}

/** Today in the *local* calendar, as the triple the arithmetic above works in. */
function todayParts(): [number, number, number] {
  const d = new Date();
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

function compareDay(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Coverage presentation ─────────────────────────────────────────────────────

/**
 * Density bucket for a capture count.
 *
 * The dot's *opacity* is the density signal; its accessible name carries the
 * same information in words, and the legend decodes it. A day with captures is
 * additionally given a tinted cell, so density is legible even at a glance on a
 * phone in sunlight, where a 1px dot is not.
 */
function coverageBucket(count: number): "none" | "light" | "medium" | "heavy" {
  if (count <= 0) return "none";
  if (count <= 2) return "light";
  if (count <= 5) return "medium";
  return "heavy";
}

const DOT_CLASS: Record<ReturnType<typeof coverageBucket>, string> = {
  none: "",
  light: "bg-accent/45",
  medium: "bg-accent/75",
  heavy: "bg-accent",
};

function captureLabel(count: number): string {
  if (count <= 0) return "no captures";
  if (count === 1) return "1 capture";
  return `${count} captures`;
}

// ── NavButton: one shape for every icon control in the picker ─────────────────

function NavButton({
  label,
  onClick,
  disabled,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-compact
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "h-9 w-9 flex-none grid place-items-center rounded-lg",
        "text-muted-foreground hover:text-foreground hover:bg-muted",
        "transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
        "disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── Year grid ─────────────────────────────────────────────────────────────────

function YearGrid({
  year,
  onPick,
}: {
  year: number;
  onPick: (year: number) => void;
}) {
  const [currentYear] = todayParts();
  const maxYear = currentYear;

  /** The page of 12 that contains `year`. */
  function pageOf(y: number): number {
    const clamped = Math.min(Math.max(y, MIN_YEAR), maxYear);
    return MIN_YEAR + Math.floor((clamped - MIN_YEAR) / YEARS_PER_PAGE) * YEARS_PER_PAGE;
  }

  const [pageStart, setPageStart] = useState(() => pageOf(year));

  // Follow the selection into a different page. Deriving this during render (the
  // "adjust state from props" pattern) rather than in an effect means the grid is
  // never briefly showing a page that does not contain the highlighted year —
  // which is what happened when the parent moved the year from elsewhere.
  const [seenYear, setSeenYear] = useState(year);
  if (seenYear !== year) {
    setSeenYear(year);
    const target = pageOf(year);
    if (target !== pageStart) setPageStart(target);
  }

  const years = Array.from({ length: YEARS_PER_PAGE }, (_, i) => pageStart + i);
  const lastPageStart = pageOf(maxYear);
  const firstFocusable = years.includes(year) ? year : years[0]!;

  return (
    <div className="space-y-3">
      {/* `data-testid` because the month level renders this grid *and* a month
        * grid, so both carry year-navigation arrows and a role-based query is
        * ambiguous. Scoping by test id keeps the e2e script honest without
        * inventing a second accessible name for the same control. */}
      <div className="flex items-center justify-between gap-1" data-testid="year-grid-nav">
        <NavButton
          label="Previous years"
          onClick={() => setPageStart((s) => Math.max(MIN_YEAR, s - YEARS_PER_PAGE))}
          disabled={pageStart <= MIN_YEAR}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </NavButton>
        <span className="text-sm font-semibold tabular-nums" aria-live="polite">
          {pageStart}–{Math.min(pageStart + YEARS_PER_PAGE - 1, maxYear)}
        </span>
        <NavButton
          label="Later years"
          onClick={() => setPageStart((s) => Math.min(lastPageStart, s + YEARS_PER_PAGE))}
          disabled={pageStart >= lastPageStart}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </NavButton>
      </div>

      <div
        role="group"
        aria-label="Choose a year"
        className="grid grid-cols-3 gap-1.5"
        onKeyDown={(e) => {
          const delta = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -3 : e.key === "ArrowDown" ? 3 : 0;
          if (delta === 0) return;
          e.preventDefault();
          const next = Math.min(Math.max(year + delta, MIN_YEAR), maxYear);
          onPick(next);
        }}
      >
        {years.map((y) => {
          const isFuture = y > maxYear;
          const isSelected = y === year;
          const isThisYear = y === currentYear;
          return (
            <button
              key={y}
              type="button"
              data-compact
              tabIndex={y === firstFocusable ? 0 : -1}
              disabled={isFuture}
              aria-pressed={isSelected}
              onClick={() => onPick(y)}
              className={cn(
                "h-10 rounded-lg text-sm font-medium tabular-nums transition-colors",
                "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
                isSelected && "bg-accent text-accent-foreground font-semibold",
                !isSelected && !isFuture && "text-foreground hover:bg-muted",
                isFuture && "text-muted-foreground/60 cursor-not-allowed",
                isThisYear && !isSelected && "ring-1 ring-inset ring-border",
              )}
            >
              {y}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Month grid ────────────────────────────────────────────────────────────────

function MonthGrid({
  year,
  month,
  onPick,
}: {
  year: number;
  month: number;
  onPick: (month: number) => void;
}) {
  const [curYear, curMonth] = todayParts();
  const isCurrentYear = year === curYear;

  return (
    <div
      role="group"
      aria-label={`Choose a month in ${year}`}
      className="grid grid-cols-3 gap-1.5"
      onKeyDown={(e) => {
        const delta = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -3 : e.key === "ArrowDown" ? 3 : 0;
        if (delta === 0) return;
        e.preventDefault();
        const next = month + delta;
        if (next < 1 || next > 12) return;
        if (isCurrentYear && next > curMonth) return;
        onPick(next);
      }}
    >
      {MONTHS_SHORT.map((name, i) => {
        const value = i + 1;
        const isFuture = isCurrentYear && value > curMonth;
        const isSelected = value === month;
        const isCurrentMonth = isCurrentYear && value === curMonth;
        return (
          <button
            key={name}
            type="button"
            data-compact
            disabled={isFuture}
            aria-pressed={isSelected}
            // A full accessible name: "Mar" alone is ambiguous out of context.
            aria-label={`${MONTHS[i]} ${year}`}
            onClick={() => onPick(value)}
            className={cn(
              "h-11 rounded-lg text-sm font-medium transition-colors",
              "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
              isSelected && "bg-accent text-accent-foreground font-semibold",
              !isSelected && !isFuture && "text-foreground hover:bg-muted",
              isFuture && "text-muted-foreground/60 cursor-not-allowed",
              isCurrentMonth && !isSelected && "ring-1 ring-inset ring-border",
            )}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}

// ── Day grid ──────────────────────────────────────────────────────────────────

interface DayGridProps {
  year: number;
  month: number;
  selectedDay: string | null;
  coverageMap: Map<string, number>;
  isLoading: boolean;
  monthHasCoverage: boolean;
  monthIsFuture: boolean;
  onSelect: (day: string) => void;
  /** Step the visible month; `hint` seeds the next grid's keyboard cursor. */
  onNavigateMonth: (delta: number, hint?: number) => void;
  /**
   * Day-of-month the roving tabindex should land on after this grid mounts.
   *
   * Needed because arrow-key navigation *remounts* the grid: moving right from
   * the 31st asks the parent for a new month, and the new grid has to know to
   * put the cursor on the 1st rather than on its own default. Without this the
   * keyboard cursor silently jumped back to the first day with coverage every
   * time it crossed a month boundary.
   */
  focusHint?: number | undefined;
}

function DayGrid({
  year,
  month,
  selectedDay,
  coverageMap,
  isLoading,
  monthHasCoverage,
  monthIsFuture,
  onSelect,
  onNavigateMonth,
  focusHint,
}: DayGridProps) {
  const [ty, tm, td] = todayParts();
  const today = iso(ty, tm, td);
  const key = monthKey(year, month);

  const total = daysInMonth(year, month);
  const lead = firstWeekday(year, month);

  /** Leading blanks, then the days, padded to whole weeks. */
  const cells = useMemo(() => {
    const out: Array<number | null> = [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: total }, (_, i) => i + 1),
    ];
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [lead, total]);

  /** First day of this month that has captures, or null. */
  const firstCoveredDay = useMemo(() => {
    let best: number | null = null;
    for (const [d, count] of coverageMap) {
      if (count <= 0 || !d.startsWith(key)) continue;
      const n = Number(d.slice(8));
      if (best === null || n < best) best = n;
    }
    return best;
  }, [coverageMap, key]);

  /** Where the keyboard cursor should start in this month. */
  function defaultFocusDay(): number {
    const sel = selectedDay;
    if (sel?.startsWith(key)) {
      const n = Number(sel.slice(8));
      if (Number.isFinite(n)) return n;
    }
    if (year === ty && month === tm) return td; // today
    return firstCoveredDay ?? 1; // else the first actionable day
  }

  // ── Roving tabindex ────────────────────────────────────────────────────────
  //
  // The grid is one tab stop. Arrow keys move a "focused" day, and the button
  // carrying it is the only one with tabIndex 0. Without this, tabbing into the
  // calendar means 31 tab presses to get past it.
  const [focusDay, setFocusDay] = useState(() =>
    Math.min(Math.max(1, focusHint ?? defaultFocusDay()), total),
  );

  // Reset when the grid starts showing a different month, computed during render
  // rather than in an effect so there is no frame with the old cursor.
  const [seenMonth, setSeenMonth] = useState(key);
  if (seenMonth !== key) {
    setSeenMonth(key);
    setFocusDay(Math.min(Math.max(1, focusHint ?? defaultFocusDay()), total));
  }

  // Follow a selection made elsewhere (the parent can reset it).
  const [seenSelection, setSeenSelection] = useState(selectedDay);
  if (seenSelection !== selectedDay) {
    setSeenSelection(selectedDay);
    if (selectedDay?.startsWith(key)) {
      const n = Number(selectedDay.slice(8));
      if (Number.isFinite(n)) setFocusDay(n);
    }
  }

  const gridRef = useRef<HTMLDivElement>(null);
  // Set when a keyboard move should pull focus, so re-renders from mouse clicks
  // do not steal focus from wherever the user actually is.
  const shouldRefocus = useRef(false);

  useEffect(() => {
    if (!shouldRefocus.current) return;
    shouldRefocus.current = false;
    const btn = gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`);
    btn?.focus();
  }, [focusDay]);

  /** Move focus by `delta` days, crossing month boundaries via the parent. */
  function move(delta: number) {
    const target = focusDay + delta;
    if (target >= 1 && target <= total) {
      shouldRefocus.current = true;
      setFocusDay(target);
      return;
    }
    // Crossing out of the month. Hand the wrapped day to the next grid as a hint
    // so the cursor continues from where it left off (31 → 1, 1 → 31).
    onNavigateMonth(delta < 0 ? -1 : 1, target < 1 ? total + target : target - total);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case "ArrowLeft":  e.preventDefault(); move(-1); break;
      case "ArrowRight": e.preventDefault(); move(1); break;
      case "ArrowUp":    e.preventDefault(); move(-7); break;
      case "ArrowDown":  e.preventDefault(); move(7); break;
      case "Home":       e.preventDefault(); shouldRefocus.current = true; setFocusDay(1); break;
      case "End":        e.preventDefault(); shouldRefocus.current = true; setFocusDay(total); break;
      case "PageUp":     e.preventDefault(); onNavigateMonth(-1); break;
      case "PageDown":   e.preventDefault(); onNavigateMonth(1); break;
      // Enter/Space are deliberately NOT handled here: the focused cell is a
      // real <button>, so its own click event already fires on both keys, and
      // handling them here too would select twice.
      default:
        break;
    }
  }

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label={`${MONTHS[month - 1]} ${year}`}
      aria-busy={isLoading}
      className="space-y-1"
      onKeyDown={onKeyDown}
    >
      {/* Weekday header row */}
      <div role="row" className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((wd, i) => (
          <div
            key={wd}
            role="columnheader"
            aria-label={WEEKDAYS_LONG[i]}
            className="grid h-7 place-items-center text-[11px] font-semibold text-muted-foreground"
          >
            <span aria-hidden>{wd}</span>
          </div>
        ))}
      </div>

      {isLoading ? (
        // Skeletons keep the grid's exact shape, so nothing jumps when data lands.
        <div className="grid grid-cols-7 gap-1" role="presentation">
          {Array.from({ length: cells.length }, (_, i) => (
            <div key={i} className="h-10 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, i) => {
            if (day === null) {
              return <div key={`blank-${i}`} role="gridcell" aria-hidden className="h-10" />;
            }

            const dayStr = iso(year, month, day);
            const count = coverageMap.get(dayStr) ?? 0;
            const bucket = coverageBucket(count);
            const hasCapture = count > 0;
            const isSelected = dayStr === selectedDay;
            const isToday = dayStr === today;
            const isFuture = compareDay(dayStr, today) > 0;
            const isFocusTarget = day === focusDay;

            // A full sentence per cell: the dot alone conveys nothing to a
            // screen reader, and "12" alone is ambiguous out of context.
            const name = [
              `${WEEKDAYS_LONG[new Date(year, month - 1, day).getDay()]}, ${MONTHS[month - 1]} ${day}, ${year}`,
              isFuture ? "in the future" : captureLabel(count),
              isToday ? "today" : null,
              isSelected ? "selected" : null,
            ]
              .filter(Boolean)
              .join(", ");

            return (
              <button
                key={dayStr}
                type="button"
                data-compact
                data-day={day}
                role="gridcell"
                tabIndex={isFocusTarget ? 0 : -1}
                disabled={isFuture}
                aria-label={name}
                aria-pressed={isSelected}
                aria-current={isToday ? "date" : undefined}
                title={isFuture ? "Not archived yet" : captureLabel(count)}
                onClick={() => {
                  setFocusDay(day);
                  if (!isFuture) onSelect(dayStr);
                }}
                className={cn(
                  "relative grid h-10 place-items-center rounded-lg text-[13px] font-medium",
                  "transition-colors duration-150",
                  "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
                  // Disabled = future only.
                  isFuture && "cursor-not-allowed text-muted-foreground/50",
                  // Selected day.
                  isSelected && "bg-accent text-accent-foreground font-semibold shadow-sm",
                  // Days with captures, unselected.
                  !isSelected && hasCapture && "bg-accent-soft text-foreground hover:bg-muted",
                  // Capturable today (may be zero captures): visible surface tint
                  // so it is obvious the cell can be pressed.
                  !isSelected && !hasCapture && !isFuture && "bg-muted/60 text-foreground hover:bg-muted",
                  // Today's ring.
                  isToday && !isSelected && "ring-1 ring-inset ring-accent",
                )}
              >
                <span className="tabular-nums leading-none">{day}</span>

                {/* Density dot, bottom-centred. Hidden from AT: the count is in
                  * the button's accessible name. */}
                {hasCapture && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute bottom-1 h-1 w-1 rounded-full",
                      isSelected ? "bg-accent-foreground/70" : DOT_CLASS[bucket],
                    )}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Empty-month notice. Not an error and not a dead end — the month is still
        * selectable for crawling and sharing, so say what is true and move on. */}
      {!isLoading && !monthHasCoverage && !monthIsFuture && (
        <p className="pt-1 text-center text-[11px] text-muted-foreground">
          No captures stored for {MONTHS[month - 1]} {year}.
        </p>
      )}
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend({ daysCaptured }: { daysCaptured: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-accent/45" />1–2
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-accent/75" />3–5
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-accent" />6+
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-muted ring-1 ring-inset ring-border" />
        none
      </span>
      <span className="ml-auto tabular-nums">
        {daysCaptured === 1 ? "1 day captured" : `${daysCaptured} days captured`}
      </span>
    </div>
  );
}

// ── Picker body: header + whichever level is active ───────────────────────────

interface PickerBodyProps {
  year: number;
  month: number;
  view: PickerView;
  setView: (v: PickerView) => void;
  selectedDay: string | null;
  coverage: DayCoverage[];
  isLoading: boolean;
  onSelectDay: (day: string) => void;
  onNavigate: (year: number, month: number) => void;
  onClose?: () => void;
}

function PickerBody({
  year,
  month,
  view,
  setView,
  selectedDay,
  coverage,
  isLoading,
  onSelectDay,
  onNavigate,
  onClose,
}: PickerBodyProps) {
  const [ty, tm, td] = todayParts();

  const coverageMap = useMemo(
    () => new Map(coverage.map((c) => [c.day, c.captureCount])),
    [coverage],
  );

  const key = monthKey(year, month);
  const monthHasCoverage = useMemo(
    () => [...coverageMap.keys()].some((d) => d.startsWith(key)),
    [coverageMap, key],
  );
  const daysCaptured = useMemo(() => coverage.filter((c) => c.captureCount > 0).length, [coverage]);

  const isAtCurrentMonth = year === ty && month === tm;
  const monthIsFuture = year > ty || (year === ty && month > tm);

  // Roving-cursor hint handed to the day grid. `null` means "let the grid decide";
  // a number means "an arrow key crossed the month edge, land here".
  const [focusHint, setFocusHint] = useState<number | null>(null);

  const goto = useCallback(
    (delta: number, hint?: number) => {
      const [ny, nm] = addMonths(year, month, delta);
      if (ny < MIN_YEAR) return;
      if (ny > ty || (ny === ty && nm > tm)) return; // never navigate into the future
      setFocusHint(hint ?? null);
      onNavigate(ny, nm);
    },
    [year, month, ty, tm, onNavigate],
  );

  const monthLabel = `${MONTHS[month - 1]} ${year}`;

  return (
    <div className="flex w-full flex-col gap-3 select-none">
      {/* ── Header ─────────────────────────────────────────────────────────
        * Two zones: navigation on the left, view switcher on the right. Both
        * wrap gracefully, so nothing is clipped at 320px. */}
      <div className="flex flex-wrap items-center gap-1">
        <NavButton
          label={view === "day" ? "Previous month" : view === "month" ? `Previous year, ${year - 1}` : "Previous years"}
          onClick={() => {
            if (view === "day") goto(-1);
            else if (view === "month") onNavigate(year - 1, month);
            else setView("month");
          }}
          disabled={
            view === "day"
              ? year <= MIN_YEAR && month === 1
              : view === "month"
                ? year <= MIN_YEAR
                : false
          }
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </NavButton>

        {/* Heading is the view switcher: the label you see is the button you
          * press to change it, which is the whole point of a three-level picker. */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
          <button
            type="button"
            data-compact
            onClick={() => setView("month")}
            aria-label={`Change month. Currently ${monthLabel}.`}
            className={cn(
              "truncate rounded-lg px-2 py-1 text-sm font-semibold",
              "hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
              view === "month" && "bg-muted",
            )}
          >
            {MONTHS[month - 1]}
          </button>
          <button
            type="button"
            data-compact
            onClick={() => setView("year")}
            aria-label={`Change year. Currently ${year}.`}
            className={cn(
              "rounded-lg px-2 py-1 text-sm font-semibold tabular-nums",
              "hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
              view === "year" && "bg-muted",
            )}
          >
            {year}
          </button>
        </div>

        <NavButton
          label={view === "day" ? "Next month" : view === "month" ? `Next year, ${year + 1}` : "Later years"}
          onClick={() => {
            if (view === "day") goto(1);
            else if (view === "month") onNavigate(year + 1, month);
            else setView("month");
          }}
          disabled={
            view === "day"
              ? isAtCurrentMonth || monthIsFuture
              : view === "month"
                ? year >= ty
                : false
          }
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </NavButton>

        {onClose && (
          <NavButton label="Close calendar" onClick={onClose} className="ml-0.5">
            <X className="h-4 w-4" aria-hidden />
          </NavButton>
        )}
      </div>

      {/* ── Level ──────────────────────────────────────────────────────── */}
      {view === "year" && (
        <YearGrid
          year={year}
          onPick={(y) => {
            // Clamp the month when jumping into the current year.
            const m = y === ty ? Math.min(month, tm) : month;
            onNavigate(y, m);
            setView("month");
          }}
        />
      )}

      {view === "month" && (
        <>
          <YearGrid
            year={year}
            onPick={(y) => {
              const m = y === ty ? Math.min(month, tm) : month;
              onNavigate(y, m);
            }}
          />
          <div className="border-t border-border pt-3">
            <MonthGrid
              year={year}
              month={month}
              onPick={(m) => {
                onNavigate(year, m);
                setView("day");
              }}
            />
          </div>
        </>
      )}

      {view === "day" && (
        <>
          <DayGrid
            year={year}
            month={month}
            selectedDay={selectedDay}
            coverageMap={coverageMap}
            isLoading={isLoading}
            monthHasCoverage={monthHasCoverage}
            monthIsFuture={monthIsFuture}
            onSelect={onSelectDay}
            onNavigateMonth={goto}
            focusHint={focusHint ?? undefined}
          />

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
            <button
              type="button"
              data-compact
              onClick={() => {
                onNavigate(ty, tm);
                onSelectDay(iso(ty, tm, td));
              }}
              className="rounded-lg px-2 py-1 text-[11px] font-medium text-accent hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              Today
            </button>
            <button
              type="button"
              data-compact
              onClick={() => {
                onNavigate(ty, tm);
                onSelectDay(iso(ty, tm, 1));
              }}
              className="rounded-lg px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              First of month
            </button>
          </div>

          <Legend daysCaptured={daysCaptured} />
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

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
  const [year, setYear] = useState(() => initialYear ?? todayParts()[0]);
  const [month, setMonth] = useState(() => initialMonth ?? todayParts()[1]);
  const [view, setView] = useState<PickerView>("day");
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Follow an external month change (the parent refetches coverage for it), using
  // the render-phase "derive state from props" pattern rather than an effect, so
  // there is no frame showing the old month next to the new month's dots.
  const [seenInitial, setSeenInitial] = useState({
    y: initialYear ?? null,
    m: initialMonth ?? null,
  });
  if (seenInitial.y !== (initialYear ?? null) || seenInitial.m !== (initialMonth ?? null)) {
    setSeenInitial({ y: initialYear ?? null, m: initialMonth ?? null });
    if (initialYear !== undefined) setYear(initialYear);
    if (initialMonth !== undefined) setMonth(initialMonth);
  }

  // Jump the grid to whatever day is selected, wherever it was selected from.
  const [seenSelection, setSeenSelection] = useState(selectedDay);
  if (seenSelection !== selectedDay) {
    setSeenSelection(selectedDay);
    if (selectedDay) {
      const y = Number(selectedDay.slice(0, 4));
      const m = Number(selectedDay.slice(5, 7));
      if (Number.isFinite(y) && y >= MIN_YEAR && m >= 1 && m <= 12) {
        setYear(y);
        setMonth(m);
      }
    }
  }

  /** Grid navigation: move the visible month and tell the parent to refetch. */
  const handleNavigate = useCallback(
    (y: number, m: number) => {
      setYear(y);
      setMonth(m);
      onMonthChange?.(y, m);
    },
    [onMonthChange],
  );

  /** A day was chosen: commit it and dismiss, so the next tap is on the page. */
  const handleDaySelect = useCallback(
    (day: string) => {
      onChange(day);
      setOpen(false);
    },
    [onChange],
  );

  const selectedLabel = selectedDay
    ? new Date(`${selectedDay}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Pick a day";

  const bodyProps: PickerBodyProps = {
    year,
    month,
    view,
    setView,
    selectedDay,
    coverage,
    isLoading,
    onSelectDay: handleDaySelect,
    onNavigate: handleNavigate,
  };

  const trigger = (
    <button
      type="button"
      aria-label={`Choose a date for ${domain}. Selected: ${selectedLabel}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      className="cw-btn cw-btn-secondary max-w-full"
    >
      <CalendarDays className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />
      <span className="truncate">{selectedLabel}</span>
    </button>
  );

  if (isMobile) {
    return (
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setView("day");
        }}
      >
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content
            className="cw-overlay overlay-shadow fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto rounded-t-2xl border-b-0 p-4 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom duration-200"
            style={{
              paddingBottom: "calc(1rem + var(--sai-bottom))",
              paddingLeft: "max(1rem, var(--sai-left))",
              paddingRight: "max(1rem, var(--sai-right))",
            }}
            aria-describedby={undefined}
          >
            <div className="mx-auto mb-3 h-1 w-12 rounded-full bg-muted" aria-hidden />
            <Dialog.Title className="sr-only">
              Choose a date for {domain}
            </Dialog.Title>
            {/* Live region: the grid's contents change under the user as they
              * navigate, and a screen reader gets no other notice of it. */}
            <p className="sr-only" role="status" aria-live="polite">
              {MONTHS[month - 1]} {year},{" "}
              {coverage.filter((c) => c.captureCount > 0).length} days with captures
            </p>
            <PickerBody {...bodyProps} onClose={() => setOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView("day");
      }}
    >
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="start"
          collisionPadding={12}
          className="cw-overlay overlay-shadow z-50 w-[20.5rem] max-w-[calc(100vw-1.5rem)] rounded-xl p-3 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-150"
        >
          <p className="sr-only" role="status" aria-live="polite">
            {MONTHS[month - 1]} {year},{" "}
            {coverage.filter((c) => c.captureCount > 0).length} days with captures
          </p>
          <PickerBody {...bodyProps} />
          <Popover.Arrow className="fill-popover" width={14} height={7} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
