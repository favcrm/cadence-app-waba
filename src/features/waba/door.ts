import { ApiError } from "@cadence/screen-ui";
/** Door answers (`agenticos.whatsapp-door.v1`, design §3) as the host relays
 *  them. Reads are display data only: every authority check stays host-side. */
export interface Status {
  connected: boolean; displayPhoneNumber: string | null; verifiedName: string | null; wabaId: string | null; phoneNumberId: string | null;
  webhook: { subscribed: boolean | null; status: string | null; error: string | null; fields: string[] } | null; observedAt: string | null;
}
export interface ConnectSession { url: string; expiresAt: string | null }
export interface ConversationRow {
  conversationId: string; contact: { name: string | null; phone: string | null };
  lastMessage: { direction: string | null; body: string | null; createdAt: string | null } | null;
  unreadCount: number | null; replyMode: string | null; freeformUntil: string | null;
}
export interface Conversation extends ConversationRow { status: string | null; lastInboundAt: string | null; handoffAt: string | null }
export interface Message { id: string; direction: string | null; body: string | null; status: string | null; senderType: string | null; createdAt: string | null; type: string | null }
export interface Page<T> { rows: T[]; cursor: string | null }
/** The host's reply states; anything else reads as uncertain. */
export type ReplyState = "sent" | "pending" | "failed" | "refused" | "uncertain";
export interface Prepared { effect_id: string; decision: string | null; expires_at: string | null }
export interface ReplyStatus { state: string; door: string | null }

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => typeof v === "string" && v !== "" ? v : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
function bad(): never { throw new ApiError("The WhatsApp door answered an unexpected shape", 502); }
export const CONTRACT = "agenticos.whatsapp-door.v1";
function door(v: unknown): Record<string, unknown> { if (!obj(v) || v.contract !== CONTRACT) bad(); return v; }

export function parseStatus(v: unknown): Status {
  const d = door(v);
  if (typeof d.connected !== "boolean") bad();
  const w = obj(d.webhook) ? d.webhook : null;
  return {
    connected: d.connected, displayPhoneNumber: str(d.displayPhoneNumber), verifiedName: str(d.verifiedName), wabaId: str(d.wabaId), phoneNumberId: str(d.phoneNumberId),
    webhook: w && { subscribed: typeof w.subscribed === "boolean" ? w.subscribed : null, status: str(w.status), error: str(w.error), fields: Array.isArray(w.fields) ? w.fields.filter((f): f is string => typeof f === "string") : [] },
    observedAt: str(d.observedAt),
  };
}
export function parseConnect(v: unknown): ConnectSession {
  const d = door(v);
  let url: URL;
  try { url = new URL(String(d.url)); } catch { bad(); }
  // The door already pins the FavCRM portal origin; https is the frame's floor.
  if (url.protocol !== "https:" || url.username || url.password) bad();
  return { url: url.href, expiresAt: str(d.expiresAt) };
}
function row(v: unknown): ConversationRow {
  if (!obj(v) || !str(v.conversationId)) bad();
  const c = obj(v.contact) ? v.contact : {}, m = obj(v.lastMessage) ? v.lastMessage : null;
  return {
    conversationId: v.conversationId as string, contact: { name: str(c.name), phone: str(c.phone) },
    lastMessage: m && { direction: str(m.direction), body: str(m.body), createdAt: str(m.createdAt) },
    unreadCount: num(v.unreadCount), replyMode: str(v.replyMode), freeformUntil: str(v.freeformUntil),
  };
}
export function parseConversations(v: unknown): Page<ConversationRow> {
  const d = door(v);
  if (!Array.isArray(d.conversations)) bad();
  return { rows: d.conversations.map(row), cursor: str(d.cursor) };
}
export function parseConversation(v: unknown): Conversation {
  const d = door(v);
  return { ...row({ ...d, lastMessage: null }), status: str(d.status), lastInboundAt: str(d.lastInboundAt), handoffAt: str(d.handoffAt) };
}
export function parseMessages(v: unknown): Page<Message> {
  const d = door(v);
  if (!Array.isArray(d.messages)) bad();
  return { rows: d.messages.map(m => {
    if (!obj(m) || !str(m.id)) bad();
    return { id: m.id as string, direction: str(m.direction), body: str(m.body), status: str(m.status), senderType: str(m.senderType), createdAt: str(m.createdAt), type: str(m.type) };
  }), cursor: str(d.cursor) };
}
export function parsePrepared(v: unknown): Prepared {
  if (!obj(v) || typeof v.effect_id !== "string" || !/^wae_[0-9a-f]{32}$/.test(v.effect_id)) bad();
  return { effect_id: v.effect_id, decision: str(v.decision), expires_at: str(v.expires_at) };
}
/** A send answer. Fails closed: only an explicit known state is taken. */
export function sendState(v: unknown): ReplyState {
  const s = obj(v) && obj(v.reply) ? v.reply.state : null;
  return s === "sent" || s === "pending" || s === "failed" || s === "refused" ? s : "uncertain";
}
export function parseReplyStatus(v: unknown): ReplyStatus {
  if (!obj(v) || typeof v.state !== "string") bad();
  return { state: v.state, door: obj(v.door) ? str(v.door.state) : null };
}
/** A parked assistant draft (host `whatsapp.draft.show`); null when none is parked. */
export interface Draft { draftId: string; text: string }
export function parseDraft(v: unknown): Draft | null {
  if (!obj(v) || !("draft" in v)) bad();
  if (v.draft === null) return null;
  const d = v.draft;
  if (!obj(d) || !str(d.draft_id) || typeof d.text !== "string" || !d.text) bad();
  return { draftId: d.draft_id as string, text: d.text };
}
/** The free-text window: open only on an explicit `freeform` mode whose bound has not passed. */
export function windowOpen(c: Pick<ConversationRow, "replyMode" | "freeformUntil">, now = Date.now()): boolean {
  if (c.replyMode !== "freeform") return false;
  const until = c.freeformUntil ? Date.parse(c.freeformUntil) : NaN;
  return Number.isNaN(until) || until > now;
}
export function when(v: string | null): string {
  if (!v) return "—";
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toLocaleString();
}
/** Why a confirm card ended without a send. The host names its own refusals
 *  (`conflict`, `expired`, …); only `cancelled` is the person's own choice. */
export function declinedReason(error: unknown): { cancelled: boolean; code: string | null; text: string | null } {
  const api = error instanceof ApiError ? error : null;
  return { cancelled: !api || api.code === "cancelled", code: api?.code ?? null, text: api?.message || null };
}
/** Typed host refusals (`refusal.code`) with a clear sentence; any other code keeps the host message. */
const REFUSALS: Record<string, string> = {
  test_limit: "Test limit reached: up to 5 test sends per 24 hours.",
  invalid_request: "The host refused this request as invalid. Check the fields and try again.",
};
export function errorText(error: unknown, fallback: string): string {
  const code = error instanceof ApiError ? (error as ApiError & { code?: unknown }).code : undefined;
  if (typeof code === "string" && Object.hasOwn(REFUSALS, code)) return REFUSALS[code];
  if (error instanceof ApiError && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
