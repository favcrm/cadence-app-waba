import { ApiError,Button,EmptyState,ErrorNotice,Field,Loading,Notice,Select,type SelectOption } from "@cadence/screen-ui";
import { Fragment,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode,type RefObject } from "react";
import { channel } from "../../bridge/channel";
import { patchRoute } from "../../bridge/route";
import { routable,useOnPush,useScope,type DisplayScope } from "../../bridge/scope";
import { serviceCall,serviceSlot } from "../../bridge/services";
import ContactDrawer,{ threadStateLabel } from "./ContactDrawer";
import { dueLabel,effectiveThreadState,listThreadWork,validWorkRef,type ThreadState,type ThreadWork } from "./inboxWork";
import { useWorkBrowse } from "./useWorkBrowse";
import type { Recipient } from "./Templates";
import { declinedReason,errorText,formatMediaBytes,formatMediaDuration,parseConversation,parseConversations,parseDraft,parseMessages,parsePrepared,parseReplyStatus,sendState,when,windowOpen,type Conversation,type ConversationRow,type Draft,type LinkedMediaInfo,type Message,type ReplyState,type ReplyStatus } from "./door";

const PAGE = 25;
/** What the copilot may show, derived from the host-granted actions (members get the draft read-only). */
export interface Assist { show: boolean; brief: boolean; open: boolean; discard: boolean }
/** Takeover actions the host granted; the banner itself is shown to everyone. */
export interface Handoff { set: boolean; release: boolean }
const DRAFT_POLL_MS = 5000;
type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "failed"; text: string };

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

function RowIdentity({ name, phone }: { name: string; phone: string | null }) {
  return <span className="waba-row-name">
    {name === phone ? <bdi className="waba-row-phone" dir="ltr">{phone}</bdi> : <span className="waba-row-title">{name}</span>}
    {phone && phone !== name && <bdi className="waba-row-phone waba-muted" dir="ltr">{phone}</bdi>}
  </span>;
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
const allQueues: readonly Queue[] = ["all", "unread", "needs_reply", "due", "waiting", "done"];
type WorkIndex = { records: Map<string, ThreadWork>; checked: Set<string> };
const emptyWorkIndex = (): WorkIndex => ({ records: new Map(), checked: new Set() });
function calendarDay(now: Date) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export default function Inbox({ scope, canReply, canTemplate, assist, handoff, routeId: routed, initialId, onRecipient, replyDirty, onDirtyChange, openSettings, tools }: { scope: DisplayScope; canReply: boolean; canTemplate: boolean; assist: Assist; handoff: Handoff; routeId: string | null; initialId: string | null; onRecipient: (r: Recipient) => void; replyDirty: boolean; onDirtyChange: (dirty: boolean) => void; openSettings: () => Promise<unknown>; tools: ReactNode }) {
  const zh = useScope()?.presentationLocale === "zh-TW", locale = zh ? "zh" : "en";
  const linked = scope.provider === "linked";
  const [settingsError, setSettingsError] = useState(false);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [list, setList] = useState<"loading" | "indexing" | "ok" | "more" | "failed">("loading");
  const listRequest = useRef(0);
  const foregroundList = useRef(false);
  const [filter, setFilter] = useState("");
  const [queue, setQueue] = useState<Queue>("all");
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
  // Ids outside the host route grammar stay a local selection.
  const [local, setLocal] = useState(initialId);
  const [resolved, setResolved] = useState<Conversation | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const openingRequest = useRef(0);
  const [newMessage, setNewMessage] = useState(false);
  const selected = routed ?? local;
  const openRow = useRef<HTMLElement | null>(null);
  const focusThread = useRef(false);
  const thread = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!focusThread.current) return;
    focusThread.current = false;
    if (newMessage || (selected && !openRow.current?.getClientRects().length)) thread.current?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    else if (!selected) openRow.current?.focus({ preventScroll: true });
  }, [newMessage, selected]);
  // `quiet` is a host-push refresh: no loading state, loaded pages kept, errors
  // leave what is shown in place.
  const page = useCallback(async (after: string | null, quiet = false) => {
    if (quiet && foregroundList.current) return;
    const request = ++listRequest.current;
    if (!quiet) { foregroundList.current = true; setList(after ? "more" : "loading"); }
    try {
      const got = await readWhileIndexing(
        async () => parseConversations(await serviceCall(scope, "whatsapp.conversations.list", { limit: PAGE, ...(after ? { cursor: after } : {}) })),
        () => request === listRequest.current,
        () => { if (!quiet) setList("indexing"); },
      );
      if (!got) return;
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
      setRows(r => changed ? got.rows : after ? [...r, ...got.rows.filter(n => !r.some(o => o.conversationId === n.conversationId))]
        : quiet ? [...got.rows, ...r.filter(o => !got.rows.some(n => n.conversationId === o.conversationId))] : got.rows);
      setCursor(c => quiet && c && !changed ? c : got.cursor); setList("ok");
      if (nextInbox && got.rows.length) {
        const refs = got.rows.flatMap(r => r.work ? [r.work.ref] : []);
        try {
          const records = await listThreadWork(scope, nextInbox, refs);
          if (request !== listRequest.current) return;
          setWork(previous => {
            const next = { records: new Map(previous.records), checked: new Set(previous.checked) };
            for (const ref of refs) next.checked.add(ref);
            for (const record of records) if ((next.records.get(record.ref)?.revision ?? 0) < record.revision) next.records.set(record.ref, record);
            return next;
          });
          setWorkError(false);
        } catch { if (request === listRequest.current) setWorkError(true); }
      }
    } catch (error) {
      if (request !== listRequest.current) return;
      if (linked && error instanceof ApiError && error.code === "not_granted") {
        openingRequest.current++;
        liveInbox.current = null;
        setInboxScope(null); setLocal(null); setResolved(null); setNewMessage(false);
        setOpening(false); setOpenError(false); setQueue("all"); setRows([]); setCursor(null);
        setWork(emptyWorkIndex()); setWorkError(false); setList("failed");
      } else if (!quiet) setList("failed");
    }
    finally { if (!quiet && request === listRequest.current) foregroundList.current = false; }
  }, [scope, linked]);
  useEffect(() => { void page(null); return () => { listRequest.current++; foregroundList.current = false; }; }, [page]);
  useOnPush(() => page(null, true));
  function select(id: string | null, observed: Conversation | null = null) {
    openingRequest.current++;
    setOpening(false); setOpenError(false); setResolved(observed);
    setNewMessage(false);
    focusThread.current = true;
    if (scope.provider === "linked") { setLocal(id); return; }
    if (id === null || routable(id)) { setLocal(null); void patchRoute({ section: "inbox", view: "list", record_id: id }).catch(() => undefined); }
    else { setLocal(id); void patchRoute({ section: "inbox", view: "list", record_id: null }).catch(() => undefined); }
  }
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
    if (!canFilterUnread && queue === "unread") setQueue("all");
  }, [canFilterUnread, queue]);
  const unreadCount = rows.filter(row => (row.unreadCount ?? 0) > 0).length;
  const shown = queue === "due" ? [] : rows.filter(r => {
    const record = recordFor(r);
    if (queue === "unread" ? (r.unreadCount ?? 0) <= 0
      : queue !== "all" && (!r.work || !work.checked.has(r.work.ref) || effectiveThreadState(record, r.work.inboundVersion) !== queue)) return false;
    return !needle || [record?.name, r.contact.name, contactPhone(r, linked), r.lastMessage?.body].some(v => v?.toLocaleLowerCase().includes(needle));
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
  const queueOptions = useMemo<SelectOption[]>(() => {
    const inboxGroup = inboxScope ? (zh ? "收件匣" : "Inbox") : undefined;
    const workGroup = zh ? "跟進及狀態" : "Follow-up & status";
    const opts: SelectOption[] = [
      { value: "all", label: zh ? "全部對話" : "All chats", ...(rows.length > 0 ? { badge: String(rows.length) } : {}), ...(inboxGroup ? { group: inboxGroup } : {}) },
      ...(canFilterUnread ? [{ value: "unread", label: zh ? "未讀" : "Unread", ...(unreadCount > 0 ? { badge: String(unreadCount) } : {}), ...(inboxGroup ? { group: inboxGroup } : {}) }] : []),
    ];
    if (inboxScope) {
      opts.push(
        { value: "needs_reply", label: threadStateLabel("needs_reply", zh), ...(queueStats.needsReply > 0 ? { badge: String(queueStats.needsReply) } : {}), group: workGroup },
        { value: "due", label: zh ? "待跟進" : "Follow-ups due", ...(queueStats.dueBadge ? { badge: queueStats.dueBadge } : {}), group: workGroup },
        { value: "waiting", label: threadStateLabel("waiting", zh), ...(queueStats.waiting > 0 ? { badge: String(queueStats.waiting) } : {}), group: workGroup },
        { value: "done", label: threadStateLabel("done", zh), ...(queueStats.done > 0 ? { badge: String(queueStats.done) } : {}), group: workGroup },
      );
    }
    return opts;
  }, [inboxScope, zh, rows.length, canFilterUnread, unreadCount, queueStats]);
  const activeQueueLabel = queueOptions.find(o => o.value === queue)?.label ?? (zh ? "全部對話" : "All chats");
  const visibleCount = queue === "due" ? extras.length : shown.length + extras.length;
  const failed = list === "failed";
  const browseLabel = queue === "due" ? (zh ? "查找跟進事項…" : "Finding follow-ups…") : (zh ? "搜尋已儲存名稱…" : "Searching saved names…");
  return <section className="waba-page waba-inbox" data-selected={newMessage || selected ? "yes" : "no"} aria-label={zh ? "收件匣" : "Inbox"}>
    <div className="waba-list" aria-labelledby="waba-inbox-title">
      <header className="waba-list-head">
        <div className="waba-head">
          <h1 id="waba-inbox-title" tabIndex={-1}>{zh ? "收件匣" : "Inbox"}</h1>
          {linked && canReply && <Button size="sm" variant="primary" disabled={replyDirty || opening} onClick={e => { openRow.current = e.currentTarget; focusThread.current = true; setLocal(null); setResolved(null); setNewMessage(true); }}>{zh ? "新增訊息" : "New message"}</Button>}
          {tools}
        </div>
        <input className="field waba-search" type="search" aria-label={zh ? "搜尋對話" : "Search conversations"} placeholder={zh ? "搜尋對話…" : "Search conversations…"} value={filter} onChange={e => setFilter(e.target.value)} />
        {(canFilterUnread || inboxScope) && <div className="waba-list-filters" role="group" aria-label={zh ? "篩選對話" : "Filter conversations"}>
          <Select className="waba-queue-select" size="sm" full value={queue} options={queueOptions} aria-label={zh ? "選擇對話佇列" : "Filter conversation queue"} onChange={next => {
            const matched = allQueues.find(value => value === next);
            setQueue(matched ?? "all");
          }} />
          {inboxScope && <button type="button" className="waba-due-toggle" aria-pressed={queue === "due"} onClick={() => setQueue(queue === "due" ? "all" : "due")}>
            <span className="waba-due-dot" aria-hidden="true" />
            <span>{zh ? "待跟進" : "Due"}</span>
            {queueStats.dueBadge && <span className="waba-due-count">{queueStats.dueBadge}</span>}
          </button>}
        </div>}
      </header>
      <div className="waba-list-scroll">
      {queue !== "all" && list === "ok" && <div className="waba-active-filter">
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
          const state = r.work && work.checked.has(r.work.ref) ? effectiveThreadState(record, r.work.inboundVersion) : null;
          const isDue = !!record?.due && record.due <= dueDay;
          const flag = isDue ? dueLabel(record!.due!, dueDay, zh)
            : state && state !== "needs_reply" ? threadStateLabel(state, zh) : null;
          const flagTone = isDue ? (record!.due! < dueDay ? "overdue" : "due") : state === "done" ? "done" : "waiting";
          const unread = r.unreadCount ?? 0;
          const lastText = r.lastMessage
            ? `${r.lastMessage.direction === "outbound" ? (zh ? "你：" : "You: ") : ""}${r.lastMessage.body ?? (zh ? "媒體附件" : "Attachment")}`
            : "";
          return <li key={r.conversationId}>
            <button type="button" className="waba-row" disabled={replyDirty || opening} aria-current={r.conversationId === selected ? "true" : undefined} data-unread={unread > 0 ? "yes" : undefined} onClick={e => { openRow.current = e.currentTarget; select(r.conversationId); }}>
              <Avatar name={name} phone={phone} group={groupRow} />
              <RowIdentity name={name} phone={linked ? phone : null} />
              {at === null ? <span /> : <time className="waba-row-time" dateTime={r.lastMessage?.createdAt ?? undefined}>{dayFormat[locale].format(at) === today ? timeFormat[locale].format(at) : listDate[locale].format(at)}</time>}
              <span className="waba-row-last">{lastText}</span>
              {unread > 0 && <span className="waba-badge" aria-label={zh ? `${unread} 則未讀訊息` : `${unread} unread`}>{unread > 99 ? "99+" : unread}</span>}
              {flag && <span className="waba-row-flag" data-tone={flagTone}>{flag}</span>}
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
              <RowIdentity name={name} phone={phone} />
              <span />
              <span className="waba-row-last">{record.due ? `${dueLabel(record.due, dueDay, zh)} · ${record.due}` : (zh ? "已儲存的對話名稱" : "Saved conversation name")}</span>
            </button>
          </li>;
        })}</ul>}
        {cursor && !failed && queue !== "due" && <div className="waba-page-more"><Button size="sm" loading={list === "more" || list === "indexing"} onClick={() => { void page(cursor); }}>{zh ? "載入更多" : "Load more"}</Button></div>}
        {browse.page?.cursor && browse.page.state !== "failed" && <div className="waba-page-more"><Button size="sm" loading={browse.page.state === "loading"} onClick={() => { void browse.load(browse.page?.cursor); }}>{zh ? "更多結果" : "More results"}</Button></div>}
      </div>
    </div>
    <div ref={thread} className="waba-thread">
      {newMessage ? <NewLinkedReply scope={scope} dirty={replyDirty} onDirtyChange={onDirtyChange} onBack={() => select(null)} onChanged={() => { void page(null, true); }} />
        : selected ? <Thread key={selected} scope={scope} id={selected} initial={resolved} inboxScope={inboxScope} work={work} onWork={remember} canReply={canReply} canTemplate={canTemplate} assist={assist} handoff={handoff} onRecipient={onRecipient} onDirtyChange={onDirtyChange} onBack={() => select(null)} replyDirty={replyDirty} />
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

function Thread({ scope, id, initial, inboxScope, work, onWork, canReply, canTemplate, assist, handoff, onRecipient, onDirtyChange, onBack, replyDirty }: {
  scope: DisplayScope; id: string; initial: Conversation | null; inboxScope: string | null; work: WorkIndex; onWork: (record: ThreadWork) => void;
  canReply: boolean; canTemplate: boolean; assist: Assist; handoff: Handoff; onRecipient: (r: Recipient) => void;
  onDirtyChange: (dirty: boolean) => void; onBack: () => void; replyDirty: boolean;
}) {
  const zh = useScope()?.presentationLocale === "zh-TW";
  const unavailablePreview = zh ? "無法顯示預覽" : "Preview unavailable";
  const [conversation, setConversation] = useState<Load<Conversation>>(() => initial?.conversationId === id ? { state: "ok", value: initial } : { state: "loading" });
  const [messages, setMessages] = useState<Load<{ rows: Message[]; cursor: string | null; previousAnchor?: { row: HTMLElement; top: number } }>>({ state: "loading" });
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
  const mediaMounted = useRef(true);
  const mediaUrls = useRef<Map<string, string>>(new Map());
  const loadedMediaRef = useRef<Map<string, LoadedInlineMedia>>(new Map());
  const inlineInFlight = useRef<Map<string, Promise<LoadedInlineMedia>>>(new Map());
  const [loadedMedia, setLoadedMedia] = useState<Map<string, LoadedInlineMedia>>(() => new Map());
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const hostMediaDownload = useSyncExternalStore(channel.subscribeReplyAvailability, () => channel.hostMediaDownload);
  useEffect(() => {
    mediaMounted.current = true;
    const urls = mediaUrls.current;
    const loaded = loadedMediaRef.current;
    return () => {
      mediaMounted.current = false;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      loaded.clear();
    };
  }, []);
  const loadInlineMedia = useCallback(async (messageId: string): Promise<LoadedInlineMedia> => {
    const cached = loadedMediaRef.current.get(messageId);
    if (cached && cached.url) return cached;
    const active = inlineInFlight.current.get(messageId);
    if (active) return active;
    const promise = channel.downloadMedia(id, messageId).then(downloaded => {
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
  }, [id]);
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
  // `quiet` is a host-push refresh: shown data stays on a failed read, and
  // messages already loaded stay (newer rows win by id).
  const show = useCallback(async (quiet = false) => {
    try {
      const next = parseConversation(await serviceCall(scope, "whatsapp.conversations.show", { conversation_id: id }));
      if (next.conversationId !== id) throw new ApiError("The conversation identity changed", 502);
      setConversation({ state: "ok", value: next });
    }
    catch (e) { setConversation(c => quiet && c.state === "ok" ? c : { state: "failed", text: errorText(e, "The conversation could not be read.") }); }
  }, [scope, id]);
  const read = useCallback(async (after: string | null = null, quiet = false) => {
    if (quiet && foregroundMessages.current) return;
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
      if (!got) return;
      setIndexing(false);
      // A dock resize can change the scroll extent in the same commit as an
      // older page. Anchor a retained row, not the height including the dock.
      const row = after ? timeline.current?.querySelector<HTMLElement>(".waba-message") : null;
      const previousAnchor = row ? { row, top: row.offsetTop } : undefined;
      setMessages(m => m.state === "ok" && (after || quiet)
        ? { state: "ok", value: { rows: after ? [...m.value.rows, ...got.rows.filter(n => !m.value.rows.some(o => o.id === n.id))] : [...got.rows, ...m.value.rows.filter(o => !got.rows.some(n => n.id === o.id))], cursor: quiet ? m.value.cursor : got.cursor, previousAnchor } }
        : { state: "ok", value: { rows: got.rows, cursor: got.cursor } });
    } catch (e) {
      if (request !== messageRequest.current) return;
      setIndexing(false);
      setMessages(m => quiet && m.state === "ok" ? m : { state: "failed", text: errorText(e, "Messages could not be read.") });
    }
    finally {
      if (!quiet && request === messageRequest.current) {
        foregroundMessages.current = false;
        setLoadingOlder(false);
      }
    }
  }, [scope, id]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [inserted, setInserted] = useState<{ text: string; n: number } | null>(null);
  const [assistNote, setAssistNote] = useState<string | null>(null);
  const readDraft = useCallback(async () => {
    if (!assist.show) { setDraft(null); return; }
    // A failed read keeps what is shown: the chip never invents or drops a draft.
    try { setDraft(parseDraft(await serviceCall(scope, "whatsapp.draft.show", { conversation_id: id }))); } catch { /* next poll retries */ }
  }, [scope, id, assist.show]);
  useEffect(() => {
    void readDraft();
    if (!assist.show) return;
    const t = setInterval(() => { void readDraft(); }, DRAFT_POLL_MS);
    return () => clearInterval(t);
  }, [readDraft, assist.show]);
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
  // The reply went out: its draft is spent. A failed discard leaves the chip, never a retry loop.
  const onSent = useCallback(() => { if (assist.discard) void discard(); }, [assist.discard, scope, id]);
  useOnPush(() => Promise.all([show(true), read(null, true)]));
  const c = conversation.state === "ok" ? conversation.value : null;
  const ordered = useMemo(() => messages.state === "ok"
    ? [...messages.value.rows].sort((a, b) => (stamp(a.createdAt) ?? 0) - (stamp(b.createdAt) ?? 0))
    : [], [messages]);
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
  }, [messages, details, replyInset]);
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
  const phone = c ? contactPhone(c, linked) : null;
  const workLink = inboxScope && c?.work && validWorkRef(c.work.ref, inboxScope) ? c.work : null;
  const record = workLink ? work.records.get(workLink.ref) : undefined;
  const title = c ? contactName(c, phone, linked, zh, record?.name) : (zh ? "對話" : "Conversation");
  const group = linked && id.endsWith("@g.us");
  const subtitle = group ? (zh ? "WhatsApp 群組" : "WhatsApp group") : phone ?? phoneUnavailable(zh);
  const detailsLabel = zh ? (group ? "群組詳情" : "聯絡人詳情") : (group ? "Group details" : "Contact details");
  const identity = phone && phone !== title ? `${title}${zh ? "、" : ", "}${phone}` : title;
  const photos = details ? ordered.filter(m => m.previewJpeg !== null || (m.media?.kind === "image" && m.media.available)) : [];
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
      <Button size="sm" variant="ghost" className="waba-back" disabled={replyDirty} onClick={onBack}>{zh ? "返回" : "Back"}</Button>
      <h2 id="waba-thread-title" tabIndex={-1}>
        {c ? <button className="waba-details-trigger" ref={detailsButton} type="button" aria-haspopup="dialog" aria-expanded={details} aria-label={`${identity}${zh ? "：" : ": "}${detailsLabel}`} onClick={() => details ? closeDetails() : setDetails(true)}>
          <Avatar name={title} phone={phone} group={group} />
          <span className="waba-thread-identity">{title === phone ? <bdi dir="ltr">{phone}</bdi> : title}{subtitle !== title && <small className="waba-muted">{phone ? <bdi dir="ltr">{phone}</bdi> : subtitle}</small>}</span>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7.5 3v10m-4-10h9A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3Z" /></svg>
        </button> : title}
      </h2>
      {workLink && work.checked.has(workLink.ref) && (() => {
        const currentState = effectiveThreadState(record, workLink.inboundVersion);
        return <button type="button" className="waba-work-pill" data-state={currentState} aria-haspopup="dialog" aria-expanded={details} onClick={() => details ? closeDetails() : setDetails(true)}>
          <span className="waba-work-dot" aria-hidden="true" />
          <span>{threadStateLabel(currentState, zh)}</span>
        </button>;
      })()}
    </header>
    <div className="waba-conversation-body">
      <div className="waba-thread-main" ref={messagePane}>
        {replyAvailability && <div className="waba-reply-availability" role="status">
          {replyAvailability !== "verified" && <Notice state={replyAvailability}>
            {replyAvailability === "checking" ? <span className="waba-inline-loading"><span className="waba-inline-spin" aria-hidden="true" /><span>{zh ? "正在核對收件人…" : "Verifying recipient…"}</span></span>
              : (zh ? "此對話暫時無法回覆，你仍可查看訊息。" : "Replies are unavailable for this chat. You can still read messages.")}
          </Notice>}
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
          }}>
            <div className="waba-timeline-inner">
              {conversation.state === "loading" && messages.state === "loading" ? (
                <Loading>{indexing ? (zh ? "正在整理較早的訊息…" : "Indexing older messages…") : (zh ? "正在讀取對話…" : "Reading conversation…")}</Loading>
              ) : <>
                {conversation.state === "loading" ? <Loading>{zh ? "正在讀取對話…" : "Reading conversation…"}</Loading>
                  : conversation.state === "failed" ? <ErrorNotice onRetry={() => { void show(); }}>{conversation.text}</ErrorNotice> : null}
                {messages.state === "loading" ? <Loading>{indexing ? (zh ? "正在整理較早的訊息…" : "Indexing older messages…") : (zh ? "正在讀取訊息…" : "Reading messages…")}</Loading>
                  : messages.state === "failed" ? <ErrorNotice onRetry={() => { void read(); }}>{messages.text}</ErrorNotice>
                  : <>
                    {messages.value.cursor && <div className="waba-history-more"><Button size="sm" loading={loadingOlder || indexing} onClick={() => loadOlder(messages.value.cursor!)}>{zh ? "載入較早訊息" : "Load older messages"}</Button></div>}
                    {!ordered.length ? <EmptyState title={zh ? "沒有訊息" : "No messages"} name="messages" /> : <ol className="waba-messages" aria-label="Messages">{ordered.map((m, index) => {
                    const at = stamp(m.createdAt), previous = stamp(ordered[index - 1]?.createdAt ?? null);
                    const date = at === null ? null : day.format(at);
                    return <Fragment key={m.id}>
                      {date && (previous === null || day.format(previous) !== date) && <li className="waba-date">{date}</li>}
                      <li className="waba-message" data-direction={m.direction === "outbound" ? "outbound" : "inbound"}>
                        {scope.provider === "linked" && m.type === "unsupported"
                          ? m.media
                            ? <LinkedMediaMessage
                                conversationId={id}
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
                        {(at !== null || m.status) && <div className="waba-message-meta waba-muted">{at !== null && <time dateTime={m.createdAt!}>{time.format(at)}</time>}{m.status && <span>{m.status}</span>}</div>}
                      </li>
                    </Fragment>;
                  })}</ol>}
                </>}
              </>}
            </div>
          </div>
          {showLatest && <div className="waba-jump"><Button size="sm" onClick={jumpToLatest}>{zh ? "跳至最新訊息" : "Jump to latest"}</Button></div>}
        </div>
        {/* The admitted linked composer is on the board. Official actions and
            the local-composer/read-only footer stay on their existing path. */}
        {c && composeId === null && <footer className="waba-thread-footer">
          <TakeoverBar scope={scope} id={id} handoffAt={c.handoffAt} rights={handoff} onChanged={() => { void show(); }} />
          {assist.brief && <Brief scope={scope} id={id} canOpen={assist.open} />}
          {draft && <DraftChip draft={draft} canInsert={canReply && windowOpen(c)} canDiscard={assist.discard} note={assistNote} onInsert={() => setInserted(i => ({ text: draft.text, n: (i?.n ?? 0) + 1 }))} onDiscard={() => { void discard(); }} />}
          {canReply ? !(linked && channel.hostCompose) && <Composer scope={scope} conversationId={c.conversationId} handoffAt={c.handoffAt} freeformUntil={c.freeformUntil} open={scope.provider === "linked" || windowOpen(c)} autoTakeover={handoff.set} inserted={inserted} onSent={onSent} onChanged={reload} onDirtyChange={onReplyDirty} />
            : <Notice state="read-only">You can read this inbox. Only the workspace operator can reply.</Notice>}
          {canTemplate && <Button size="sm" disabled={replyDirty} onClick={() => onRecipient(c)}>{zh ? "使用已核准的範本…" : "Send an approved template…"}</Button>}
        </footer>}
      </div>
    </div>
    {details && c && <ContactDrawer
      key={workLink?.ref ?? id}
      scope={scope}
      conversation={c}
      workLink={workLink}
      title={title}
      subtitle={subtitle}
      phone={phone}
      group={group}
      zh={zh}
      avatar={<Avatar name={title} phone={phone} group={group} />}
      photos={photos}
      loadedMedia={loadedMedia}
      hostMediaDownload={hostMediaDownload}
      unavailablePreview={unavailablePreview}
      dueDay={dueDay}
      onSaved={onWork}
      onDirty={onWorkDirty}
      onOpenLightbox={messageId => setLightboxId(messageId)}
      onClose={closeDetails}
    />}
    {lightboxMessage?.media && <MediaLightbox
      conversationId={id}
      message={lightboxMessage}
      media={lightboxMessage.media}
      loaded={loadedMedia.get(lightboxMessage.id) ?? null}
      zh={zh}
      unavailable={unavailablePreview}
      closeRef={closeLightboxButton}
      onLoadInline={loadInlineMedia}
      onClose={() => setLightboxId(null)}
    />}
  </article>;
}

function PhotoPreview({ jpeg, label, unavailable }: { jpeg: string; label: string; unavailable: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="waba-muted">{unavailable}</p>
    : <img className="waba-photo-preview" src={`data:image/jpeg;base64,${jpeg}`} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function mediaBadge(media: LinkedMediaInfo): string {
  if (media.kind === "image") return "IMG";
  if (media.kind === "video") return "VID";
  if (media.kind === "audio") return media.ptt ? "PTT" : "AUD";
  const mime = media.mimeType.toLowerCase();
  if (mime === "application/pdf") return "PDF";
  if (mime.includes("wordprocessingml")) return "DOCX";
  if (mime.includes("spreadsheetml")) return "XLSX";
  if (mime.includes("presentationml")) return "PPTX";
  if (mime === "text/csv") return "CSV";
  if (mime === "text/plain") return "TXT";
  return "FILE";
}

function mediaKindLabel(media: LinkedMediaInfo, zh: boolean): string {
  if (media.kind === "image") return zh ? "圖片" : "Image";
  if (media.kind === "video") return zh ? "影片" : "Video";
  if (media.kind === "audio") return media.ptt ? (zh ? "語音訊息" : "Voice message") : (zh ? "音訊" : "Audio");
  return zh ? "文件" : "Document";
}

function mediaMetaSummary(media: LinkedMediaInfo): string {
  const parts = [
    formatMediaBytes(media.byteLength),
    media.width && media.height ? `${media.width}×${media.height}` : null,
    formatMediaDuration(media.durationSeconds),
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
}

function unavailableReasonText(reason: LinkedMediaInfo["unavailableReason"], zh: boolean): string {
  if (reason === "too_large") return zh ? "檔案超過 10 MB 下載限制。" : "Attachment exceeds the 10 MB limit.";
  if (reason === "unsupported_type") return zh ? "不支援此媒體格式。" : "Unsupported media format.";
  return zh ? "此訊息無法提供媒體下載。" : "Media is unavailable for this message.";
}

function LinkedMediaMessage({
  conversationId,
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
  message: Message;
  media: LinkedMediaInfo;
  loaded: { url: string; mimeType: string; fileName: string | null } | null;
  canDownload: boolean;
  zh: boolean;
  unavailable: string;
  onLoadInline: (messageId: string) => Promise<{ url: string; mimeType: string; fileName: string | null }>;
  onOpenLightbox: () => void;
}) {
  const [loadingInline, setLoadingInline] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const label = media.fileName ?? mediaKindLabel(media, zh);
  const summary = mediaMetaSummary(media);

  async function playInline() {
    if (loadingInline) return;
    setLoadingInline(true);
    setInlineError(null);
    try {
      await onLoadInline(message.id);
    } catch (e) {
      setInlineError(errorText(e, zh ? "無法載入媒體。" : "Couldn’t load media."));
    } finally {
      setLoadingInline(false);
    }
  }

  async function saveFile() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await channel.saveMedia(conversationId, message.id);
      setSavedName(saved.fileName);
    } catch (e) {
      setSaveError(errorText(e, zh ? "無法下載檔案。" : "Couldn’t save attachment."));
    } finally {
      setSaving(false);
    }
  }

  const caption = media.caption ? <p className="waba-media-caption">{media.caption}</p> : null;

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
    return <div className="waba-media-card">
      <button type="button" className="waba-media-trigger" aria-label={media.fileName ? `${zh ? "檢視圖片" : "View image"}: ${media.fileName}` : (zh ? "檢視完整圖片" : "View full image")} onClick={onOpenLightbox}>
        {loaded?.url
          ? <img className="waba-photo-preview" src={loaded.url} alt={label} loading="lazy" decoding="async" />
          : message.previewJpeg
          ? <PhotoPreview key={message.previewJpeg} jpeg={message.previewJpeg} label={label} unavailable={unavailable} />
          : <span className="waba-media-tile">
              <span className="waba-media-badge">IMG</span>
              <span className="waba-media-info">
                <span className="waba-media-title">{label}</span>
                {summary && <span className="waba-media-sub">{summary}</span>}
              </span>
            </span>}
      </button>
      {summary && !message.previewJpeg && !loaded?.url ? null : summary && <span className="waba-media-sub">{summary}</span>}
      {caption}
    </div>;
  }

  if (media.kind === "audio") {
    return <div className="waba-media-card">
      <div className="waba-media-tile">
        <span className="waba-media-badge">{mediaBadge(media)}</span>
        <span className="waba-media-info">
          <span className="waba-media-title">{mediaKindLabel(media, zh)}</span>
          {summary && <span className="waba-media-sub">{summary}</span>}
        </span>
      </div>
      {loaded?.url
        ? <audio className="waba-media-audio" controls autoPlay src={loaded.url} />
        : null}
      <div className="waba-media-actions">
        {!loaded?.url && <Button size="sm" loading={loadingInline} onClick={() => { void playInline(); }}>{inlineError ? (zh ? "重試" : "Retry") : (zh ? "播放" : "Play")}</Button>}
        <Button size="sm" variant="ghost" loading={saving} onClick={() => { void saveFile(); }}>{zh ? "下載" : "Save"}</Button>
      </div>
      {savedName && <p className="waba-muted" role="status">{zh ? `已儲存 ${savedName}` : `Saved ${savedName}`}</p>}
      {inlineError && <ErrorNotice bare>{inlineError}</ErrorNotice>}
      {saveError && <ErrorNotice bare>{saveError}</ErrorNotice>}
      {caption}
    </div>;
  }

  if (media.kind === "video") {
    const poster = message.previewJpeg ? `data:image/jpeg;base64,${message.previewJpeg}` : undefined;
    return <div className="waba-media-card">
      {loaded?.url
        ? <video className="waba-media-video" controls playsInline autoPlay poster={poster} src={loaded.url} />
        : message.previewJpeg
        ? <PhotoPreview key={message.previewJpeg} jpeg={message.previewJpeg} label={label} unavailable={unavailable} />
        : <div className="waba-media-tile">
            <span className="waba-media-badge">VID</span>
            <span className="waba-media-info">
              <span className="waba-media-title">{mediaKindLabel(media, zh)}</span>
              {summary && <span className="waba-media-sub">{summary}</span>}
            </span>
          </div>}
      <div className="waba-media-actions">
        {!loaded?.url && <Button size="sm" loading={loadingInline} onClick={() => { void playInline(); }}>{inlineError ? (zh ? "重試" : "Retry") : (zh ? "播放影片" : "Play video")}</Button>}
        <Button size="sm" variant="ghost" loading={saving} onClick={() => { void saveFile(); }}>{zh ? "下載" : "Save"}</Button>
        {summary && !loaded?.url && message.previewJpeg && <span className="waba-media-sub">{summary}</span>}
      </div>
      {savedName && <p className="waba-muted" role="status">{zh ? `已儲存 ${savedName}` : `Saved ${savedName}`}</p>}
      {inlineError && <ErrorNotice bare>{inlineError}</ErrorNotice>}
      {saveError && <ErrorNotice bare>{saveError}</ErrorNotice>}
      {caption}
    </div>;
  }

  return <div className="waba-media-card">
    <div className="waba-media-tile">
      <span className="waba-media-badge">{mediaBadge(media)}</span>
      <span className="waba-media-info">
        <span className="waba-media-title">{label}</span>
        {summary && <span className="waba-media-sub">{summary}</span>}
      </span>
    </div>
    <div className="waba-media-actions">
      <Button size="sm" loading={saving} onClick={() => { void saveFile(); }}>{saveError ? (zh ? "重試" : "Retry") : (zh ? "下載" : "Download")}</Button>
    </div>
    {savedName && <p className="waba-muted" role="status">{zh ? `已下載 ${savedName}` : `Downloaded ${savedName}`}</p>}
    {saveError && <ErrorNotice bare>{saveError}</ErrorNotice>}
    {caption}
  </div>;
}

function MediaLightbox({
  conversationId,
  message,
  media,
  loaded,
  zh,
  unavailable,
  closeRef,
  onLoadInline,
  onClose,
}: {
  conversationId: string;
  message: Message;
  media: LinkedMediaInfo;
  loaded: { url: string; mimeType: string; fileName: string | null } | null;
  zh: boolean;
  unavailable: string;
  closeRef: RefObject<HTMLButtonElement | null>;
  onLoadInline: (messageId: string) => Promise<{ url: string; mimeType: string; fileName: string | null }>;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(!loaded?.url);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const retryLoad = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void onLoadInline(message.id).then(
      () => setLoading(false),
      (e: unknown) => {
        setLoadError(errorText(e, zh ? "無法載入完整相片。" : "Couldn’t load full photo."));
        setLoading(false);
      },
    );
  }, [message.id, onLoadInline, zh]);

  useEffect(() => {
    if (!loaded?.url) retryLoad();
    else setLoading(false);
  }, [loaded?.url, retryLoad]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  async function saveImage() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await channel.saveMedia(conversationId, message.id);
      setSavedName(res.fileName);
    } catch (e) {
      setSaveError(errorText(e, zh ? "無法下載相片。" : "Couldn’t save photo."));
    } finally {
      setSaving(false);
    }
  }

  const title = media.fileName ?? (zh ? "相片" : "Photo");
  const summary = mediaMetaSummary(media);
  return <div className="waba-lightbox-backdrop" role="dialog" aria-modal="true" aria-labelledby="waba-lightbox-title" onClick={e => {
    if (e.target === e.currentTarget) onClose();
  }} onKeyDown={e => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }}>
    <div className="waba-lightbox">
      <header className="waba-head">
        <div>
          <h3 id="waba-lightbox-title">{title}</h3>
          {summary && <p className="waba-media-sub">{summary}</p>}
        </div>
        <button ref={closeRef} type="button" className="btn" onClick={onClose}>{zh ? "關閉" : "Close"}</button>
      </header>
      <div className="waba-lightbox-body">
        {loaded?.url
          ? <img className="waba-lightbox-img" src={loaded.url} alt={title} />
          : message.previewJpeg
          ? <PhotoPreview jpeg={message.previewJpeg} label={title} unavailable={unavailable} />
          : null}
        {loading && <Loading>{zh ? "正在載入完整相片…" : "Loading full image…"}</Loading>}
        {loadError && <ErrorNotice onRetry={retryLoad}>{loadError}</ErrorNotice>}
      </div>
      <footer className="waba-lightbox-foot">
        <div>{media.caption && <p className="waba-media-caption">{media.caption}</p>}
          {savedName && <p className="waba-muted" role="status">{zh ? `已儲存 ${savedName}` : `Saved ${savedName}`}</p>}
          {saveError && <ErrorNotice bare>{saveError}</ErrorNotice>}
        </div>
        <Button size="sm" loading={saving} onClick={() => { void saveImage(); }}>{zh ? "下載原圖" : "Save"}</Button>
      </footer>
    </div>
  </div>;
}

function Brief({ scope, id, canOpen }: { scope: DisplayScope; id: string; canOpen: boolean }) {
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function brief() {
    setBusy(true); setNote(null);
    try {
      // The host draws the card over this exact guidance; its tap runs the brief, then opens the Assistant.
      await serviceSlot(scope, "chat.whatsapp.brief", { conversation_id: id, guidance: guidance.trim() });
      setNote("The assistant is drafting. The draft appears here when it is ready.");
    } catch (e) { setNote(errorText(e, "The assistant was not asked (cancelled or refused).")); }
    finally { setBusy(false); }
  }
  return <div className="waba-assist">
    <Field label="Guidance for the assistant (optional)" hint="For example the tone, or what to offer. The assistant reads this conversation only.">
      {c => <textarea {...c} className="field" rows={2} maxLength={2000} value={guidance} disabled={busy} onChange={e => setGuidance(e.target.value)} />}
    </Field>
    <div className="waba-head">
      <Button size="sm" onClick={() => { void brief(); }} loading={busy}>Draft with assistant</Button>
      {canOpen && <Button size="sm" variant="ghost" onClick={() => { void serviceCall(scope, "chat.whatsapp.open", { conversation_id: id }).catch(() => undefined); }}>Open assistant</Button>}
    </div>
    {note && <p className="waba-muted" role="status">{note}</p>}
  </div>;
}

function DraftChip({ draft, canInsert, canDiscard, note, onInsert, onDiscard }: { draft: Draft; canInsert: boolean; canDiscard: boolean; note: string | null; onInsert: () => void; onDiscard: () => void }) {
  return <Notice state="assistant-draft">
    <strong>Assistant draft</strong>
    <blockquote className="waba-quote">{draft.text}</blockquote>
    {(canInsert || canDiscard) && <div className="waba-head">
      {canInsert && <Button size="sm" onClick={onInsert}>Insert</Button>}
      {canDiscard && <Button size="sm" variant="ghost" onClick={onDiscard}>Discard</Button>}
    </div>}
    {note && <p className="waba-muted" role="alert">{note}</p>}
  </Notice>;
}

/** Takeover state from the conversation read (`handoffAt`, FavCRM's one source of truth).
 *  Everyone sees the banner; only granted actions show buttons. After any refusal the
 *  conversation is read again and the host's own reason stays on screen. */
function TakeoverBar({ scope, id, handoffAt, rights, onChanged }: { scope: DisplayScope; id: string; handoffAt: string | null; rights: Handoff; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(kind: "set" | "release") {
    setBusy(true); setNote(null);
    try {
      if (kind === "set") await serviceCall(scope, "whatsapp.handoff.set", { conversation_id: id });
      else await serviceSlot(scope, "whatsapp.handoff.release", { conversation_id: id });
      setNote({ ok: true, text: kind === "set" ? "Taken over. FavCRM's AI is paused on this conversation." : "Handed back. FavCRM's AI may reply automatically again." });
    } catch (e) {
      const reason = kind === "release" && declinedReason(e).cancelled ? "the card was cancelled." : errorText(e, "the host refused it.");
      setNote({ ok: false, text: `${kind === "set" ? "Not taken over" : "Not handed back"}: ${reason}` });
    }
    setBusy(false); onChanged();
  }
  if (!handoffAt && !note && !rights.set) return null;
  return <div className="waba-assist" aria-label="Takeover">
    {handoffAt
      ? <Notice state="taken-over"><strong>Taken over.</strong> FavCRM&apos;s AI is paused on this conversation since {when(handoffAt)}.</Notice>
      : rights.set && <p className="waba-muted">FavCRM&apos;s AI may reply automatically here. Replying yourself pauses it.</p>}
    {(handoffAt ? rights.release : rights.set) && <div className="waba-head">
      {handoffAt
        ? <Button size="sm" loading={busy} onClick={() => { void run("release"); }}>Hand back to AI…</Button>
        : <Button size="sm" loading={busy} onClick={() => { void run("set"); }}>Take over</Button>}
    </div>}
    {note && (note.ok ? <p className="waba-muted" role="status">{note.text}</p> : <ErrorNotice bare>{note.text}</ErrorNotice>)}
  </div>;
}

/** One reply = prepare (host mints the effect and digest) → the host-drawn
 *  approval SLOT over exactly the prepared text. Nothing is retried. */
type Attempt = { text: string; effectId: string } & ({ state: "approving" } | { state: ReplyState } | { state: "checking" } | { state: "status"; status: ReplyStatus } | { state: "cancelled"; reason: string | null });

function Composer({ scope, conversationId, handoffAt, freeformUntil, open, autoTakeover, inserted, onSent, onChanged, onDirtyChange }: { scope: DisplayScope; conversationId: string; handoffAt: string | null; freeformUntil: string | null; open: boolean; autoTakeover: boolean; inserted: { text: string; n: number } | null; onSent: () => void; onChanged: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const zh = useScope()?.presentationLocale === "zh-TW";
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [text, open]);
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
  const outcome = attempt && <Outcome attempt={attempt} linked={scope.provider === "linked"} group={conversationId.endsWith("@g.us")} onCheck={() => { void check(attempt, undefined, true); }} onApproveAgain={() => { void approve(attempt); }} onDismiss={() => setAttempt(null)} />;
  if (!open) return <div className="waba-composer">{outcome}<Notice state="window-closed">The 24-hour reply window is closed, so free text can&apos;t be sent to this customer. An approved template can still be sent.</Notice></div>;
  const review = zh ? "檢查並核准回覆" : "Review reply";
  return <div className="waba-composer">
    {outcome}
    {error && <ErrorNotice bare>{error}</ErrorNotice>}
    <form className="waba-compose-box" onSubmit={e => { e.preventDefault(); if (open && !locked) void send(); }}>
      <textarea ref={input} aria-label={zh ? "回覆" : "Reply"} placeholder={zh ? "輸入回覆…" : "Write a reply…"} rows={1} maxLength={4096} value={text} disabled={busy || locked} onChange={e => setText(e.target.value)} onKeyDown={e => {
        if (e.key !== "Enter" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        if (!e.repeat && !busy && !locked) void send();
      }} />
      <div className="waba-compose-foot">
        {text && !busy && !locked && <Button size="sm" variant="ghost" onClick={() => { setText(""); input.current?.focus(); }}>{zh ? "清除草稿" : "Clear draft"}</Button>}
        <span className="waba-muted">{zh ? "Enter 檢查回覆 · Shift+Enter 換行" : "Enter to review · Shift+Enter for a new line"}{freeformUntil && scope.provider !== "linked" ? ` · ${when(freeformUntil)}` : ""}</span>
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
