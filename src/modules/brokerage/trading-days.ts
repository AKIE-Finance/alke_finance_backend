/**
 * Calendar helpers for the BVMAC session model (one fixing per trading day,
 * Monday to Friday). Public holidays are not modelled in v1.0 — an order that
 * straddles a holiday expires one session early at worst, which is the safe
 * direction (the reserve is released, never kept longer than promised).
 *
 * All computations are done in the market timezone (Africa/Douala = UTC+1,
 * no daylight saving) via Intl, so the server's own timezone is irrelevant.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

const pad = (n: number, len = 2): string => String(n).padStart(len, '0');

/** YYYYMMDD in the given timezone. */
export function yyyymmdd(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}${pad(p.month)}${pad(p.day)}`;
}

/** YYYY-MM-DD in the given timezone. */
export function isoDate(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "HH:mm" in the given timezone. */
export function localTime(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** UTC offset of a timezone at `date`, in minutes (Africa/Douala → 60). */
export function utcOffsetMinutes(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60000);
}

/** ISO-8601 with the timezone's numeric offset, e.g. 2026-09-04T10:15:00+01:00 (seconds precision). */
export function isoWithOffset(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  const off = utcOffsetMinutes(date, timeZone);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** A calendar day as a UTC-midnight Date (timezone-free arithmetic). */
export type CalendarDay = Date;

export function calendarDay(date: Date, timeZone: string): CalendarDay {
  const p = localParts(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

export function calendarDayFromYYYYMMDD(s: string): CalendarDay | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isTradingDay(day: CalendarDay): boolean {
  const dow = day.getUTCDay();
  return dow !== 0 && dow !== 6;
}

export function addDays(day: CalendarDay, n: number): CalendarDay {
  return new Date(day.getTime() + n * 86_400_000);
}

export function nextTradingDay(day: CalendarDay): CalendarDay {
  let d = addDays(day, 1);
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}

/** Adds `n` trading days to `day` (n ≥ 0). */
export function addTradingDays(day: CalendarDay, n: number): CalendarDay {
  let d = day;
  for (let i = 0; i < n; i++) d = nextTradingDay(d);
  return d;
}

/** Number of trading days in the closed interval [from, to]; 0 when to < from. */
export function tradingDaysInclusive(from: CalendarDay, to: CalendarDay): number {
  if (to.getTime() < from.getTime()) return 0;
  let count = 0;
  for (let d = from; d.getTime() <= to.getTime(); d = addDays(d, 1)) if (isTradingDay(d)) count++;
  return count;
}

/**
 * First fixing session an order transmitted at `at` can reach: the same day
 * when it is a trading day and the market cut-off has not passed, else the
 * next trading day.
 */
export function firstSession(at: Date, timeZone: string, cutoffTime: string): CalendarDay {
  const day = calendarDay(at, timeZone);
  if (isTradingDay(day) && localTime(at, timeZone) < cutoffTime) return day;
  return nextTradingDay(day);
}

/**
 * Whether an order transmitted at `transmittedAt` with `sessions` allowed
 * fixings is stale at `now`: every allowed session has ended (the last
 * session's day is over, or it is today and the session close has passed).
 */
export function isExpired(
  transmittedAt: Date,
  sessions: number,
  now: Date,
  timeZone: string,
  cutoffTime: string,
  sessionClose = '16:00',
): boolean {
  const first = firstSession(transmittedAt, timeZone, cutoffTime);
  const last = addTradingDays(first, Math.max(1, sessions) - 1);
  const today = calendarDay(now, timeZone);
  if (today.getTime() > last.getTime()) return true;
  if (today.getTime() < last.getTime()) return false;
  return localTime(now, timeZone) >= sessionClose;
}

/** Sessions allowed by a validity string: DAY → 1; GTD:YYYYMMDD → trading days from the first session to that date (≥ 1). */
export function sessionsForValidity(validity: string, at: Date, timeZone: string, cutoffTime: string): number | null {
  if (validity === 'DAY') return 1;
  const m = /^GTD:(\d{8})$/.exec(validity);
  if (!m) return null;
  const until = calendarDayFromYYYYMMDD(m[1]);
  if (!until) return null;
  const first = firstSession(at, timeZone, cutoffTime);
  if (until.getTime() < first.getTime()) return null;
  return Math.max(1, tradingDaysInclusive(first, until));
}
