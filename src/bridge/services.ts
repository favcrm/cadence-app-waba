import { ApiError } from "@cadence/screen-ui";
import { channel } from "./channel";
import { assertCurrentScope,requireOperation,type DisplayScope } from "./scope";

type Bag = Record<string, unknown>;
/** Host operation names and argument shapes pinned to the CAD-1562 host
 *  door (favcrm/cadence#1138) and its CAD-1590 v2 verbs (favcrm/cadence#1171).
 *  No key, digest, company or connection field exists: the host derives each
 *  of them. */
export interface CallArgs {
  "whatsapp.status": Bag;
  "whatsapp.connect_session": Bag;
  "whatsapp.conversations.list": { cursor?: string; limit?: number };
  "whatsapp.conversations.show": { conversation_id: string };
  "whatsapp.messages": { conversation_id: string; cursor?: string; limit?: number };
  "whatsapp.reply.prepare": { conversation_id: string; text: string; reply_to_message_id?: string };
  "whatsapp.reply.status": { effect_id: string };
  "whatsapp.templates.list": { status?: "approved" | "all" };
  "whatsapp.template.show": { template_id: string };
  "whatsapp.template.prepare": { conversation_id: string; template_id: string; variables: Record<string, string> };
  "whatsapp.template.status": { effect_id: string };
  "whatsapp.broadcasts.list": { cursor?: string; limit?: number };
  "whatsapp.broadcast.show": { broadcast_id: string };
  "whatsapp.broadcast.estimate": { broadcast_id: string };
  "whatsapp.broadcast.results": { broadcast_id: string; cursor?: string; limit?: number; status?: string };
  "whatsapp.broadcast.draft": { broadcast_id?: string; name: string; template_id: string; body_parameters: string[]; audience: Audience };
  "whatsapp.broadcast.test.prepare": { broadcast_id: string; to: string };
  "whatsapp.broadcast.prepare": { broadcast_id: string; send_at?: string };
  "screen.route.patch": { section?: Section; view?: "list" | "new"; record_id?: string | null; segment_id?: string | null; replace?: boolean };
}
export type Section = "connection" | "inbox" | "templates" | "broadcasts";
/** Q6: a segment or up to 1000 individual accounts; `all` and `csv` are not offered. */
export type Audience = { source: "segment"; segment_id: string } | { source: "individual"; account_ids: string[] };
export interface SlotArgs {
  "whatsapp.reply.send": { conversation_id: string; text: string; effect_id: string; reply_to_message_id?: string };
  "whatsapp.template.send": { effect_id: string; conversation_id: string; template_id: string; variables: Record<string, string> };
  "whatsapp.broadcast.test.send": { effect_id: string };
  "whatsapp.broadcast.send": { effect_id: string };
  "whatsapp.broadcast.stop": { broadcast_id: string };
}
// A closed field allowlist is checked again at runtime before serialization.
export const CALL_FIELDS: Record<keyof CallArgs, readonly string[]> = {
  "whatsapp.status": [], "whatsapp.connect_session": [],
  "whatsapp.conversations.list": ["cursor", "limit"], "whatsapp.conversations.show": ["conversation_id"],
  "whatsapp.messages": ["conversation_id", "cursor", "limit"],
  "whatsapp.reply.prepare": ["conversation_id", "text", "reply_to_message_id"], "whatsapp.reply.status": ["effect_id"],
  "whatsapp.templates.list": ["status"], "whatsapp.template.show": ["template_id"],
  "whatsapp.template.prepare": ["conversation_id", "template_id", "variables"], "whatsapp.template.status": ["effect_id"],
  "whatsapp.broadcasts.list": ["cursor", "limit"], "whatsapp.broadcast.show": ["broadcast_id"], "whatsapp.broadcast.estimate": ["broadcast_id"],
  "whatsapp.broadcast.results": ["broadcast_id", "cursor", "limit", "status"],
  "whatsapp.broadcast.draft": ["broadcast_id", "name", "template_id", "body_parameters", "audience"],
  "whatsapp.broadcast.test.prepare": ["broadcast_id", "to"], "whatsapp.broadcast.prepare": ["broadcast_id", "send_at"],
  "screen.route.patch": ["section", "view", "record_id", "segment_id", "replace"],
};
export const SLOT_FIELDS: Record<keyof SlotArgs, readonly string[]> = {
  "whatsapp.reply.send": ["conversation_id", "text", "effect_id", "reply_to_message_id"],
  "whatsapp.template.send": ["effect_id", "conversation_id", "template_id", "variables"],
  "whatsapp.broadcast.test.send": ["effect_id"], "whatsapp.broadcast.send": ["effect_id"], "whatsapp.broadcast.stop": ["broadcast_id"],
};
export const OPERATIONS = [...Object.keys(CALL_FIELDS), ...Object.keys(SLOT_FIELDS)];
export function cleanArgs(verb: string, args: Bag, slot: boolean): Bag {
  const fields = (slot ? SLOT_FIELDS : CALL_FIELDS)[verb as never] as readonly string[] | undefined;
  if (!fields || !args || typeof args !== "object" || Array.isArray(args)) throw new ApiError("Unlisted WhatsApp operation", 400);
  for (const key of Object.keys(args)) if (!fields.includes(key)) throw new ApiError(`Refused WhatsApp field: ${key}`, 400);
  const value = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  // The host's per-operation budgets (`recordArgsLimit`).
  const cap = verb === "whatsapp.broadcast.draft" ? 196608 : ["whatsapp.reply.prepare", "whatsapp.reply.send", "whatsapp.template.prepare", "whatsapp.template.send"].includes(verb) ? 49152 : 16384;
  if (new TextEncoder().encode(JSON.stringify(value)).length > cap) throw new ApiError("WhatsApp request exceeds its operation budget", 413);
  return value;
}
export async function serviceCall<T = unknown, K extends keyof CallArgs = keyof CallArgs>(scope: DisplayScope, verb: K, args: CallArgs[K]): Promise<T> {
  assertCurrentScope(scope); requireOperation(verb);
  return await channel.request("call", verb, cleanArgs(verb, args as Bag, false)) as T;
}
export async function serviceSlot<T = unknown, K extends keyof SlotArgs = keyof SlotArgs>(scope: DisplayScope, verb: K, args: SlotArgs[K]): Promise<T> {
  assertCurrentScope(scope); requireOperation(verb);
  return await channel.request("slot", verb, cleanArgs(verb, args as Bag, true)) as T;
}
