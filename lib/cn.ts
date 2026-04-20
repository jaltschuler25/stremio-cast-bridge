/**
 * Tiny classname joiner — avoids an extra dependency for what is
 * essentially a one-liner. Filters out falsy values so we can write
 * conditional classes inline without ternaries everywhere.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
