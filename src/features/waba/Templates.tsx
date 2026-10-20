import { Button,Detail,EmptyState,ErrorNotice,Field,Loading,Notice } from "@cadence/screen-ui";
import { useCallback,useEffect,useState } from "react";
import { patchRoute } from "../../bridge/route";
import { routeId,type DisplayScope } from "../../bridge/scope";
import { serviceCall,serviceSlot } from "../../bridge/services";
import { errorText,parseConversations,parseReplyStatus,when,windowOpen,type ConversationRow,type ReplyStatus } from "./door";
import { bodyIndexes,parsePrepared,parseTemplate,parseTemplates,render,sendOutcome,valueOk,type SendState,type Template } from "./door2";

/** The conversation a template goes to. It lives above the section switch,
 *  so it survives page navigation inside this frame. */
export type Recipient = Pick<ConversationRow, "conversationId" | "contact" | "replyMode" | "freeformUntil">;
type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "failed"; text: string };
export const statusLabel = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

export default function Templates({ scope, canSend, routeId: routed, recipient, onRecipient }: { scope: DisplayScope; canSend: boolean; routeId: string | null; recipient: Recipient | null; onRecipient: (r: Recipient | null) => void }) {
  const [all, setAll] = useState(false);
  const [list, setList] = useState<Load<Template[]>>({ state: "loading" });
  const [local, setLocal] = useState<string | null>(null);
  const selected = routed ?? local;
  const load = useCallback(async () => {
    setList({ state: "loading" });
    try { setList({ state: "ok", value: parseTemplates(await serviceCall(scope, "whatsapp.templates.list", { status: all ? "all" : "approved" })) }); }
    catch (e) { setList({ state: "failed", text: errorText(e, "The template list could not be read.") }); }
  }, [scope, all]);
  useEffect(() => { void load(); }, [load]);
  function select(id: string | null) {
    if (id === null || routeId(id)) { setLocal(null); void patchRoute({ section: "templates", view: "list", record_id: id }).catch(() => undefined); }
    else setLocal(id);
  }
  return <section className="waba-page waba-split" data-selected={selected ? "yes" : "no"} aria-label="Templates">
    <div className="waba-list" aria-labelledby="waba-templates-title">
      <header className="waba-head">
        <h1 id="waba-templates-title">Templates</h1>
        <Button size="sm" onClick={() => { void load(); }} loading={list.state === "loading"}>Refresh</Button>
      </header>
      <label className="waba-check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Show every status, not only approved</label>
      {recipient && <p className="waba-muted">Sending to {recipient.contact.name ?? recipient.contact.phone ?? recipient.conversationId}</p>}
      {list.state === "loading" ? <Loading>Reading templates…</Loading>
        : list.state === "failed" ? <ErrorNotice onRetry={() => { void load(); }}>{list.text}</ErrorNotice>
        : !list.value.length ? <EmptyState title={all ? "No templates" : "No approved templates"} name="templates">Templates are created and approved in Meta through FavCRM.</EmptyState>
        : <ul className="waba-rows">{list.value.map(t => <li key={t.templateId}>
            <button type="button" className="waba-row" aria-current={t.templateId === selected ? "true" : undefined} onClick={() => select(t.templateId)}>
              <span className="waba-row-name">{t.name} <span className="waba-muted">{t.language}</span></span>
              <span className="waba-muted">{statusLabel(t.status)}{t.category ? ` · ${t.category}` : ""} · revised {when(t.revision)}</span>
            </button>
          </li>)}</ul>}
    </div>
    <div className="waba-thread">
      {selected ? <TemplateDetail key={selected} scope={scope} id={selected} canSend={canSend} recipient={recipient} onRecipient={onRecipient} onBack={() => select(null)} />
        : <EmptyState title="Select a template" name="template">Its status, revision and variables appear here.</EmptyState>}
    </div>
  </section>;
}

function TemplateDetail({ scope, id, canSend, recipient, onRecipient, onBack }: { scope: DisplayScope; id: string; canSend: boolean; recipient: Recipient | null; onRecipient: (r: Recipient | null) => void; onBack: () => void }) {
  const [read, setRead] = useState<Load<Template>>({ state: "loading" });
  const show = useCallback(async () => {
    setRead({ state: "loading" });
    try { setRead({ state: "ok", value: parseTemplate(await serviceCall(scope, "whatsapp.template.show", { template_id: id })) }); }
    catch (e) { setRead({ state: "failed", text: errorText(e, "The template could not be read.") }); }
  }, [scope, id]);
  useEffect(() => { void show(); }, [show]);
  const t = read.state === "ok" ? read.value : null;
  return <article className="waba-card" aria-labelledby="waba-template-title">
    <header className="waba-head">
      <Button size="sm" variant="ghost" className="waba-back" onClick={onBack}>Back</Button>
      <h2 id="waba-template-title">{t ? t.name : "Template"}</h2>
      <Button size="sm" onClick={() => { void show(); }}>Refresh</Button>
    </header>
    {read.state === "loading" ? <Loading>Reading the template…</Loading>
      : read.state === "failed" ? <ErrorNotice onRetry={() => { void show(); }}>{read.text}</ErrorNotice>
      : <>
        <Detail label="Template" items={[
          { key: "status", term: "Status", value: statusLabel(t!.status) },
          { key: "language", term: "Language", value: t!.language || "—" },
          { key: "category", term: "Category", value: t!.category ?? "—" },
          { key: "revision", term: "Revision", value: when(t!.revision) },
          { key: "header", term: "Header", value: t!.header.format && t!.header.format !== "NONE" ? `${statusLabel(t!.header.format)}${t!.header.text ? `: ${t!.header.text}` : ""}` : "None" },
          { key: "body", term: "Body", value: <span className="waba-pre">{t!.bodyText}</span> },
          { key: "footer", term: "Footer", value: t!.footerText ?? "None" },
          { key: "variables", term: "Variables", value: bodyIndexes(t!.bodyText).length ? bodyIndexes(t!.bodyText).map(n => `{{${n}}}${sample(t!, n) ? ` e.g. ${sample(t!, n)}` : ""}`).join(", ") : "None" },
        ]} />
        {!canSend ? <Notice state="read-only">You can read templates. Only the workspace operator can send one.</Notice>
          : !t!.sendable ? <Notice state="not-sendable">{t!.status === "APPROVED" ? "This approved template can't be sent from Cadence: it belongs to another number, or its header needs a variable or media." : "Only a template Meta has approved can be sent, so this one can't be used in a conversation."}</Notice>
          : <UseInConversation key={recipient?.conversationId ?? "none"} scope={scope} template={t!} recipient={recipient} onRecipient={onRecipient} />}
      </>}
  </article>;
}
const sample = (t: Template, n: number) => t.variables.find(v => v.index === n)?.sample ?? null;

/** One template send = prepare (the host reads the live template and mints
 *  the effect and digest) → the host-drawn SLOT over exactly the same
 *  conversation, template and variables. Nothing is retried. */
type Attempt = { effectId: string; variables: Record<string, string> } & ({ state: "approving" | "checking" | "cancelled" } | { state: SendState } | { state: "status"; status: ReplyStatus });

function UseInConversation({ scope, template, recipient, onRecipient }: { scope: DisplayScope; template: Template; recipient: Recipient | null; onRecipient: (r: Recipient | null) => void }) {
  const indexes = bodyIndexes(template.bodyText);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  if (!recipient) return <ConversationPicker scope={scope} onPick={onRecipient} />;
  const to = recipient;
  const invalid = indexes.filter(n => !valueOk(values[n] ?? ""));
  const args = (variables: Record<string, string>) => ({ conversation_id: to.conversationId, template_id: template.templateId, variables });
  async function approve(frozen: { effectId: string; variables: Record<string, string> }) {
    setAttempt({ ...frozen, state: "approving" });
    try { setAttempt({ ...frozen, state: sendOutcome(await serviceSlot(scope, "whatsapp.template.send", { effect_id: frozen.effectId, ...args(frozen.variables) })).state }); }
    catch { await check(frozen, true); }
  }
  async function check(frozen: { effectId: string; variables: Record<string, string> }, afterRefusal = false) {
    setAttempt({ ...frozen, state: "checking" });
    try {
      const status = parseReplyStatus(await serviceCall(scope, "whatsapp.template.status", { effect_id: frozen.effectId }));
      setAttempt(afterRefusal && status.state === "prepared" ? { ...frozen, state: "cancelled" } : { ...frozen, state: "status", status });
    } catch { setAttempt({ ...frozen, state: "uncertain" }); }
  }
  async function send() {
    if (busy || invalid.length) return;
    // Exactly the body indexes, byte for byte, in both the prepare and the SLOT.
    const variables = Object.fromEntries(indexes.map(n => [String(n), values[n]]));
    setBusy(true); setError(null); setAttempt(null);
    try { await approve({ effectId: parsePrepared(await serviceCall(scope, "whatsapp.template.prepare", args(variables)), "wat_").effect_id, variables }); }
    catch (e) { setError(errorText(e, "The template could not be prepared. Nothing was sent.")); }
    finally { setBusy(false); }
  }
  const locked = !!attempt && !["sent", "failed", "refused", "cancelled"].includes(attempt.state);
  return <form className="waba-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
    <h3>Use in conversation</h3>
    <p className="waba-muted">To <strong>{to.contact.name ?? to.contact.phone ?? to.conversationId}</strong>{to.contact.name && to.contact.phone ? ` · ${to.contact.phone}` : ""} · {windowOpen(to) ? "reply window open" : "reply window closed; an approved template may still be sent"}
      {" "}<Button size="sm" variant="ghost" disabled={busy || locked} onClick={() => onRecipient(null)}>Change</Button>
      {" "}<Button size="sm" variant="ghost" onClick={() => { void patchRoute({ section: "inbox", view: "list", record_id: routeId(to.conversationId) ? to.conversationId : null }).catch(() => undefined); }}>Open conversation</Button></p>
    {indexes.map(n => <Field key={n} label={`Variable {{${n}}}`} hint={sample(template, n) ? `Example: ${sample(template, n)}` : undefined} error={values[n] !== undefined && !valueOk(values[n]) ? "1–1024 characters, no leading or trailing spaces." : undefined}>
      {c => <input {...c} className="field" value={values[n] ?? ""} maxLength={1024} disabled={busy || locked} onChange={e => setValues(v => ({ ...v, [n]: e.target.value }))} />}
    </Field>)}
    <p className="waba-muted">Preview</p>
    <blockquote className="waba-quote">{render(template.bodyText, values)}</blockquote>
    {attempt && <Outcome attempt={attempt} onCheck={() => { void check(attempt); }} onApproveAgain={() => { void approve(attempt); }} onDismiss={() => setAttempt(null)} />}
    {error && <ErrorNotice bare>{error}</ErrorNotice>}
    <Button type="submit" variant="primary" loading={busy} disabled={locked || invalid.length > 0}>Send template…</Button>
  </form>;
}

function Outcome({ attempt, onCheck, onApproveAgain, onDismiss }: { attempt: Attempt; onCheck: () => void; onApproveAgain: () => void; onDismiss: () => void }) {
  const dismiss = <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>;
  switch (attempt.state) {
    case "approving": return <Notice state="approving">Waiting for your approval in the Cadence card…</Notice>;
    case "checking": return <Loading>Reading this send&apos;s recorded status…</Loading>;
    case "sent": return <Notice state="sent">Sent: FavCRM accepted the template message. Delivery shows in the conversation once WhatsApp reports it. {dismiss}</Notice>;
    case "accepted": return <Notice state="accepted">Accepted by FavCRM. That is not a delivery; check the conversation. {dismiss}</Notice>;
    case "failed": return <ErrorNotice>Failed: FavCRM did not send this template. {dismiss}</ErrorNotice>;
    case "refused": return <ErrorNotice>Refused: the template was not sent (for example it changed, is no longer approved, or the approval was declined). {dismiss}</ErrorNotice>;
    case "cancelled": return <Notice state="cancelled">Not sent: the approval was cancelled. {dismiss}</Notice>;
    case "pending": return <Notice state="pending">Waiting for the owner&apos;s approval in AgenticOS. Nothing has been sent. Once it is approved, confirm the same send again.
      {" "}<Button size="sm" onClick={onApproveAgain}>Confirm this send again</Button></Notice>;
    case "status": return <Notice state={`status-${attempt.status.state}`}>Recorded status: <strong>{attempt.status.state}</strong>{attempt.status.door ? ` (door: ${attempt.status.door})` : ""}. Check the conversation; this send is never repeated automatically.
      {" "}<Button size="sm" onClick={onCheck}>Check again</Button> {dismiss}</Notice>;
    default: return <ErrorNotice>Uncertain: Cadence can&apos;t tell whether this template was sent, so it will never be resent. Check its status and the conversation first.
      {" "}<Button size="sm" onClick={onCheck}>Check status</Button></ErrorNotice>;
  }
}

function ConversationPicker({ scope, onPick }: { scope: DisplayScope; onPick: (r: Recipient) => void }) {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "more" | string>("loading");
  const [filter, setFilter] = useState("");
  const page = useCallback(async (after: string | null) => {
    setState(after ? "more" : "loading");
    try {
      const got = parseConversations(await serviceCall(scope, "whatsapp.conversations.list", { limit: 25, ...(after ? { cursor: after } : {}) }));
      setRows(r => after ? [...r, ...got.rows.filter(n => !r.some(o => o.conversationId === n.conversationId))] : got.rows);
      setCursor(got.cursor); setState("ok");
    } catch (e) { setState(errorText(e, "The conversation list could not be read.")); }
  }, [scope]);
  useEffect(() => { void page(null); }, [page]);
  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter(r => [r.contact.name, r.contact.phone].some(v => v?.toLowerCase().includes(needle))) : rows;
  const failed = !["loading", "ok", "more"].includes(state);
  return <div className="waba-composer">
    <h3>Use in conversation</h3>
    <p className="waba-muted">Pick the conversation to send this template to. Your choice is kept while you move between pages.</p>
    <Field label="Filter loaded conversations">{c => <input {...c} className="field" type="search" value={filter} onChange={e => setFilter(e.target.value)} />}</Field>
    {state === "loading" ? <Loading>Reading conversations…</Loading>
      : failed ? <ErrorNotice onRetry={() => { void page(null); }}>{state}</ErrorNotice>
      : !shown.length ? <EmptyState title="No conversation to pick" name="recipients" />
      : <ul className="waba-rows">{shown.map(r => <li key={r.conversationId}>
          <button type="button" className="waba-row" onClick={() => onPick({ conversationId: r.conversationId, contact: r.contact, replyMode: r.replyMode, freeformUntil: r.freeformUntil })}>
            <span className="waba-row-name">{r.contact.name ?? r.contact.phone ?? "Unknown contact"}</span>
            <span className="waba-muted">{r.contact.phone ?? ""}{windowOpen(r) ? " · window open" : " · window closed"}</span>
          </button>
        </li>)}</ul>}
    {cursor && !failed && <Button size="sm" onClick={() => { void page(cursor); }} loading={state === "more"}>Load more</Button>}
  </div>;
}
