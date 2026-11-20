import { ApiError } from "@cadence/screen-ui";
import { acceptComposeState,acceptPush,clearScope } from "./scope";

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> | undefined; kind: "call" | "slot" };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function exact(v: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(v).every(k => keys.includes(k)); }
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const invalid = () => new ApiError("The WhatsApp bridge refused an invalid or retired response", 502);
/** A request that never answered may have executed; callers read status, never retry. */
export const TIMEOUT_STATUS = 504;
// Refusal codes, not text heuristics, select the UI path.
function refusal(v: unknown): ApiError {
  if (!object(v) || !exact(v, ["code", "text"]) || typeof v.code !== "string" || typeof v.text !== "string" || v.text.length > 2000) throw invalid();
  const status = ({ not_found: 404, missing: 404, stale_revision: 409, conflict: 409, unauthorized: 401, forbidden: 403, unavailable: 503 } as Record<string, number>)[v.code] ?? 400;
  return new ApiError(v.text, status, { code: v.code });
}
type ReplyAvailability = "checking" | "blocked" | "verified";
class Channel {
  private port: MessagePort | null = null;
  private retired = false;
  private serial = 0;
  private composeSupported = false;
  private replyAvailabilitySupported = false;
  private replyLayoutSupported = false;
  private lastLayout: string | null = null;
  private nomination = 0;
  private conversationId: string | null = null;
  private replyAvailability: ReplyAvailability = "checking";
  private replyListeners = new Set<() => void>();
  subscribeReplyAvailability = (listener: () => void): (() => void) => {
    this.replyListeners.add(listener);
    return () => { this.replyListeners.delete(listener); };
  };
  availabilityFor(id: string | null): ReplyAvailability | null {
    if (!this.replyAvailabilitySupported || this.retired || id === null) return null;
    return id === this.conversationId ? this.replyAvailability : "checking";
  }
  private announceReplyAvailability(): void {
    this.replyListeners.forEach(listener => listener());
  }
  get hostCompose(): boolean { return this.composeSupported; }
  get hostReplyLayout(): boolean { return this.replyLayoutSupported && !this.retired; }
  publishReplyLayout(bounds: [number, number] | null): void {
    if (!this.hostReplyLayout || !this.port || this.conversationId === null) return;
    const key = bounds === null ? "hidden" : `${bounds[0]}:${bounds[1]}`;
    if (key === this.lastLayout) return;
    this.lastLayout = key;
    this.port.postMessage({ v: 2, op: "whatsapp-reply-layout", nomination: this.nomination, bounds });
  }
  nominateConversation(conversationId: string | null): void {
    if (!this.composeSupported || !this.port || this.retired || this.conversationId === conversationId) return;
    this.conversationId = conversationId;
    this.nomination++;
    this.lastLayout = null;
    this.replyAvailability = "checking";
    this.port.postMessage({ v: 2, op: "whatsapp-compose", conversation_id: conversationId });
    this.announceReplyAvailability();
  }
  private pending = new Map<string, Pending>();
  start(): void {
    if (this.port || this.retired) return;
    const node = document.getElementById("cadence-screen-boot");
    if (!node?.textContent || node.textContent.length > 2048) throw invalid();
    const boot: unknown = JSON.parse(node.textContent);
    if (!object(boot) || !exact(boot, ["tag", "bridge_nonce", "generation", "parent_origin"]) || boot.tag !== "waba" || typeof boot.bridge_nonce !== "string" || !/^[a-f0-9]{64}$/.test(boot.bridge_nonce) || !Number.isSafeInteger(boot.generation) || (boot.generation as number) < 0 || typeof boot.parent_origin !== "string") throw invalid();
    const origin = new URL(boot.parent_origin);
    if (origin.origin !== boot.parent_origin || !["http:", "https:"].includes(origin.protocol) || window.parent === window) throw invalid();
    const pair = new MessageChannel();
    this.port = pair.port1;
    pair.port1.onmessage = e => {
      try { this.receive(e.data); } catch { this.retire(invalid()); }
    };
    pair.port1.onmessageerror = () => this.retire(invalid());
    pair.port1.start();
    window.parent.postMessage({ v: 1, op: "init", tag: boot.tag, bridge_nonce: boot.bridge_nonce, generation: boot.generation }, boot.parent_origin, [pair.port2]);
    this.composeSupported = window.location.hash === "#cadence-whatsapp-compose-v1";
    this.replyAvailabilitySupported = this.composeSupported && new URLSearchParams(window.location.search).get("wa_compose_availability") === "1";
    this.replyLayoutSupported = this.replyAvailabilitySupported && new URLSearchParams(window.location.search).get("wa_compose_layout") === "1";
    pair.port1.postMessage({ v: 1, op: "ready", accepts: ["screen.v2", "screen-records.v1", "screen-locale.v1",
      ...(this.composeSupported ? ["screen-whatsapp-compose.v1"] : []),
      ...(this.replyAvailabilitySupported ? ["screen-whatsapp-reply-availability.v1"] : []),
      ...(this.replyLayoutSupported ? ["screen-whatsapp-reply-layout.v1"] : [])] });
    window.addEventListener("pagehide", () => this.retire(new ApiError("WhatsApp mount retired", 403)), { once: true });
  }
  request(kind: "call" | "slot", verb: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.port || this.retired) return Promise.reject(new ApiError("WhatsApp bridge is unavailable", 503));
    if (this.pending.size >= 8) return Promise.reject(new ApiError("WhatsApp bridge is busy; wait for the current request", 429));
    const id = `waba-${++this.serial}`;
    return new Promise((resolve, reject) => {
      // No automatic retries: a timed-out send may have executed. A slot waits
      // for a person's tap, so only the host's own card expiry ends it; a timer
      // here would drop the effect id before a late tap is answered.
      const timer = kind === "slot" ? undefined : setTimeout(() => this.retire(new ApiError("WhatsApp request did not answer. Read its status before doing anything else.", TIMEOUT_STATUS)), 65000);
      this.pending.set(id, { resolve, reject, timer, kind });
      this.port!.postMessage({ v: 2, op: kind, id, verb, args, ...(kind === "slot" ? { anchor: "footer" } : {}) });
    });
  }
  private receive(data: unknown): void {
    if (this.retired || !object(data) || data.v !== 2) throw invalid();
    if (data.op === "screen") {
      if (bytes(data) > 131072) throw invalid();
      acceptPush(data);
      return;
    }
    if (data.op === "whatsapp-compose-state") {
      if (!this.composeSupported || !exact(data, ["v", "op", "dirty", "refresh"]) || typeof data.dirty !== "boolean" || typeof data.refresh !== "boolean") throw invalid();
      acceptComposeState(data.dirty, data.refresh);
      return;
    }
    if (data.op === "whatsapp-reply-availability") {
      if (!this.replyAvailabilitySupported || !exact(data, ["v", "op", "nomination", "state"]) ||
          typeof data.nomination !== "number" || !Number.isSafeInteger(data.nomination) || data.nomination < 1 ||
          (data.state !== "checking" && data.state !== "blocked" && data.state !== "verified")) throw invalid();
      if (this.conversationId !== null && data.nomination === this.nomination && data.state !== this.replyAvailability) {
        this.replyAvailability = data.state;
        this.announceReplyAvailability();
      }
      return;
    }
    if (data.op !== "reply" && data.op !== "slot-state") throw invalid();
    if (bytes(data) > 1049600 || typeof data.id !== "string") throw invalid();
    const p = this.pending.get(data.id);
    if (!p || (data.op === "reply" ? p.kind !== "call" : p.kind !== "slot")) throw invalid();
    if (data.op === "reply") {
      if (data.ok === true && exact(data, ["v", "op", "id", "ok", "data"]) && "data" in data) {
        if (bytes(data.data) > 1048576) throw invalid();
        this.finish(data.id, data.data);
      }
      else if (data.ok === false && exact(data, ["v", "op", "id", "ok", "refusal"])) this.fail(data.id, refusal(data.refusal));
      else throw invalid();
    } else {
      if (!exact(data, ["v", "op", "id", "state", "refusal", "data"])) throw invalid();
      if (data.state === "pending" && data.data === undefined && data.refusal === undefined) return;
      if (data.state === "done" && data.refusal === undefined) {
        if ("data" in data && bytes(data.data) > 1048576) throw invalid();
        if (object(data.data) && ["confirmation_nonce", "confirmation_token", "confirm_token", "action_token"].some(k => k in (data.data as Record<string, unknown>))) throw invalid();
        this.finish(data.id, data.data);
      } else if (data.state === "refused" && data.data === undefined) this.fail(data.id, refusal(data.refusal));
      else throw invalid();
    }
  }
  private finish(id: string, value: unknown): void {
    const p = this.pending.get(id)!; clearTimeout(p.timer); this.pending.delete(id); p.resolve(value);
  }
  private fail(id: string, error: ApiError): void {
    const p = this.pending.get(id)!; clearTimeout(p.timer); this.pending.delete(id);
    if ([401, 403].includes(error.status)) { p.reject(error); this.retire(error); }
    else p.reject(error);
  }
  retire(error: ApiError): void {
    if (this.retired) return;
    this.retired = true;
    this.port?.close(); this.port = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); clearScope(error.message);
    this.announceReplyAvailability();
  }
}
export const channel = new Channel();
