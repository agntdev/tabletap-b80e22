import type { Ctx } from "./bot.js";

export type BookingStatus = "confirmed" | "cancelled" | "rescheduled" | "no-show";
export interface Booking {
  id: string; ref: string; chatId: number; partySize: number; date: string; time: string;
  name?: string; phone?: string; status: BookingStatus; createdAt: string; updatedAt: string;
  rescheduleCount: number; reminderSentAt?: string;
}
export interface DomainState { bookings: Booking[]; audit: AuditEvent[]; settings: Settings; }
export interface AuditEvent { id: string; bookingId?: string; actor: "guest" | "owner" | "system"; action: string; at: string; details?: string; }
export interface Settings {
  timezone: string; sittingMinutes: number; reminderLeadHours: 1 | 2 | 3 | 24;
  maxLookaheadDays: number; open: string; close: string; tables: Record<string, number>;
}

const DEFAULTS: Settings = { timezone: "UTC", sittingMinutes: 90, reminderLeadHours: 2, maxLookaheadDays: 30, open: "11:00", close: "22:00", tables: { "2": 4, "4": 4, "6": 2 } };
const initial = (): DomainState => ({ bookings: [], audit: [], settings: { ...DEFAULTS, tables: { ...DEFAULTS.tables } } });
const envOf = (ctx: Ctx): Record<string, unknown> | undefined => (ctx as Ctx & { env?: Record<string, unknown> }).env;
type D1 = { prepare(sql: string): { bind(...args: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } } };

// D1 is the durable domain store in Workers. The harness has no binding, so it
// uses only the session as an isolated replay fixture; production never does.
export async function loadState(ctx: Ctx): Promise<DomainState> {
  const db = envOf(ctx)?.DB as D1 | undefined;
  if (db) {
    await db.prepare("CREATE TABLE IF NOT EXISTS tablereserve_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)").bind().run();
    const row = await db.prepare("SELECT value FROM tablereserve_state WHERE id = ?").bind("main").first<{ value: string }>();
    if (row?.value) return JSON.parse(row.value) as DomainState;
  }
  const existing = ctx.session.domain;
  if (existing) return existing;
  const state = initial(); ctx.session.domain = state; return state;
}
export async function saveState(ctx: Ctx, state: DomainState): Promise<void> {
  ctx.session.domain = state;
  const db = envOf(ctx)?.DB as D1 | undefined;
  if (db) {
    await db.prepare("INSERT INTO tablereserve_state (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value").bind("main", JSON.stringify(state)).run();
  }
}
export const now = (): Date => new Date();
export const today = (): string => now().toISOString().slice(0, 10);
export function addDays(date: string, count: number): string { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10); }
export function slots(settings: Settings): string[] {
  const [oh, om] = settings.open.split(":").map(Number); const [ch, cm] = settings.close.split(":").map(Number);
  const out: string[] = []; for (let m = oh * 60 + om; m + settings.sittingMinutes <= ch * 60 + cm; m += 15) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`); return out;
}
function tablesNeeded(size: number, tables: Record<string, number>): string[] | undefined {
  const available: string[] = []; for (const key of ["6", "4", "2"]) for (let i = 0; i < (tables[key] ?? 0); i++) available.push(key);
  const chosen: string[] = []; let remaining = size; for (const table of available) { if (remaining <= 0) break; chosen.push(table); remaining -= Number(table); }
  return remaining <= 0 ? chosen : undefined;
}
export function availableSlots(state: DomainState, date: string, partySize: number, excludeId?: string): string[] {
  return slots(state.settings).filter(time => {
    const candidateStart = minute(time);
    const candidateEnd = candidateStart + state.settings.sittingMinutes;
    const remaining = { ...state.settings.tables };
    for (const booking of state.bookings.filter(b => b.status === "confirmed" && b.date === date && b.id !== excludeId)) {
      const start = minute(booking.time);
      if (start >= candidateEnd || start + state.settings.sittingMinutes <= candidateStart) continue;
      const assigned = tablesNeeded(booking.partySize, remaining);
      if (!assigned) return false;
      for (const size of assigned) remaining[size] = (remaining[size] ?? 0) - 1;
    }
    return tablesNeeded(partySize, remaining) !== undefined;
  });
}
function minute(value: string): number { const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; }
export function newId(): string { return crypto.randomUUID(); }
export function newRef(state: DomainState): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const uuid = newId().replaceAll("-", "").toUpperCase();
  let ref = ""; for (let i = 0; i < 6; i++) ref += alphabet[parseInt(uuid.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
  if (state.bookings.some(b => b.ref === ref && b.status === "confirmed")) return newRef(state); return ref;
}
export function audit(state: DomainState, action: string, actor: AuditEvent["actor"], bookingId?: string, details?: string): void { state.audit.push({ id: newId(), action, actor, bookingId, at: now().toISOString(), details }); }
