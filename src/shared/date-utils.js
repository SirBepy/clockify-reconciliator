import {
  parse,
  format,
  isSameDay,
  addHours,
  differenceInDays,
  startOfDay,
  endOfDay,
} from "date-fns";

/**
 * Parse Clockify date format (MM/DD/YYYY) and time (hh:mm AM/PM) as local time
 * @param {string} dateStr - Date in MM/DD/YYYY format
 * @param {string} timeStr - Time in hh:mm AM/PM format
 * @returns {Date} Parsed date in local timezone
 */
export function parseClockifyDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) {
    throw new Error("Date and time strings are required");
  }

  const dateTimeStr = `${dateStr} ${timeStr}`;
  return parse(dateTimeStr, "MM/dd/yyyy hh:mm a", new Date());
}

/**
 * Parse ISO 8601 string and convert to local timezone Date object
 * @param {string} isoStr - ISO 8601 formatted string
 * @returns {Date} Parsed date in local timezone
 */
export function parseISOToLocal(isoStr) {
  if (!isoStr) {
    throw new Error("ISO date string is required");
  }

  return new Date(isoStr);
}

/**
 * Check if two dates are the same local day
 * @param {Date} date1 - First date
 * @param {Date} date2 - Second date
 * @returns {boolean} True if dates are on the same day
 */
export function isSameLocalDay(date1, date2) {
  if (!(date1 instanceof Date) || !(date2 instanceof Date)) {
    throw new Error("Both arguments must be Date objects");
  }

  return isSameDay(date1, date2);
}

/**
 * Check if date is within ±N days of target
 * @param {Date} date - Date to check
 * @param {Date} targetDate - Target date
 * @param {number} windowDays - Number of days on each side
 * @returns {boolean} True if within window
 */
export function isWithinDayWindow(date, targetDate, windowDays) {
  if (!(date instanceof Date) || !(targetDate instanceof Date)) {
    throw new Error("date and targetDate must be Date objects");
  }

  if (!Number.isInteger(windowDays) || windowDays < 0) {
    throw new Error("windowDays must be a non-negative integer");
  }

  const daysDiff = Math.abs(differenceInDays(date, targetDate));
  return daysDiff <= windowDays;
}

/**
 * Deterministic sequential time slicing
 * Splits a time window into sequential segments with specified durations
 * @param {Date} startDate - Start of time window
 * @param {Date} endDate - End of time window
 * @param {number[]} durations - Array of durations in hours
 * @returns {Array<{start: Date, end: Date}>} Array of time segments
 */
export function splitTimeWindow(startDate, endDate, durations) {
  if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
    throw new Error("startDate and endDate must be Date objects");
  }

  if (!Array.isArray(durations) || durations.length === 0) {
    throw new Error("durations must be a non-empty array");
  }

  const totalDuration = durations.reduce((sum, d) => sum + d, 0);
  const windowDuration = (endDate - startDate) / (1000 * 60 * 60); // in hours

  if (Math.abs(windowDuration - totalDuration) > 0.001) {
    throw new Error(
      `Total durations (${totalDuration}h) must equal window duration (${windowDuration}h)`,
    );
  }

  const segments = [];
  let currentStart = new Date(startDate);

  for (const duration of durations) {
    const currentEnd = addHours(currentStart, duration);
    segments.push({
      start: new Date(currentStart),
      end: new Date(currentEnd),
    });
    currentStart = currentEnd;
  }

  return segments;
}

/**
 * Format Date to MM/DD/YYYY
 * @param {Date} date - Date to format
 * @returns {string} Formatted date string
 */
export function formatClockifyDate(date) {
  if (!(date instanceof Date)) {
    throw new Error("Argument must be a Date object");
  }

  return format(date, "MM/dd/yyyy");
}

/**
 * Format Date to hh:mm AM/PM
 * @param {Date} date - Date to format
 * @returns {string} Formatted time string
 */
export function formatClockifyTime(date) {
  if (!(date instanceof Date)) {
    throw new Error("Argument must be a Date object");
  }

  return format(date, "hh:mm a");
}
