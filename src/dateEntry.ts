/**
 * Type definition for ISO date segment objects.
 */
export type DateSegments = {
  month: string;
  day: string;
  year: string;
};

/**
 * Gets the full year from a two-digit year using the century rule.
 * @param twoDigitYear - A two-digit year (00-99).
 * @param currentYear - The current year for reference (defaults to today's year).
 * @returns The four-digit full year.
 */
export const getFullYearForTwoDigitYear = (
  twoDigitYear: number,
  currentYear = new Date().getFullYear(),
) => {
  const currentCentury = Math.floor(currentYear / 100) * 100;
  return twoDigitYear <= currentYear % 100
    ? currentCentury + twoDigitYear
    : currentCentury - 100 + twoDigitYear;
};

/**
 * Parses an ISO-formatted date string into its component segments.
 * @param date - An ISO date string in YYYY-MM-DD format.
 * @returns An object containing the year, month, and day segments.
 */
export const parseDateSegments = (date: string): DateSegments => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match
    ? { year: match[1], month: match[2], day: match[3] }
    : { month: "", day: "", year: "" };
};

/**
 * Completes a partial date segment field (year or month/day).
 * @param value - The current value for the field.
 * @param field - The field to complete ('year', 'month', or 'day').
 * @returns The completed value as a string.
 */
export const completeDateSegment = (
  value: string,
  field: keyof DateSegments,
): string => {
  if (!value) {
    return value;
  }
  if (field === "year") {
    return value.length <= 2
      ? String(getFullYearForTwoDigitYear(Number(value)))
      : value;
  }
  return value.padStart(2, "0");
};

/**
 * Converts date segments into a validated ISO 8601 date string.
 * @param month - The one-digit or two-digit month (01-12).
 * @param day - The one-digit or two-digit day.
 * @param year - A two-digit or four-digit year.
 * @returns The ISO-formatted date string, or null if invalid.
 */
export const toIsoDate = ({
  month,
  day,
  year,
}: DateSegments): string | null => {
  if (
    !/^\d{2}$/.test(month) ||
    !/^\d{2}$/.test(day) ||
    !/^(\d{2}|\d{4})$/.test(year)
  ) {
    return null;
  }

  const fullYear =
    year.length <= 2 ? getFullYearForTwoDigitYear(Number(year)) : Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const isLeapYear =
    fullYear % 4 === 0 && (fullYear % 100 !== 0 || fullYear % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  if (
    fullYear < 1 ||
    monthNumber < 1 ||
    monthNumber > 12 ||
    dayNumber < 1 ||
    dayNumber > daysInMonth[monthNumber - 1]
  ) {
    return null;
  }

  return `${String(fullYear).padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
};
