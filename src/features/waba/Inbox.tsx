import { Button,EmptyState,ErrorNotice,Field,Loading,Notice } from "@cadence/screen-ui";
import { useCallback,useEffect,useState } from "react";
import { patchRoute } from "../../bridge/route";
import { routeId,type DisplayScope } from "../../bridge/scope";
import { serviceCall,serviceSlot } from "../../bridge/services";
import type { Recipient } from "./Templates";
import { errorText,parseConversation,parseConversations,parseMessages,parsePrepared,parseReplyStatus,sendState,when,windowOpen,type Conversation,type ConversationRow,type Message,type ReplyState,type ReplyStatus } from "./door";

const PAGE = 25;
type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "failed"; text: string };

export default function Inbox({ scope, canReply, canTemplate, routeId: routed, onRecipient }: { scope: DisplayScope; canReply: boolean; canTemplate: boolean; routeId: string | null; onRecipient: (r: Recipient) => void }) {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [list, setList] = useState<"loading" | "ok" | "more" | string>("loading");
  const [filter, setFilter] = useState("");
  // Ids outside the host route grammar stay a local selection.
  const [local, setLocal] = useState<string | null>(null);
  const selected = routed ?? local;
  const page = useCallback(async (after: string | null) => {
    setList(after ? "more" : "loading");
    try {
      const got = parseConversations(await serviceCall(scope, "whatsapp.conversations.list", { limit: PAGE, ...(after ? { cursor: after } : {}) }));
      setRows(r => after ? [...r, ...got.rows.filter(n => !r.some(o => o.conversationId === n.conversationId))] : got.rows);
      setCursor(got.cursor); setList("ok");
    } catch (e) { setList(errorText(e, "The conversation list could not be read.")); }
  }, [scope]);
  useEffect(() => { void page(null); }, [page]);
  function select(id: string | null) {
    if (id === null || routeId(id)) { setLocal(null); void patchRoute({ section: "inbox", view: "list", record_id: id }).catch(() => undefined); }
    else setLocal(id);
  }
  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter(r => [r.contact.name, r.contact.phone, r.lastMessage?.body].some(v => v?.toLowerCase().includes(needle))) : rows;
  const failed = list !== "loading" && list !== "ok" && list !== "more";
  return <section className="waba-page waba-inbox" data-selected={selected ? "yes" : "no"} aria-label="Inbox">
    <div className="waba-list" aria-labelledby="waba-inbox-title">
      <header className="waba-head">
        <h1 id="waba-inbox-title">Inbox</h1>
        <Button size="sm" onClick={() => { void page(null); }} loading={list === "loading"}>Refresh</Button>
      </header>
      <Field label="Filter loaded conversations">{c => <input {...c} className="field" type="search" value={filter} onChange={e => setFilter(e.target.value)} />}</Field>
      {list === "loading" && !rows.length ? <Loading>Reading conversations…</Loading>
        : failed ? <ErrorNotice onRetry={() => { void page(null); }}>{list}</ErrorNotice>
        : !shown.length ? <EmptyState title={needle ? "No loaded conversation matches" : "No conversations yet"} name="conversations">{needle ? "Load more or clear the filter." : "New WhatsApp conversations appear here after a refresh."}</EmptyState>
        : <ul className="waba-rows">{shown.map(r => <li key={r.conversationId}>
            <button type="button" className="waba-row" aria-current={r.conversationId === selected ? "true" : undefined} onClick={() => select(r.conversationId)}>
              <span className="waba-row-name">{r.contact.name ?? r.contact.phone ?? "Unknown contact"}{r.unreadCount ? <span className="waba-badge" aria-label={`${r.unreadCount} unread`}>{r.unreadCount}</span> : null}</span>
              <span className="waba-row-last">{r.lastMessage?.direction === "outbound" ? "You: " : ""}{r.lastMessage?.body ?? ""}</span>
              <span className="waba-muted">{when(r.lastMessage?.createdAt ?? null)}{windowOpen(r) ? "" : " · window closed"}</span>
            </button>
          </li>)}</ul>}
      {cursor && !failed && <Button size="sm" onClick={() => { void page(cursor); }} loading={list === "more"}>Load more</Button>}
    </div>
    <div className="waba-thread">
      {selected ? <Thread key={selected} scope={scope} id={selected} canReply={canReply} canTemplate={canTemplate} onRecipient={onRecipient} onBack={() => select(null)} />
        : <EmptyState title="Select a conversation" name="thread">Messages and the reply composer appear here.</EmptyState>}
    </div>
  </section>;
}

function Thread({ scope, id, canReply, canTemplate, onRecipient, onBack }: { scope: DisplayScope; id: string; canReply: boolean; canTemplate: boolean; onRecipient: (r: Recipient) => void; onBack: () => void }) {
  const [conversation, setConversation] = useState<Load<Conversation>>({ state: "loading" });
  const [messages, setMessages] = useState<Load<{ rows: Message[]; cursor: string | null }>>({ state: "loading" });
  const show = useCallback(async () => {
    try { setConversation({ state: "ok", value: parseConversation(await serviceCall(scope, "whatsapp.conversations.show", { conversation_id: id })) }); }
    catch (e) { setConversation({ state: "failed", text: errorText(e, "The conversation could not be read.") }); }
  }, [scope, id]);
  const read = useCallback(async (after: string | null = null) => {
    try {
      const got = parseMessages(await serviceCall(scope, "whatsapp.messages", { conversation_id: id, limit: 50, ...(after ? { cursor: after } : {}) }));
      setMessages(m => ({ state: "ok", value: { rows: after && m.state === "ok" ? [...m.value.rows, ...got.rows.filter(n => !m.value.rows.some(o => o.id === n.id))] : got.rows, cursor: got.cursor } }));
    } catch (e) { setMessages({ state: "failed", text: errorText(e, "Messages could not be read.") }); }
  }, [scope, id]);
  const reload = useCallback(() => { void show(); void read(); }, [show, read]);
  useEffect(() => { reload(); }, [reload]);
  const c = conversation.state === "ok" ? conversation.value : null;
  const ordered = messages.state === "ok" ? [...messages.value.rows].sort((a, b) => (Date.parse(a.createdAt ?? "") || 0) - (Date.parse(b.createdAt ?? "") || 0)) : [];
  return <article className="waba-card waba-conversation" aria-labelledby="waba-thread-title">
    <header className="waba-head">
      <Button size="sm" variant="ghost" className="waba-back" onClick={onBack}>Back</Button>
      <h2 id="waba-thread-title">{c ? c.contact.name ?? c.contact.phone ?? "Unknown contact" : "Conversation"}</h2>
      <Button size="sm" onClick={reload}>Refresh</Button>
    </header>
    {conversation.state === "loading" ? <Loading>Reading the conversation…</Loading>
      : conversation.state === "failed" ? <ErrorNotice onRetry={() => { void show(); }}>{conversation.text}</ErrorNotice>
      : <p className="waba-muted">{c!.contact.phone ?? ""}{c!.status ? ` · ${c!.status}` : ""} · last inbound {when(c!.lastInboundAt)}</p>}
    {messages.state === "loading" ? <Loading>Reading messages…</Loading>
      : messages.state === "failed" ? <ErrorNotice onRetry={() => { void read(); }}>{messages.text}</ErrorNotice>
      : <>
        {messages.value.cursor && <Button size="sm" onClick={() => { void read(messages.value.cursor); }}>Load older messages</Button>}
        {!ordered.length ? <EmptyState title="No messages" name="messages" /> : <ol className="waba-messages" aria-label="Messages">{ordered.map(m =>
          <li key={m.id} className="waba-message" data-direction={m.direction === "outbound" ? "outbound" : "inbound"}>
            <p>{m.body ?? (m.type ? `[${m.type}]` : "")}</p>
            <span className="waba-muted">{when(m.createdAt)}{m.status ? ` · ${m.status}` : ""}</span>
          </li>)}</ol>}
      </>}
    {c && (canReply ? <Composer scope={scope} conversation={c} onChanged={reload} />
      : <Notice state="read-only">You can read this inbox. Only the workspace operator can reply.</Notice>)}
    {c && canTemplate && <Button size="sm" onClick={() => { onRecipient(c); void patchRoute({ section: "templates", view: "list", record_id: null }).catch(() => undefined); }}>Send an approved template…</Button>}
  </article>;
}

/** One reply = prepare (host mints the effect and digest) → the host-drawn
 *  approval SLOT over exactly the prepared text. Nothing is retried. */
type Attempt = { text: string; effectId: string } & ({ state: "approving" } | { state: ReplyState } | { state: "checking" } | { state: "status"; status: ReplyStatus } | { state: "cancelled" });

function Composer({ scope, conversation, onChanged }: { scope: DisplayScope; conversation: Conversation; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const open = windowOpen(conversation);
  async function approve(frozen: { text: string; effectId: string }) {
    setAttempt({ ...frozen, state: "approving" });
    try {
      // The SLOT carries the exact prepared text; the host recomputes the
      // digest and refuses any difference.
      const done = await serviceSlot(scope, "whatsapp.reply.send", { conversation_id: conversation.conversationId, text: frozen.text, effect_id: frozen.effectId });
      const state = sendState(done);
      setAttempt({ ...frozen, state });
      if (state === "sent" || state === "uncertain") setText("");
    } catch {
      // A refused card may be a cancel or a host refusal: the host record decides.
      await check(frozen, true);
    }
    onChanged();
  }
  async function check(frozen: { text: string; effectId: string }, afterRefusal = false) {
    setAttempt({ ...frozen, state: "checking" });
    try {
      const status = parseReplyStatus(await serviceCall(scope, "whatsapp.reply.status", { effect_id: frozen.effectId }));
      const cancelled = afterRefusal && status.state === "prepared";
      setAttempt(cancelled ? { ...frozen, state: "cancelled" } : { ...frozen, state: "status", status });
      // Anything that may have left the host is never offered for resend.
      if (!cancelled && !["prepared", "failed", "refused"].includes(status.state)) setText("");
    } catch { setAttempt({ ...frozen, state: "uncertain" }); setText(""); }
  }
  async function send() {
    const frozen = text;
    if (!frozen.trim() || busy) return;
    setBusy(true); setError(null); setAttempt(null);
    try {
      const prepared = parsePrepared(await serviceCall(scope, "whatsapp.reply.prepare", { conversation_id: conversation.conversationId, text: frozen }));
      await approve({ text: frozen, effectId: prepared.effect_id });
    } catch (e) {
      // Refusal codes are generic here; the re-read shows a closed window.
      setError(errorText(e, "The reply could not be prepared. Nothing was sent."));
      onChanged();
    } finally { setBusy(false); }
  }
  // While an attempt's outcome is open, the composer is locked so the same
  // reply is never sent twice. The outcome stays visible if the window closes.
  const locked = !!attempt && !["sent", "failed", "refused", "cancelled"].includes(attempt.state);
  const outcome = attempt && <Outcome attempt={attempt} onCheck={() => { void check(attempt); }} onApproveAgain={() => { void approve(attempt); }} onDismiss={() => setAttempt(null)} />;
  if (!open) return <div className="waba-composer">{outcome}<Notice state="window-closed">The 24-hour reply window is closed, so free text can&apos;t be sent to this customer. An approved template can still be sent.</Notice></div>;
  return <form className="waba-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
    {outcome}
    {error && <ErrorNotice bare>{error}</ErrorNotice>}
    <Field label="Reply" hint={`Window open until ${when(conversation.freeformUntil)}. You approve the exact text before it is sent.`}>
      {c => <textarea {...c} className="field" rows={3} maxLength={4096} value={text} disabled={busy || locked} onChange={e => setText(e.target.value)} />}
    </Field>
    <Button type="submit" variant="primary" loading={busy} disabled={locked || !text.trim()}>Send…</Button>
  </form>;
}

function Outcome({ attempt, onCheck, onApproveAgain, onDismiss }: { attempt: Attempt; onCheck: () => void; onApproveAgain: () => void; onDismiss: () => void }) {
  const quote = <blockquote className="waba-quote">{attempt.text}</blockquote>;
  switch (attempt.state) {
    case "approving": return <Notice state="approving">Waiting for your approval in the Cadence card…</Notice>;
    case "checking": return <Loading>Reading this reply&apos;s recorded status…</Loading>;
    case "sent": return <Notice state="sent">Sent: FavCRM accepted the reply. Delivery shows on the message once WhatsApp reports it. <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></Notice>;
    case "failed": return <ErrorNotice>Failed: FavCRM did not send this reply. Your text is still in the composer. <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></ErrorNotice>;
    case "refused": return <ErrorNotice>Refused: the reply was not sent (for example the window closed or the approval was declined). <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></ErrorNotice>;
    case "cancelled": return <Notice state="cancelled">Not sent: the approval was cancelled. <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></Notice>;
    case "pending": return <Notice state="pending">Waiting for the owner&apos;s approval in AgenticOS. Nothing has been sent. Once it is approved, confirm the same reply again.{quote}
      <Button size="sm" onClick={onApproveAgain}>Confirm this reply again</Button></Notice>;
    case "status": return <Notice state={`status-${attempt.status.state}`}>Recorded status: <strong>{attempt.status.state}</strong>{attempt.status.door ? ` (door: ${attempt.status.door})` : ""}. Check the messages above; this reply is never resent automatically.{quote}
      <Button size="sm" onClick={onCheck}>Check again</Button> <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></Notice>;
    default: return <ErrorNotice>Uncertain: Cadence can&apos;t tell whether this reply was sent, so it will never be resent. Check its status and the messages above before replying again.{quote}
      <Button size="sm" onClick={onCheck}>Check status</Button></ErrorNotice>;
  }
}
