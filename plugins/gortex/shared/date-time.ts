import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const hostTimeSchema = z.object({ timeZone: z.string().min(1).max(100), locale: z.string().min(1).max(100) });
export const hostTimeRpc = defineRpc({ name: "host.time-settings", input: z.object({}), output: hostTimeSchema });
export type HostTimeSettings = z.infer<typeof hostTimeSchema>;

export function createDateTimeFormatter(settings: HostTimeSettings | null): (value: string | null | undefined) => string {
  let formatter: Intl.DateTimeFormat;
  let fallback = !settings;
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  try { formatter = new Intl.DateTimeFormat(settings?.locale ?? "en-US", { ...options, timeZone: settings?.timeZone ?? "UTC" }); }
  catch { fallback = true; formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }); }
  return value => {
    if (!value || /^0001-01-01/.test(value)) return "Not reported";
    // Refuse timezone-less input: parsing it would silently use the viewing device's timezone.
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return "Invalid timestamp";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Invalid timestamp";
    return formatter.format(date) + (fallback ? " (host time zone unavailable)" : "");
  };
}
