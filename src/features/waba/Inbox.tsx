import { ApiError,Button,EmptyState,ErrorNotice,Field,Loading,Notice } from "@cadence/screen-ui";
import { Fragment,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
import { patchRoute } from "../../bridge/route";
import { routable,useOnPush,useScope,type DisplayScope } from "../../bridge/scope";
import { serviceCall,serviceSlot } from "../../bridge/services";
import type { Recipient } from "./Templates";
import { declinedReason,errorText,parseConversation,parseConversations,parseDraft,parseMessages,parsePrepared,parseReplyStatus,sendState,when,windowOpen,type Conversation,type ConversationRow,type Draft,type Message,type ReplyState,type ReplyStatus } from "./door";

const PAGE = 25;
/** What the copilot may show, derived from the host-granted actions (members get the draft read-only). */
export interface Assist { show: boolean; brief: boolean; open: boolean; discard: boolean }
/** Takeover actions the host granted; the banner itself is shown to everyone. */
export interface Handoff { set: boolean; release: boolean }
const DRAFT_POLL_MS = 5000;
type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "failed"; text: string };

function contactName(row: ConversationRow, scope: DisplayScope) {
  return row.contact.name ?? row.contact.phone ?? (scope.provider === "linked" ? row.conversationId : "Unknown contact");
}

function Avatar({ name }: { name: string }) {
  return <span className="waba-avatar" aria-hidden="true">{Array.from(name.trim()).slice(0, 2).join("").toLocaleUpperCase()}</span>;
}

const dayFormat = { en: new Intl.DateTimeFormat("en", { dateStyle: "medium" }), zh: new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium" }) };
const timeFormat = { en: new Intl.DateTimeFormat("en", { timeStyle: "short" }), zh: new Intl.DateTimeFormat("zh-TW", { timeStyle: "short" }) };
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

export default function Inbox({ scope, canReply, canTemplate, assist, handoff, routeId: routed, onRecipient, replyDirty, onDirtyChange, openSettings }: { scope: DisplayScope; canReply: boolean; canTemplate: boolean; assist: Assist; handoff: Handoff; routeId: string | null; onRecipient: (r: Recipient) => void; replyDirty: boolean; onDirtyChange: (dirty: boolean) => void; openSettings: () => Promise<unknown> }) {
  const zh = useScope()?.presentationLocale === "zh-TW", locale = zh ? "zh" : "en";
  const linked = scope.provider === "linked";
  const providerName = linked ? (zh ? "已連結裝置" : "Linked device") : (zh ? "官方 API" : "Official API");
  const [settingsError, setSettingsError] = useState(false);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [list, setList] = useState<"loading" | "indexing" | "ok" | "more" | "failed">("loading");
  const listRequest = useRef(0);
  const foregroundList = useRef(false);
  const [filter, setFilter] = useState("");
  // Ids outside the host route grammar stay a local selection.
  const [local, setLocal] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState(false);
  const selected = routed ?? local;
  const openRow = useRef<HTMLElement | null>(null);
  const focusThread = useRef(false);
  const thread = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!focusThread.current) return;
    focusThread.current = false;
    if (newMessage || selected) thread.current?.querySelector<HTMLElement>("h2")?.focus();
    else openRow.current?.focus({ preventScroll: true });
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
      setRows(r => after ? [...r, ...got.rows.filter(n => !r.some(o => o.conversationId === n.conversationId))]
        : quiet ? [...got.rows, ...r.filter(o => !got.rows.some(n => n.conversationId === o.conversationId))] : got.rows);
      setCursor(c => quiet && c ? c : got.cursor); setList("ok");
    } catch { if (request === listRequest.current && !quiet) setList("failed"); }
    finally { if (!quiet && request === listRequest.current) foregroundList.current = false; }
  }, [scope]);
  useEffect(() => { void page(null); return () => { listRequest.current++; foregroundList.current = false; }; }, [page]);
  useOnPush(() => page(null, true));
  function select(id: string | null) {
    setNewMessage(false);
    focusThread.current = true;
    if (scope.provider === "linked") { setLocal(id); return; }
    if (id === null || routable(id)) { setLocal(null); void patchRoute({ section: "inbox", view: "list", record_id: id }).catch(() => undefined); }
    else { setLocal(id); void patchRoute({ section: "inbox", view: "list", record_id: null }).catch(() => undefined); }
  }
  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter(r => [r.contact.name, r.contact.phone, r.lastMessage?.body, ...(scope.provider === "linked" ? [r.conversationId] : [])].some(v => v?.toLowerCase().includes(needle))) : rows;
  const failed = list === "failed";
  const today = dayFormat[locale].format(Date.now());
  return <section className="waba-page waba-inbox" data-selected={newMessage || selected ? "yes" : "no"} aria-label={zh ? "收件匣" : "Inbox"}>
    <div className="waba-list" aria-labelledby="waba-inbox-title">
      <header className="waba-list-head">
        <div className="waba-head">
          <h1 id="waba-inbox-title" tabIndex={-1}>{zh ? "收件匣" : "Inbox"}</h1>
          {linked && canReply && <Button size="sm" variant="primary" disabled={replyDirty} onClick={e => { openRow.current = e.currentTarget; focusThread.current = true; setLocal(null); setNewMessage(true); }}>{zh ? "新增訊息" : "New message"}</Button>}
        </div>
        <button className="waba-provider-link" type="button" disabled={replyDirty}
          aria-label={zh ? `${providerName}：連線設定` : `${providerName}: Connection settings`}
          onClick={() => { setSettingsError(false); void openSettings().catch(() => setSettingsError(true)); }}>
          {providerName}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
        </button>
        {settingsError && <ErrorNotice bare>{zh ? "無法開啟設定，請從側欄選取設定。" : "Couldn’t open Settings. Choose Settings in the sidebar."}</ErrorNotice>}
        <input className="field waba-search" type="search" aria-label={zh ? "搜尋已載入對話" : "Search loaded conversations"} placeholder={zh ? "搜尋對話…" : "Search conversations…"} value={filter} onChange={e => setFilter(e.target.value)} />
      </header>
      <div className="waba-list-scroll">
      {list === "indexing" && rows.length > 0 && <p className="waba-muted" role="status">Indexing older conversations…</p>}
      {(list === "loading" || list === "indexing") && !rows.length ? <Loading>{list === "indexing" ? "Indexing older conversations…" : "Reading conversations…"}</Loading>
        : failed ? <ErrorNotice onRetry={() => { void page(null); }}>
          <strong>{zh ? `無法載入${providerName}收件匣。` : `Couldn’t load the ${providerName} inbox.`}</strong>
          <p>{zh ? "可以重試，或到連線設定檢查狀態及切換連線。" : "Retry here, or open connection settings to check status or choose the other connection."}</p>
        </ErrorNotice>
        : !shown.length ? <EmptyState title={needle ? "No matching conversations" : "No conversations yet"} name="conversations">{needle ? "Search covers loaded conversations. Load more or clear the search." : "New WhatsApp conversations appear here."}</EmptyState>
        : <ul className="waba-rows">{shown.map(r => {
          const name = contactName(r, scope), at = stamp(r.lastMessage?.createdAt ?? null);
          return <li key={r.conversationId}>
            <button type="button" className="waba-row" disabled={replyDirty} aria-current={r.conversationId === selected ? "true" : undefined} onClick={e => { openRow.current = e.currentTarget; select(r.conversationId); }}>
              <Avatar name={name} />
              <span className="waba-row-name">{name}</span>
              {at === null ? <span /> : <time className="waba-row-time" dateTime={r.lastMessage?.createdAt ?? undefined}>{dayFormat[locale].format(at) === today ? timeFormat[locale].format(at) : dayFormat[locale].format(at)}</time>}
              <span className="waba-row-last">{r.lastMessage?.direction === "outbound" ? "You: " : ""}{r.lastMessage?.body ?? ""}</span>
              {r.unreadCount ? <span className="waba-badge" aria-label={`${r.unreadCount} unread`}>{r.unreadCount}</span> : null}
            </button>
          </li>;
        })}</ul>}
        {cursor && !failed && <div className="waba-page-more"><Button size="sm" onClick={() => { void page(cursor); }} loading={list === "more" || list === "indexing"}>Load more</Button></div>}
      </div>
    </div>
    <div ref={thread} className="waba-thread">
      {newMessage ? <NewLinkedReply scope={scope} dirty={replyDirty} onDirtyChange={onDirtyChange} onBack={() => select(null)} onChanged={() => { void page(null, true); }} />
        : selected ? <Thread key={selected} scope={scope} id={selected} canReply={canReply} canTemplate={canTemplate} assist={assist} handoff={handoff} onRecipient={onRecipient} onDirtyChange={onDirtyChange} onBack={() => select(null)} replyDirty={replyDirty} />
        : <div className="waba-thread-empty"><EmptyState title={zh ? "選擇對話" : "Select a conversation"} name="thread">{zh ? "在左側選擇對話，即可查看記錄及回覆。" : "Open a conversation to read its history and reply."}</EmptyState></div>}
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

function Thread({ scope, id, canReply, canTemplate, assist, handoff, onRecipient, onDirtyChange, onBack, replyDirty }: { scope: DisplayScope; id: string; canReply: boolean; canTemplate: boolean; assist: Assist; handoff: Handoff; onRecipient: (r: Recipient) => void; onDirtyChange: (dirty: boolean) => void; onBack: () => void; replyDirty: boolean }) {
  const zh = useScope()?.presentationLocale === "zh-TW";
  const unavailablePreview = zh ? "無法顯示預覽" : "Preview unavailable";
  const [conversation, setConversation] = useState<Load<Conversation>>({ state: "loading" });
  const [messages, setMessages] = useState<Load<{ rows: Message[]; cursor: string | null }>>({ state: "loading" });
  const [indexing, setIndexing] = useState(false);
  const messageRequest = useRef(0);
  const foregroundMessages = useRef(false);
  const timeline = useRef<HTMLDivElement>(null);
  const keepBottom = useRef(true);
  const prependHeight = useRef<number | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [details, setDetails] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const closeDetailsButton = useRef<HTMLButtonElement>(null);
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
    detailsButton.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => { if (details) closeDetailsButton.current?.focus({ preventScroll: true }); }, [details]);
  useLayoutEffect(() => {
    const pane = timeline.current;
    if (!pane) return;
    if (prependHeight.current !== null && !foregroundMessages.current) {
      pane.scrollTop += pane.scrollHeight - prependHeight.current;
      prependHeight.current = null;
    } else if (keepBottom.current) pane.scrollTop = pane.scrollHeight;
  }, [messages, details]);
  useLayoutEffect(() => {
    const pane = timeline.current;
    if (!pane) return;
    const observer = new ResizeObserver(() => {
      if (keepBottom.current && prependHeight.current === null) pane.scrollTop = pane.scrollHeight;
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  // `quiet` is a host-push refresh: shown data stays on a failed read, and
  // messages already loaded stay (newer rows win by id).
  const show = useCallback(async (quiet = false) => {
    try { setConversation({ state: "ok", value: parseConversation(await serviceCall(scope, "whatsapp.conversations.show", { conversation_id: id })) }); }
    catch (e) { setConversation(c => quiet && c.state === "ok" ? c : { state: "failed", text: errorText(e, "The conversation could not be read.") }); }
  }, [scope, id]);
  const read = useCallback(async (after: string | null = null, quiet = false) => {
    if (quiet && foregroundMessages.current) return;
    const request = ++messageRequest.current;
    if (!quiet) { foregroundMessages.current = true; setIndexing(false); }
    try {
      const got = await readWhileIndexing(
        async () => parseMessages(await serviceCall(scope, "whatsapp.messages", { conversation_id: id, limit: 50, ...(after ? { cursor: after } : {}) })),
        () => request === messageRequest.current,
        () => setIndexing(true),
      );
      if (!got) return;
      setIndexing(false);
      setMessages(m => m.state === "ok" && (after || quiet)
        ? { state: "ok", value: { rows: after ? [...m.value.rows, ...got.rows.filter(n => !m.value.rows.some(o => o.id === n.id))] : [...got.rows, ...m.value.rows.filter(o => !got.rows.some(n => n.id === o.id))], cursor: quiet ? m.value.cursor : got.cursor } }
        : { state: "ok", value: { rows: got.rows, cursor: got.cursor } });
    } catch (e) {
      if (request !== messageRequest.current) return;
      setIndexing(false);
      setMessages(m => quiet && m.state === "ok" ? m : { state: "failed", text: errorText(e, "Messages could not be read.") });
    }
    finally { if (!quiet && request === messageRequest.current) foregroundMessages.current = false; }
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
  useEffect(() => { reload(); return () => { messageRequest.current++; foregroundMessages.current = false; }; }, [reload]);
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
  const title = c ? contactName(c, scope) : "Conversation";
  const group = id.endsWith("@g.us");
  const subtitle = group ? (zh ? "WhatsApp 群組" : "WhatsApp group") : c?.contact.phone;
  const photos = details ? ordered.filter(m => m.previewJpeg !== null) : [];
  const locale = zh ? "zh" : "en";
  const day = dayFormat[locale], time = timeFormat[locale];
  const loadOlder = (cursor: string) => {
    if (foregroundMessages.current) return;
    prependHeight.current = timeline.current?.scrollHeight ?? null;
    void read(cursor);
  };
  return <article className="waba-conversation" data-details={details} aria-labelledby="waba-thread-title" onKeyDown={e => {
    if (details && e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); closeDetails(); }
  }}>
    <header className="waba-thread-head">
      <Button size="sm" variant="ghost" className="waba-back" disabled={replyDirty} onClick={onBack}>{zh ? "返回" : "Back"}</Button>
      <h2 id="waba-thread-title" tabIndex={-1}>
        {c ? <button className="waba-details-trigger" ref={detailsButton} type="button" aria-expanded={details} aria-controls="waba-contact-details" aria-label={zh ? `${title}：${group ? "群組詳情" : "聯絡人詳情"}` : `${title}: ${group ? "Group details" : "Contact details"}`} onClick={() => details ? closeDetails() : setDetails(true)}>
          <Avatar name={title} />
          <span className="waba-thread-identity">{title}{subtitle && subtitle !== title && <small className="waba-muted">{subtitle}</small>}</span>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7.5 3v10m-4-10h9A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3Z" /></svg>
        </button> : title}
      </h2>
    </header>
    <div className="waba-conversation-body">
      <div className="waba-thread-main">
        <div className="waba-history">
          <div className="waba-timeline" tabIndex={0} role="region" aria-label={zh ? "訊息記錄" : "Message history"} ref={timeline} onKeyDown={e => {
            // Native Home/End scroll animations can continue after Jump to latest.
            if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "Home" && e.key !== "End")) return;
            e.preventDefault();
            const pane = e.currentTarget;
            pane.scrollTo({ top: e.key === "Home" ? 0 : pane.scrollHeight, behavior: "instant" });
          }} onScroll={() => {
            const pane = timeline.current;
            if (!pane) return;
            keepBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 72;
            setShowLatest(!keepBottom.current);
          }}>
            <div className="waba-timeline-inner">
              {conversation.state === "loading" ? <Loading>Reading the conversation…</Loading>
                : conversation.state === "failed" ? <ErrorNotice onRetry={() => { void show(); }}>{conversation.text}</ErrorNotice> : null}
              {messages.state === "loading" ? <Loading>{indexing ? "Indexing older messages…" : "Reading messages…"}</Loading>
                : messages.state === "failed" ? <ErrorNotice onRetry={() => { void read(); }}>{messages.text}</ErrorNotice>
                : <>
                  {messages.value.cursor && <div className="waba-history-more"><Button size="sm" loading={indexing} onClick={() => loadOlder(messages.value.cursor!)}>Load older messages</Button></div>}
                  {!ordered.length ? <EmptyState title="No messages" name="messages" /> : <ol className="waba-messages" aria-label="Messages">{ordered.map((m, index) => {
                    const at = stamp(m.createdAt), previous = stamp(ordered[index - 1]?.createdAt ?? null);
                    const date = at === null ? null : day.format(at);
                    return <Fragment key={m.id}>
                      {date && (previous === null || day.format(previous) !== date) && <li className="waba-date">{date}</li>}
                      <li className="waba-message" data-direction={m.direction === "outbound" ? "outbound" : "inbound"}>
                        {scope.provider === "linked" && m.type === "unsupported"
                          ? m.previewJpeg
                            ? <PhotoPreview key={m.previewJpeg} jpeg={m.previewJpeg} label={zh ? "相片預覽" : "Photo preview"} unavailable={unavailablePreview} />
                            : <p className="waba-muted">{unavailablePreview}</p>
                          : <p>{m.body ?? (m.type ? `[${m.type}]` : "")}</p>}
                        {(at !== null || m.status) && <div className="waba-message-meta waba-muted">{at !== null && <time dateTime={m.createdAt!}>{time.format(at)}</time>}{m.status && <span>{m.status}</span>}</div>}
                      </li>
                    </Fragment>;
                  })}</ol>}
                </>}
            </div>
          </div>
          {showLatest && <div className="waba-jump"><Button size="sm" onClick={jumpToLatest}>{zh ? "跳至最新訊息" : "Jump to latest"}</Button></div>}
        </div>
        {c && <footer className="waba-thread-footer">
          <TakeoverBar scope={scope} id={id} handoffAt={c.handoffAt} rights={handoff} onChanged={() => { void show(); }} />
          {assist.brief && <Brief scope={scope} id={id} canOpen={assist.open} />}
          {draft && <DraftChip draft={draft} canInsert={canReply && windowOpen(c)} canDiscard={assist.discard} note={assistNote} onInsert={() => setInserted(i => ({ text: draft.text, n: (i?.n ?? 0) + 1 }))} onDiscard={() => { void discard(); }} />}
          {canReply ? <Composer scope={scope} conversationId={c.conversationId} handoffAt={c.handoffAt} freeformUntil={c.freeformUntil} open={scope.provider === "linked" || windowOpen(c)} autoTakeover={handoff.set} inserted={inserted} onSent={onSent} onChanged={reload} onDirtyChange={onDirtyChange} />
            : <Notice state="read-only">You can read this inbox. Only the workspace operator can reply.</Notice>}
          {canTemplate && <Button size="sm" onClick={() => { onRecipient(c); void patchRoute({ section: "templates", view: "list", record_id: null }).catch(() => undefined); }}>Send an approved template…</Button>}
        </footer>}
      </div>
      {c && <aside id="waba-contact-details" className="waba-contact-details" aria-labelledby="waba-contact-title" hidden={!details}>
        <header className="waba-head"><h3 id="waba-contact-title">{group ? (zh ? "群組詳情" : "Group details") : (zh ? "聯絡人詳情" : "Contact details")}</h3><button className="btn" type="button" ref={closeDetailsButton} onClick={closeDetails}>{zh ? "關閉" : "Close"}</button></header>
        <div className="waba-contact-profile"><Avatar name={title} /><strong>{title}</strong></div>
        {(subtitle || c.status || c.lastInboundAt) && <dl className="waba-contact-facts">
          {subtitle && <div><dt>{group ? (zh ? "類型" : "Type") : (zh ? "電話" : "Phone")}</dt><dd>{subtitle}</dd></div>}
          {c.status && <div><dt>{zh ? "狀態" : "Status"}</dt><dd>{c.status}</dd></div>}
          {c.lastInboundAt && <div><dt>{zh ? "最後收到訊息" : "Last inbound"}</dt><dd>{when(c.lastInboundAt)}</dd></div>}
        </dl>}
        <section aria-label={zh ? "已分享的媒體" : "Shared media"}>
          <h4>{zh ? "已分享的媒體" : "Shared media"}</h4>
          {photos.length ? <ul className="waba-contact-media">{photos.map(m => <li key={m.id}><PhotoPreview jpeg={m.previewJpeg!} label={zh ? "相片預覽" : "Photo preview"} unavailable={unavailablePreview} /></li>)}</ul>
            : <p className="waba-muted">{zh ? "已載入的訊息沒有相片預覽。" : "No photo previews in loaded messages."}</p>}
        </section>
      </aside>}
    </div>
  </article>;
}

function PhotoPreview({ jpeg, label, unavailable }: { jpeg: string; label: string; unavailable: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="waba-muted">{unavailable}</p>
    : <img className="waba-photo-preview" src={`data:image/jpeg;base64,${jpeg}`} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
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
