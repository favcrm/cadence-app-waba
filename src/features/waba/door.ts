import { ApiError } from "@cadence/screen-ui";
import { validInboxScope,validWorkRef } from "./inboxWork";
/** Door answers (`agenticos.whatsapp-door.v1`, design §3) as the host relays
 *  them. Reads are display data only: every authority check stays host-side. */
export interface Status {
  connected: boolean; state: string | null; paused: boolean | null;
  displayPhoneNumber: string | null; verifiedName: string | null; wabaId: string | null; phoneNumberId: string | null;
  webhook: { subscribed: boolean | null; status: string | null; error: string | null; fields: string[] } | null; observedAt: string | null;
}
export interface ConnectSession { url: string; expiresAt: string | null }
export type WorkLink = { ref: string; inboundVersion: number };
export interface ConversationRow {
  conversationId: string; contact: { name: string | null; phone: string | null };
  lastMessage: { direction: string | null; body: string | null; createdAt: string | null } | null;
  unreadCount: number | null; replyMode: string | null; freeformUntil: string | null;
  work: WorkLink | null;
}
export interface Conversation extends ConversationRow { status: string | null; lastInboundAt: string | null; handoffAt: string | null }
export type LinkedMediaKind = "image" | "video" | "audio" | "document";
export type LinkedMediaUnavailableReason = "too_large" | "unsupported_type" | "missing_locator";
export interface LinkedMediaInfo {
  kind: LinkedMediaKind;
  mimeType: string;
  fileName: string | null;
  byteLength: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  ptt: boolean;
  caption: string | null;
  available: boolean;
  unavailableReason: LinkedMediaUnavailableReason | null;
}
export interface Message {
  id: string;
  direction: string | null;
  body: string | null;
  status: string | null;
  senderType: string | null;
  createdAt: string | null;
  type: string | null;
  previewJpeg: string | null;
  media: LinkedMediaInfo | null;
}
export interface Page<T> { rows: T[]; cursor: string | null }
/** The host's reply states; anything else reads as uncertain. */
export type ReplyState = "sent" | "accepted" | "pending" | "failed" | "refused" | "uncertain";
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
    connected: d.connected,
    state: str(d.state),
    paused: typeof d.paused === "boolean" ? d.paused : null,
    displayPhoneNumber: str(d.displayPhoneNumber), verifiedName: str(d.verifiedName), wabaId: str(d.wabaId), phoneNumberId: str(d.phoneNumberId),
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
  const work = validWorkRef(v.workRef) && typeof v.inboundVersion === "number" && Number.isSafeInteger(v.inboundVersion) && v.inboundVersion >= 0
    ? { ref: v.workRef, inboundVersion: v.inboundVersion } : null;
  return {
    conversationId: v.conversationId as string, contact: { name: str(c.name), phone: str(c.phone) },
    lastMessage: m && { direction: str(m.direction), body: str(m.body), createdAt: str(m.createdAt) },
    unreadCount: num(v.unreadCount), replyMode: str(v.replyMode), freeformUntil: str(v.freeformUntil), work,
  };
}
export function parseConversations(v: unknown): Page<ConversationRow> & { inboxScope: string | null } {
  const d = door(v);
  if (!Array.isArray(d.conversations)) bad();
  const rows = d.conversations.map(row);
  const candidate = d.inboxScope;
  const inboxScope = validInboxScope(candidate) && rows.every(r => r.work && validWorkRef(r.work.ref, candidate)) ? candidate : null;
  return { rows, cursor: str(d.cursor), inboxScope };
}
export function parseConversation(v: unknown): Conversation {
  const d = door(v);
  return { ...row({ ...d, lastMessage: null }), status: str(d.status), lastInboundAt: str(d.lastInboundAt), handoffAt: str(d.handoffAt) };
}
function previewJpeg(value: unknown): string | null {
  // Do not accept a provider URL or a MIME type from a message payload.
  return typeof value === "string" && value.length <= 21_848 && value.length % 4 === 0 &&
    value.startsWith("/9j/") && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}
function noControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}
function mediaFileName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || !noControl(value)) return null;
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) return null;
  return value;
}
function boundedInt(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}
export function parseMediaInfo(value: unknown): LinkedMediaInfo | null {
  if (!obj(value)) return null;
  const kind = value.kind;
  if (kind !== "image" && kind !== "video" && kind !== "audio" && kind !== "document") return null;
  if (typeof value.mimeType !== "string" || value.mimeType.length === 0 || value.mimeType.length > 200 || !noControl(value.mimeType)) return null;
  if (typeof value.ptt !== "boolean" || typeof value.available !== "boolean") return null;
  if (value.fileName !== null && value.fileName !== undefined && mediaFileName(value.fileName) === null) return null;
  if (value.byteLength !== null && value.byteLength !== undefined && boundedInt(value.byteLength, 0, 2_000_000_000) === null) return null;
  if (value.width !== null && value.width !== undefined && boundedInt(value.width, 1, 65535) === null) return null;
  if (value.height !== null && value.height !== undefined && boundedInt(value.height, 1, 65535) === null) return null;
  if (value.durationSeconds !== null && value.durationSeconds !== undefined && boundedInt(value.durationSeconds, 0, 86400) === null) return null;
  if (value.caption !== null && value.caption !== undefined && (typeof value.caption !== "string" || value.caption.length > 8192)) return null;
  const reason = value.unavailableReason;
  if (value.available) {
    if (reason !== null && reason !== undefined) return null;
  } else if (reason !== "too_large" && reason !== "unsupported_type" && reason !== "missing_locator") {
    return null;
  }
  const caption = typeof value.caption === "string" && value.caption.trim() !== "" ? value.caption : null;
  return {
    kind,
    mimeType: value.mimeType,
    fileName: mediaFileName(value.fileName),
    byteLength: boundedInt(value.byteLength, 0, 2_000_000_000),
    width: boundedInt(value.width, 1, 65535),
    height: boundedInt(value.height, 1, 65535),
    durationSeconds: boundedInt(value.durationSeconds, 0, 86400),
    ptt: kind === "audio" && value.ptt,
    caption,
    available: value.available,
    unavailableReason: value.available ? null : (reason as LinkedMediaUnavailableReason),
  };
}
export function formatMediaBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb % 1 === 0 ? kb.toFixed(0) : kb.toFixed(1)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb % 1 === 0 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}
export function formatMediaDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
export function parseMessages(v: unknown): Page<Message> {
  const d = door(v);
  if (!Array.isArray(d.messages)) bad();
  return { rows: d.messages.map(m => {
    if (!obj(m) || !str(m.id)) bad();
    return { id: m.id as string, direction: str(m.direction), body: str(m.body), status: str(m.status), senderType: str(m.senderType), createdAt: str(m.createdAt), type: str(m.type), previewJpeg: previewJpeg(m.previewJpeg), media: parseMediaInfo(m.media) };
  }), cursor: str(d.cursor) };
}
export function parsePrepared(v: unknown): Prepared {
  if (!obj(v) || typeof v.effect_id !== "string" || !/^wae_[0-9a-f]{32}$/.test(v.effect_id)) bad();
  return { effect_id: v.effect_id, decision: str(v.decision), expires_at: str(v.expires_at) };
}
/** A send answer. Fails closed: only an explicit known state is taken. */
export function sendState(v: unknown): ReplyState {
  const s = obj(v) && obj(v.reply) ? v.reply.state : null;
  return s === "sent" || s === "accepted" || s === "pending" || s === "failed" || s === "refused" ? s : "uncertain";
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
  facts_changed: "The takeover changed since this card opened. Check the conversation before trying again.",
  window_closed: "The 24-hour reply window is closed. Send an approved template instead.",
  stale_approval: "This approval expired before it was sent. Review and confirm again.",
  owner_required: "Only a workspace owner can perform this WhatsApp action.",
  connector_paused: "Official WhatsApp is paused for this workspace. Resume it before sending.",
  unsupported_for_provider: "This operation is not supported for the selected WhatsApp mode.",
  session_stopped: "The linked WhatsApp session is stopped. Start it in Settings or via CLI.",
  reauthorization_required: "The linked WhatsApp session needs re-pairing in workspace account settings.",
  already_connected: "This WhatsApp connection is already active.",
  not_connected: "WhatsApp is not connected for this workspace.",
  attachment_too_large: "This attachment exceeds the WhatsApp media size limit.",
  unsupported_attachment: "This attachment type is not supported for WhatsApp.",
  rate_limited: "Too many WhatsApp requests right now. Try again in a moment.",
  favcrm_unavailable: "FavCRM is not answering right now. Try again in a moment.",
  favcrm_not_bound: "This workspace is not connected to FavCRM. Connect it, then try again.",
  not_granted: "Linked-device access is not enabled. Ask a platform administrator to grant access.",
  conversation_not_found: "FavCRM could not find this conversation. Refresh the Inbox.",
  expired_on_provider: "WhatsApp no longer retains this media.",
  device_offline: "Linked WhatsApp device is offline. Reconnect in Settings and try again.",
  too_large: "This attachment exceeds the 10 MB display/download limit.",
  unsupported_type: "This media format is not supported.",
  missing_locator: "Media metadata is unavailable for this message.",
  busy: "Too many downloads are in progress. Try again in a moment.",
  media_unavailable: "This media attachment is unavailable.",
  download_failed: "Couldn't download this attachment. Try again.",
  timeout: "Media download timed out. Try again.",
};
export function errorText(error: unknown, fallback: string): string {
  const code = error instanceof ApiError ? (error as ApiError & { code?: unknown }).code : undefined;
  if (typeof code === "string" && Object.hasOwn(REFUSALS, code)) return REFUSALS[code];
  if (error instanceof ApiError && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
