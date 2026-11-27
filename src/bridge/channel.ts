import { ApiError } from "@cadence/screen-ui";
import { acceptComposeState,acceptPush,clearScope } from "./scope";

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> | undefined; kind: "call" | "slot" };
export type DownloadedWhatsAppMedia = { bytes: ArrayBuffer; mimeType: string; fileName: string | null; sha256: string };
export type SavedWhatsAppMedia = { saved: true; mimeType: string; fileName: string; sha256: string };
type MediaPending =
  | { kind: "inline"; resolve: (v: DownloadedWhatsAppMedia) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }
  | { kind: "download"; resolve: (v: SavedWhatsAppMedia) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };
const LINKED_MEDIA_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const LINKED_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_MEDIA_MIMES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/3gpp",
  "video/quicktime",
  "audio/mpeg",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/webm",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
function printableBounded(value: unknown, maxLen: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function exact(v: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(v).every(k => keys.includes(k)); }
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const invalid = () => new ApiError("The WhatsApp bridge refused an invalid or retired response", 502);
/** A request that never answered may have executed; callers read status, never retry. */
export const TIMEOUT_STATUS = 504;
// Refusal codes, not text heuristics, select the UI path.
function refusal(v: unknown): ApiError {
  if (!object(v) || !exact(v, ["code", "text"]) || typeof v.code !== "string" || typeof v.text !== "string" || v.text.length > 2000) throw invalid();
  const status = ({
    not_found: 404,
    missing: 404,
    stale_revision: 409,
    conflict: 409,
    window_closed: 409,
    stale_approval: 409,
    owner_required: 409,
    facts_changed: 409,
    connector_paused: 409,
    rate_limited: 429,
    unauthorized: 401,
    forbidden: 403,
    unavailable: 503,
  } as Record<string, number>)[v.code] ?? 400;
  return new ApiError(v.text, status, { code: v.code });
}
type ReplyAvailability = "checking" | "blocked" | "verified";
type ReplyInset = { nomination: number; seq: number; px: number };
export type WhatsAppUxMediaKind = "image" | "video" | "audio" | "document";
export type WhatsAppOutboundEcho = {
  phase: "pending" | "sent" | "failed" | "cancelled";
  tempId: string;
  conversationId: string;
  provider: "linked" | "official";
  text: string;
  mediaKind: WhatsAppUxMediaKind | null;
  fileName: string | null;
  createdAt: string;
};
const EMPTY_DRAFTS: Record<string, string> = {};
const UX_MEDIA_KINDS = new Set<string>(["image", "video", "audio", "document"]);
const ECHO_PHASES = new Set<string>(["pending", "sent", "failed", "cancelled"]);
class Channel {
  private port: MessagePort | null = null;
  private retired = false;
  private serial = 0;
  private composeSupported = false;
  private replyAvailabilitySupported = false;
  private replyLayoutSupported = false;
  private replyOverlaySupported = false;
  private mediaDownloadSupported = false;
  private pdfPreviewSupported = false;
  private uxSupported = false;
  private drafts: Record<string, string> = EMPTY_DRAFTS;
  private draftListeners = new Set<() => void>();
  private pendingOpenThread: string | null = null;
  private openThreadListeners = new Set<(conversationId: string) => void>();
  private outboundEchoListeners = new Set<(echo: WhatsAppOutboundEcho) => void>();
  private replyInset: ReplyInset | null = null;
  private acknowledgedInset: ReplyInset | null = null;
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
  insetFor(id: string | null): ReplyInset | null {
    return this.replyOverlaySupported && !this.retired && id !== null && id === this.conversationId ? this.replyInset : null;
  }
  acknowledgeReplyInset(inset: ReplyInset | null): void {
    if (!inset || !this.replyOverlaySupported || this.retired || !this.port ||
        this.conversationId === null || inset !== this.replyInset || inset.nomination !== this.nomination ||
        inset === this.acknowledgedInset) return;
    this.acknowledgedInset = inset;
    this.port.postMessage({ v: 2, op: "whatsapp-reply-inset-ready", nomination: inset.nomination, seq: inset.seq, px: inset.px });
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
    this.replyInset = null;
    this.acknowledgedInset = null;
    this.replyAvailability = "checking";
    this.port.postMessage({ v: 2, op: "whatsapp-compose", conversation_id: conversationId });
    this.announceReplyAvailability();
  }
  private pending = new Map<string, Pending>();
  private mediaPending = new Map<string, MediaPending>();
  get hostUx(): boolean { return this.uxSupported && !this.retired; }
  getDrafts = (): Record<string, string> => (this.retired ? EMPTY_DRAFTS : this.drafts);
  subscribeDrafts = (listener: () => void): (() => void) => {
    this.draftListeners.add(listener);
    return () => { this.draftListeners.delete(listener); };
  };
  subscribeOpenThread = (listener: (conversationId: string) => void): (() => void) => {
    this.openThreadListeners.add(listener);
    if (this.pendingOpenThread !== null && !this.retired) {
      const target = this.pendingOpenThread;
      this.pendingOpenThread = null;
      listener(target);
    }
    return () => { this.openThreadListeners.delete(listener); };
  };
  subscribeOutboundEcho = (listener: (echo: WhatsAppOutboundEcho) => void): (() => void) => {
    this.outboundEchoListeners.add(listener);
    return () => { this.outboundEchoListeners.delete(listener); };
  };
  setThreadUnread(conversationId: string, provider: "linked" | "official", unread: boolean): void {
    if (!this.port || this.retired || !this.uxSupported || !printableBounded(conversationId, 256)) return;
    this.port.postMessage({
      v: 2,
      op: "whatsapp-thread-unread",
      conversation_id: conversationId,
      provider,
      unread,
    });
  }
  get hostMediaDownload(): boolean { return this.mediaDownloadSupported && !this.retired; }
  get hostPdfPreview(): boolean { return this.pdfPreviewSupported && !this.retired; }
  previewPdf(conversationId: string, messageId: string, provider?: "linked" | "official"): void {
    if (!this.port || this.retired || !this.pdfPreviewSupported) return;
    if (!printableBounded(conversationId, 256) || !printableBounded(messageId, 256)) return;
    this.port.postMessage({
      v: 2,
      op: "whatsapp-pdf-preview",
      conversation_id: conversationId,
      message_id: messageId,
      ...(provider === "official" ? { provider: "official" } : {}),
    });
  }
  downloadMedia(conversationId: string, messageId: string, provider?: "linked" | "official"): Promise<DownloadedWhatsAppMedia> {
    return this.requestMedia("inline", conversationId, messageId, provider);
  }
  saveMedia(conversationId: string, messageId: string, provider?: "linked" | "official"): Promise<SavedWhatsAppMedia> {
    return this.requestMedia("download", conversationId, messageId, provider);
  }
  private requestMedia(kind: "inline", conversationId: string, messageId: string, provider?: "linked" | "official"): Promise<DownloadedWhatsAppMedia>;
  private requestMedia(kind: "download", conversationId: string, messageId: string, provider?: "linked" | "official"): Promise<SavedWhatsAppMedia>;
  private requestMedia(kind: "inline" | "download", conversationId: string, messageId: string, provider?: "linked" | "official"): Promise<DownloadedWhatsAppMedia | SavedWhatsAppMedia> {
    if (!this.port || this.retired || !this.mediaDownloadSupported) {
      return Promise.reject(new ApiError("Media download bridge is unavailable.", 503, { code: "unavailable" }));
    }
    if (!printableBounded(conversationId, 256) || !printableBounded(messageId, 256)) {
      return Promise.reject(new ApiError("Invalid WhatsApp media identifier.", 400, { code: "invalid_request" }));
    }
    if (this.mediaPending.size >= 4) {
      return Promise.reject(new ApiError("Too many downloads in progress.", 429, { code: "busy" }));
    }
    const id = `waba-${++this.serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.mediaPending.delete(id);
        reject(new ApiError("Media download timed out.", TIMEOUT_STATUS, { code: "timeout" }));
      }, 60000);
      if (kind === "inline") {
        this.mediaPending.set(id, { kind: "inline", resolve: resolve as (v: DownloadedWhatsAppMedia) => void, reject, timer });
      } else {
        this.mediaPending.set(id, { kind: "download", resolve: resolve as (v: SavedWhatsAppMedia) => void, reject, timer });
      }
      this.port!.postMessage({
        v: 2,
        op: "whatsapp-media",
        id,
        conversation_id: conversationId,
        message_id: messageId,
        disposition: kind,
        ...(provider === "official" ? { provider: "official" } : {}),
      });
    });
  }
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
    this.replyOverlaySupported = this.replyLayoutSupported && new URLSearchParams(window.location.search).get("wa_compose_inset_ack") === "1";
    this.mediaDownloadSupported = new URLSearchParams(window.location.search).get("wa_media_download") === "1";
    this.pdfPreviewSupported = new URLSearchParams(window.location.search).get("wa_pdf_preview") === "1";
    this.uxSupported = new URLSearchParams(window.location.search).get("wa_ux") === "1";
    const accepts = [
      "screen.v2",
      "screen-records.v1",
      "screen-locale.v1",
      ...(this.composeSupported ? ["screen-whatsapp-compose.v1"] : []),
      ...(this.replyAvailabilitySupported ? ["screen-whatsapp-reply-availability.v1"] : []),
      ...(this.replyLayoutSupported ? [this.replyOverlaySupported ? "screen-whatsapp-reply-layout.v2" : "screen-whatsapp-reply-layout.v1"] : []),
      ...(this.mediaDownloadSupported ? ["screen-whatsapp-media.v1"] : []),
      ...(this.pdfPreviewSupported ? ["screen-whatsapp-pdf-preview.v1"] : []),
      ...(this.uxSupported ? ["screen-whatsapp-ux.v1"] : []),
    ];
    // Stay within the legacy 8-token accepts cap on older hosts while always enabling route params on read-only Canvas or CAD-2883+ hosts.
    if (this.pdfPreviewSupported || accepts.length < 8) {
      accepts.splice(3, 0, "screen-route-params.v1");
    }
    pair.port1.postMessage({ v: 1, op: "ready", accepts });
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
    if (data.op === "whatsapp-reply-inset") {
      if (!this.replyOverlaySupported || !exact(data, ["v", "op", "nomination", "seq", "px"]) ||
          typeof data.nomination !== "number" || !Number.isSafeInteger(data.nomination) || data.nomination < 1 ||
          typeof data.seq !== "number" || !Number.isSafeInteger(data.seq) || data.seq < 1 ||
          typeof data.px !== "number" || !Number.isInteger(data.px) || data.px < 0 || data.px > 512) throw invalid();
      if (this.conversationId !== null && data.nomination === this.nomination && data.seq > (this.replyInset?.seq ?? 0)) {
        this.replyInset = { nomination: data.nomination, seq: data.seq, px: data.px };
        this.announceReplyAvailability();
      }
      return;
    }
    if (data.op === "whatsapp-media-reply") {
      if (!this.mediaDownloadSupported || typeof data.id !== "string") throw invalid();
      const m = this.mediaPending.get(data.id);
      if (!m) throw invalid();
      if (data.ok === false) {
        if (!exact(data, ["v", "op", "id", "ok", "refusal"])) throw invalid();
        const err = refusal(data.refusal);
        clearTimeout(m.timer);
        this.mediaPending.delete(data.id);
        m.reject(err);
        if (err.code === "unauthorized" || err.code === "forbidden") this.retire(err);
        return;
      }
      if (data.ok !== true) throw invalid();
      if (m.kind === "download") {
        if (
          !exact(data, ["v", "op", "id", "ok", "saved", "mime_type", "file_name", "sha256"]) ||
          data.saved !== true ||
          typeof data.mime_type !== "string" || !SAFE_MEDIA_MIMES.has(data.mime_type) ||
          !printableBounded(data.file_name, 200) ||
          typeof data.sha256 !== "string" || !SHA256_RE.test(data.sha256)
        ) throw invalid();
        clearTimeout(m.timer);
        this.mediaPending.delete(data.id);
        m.resolve({ saved: true, mimeType: data.mime_type, fileName: data.file_name, sha256: data.sha256 });
        return;
      }
      if (
        !exact(data, ["v", "op", "id", "ok", "bytes", "mime_type", "file_name", "sha256"]) ||
        !(data.bytes instanceof ArrayBuffer) ||
        typeof data.mime_type !== "string" || !SAFE_MEDIA_MIMES.has(data.mime_type) ||
        (data.file_name !== null && !printableBounded(data.file_name, 200)) ||
        typeof data.sha256 !== "string" || !SHA256_RE.test(data.sha256)
      ) throw invalid();
      const limit = data.mime_type.startsWith("image/") ? LINKED_MEDIA_MAX_IMAGE_BYTES : LINKED_MEDIA_MAX_BYTES;
      if (data.bytes.byteLength < 1 || data.bytes.byteLength > limit) throw invalid();
      clearTimeout(m.timer);
      this.mediaPending.delete(data.id);
      m.resolve({ bytes: data.bytes, mimeType: data.mime_type, fileName: data.file_name, sha256: data.sha256 });
      return;
    }
    if (data.op === "whatsapp-open-thread") {
      if (!this.uxSupported || !exact(data, ["v", "op", "conversation_id"]) || !printableBounded(data.conversation_id, 256)) {
        throw invalid();
      }
      const conversationId = data.conversation_id;
      if (this.openThreadListeners.size === 0) {
        this.pendingOpenThread = conversationId;
      } else {
        this.openThreadListeners.forEach(listener => listener(conversationId));
      }
      return;
    }
    if (data.op === "whatsapp-drafts") {
      if (!this.uxSupported || !exact(data, ["v", "op", "drafts"]) || !object(data.drafts)) {
        throw invalid();
      }
      const entries = Object.entries(data.drafts);
      if (entries.length > 50) throw invalid();
      const next: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (!printableBounded(k, 256) || typeof v !== "string" || v.length > 200) throw invalid();
        next[k] = v;
      }
      const keys = Object.keys(next);
      const prevKeys = Object.keys(this.drafts);
      const same = keys.length === prevKeys.length && keys.every(k => this.drafts[k] === next[k]);
      if (!same) {
        this.drafts = keys.length === 0 ? EMPTY_DRAFTS : next;
        this.draftListeners.forEach(listener => listener());
      }
      return;
    }
    if (data.op === "whatsapp-outbound-echo") {
      if (
        !this.uxSupported ||
        !exact(data, ["v", "op", "phase", "temp_id", "conversation_id", "provider", "text", "media_kind", "file_name", "created_at"]) ||
        typeof data.phase !== "string" || !ECHO_PHASES.has(data.phase) ||
        !printableBounded(data.temp_id, 128) ||
        !printableBounded(data.conversation_id, 256) ||
        (data.provider !== "linked" && data.provider !== "official") ||
        typeof data.text !== "string" || data.text.length > 4096 ||
        (data.media_kind !== null && (typeof data.media_kind !== "string" || !UX_MEDIA_KINDS.has(data.media_kind))) ||
        (data.file_name !== null && !printableBounded(data.file_name, 256)) ||
        !printableBounded(data.created_at, 64)
      ) {
        throw invalid();
      }
      const echo: WhatsAppOutboundEcho = {
        phase: data.phase as WhatsAppOutboundEcho["phase"],
        tempId: data.temp_id,
        conversationId: data.conversation_id,
        provider: data.provider,
        text: data.text,
        mediaKind: data.media_kind as WhatsAppUxMediaKind | null,
        fileName: data.file_name,
        createdAt: data.created_at,
      };
      this.outboundEchoListeners.forEach(listener => listener(echo));
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
    this.replyInset = null;
    this.acknowledgedInset = null;
    this.drafts = EMPTY_DRAFTS;
    this.pendingOpenThread = null;
    this.port?.close(); this.port = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const m of this.mediaPending.values()) { clearTimeout(m.timer); m.reject(error); }
    this.mediaPending.clear();
    clearScope(error.message);
    this.announceReplyAvailability();
    this.draftListeners.forEach(listener => listener());
  }
}
export const channel = new Channel();
