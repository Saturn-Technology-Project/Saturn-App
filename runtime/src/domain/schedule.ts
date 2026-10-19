import type { AutomationFrequency, AutomationTrigger } from "./model.js";

const DAY = 1440;
const FREQUENCIES: AutomationFrequency[] = ["hourly", "daily", "weekdays", "weekly"];

export function validTimeZone(value: unknown): string {
  const zone = typeof value === "string" && value.trim() ? value.trim() : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    throw new Error(`Unknown time zone: ${zone}`);
  }
}

export function triggerOf(value: unknown, fallback?: AutomationTrigger): AutomationTrigger {
  const input = (value && typeof value === "object" ? value : {}) as Partial<AutomationTrigger>;
  const frequency = FREQUENCIES.includes(input.frequency as AutomationFrequency)
    ? (input.frequency as AutomationFrequency)
    : fallback?.frequency ?? "daily";
  const time = typeof input.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)
    ? input.time
    : fallback?.time ?? "09:00";
  const weekday = Number.isInteger(input.weekday) && Number(input.weekday) >= 0 && Number(input.weekday) <= 6
    ? Number(input.weekday)
    : fallback?.weekday ?? 1;
  return { frequency, time, weekday };
}

/**
 * Minutes since the epoch of the wall-clock time in `timeZone`, treated as if it were UTC.
 * Slots are compared in this space so DST shifts never skip or repeat a run by a full day.
 */
export function localMinute(now: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) / 60000;
}

function matches(trigger: AutomationTrigger, minute: number): boolean {
  if (trigger.frequency === "hourly") return true;
  const weekday = new Date(minute * 60000).getUTCDay();
  if (trigger.frequency === "weekdays") return weekday >= 1 && weekday <= 5;
  if (trigger.frequency === "weekly") return weekday === trigger.weekday;
  return true;
}

function anchor(trigger: AutomationTrigger, local: number): { start: number; step: number } {
  const [hour, minute] = trigger.time.split(":").map(Number);
  if (trigger.frequency === "hourly") return { start: Math.floor(local / 60) * 60 + minute, step: 60 };
  return { start: Math.floor(local / DAY) * DAY + hour * 60 + minute, step: DAY };
}

/** Latest scheduled slot at or before `local`. */
export function previousSlot(trigger: AutomationTrigger, local: number): number {
  let { start, step } = anchor(trigger, local);
  while (start > local || !matches(trigger, start)) start -= step;
  return start;
}

/** Earliest scheduled slot after `local`. */
export function nextSlot(trigger: AutomationTrigger, local: number): number {
  let { start, step } = anchor(trigger, local);
  while (start <= local || !matches(trigger, start)) start += step;
  return start;
}

/** "YYYY-MM-DD HH:MM" wall-clock text for a local-minute index. */
export function slotLabel(minute: number): string {
  return new Date(minute * 60000).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Reads the cron shapes Saturn's scheduler can run: hourly ("M * * * *"), daily ("M H * * *"),
 * weekdays ("M H * * 1-5") and weekly ("M H * * D"), optionally prefixed with CRON_TZ=<zone>.
 * Anything else is refused with the supported shapes, instead of being stored and never firing.
 */
export function cronToTrigger(cron: string): { trigger: AutomationTrigger; timeZone?: string } {
  let text = cron.trim();
  let timeZone: string | undefined;
  const tz = /^CRON_TZ=(\S+)\s+(.*)$/.exec(text);
  if (tz) {
    timeZone = validTimeZone(tz[1]);
    text = tz[2].trim();
  }
  const fields = text.split(/\s+/);
  const unsupported = () =>
    new Error(
      `Unsupported schedule "${cron}". Saturn runs hourly ("M * * * *"), daily ("M H * * *"), weekdays ("M H * * 1-5") or weekly ("M H * * D", 0 = Sunday) schedules.`,
    );
  if (fields.length !== 5) throw unsupported();
  const [minute, hour, day, month, weekday] = fields;
  const number = (value: string, max: number) => (/^\d+$/.test(value) && Number(value) <= max ? Number(value) : null);
  const m = number(minute, 59);
  if (m === null || day !== "*" || month !== "*") throw unsupported();
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hour === "*" && weekday === "*") return { trigger: { frequency: "hourly", time: `00:${pad(m)}`, weekday: 1 }, timeZone };
  const h = number(hour, 23);
  if (h === null) throw unsupported();
  const time = `${pad(h)}:${pad(m)}`;
  if (weekday === "*") return { trigger: { frequency: "daily", time, weekday: 1 }, timeZone };
  if (weekday === "1-5") return { trigger: { frequency: "weekdays", time, weekday: 1 }, timeZone };
  const d = number(weekday === "7" ? "0" : weekday, 6);
  if (d === null) throw unsupported();
  return { trigger: { frequency: "weekly", time, weekday: d }, timeZone };
}

/** The cron equivalent of a trigger, for tools that speak cron. */
export function triggerToCron(trigger: AutomationTrigger): string {
  const [hour, minute] = trigger.time.split(":").map(Number);
  if (trigger.frequency === "hourly") return `${minute} * * * *`;
  if (trigger.frequency === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (trigger.frequency === "weekly") return `${minute} ${hour} * * ${trigger.weekday}`;
  return `${minute} ${hour} * * *`;
}
