import { ApiError } from "@cadence/screen-ui";
/** Door v2 answers (`agenticos.whatsapp-door.v2`, AOS-288, CAD-1590) as the
 *  host relays them. Reads are display data only: every authority check,
 *  digest and recheck stays host-side. */
export const CONTRACT_V2 = "agenticos.whatsapp-door.v2";
type Bag = Record<string, unknown>;
const obj = (v: unknown): v is Bag => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => typeof v === "string" && v !== "" ? v : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
function bad(): never { throw new ApiError("The WhatsApp door answered an unexpected shape", 502); }
function door(v: unknown): Bag { if (!obj(v) || v.contract !== CONTRACT_V2) bad(); return v; }
const counts = (v: unknown): Record<string, number> => obj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number")) : {};

export interface Template {
  templateId: string; name: string; language: string; category: string | null; status: string; connectionId: string | null;
  revision: string | null; header: { format: string | null; text: string | null }; bodyText: string; footerText: string | null;
  variables: { index: number; sample: string | null }[]; sendable: boolean;
}
function template(v: unknown): Template {
  if (!obj(v) || !str(v.templateId) || !str(v.name) || typeof v.status !== "string") bad();
  const h = obj(v.header) ? v.header : {};
  return {
    templateId: v.templateId as string, name: v.name as string, language: str(v.language) ?? "", category: str(v.category), status: v.status, connectionId: str(v.connectionId),
    revision: str(v.revision), header: { format: str(h.format), text: str(h.text) }, bodyText: typeof v.bodyText === "string" ? v.bodyText : "", footerText: str(v.footerText),
    variables: Array.isArray(v.variables) ? v.variables.filter(obj).map(x => ({ index: num(x.index) ?? 0, sample: str(x.sample) })).filter(x => x.index > 0) : [],
    // Only an explicit true: the door says APPROVED, on the bound number, no header variable.
    sendable: v.sendable === true && v.status === "APPROVED",
  };
}
export function parseTemplates(v: unknown): Template[] {
  const d = door(v);
  if (!Array.isArray(d.templates)) bad();
  return d.templates.map(template);
}
export const parseTemplate = (v: unknown): Template => template(door(v));
/** `{{n}}` body indexes, ascending, exactly as the door detects them. */
export function bodyIndexes(body: string): number[] {
  return [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
}
/** The door's shared render: `{{n}}` → its value, unknown indexes left as written. */
export function render(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{(\d+)\}\}/g, (m, n: string) => values[n]?.trim() || m);
}
/** A template variable or body parameter: 1–1024 characters, no surrounding spaces (refused, never trimmed). */
export const valueOk = (v: string) => v.length > 0 && v.length <= 1024 && v.trim() === v;

export interface BroadcastRow { broadcastId: string; name: string; status: string; recipientCount: number | null; scheduledAt: string | null; sentAt: string | null; createdAt: string | null; deliveryStats: Record<string, number> }
export function parseBroadcasts(v: unknown): { rows: BroadcastRow[]; cursor: string | null } {
  const d = door(v);
  if (!Array.isArray(d.broadcasts)) bad();
  return { rows: d.broadcasts.map(b => {
    if (!obj(b) || !str(b.broadcastId) || typeof b.status !== "string") bad();
    return { broadcastId: b.broadcastId as string, name: typeof b.name === "string" ? b.name : "", status: b.status, recipientCount: num(b.recipientCount), scheduledAt: str(b.scheduledAt), sentAt: str(b.sentAt), createdAt: str(b.createdAt), deliveryStats: counts(b.deliveryStats) };
  }), cursor: str(d.cursor) };
}
export interface Broadcast {
  broadcastId: string; name: string; status: string; template: { templateId: string; name: string; language: string; revision: string | null } | null;
  bodyParameters: string[]; audience: { source: string | null; segmentId: string | null; accountIds: string[] };
  scheduledAt: string | null; sentAt: string | null; deliveryStats: Record<string, number>; errorMessage: string | null;
}
export function parseBroadcast(v: unknown): Broadcast {
  const d = door(v);
  if (!str(d.broadcastId) || typeof d.status !== "string") bad();
  const t = obj(d.template) && str(d.template.templateId) ? d.template : null, a = obj(d.audience) ? d.audience : {};
  return {
    broadcastId: d.broadcastId as string, name: typeof d.name === "string" ? d.name : "", status: d.status,
    template: t && { templateId: t.templateId as string, name: str(t.name) ?? "", language: str(t.language) ?? "", revision: str(t.revision) },
    bodyParameters: strs(d.bodyParameters), audience: { source: str(a.source), segmentId: str(a.segmentId), accountIds: strs(a.accountIds) },
    scheduledAt: str(d.scheduledAt), sentAt: str(d.sentAt), deliveryStats: counts(d.deliveryStats), errorMessage: str(d.errorMessage),
  };
}
export interface Estimate { valid: boolean; errors: string[]; counts: Record<string, number>; preview: string | null }
export function parseEstimate(v: unknown): Estimate {
  const d = door(v);
  if (typeof d.valid !== "boolean" || !obj(d.estimate)) bad();
  return { valid: d.valid, errors: strs(d.errors), counts: counts(d.estimate), preview: obj(d.preview) ? str(d.preview.renderedBody) : null };
}
/** Everything FavCRM leaves out of a send; display only, the host rechecks at send. */
export const excluded = (c: Record<string, number>) => ["manuallyExcluded", "missingAddress", "missingConsent", "optedOut"].reduce((n, k) => n + (c[k] ?? 0), 0);
export interface Result { contactName: string | null; phone: string | null; status: string; at: string | null; error: string | null }
export function parseResults(v: unknown): { rows: Result[]; total: number | null; cursor: string | null } {
  const d = door(v);
  if (!Array.isArray(d.recipients)) bad();
  return { rows: d.recipients.map(r => {
    if (!obj(r) || typeof r.status !== "string") bad();
    const e = obj(r.error) ? r.error : null;
    return { contactName: str(r.contactName), phone: str(r.phone), status: r.status, at: str(r.readAt) ?? str(r.deliveredAt) ?? str(r.failedAt) ?? str(r.sentAt), error: e ? [num(e.code), str(e.title)].filter(x => x !== null).join(" ") || null : null };
  }), total: num(d.total), cursor: str(d.cursor) };
}
export function parseDraft(v: unknown): string {
  const d = door(v);
  if (!str(d.broadcastId)) bad();
  return d.broadcastId as string;
}
export interface Stopped { status: string; alreadySent: number | null; cancelled: number | null }
export function parseStop(v: unknown): Stopped {
  const d = door(v);
  if (d.status !== "STOPPED" && d.status !== "DRAFT") bad();
  return { status: d.status, alreadySent: num(d.alreadySent), cancelled: num(d.cancelled) };
}

/** A host-minted effect (`wat_` template send, `wbt_` test, `wab_` broadcast). */
export interface Prepared { effect_id: string; decision: string | null; to: string | null }
export function parsePrepared(v: unknown, prefix: "wat_" | "wbt_" | "wab_"): Prepared {
  if (!obj(v) || typeof v.effect_id !== "string" || !new RegExp(`^${prefix}[0-9a-f]{32}$`).test(v.effect_id)) bad();
  return { effect_id: v.effect_id, decision: str(v.decision), to: str(v.to) };
}
/** A v2 send answer. `accepted` is FavCRM's acceptance of a schedule or a
 *  test enqueue, never a delivery. Fails closed: anything else is uncertain. */
export type SendState = "sent" | "accepted" | "pending" | "failed" | "refused" | "uncertain";
export function sendOutcome(v: unknown): { state: SendState; code: string | null } {
  const o = obj(v) && obj(v.outcome) ? v.outcome : null, s = o?.state;
  return { state: s === "sent" || s === "accepted" || s === "pending" || s === "failed" || s === "refused" ? s : "uncertain", code: o ? str(o.code) : null };
}
/** The AgenticOS cap of 5 test sends per broadcast per 24 h (Q7). */
export const testLimit = (code: string | null) => !!code && /\btest_limit\b/.test(code);
