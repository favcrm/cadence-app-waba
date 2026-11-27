import { ApiError,Button,EmptyState,ErrorNotice,Field,Loading,Notice } from "@cadence/screen-ui";
import { Fragment,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode,type RefObject } from "react";
import { channel, type WhatsAppOutboundEcho } from "../../bridge/channel";
import { patchRoute } from "../../bridge/route";
import { routable,useOnPush,useScope,type DisplayScope } from "../../bridge/scope";
import { serviceCall,serviceSlot } from "../../bridge/services";
import ContactDrawer,{ threadStateLabel } from "./ContactDrawer";
import { dueLabel,effectiveThreadState,listThreadWork,saveThreadWork,validWorkRef,type ThreadState,type ThreadWork } from "./inboxWork";
import { useWorkBrowse } from "./useWorkBrowse";
import { useLivePoll } from "./useLivePoll";
import type { Recipient } from "./Templates";
import { declinedReason,errorText,formatConversationPreviewText,formatMediaBytes,formatMediaDuration,isPdfMedia,mediaAspectRatio,mediaBadge,mediaExtTone,mediaKindLabel,mediaMetaSummary,parseConversation,parseConversations,parseDraft,parseMessages,parsePrepared,parseReplyStatus,sendState,when,windowOpen,type Conversation,type ConversationRow,type Draft,type LinkedMediaInfo,type Message,type ReplyState,type ReplyStatus } from "./door";

const PAGE = 25;
/** What the copilot may show, derived from the host-granted actions (members get the draft read-only). */
export interface Assist { show: boolean; brief: boolean; open: boolean; discard: boolean }
/** Takeover actions the host granted; the banner itself is shown to everyone. */
export interface Handoff { set: boolean; release: boolean }
const LIVE_POLL_MS = 5000;
type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "failed"; text: string };

function sameMedia(a: LinkedMediaInfo | null, b: LinkedMediaInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.mimeType === b.mimeType &&
    a.fileName === b.fileName &&
    a.byteLength === b.byteLength &&
    a.width === b.width &&
    a.height === b.height &&
    a.durationSeconds === b.durationSeconds &&
    a.ptt === b.ptt &&
    a.caption === b.caption &&
    a.available === b.available &&
    a.unavailableReason === b.unavailableReason
  );
}

function sameConversationRow(a: ConversationRow, b: ConversationRow): boolean {
  if (a === b) return true;
  return (
    a.conversationId === b.conversationId &&
    a.contact.name === b.contact.name &&
    a.contact.phone === b.contact.phone &&
    (a.lastMessage === b.lastMessage ||
      (!!a.lastMessage &&
        !!b.lastMessage &&
        a.lastMessage.direction === b.lastMessage.direction &&
        a.lastMessage.body === b.lastMessage.body &&
        a.lastMessage.createdAt === b.lastMessage.createdAt &&
        a.lastMessage.mediaKind === b.lastMessage.mediaKind &&
        a.lastMessage.fileName === b.lastMessage.fileName &&
        a.lastMessage.ptt === b.lastMessage.ptt)) &&
    a.unreadCount === b.unreadCount &&
    a.replyMode === b.replyMode &&
    a.freeformUntil === b.freeformUntil &&
    (a.work === b.work ||
      (!!a.work &&
        !!b.work &&
        a.work.ref === b.work.ref &&
        a.work.inboundVersion === b.work.inboundVersion))
  );
}

function sameConversationRows(a: ConversationRow[], b: ConversationRow[]): boolean {
  return a.length === b.length && a.every((row, i) => sameConversationRow(row, b[i]));
}

function sameConversation(a: Conversation, b: Conversation): boolean {
  return (
    sameConversationRow(a, b) &&
    a.status === b.status &&
    a.lastInboundAt === b.lastInboundAt &&
    a.handoffAt === b.handoffAt
  );
}

function sameMessage(a: Message, b: Message): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.direction === b.direction &&
    a.body === b.body &&
    a.status === b.status &&
    a.senderType === b.senderType &&
    a.createdAt === b.createdAt &&
    a.type === b.type &&
    a.previewJpeg === b.previewJpeg &&
    sameMedia(a.media, b.media)
  );
}

function sameMessageRows(a: Message[], b: Message[]): boolean {
  return a.length === b.length && a.every((row, i) => sameMessage(row, b[i]));
}

function contactPhone(row: ConversationRow, linked: boolean) {
  if (linked && row.conversationId.endsWith("@g.us")) return null;
  if (!linked) return row.contact.phone;
  if (row.contact.phone && /^\+[1-9]\d{7,14}$/.test(row.contact.phone)) return row.contact.phone;
  // Older hosts may omit the phone. Only a phone-addressed JID proves it.
  const address = /^([1-9]\d{7,14})(?::\d{1,5})?@s\.whatsapp\.net$/.exec(row.conversationId);
  return address ? `+${address[1]}` : null;
}

const phoneUnavailable = (zh: boolean) => zh ? "未有電話號碼" : "Phone not available";

function contactName(row: ConversationRow, phone: string | null, linked: boolean, zh: boolean, name?: string | null) {
  const display = name || row.contact.name;
  if (display) return display;
  if (linked && row.conversationId.endsWith("@g.us")) return zh ? "WhatsApp 群組" : "WhatsApp group";
  return phone ?? (linked ? phoneUnavailable(zh) : (zh ? "未知聯絡人" : "Unknown contact"));
}

function Avatar({ name, phone, group }: { name: string; phone?: string | null; group?: boolean }) {
  if (group) {
    return <span className="waba-avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9.2" cy="9" r="2.8" />
        <path d="M4 18.5a5.2 5.2 0 0 1 10.4 0" />
        <circle cx="16.5" cy="9.5" r="2.3" />
        <path d="M16 14.2a4.3 4.3 0 0 1 4.2 4.3" />
      </svg>
    </span>;
  }
  const trimmed = name.trim();
  const isGeneric = !trimmed || trimmed === phone || ["Phone not available", "未有電話號碼", "Unknown contact", "未知聯絡人", "WhatsApp group", "WhatsApp 群組"].includes(trimmed) || trimmed.startsWith("+");
  if (isGeneric) {
    return <span className="waba-avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8.5" r="3.6" />
        <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
      </svg>
    </span>;
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const chars = parts.length >= 2
    ? `${Array.from(parts[0]!)[0] ?? ""}${Array.from(parts[1]!)[0] ?? ""}`
    : Array.from(trimmed).slice(0, 2).join("");
  return <span className="waba-avatar" aria-hidden="true">{chars.toLocaleUpperCase()}</span>;
}

const dayFormat = { en: new Intl.DateTimeFormat("en", { dateStyle: "medium" }), zh: new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium" }) };
const timeFormat = { en: new Intl.DateTimeFormat("en", { timeStyle: "short" }), zh: new Intl.DateTimeFormat("zh-TW", { timeStyle: "short" }) };
const listDate = { en: new Intl.DateTimeFormat("en", { dateStyle: "short" }), zh: new Intl.DateTimeFormat("zh-TW", { dateStyle: "short" }) };
function stamp(value: string | null) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

async function readWhileIndexing<T>(
  read: () => Promise<T>,
  current: () => boolean,
  onIndexing: () => void,
): Promise<T | undefined> {
  while (current()) {
    try { const result = await read(); return current() ? result : undefined; }
    catch (error) {
      if (!current()) return undefined;
      if (!(error instanceof ApiError) || error.code !== "inbox_indexing") throw error;
      onIndexing();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  return undefined;
}

type Queue = "all" | "unread" | ThreadState | "due";
export type InboxQueue = Queue;
const crmQueues: readonly (ThreadState | "due")[] = ["needs_reply", "due", "waiting", "done"];
type WorkIndex = { records: Map<string, ThreadWork>; checked: Set<string> };
const emptyWorkIndex = (): WorkIndex => ({ records: new Map(), checked: new Set() });
function calendarDay(now: Date) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export default function Inbox({ scope, canReply, canTemplate, assist, handoff, routeId: routed, initialId, routeParamId, initialFilter, hasRouteParams = false, onRecipient, replyDirty, onDirtyChange, openSettings, tools }: { scope: DisplayScope; canReply: boolean; canTemplate: boolean; assist: Assist; handoff: Handoff; routeId: string | null; initialId: string | null; routeParamId: string | null; initialFilter: Queue | null; hasRouteParams?: boolean; onRecipient: (r: Recipient) => void; replyDirty: boolean; onDirtyChange: (dirty: boolean) => void; openSettings: () => Promise<unknown>; tools: ReactNode }) {
  const zh = useScope()?.presentationLocale === "zh-TW", locale = zh ? "zh" : "en";
  const linked = scope.provider === "linked";
  const provider: "linked" | "official" = linked ? "linked" : "official";
  const [settingsError, setSettingsError] = useState(false);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [list, setList] = useState<"loading" | "indexing" | "ok" | "more" | "failed">("loading");
  const listRequest = useRef(0);
  const foregroundList = useRef(false);
  const [filter, setFilter] = useState("");
  const [queue, setQueue] = useState<Queue>(() => initialFilter ?? "all");
  const [inboxScope, setInboxScope] = useState<string | null>(null);
  const liveInbox = useRef<string | null>(null);
  const [work, setWork] = useState(emptyWorkIndex);
  const [workError, setWorkError] = useState(false);
  const remember = useCallback((record: ThreadWork) => {
    if (!liveInbox.current || !validWorkRef(record.ref, liveInbox.current)) return;
    setWork(previous => {
      if ((previous.records.get(record.ref)?.revision ?? 0) >= record.revision) return previous;
      return { records: new Map(previous.records).set(record.ref, record), checked: new Set(previous.checked).add(record.ref) };
    });
  }, []);
  // Ids outside the host route grammar (or opened via route.params.id) stay in local selection.
  const [local, setLocal] = useState(() => routeParamId ?? initialId);
  const [focusedThread, setFocusedThread] = useState(() => routeParamId !== null);
  const [resolved, setResolved] = useState<Conversation | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const openingRequest = useRef(0);
  const [newMessage, setNewMessage] = useState(false);
  const selected = routed ?? local;
  const drafts = useSyncExternalStore(channel.subscribeDrafts, channel.getDrafts);
  const manuallyMarkedUnread = useRef<Map<string, string | null>>(new Map());
  const threadAtBottom = useRef(true);
  const [openedUnread, setOpenedUnread] = useState<{ id: string; count: number }>({ id: "", count: 0 });
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const openRow = useRef<HTMLElement | null>(null);
  const focusThread = useRef(false);
  const thread = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!focusThread.current) return;
    focusThread.current = false;
    const canFocus = typeof navigator === "undefined" || !navigator.userActivation || navigator.userActivation.isActive;
    if (!canFocus) return;
    if (newMessage || (selected && !openRow.current?.getClientRects().length)) thread.current?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    else if (!selected) openRow.current?.focus({ preventScroll: true });
  }, [newMessage, selected]);
  // `quiet` is a host-push or background poll refresh: no loading state, loaded pages
  // kept, errors leave what is shown in place.
  const page = useCallback(async (after: string | null, quiet = false): Promise<boolean> => {
    if (quiet && foregroundList.current) return true;
    const request = ++listRequest.current;
    if (!quiet) { foregroundList.current = true; setList(after ? "more" : "loading"); }
    try {
      const got = await readWhileIndexing(
        async () => parseConversations(await serviceCall(scope, "whatsapp.conversations.list", { limit: PAGE, ...(after ? { cursor: after } : {}) })),
        () => request === listRequest.current,
        () => { if (!quiet) setList("indexing"); },
      );
      if (!got) return true;
      const nextInbox = linked ? got.inboxScope : null;
      const changed = nextInbox !== liveInbox.current;
      if (changed) {
        if (liveInbox.current !== null) {
          openingRequest.current++;
          setOpening(false); setLocal(null); setResolved(null); setNewMessage(false); setQueue("all");
        }
        liveInbox.current = nextInbox;
        setInboxScope(nextInbox); setWork(emptyWorkIndex()); setWorkError(false);
      }
      setRows(r => {
        const merged = changed ? got.rows : after ? [...r, ...got.rows.filter(n => !r.some(o => o.conversationId === n.conversationId))]
          : quiet ? [...got.rows, ...r.filter(o => !got.rows.some(n => n.conversationId === o.conversationId))] : got.rows;
        const activeId = selectedRef.current;
        const visibleNow = typeof document === "undefined" ? true : document.visibilityState === "visible";
        const nextRows = merged.map(rowItem => {
          const markedStamp = manuallyMarkedUnread.current.get(rowItem.conversationId);
          if (markedStamp !== undefined) {
            if ((rowItem.lastMessage?.createdAt ?? null) === markedStamp) {
              return rowItem;
            }
            manuallyMarkedUnread.current.delete(rowItem.conversationId);
          }
          if (
            activeId &&
            rowItem.conversationId === activeId &&
            visibleNow &&
            threadAtBottom.current &&
            (rowItem.unreadCount ?? 0) > 0 &&
            channel.hostUx
          ) {
            channel.setThreadUnread(activeId, provider, false);
            return { ...rowItem, unreadCount: 0 };
          }
          return rowItem;
        });
        return sameConversationRows(r, nextRows) ? r : nextRows;
      });
      setCursor(c => quiet && c && !changed ? c : got.cursor); setList(l => l === "ok" ? l : "ok");
      if (nextInbox && got.rows.length) {
        const refs = got.rows.flatMap(r => r.work ? [r.work.ref] : []);
        try {
          const records = await listThreadWork(scope, nextInbox, refs);
          if (request !== listRequest.current) return true;
          setWork(previous => {
            const next = { records: new Map(previous.records), checked: new Set(previous.checked) };
            let workChanged = false;
            for (const ref of refs) {
              if (!next.checked.has(ref)) {
                next.checked.add(ref);
                workChanged = true;
              }
            }
            for (const record of records) {
              if ((next.records.get(record.ref)?.revision ?? 0) < record.revision) {
                next.records.set(record.ref, record);
                workChanged = true;
              }
            }
            return workChanged ? next : previous;
          });
          setWorkError(e => e ? false : e);
        } catch { if (request === listRequest.current) setWorkError(true); }
      }
      return true;
    } catch (error) {
      if (request !== listRequest.current) return true;
      if (linked && error instanceof ApiError && error.code === "not_granted") {
        openingRequest.current++;
        liveInbox.current = null;
        setInboxScope(null); setLocal(null); setResolved(null); setNewMessage(false);
        setOpening(false); setOpenError(false); setQueue("all"); setRows([]); setCursor(null);
        setWork(emptyWorkIndex()); setWorkError(false); setList("failed");
      } else if (!quiet) setList("failed");
      return false;
    }
    finally { if (!quiet && request === listRequest.current) foregroundList.current = false; }
  }, [scope, linked]);
  useEffect(() => { void page(null); return () => { listRequest.current++; foregroundList.current = false; }; }, [page]);
  useOnPush(() => page(null, true));
  useLivePoll({
    enabled: list === "ok",
    poll: () => page(null, true),
    intervalMs: LIVE_POLL_MS,
  });
  const clearUnread = useCallback((conversationId: string, force = false) => {
    const existing = rowsRef.current.find(r => r.conversationId === conversationId);
    const hasUnread = (existing?.unreadCount ?? 0) > 0;
    manuallyMarkedUnread.current.delete(conversationId);
    if (!force && !hasUnread) return;
    setRows(prev => {
      let updated = false;
      const next = prev.map(rowItem => {
        if (rowItem.conversationId !== conversationId || (rowItem.unreadCount ?? 0) === 0) return rowItem;
        updated = true;
        return { ...rowItem, unreadCount: 0 };
      });
      return updated ? next : prev;
    });
    if (channel.hostUx && (hasUnread || force)) {
      channel.setThreadUnread(conversationId, provider, false);
    }
  }, [provider]);
  const markUnread = useCallback((conversationId: string) => {
    const existing = rowsRef.current.find(r => r.conversationId === conversationId);
    manuallyMarkedUnread.current.set(conversationId, existing?.lastMessage?.createdAt ?? null);
    setRows(prev => {
      let updated = false;
      const next = prev.map(rowItem => {
        if (rowItem.conversationId !== conversationId) return rowItem;
        const target = Math.max(1, rowItem.unreadCount ?? 0);
        if (rowItem.unreadCount === target) return rowItem;
        updated = true;
        return { ...rowItem, unreadCount: target };
      });
      return updated ? next : prev;
    });
    if (channel.hostUx) channel.setThreadUnread(conversationId, provider, true);
  }, [provider]);
  const select = useCallback((id: string | null, observed: Conversation | null = null) => {
    openingRequest.current++;
    setOpening(false); setOpenError(false); setResolved(observed);
    setNewMessage(false);
    focusThread.current = true;
    threadAtBottom.current = true;
    if (id !== null) {
      const existing = rowsRef.current.find(r => r.conversationId === id);
      const countBeforeOpen = Math.max(0, existing?.unreadCount ?? observed?.unreadCount ?? 0);
      setOpenedUnread({ id, count: countBeforeOpen });
      clearUnread(id, observed !== null ? countBeforeOpen > 0 : existing === undefined);
    } else {
      setOpenedUnread({ id: "", count: 0 });
      setFocusedThread(false);
    }
    const clearParams = id === null && (hasRouteParams || routeParamId !== null);
    if (scope.provider === "linked") {
      setLocal(id);
      if (clearParams) void patchRoute({ section: "inbox", view: "list", record_id: null, params: {} }).catch(() => undefined);
      return;
    }
    if (id === null || routable(id)) {
      setLocal(null);
      void patchRoute({ section: "inbox", view: "list", record_id: id, ...(clearParams ? { params: {} } : {}) }).catch(() => undefined);
    } else {
      setLocal(id);
      void patchRoute({ section: "inbox", view: "list", record_id: null }).catch(() => undefined);
    }
  }, [clearUnread, hasRouteParams, routeParamId, scope.provider]);
  const prevRouteParamId = useRef(routeParamId);
  useEffect(() => {
    if (prevRouteParamId.current === routeParamId) return;
    prevRouteParamId.current = routeParamId;
    if (routeParamId === null) {
      setFocusedThread(false);
      return;
    }
    setFocusedThread(true);
    setResolved(null);
    setLocal(routeParamId);
    setOpenError(false);
  }, [routeParamId]);
  const prevInitialFilter = useRef(initialFilter);
  useEffect(() => {
    if (prevInitialFilter.current === initialFilter) return;
    prevInitialFilter.current = initialFilter;
    if (initialFilter !== null) setQueue(initialFilter);
  }, [initialFilter]);
  useEffect(() => {
    return channel.subscribeOpenThread(conversationId => {
      if (replyDirty) return;
      const existing = rowsRef.current.find(r => r.conversationId === conversationId);
      if (existing) {
        select(conversationId);
        return;
      }
      const request = ++openingRequest.current;
      setOpening(true);
      setOpenError(false);
      void serviceCall(scope, "whatsapp.conversations.show", { conversation_id: conversationId })
        .then(raw => {
          if (request !== openingRequest.current) return;
          const found = parseConversation(raw);
          select(found.conversationId, found);
          void page(null, true);
        })
        .catch(() => {
          if (request === openingRequest.current) setOpenError(true);
        })
        .finally(() => {
          if (request === openingRequest.current) setOpening(false);
        });
    });
  }, [scope, page, replyDirty, select]);
  async function openWork(ref: string, source: HTMLElement) {
    if (!inboxScope || !validWorkRef(ref, inboxScope) || opening || replyDirty) return;
    const account = inboxScope, request = ++openingRequest.current;
    setOpening(true); setOpenError(false);
    try {
      const found = parseConversation(await serviceCall(scope, "whatsapp.conversations.show", { conversation_id: ref }));
      if (request !== openingRequest.current || liveInbox.current !== account) return;
      if (found.work?.ref !== ref || found.conversationId === ref) throw new ApiError("Conversation reference did not resolve", 502);
      openRow.current = source;
      select(found.conversationId, found);
    } catch { if (request === openingRequest.current) setOpenError(true); }
    finally { if (request === openingRequest.current) setOpening(false); }
  }
  const now = new Date(), today = dayFormat[locale].format(now), dueDay = calendarDay(now);
  const needle = filter.trim().toLocaleLowerCase();
  const browse = useWorkBrowse(scope, inboxScope, queue === "due" ? "due" : queue === "all" && needle ? "names" : null, queue === "due" ? dueDay : needle);
  const recordFor = (row: ConversationRow) => row.work && inboxScope && validWorkRef(row.work.ref, inboxScope) ? work.records.get(row.work.ref) : undefined;
  const canFilterUnread = rows.some(row => row.unreadCount !== null);
  useLayoutEffect(() => {
    if (list === "ok" && !canFilterUnread && queue === "unread") setQueue("all");
  }, [list, canFilterUnread, queue]);
  const unreadCount = rows.filter(row => (row.unreadCount ?? 0) > 0).length;
  const selectedRow = selected ? rows.find(r => r.conversationId === selected) ?? null : null;
  const shown = queue === "due" ? [] : rows.filter(r => {
    const record = recordFor(r);
    if (queue === "unread" ? (r.unreadCount ?? 0) <= 0
      : queue !== "all" && (!r.work || !work.checked.has(r.work.ref) || effectiveThreadState(record, r.work.inboundVersion) !== queue)) return false;
    return !needle || [record?.name, r.contact.name, contactPhone(r, linked), r.lastMessage?.body, r.lastMessage?.fileName].some(v => v?.toLocaleLowerCase().includes(needle));
  });
  const pageByRef = useMemo(() => new Map(rows.flatMap(r => r.work ? [[r.work.ref, r] as const] : [])), [rows]);
  const extras = browse.page?.rows.map(row => work.records.get(row.ref) ?? row).filter(r => {
    if (queue === "due") {
      const known = pageByRef.get(r.ref);
      return !!r.due && r.due <= dueDay && (!needle || [r.name, known?.contact.name, known && contactPhone(known, linked)].some(value => value?.toLocaleLowerCase().includes(needle)));
    }
    return !pageByRef.has(r.ref) && !!r.name?.toLocaleLowerCase().includes(needle);
  }) ?? [];
  const queueStats = useMemo(() => {
    let needsReply = 0, waiting = 0, done = 0, dueLoaded = 0;
    for (const r of rows) {
      if (!r.work || !work.checked.has(r.work.ref)) continue;
      const record = work.records.get(r.work.ref);
      const state = effectiveThreadState(record, r.work.inboundVersion);
      if (state === "needs_reply") needsReply += 1;
      else if (state === "waiting") waiting += 1;
      else if (state === "done") done += 1;
      if (record?.due && record.due <= dueDay) dueLoaded += 1;
    }
    const dueExact = queue === "due" && browse.page?.state === "ok"
      ? (browse.page.cursor ? `${extras.length}+` : String(extras.length))
      : dueLoaded > 0 ? String(dueLoaded) : undefined;
    return { needsReply, waiting, done, dueBadge: dueExact };
  }, [rows, work, dueDay, queue, browse.page, extras.length]);
  const [queueFilterOpen, setQueueFilterOpen] = useState(false);
  const queueFilterWrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!queueFilterOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (queueFilterWrap.current && !queueFilterWrap.current.contains(event.target as Node)) setQueueFilterOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setQueueFilterOpen(false); }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [queueFilterOpen]);
  const queueLabel = (value: Queue) => {
    if (value === "all") return zh ? "全部" : "All";
    if (value === "unread") return zh ? "未讀" : "Unread";
    if (value === "due") return zh ? "待跟進" : "Follow-ups due";
    return threadStateLabel(value, zh);
  };
  const queueCount = (value: Queue): string | undefined => {
    if (value === "unread") return unreadCount > 0 ? String(unreadCount) : undefined;
    if (value === "needs_reply") return queueStats.needsReply > 0 ? String(queueStats.needsReply) : undefined;
    if (value === "due") return queueStats.dueBadge;
    if (value === "waiting") return queueStats.waiting > 0 ? String(queueStats.waiting) : undefined;
    if (value === "done") return queueStats.done > 0 ? String(queueStats.done) : undefined;
    return undefined;
  };
  const activeQueueLabel = queueLabel(queue);
  const crmFilterActive = queue !== "all" && queue !== "unread";
  const visibleCount = queue === "due" ? extras.length : shown.length + extras.length;
  const failed = list === "failed";
  const browseLabel = queue === "due" ? (zh ? "查找跟進事項…" : "Finding follow-ups…") : (zh ? "搜尋已儲存名稱…" : "Searching saved names…");
  const isFocusedMode = focusedThread && selected !== null && !newMessage;
  return <section className="waba-page waba-inbox" data-selected={newMessage || selected ? "yes" : "no"} data-focused-thread={isFocusedMode ? "yes" : "no"} aria-label={zh ? "收件匣" : "Inbox"}>
    <div className="waba-list" aria-labelledby="waba-inbox-title">
      <header className="waba-list-head">
        <div className="waba-head">
          <h1 id="waba-inbox-title" tabIndex={-1}>{zh ? "收件匣" : "Inbox"}</h1>
          {linked && canReply && <Button size="sm" variant="primary" disabled={replyDirty || opening} onClick={e => { openRow.current = e.currentTarget; focusThread.current = true; setLocal(null); setResolved(null); setNewMessage(true); }}>{zh ? "新增訊息" : "New message"}</Button>}
          {tools}
        </div>
        <input className="field waba-search" type="search" aria-label={zh ? "搜尋對話" : "Search conversations"} placeholder={zh ? "搜尋對話…" : "Search conversations…"} value={filter} onChange={e => setFilter(e.target.value)} />
        {(canFilterUnread || inboxScope) && <div className="waba-list-filters" role="group" aria-label={zh ? "篩選對話" : "Filter conversations"}>
          <div className="waba-seg-group">
            <button type="button" className="waba-seg-btn" aria-pressed={queue === "all"} onClick={() => { setQueue("all"); setQueueFilterOpen(false); }}>{zh ? "全部" : "All"}</button>
            {canFilterUnread && <button type="button" className="waba-seg-btn" aria-pressed={queue === "unread"} onClick={() => { setQueue(queue === "unread" ? "all" : "unread"); setQueueFilterOpen(false); }}>
              <span>{zh ? "未讀" : "Unread"}</span>
              {unreadCount > 0 && <span className="waba-seg-count">{unreadCount > 99 ? "99+" : unreadCount}</span>}
            </button>}
          </div>
          {inboxScope && <div ref={queueFilterWrap} className="waba-filter-pop-wrap">
            <button type="button" className="waba-filter-btn" data-active={crmFilterActive ? "yes" : undefined} aria-haspopup="menu" aria-expanded={queueFilterOpen} aria-label={zh ? "進階篩選" : "Filter by status"} onClick={() => setQueueFilterOpen(v => !v)}>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4h11M4.5 8h7M6.5 12h3" /></svg>
              <span>{crmFilterActive ? activeQueueLabel : (zh ? "篩選" : "Filter")}</span>
              {crmFilterActive && queueCount(queue) && <span className="waba-seg-count">{queueCount(queue)}</span>}
            </button>
            {queueFilterOpen && <div className="waba-work-menu" role="menu" aria-label={zh ? "跟進及狀態" : "Follow-up & status"}>
              {crmQueues.map(option => {
                const badge = queueCount(option);
                return <button key={option} type="button" role="menuitemradio" aria-checked={queue === option} className="waba-work-menu-item" onClick={() => { setQueue(queue === option ? "all" : option); setQueueFilterOpen(false); }}>
                  <span>{queueLabel(option)}</span>
                  {badge && <span className="waba-work-menu-badge">{badge}</span>}
                  {queue === option && <span className="waba-work-menu-check" aria-hidden="true">✓</span>}
                </button>;
              })}
              {crmFilterActive && <>
                <div className="waba-work-menu-sep" role="separator" />
                <button type="button" role="menuitem" className="waba-work-menu-item" onClick={() => { setQueue("all"); setQueueFilterOpen(false); }}>{zh ? "顯示全部對話" : "Show all chats"}</button>
              </>}
            </div>}
          </div>}
        </div>}
      </header>
      <div className="waba-list-scroll">
      {crmFilterActive && list === "ok" && <div className="waba-active-filter">
        <span>{zh ? `顯示 ${visibleCount} 項 · ${activeQueueLabel}` : `Showing ${visibleCount} · ${activeQueueLabel}`}</span>
        <button type="button" className="waba-active-reset" onClick={() => setQueue("all")}>{zh ? "重設" : "Reset"}</button>
      </div>}
      {workError && queue !== "due" && <ErrorNotice bare onRetry={() => { void page(null, true); }}>{zh ? "無法載入跟進狀態。" : "Couldn’t refresh conversation work."}</ErrorNotice>}
      {opening && <Loading>{zh ? "正在開啟對話…" : "Opening conversation…"}</Loading>}
      {openError && <ErrorNotice bare>{zh ? "無法開啟對話。請檢查已連結帳戶。" : "Couldn’t open that conversation. Check the linked account."}</ErrorNotice>}
      {browse.page?.state === "failed" && <ErrorNotice bare onRetry={() => { void browse.load(browse.page?.cursor); }}>{zh ? "無法讀取搜尋結果。" : "Couldn’t read those results."}</ErrorNotice>}
      {list === "indexing" && rows.length > 0 && <p className="waba-muted" role="status">{zh ? "正在整理較早的對話…" : "Indexing older conversations…"}</p>}
      {(list === "loading" || list === "indexing") && !rows.length ? <Loading>{list === "indexing" ? (zh ? "正在整理較早的對話…" : "Indexing older conversations…") : (zh ? "正在載入對話…" : "Loading conversations…")}</Loading>
        : failed ? <>
          <ErrorNotice onRetry={() => { void page(null); }}>{zh ? "無法載入對話。" : "Couldn’t load conversations."}</ErrorNotice>
          <Button size="sm" variant="ghost" disabled={replyDirty} onClick={() => { setSettingsError(false); void openSettings().catch(() => setSettingsError(true)); }}>{zh ? "開啟設定" : "Open Settings"}</Button>
          {settingsError && <ErrorNotice bare>{zh ? "請在側欄選取設定。" : "Choose Settings in the sidebar."}</ErrorNotice>}
        </>
        : !shown.length && !extras.length && browse.page?.state === "loading" ? <Loading>{browseLabel}</Loading>
        : !shown.length && !extras.length && browse.page?.state !== "failed" ? <EmptyState title={queue === "due" ? (zh ? "沒有待跟進事項" : "No follow-ups due") : needle || queue !== "all" ? (zh ? "找不到符合的對話" : "No matching conversations") : (zh ? "暫未有對話" : "No conversations yet")} name="conversations">
            {cursor && queue !== "due" && (needle || queue !== "all") ? (zh ? "可載入更多對話以查看較早結果。" : "Load more conversations to check older results.")
              : queue === "due" ? (zh ? "跟進日期到期時，對話會在這裏出現。" : "Conversations appear here when their follow-up date is due.")
              : !needle && queue === "all" ? (zh ? "新的 WhatsApp 對話會在這裏顯示。" : "New WhatsApp conversations will appear here.") : undefined}
          </EmptyState>
        : <ul className="waba-rows">{shown.map(r => {
          const phone = contactPhone(r, linked);
          const record = recordFor(r);
          const groupRow = linked && r.conversationId.endsWith("@g.us");
          const name = contactName(r, phone, linked, zh, record?.name), at = stamp(r.lastMessage?.createdAt ?? null);
          const isDue = !!record?.due && record.due <= dueDay;
          const unread = r.unreadCount ?? 0;
          const draftPreview = r.conversationId !== selected ? drafts[r.conversationId] : undefined;
          const lastText = formatConversationPreviewText(r, zh);
          const outboundLast = !draftPreview && r.lastMessage?.direction === "outbound";
          return <li key={r.conversationId}>
            <button type="button" className="waba-row" disabled={replyDirty || opening} aria-current={r.conversationId === selected ? "true" : undefined} data-unread={unread > 0 ? "yes" : undefined} onClick={e => { openRow.current = e.currentTarget; select(r.conversationId); }}>
              <Avatar name={name} phone={phone} group={groupRow} />
              <span className="waba-row-top">
                <span className="waba-row-title">{name === phone ? <bdi className="waba-row-phone" dir="ltr">{phone}</bdi> : name}</span>
                {at !== null && <time className="waba-row-time" data-unread={unread > 0 ? "yes" : undefined} dateTime={r.lastMessage?.createdAt ?? undefined}>{dayFormat[locale].format(at) === today ? timeFormat[locale].format(at) : listDate[locale].format(at)}</time>}
              </span>
              <span className="waba-row-bottom">
                <span className="waba-row-last">
                  {outboundLast && <MessageStatusTick status="delivered" zh={zh} />}
                  <span className="waba-row-preview">{draftPreview ? <><span className="waba-draft-prefix">{zh ? "草稿：" : "Draft: "}</span>{draftPreview}</> : lastText}</span>
                </span>
                {(isDue || unread > 0) && <span className="waba-row-tail">
                  {isDue && <span className="waba-row-due-dot" data-tone={record!.due! < dueDay ? "overdue" : "due"} title={dueLabel(record!.due!, dueDay, zh)} aria-label={dueLabel(record!.due!, dueDay, zh)} />}
                  {unread > 0 && <span className="waba-badge" aria-label={zh ? `${unread} 則未讀訊息` : `${unread} unread`}>{unread > 99 ? "99+" : unread}</span>}
                </span>}
              </span>
            </button>
          </li>;
        })}{extras.map(record => {
          const known = pageByRef.get(record.ref) ?? (resolved?.work?.ref === record.ref ? resolved : null);
          const phone = known ? contactPhone(known, linked) : null;
          const groupRow = !!known && linked && known.conversationId.endsWith("@g.us");
          const name = known ? contactName(known, phone, linked, zh, record.name) : record.name ?? (zh ? "較早對話" : "Earlier conversation");
          return <li key={record.ref}>
            <button type="button" className="waba-row" aria-disabled={opening || undefined} disabled={replyDirty} aria-current={selected && (known?.conversationId === selected || resolved?.work?.ref === record.ref) ? "true" : undefined}
              onClick={e => { remember(record); void openWork(record.ref, e.currentTarget); }}>
              <Avatar name={name} phone={phone} group={groupRow} />
              <span className="waba-row-top">
                <span className="waba-row-title">{name === phone ? <bdi className="waba-row-phone" dir="ltr">{phone}</bdi> : name}</span>
              </span>
              <span className="waba-row-bottom">
                <span className="waba-row-last"><span className="waba-row-preview">{record.due ? `${dueLabel(record.due, dueDay, zh)} · ${record.due}` : (zh ? "已儲存的對話名稱" : "Saved conversation name")}</span></span>
              </span>
            </button>
          </li>;
        })}</ul>}
        {cursor && !failed && queue !== "due" && <div className="waba-page-more"><Button size="sm" loading={list === "more" || list === "indexing"} onClick={() => { void page(cursor); }}>{zh ? "載入更多" : "Load more"}</Button></div>}
        {browse.page?.cursor && browse.page.state !== "failed" && <div className="waba-page-more"><Button size="sm" loading={browse.page.state === "loading"} onClick={() => { void browse.load(browse.page?.cursor); }}>{zh ? "更多結果" : "More results"}</Button></div>}
      </div>
    </div>
    <div ref={thread} className="waba-thread">
      {newMessage ? <NewLinkedReply scope={scope} dirty={replyDirty} onDirtyChange={onDirtyChange} onBack={() => select(null)} onChanged={() => { void page(null, true); }} />
        : selected ? <Thread key={selected} scope={scope} id={selected} initial={resolved} preview={selectedRow} initialUnread={openedUnread.id === selected ? openedUnread.count : 0} inboxScope={inboxScope} work={work} onWork={remember} onMarkUnread={markUnread} onAutoClearUnread={id => { if (!manuallyMarkedUnread.current.has(id)) clearUnread(id, false); }} onAtBottomChange={atBottom => { threadAtBottom.current = atBottom; }} canReply={canReply} canTemplate={canTemplate} assist={assist} handoff={handoff} focusedMode={isFocusedMode} onRecipient={onRecipient} onDirtyChange={onDirtyChange} onBack={() => select(null)} replyDirty={replyDirty} />
        : <div className="waba-thread-empty">
            <p><strong>{zh ? "選擇對話" : "Select a conversation"}</strong></p>
            <p className="waba-muted">{zh ? "打開對話以查看記錄及回覆。" : "Open a conversation to read and reply."}</p>
          </div>}
    </div>
  </section>;
}

function NewLinkedReply({ scope, dirty, onDirtyChange, onBack, onChanged }: { scope: DisplayScope; dirty: boolean; onDirtyChange: (dirty: boolean) => void; onBack: () => void; onChanged: () => void }) {
  const [phone, setPhone] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  return <article className="waba-card" aria-labelledby="waba-new-message-title">
    <header className="waba-head">
      <Button size="sm" variant="ghost" disabled={dirty} onClick={onBack}>Back</Button>
      <h2 id="waba-new-message-title" tabIndex={-1}>New linked-device message</h2>
    </header>
    {target === null ? <form className="waba-composer" onSubmit={e => { e.preventDefault(); if (/^\+[1-9]\d{7,14}$/.test(phone)) setTarget(`${phone.slice(1)}@s.whatsapp.net`); }}>
      <Field label="Recipient phone number" hint="Use international format, including + and country code.">
        {c => <input {...c} className="field" type="tel" autoComplete="tel" required pattern="\+[1-9][0-9]{7,14}" value={phone} onChange={e => setPhone(e.target.value)} />}
      </Field>
      <Button type="submit" variant="primary">Continue</Button>
    </form> : <>
      <p>To: <strong>{phone}</strong></p>
      <Button size="sm" variant="ghost" disabled={dirty} onClick={() => setTarget(null)}>Change number</Button>
      <Composer scope={scope} conversationId={target} handoffAt={null} freeformUntil={null} open autoTakeover={false} inserted={null} onSent={onChanged} onChanged={onChanged} onDirtyChange={onDirtyChange} />
    </>}
  </article>;
}

function ThreadSkeleton({ indexing, zh }: { indexing: boolean; zh: boolean }) {
  const label = indexing
    ? (zh ? "正在整理較早的訊息…" : "Indexing older messages…")
    : (zh ? "正在載入訊息…" : "Loading messages…");
  return <div className="waba-skeleton" role="status">
    <span className="waba-sr">{label}</span>
    {indexing && <div className="waba-skeleton-indexing" aria-hidden="true">
      <span className="waba-inline-spin" />
      <span>{label}</span>
    </div>}
    <div className="waba-skeleton-date" aria-hidden="true" />
    <div className="waba-skeleton-bubble" data-direction="inbound" data-size="lg" aria-hidden="true">
      <span className="waba-skeleton-line" />
      <span className="waba-skeleton-line" data-short="" />
      <span className="waba-skeleton-meta" />
    </div>
    <div className="waba-skeleton-bubble" data-direction="outbound" data-size="md" aria-hidden="true">
      <span className="waba-skeleton-line" />
      <span className="waba-skeleton-meta" />
    </div>
    <div className="waba-skeleton-bubble" data-direction="inbound" data-size="xl" aria-hidden="true">
      <span className="waba-skeleton-line" />
      <span className="waba-skeleton-line" data-med="" />
      <span className="waba-skeleton-meta" />
    </div>
    <div className="waba-skeleton-bubble" data-direction="outbound" data-size="sm" aria-hidden="true">
      <span className="waba-skeleton-line" />
      <span className="waba-skeleton-meta" />
    </div>
    <div className="waba-skeleton-bubble" data-direction="inbound" data-size="md" aria-hidden="true">
      <span className="waba-skeleton-line" />
      <span className="waba-skeleton-meta" />
    </div>
  </div>;
}

function Thread({ scope, id, initial, preview, initialUnread, inboxScope, work, onWork, onMarkUnread, onAutoClearUnread, onAtBottomChange, canReply, canTemplate, assist, handoff, focusedMode = false, onRecipient, onDirtyChange, onBack, replyDirty }: {
  scope: DisplayScope; id: string; initial: Conversation | null; preview: ConversationRow | null; initialUnread: number; inboxScope: string | null; work: WorkIndex; onWork: (record: ThreadWork) => void;
  onMarkUnread: (conversationId: string) => void; onAutoClearUnread: (conversationId: string) => void; onAtBottomChange: (atBottom: boolean) => void;
  canReply: boolean; canTemplate: boolean; assist: Assist; handoff: Handoff; focusedMode?: boolean; onRecipient: (r: Recipient) => void;
  onDirtyChange: (dirty: boolean) => void; onBack: () => void; replyDirty: boolean;
}) {
  const zh = useScope()?.presentationLocale === "zh-TW";
  const unavailablePreview = zh ? "無法顯示預覽" : "Preview unavailable";
  const [conversation, setConversation] = useState<Load<Conversation>>(() => initial?.conversationId === id ? { state: "ok", value: initial } : { state: "loading" });
  const [messages, setMessages] = useState<Load<{ rows: Message[]; cursor: string | null; previousAnchor?: { row: HTMLElement; top: number } }>>({ state: "loading" });
  const [unreadDividerCount, setUnreadDividerCount] = useState(() => (initialUnread > 0 ? initialUnread : 0));
  const [newWhileScrolledUp, setNewWhileScrolledUp] = useState(0);
  const seenMessageIds = useRef<Set<string> | null>(null);
  const latestInboundStamp = useRef(0);
  type OptimisticMessage = { tempId: string; text: string; mediaKind: WhatsAppOutboundEcho["mediaKind"]; fileName: string | null; createdAt: string; status: "pending" | "sent" };
  const [optimistic, setOptimistic] = useState<OptimisticMessage[]>([]);
  const [workMenuOpen, setWorkMenuOpen] = useState(false);
  const [workBusy, setWorkBusy] = useState(false);
  const workMenuWrap = useRef<HTMLDivElement>(null);
  const workPillButton = useRef<HTMLButtonElement>(null);
  const workActionState = useRef<{
    workLink: { ref: string; inboundVersion: number } | null;
    record: ThreadWork | undefined;
    checked: boolean;
  }>({ workLink: null, record: undefined, checked: false });
  const [indexing, setIndexing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const messageRequest = useRef(0);
  const foregroundMessages = useRef(false);
  const timeline = useRef<HTMLDivElement>(null);
  const messagePane = useRef<HTMLDivElement>(null);
  const keepBottom = useRef(true);
  const timelineScroll = useRef({ width: 0, height: 0, top: 0 });
  const [showLatest, setShowLatest] = useState(false);
  const [details, setDetails] = useState(false);
  const replyEdited = useRef(false), workEdited = useRef(false);
  const onReplyDirty = useCallback((dirty: boolean) => {
    replyEdited.current = dirty;
    onDirtyChange(dirty || workEdited.current);
  }, [onDirtyChange]);
  const onWorkDirty = useCallback((dirty: boolean) => {
    workEdited.current = dirty;
    onDirtyChange(dirty || replyEdited.current);
  }, [onDirtyChange]);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const wasDetailsOpen = useRef(false);
  const closeLightboxButton = useRef<HTMLButtonElement>(null);
  type LoadedInlineMedia = { url: string; mimeType: string; fileName: string | null };
  type QueuedAutoMedia = {
    messageId: string;
    resolve: (value: LoadedInlineMedia) => void;
    reject: (error: unknown) => void;
  };
  const mediaMounted = useRef(true);
  const mediaUrls = useRef<Map<string, string>>(new Map());
  const loadedMediaRef = useRef<Map<string, LoadedInlineMedia>>(new Map());
  const inlineInFlight = useRef<Map<string, Promise<LoadedInlineMedia>>>(new Map());
  const autoQueue = useRef<QueuedAutoMedia[]>([]);
  const autoQueuedPromises = useRef<Map<string, { task: QueuedAutoMedia; promise: Promise<LoadedInlineMedia> }>>(new Map());
  const autoRunning = useRef(0);
  const [loadedMedia, setLoadedMedia] = useState<Map<string, LoadedInlineMedia>>(() => new Map());
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const hostMediaDownload = useSyncExternalStore(channel.subscribeReplyAvailability, () => channel.hostMediaDownload);
  useEffect(() => {
    mediaMounted.current = true;
    const urls = mediaUrls.current;
    const loaded = loadedMediaRef.current;
    const queued = autoQueue.current;
    const queuedMap = autoQueuedPromises.current;
    return () => {
      mediaMounted.current = false;
      queued.length = 0;
      queuedMap.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      loaded.clear();
    };
  }, []);
  const mediaProvider: "linked" | "official" = scope.provider === "linked" ? "linked" : "official";
  const runInlineFetch = useCallback((messageId: string): Promise<LoadedInlineMedia> => {
    const active = inlineInFlight.current.get(messageId);
    if (active) return active;
    const promise = channel.downloadMedia(id, messageId, mediaProvider).then(downloaded => {
      if (!mediaMounted.current) {
        return { url: "", mimeType: downloaded.mimeType, fileName: downloaded.fileName };
      }
      const prev = mediaUrls.current.get(messageId);
      if (prev) URL.revokeObjectURL(prev);
      const url = URL.createObjectURL(new Blob([downloaded.bytes], { type: downloaded.mimeType }));
      mediaUrls.current.set(messageId, url);
      const entry: LoadedInlineMedia = { url, mimeType: downloaded.mimeType, fileName: downloaded.fileName };
      loadedMediaRef.current.set(messageId, entry);
      setLoadedMedia(current => new Map(current).set(messageId, entry));
      return entry;
    }).finally(() => {
      inlineInFlight.current.delete(messageId);
    });
    inlineInFlight.current.set(messageId, promise);
    return promise;
  }, [id, mediaProvider]);
  const drainAutoQueue = useCallback(() => {
    while (mediaMounted.current && autoRunning.current < 1 && autoQueue.current.length > 0) {
      const task = autoQueue.current.pop()!;
      autoQueuedPromises.current.delete(task.messageId);
      const cached = loadedMediaRef.current.get(task.messageId);
      if (cached && cached.url) {
        task.resolve(cached);
        continue;
      }
      autoRunning.current += 1;
      void runInlineFetch(task.messageId)
        .then(task.resolve, task.reject)
        .finally(() => {
          autoRunning.current = Math.max(0, autoRunning.current - 1);
          drainAutoQueue();
        });
    }
  }, [runInlineFetch]);
  const loadInlineMedia = useCallback((messageId: string, priority: "user" | "auto" = "user"): Promise<LoadedInlineMedia> => {
    const cached = loadedMediaRef.current.get(messageId);
    if (cached && cached.url) return Promise.resolve(cached);
    const active = inlineInFlight.current.get(messageId);
    if (active) return active;
    const queued = autoQueuedPromises.current.get(messageId);
    if (priority === "user") {
      if (queued) {
        autoQueuedPromises.current.delete(messageId);
        const idx = autoQueue.current.indexOf(queued.task);
        if (idx >= 0) autoQueue.current.splice(idx, 1);
        const direct = runInlineFetch(messageId);
        direct.then(queued.task.resolve, queued.task.reject);
        return direct;
      }
      return runInlineFetch(messageId);
    }
    if (queued) return queued.promise;
    let resolve!: (value: LoadedInlineMedia) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<LoadedInlineMedia>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const task: QueuedAutoMedia = { messageId, resolve, reject };
    autoQueuedPromises.current.set(messageId, { task, promise });
    autoQueue.current.push(task);
    drainAutoQueue();
    return promise;
  }, [runInlineFetch, drainAutoQueue]);
  useLayoutEffect(() => {
    if (lightboxId !== null) closeLightboxButton.current?.focus({ preventScroll: true });
  }, [lightboxId]);
  function jumpToLatest() {
    const pane = timeline.current;
    if (!pane) return;
    pane.focus({ preventScroll: true });
    pane.scrollTo({ top: pane.scrollHeight, behavior: "instant" });
    keepBottom.current = true;
    setShowLatest(false);
    setNewWhileScrolledUp(0);
    onAtBottomChange(true);
    onAutoClearUnread(id);
  }
  function closeDetails() {
    setDetails(false);
  }
  useLayoutEffect(() => {
    if (wasDetailsOpen.current && !details) {
      detailsButton.current?.focus({ preventScroll: true });
    }
    wasDetailsOpen.current = details;
  }, [details]);
  useLayoutEffect(() => {
    const pane = timeline.current;
    if (!pane) return;
    const observer = new ResizeObserver(() => {
      if (keepBottom.current) pane.scrollTop = pane.scrollHeight;
      const last = timelineScroll.current;
      last.width = pane.clientWidth;
      last.height = pane.clientHeight;
      last.top = pane.scrollTop;
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  // `quiet` is a host-push or background poll refresh: shown data stays on a failed
  // read, and messages already loaded stay (newer rows win by id).
  const show = useCallback(async (quiet = false): Promise<boolean> => {
    try {
      const next = parseConversation(await serviceCall(scope, "whatsapp.conversations.show", { conversation_id: id }));
      if (next.conversationId !== id) throw new ApiError("The conversation identity changed", 502);
      setConversation(c => c.state === "ok" && sameConversation(c.value, next) ? c : { state: "ok", value: next });
      return true;
    }
    catch (e) {
      setConversation(c => quiet && c.state === "ok" ? c : { state: "failed", text: errorText(e, "The conversation could not be read.") });
      return false;
    }
  }, [scope, id]);
  const read = useCallback(async (after: string | null = null, quiet = false): Promise<boolean> => {
    if (quiet && foregroundMessages.current) return true;
    const request = ++messageRequest.current;
    if (!quiet) {
      foregroundMessages.current = true;
      setIndexing(false);
      if (after) setLoadingOlder(true);
    }
    try {
      const got = await readWhileIndexing(
        async () => parseMessages(await serviceCall(scope, "whatsapp.messages", { conversation_id: id, limit: 50, ...(after ? { cursor: after } : {}) })),
        () => request === messageRequest.current,
        () => setIndexing(true),
      );
      if (!got) return true;
      setIndexing(i => i ? false : i);
      // A dock resize can change the scroll extent in the same commit as an
      // older page. Anchor a retained row, not the height including the dock.
      const row = after ? timeline.current?.querySelector<HTMLElement>(".waba-message") : null;
      const previousAnchor = row ? { row, top: row.offsetTop } : undefined;
      setMessages(m => {
        if (m.state === "ok" && (after || quiet)) {
          const nextRows = after
            ? [...m.value.rows, ...got.rows.filter(n => !m.value.rows.some(o => o.id === n.id))]
            : [...got.rows, ...m.value.rows.filter(o => !got.rows.some(n => n.id === o.id))];
          if (!after && sameMessageRows(m.value.rows, nextRows)) return m;
          return {
            state: "ok",
            value: {
              rows: nextRows,
              cursor: quiet ? m.value.cursor : got.cursor,
              ...(previousAnchor ? { previousAnchor } : {}),
            },
          };
        }
        return { state: "ok", value: { rows: got.rows, cursor: got.cursor } };
      });
      return true;
    } catch (e) {
      if (request !== messageRequest.current) return true;
      setIndexing(false);
      setMessages(m => quiet && m.state === "ok" ? m : { state: "failed", text: errorText(e, "Messages could not be read.") });
      return false;
    }
    finally {
      if (!quiet && request === messageRequest.current) {
        foregroundMessages.current = false;
        setLoadingOlder(false);
      }
    }
  }, [scope, id]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [assistNote, setAssistNote] = useState<string | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefNote, setBriefNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffNote, setHandoffNote] = useState<{ ok: boolean; text: string } | null>(null);
  const readDraft = useCallback(async (): Promise<boolean> => {
    if (!assist.show) { setDraft(null); return true; }
    // A failed read keeps what is shown: the chip never invents or drops a draft.
    try {
      const nextDraft = parseDraft(await serviceCall(scope, "whatsapp.draft.show", { conversation_id: id }));
      setDraft(prev => prev === nextDraft || (!!prev && !!nextDraft && prev.draftId === nextDraft.draftId && prev.text === nextDraft.text) ? prev : nextDraft);
      return true;
    } catch { return false; /* next poll retries */ }
  }, [scope, id, assist.show]);
  useEffect(() => {
    void readDraft();
  }, [readDraft]);
  useLivePoll({
    enabled: assist.show,
    poll: readDraft,
    intervalMs: LIVE_POLL_MS,
  });
  const reload = useCallback(() => { void show(); void read(); void readDraft(); }, [show, read, readDraft]);
  useEffect(() => {
    if (initial?.conversationId === id) { void read(); void readDraft(); } else reload();
    return () => { messageRequest.current++; foregroundMessages.current = false; };
  }, [reload, read, readDraft, initial, id]);
  async function discard() {
    setAssistNote(null);
    try { await serviceCall(scope, "whatsapp.draft.discard", { conversation_id: id }); setDraft(null); }
    catch (e) { setAssistNote(errorText(e, "The draft could not be discarded.")); }
  }
  async function runBrief(guidance: string) {
    if (!assist.brief || briefBusy) return;
    setBriefBusy(true);
    setBriefNote(null);
    try {
      await serviceSlot(scope, "chat.whatsapp.brief", { conversation_id: id, guidance: guidance.trim() });
      setBriefNote({ ok: true, text: zh ? "AI 正在起草回覆，準備好後會直接顯示於輸入欄。" : "Drafting reply… it will appear inline once ready." });
    } catch (e) {
      setBriefNote({ ok: false, text: errorText(e, zh ? "未有要求助理起草。" : "The assistant was not asked (cancelled or refused).") });
    } finally {
      setBriefBusy(false);
    }
  }
  async function runHandoff(kind: "set" | "release") {
    if (handoffBusy) return;
    setHandoffBusy(true);
    setHandoffNote(null);
    try {
      if (kind === "set") await serviceCall(scope, "whatsapp.handoff.set", { conversation_id: id });
      else await serviceSlot(scope, "whatsapp.handoff.release", { conversation_id: id });
      setHandoffNote({ ok: true, text: kind === "set" ? (zh ? "已接手對話，AI 自動回覆已暫停。" : "Taken over. FavCRM AI is paused on this chat.") : (zh ? "已交回 AI 自動回覆。" : "Handed back. FavCRM AI may reply automatically again.") });
    } catch (e) {
      const reason = kind === "release" && declinedReason(e).cancelled ? "cancelled." : errorText(e, "the host refused it.");
      setHandoffNote({ ok: false, text: `${kind === "set" ? "Not taken over" : "Not handed back"}: ${reason}` });
    } finally {
      setHandoffBusy(false);
      void show();
    }
  }
  const autoAdvanceWaiting = useCallback(() => {
    const current = workActionState.current;
    if (!inboxScope || !current.workLink || !current.checked) return;
    if (effectiveThreadState(current.record, current.workLink.inboundVersion) !== "needs_reply") return;
    void saveThreadWork(
      scope,
      current.workLink.ref,
      {
        name: current.record?.name ?? null,
        state: "waiting",
        due: current.record?.due ?? null,
        seenInbound: Math.max(current.record?.seenInbound ?? 0, current.workLink.inboundVersion),
      },
      current.record?.revision ?? null,
    ).then(onWork).catch(() => undefined);
  }, [inboxScope, scope, onWork]);
  // The reply went out: its draft is spent. A failed discard leaves the chip, never a retry loop.
  const onSent = useCallback(() => {
    setUnreadDividerCount(0);
    autoAdvanceWaiting();
    if (assist.discard) void discard();
  }, [assist.discard, scope, id, autoAdvanceWaiting]);
  const refreshThreadQuiet = useCallback(async (): Promise<boolean> => {
    const results = await Promise.all([show(true), read(null, true)]);
    return results[0] && results[1];
  }, [show, read]);
  useOnPush(refreshThreadQuiet);
  useLivePoll({
    enabled: conversation.state === "ok" || messages.state === "ok",
    poll: refreshThreadQuiet,
    intervalMs: LIVE_POLL_MS,
  });
  useEffect(() => {
    return channel.subscribeOutboundEcho(echo => {
      if (echo.conversationId !== id) return;
      if (echo.phase === "pending") {
        setUnreadDividerCount(0);
        keepBottom.current = true;
        setShowLatest(false);
        setNewWhileScrolledUp(0);
        onAtBottomChange(true);
        setOptimistic(prev => [
          ...prev.filter(item => item.tempId !== echo.tempId),
          { tempId: echo.tempId, text: echo.text, mediaKind: echo.mediaKind, fileName: echo.fileName, createdAt: echo.createdAt, status: "pending" },
        ]);
      } else if (echo.phase === "sent") {
        setUnreadDividerCount(0);
        setOptimistic(prev => prev.map(item => item.tempId === echo.tempId ? { ...item, status: "sent" } : item));
        autoAdvanceWaiting();
        void refreshThreadQuiet();
      } else {
        setOptimistic(prev => prev.filter(item => item.tempId !== echo.tempId));
      }
    });
  }, [id, autoAdvanceWaiting, refreshThreadQuiet, onAtBottomChange]);
  const c = conversation.state === "ok" ? conversation.value : null;
  const ordered = useMemo(() => messages.state === "ok"
    ? [...messages.value.rows].sort((a, b) => (stamp(a.createdAt) ?? 0) - (stamp(b.createdAt) ?? 0))
    : [], [messages]);
  const visibleOptimistic = useMemo(() => {
    if (optimistic.length === 0) return [];
    const matchesServer = (opt: OptimisticMessage) => {
      const optTime = Date.parse(opt.createdAt);
      return ordered.some(m => {
        if (m.direction !== "outbound") return false;
        const msgTime = stamp(m.createdAt);
        if (msgTime !== null && Number.isFinite(optTime) && msgTime < optTime - 15_000) return false;
        return opt.text ? (m.body ?? "") === opt.text : m.media !== null || m.type === "unsupported";
      });
    };
    return optimistic.filter(opt => !matchesServer(opt));
  }, [optimistic, ordered]);
  useEffect(() => {
    if (messages.state !== "ok") return;
    const prevIds = seenMessageIds.current;
    const nextIds = new Set(ordered.map(m => m.id));
    if (prevIds === null) {
      seenMessageIds.current = nextIds;
      for (const m of ordered) {
        if (m.direction !== "outbound") {
          const ts = stamp(m.createdAt) ?? 0;
          if (ts > latestInboundStamp.current) latestInboundStamp.current = ts;
        }
      }
      return;
    }
    let addedInbound = 0;
    let maxSeen = latestInboundStamp.current;
    for (const m of ordered) {
      if (m.direction !== "outbound") {
        const ts = stamp(m.createdAt) ?? 0;
        if (!prevIds.has(m.id) && ts >= latestInboundStamp.current) {
          addedInbound++;
        }
        if (ts > maxSeen) maxSeen = ts;
      }
    }
    latestInboundStamp.current = maxSeen;
    seenMessageIds.current = nextIds;
    if (addedInbound > 0 && !keepBottom.current) {
      setNewWhileScrolledUp(n => n + addedInbound);
    }
  }, [messages.state, ordered]);
  useEffect(() => {
    if (optimistic.length === 0) return;
    if (visibleOptimistic.length !== optimistic.length) {
      setOptimistic(visibleOptimistic);
    }
  }, [optimistic.length, visibleOptimistic]);
  const composeId = scope.provider === "linked" && canReply && channel.hostCompose
    && /^[A-Za-z0-9._:-]{1,128}@(s\.whatsapp\.net|lid|g\.us)$/.test(id) ? id : null;
  const replyAvailability = useSyncExternalStore(channel.subscribeReplyAvailability, () => channel.availabilityFor(composeId));
  const replyInset = useSyncExternalStore(channel.subscribeReplyAvailability, () => channel.insetFor(composeId));
  useLayoutEffect(() => {
    if (composeId === null) return;
    channel.nominateConversation(composeId);
    return () => channel.nominateConversation(null);
  }, [composeId]);
  useLayoutEffect(() => {
    const pane = messagePane.current;
    if (!pane) return;
    // Details hides the dock without retiring this nomination. Keep the list
    // extent through the zero inset and re-open so scrollTop cannot clamp.
    if (replyInset === null) {
      pane.removeAttribute("data-reply-overlay");
      pane.style.removeProperty("--waba-reply-dock-height");
    } else if (replyInset.px > 0) {
      pane.setAttribute("data-reply-overlay", "");
      pane.style.setProperty("--waba-reply-dock-height", `${replyInset.px}px`);
    }
  }, [replyInset]);
  useLayoutEffect(() => {
    const pane = timeline.current;
    const anchor = messages.state === "ok" && messages.value.previousAnchor;
    if (pane && anchor && !keepBottom.current && pane.contains(anchor.row)) {
      pane.scrollTop += anchor.row.offsetTop - anchor.top;
    }
  }, [messages]);
  useLayoutEffect(() => {
    const pane = timeline.current;
    if (!pane) return;
    if (keepBottom.current) pane.scrollTop = pane.scrollHeight;
    channel.acknowledgeReplyInset(replyInset);
  }, [messages, visibleOptimistic.length, details, replyInset]);
  useLayoutEffect(() => {
    const pane = messagePane.current;
    if (composeId === null || !channel.hostReplyLayout || !pane) return;
    const measure = () => {
      if (!channel.hostReplyLayout) return;
      if (details || lightboxId !== null || getComputedStyle(pane).visibility === "hidden") {
        channel.publishReplyLayout(null);
        return;
      }
      const width = document.documentElement.clientWidth;
      if (!width) return;
      const rect = pane.getBoundingClientRect();
      const left = Math.max(0, Math.min(10000, Math.round(rect.left / width * 10000)));
      const right = Math.max(0, Math.min(10000, Math.round(rect.right / width * 10000)));
      if (left < right) channel.publishReplyLayout([left, right]);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(document.documentElement);
    window.addEventListener("resize", measure);
    const unsubscribe = channel.subscribeReplyAvailability(() => {
      if (!channel.hostReplyLayout) observer.disconnect();
    });
    return () => {
      unsubscribe();
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [composeId, details, lightboxId]);
  const linked = scope.provider === "linked";
  const headerRow: ConversationRow | null = c ?? (preview?.conversationId === id ? preview : null);
  const phone = headerRow ? contactPhone(headerRow, linked) : null;
  const workLink = inboxScope && headerRow?.work && validWorkRef(headerRow.work.ref, inboxScope) ? headerRow.work : null;
  const record = workLink ? work.records.get(workLink.ref) : undefined;
  workActionState.current = { workLink, record, checked: !!(workLink && work.checked.has(workLink.ref)) };
  const closeWorkMenu = useCallback((returnFocus = false) => {
    setWorkMenuOpen(false);
    if (returnFocus) workPillButton.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!workMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (workMenuWrap.current && !workMenuWrap.current.contains(event.target as Node)) {
        closeWorkMenu(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeWorkMenu(true);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [workMenuOpen, closeWorkMenu]);
  async function setQuickWorkState(nextState: ThreadState) {
    if (!workLink || workBusy) return;
    setWorkBusy(true);
    try {
      const saved = await saveThreadWork(
        scope,
        workLink.ref,
        {
          name: record?.name ?? null,
          state: nextState,
          due: record?.due ?? null,
          seenInbound: Math.max(record?.seenInbound ?? 0, workLink.inboundVersion),
        },
        record?.revision ?? null,
      );
      onWork(saved);
      closeWorkMenu(true);
    } finally {
      setWorkBusy(false);
    }
  }
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuWrap = useRef<HTMLDivElement>(null);
  const moreMenuBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!moreMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (moreMenuWrap.current && !moreMenuWrap.current.contains(event.target as Node)) setMoreMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMoreMenuOpen(false); moreMenuBtn.current?.focus({ preventScroll: true }); }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [moreMenuOpen]);
  const title = headerRow ? contactName(headerRow, phone, linked, zh, record?.name) : (zh ? "對話" : "Conversation");
  const group = linked && id.endsWith("@g.us");
  const subtitle = group ? (zh ? "WhatsApp 群組" : "WhatsApp group") : phone ?? phoneUnavailable(zh);
  const detailsLabel = zh ? (group ? "群組詳情" : "聯絡人詳情") : (group ? "Group details" : "Contact details");
  const identity = phone && phone !== title ? `${title}${zh ? "、" : ", "}${phone}` : title;
  const mediaMessages = details ? ordered.filter(m => m.media !== null || m.previewJpeg !== null) : [];
  const visualMedia = hostMediaDownload
    ? ordered.filter(m => m.media?.available && (m.media.kind === "image" || m.media.kind === "video"))
    : [];
  const lightboxMessage = lightboxId ? ordered.find(m => m.id === lightboxId) ?? null : null;
  const locale = zh ? "zh" : "en";
  const day = dayFormat[locale], time = timeFormat[locale];
  const dueDay = calendarDay(new Date());
  const loadOlder = (cursor: string) => {
    if (foregroundMessages.current) return;
    void read(cursor);
  };
  return <article className="waba-conversation" aria-labelledby="waba-thread-title" onKeyDown={e => {
    if (e.key === "Escape" && !e.defaultPrevented && lightboxId !== null) {
      e.preventDefault();
      setLightboxId(null);
    }
  }}>
    <header className="waba-thread-head">
      <Button size="sm" variant="ghost" className="waba-back" disabled={replyDirty} onClick={onBack}>{focusedMode ? (zh ? "收件匣" : "Inbox") : (zh ? "返回" : "Back")}</Button>
      <h2 id="waba-thread-title" tabIndex={-1}>
        {headerRow ? <button className="waba-details-trigger" ref={detailsButton} type="button" disabled={!c} aria-haspopup="dialog" aria-expanded={details} aria-label={`${identity}${zh ? "：" : ": "}${detailsLabel}`} onClick={() => details ? closeDetails() : setDetails(true)}>
          <Avatar name={title} phone={phone} group={group} />
          <span className="waba-thread-identity"><span className="waba-thread-title">{title === phone ? <bdi dir="ltr">{phone}</bdi> : title}</span>{subtitle !== title && <small className="waba-muted">{phone ? <bdi dir="ltr">{phone}</bdi> : subtitle}</small>}</span>
        </button> : title}
      </h2>
      {c?.handoffAt && <span className="waba-handoff-pill" title={`${zh ? "人工接手於" : "Taken over since"} ${when(c.handoffAt)}`}>
        <span className="waba-work-dot" aria-hidden="true" />
        <span>{zh ? "人工接手" : "AI paused"}</span>
      </span>}
      {workLink && work.checked.has(workLink.ref) && (() => {
        const currentState = effectiveThreadState(record, workLink.inboundVersion);
        const states: readonly ThreadState[] = ["needs_reply", "waiting", "done"];
        return <div ref={workMenuWrap} className="waba-work-menu-wrap">
          <button
            ref={workPillButton}
            type="button"
            className="waba-work-pill"
            disabled={!c || workBusy}
            data-state={currentState}
            aria-haspopup="menu"
            aria-expanded={workMenuOpen}
            onClick={() => setWorkMenuOpen(openNow => !openNow)}
          >
            <span className="waba-work-dot" aria-hidden="true" />
            <span>{threadStateLabel(currentState, zh)}</span>
          </button>
          {workMenuOpen && <div className="waba-work-menu" role="menu" aria-label={zh ? "對話狀態" : "Conversation status"}>
            {states.map(option => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={currentState === option}
                className="waba-work-menu-item"
                disabled={workBusy}
                onClick={() => { void setQuickWorkState(option); }}
              >
                <span>{threadStateLabel(option, zh)}</span>
                {currentState === option && <span className="waba-work-menu-check" aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>}
        </div>;
      })()}
      <div className="waba-thread-head-actions">
        {headerRow && <button
          type="button"
          className="waba-head-ico-btn"
          disabled={!c}
          aria-pressed={details}
          aria-label={detailsLabel}
          title={detailsLabel}
          onClick={() => details ? closeDetails() : setDetails(true)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7.5 3v10m-4-10h9A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3Z" /></svg>
        </button>}
        <div ref={moreMenuWrap} className="waba-work-menu-wrap">
          <button
            ref={moreMenuBtn}
            type="button"
            className="waba-head-ico-btn"
            aria-haspopup="menu"
            aria-expanded={moreMenuOpen}
            aria-label={zh ? "更多對話操作" : "More conversation actions"}
            title={zh ? "更多操作" : "More actions"}
            onClick={() => setMoreMenuOpen(openNow => !openNow)}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>
          </button>
          {moreMenuOpen && <div className="waba-work-menu" role="menu" aria-label={zh ? "對話操作" : "Conversation actions"}>
            {c && !linked && (c.handoffAt ? handoff.release : handoff.set) && (
              <button
                type="button"
                role="menuitem"
                className="waba-work-menu-item"
                disabled={handoffBusy}
                onClick={() => {
                  setMoreMenuOpen(false);
                  void runHandoff(c.handoffAt ? "release" : "set");
                }}
              >
                {c.handoffAt ? (zh ? "交回 AI 自動回覆…" : "Hand back to AI…") : (zh ? "人工接手對話" : "Take over conversation")}
              </button>
            )}
            {assist.open && (
              <button
                type="button"
                role="menuitem"
                className="waba-work-menu-item"
                onClick={() => {
                  setMoreMenuOpen(false);
                  void serviceCall(scope, "chat.whatsapp.open", { conversation_id: id }).catch(() => undefined);
                }}
              >
                {zh ? "在助理中開啟" : "Open in assistant"}
              </button>
            )}
            {channel.hostUx && (
              <button
                type="button"
                role="menuitem"
                className="waba-work-menu-item"
                onClick={() => {
                  onMarkUnread(id);
                  setMoreMenuOpen(false);
                }}
              >
                {zh ? "標記為未讀" : "Mark as unread"}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="waba-work-menu-item"
              onClick={() => {
                setMoreMenuOpen(false);
                setDetails(true);
              }}
            >
              {`${detailsLabel}…`}
            </button>
          </div>}
        </div>
      </div>
    </header>
    {handoffNote && <div className="waba-reply-availability" role={handoffNote.ok ? "status" : "alert"}>
      {handoffNote.ok
        ? <Notice state="taken-over">{handoffNote.text} <Button size="sm" variant="ghost" onClick={() => setHandoffNote(null)}>{zh ? "關閉" : "Dismiss"}</Button></Notice>
        : <ErrorNotice bare>{handoffNote.text} <Button size="sm" variant="ghost" onClick={() => setHandoffNote(null)}>{zh ? "關閉" : "Dismiss"}</Button></ErrorNotice>}
    </div>}
    <div className="waba-conversation-body">
      <div className="waba-thread-main" ref={messagePane}>
        {replyAvailability === "blocked" && <div className="waba-reply-availability" role="status">
          <Notice state="blocked">
            {zh ? "此對話暫時無法回覆，你仍可查看訊息。" : "Replies are unavailable for this chat. You can still read messages."}
          </Notice>
        </div>}
        <div className="waba-history">
          <div className="waba-timeline" tabIndex={0} role="region" aria-label={zh ? "訊息記錄" : "Message history"} ref={timeline} onKeyDown={e => {
            // Native Home/End scroll animations can continue after Jump to latest.
            if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "Home" && e.key !== "End")) return;
            e.preventDefault();
            if (e.key === "End") jumpToLatest();
            else e.currentTarget.scrollTo({ top: 0, behavior: "instant" });
          }} onScroll={e => {
            const pane = e.currentTarget, last = timelineScroll.current;
            const top = pane.scrollTop, height = pane.clientHeight;
            // A dock resize can clamp scrollTop and dispatch scroll before ResizeObserver.
            // Only movement in the settled viewport changes whether the reader follows latest.
            if (height !== last.height || pane.clientWidth !== last.width || top === last.top) return;
            last.top = top;
            keepBottom.current = pane.scrollHeight - top - height < 72;
            setShowLatest(!keepBottom.current);
            onAtBottomChange(keepBottom.current);
            if (keepBottom.current) {
              setNewWhileScrolledUp(0);
              onAutoClearUnread(id);
            }
          }}>
            <div className="waba-timeline-inner">
              {conversation.state === "failed" && <ErrorNotice onRetry={() => { void show(); }}>{conversation.text}</ErrorNotice>}
              {messages.state === "loading" ? <ThreadSkeleton indexing={indexing} zh={zh} />
                : messages.state === "failed" ? <ErrorNotice onRetry={() => { void read(); }}>{messages.text}</ErrorNotice>
                : <>
                  {messages.value.cursor && <div className="waba-history-more"><Button size="sm" loading={loadingOlder || indexing} onClick={() => loadOlder(messages.value.cursor!)}>{zh ? "載入較早訊息" : "Load older messages"}</Button></div>}
                  {!ordered.length && !visibleOptimistic.length ? <EmptyState title={zh ? "沒有訊息" : "No messages"} name="messages" /> : <ol className="waba-messages" aria-label="Messages">{(() => {
                    let unreadDividerId: string | null = null;
                    if (unreadDividerCount > 0 && ordered.length > 0) {
                      let remaining = unreadDividerCount;
                      for (let i = ordered.length - 1; i >= 0; i--) {
                        if (ordered[i].direction !== "outbound") {
                          remaining--;
                          if (remaining === 0) {
                            unreadDividerId = ordered[i].id;
                            break;
                          }
                        }
                      }
                    }
                    return ordered.map((m, index) => {
                      const at = stamp(m.createdAt), previous = stamp(ordered[index - 1]?.createdAt ?? null);
                      const date = at === null ? null : day.format(at);
                      return <Fragment key={m.id}>
                        {date && (previous === null || day.format(previous) !== date) && <li className="waba-date">{date}</li>}
                        {unreadDividerId === m.id && <li className="waba-unread-divider" role="separator"><span>{zh ? `${unreadDividerCount} 則未讀訊息` : `${unreadDividerCount} unread message${unreadDividerCount === 1 ? "" : "s"}`}</span></li>}
                        <li className="waba-message" data-direction={m.direction === "outbound" ? "outbound" : "inbound"}>
                          {m.media || (scope.provider === "linked" && m.type === "unsupported")
                            ? m.media
                              ? <LinkedMediaMessage
                                  conversationId={id}
                                  provider={mediaProvider}
                                  message={m}
                                  media={m.media}
                                  loaded={loadedMedia.get(m.id) ?? null}
                                  canDownload={hostMediaDownload}
                                  zh={zh}
                                  unavailable={unavailablePreview}
                                  onLoadInline={loadInlineMedia}
                                  onOpenLightbox={() => setLightboxId(m.id)}
                                />
                              : m.previewJpeg
                                ? <PhotoPreview key={m.previewJpeg} jpeg={m.previewJpeg} label={zh ? "相片預覽" : "Photo preview"} unavailable={unavailablePreview} />
                                : <p className="waba-muted">{unavailablePreview}</p>
                            : <p>{m.body ?? (m.type ? `[${m.type}]` : "")}</p>}
                          {(at !== null || (m.direction === "outbound" && !!m.status)) && <div className="waba-message-meta waba-muted">{at !== null && <time dateTime={m.createdAt!}>{time.format(at)}</time>}{m.direction === "outbound" && m.status ? <MessageStatusTick status={m.status} zh={zh} /> : null}</div>}
                        </li>
                      </Fragment>;
                    });
                  })()}{visibleOptimistic.map(opt => {
                    const optAt = stamp(opt.createdAt);
                    const optBody = opt.text || (opt.mediaKind === "image" ? `📷 ${zh ? "相片" : "Photo"}` : opt.mediaKind === "video" ? `🎥 ${zh ? "影片" : "Video"}` : opt.mediaKind === "audio" ? `🎤 ${zh ? "語音訊息" : "Voice message"}` : opt.mediaKind === "document" ? `📄 ${opt.fileName || (zh ? "文件" : "Document")}` : "");
                    return <li key={opt.tempId} className="waba-message" data-direction="outbound" data-optimistic="yes">
                      <p>{optBody}</p>
                      <div className="waba-message-meta waba-muted">
                        {optAt !== null && <time dateTime={opt.createdAt}>{time.format(optAt)}</time>}
                        <MessageStatusTick status={opt.status} zh={zh} />
                      </div>
                    </li>;
                  })}</ol>}
              </>}
            </div>
          </div>
          {(showLatest || newWhileScrolledUp > 0) && <div className="waba-jump" data-has-new={newWhileScrolledUp > 0 ? "yes" : undefined}><Button size="sm" onClick={jumpToLatest}>{newWhileScrolledUp > 0 ? (zh ? `↓ ${newWhileScrolledUp} 則新訊息` : `↓ ${newWhileScrolledUp} new message${newWhileScrolledUp === 1 ? "" : "s"}`) : (zh ? "跳至最新訊息" : "Jump to latest")}</Button></div>}
        </div>
        {/* The admitted linked composer is on the board. Official actions and
            the local-composer/read-only footer stay on their existing path. */}
        {c && composeId !== null && draft && <div className="waba-draft-dock">
          <DraftChip
            draft={draft}
            zh={zh}
            canInsert={false}
            canDiscard={assist.discard}
            note={assistNote}
            onInsert={() => {}}
            onCopy={typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function"
              ? () => navigator.clipboard.writeText(draft.text)
              : undefined}
            onDiscard={() => { void discard(); }}
          />
        </div>}
        {c && composeId === null && <footer className="waba-thread-footer">
          {canReply ? !(linked && channel.hostCompose) && <Composer
            scope={scope}
            conversationId={c.conversationId}
            handoffAt={c.handoffAt}
            freeformUntil={c.freeformUntil}
            open={scope.provider === "linked" || windowOpen(c)}
            autoTakeover={handoff.set}
            inserted={null}
            draft={draft}
            canDiscardDraft={assist.discard}
            onDiscardDraft={() => { void discard(); }}
            canBrief={assist.brief}
            briefBusy={briefBusy}
            briefNote={briefNote}
            assistNote={assistNote}
            onBrief={runBrief}
            onDismissBriefNote={() => setBriefNote(null)}
            canTemplate={canTemplate}
            onOpenTemplate={() => onRecipient(c)}
            replyDirty={replyDirty}
            onSent={onSent}
            onChanged={reload}
            onDirtyChange={onReplyDirty}
          />
            : <Notice state="read-only">{zh ? "你可以閱讀此收件匣。只有工作區擁有人可以回覆。" : "You can read this inbox. Only the workspace operator can reply."}</Notice>}
          {!canReply && canTemplate && <Button size="sm" disabled={replyDirty} onClick={() => onRecipient(c)}>{zh ? "使用已核准的範本…" : "Send an approved template…"}</Button>}
        </footer>}
      </div>
    </div>
    {details && c && <ContactDrawer
      key={workLink?.ref ?? id}
      scope={scope}
      conversation={c}
      conversationId={id}
      workLink={workLink}
      title={title}
      subtitle={subtitle}
      phone={phone}
      group={group}
      zh={zh}
      avatar={<Avatar name={title} phone={phone} group={group} />}
      mediaMessages={mediaMessages}
      loadedMedia={loadedMedia}
      hostMediaDownload={hostMediaDownload}
      unavailablePreview={unavailablePreview}
      dueDay={dueDay}
      onSaved={onWork}
      onDirty={onWorkDirty}
      onLoadInline={loadInlineMedia}
      onOpenLightbox={messageId => setLightboxId(messageId)}
      onClose={closeDetails}
    />}
    {lightboxMessage?.media && <MediaLightbox
      conversationId={id}
      provider={mediaProvider}
      message={lightboxMessage}
      media={lightboxMessage.media}
      items={visualMedia}
      loaded={loadedMedia.get(lightboxMessage.id) ?? null}
      loadedMedia={loadedMedia}
      zh={zh}
      unavailable={unavailablePreview}
      closeRef={closeLightboxButton}
      onLoadInline={loadInlineMedia}
      onSelect={messageId => setLightboxId(messageId)}
      onClose={() => setLightboxId(null)}
    />}
  </article>;
}

function PhotoPreview({ jpeg, label, unavailable, className }: { jpeg: string; label: string; unavailable: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="waba-muted">{unavailable}</p>
    : <img className={className ?? "waba-photo-preview"} src={`data:image/jpeg;base64,${jpeg}`} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function MessageStatusTick({ status, zh }: { status: string; zh: boolean }) {
  const normalized = status.trim().toLowerCase();
  if (normalized === "pending" || normalized === "queued" || normalized === "sending" || normalized === "dispatching") {
    const label = zh ? "傳送中" : "Sending";
    return <span className="waba-tick" data-state="pending" role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.2" />
      </svg>
    </span>;
  }
  if (normalized === "sent" || normalized === "accepted") {
    const label = zh ? "已傳送" : "Sent";
    return <span className="waba-tick" data-state="sent" role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 16 11" width="14" height="10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3.5 6.2 6.5 9.2 13 2.3" />
      </svg>
    </span>;
  }
  if (normalized === "delivered" || normalized === "read" || normalized === "played") {
    const read = normalized === "read" || normalized === "played";
    const label = read ? (zh ? "已讀" : "Read") : (zh ? "已送達" : "Delivered");
    return <span className="waba-tick" data-state={read ? "read" : "delivered"} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 18 11" width="16" height="10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M1.8 6.2 4.6 9.1 10.8 2.3" />
        <path d="M6.6 6.2 9.4 9.1 15.6 2.3" />
      </svg>
    </span>;
  }
  if (normalized === "failed") {
    const label = zh ? "傳送失敗" : "Failed";
    return <span className="waba-tick" data-state="failed" role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3.5" />
        <circle cx="8" cy="11" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    </span>;
  }
  return null;
}

function voiceWaveformHeights(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return Array.from({ length: 24 }, (_, idx) => {
    h = Math.imul(h ^ (idx + 17), 16777619);
    return 24 + (Math.abs(h) % 72);
  });
}

function unavailableReasonText(reason: LinkedMediaInfo["unavailableReason"], zh: boolean): string {
  if (reason === "too_large") return zh ? "檔案超過 10 MB 下載限制。" : "Attachment exceeds the 10 MB limit.";
  if (reason === "unsupported_type") return zh ? "不支援此媒體格式。" : "Unsupported media format.";
  return zh ? "此訊息無法提供媒體下載。" : "Media is unavailable for this message.";
}

function LinkedMediaMessage({
  conversationId,
  provider,
  message,
  media,
  loaded,
  canDownload,
  zh,
  unavailable,
  onLoadInline,
  onOpenLightbox,
}: {
  conversationId: string;
  provider: "linked" | "official";
  message: Message;
  media: LinkedMediaInfo;
  loaded: { url: string; mimeType: string; fileName: string | null } | null;
  canDownload: boolean;
  zh: boolean;
  unavailable: string;
  onLoadInline: (messageId: string, priority?: "user" | "auto") => Promise<{ url: string; mimeType: string; fileName: string | null }>;
  onOpenLightbox: () => void;
}) {
  const [loadingInline, setLoadingInline] = useState(false);
  const [autoFailed, setAutoFailed] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const autoTriedRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingAudioPlay = useRef(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(media.durationSeconds ?? 0);

  useEffect(() => {
    setAutoFailed(false);
  }, [message.id]);

  useEffect(() => {
    setAudioDuration(media.durationSeconds ?? 0);
  }, [media.durationSeconds]);

  useEffect(() => {
    if (
      media.kind !== "image" ||
      !media.available ||
      !canDownload ||
      loaded?.url ||
      autoTriedRef.current === message.id
    )
      return;
    autoTriedRef.current = message.id;
    void onLoadInline(message.id, "auto").catch(() => {
      setAutoFailed(true);
    });
  }, [
    canDownload,
    loaded?.url,
    media.available,
    media.kind,
    message.id,
    onLoadInline,
  ]);

  useEffect(() => {
    if (loaded?.url && pendingAudioPlay.current && audioRef.current) {
      pendingAudioPlay.current = false;
      void audioRef.current.play().catch(() => undefined);
    }
  }, [loaded?.url]);

  const label = media.fileName ?? mediaKindLabel(media, zh);
  const summary = mediaMetaSummary(media);

  async function toggleAudio() {
    if (loaded?.url && audioRef.current) {
      if (audioRef.current.paused) void audioRef.current.play().catch(() => undefined);
      else audioRef.current.pause();
      return;
    }
    if (loadingInline) return;
    pendingAudioPlay.current = true;
    setLoadingInline(true);
    setInlineError(null);
    try {
      await onLoadInline(message.id, "user");
    } catch (e) {
      pendingAudioPlay.current = false;
      setInlineError(errorText(e, zh ? "無法載入音訊。" : "Couldn’t load audio."));
    } finally {
      setLoadingInline(false);
    }
  }

  async function saveFile() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await channel.saveMedia(conversationId, message.id, provider);
      setSavedName(saved.fileName);
    } catch (e) {
      setSaveError(errorText(e, zh ? "無法下載檔案。" : "Couldn’t save attachment."));
    } finally {
      setSaving(false);
    }
  }

  const caption = media.caption ? <p className="waba-media-caption">{media.caption}</p> : null;
  const saveIcon = saving
    ? <span className="waba-inline-spin" aria-hidden="true" />
    : savedName
    ? <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7" /></svg>
    : <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14" /></svg>;

  if (!media.available) {
    return <div className="waba-media-card">
      {message.previewJpeg && <PhotoPreview key={message.previewJpeg} jpeg={message.previewJpeg} label={label} unavailable={unavailable} />}
      <div className="waba-media-tile">
        <span className="waba-media-badge">{mediaBadge(media)}</span>
        <span className="waba-media-info">
          <span className="waba-media-title">{label}</span>
          {summary && <span className="waba-media-sub">{summary}</span>}
        </span>
      </div>
      <p className="waba-muted">{unavailableReasonText(media.unavailableReason, zh)}</p>
      {caption}
    </div>;
  }

  if (!canDownload) {
    return <div className="waba-media-card">
      {message.previewJpeg
        ? <PhotoPreview key={message.previewJpeg} jpeg={message.previewJpeg} label={label} unavailable={unavailable} />
        : <div className="waba-media-tile">
            <span className="waba-media-badge">{mediaBadge(media)}</span>
            <span className="waba-media-info">
              <span className="waba-media-title">{label}</span>
              {summary && <span className="waba-media-sub">{summary}</span>}
            </span>
          </div>}
      <p className="waba-muted">{zh ? "更新 Cadence 主機板即可檢視或下載完整媒體。" : "Update the Cadence board to view or save full media."}</p>
      {caption}
    </div>;
  }

  if (media.kind === "image") {
    const ratio = mediaAspectRatio(media);
    return <div className="waba-media-card">
      <div className="waba-media-frame-wrap">
        <button type="button" className="waba-media-frame" style={{ aspectRatio: String(ratio) }} aria-label={media.fileName ? `${zh ? "檢視圖片" : "View image"}: ${media.fileName}` : (zh ? "檢視完整圖片" : "View full image")} onClick={onOpenLightbox}>
          {loaded?.url
            ? <img className="waba-media-img" src={loaded.url} alt={label} loading="lazy" decoding="async" />
            : message.previewJpeg
            ? <PhotoPreview className="waba-media-img waba-media-blur" key={message.previewJpeg} jpeg={message.previewJpeg} label={label} unavailable={unavailable} />
            : !autoFailed
            ? <span className="waba-media-shimmer" aria-hidden="true" />
            : <span className="waba-media-tile">
                <span className="waba-media-badge">IMG</span>
                <span className="waba-media-info">
                  <span className="waba-media-title">{label}</span>
                  {summary && <span className="waba-media-sub">{summary}</span>}
                </span>
              </span>}
          <span className="waba-media-hover-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6" /></svg>
          </span>
        </button>
      </div>
      {caption}
    </div>;
  }

  if (media.kind === "audio") {
    const bars = voiceWaveformHeights(message.id);
    const totalDur = audioDuration > 0 ? audioDuration : (media.durationSeconds ?? 0);
    const ratio = totalDur > 0 ? Math.max(0, Math.min(1, audioTime / totalDur)) : 0;
    const totalLabel = formatMediaDuration(totalDur);
    const elapsedLabel = formatMediaDuration(audioTime);
    const timeText = (audioPlaying || audioTime > 0) && totalLabel
      ? `${elapsedLabel ?? "0:00"} / ${totalLabel}`
      : totalLabel ?? mediaKindLabel(media, zh);
    const byteText = formatMediaBytes(media.byteLength);
    return <div className="waba-media-card">
      {loaded?.url && <audio
        ref={audioRef}
        className="waba-media-audio-hidden"
        preload="metadata"
        src={loaded.url}
        onLoadedMetadata={e => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setAudioDuration(d);
        }}
        onTimeUpdate={e => setAudioTime(e.currentTarget.currentTime)}
        onPlay={() => setAudioPlaying(true)}
        onPause={() => setAudioPlaying(false)}
        onEnded={() => {
          setAudioPlaying(false);
          setAudioTime(0);
        }}
      />}
      <div className="waba-voice-card">
        <button
          type="button"
          className="waba-voice-play-btn"
          aria-label={audioPlaying ? (zh ? "暫停音訊" : "Pause audio") : (zh ? "播放音訊" : "Play audio")}
          disabled={loadingInline}
          aria-busy={loadingInline || undefined}
          onClick={() => { void toggleAudio(); }}
        >
          {loadingInline
            ? <span className="waba-inline-spin" aria-hidden="true" />
            : audioPlaying
            ? <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="7" y="5.5" width="3.5" height="13" rx="1" /><rect x="13.5" y="5.5" width="3.5" height="13" rx="1" /></svg>
            : <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="m8 5.5 11 6.5-11 6.5Z" /></svg>}
        </button>
        <div className="waba-voice-col">
          <div
            className="waba-voice-bars"
            data-ready={loaded?.url ? "true" : "false"}
            aria-hidden="true"
            onClick={e => {
              if (!audioRef.current || !loaded?.url || totalDur <= 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              if (rect.width <= 0) return;
              const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              audioRef.current.currentTime = frac * totalDur;
              setAudioTime(frac * totalDur);
            }}
          >
            {bars.map((h, i) => (
              <span
                key={i}
                className="waba-voice-bar"
                data-played={(i / bars.length) < ratio ? "true" : undefined}
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <div className="waba-voice-foot">
            <span>{timeText}</span>
            {byteText && <span>{byteText}</span>}
          </div>
        </div>
        <button
          type="button"
          className="waba-media-icon-btn"
          data-saved={savedName ? "true" : undefined}
          aria-label={savedName ? (zh ? `已儲存 ${savedName}` : `Saved ${savedName}`) : (zh ? "下載音訊" : "Save audio")}
          title={savedName ? (zh ? `已儲存 ${savedName}` : `Saved ${savedName}`) : (zh ? "下載" : "Save")}
          disabled={saving}
          aria-busy={saving || undefined}
          onClick={() => { void saveFile(); }}
        >
          {saveIcon}
        </button>
      </div>
      {inlineError && <ErrorNotice bare>{inlineError}</ErrorNotice>}
      {saveError && <ErrorNotice bare>{saveError}</ErrorNotice>}
      {caption}
    </div>;
  }

  if (media.kind === "video") {
    const ratio = mediaAspectRatio(media);
    const dur = formatMediaDuration(media.durationSeconds);
    return <div className="waba-media-card">
      <div className="waba-media-frame-wrap">
        <button type="button" className="waba-media-frame" style={{ aspectRatio: String(ratio) }} aria-label={media.fileName ? `${zh ? "播放影片" : "Play video"}: ${media.fileName}` : (zh ? "播放影片" : "Play video")} onClick={onOpenLightbox}>
          {message.previewJpeg
            ? <PhotoPreview className="waba-media-img" key={message.previewJpeg} jpeg={message.previewJpeg} label={label} unavailable={unavailable} />
            : <span className="waba-video-poster-fallback" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="5" width="18" height="14" rx="2" /></svg>
              </span>}
          <span className="waba-video-play-ring" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style={{ marginLeft: "2px" }}><path d="m8 5.5 11 6.5-11 6.5Z" /></svg>
          </span>
          {dur && <span className="waba-video-dur-pill">{dur}</span>}
        </button>
        <button
          type="button"
          className="waba-media-save-corner"
          data-saved={savedName ? "true" : undefined}
          aria-label={savedName ? (zh ? `已儲存 ${savedName}` : `Saved ${savedName}`) : (zh ? "下載影片" : "Save video")}
          title={savedName ? (zh ? `已儲存 ${savedName}` : `Saved ${savedName}`) : (zh ? "下載" : "Save")}
          disabled={saving}
          aria-busy={saving || undefined}
          onClick={e => {
            e.stopPropagation();
            void saveFile();
          }}
        >
          {saveIcon}
        </button>
      </div>
      {saveError && <ErrorNotice bare>{saveError}</ErrorNotice>}
      {caption}
    </div>;
  }

  const docMeta = [formatMediaBytes(media.byteLength), mediaBadge(media)].filter(Boolean).join(" · ");
  const canPreviewPdf = isPdfMedia(media) && media.available && channel.hostPdfPreview;
  const docContent = <>
    <span className="waba-doc-badge" data-ext={mediaExtTone(media)}>{mediaBadge(media)}</span>
    <span className="waba-doc-meta">
      <span className="waba-doc-name" title={label}>{label}</span>
      {docMeta && <span className="waba-doc-sub">{docMeta}</span>}
    </span>
  </>;
  return <div className="waba-media-card">
    <div className="waba-doc-card">
      {canPreviewPdf ? (
        <button
          type="button"
          className="waba-doc-open"
          aria-label={zh ? `檢視 PDF：${label}` : `Preview PDF: ${label}`}
          onClick={() => channel.previewPdf(conversationId, message.id, provider)}
        >
          {docContent}
        </button>
      ) : docContent}
      <button
        type="button"
        className="waba-media-icon-btn"
        data-saved={savedName ? "true" : undefined}
        aria-label={savedName ? (zh ? `已下載 ${savedName}` : `Saved ${savedName}`) : saveError ? (zh ? "重試下載" : "Retry download") : (zh ? `下載 ${label}` : `Download ${label}`)}
        title={savedName ? (zh ? `已下載 ${savedName}` : `Saved ${savedName}`) : (zh ? "下載" : "Download")}
        disabled={saving}
        aria-busy={saving || undefined}
        onClick={() => { void saveFile(); }}
      >
        {saveIcon}
      </button>
    </div>
    {saveError && <ErrorNotice bare>{saveError}</ErrorNotice>}
    {caption}
  </div>;
}

function MediaLightbox({
  conversationId,
  provider,
  message,
  media,
  items,
  loaded,
  loadedMedia,
  zh,
  unavailable,
  closeRef,
  onLoadInline,
  onSelect,
  onClose,
}: {
  conversationId: string;
  provider: "linked" | "official";
  message: Message;
  media: LinkedMediaInfo;
  items: Message[];
  loaded: { url: string; mimeType: string; fileName: string | null } | null;
  loadedMedia: Map<string, { url: string; mimeType: string; fileName: string | null }>;
  zh: boolean;
  unavailable: string;
  closeRef: RefObject<HTMLButtonElement | null>;
  onLoadInline: (messageId: string, priority?: "user" | "auto") => Promise<{ url: string; mimeType: string; fileName: string | null }>;
  onSelect: (messageId: string) => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(!loaded?.url);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const idx = items.findIndex(m => m.id === message.id);
  const prevItem = idx > 0 ? items[idx - 1] : null;
  const nextItem = idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null;

  useEffect(() => {
    setZoomed(false);
    setSavedName(null);
    setSaveError(null);
    setLoadError(null);
  }, [message.id]);

  const retryLoad = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void onLoadInline(message.id, "user").then(
      () => setLoading(false),
      (e: unknown) => {
        setLoadError(errorText(e, media.kind === "video" ? (zh ? "無法載入影片。" : "Couldn’t load video.") : (zh ? "無法載入完整相片。" : "Couldn’t load full photo.")));
        setLoading(false);
      },
    );
  }, [media.kind, message.id, onLoadInline, zh]);

  useEffect(() => {
    if (!loaded?.url) retryLoad();
    else setLoading(false);
  }, [loaded?.url, retryLoad]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft" && prevItem) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onSelect(prevItem.id);
        return;
      }
      if (e.key === "ArrowRight" && nextItem) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onSelect(nextItem.id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [nextItem, onClose, onSelect, prevItem]);

  async function saveImage() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await channel.saveMedia(conversationId, message.id, provider);
      setSavedName(res.fileName);
    } catch (e) {
      setSaveError(errorText(e, zh ? "無法下載媒體。" : "Couldn’t save media."));
    } finally {
      setSaving(false);
    }
  }

  const title = media.fileName ?? mediaKindLabel(media, zh);
  const summary = mediaMetaSummary(media);
  const poster = message.previewJpeg ? `data:image/jpeg;base64,${message.previewJpeg}` : undefined;
  return <div className="waba-lightbox-backdrop" role="dialog" aria-modal="true" aria-labelledby="waba-lightbox-title" onClick={e => {
    if (e.target === e.currentTarget) onClose();
  }} onKeyDown={e => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }}>
    <header className="waba-lightbox-bar">
      <div className="waba-lightbox-file">
        <h3 id="waba-lightbox-title">{title}</h3>
        {summary && <p>{summary}</p>}
      </div>
      {items.length > 1 && idx >= 0
        ? <span className="waba-lightbox-counter">{idx + 1} / {items.length}</span>
        : <span aria-hidden="true" />}
      <div className="waba-lightbox-actions">
        {media.kind === "image" && loaded?.url && (
          <button type="button" className="waba-lightbox-ico-btn" onClick={() => setZoomed(z => !z)}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 5 5M8.5 10.5h4" />{!zoomed && <path d="M10.5 8.5v4" />}</svg>
            <span className="waba-lightbox-ico-label">{zoomed ? (zh ? "還原" : "Fit") : (zh ? "放大" : "Zoom")}</span>
          </button>
        )}
        <button
          type="button"
          className="waba-lightbox-ico-btn"
          data-saved={savedName ? "true" : undefined}
          disabled={saving}
          aria-busy={saving || undefined}
          onClick={() => { void saveImage(); }}
        >
          {saving
            ? <span className="waba-inline-spin" aria-hidden="true" />
            : savedName
            ? <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7" /></svg>
            : <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14" /></svg>}
          <span className="waba-lightbox-ico-label">{savedName ? (zh ? "已儲存" : "Saved") : (zh ? "下載" : "Save")}</span>
        </button>
        <button ref={closeRef} type="button" className="waba-lightbox-ico-btn" aria-label={zh ? "關閉" : "Close"} onClick={onClose}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
    </header>
    <div className="waba-lightbox-stage" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      {items.length > 1 && (
        <button
          type="button"
          className="waba-lightbox-nav"
          data-dir="prev"
          disabled={!prevItem}
          aria-label={zh ? "上一個媒體" : "Previous media"}
          onClick={() => { if (prevItem) onSelect(prevItem.id); }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        </button>
      )}
      <div className="waba-lightbox-media-wrap">
        {media.kind === "video"
          ? loaded?.url
            ? <video key={loaded.url} className="waba-lightbox-video" controls playsInline autoPlay poster={poster} src={loaded.url} />
            : message.previewJpeg
            ? <PhotoPreview className="waba-lightbox-poster" jpeg={message.previewJpeg} label={title} unavailable={unavailable} />
            : null
          : loaded?.url
          ? <img className="waba-lightbox-img" src={loaded.url} alt={title} data-zoomed={zoomed ? "true" : undefined} onClick={() => setZoomed(z => !z)} />
          : message.previewJpeg
          ? <PhotoPreview className="waba-lightbox-img" key={message.previewJpeg} jpeg={message.previewJpeg} label={title} unavailable={unavailable} />
          : null}
        {loading && <div className="waba-lightbox-loading-pill" role="status">
          <span className="waba-inline-spin" aria-hidden="true" />
          <span>{media.kind === "video" ? (zh ? "正在載入影片…" : "Loading video…") : (zh ? "正在載入完整相片…" : "Loading full image…")}</span>
        </div>}
        {loadError && <ErrorNotice onRetry={retryLoad}>{loadError}</ErrorNotice>}
      </div>
      {items.length > 1 && (
        <button
          type="button"
          className="waba-lightbox-nav"
          data-dir="next"
          disabled={!nextItem}
          aria-label={zh ? "下一個媒體" : "Next media"}
          onClick={() => { if (nextItem) onSelect(nextItem.id); }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      )}
    </div>
    <footer className="waba-lightbox-foot">
      {media.caption && <p className="waba-media-caption">{media.caption}</p>}
      {savedName && <p className="waba-muted" role="status">{zh ? `已儲存 ${savedName}` : `Saved ${savedName}`}</p>}
      {saveError && <ErrorNotice bare>{saveError}</ErrorNotice>}
      {items.length > 1 && <div className="waba-lightbox-thumbs">
        {items.map(item => {
          const itemLoaded = loadedMedia.get(item.id);
          const itemThumbSrc = (item.media?.kind !== "video" && itemLoaded?.url && itemLoaded.mimeType.toLowerCase().startsWith("image/") ? itemLoaded.url : null)
            ?? (item.previewJpeg ? `data:image/jpeg;base64,${item.previewJpeg}` : null);
          return (
            <button
              key={item.id}
              type="button"
              className="waba-lightbox-thumb"
              aria-current={item.id === message.id ? "true" : undefined}
              aria-label={item.media?.fileName ?? (item.media ? mediaKindLabel(item.media, zh) : (zh ? "媒體" : "Media"))}
              onClick={() => onSelect(item.id)}
            >
              {itemThumbSrc
                ? <img src={itemThumbSrc} alt="" loading="lazy" decoding="async" />
                : <span className="waba-lightbox-thumb-fallback">{item.media ? mediaBadge(item.media) : "IMG"}</span>}
              {item.media?.kind === "video" && <span className="waba-lightbox-thumb-play" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="8" height="8" fill="currentColor"><path d="m8 5.5 11 6.5-11 6.5Z" /></svg>
              </span>}
            </button>
          );
        })}
      </div>}
    </footer>
  </div>;
}

function DraftChip({ draft, zh, canInsert, canDiscard, note, onInsert, onCopy, onDiscard }: {
  draft: Draft;
  zh: boolean;
  canInsert: boolean;
  canDiscard: boolean;
  note: string | null;
  onInsert: () => void;
  onCopy?: () => Promise<void> | void;
  onDiscard: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current !== null) clearTimeout(copyTimer.current); }, []);
  useEffect(() => { setCopied(false); }, [draft.draftId, draft.text]);
  async function copy() {
    if (!onCopy) return;
    try {
      await onCopy();
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => { setCopied(false); copyTimer.current = null; }, 2000);
    } catch {
      setCopied(false);
    }
  }
  const showCopy = !canInsert && !!onCopy;
  return <Notice state="assistant-draft">
    <strong>{zh ? "助理草稿" : "Assistant draft"}</strong>
    <blockquote className="waba-quote">{draft.text}</blockquote>
    {(canInsert || showCopy || canDiscard) && <div className="waba-head">
      {canInsert && <Button size="sm" onClick={onInsert}>{zh ? "插入" : "Insert"}</Button>}
      {showCopy && <Button size="sm" onClick={() => { void copy(); }}>{copied ? (zh ? "已複製" : "Copied") : (zh ? "複製" : "Copy")}</Button>}
      {canDiscard && <Button size="sm" variant="ghost" onClick={onDiscard}>{zh ? "捨棄" : "Discard"}</Button>}
    </div>}
    {note && <p className="waba-muted" role="alert">{note}</p>}
  </Notice>;
}

/** One reply = prepare (host mints the effect and digest) → the host-drawn
 *  approval SLOT over exactly the prepared text. Nothing is retried. */
type Attempt = { text: string; effectId: string } & ({ state: "approving" } | { state: ReplyState } | { state: "checking" } | { state: "status"; status: ReplyStatus } | { state: "cancelled"; reason: string | null });

function Composer({
  scope,
  conversationId,
  handoffAt,
  freeformUntil,
  open,
  autoTakeover,
  inserted,
  draft,
  canDiscardDraft,
  onDiscardDraft,
  canBrief,
  briefBusy,
  briefNote,
  assistNote,
  onBrief,
  onDismissBriefNote,
  canTemplate,
  onOpenTemplate,
  replyDirty,
  onSent,
  onChanged,
  onDirtyChange,
}: {
  scope: DisplayScope;
  conversationId: string;
  handoffAt: string | null;
  freeformUntil: string | null;
  open: boolean;
  autoTakeover: boolean;
  inserted: { text: string; n: number } | null;
  draft?: Draft | null;
  canDiscardDraft?: boolean;
  onDiscardDraft?: () => void;
  canBrief?: boolean;
  briefBusy?: boolean;
  briefNote?: { ok: boolean; text: string } | null;
  assistNote?: string | null;
  onBrief?: (guidance: string) => Promise<void>;
  onDismissBriefNote?: () => void;
  canTemplate?: boolean;
  onOpenTemplate?: () => void;
  replyDirty?: boolean;
  onSent: () => void;
  onChanged: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [dismissedDraftId, setDismissedDraftId] = useState<string | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [briefPromptOpen, setBriefPromptOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const plusWrap = useRef<HTMLDivElement>(null);
  const plusBtn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const zh = useScope()?.presentationLocale === "zh-TW";
  useEffect(() => {
    setDismissedDraftId(prev => prev && draft?.draftId === prev ? prev : null);
  }, [draft?.draftId]);
  useEffect(() => {
    if (!plusOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (plusWrap.current && !plusWrap.current.contains(event.target as Node)) {
        setPlusOpen(false);
        setBriefPromptOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPlusOpen(false);
        setBriefPromptOpen(false);
        plusBtn.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [plusOpen]);
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [text, open, draft?.text]);
  useEffect(() => { onDirtyChange(!!text || busy || !!attempt && !["sent", "accepted", "failed", "refused", "cancelled"].includes(attempt.state)); }, [text, busy, attempt, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  // Insert only fills the text for editing; nothing is prepared until Send…
  useEffect(() => { if (inserted) setText(inserted.text); }, [inserted]);
  async function approve(frozen: { text: string; effectId: string }) {
    setAttempt({ ...frozen, state: "approving" });
    try {
      // The SLOT carries the exact prepared text; the host recomputes the
      // digest and refuses any difference.
      const done = await serviceSlot(scope, "whatsapp.reply.send", { conversation_id: conversationId, text: frozen.text, effect_id: frozen.effectId });
      const state = sendState(done);
      setAttempt({ ...frozen, state });
      if (state === "sent" || state === "accepted" || state === "uncertain") setText("");
      if (state === "sent" || state === "accepted") onSent();
    } catch (e) {
      // A refused card may be a cancel or a host refusal: the host record decides.
      await check(frozen, e);
    }
    onChanged();
  }
  // `refusal` is what ended the card; with it, a still-prepared effect was not sent.
  async function check(frozen: { text: string; effectId: string }, refusal?: unknown, preserveDraft = false) {
    setAttempt({ ...frozen, state: "checking" });
    try {
      const status = parseReplyStatus(await serviceCall(scope, "whatsapp.reply.status", { effect_id: frozen.effectId }));
      const cancelled = refusal !== undefined && status.state === "prepared";
      setAttempt(cancelled ? { ...frozen, state: "cancelled", reason: declinedReason(refusal).cancelled ? null : declinedReason(refusal).text } : { ...frozen, state: "status", status });
      // Anything that may have left the host is never offered for resend.
      if (!preserveDraft && !cancelled && !["prepared", "failed", "refused"].includes(status.state)) setText("");
      if (status.state === "sent" || status.state === "accepted") onSent();
    } catch { setAttempt({ ...frozen, state: "uncertain" }); if (!preserveDraft) setText(""); }
  }
  async function send() {
    const frozen = text;
    if (!frozen.trim() || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(null); setAttempt(null);
    try {
      // Replying by hand pauses FavCRM's AI first. If that fails nothing is prepared.
      if (autoTakeover && !handoffAt) {
        try { await serviceCall(scope, "whatsapp.handoff.set", { conversation_id: conversationId }); }
        catch (e) { setError(`Nothing was prepared: FavCRM's AI could not be paused. ${errorText(e, "The takeover was refused.")}`); onChanged(); return; }
        onChanged();
      }
      const prepared = parsePrepared(await serviceCall(scope, "whatsapp.reply.prepare", { conversation_id: conversationId, text: frozen }));
      await approve({ text: frozen, effectId: prepared.effect_id });
    } catch (e) {
      // Refusal codes are generic here; the re-read shows a closed window.
      setError(errorText(e, "The reply could not be prepared. Nothing was sent."));
      onChanged();
    } finally { submitting.current = false; setBusy(false); }
  }
  // While an attempt's outcome is open, the composer is locked so the same
  // reply is never sent twice. The outcome stays visible if the window closes.
  const locked = !!attempt && !["sent", "accepted", "failed", "refused", "cancelled"].includes(attempt.state);
  const ghostDraft = draft && draft.draftId !== dismissedDraftId ? draft : null;
  const showGhost = open && !locked && !busy && !!ghostDraft && text === "";
  function acceptGhost() {
    if (!ghostDraft) return;
    const nextText = ghostDraft.text;
    setDismissedDraftId(ghostDraft.draftId);
    setText(nextText);
    requestAnimationFrame(() => {
      const box = input.current;
      if (!box) return;
      box.focus();
      const len = nextText.length;
      box.setSelectionRange(len, len);
    });
  }
  function dismissGhost() {
    if (!ghostDraft) return;
    setDismissedDraftId(ghostDraft.draftId);
    if (canDiscardDraft && onDiscardDraft) onDiscardDraft();
  }
  const outcome = attempt && <Outcome attempt={attempt} linked={scope.provider === "linked"} group={conversationId.endsWith("@g.us")} onCheck={() => { void check(attempt, undefined, true); }} onApproveAgain={() => { void approve(attempt); }} onDismiss={() => setAttempt(null)} />;
  if (!open) return <div className="waba-composer">
    {outcome}
    <Notice state="window-closed">
      {zh ? "24 小時免費回覆時段已結束，現階段只可傳送已核准的範本訊息。" : "The 24-hour reply window is closed, so free text can’t be sent to this customer. An approved template can still be sent."}
      {canTemplate && onOpenTemplate && <> <Button size="sm" variant="primary" disabled={replyDirty} onClick={onOpenTemplate}>{zh ? "傳送範本…" : "Send template…"}</Button></>}
    </Notice>
  </div>;
  const review = zh ? "檢查並核准回覆" : "Review reply";
  const hasPlusMenu = !!((canTemplate && onOpenTemplate) || (canBrief && onBrief));
  return <div className="waba-composer">
    {outcome}
    {error && <ErrorNotice bare>{error}</ErrorNotice>}
    {assistNote && <p className="waba-muted" role="status">{assistNote}</p>}
    {briefNote && <p className={briefNote.ok ? "waba-muted" : "waba-brief-err"} role={briefNote.ok ? "status" : "alert"}>
      {briefNote.text}
      {onDismissBriefNote && <> <button type="button" className="waba-active-reset" onClick={onDismissBriefNote}>{zh ? "關閉" : "Dismiss"}</button></>}
    </p>}
    <form className="waba-compose-box" data-ghost={showGhost ? "yes" : undefined} onSubmit={e => { e.preventDefault(); if (open && !locked) void send(); }}>
      <div className="waba-compose-stage">
        {showGhost && (
          <div className="waba-ghost-text" aria-hidden="true">
            <span>{ghostDraft.text}</span>
          </div>
        )}
        <textarea
          ref={input}
          aria-label={zh ? "回覆" : "Reply"}
          placeholder={showGhost ? "" : (zh ? "輸入回覆…" : "Write a reply…")}
          rows={1}
          maxLength={4096}
          value={text}
          disabled={busy || locked}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (showGhost && e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              acceptGhost();
              return;
            }
            if (showGhost && e.key === "Escape" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              dismissGhost();
              return;
            }
            if (e.key !== "Enter" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            if (!e.repeat && !busy && !locked) void send();
          }}
        />
      </div>
      <div className="waba-compose-foot">
        <div className="waba-compose-left">
          {hasPlusMenu && <div ref={plusWrap} className="waba-plus-wrap">
            <button
              ref={plusBtn}
              type="button"
              className="waba-compose-ico-btn"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              aria-label={zh ? "更多輸入工具" : "More composer tools"}
              title={zh ? "範本及助理工具" : "Templates & AI tools"}
              disabled={busy || locked}
              onClick={() => { setPlusOpen(v => !v); setBriefPromptOpen(false); }}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" /></svg>
            </button>
            {plusOpen && <div className="waba-plus-menu" role="menu" aria-label={zh ? "輸入選項" : "Composer actions"}>
              {canTemplate && onOpenTemplate && <button type="button" role="menuitem" className="waba-work-menu-item" disabled={replyDirty} onClick={() => { setPlusOpen(false); onOpenTemplate(); }}>
                {zh ? "傳送已核准的範本…" : "Send an approved template…"}
              </button>}
              {canBrief && onBrief && !briefPromptOpen && <>
                <button type="button" role="menuitem" className="waba-work-menu-item" disabled={briefBusy} onClick={() => { setPlusOpen(false); void onBrief(""); }}>
                  {zh ? "用 AI 快速起草回覆" : "Draft reply with AI"}
                </button>
                <button type="button" role="menuitem" className="waba-work-menu-item" onClick={() => setBriefPromptOpen(true)}>
                  {zh ? "附帶指示讓 AI 起草…" : "Draft with AI guidance…"}
                </button>
              </>}
              {canBrief && onBrief && briefPromptOpen && <div className="waba-brief-pop">
                <textarea
                  className="field"
                  rows={2}
                  maxLength={2000}
                  value={guidance}
                  placeholder={zh ? "輸入語氣或重點（選填）…" : "Tone or offer guidance (optional)…"}
                  disabled={briefBusy}
                  onChange={e => setGuidance(e.target.value)}
                />
                <div className="waba-brief-pop-actions">
                  <Button size="sm" variant="primary" loading={briefBusy} onClick={() => {
                    const g = guidance;
                    setPlusOpen(false);
                    setBriefPromptOpen(false);
                    setGuidance("");
                    void onBrief(g);
                  }}>{zh ? "生成草稿" : "Generate draft"}</Button>
                </div>
              </div>}
            </div>}
          </div>}
          {canBrief && onBrief && !showGhost && <button
            type="button"
            className="waba-compose-ai-btn"
            disabled={busy || locked || briefBusy}
            title={zh ? "AI 起草回覆" : "Draft with AI"}
            aria-label={zh ? "AI 起草回覆" : "Draft with AI"}
            onClick={() => { void onBrief(""); }}
          >
            {briefBusy ? <span className="waba-inline-spin" aria-hidden="true" /> : <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.2 9.4 6l3.8 1.4-3.8 1.4L8 12.6 6.6 8.8 2.8 7.4 6.6 6Z" /></svg>}
            <span>{zh ? "AI 起草" : "AI Draft"}</span>
          </button>}
          {showGhost && <span className="waba-ghost-controls">
            <button type="button" className="waba-ghost-tab-btn" onClick={acceptGhost} title={zh ? "按 Tab 套用草稿" : "Press Tab to apply draft"}>
              <kbd>Tab</kbd>
              <span>{zh ? "套用 AI 草稿" : "Apply AI draft"}</span>
            </button>
            <button type="button" className="waba-ghost-dismiss" onClick={dismissGhost} aria-label={zh ? "略過草稿" : "Dismiss draft"} title={zh ? "按 Esc 略過" : "Esc to dismiss"}>×</button>
          </span>}
          {text && !busy && !locked && <Button size="sm" variant="ghost" onClick={() => { setText(""); input.current?.focus(); }}>{zh ? "清除" : "Clear"}</Button>}
        </div>
        <span className="waba-compose-hint waba-muted">{showGhost ? (zh ? "Tab 套用 · 直接輸入覆蓋" : "Tab to accept · Type to override") : (zh ? "Enter 檢查回覆 · Shift+Enter 換行" : "Enter to review · Shift+Enter for new line")}{freeformUntil && scope.provider !== "linked" ? ` · ${when(freeformUntil)}` : ""}</span>
        <button className="waba-compose-send" type="submit" aria-label={review} title={review} disabled={busy || locked || !text.trim()}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
        </button>
      </div>
    </form>
  </div>;
}

function Outcome({ attempt, linked, group, onCheck, onApproveAgain, onDismiss }: { attempt: Attempt; linked: boolean; group: boolean; onCheck: () => void; onApproveAgain: () => void; onDismiss: () => void }) {
  const quote = <blockquote className="waba-quote">{attempt.text}</blockquote>;
  const groupNote = "WhatsApp accepted this group message; group delivery confirmation is unavailable.";
  switch (attempt.state) {
    case "approving": return <Notice state="approving">Waiting for your approval in the Cadence card…</Notice>;
    case "checking": return <Loading>Reading this reply&apos;s recorded status…</Loading>;
    case "sent": return <Notice state="sent">{linked ? group ? groupNote : "Delivery confirmed." : "Sent: FavCRM accepted the reply. Delivery shows on the message once WhatsApp reports it."} <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></Notice>;
    case "accepted": return <Notice state="sent">{linked ? group ? groupNote : "WhatsApp accepted this message; recipient delivery is not confirmed." : "The provider accepted this message; recipient delivery is not confirmed."} {linked && !group && <Button size="sm" onClick={onCheck}>Check delivery</Button>} <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></Notice>;
    case "failed": return <ErrorNotice>{linked ? "The linked device did not dispatch this reply." : "Failed: FavCRM did not send this reply."} Your text is still in the composer. <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></ErrorNotice>;
    case "refused": return <ErrorNotice>Refused: the reply was not sent (for example the window closed or the approval was declined). <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></ErrorNotice>;
    case "cancelled": return <Notice state="cancelled">{attempt.reason ? `Not sent: ${attempt.reason}` : "Not sent: the approval was cancelled."} <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></Notice>;
    case "pending": return <Notice state="pending">Waiting for the owner&apos;s approval in AgenticOS. Nothing has been sent. Once it is approved, confirm the same reply again.{quote}
      <Button size="sm" onClick={onApproveAgain}>Confirm this reply again</Button></Notice>;
    case "status": return <Notice state={`status-${attempt.status.state}`}>Recorded status: <strong>{attempt.status.state}</strong>{attempt.status.door ? ` (door: ${attempt.status.door})` : ""}. {linked && group && ["sent", "accepted"].includes(attempt.status.state) ? "Group delivery confirmation is unavailable." : linked && attempt.status.state === "sent" ? "Delivery confirmed." : linked && attempt.status.state === "accepted" ? "WhatsApp accepted the message; recipient delivery is not confirmed." : linked ? "Verify with the recipient before sending again." : "Check the messages above; this reply is never resent automatically."}{quote}
      <Button size="sm" onClick={onCheck}>Check again</Button> <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></Notice>;
    default: return <ErrorNotice>Uncertain: Cadence can&apos;t tell whether this reply was sent, so it will never be resent. {linked ? "Check its status and verify with the recipient before sending again." : "Check its status and the messages above before replying again."}{quote}
      <Button size="sm" onClick={onCheck}>Check status</Button></ErrorNotice>;
  }
}
