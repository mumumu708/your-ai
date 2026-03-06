/**
 * Standard 5-field cron expression parser.
 *
 * ┌──────────── minute (0-59)
 * │ ┌────────── hour (0-23)
 * │ │ ┌──────── day of month (1-31)
 * │ │ │ ┌────── month (1-12)
 * │ │ │ │ ┌──── day of week (0-7, 0 and 7 = Sunday)
 * * * * * *
 *
 * Supports: *, ranges (1-5), steps (*\/30), lists (1,3,5), combined (1-5/2)
 */

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

const FIELD_RANGES: Array<{ min: number; max: number; name: string }> = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day of month' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 7, name: 'day of week' },
];

/**
 * Parse a 5-field cron expression into expanded field arrays.
 */
function parse(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  const parsed = parts.map((part, i) => {
    const range = FIELD_RANGES[i];
    if (!range) {
      throw new Error(`Missing field range for index ${i}`);
    }
    return parseField(part, range);
  });

  const minutes = parsed[0]!;
  const hours = parsed[1]!;
  const daysOfMonth = parsed[2]!;
  const months = parsed[3]!;
  const daysOfWeek = parsed[4]!;

  // Normalize day of week: 7 → 0 (both mean Sunday)
  const normalizedDow = daysOfWeek.map((d) => (d === 7 ? 0 : d));
  const uniqueDow = [...new Set(normalizedDow)].sort((a, b) => a - b);

  return { minutes, hours, daysOfMonth, months, daysOfWeek: uniqueDow };
}

/**
 * Parse a single cron field. Supports wildcards, ranges, steps, and lists.
 */
function parseField(field: string, range: { min: number; max: number; name: string }): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const base = stepMatch ? stepMatch[1]! : part;
    const step = stepMatch ? Number.parseInt(stepMatch[2]!, 10) : 1;

    if (step <= 0) {
      throw new Error(`Invalid step in cron field '${field}': step must be > 0`);
    }

    let start: number;
    let end: number;

    if (base === '*') {
      start = range.min;
      end = range.max;
    } else if (base.includes('-')) {
      const rangeParts = base.split('-').map(Number);
      const lo = rangeParts[0];
      const hi = rangeParts[1];
      if (lo == null || hi == null || Number.isNaN(lo) || Number.isNaN(hi)) {
        throw new Error(`Invalid range in cron field '${field}'`);
      }
      start = lo;
      end = hi;
    } else {
      const num = Number.parseInt(base, 10);
      if (Number.isNaN(num)) {
        throw new Error(`Invalid value in cron field '${field}'`);
      }
      if (step === 1) {
        // Single value
        if (num < range.min || num > range.max) {
          throw new Error(
            `Value ${num} out of range for ${range.name} (${range.min}-${range.max})`,
          );
        }
        values.add(num);
        continue;
      }
      start = num;
      end = range.max;
    }

    if (start < range.min || end > range.max || start > end) {
      throw new Error(
        `Range ${start}-${end} out of bounds for ${range.name} (${range.min}-${range.max})`,
      );
    }

    for (let i = start; i <= end; i += step) {
      values.add(i);
    }
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Calculate the next run time after `after` for a given cron expression.
 * Returns a Date or null if no valid time found within reasonable bounds.
 */
function nextRun(expression: string, after: Date = new Date()): Date | null {
  const fields = parse(expression);

  // Start from the next minute
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // Limit search to 2 years to avoid infinite loops
  const limit = new Date(after.getTime() + 2 * 365 * 24 * 60 * 60 * 1000);

  while (cursor < limit) {
    if (!fields.months.includes(cursor.getMonth() + 1)) {
      // Advance to next valid month
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    if (!fields.daysOfMonth.includes(cursor.getDate())) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    // Check day of week (0=Sun, 1=Mon, ..., 6=Sat)
    if (!fields.daysOfWeek.includes(cursor.getDay())) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    if (!fields.hours.includes(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!fields.minutes.includes(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }

    return new Date(cursor.getTime());
  }

  return null;
}

/**
 * Validate a cron expression. Returns null if valid, error message if invalid.
 */
function validate(expression: string): string | null {
  try {
    parse(expression);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export const CronParser = { parse, parseField, nextRun, validate } as const;
