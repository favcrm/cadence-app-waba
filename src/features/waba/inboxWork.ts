import { ApiError } from "@cadence/screen-ui";
import type { DisplayScope } from "../../bridge/scope";
import { serviceCall, type CallArgs } from "../../bridge/services";

export type ThreadState = "needs_reply" | "waiting" | "done";
export type ThreadFields = { name: string | null; state: ThreadState; due: string | null; seenInbound: number };
export type ThreadWork = ThreadFields & { ref: string; revision: number };
export type ThreadNote = { id: string; body: string; at: number };
export const emptyThread: ThreadFields = { name: null, state: "needs_reply", due: null, seenInbound: 0 };

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const validNoteTime = (v: unknown): v is number => integer(v) && v <= 8_640_000_000_000_000;
export const validInboxScope = (v: unknown): v is string => typeof v === "string" && /^lw_[a-f0-9]{32}$/.test(v);
export const validWorkRef = (v: unknown, inboxScope?: string): v is string => typeof v === "string" && /^lw_[a-f0-9]{32}_[a-f0-9]{64}$/.test(v) && (inboxScope === undefined || (validInboxScope(inboxScope) && v.startsWith(inboxScope + "_")));
const scopeOf = (ref: string) => ref.slice(0, 35);
function invalid(message: string, status = 502): never { throw new ApiError(message, status); }
function requireRef(ref: unknown): asserts ref is string { if (!validWorkRef(ref)) invalid("Invalid inbox thread reference", 400); }
function requireScope(scope: unknown): asserts scope is string { if (!validInboxScope(scope)) invalid("Invalid inbox scope", 400); }
function date(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1];
}
function validFields(v: ThreadFields): boolean {
  return object(v) && (v.name === null || (typeof v.name === "string" && v.name.length <= 100)) &&
    (v.state === "needs_reply" || v.state === "waiting" || v.state === "done") &&
    (v.due === null || date(v.due)) && integer(v.seenInbound);
}
export function effectiveThreadState(work: ThreadFields | null | undefined, inboundVersion: number): ThreadState {
  if (!integer(inboundVersion) || (work != null && !validFields(work))) invalid("Invalid inbox state", 400);
  return !work || inboundVersion > work.seenInbound ? "needs_reply" : work.state;
}
function workReceipt(value: unknown, installId: string, expectedScope?: string): ThreadWork {
  if (!object(value) || value.table !== "inbox_work" || value.install_id !== installId || !validWorkRef(value.id, expectedScope) || !integer(value.revision) || value.revision < 1 || !object(value.profile)) invalid("Invalid inbox work receipt");
  const p = value.profile;
  if (p.thread_ref !== value.id || p.inbox_scope !== scopeOf(value.id)) invalid("Invalid inbox work scope");
  const fields = { name: p.display_name, state: p.state, due: p.follow_up_on, seenInbound: p.seen_inbound } as ThreadFields;
  if (!validFields(fields)) invalid("Invalid inbox work profile");
  if (Object.keys(p).length !== 6 || !["inbox_scope", "thread_ref", "display_name", "state", "follow_up_on", "seen_inbound"].every(key => Object.hasOwn(p, key))) invalid("Invalid inbox work profile");
  return { ref: value.id, revision: value.revision, ...fields };
}
function noteReceipt(value: unknown, installId: string, ref: string): ThreadNote {
  if (!object(value) || value.table !== "inbox_notes" || value.install_id !== installId || !uuid(value.id) || !integer(value.revision) || value.revision !== 1 || !object(value.profile)) invalid("Invalid inbox note receipt");
  const p = value.profile;
  if (Object.keys(p).length !== 3 || !["thread_ref", "body", "noted_at"].every(key => Object.hasOwn(p, key))) invalid("Invalid inbox note profile");
  if (p.thread_ref !== ref || typeof p.body !== "string" || p.body.length < 1 || p.body.length > 1000 || !validNoteTime(p.noted_at)) invalid("Invalid inbox note profile");
  return { id: value.id, body: p.body, at: p.noted_at };
}
function page(value: unknown): { records: unknown[]; cursor: string | null } {
  if (!object(value) || !Array.isArray(value.records) || value.records.length > 100 || !integer(value.total) || typeof value.truncated !== "boolean" || !(value.next_cursor === null || id(value.next_cursor)) || value.truncated !== (value.next_cursor !== null)) invalid("Invalid inbox page receipt");
  return { records: value.records, cursor: value.next_cursor as string | null };
}
function cursorArg(cursor?: string | null): { cursor?: string } {
  if (cursor == null) return {};
  if (!id(cursor)) invalid("Invalid inbox cursor", 400);
  return { cursor };
}
type ListArgs = CallArgs["records.list"];
const scopeFilter = (scope: string): ListArgs["filters"][number] => ({ field: "inbox_scope", op: "eq", value: scope });

export async function readThreadWork(scope: DisplayScope, ref: string): Promise<ThreadWork | null> {
  requireRef(ref);
  try {
    const result = await serviceCall(scope, "records.show", { table: "inbox_work", record_id: ref });
    if (!object(result)) invalid("Invalid inbox work receipt");
    const work = workReceipt(result.record, scope.installId, scopeOf(ref));
    if (work.ref !== ref) invalid("Invalid inbox work reference");
    return work;
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_found") return null;
    throw e;
  }
}
export async function listThreadWork(scope: DisplayScope, inboxScope: string, refs: readonly string[]): Promise<ThreadWork[]> {
  requireScope(inboxScope);
  if (!Array.isArray(refs) || !refs.every(ref => validWorkRef(ref, inboxScope))) invalid("Invalid inbox references", 400);
  const unique = [...new Set(refs)], result: ThreadWork[] = [];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50), allowed = new Set(batch);
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const raw = await serviceCall(scope, "records.list", { table: "inbox_work", filters: [scopeFilter(inboxScope), { field: "thread_ref", op: "in", value: batch }], limit: batch.length, ...cursorArg(cursor) });
      const p = page(raw);
      for (const row of p.records) {
        const work = workReceipt(row, scope.installId, inboxScope);
        if (!allowed.delete(work.ref)) invalid("Unexpected inbox work row");
        result.push(work);
      }
      if (p.cursor !== null && cursors.has(p.cursor)) invalid("Invalid inbox page cursor");
      if (p.cursor !== null) cursors.add(p.cursor);
      cursor = p.cursor;
    } while (cursor !== null);
  }
  return result;
}
export async function listFollowUps(scope: DisplayScope, inboxScope: string, through: string, cursor?: string | null): Promise<{ rows: ThreadWork[]; cursor: string | null }> {
  requireScope(inboxScope);
  if (!date(through)) invalid("Invalid follow-up date", 400);
  const p = page(await serviceCall(scope, "records.list", { table: "inbox_work", filters: [scopeFilter(inboxScope), { field: "follow_up_on", op: "lte", value: through }], limit: 100, order_by: { field: "follow_up_on", direction: "asc" }, ...cursorArg(cursor) }));
  const rows = p.records.map(row => workReceipt(row, scope.installId, inboxScope));
  if (rows.some((row, i) => row.due === null || row.due > through || (i > 0 && rows[i - 1].due! > row.due))) invalid("Invalid follow-up page");
  return { rows, cursor: p.cursor };
}
export async function listNamedThreads(scope: DisplayScope, inboxScope: string, query: string, cursor?: string | null): Promise<{ rows: ThreadWork[]; cursor: string | null }> {
  requireScope(inboxScope);
  if (!query || new TextEncoder().encode(query).length > 256 || /[\x00-\x1f\x7f]/.test(query)) invalid("Invalid name search", 400);
  const p = page(await serviceCall(scope, "records.list", { table: "inbox_work", filters: [scopeFilter(inboxScope), { field: "display_name", op: "contains", value: query }], limit: 100, order_by: { field: "display_name", direction: "asc" }, ...cursorArg(cursor) }));
  const rows = p.records.map(row => workReceipt(row, scope.installId, inboxScope));
  if (rows.some(row => row.name === null)) invalid("Invalid name search page");
  return { rows, cursor: p.cursor };
}
export async function saveThreadWork(scope: DisplayScope, ref: string, fields: ThreadFields, revision: number | null): Promise<ThreadWork> {
  requireRef(ref);
  if (!validFields(fields) || (revision !== null && (!integer(revision) || revision < 1 || revision === Number.MAX_SAFE_INTEGER))) invalid("Invalid inbox work", 400);
  const profile = { inbox_scope: scopeOf(ref), thread_ref: ref, display_name: fields.name, state: fields.state, follow_up_on: fields.due, seen_inbound: fields.seenInbound };
  const args = { table: "inbox_work" as const, record_id: ref, profile };
  const result = revision === null ? await serviceCall(scope, "records.create", args) : await serviceCall(scope, "records.update", { ...args, expected_revision: revision });
  if (!object(result)) invalid("Invalid inbox work receipt");
  const work = workReceipt(result.record, scope.installId, scopeOf(ref));
  if (work.ref !== ref || work.revision !== (revision ?? 0) + 1 || work.name !== fields.name || work.state !== fields.state || work.due !== fields.due || work.seenInbound !== fields.seenInbound) invalid("Inbox work save could not be confirmed");
  return work;
}
export async function listThreadNotes(scope: DisplayScope, ref: string, cursor?: string | null): Promise<{ rows: ThreadNote[]; cursor: string | null }> {
  requireRef(ref);
  const p = page(await serviceCall(scope, "records.list", { table: "inbox_notes", filters: [{ field: "thread_ref", op: "eq", value: ref }], limit: 100, order_by: { field: "noted_at", direction: "desc" }, ...cursorArg(cursor) }));
  const rows = p.records.map(row => noteReceipt(row, scope.installId, ref));
  if (rows.some((row, i) => i > 0 && rows[i - 1].at < row.at)) invalid("Invalid inbox note page");
  return { rows, cursor: p.cursor };
}
export async function addThreadNote(scope: DisplayScope, ref: string, note: ThreadNote): Promise<ThreadNote> {
  requireRef(ref);
  if (!object(note) || !uuid(note.id) || typeof note.body !== "string" || note.body.length < 1 || note.body.length > 1000 || !validNoteTime(note.at)) invalid("Invalid inbox note", 400);
  let result: unknown;
  try {
    result = await serviceCall(scope, "records.create", { table: "inbox_notes", record_id: note.id, profile: { thread_ref: ref, body: note.body, noted_at: note.at } });
  } catch (error) {
    // A previous request may have committed before losing its receipt. Read
    // the same id and require the original exact note, not a second write.
    if (!(error instanceof ApiError) || error.code !== "record_exists") throw error;
    result = await serviceCall(scope, "records.show", { table: "inbox_notes", record_id: note.id });
  }
  if (!object(result)) invalid("Invalid inbox note receipt");
  const saved = noteReceipt(result.record, scope.installId, ref);
  if (saved.id !== note.id || saved.body !== note.body || saved.at !== note.at) invalid("Inbox note save could not be confirmed");
  return saved;
}
