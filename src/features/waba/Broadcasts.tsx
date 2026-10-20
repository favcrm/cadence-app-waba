import { Button,Detail,EmptyState,ErrorNotice,Field,Loading,Notice,Select } from "@cadence/screen-ui";
import { useCallback,useEffect,useRef,useState,type ReactNode } from "react";
import { patchRoute } from "../../bridge/route";
import { routable,useOnPush,type DisplayScope } from "../../bridge/scope";
import { serviceCall,serviceSlot,type Audience } from "../../bridge/services";
import { declinedReason,errorText,when } from "./door";
import { bodyIndexes,excluded,parseBroadcast,parseBroadcasts,parseDraft,parseEstimate,parsePrepared,parseResults,parseStop,parseTemplates,sendOutcome,testLimit,valueOk,type Broadcast,type BroadcastRow,type Estimate,type Result,type SendState,type Template } from "./door2";
import { statusLabel } from "./Templates";

/** Display affordances only, derived from the host-granted actions; the host
 *  refuses every write it did not grant. Members get the reads. */
export interface BroadcastRights { draft: boolean; estimate: boolean; test: boolean; send: boolean; stop: boolean }
type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "failed"; text: string };
interface DraftInput { name: string; templateId: string; parameters: string[]; source: "segment" | "individual"; segmentId: string; accounts: string }
const EMPTY: DraftInput = { name: "", templateId: "", parameters: [], source: "segment", segmentId: "", accounts: "" };
const STOPPABLE = ["SCHEDULED", "SENDING", "PARTIALLY_SENT"];
const BILLING = "Meta charges your WhatsApp Business Account per delivered marketing message.";
const go = (patch: { view?: "list" | "new"; record_id?: string | null }) => { void patchRoute({ section: "broadcasts", ...patch }).catch(() => undefined); };
const stats = (s: Record<string, number>) => Object.entries(s).map(([k, v]) => `${k} ${v}`).join(" · ") || "—";

export default function Broadcasts({ scope, rights, routeId: routed, creating }: { scope: DisplayScope; rights: BroadcastRights; routeId: string | null; creating: boolean }) {
  const [rows, setRows] = useState<BroadcastRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [list, setList] = useState<"loading" | "ok" | "more" | string>("loading");
  const [local, setLocal] = useState<string | null>(null);
  const selected = routed ?? local;
  // `quiet` is a host-push refresh: no loading state, loaded pages kept, errors
  // leave what is shown in place.
  const page = useCallback(async (after: string | null, quiet = false) => {
    if (!quiet) setList(after ? "more" : "loading");
    try {
      const got = parseBroadcasts(await serviceCall(scope, "whatsapp.broadcasts.list", { limit: 50, ...(after ? { cursor: after } : {}) }));
      setRows(r => after ? [...r, ...got.rows.filter(n => !r.some(o => o.broadcastId === n.broadcastId))]
        : quiet ? [...got.rows, ...r.filter(o => !got.rows.some(n => n.broadcastId === o.broadcastId))] : got.rows);
      setCursor(c => quiet && c ? c : got.cursor); setList(l => l === "more" ? l : "ok");
    } catch (e) { if (!quiet) setList(errorText(e, "The broadcast list could not be read.")); }
  }, [scope]);
  useEffect(() => { void page(null); }, [page]);
  useOnPush(() => page(null, true));
  function select(id: string | null) {
    if (id === null || routable(id)) { setLocal(null); go({ view: "list", record_id: id }); }
    else { setLocal(id); go({ view: "list", record_id: null }); }
  }
  const saved = (id: string) => { void page(null); select(id); };
  const failed = !["loading", "ok", "more"].includes(list);
  const open = creating || !!selected;
  return <section className="waba-page waba-split" data-selected={open ? "yes" : "no"} aria-label="Broadcasts">
    <div className="waba-list" aria-labelledby="waba-broadcasts-title">
      <header className="waba-head">
        <h1 id="waba-broadcasts-title">Broadcasts</h1>
        {rights.draft && <Button size="sm" variant="primary" onClick={() => { setLocal(null); go({ view: "new", record_id: null }); }}>New draft</Button>}
        <Button size="sm" onClick={() => { void page(null); }} loading={list === "loading"}>Refresh</Button>
      </header>
      {list === "loading" && !rows.length ? <Loading>Reading broadcasts…</Loading>
        : failed ? <ErrorNotice onRetry={() => { void page(null); }}>{list}</ErrorNotice>
        : !rows.length ? <EmptyState title="No broadcasts yet" name="broadcasts">{rights.draft ? "Start with a new draft." : "Broadcasts the operator creates appear here."}</EmptyState>
        : <ul className="waba-rows">{rows.map(b => <li key={b.broadcastId}>
            <button type="button" className="waba-row" aria-current={b.broadcastId === selected ? "true" : undefined} onClick={() => select(b.broadcastId)}>
              <span className="waba-row-name">{b.name || "Untitled broadcast"}</span>
              <span className="waba-muted">{statusLabel(b.status)}{b.recipientCount !== null ? ` · ${b.recipientCount} recipients` : ""} · {b.sentAt ? `sent ${when(b.sentAt)}` : b.scheduledAt ? `scheduled ${when(b.scheduledAt)}` : `created ${when(b.createdAt)}`}</span>
            </button>
          </li>)}</ul>}
      {cursor && !failed && <Button size="sm" onClick={() => { void page(cursor); }} loading={list === "more"}>Load more</Button>}
    </div>
    <div className="waba-thread">
      {creating && rights.draft ? <article className="waba-card"><DraftForm scope={scope} initial={EMPTY} onSaved={saved} onCancel={() => go({ view: "list" })} /></article>
        : selected ? <BroadcastDetail key={selected} scope={scope} id={selected} rights={rights} onSaved={saved} onBack={() => select(null)} />
        : <EmptyState title="Select a broadcast" name="broadcast">Its status, audience and results appear here.</EmptyState>}
    </div>
  </section>;
}

function BroadcastDetail({ scope, id, rights, onSaved, onBack }: { scope: DisplayScope; id: string; rights: BroadcastRights; onSaved: (id: string) => void; onBack: () => void }) {
  const [read, setRead] = useState<Load<Broadcast>>({ state: "loading" });
  // Edit keeps the id; a clone of a final broadcast is a new draft.
  const [editing, setEditing] = useState<{ initial: DraftInput; broadcastId?: string } | null>(null);
  // A send or stop changes the status that shows its panel, so its outcome lives here.
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const show = useCallback(async (quiet = false) => {
    try { setRead({ state: "ok", value: parseBroadcast(await serviceCall(scope, "whatsapp.broadcast.show", { broadcast_id: id })) }); }
    catch (e) { setRead(r => quiet && r.state === "ok" ? r : { state: "failed", text: errorText(e, "The broadcast could not be read.") }); }
  }, [scope, id]);
  useEffect(() => { void show(); }, [show]);
  useOnPush(() => show(true));
  const b = read.state === "ok" ? read.value : null;
  const input = (b: Broadcast, clone: boolean): DraftInput => ({ name: clone ? `${b.name} (copy)`.slice(0, 200) : b.name, templateId: b.template?.templateId ?? "", parameters: b.bodyParameters,
    source: b.audience.source === "individual" ? "individual" : "segment", segmentId: b.audience.segmentId ?? "", accounts: b.audience.accountIds.join("\n") });
  if (editing) return <article className="waba-card"><DraftForm scope={scope} initial={editing.initial} broadcastId={editing.broadcastId} onSaved={saved => { setEditing(null); if (saved === id) void show(); onSaved(saved); }} onCancel={() => setEditing(null)} /></article>;
  return <article className="waba-card" aria-labelledby="waba-broadcast-title">
    <header className="waba-head">
      <Button size="sm" variant="ghost" className="waba-back" onClick={onBack}>Back</Button>
      <h2 id="waba-broadcast-title">{b ? b.name || "Untitled broadcast" : "Broadcast"}</h2>
      <Button size="sm" onClick={() => { void show(); }}>Refresh</Button>
    </header>
    {read.state === "loading" ? <Loading>Reading the broadcast…</Loading>
      : read.state === "failed" ? <ErrorNotice onRetry={() => { void show(); }}>{read.text}</ErrorNotice>
      : <>
        <Detail label="Broadcast" items={[
          { key: "status", term: "Status", value: statusLabel(b!.status) },
          { key: "template", term: "Template", value: b!.template ? `${b!.template.name} (${b!.template.language}) · revised ${when(b!.template.revision)}` : "—" },
          { key: "variables", term: "Variables", value: b!.bodyParameters.join(" · ") || "None" },
          { key: "audience", term: "Audience", value: b!.audience.source === "segment" ? `Segment ${b!.audience.segmentId ?? "—"}` : `${b!.audience.accountIds.length} selected accounts` },
          { key: "scheduled", term: "Scheduled", value: when(b!.scheduledAt) },
          { key: "sent", term: "Sent", value: when(b!.sentAt) },
          { key: "stats", term: "Delivery", value: stats(b!.deliveryStats) },
          ...(b!.errorMessage ? [{ key: "error", term: "Error", value: b!.errorMessage }] : []),
        ]} />
        {outcome}
        {b!.status === "DRAFT" && <>
          {rights.draft && <Button size="sm" onClick={() => setEditing({ initial: input(b!, false), broadcastId: b!.broadcastId })}>Edit draft</Button>}
          {rights.estimate && <EstimatePanel scope={scope} id={b!.broadcastId} />}
          {rights.test && <TestPanel scope={scope} id={b!.broadcastId} />}
          {rights.send && <SendPanel scope={scope} id={b!.broadcastId} onOutcome={setOutcome} onChanged={() => { void show(); }} />}
          {!rights.draft && !rights.send && <Notice state="read-only">You can read broadcasts and their results. Only the workspace operator can edit, test or send them.</Notice>}
        </>}
        {STOPPABLE.includes(b!.status) && rights.stop && <StopPanel scope={scope} id={b!.broadcastId} onOutcome={setOutcome} onChanged={() => { void show(); }} />}
        {b!.status === "STOPPED" && <Notice state="stopped">Stopped broadcasts are final and can&apos;t resume. {rights.draft && <Button size="sm" onClick={() => setEditing({ initial: input(b!, true) })}>Clone to send again</Button>}</Notice>}
        {b!.status !== "DRAFT" && <ResultsPanel scope={scope} id={b!.broadcastId} />}
      </>}
  </article>;
}

function DraftForm({ scope, initial, broadcastId, onSaved, onCancel }: { scope: DisplayScope; initial: DraftInput; broadcastId?: string; onSaved: (id: string) => void; onCancel: () => void }) {
  const [form, setForm] = useState(initial);
  const [templates, setTemplates] = useState<Load<Template[]>>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void (async () => {
    try { setTemplates({ state: "ok", value: parseTemplates(await serviceCall(scope, "whatsapp.templates.list", { status: "approved" })).filter(t => t.sendable) }); }
    catch (e) { setTemplates({ state: "failed", text: errorText(e, "The template list could not be read.") }); }
  })(); }, [scope]);
  const template = templates.state === "ok" ? templates.value.find(t => t.templateId === form.templateId) ?? null : null;
  const indexes = template ? bodyIndexes(template.bodyText) : [];
  const accounts = form.accounts.split(/[\s,]+/).filter(Boolean);
  const problem = !form.name.trim() || form.name.length > 200 ? "Name the broadcast (up to 200 characters)."
    : !template ? "Choose an approved template."
    : indexes.some((_, i) => !valueOk(form.parameters[i] ?? "")) ? "Fill every variable: 1–1024 characters, no leading or trailing spaces."
    : form.source === "segment" ? (!/^[A-Za-z0-9_.:-]{1,128}$/.test(form.segmentId) ? "Enter the FavCRM segment id." : null)
    : !accounts.length || accounts.length > 1000 || accounts.some(a => !/^[A-Za-z0-9_.:-]{1,128}$/.test(a)) ? "Enter 1 to 1000 account ids, one per line." : null;
  async function save() {
    if (problem || busy || !template) return;
    const audience: Audience = form.source === "segment" ? { source: "segment", segment_id: form.segmentId } : { source: "individual", account_ids: accounts };
    setBusy(true); setError(null);
    try { onSaved(parseDraft(await serviceCall(scope, "whatsapp.broadcast.draft", { ...(broadcastId ? { broadcast_id: broadcastId } : {}), name: form.name.trim(), template_id: template.templateId, body_parameters: indexes.map((_, i) => form.parameters[i]), audience }))); }
    catch (e) { setError(errorText(e, "The draft could not be saved.")); }
    finally { setBusy(false); }
  }
  return <form className="waba-composer" onSubmit={e => { e.preventDefault(); void save(); }}>
    <h2>{broadcastId ? "Edit draft" : "New draft"}</h2>
    <p className="waba-muted">Saving a draft sends nothing. Estimate, test and send come after.</p>
    <Field label="Name">{c => <input {...c} className="field" value={form.name} maxLength={200} onChange={e => setForm({ ...form, name: e.target.value })} />}</Field>
    {templates.state === "loading" ? <Loading>Reading approved templates…</Loading>
      : templates.state === "failed" ? <ErrorNotice>{templates.text}</ErrorNotice>
      : <Field label="Approved template">{c => <Select id={c.id} full value={form.templateId} placeholder="Choose a template" onChange={v => setForm({ ...form, templateId: v, parameters: [] })}
          options={templates.value.map(t => ({ value: t.templateId, label: `${t.name} (${t.language})` }))} />}</Field>}
    {template && <blockquote className="waba-quote">{template.bodyText}</blockquote>}
    {indexes.map((n, i) => <Field key={n} label={`Variable {{${n}}}`} hint="Plain text, or FavCRM personalisation such as {{contact.name}}.">
      {c => <input {...c} className="field" value={form.parameters[i] ?? ""} maxLength={1024} onChange={e => { const p = [...form.parameters]; p[i] = e.target.value; setForm({ ...form, parameters: p }); }} />}
    </Field>)}
    <Field label="Audience">{c => <Select id={c.id} full value={form.source} onChange={v => setForm({ ...form, source: v === "individual" ? "individual" : "segment" })}
      options={[{ value: "segment", label: "A FavCRM segment" }, { value: "individual", label: "Individual accounts (up to 1000)" }]} />}</Field>
    {form.source === "segment"
      ? <Field label="Segment id">{c => <input {...c} className="field" value={form.segmentId} onChange={e => setForm({ ...form, segmentId: e.target.value.trim() })} />}</Field>
      : <Field label="Account ids" hint={`${accounts.length} of at most 1000`}>{c => <textarea {...c} className="field" rows={4} value={form.accounts} onChange={e => setForm({ ...form, accounts: e.target.value })} />}</Field>}
    <p className="waba-muted">Only contacts with marketing consent and no WhatsApp opt-out are sent to; FavCRM checks again at send.</p>
    {error && <ErrorNotice bare>{error}</ErrorNotice>}
    {problem && <p className="waba-muted">{problem}</p>}
    <div className="waba-head"><Button type="submit" variant="primary" loading={busy} disabled={!!problem}>Save draft</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
  </form>;
}

function EstimatePanel({ scope, id }: { scope: DisplayScope; id: string }) {
  const [read, setRead] = useState<Load<Estimate> | null>(null);
  async function estimate() {
    setRead({ state: "loading" });
    try { setRead({ state: "ok", value: parseEstimate(await serviceCall(scope, "whatsapp.broadcast.estimate", { broadcast_id: id })) }); }
    catch (e) { setRead({ state: "failed", text: errorText(e, "The estimate could not be read.") }); }
  }
  const e = read?.state === "ok" ? read.value : null;
  return <section className="waba-composer" aria-label="Estimate">
    <div className="waba-head"><h3>Estimate</h3><Button size="sm" onClick={() => { void estimate(); }} loading={read?.state === "loading"}>{read ? "Estimate again" : "Estimate audience"}</Button></div>
    {read?.state === "failed" && <ErrorNotice>{read.text}</ErrorNotice>}
    {e && <>
      <Detail label="Estimate" items={[
        { key: "eligible", term: "Eligible", value: e.counts.eligible ?? 0 },
        { key: "excluded", term: "Excluded", value: `${excluded(e.counts)} (manually ${e.counts.manuallyExcluded ?? 0}, no number ${e.counts.missingAddress ?? 0}, no consent ${e.counts.missingConsent ?? 0}, opted out ${e.counts.optedOut ?? 0})` },
        { key: "total", term: "Audience total", value: e.counts.total ?? 0 },
      ]} />
      {!e.valid && <ErrorNotice>Not ready to send: {e.errors.join(" ") || "FavCRM refused this draft."}</ErrorNotice>}
      {e.preview && <blockquote className="waba-quote">{e.preview}</blockquote>}
    </>}
  </section>;
}

type Effect = { state: "approving" } | { state: "cancelled"; reason?: string | null } | { state: SendState; code: string | null };
const done = (e: Effect | null) => !!e && ["accepted", "sent", "failed", "refused", "cancelled"].includes(e.state);

function TestPanel({ scope, id }: { scope: DisplayScope; id: string }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [effect, setEffect] = useState<Effect & { masked?: string | null; effectId?: string } | null>(null);
  const valid = /^\+[1-9][0-9]{7,14}$/.test(to);
  async function approve(effectId: string, masked: string | null) {
    setEffect({ state: "approving", masked, effectId });
    try { setEffect({ ...sendOutcome(await serviceSlot(scope, "whatsapp.broadcast.test.send", { effect_id: effectId })), masked, effectId }); }
    catch (e) { setEffect({ state: "cancelled", reason: hostReason(e), masked, effectId }); }
  }
  async function send() {
    if (!valid || busy) return;
    setBusy(true); setError(null); setEffect(null);
    try { const p = parsePrepared(await serviceCall(scope, "whatsapp.broadcast.test.prepare", { broadcast_id: id, to }), "wbt_"); await approve(p.effect_id, p.to); }
    // The host relays a door refusal generically, so the cap is named as a possible cause.
    catch (e) { const text = errorText(e, "The test could not be prepared."); setError(testLimit(text) ? LIMIT : `${text} Nothing was sent. If this broadcast already had 5 test sends in the last 24 hours, that limit is the reason; try again later.`); }
    finally { setBusy(false); }
  }
  const locked = !!effect && !done(effect);
  return <form className="waba-composer" aria-label="Test send" onSubmit={e => { e.preventDefault(); void send(); }}>
    <h3>Test send</h3>
    <Field label="Test number" hint="One number in international format, for example +85255550999. At most 5 tests per broadcast in 24 hours." error={to && !valid ? "Use + and the country code, 8 to 15 digits." : undefined}>
      {c => <input {...c} className="field" type="tel" inputMode="tel" autoComplete="off" value={to} disabled={busy || locked} onChange={e => setTo(e.target.value.replace(/[\s()-]/g, ""))} />}
    </Field>
    {effect && <EffectNotice effect={effect} what="test" onApproveAgain={() => { if (effect.effectId) void approve(effect.effectId, effect.masked ?? null); }} />}
    {error && <ErrorNotice bare>{error}</ErrorNotice>}
    <Button type="submit" loading={busy} disabled={!valid || locked}>Send test…</Button>
  </form>;
}
/** The host's own words for a refused card; nothing for the person's cancel. */
const hostReason = (e: unknown) => { const d = declinedReason(e); return d.cancelled ? null : d.text; };
const LIMIT = "Test limit reached: at most 5 test sends per broadcast in 24 hours. Try again later.";

function SendPanel({ scope, id, onOutcome, onChanged }: { scope: DisplayScope; id: string; onOutcome: (n: ReactNode) => void; onChanged: () => void }) {
  const [mode, setMode] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [effect, setEffect] = useState<Effect & { effectId?: string } | null>(null);
  // Q8: from now + 5 minutes to now + 7 days; the host checks again.
  const local = (ms: number) => { const d = new Date(ms); d.setSeconds(0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const atMs = at ? new Date(at).getTime() : NaN;
  const inRange = mode === "now" || (atMs >= Date.now() + 5 * 60000 && atMs <= Date.now() + 7 * 86400000);
  async function approve(effectId: string) {
    setEffect({ state: "approving", effectId });
    try {
      const out = sendOutcome(await serviceSlot(scope, "whatsapp.broadcast.send", { effect_id: effectId }));
      setEffect({ ...out, effectId });
      if (out.state !== "pending") onOutcome(<EffectNotice effect={out} what="broadcast" onApproveAgain={() => undefined} />);
    } catch (e) { setEffect({ state: "cancelled", reason: hostReason(e), effectId }); }
    onChanged();
  }
  async function send() {
    if (!inRange || busy) return;
    setBusy(true); setError(null); setEffect(null); onOutcome(null);
    try { await approve(parsePrepared(await serviceCall(scope, "whatsapp.broadcast.prepare", { broadcast_id: id, ...(mode === "later" ? { send_at: new Date(atMs).toISOString() } : {}) }), "wab_").effect_id); }
    catch (e) { setError(errorText(e, "The review could not be prepared. Nothing was scheduled.")); }
    finally { setBusy(false); }
  }
  const locked = !!effect && !done(effect);
  return <form className="waba-composer" aria-label="Send" onSubmit={e => { e.preventDefault(); void send(); }}>
    <h3>Review and send</h3>
    <Field label="When">{c => <Select id={c.id} full value={mode} disabled={busy || locked} onChange={v => setMode(v === "later" ? "later" : "now")}
      options={[{ value: "now", label: "Send now (after a 60-second undo window)" }, { value: "later", label: "Schedule" }]} />}</Field>
    {mode === "later" && <Field label="Send at" hint="Between 5 minutes and 7 days from now, in your local time." error={at && !inRange ? "Pick a time 5 minutes to 7 days ahead." : undefined}>
      {c => <input {...c} className="field" type="datetime-local" value={at} min={local(Date.now() + 5 * 60000)} max={local(Date.now() + 7 * 86400000)} disabled={busy || locked} onChange={e => setAt(e.target.value)} />}
    </Field>}
    <p className="waba-muted">FavCRM freezes the audience for your review; opt-outs are rechecked at send, so the count can only fall. Numbers above your Meta messaging limit fail and appear in results. {BILLING}</p>
    {effect && ["approving", "pending", "cancelled"].includes(effect.state) && <EffectNotice effect={effect} what="broadcast" onApproveAgain={() => { if (effect.effectId) void approve(effect.effectId); }} />}
    {error && <ErrorNotice bare>{error}</ErrorNotice>}
    <Button type="submit" variant="primary" loading={busy} disabled={locked || (mode === "later" && (!at || !inRange))}>Review and send…</Button>
  </form>;
}

function EffectNotice({ effect, what, onApproveAgain }: { effect: Effect & { masked?: string | null }; what: "test" | "broadcast"; onApproveAgain: () => void }) {
  const code = "code" in effect && effect.code ? ` (${effect.code})` : "";
  switch (effect.state) {
    case "approving": return <Notice state="approving">Waiting for your approval in the Cadence card…</Notice>;
    case "cancelled": return <Notice state="cancelled">{"reason" in effect && effect.reason ? `Not approved: ${effect.reason}` : "Not approved: the card was cancelled or the host refused it."} {what === "test" ? "No test was sent." : "Refresh to read the broadcast's status."}</Notice>;
    case "accepted": return what === "test"
      ? <Notice state="accepted">Queued: FavCRM accepted the test{effect.masked ? ` for ${effect.masked}` : ""}. That is not a delivery; check the phone.</Notice>
      : <Notice state="accepted">Scheduled: FavCRM accepted the broadcast. Accepted is not delivered; per-recipient results appear below as WhatsApp reports them.</Notice>;
    case "pending": return <Notice state="pending">Waiting for the owner&apos;s approval in AgenticOS. Nothing has been sent. Once it is approved, confirm again. <Button size="sm" onClick={onApproveAgain}>Confirm again</Button></Notice>;
    case "refused": return <ErrorNotice>{"code" in effect && testLimit(effect.code) ? LIMIT : `Refused${code}: nothing was ${what === "test" ? "sent" : "scheduled"}.${what === "broadcast" ? " Prepare a new review if the draft changed." : ""}`}</ErrorNotice>;
    case "failed": return <ErrorNotice>Failed{code}: FavCRM did not accept this {what}.</ErrorNotice>;
    case "sent": return <Notice state="accepted">Accepted by FavCRM. That is not a delivery.</Notice>;
    default: return <ErrorNotice>Uncertain{code}: Cadence can&apos;t tell whether FavCRM accepted this {what}, so it will never be resent. Refresh the broadcast before trying again.</ErrorNotice>;
  }
}

function StopPanel({ scope, id, onOutcome, onChanged }: { scope: DisplayScope; id: string; onOutcome: (n: ReactNode) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const setText = (t: { ok: boolean; text: string }) => onOutcome(t.ok ? <Notice state="stop-result">{t.text}</Notice> : <ErrorNotice>{t.text}</ErrorNotice>);
  async function stop() {
    setBusy(true); onOutcome(null);
    let answer: unknown;
    try { answer = await serviceSlot(scope, "whatsapp.broadcast.stop", { broadcast_id: id }); }
    catch (e) { setText({ ok: false, text: `Not stopped: ${errorText(e, "the card was cancelled or the host refused it.")}` }); setBusy(false); onChanged(); return; }
    try {
      const s = parseStop(answer);
      setText({ ok: true, text: s.status === "DRAFT" ? "Returned to draft: it was still inside the undo window, so nothing was sent."
        : `Stopped: ${s.cancelled ?? 0} unsent recipients cancelled. ${s.alreadySent ?? 0} already sent can't be recalled. A stopped broadcast is final.` });
    } catch { setText({ ok: false, text: "The stop was confirmed but its answer was not understood. The status above is read again." }); }
    setBusy(false); onChanged();
  }
  return <section className="waba-composer" aria-label="Stop">
    <div className="waba-head"><h3>Stop</h3><Button size="sm" variant="danger" loading={busy} onClick={() => { void stop(); }}>Stop broadcast…</Button></div>
    <p className="waba-muted">Stops unsent recipients only. Messages already sent can&apos;t be recalled, and a stopped broadcast can&apos;t resume.</p>
  </section>;
}

function ResultsPanel({ scope, id }: { scope: DisplayScope; id: string }) {
  const [rows, setRows] = useState<Result[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "more" | string>("loading");
  // Results carry no id to merge on, so a host-push refresh skips a list the
  // person has paged past its first page (Refresh reads it again).
  const deep = useRef(false);
  const page = useCallback(async (after: string | null, quiet = false) => {
    if (quiet && deep.current) return;
    if (!quiet) setState(after ? "more" : "loading");
    try {
      const got = parseResults(await serviceCall(scope, "whatsapp.broadcast.results", { broadcast_id: id, limit: 50, ...(after ? { cursor: after } : {}) }));
      deep.current = !!after;
      setRows(r => after ? [...r, ...got.rows] : got.rows); setTotal(got.total); setCursor(got.cursor); setState("ok");
    } catch (e) { if (!quiet) setState(errorText(e, "Results could not be read.")); }
  }, [scope, id]);
  useEffect(() => { void page(null); }, [page]);
  useOnPush(() => page(null, true));
  const failed = !["loading", "ok", "more"].includes(state);
  return <section className="waba-composer" aria-label="Results">
    <div className="waba-head"><h3>Results{total !== null ? ` (${total})` : ""}</h3><Button size="sm" onClick={() => { void page(null); }} loading={state === "loading"}>Refresh</Button></div>
    {state === "loading" && !rows.length ? <Loading>Reading results…</Loading>
      : failed ? <ErrorNotice onRetry={() => { void page(null); }}>{state}</ErrorNotice>
      : !rows.length ? <EmptyState title="No results yet" name="results">Per-recipient results appear as WhatsApp reports them.</EmptyState>
      : <ul className="waba-rows">{rows.map((r, i) => <li key={i} className="waba-result">
          <span className="waba-row-name">{r.contactName ?? "Unknown contact"} <span className="waba-muted">{r.phone ?? ""}</span></span>
          <span className="waba-muted">{r.status} · {when(r.at)}{r.error ? ` · ${r.error}` : ""}</span>
        </li>)}</ul>}
    {cursor && !failed && <Button size="sm" onClick={() => { void page(cursor); }} loading={state === "more"}>Load more</Button>}
  </section>;
}
