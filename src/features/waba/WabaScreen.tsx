import { ApiError,Button,EmptyState,ErrorNotice,Loading,Notice } from "@cadence/screen-ui";
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
import { patchRoute } from "../../bridge/route";
import { markUnreachable,routable,scopeError,useHostDirty,useScope } from "../../bridge/scope";
import Broadcasts from "./Broadcasts";
import AiAgent from "./AiAgent";
import Connection from "./Connection";
import { readPreferences,savePreferences,type Preferences,type Provider,type SavedPreferences } from "./preferences";
import Inbox from "./Inbox";
import Templates,{ type Recipient } from "./Templates";
import "./waba.css";

const tools = [
  { id: "templates", en: "Templates", zh: "訊息範本" },
  { id: "broadcasts", en: "Broadcasts", zh: "群發訊息" },
  { id: "ai", en: "AI agent", zh: "AI 助理" },
] as const;
type Tool = (typeof tools)[number]["id"];

function ToolsMenu({ zh, disabled, choose }: { zh: boolean; disabled: boolean; choose: (tool: Tool) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const shown = open && !disabled;
  return <nav className="waba-tools" aria-label={zh ? "官方 API 工具" : "Official API tools"} onBlur={e => {
    if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  }} onKeyDown={e => {
    if (e.key === "Escape" && shown) {
      e.stopPropagation();
      setOpen(false);
      anchor.current?.focus();
    }
  }}>
    <button id="waba-tools-trigger" className="btn waba-tools-trigger" type="button" ref={anchor} aria-expanded={shown} aria-controls="waba-tools-list" disabled={disabled} onClick={() => setOpen(value => !value)}>
      {zh ? "工具" : "Tools"}
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg>
    </button>
    <ul id="waba-tools-list" className="waba-tools-list" hidden={!shown}>{tools.map(item => <li key={item.id}>
      <Button variant="ghost" onClick={() => choose(item.id)}>{zh ? item.zh : item.en}</Button>
    </li>)}</ul>
  </nav>;
}
export default function WabaScreen() {
  const snapshot = useScope();
  // Keep a chosen recipient while moving between the official tools and the Inbox.
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [saved, setSaved] = useState<SavedPreferences | null | undefined>();
  const [readError, setReadError] = useState(false);
  const [saveError, setSaveError] = useState<"owner" | "uncertain" | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInProgress = useRef(false);
  const [pick, setPick] = useState<Provider | null>(null);
  const provider = saved?.profile.provider;
  const [frameDirty, setReplyDirty] = useState(false);
  const hostDirty = useHostDirty();
  const replyDirty = frameDirty || hostDirty;
  // The host re-pushes the scope every few seconds as a new object; pages key
  // their reads on this stable one, so a push never resets loaded data or forms.
  const installId = snapshot?.scope.installId, digest = snapshot?.digest;
  const installScope = useMemo(() => installId === undefined || digest === undefined ? null : { installId, digest }, [installId, digest]);
  const scope = useMemo(() => installScope && provider ? { ...installScope, ...(provider === "linked" ? { provider: "linked" as const } : {}) } : null, [installScope, provider]);
  const [readVersion, setReadVersion] = useState(0);
  const refresh = useCallback(() => { setSaveError(null); setReadVersion(n => n + 1); }, []);
  useEffect(() => {
    if (!installScope) return;
    let active = true;
    setSaved(undefined);
    setReadError(false);
    void readPreferences(installScope).then(value => { if (active) { setSaved(value); setPick(null); } }, () => { if (active) setReadError(true); });
    return () => { active = false; };
  }, [installScope, readVersion]);
  // No host push within the window: say the host is unreachable instead of waiting forever.
  useEffect(() => { const t = setTimeout(markUnreachable, 15000); return () => clearTimeout(t); }, []);
  const routeFocus = useRef<"inbox" | "connection" | null>(null);
  const [returnError, setReturnError] = useState(false);
  const [tool, setTool] = useState<Tool | null>(null);
  const [toolError, setToolError] = useState(false);
  const [localInboxId, setLocalInboxId] = useState<string | null>(null);
  const toolFocus = useRef(false);
  const section = snapshot?.route.section;
  useLayoutEffect(() => {
    if (routeFocus.current !== section) return;
    routeFocus.current = null;
    document.getElementById(section === "inbox" ? "waba-inbox-title" : "waba-provider-title")?.focus();
  }, [section]);
  useLayoutEffect(() => {
    if (!toolFocus.current || section !== "inbox") return;
    toolFocus.current = false;
    document.getElementById(tool ? `waba-${tool}-title` : "waba-tools-trigger")?.focus({ preventScroll: true });
  }, [section, tool]);
  useEffect(() => {
    if (section !== "inbox" || provider !== "official") {
      setTool(null);
      setLocalInboxId(null);
    }
    if (provider !== "official") setRecipient(null);
  }, [section, provider]);
  if (!snapshot || !installScope) return scopeError() ? <ErrorNotice>{scopeError()}</ErrorNotice> : <Loading>Waiting for the verified WhatsApp mount…</Loading>;
  const { route, actions } = snapshot;
  const zh = snapshot.presentationLocale === "zh-TW";
  async function go(section: "inbox" | "connection") {
    routeFocus.current = section;
    try { await patchRoute({ section, view: "list", record_id: null }); }
    catch (e) { routeFocus.current = null; throw e; }
  }
  function openTool(next: Tool, to?: Recipient) {
    if (provider !== "official" || replyDirty) return;
    if (to) setRecipient(to);
    setToolError(false);
    toolFocus.current = true;
    setTool(next);
  }
  async function closeTool(conversation?: string) {
    setToolError(false);
    if (conversation !== undefined) {
      const id = routable(conversation) ? conversation : null;
      if (id !== route.record_id) {
        try { await patchRoute({ section: "inbox", view: "list", record_id: id }); }
        catch { setToolError(true); return; }
      }
      setLocalInboxId(id === null ? conversation : null);
    } else setLocalInboxId(null);
    toolFocus.current = true;
    setTool(null);
  }
  // Display affordances only, derived from the host-granted actions (members
  // get the reads); the host independently refuses every write it did not grant.
  const can = (...verbs: string[]) => verbs.every(v => actions.includes(v));
  const canEdit = can("records.create", "records.update");
  async function apply(profile: Preferences) {
    if (!installScope || saved === undefined || replyDirty || saveInProgress.current || saveError || !canEdit) return;
    saveInProgress.current = true;
    setSaving(true);
    try {
      setSaved(await savePreferences(installScope, profile, saved?.revision ?? null));
      setPick(null);
    } catch (error) {
      setSaveError(error instanceof ApiError && error.code === "owner_required" ? "owner" : "uncertain");
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  }
  const linked = provider === "linked";
  const viewer = { canConnect: can("whatsapp.connect_session"), canReply: can("whatsapp.reply.prepare", "whatsapp.reply.send"), canTemplate: !linked && can("whatsapp.template.prepare", "whatsapp.template.send") };
  const rights = { draft: can("whatsapp.broadcast.draft"), estimate: can("whatsapp.broadcast.estimate"), test: can("whatsapp.broadcast.test.prepare", "whatsapp.broadcast.test.send"), send: can("whatsapp.broadcast.prepare", "whatsapp.broadcast.send"), stop: can("whatsapp.broadcast.stop") };
  const mode = saved?.profile.reply_mode ?? "copilot";
  // The copilot is offered only in copilot mode and only where the host granted its reads.
  const copilot = !linked && mode === "copilot" && can("whatsapp.draft.show");
  const handoff = { set: !linked && can("whatsapp.handoff.set"), release: !linked && can("whatsapp.handoff.release") };
  const assist = { show: copilot, brief: copilot && can("chat.whatsapp.brief"), open: copilot && can("chat.whatsapp.open"), discard: copilot && can("whatsapp.draft.discard") };
  const settings = route.section === "connection";
  const chosen = pick ?? provider;
  const saveNotice = saveError === "owner"
    ? <ErrorNotice bare>{zh ? "只有工作區擁有人可儲存設定。" : "Only a workspace owner can save these settings."}</ErrorNotice>
    : saveError && <ErrorNotice onRetry={refresh}>{zh ? "無法確認儲存結果，請重新讀取設定。" : "Couldn’t confirm the save. Reload the saved settings before trying again."}</ErrorNotice>;
  return <main className="app-outlet waba" key={`${installScope.installId}:${snapshot.digest}`}>
    {readError ? <ErrorNotice onRetry={refresh}>{zh ? "無法讀取此安裝的 WhatsApp 設定。" : "Couldn’t read the WhatsApp settings for this installation."}</ErrorNotice>
    : saved === undefined ? <Loading>{zh ? "正在讀取 WhatsApp 設定…" : "Reading WhatsApp settings…"}</Loading>
    : settings ? <div className="waba-settings">
      <header className="waba-head"><h1>{zh ? "設定" : "Settings"}</h1></header>
      <div className="waba-connection-picker">
        <fieldset className="waba-provider" aria-describedby="waba-provider-hint" disabled={!canEdit || replyDirty || saving || !!saveError}>
          <legend id="waba-provider-title" tabIndex={-1}>{zh ? "收件匣連線" : "Inbox connection"}</legend>
          <label><input type="radio" name="waba-provider" value="official" checked={chosen === "official"} onChange={() => setPick("official")} /> {zh ? "官方 API (FavCRM)" : "Official API (FavCRM)"}</label>
          <label><input type="radio" name="waba-provider" value="linked" checked={chosen === "linked"} onChange={() => setPick("linked")} /> {zh ? "已連結裝置" : "Linked device"}</label>
        </fieldset>
        <p id="waba-provider-hint" className="waba-muted">{!canEdit
          ? (zh ? "只有工作區擁有人可設定連線。" : "Only a workspace owner can set the connection.")
          : replyDirty ? (zh ? "請先儲存或取消目前的修改。" : "Save or cancel your changes before changing the connection.")
          : (zh ? "此安裝每次只使用一個連線。儲存不會中斷任何連線。" : "This installation uses one connection at a time. Saving doesn’t disconnect either provider.")}</p>
        <div className="waba-head">
          {canEdit && <Button size="sm" variant="primary" loading={saving} disabled={!chosen || chosen === provider || replyDirty || !!saveError}
            onClick={() => { if (chosen) void apply({ provider: chosen, reply_mode: mode }); }}>{zh ? "儲存連線" : "Save connection"}</Button>}
          {scope && <Button size="sm" disabled={saving || chosen !== provider} onClick={() => { setReturnError(false); void go("inbox").catch(() => setReturnError(true)); }}>{zh ? "開啟收件匣" : "Open Inbox"}</Button>}
        </div>
        {saveNotice}
        {returnError && <ErrorNotice bare>{zh ? "無法開啟收件匣，請從側欄選取收件匣。" : "Couldn’t open the Inbox. Choose Inbox in the sidebar."}</ErrorNotice>}
      </div>
      {linked && <Notice>{zh ? "只供測試帳戶使用。服務異常中止時，可能會遺失傳入訊息。" : "Test accounts only. Incoming messages can be lost after a crash."}</Notice>}
      {scope && <Connection key={provider} scope={scope} canConnect={viewer.canConnect} />}
    </div> : !scope ? <EmptyState name="connection" title={zh ? "選擇 WhatsApp 連線" : "Choose a WhatsApp connection"}>{zh ? "請由工作區擁有人在設定中選取連線。" : "A workspace owner needs to choose a connection in Settings."} <Button size="sm" onClick={() => { setReturnError(false); void go("connection").catch(() => setReturnError(true)); }}>{zh ? "開啟設定" : "Open Settings"}</Button>{returnError && <p>{zh ? "請在側欄選取設定。" : "Choose Settings in the sidebar."}</p>}</EmptyState>
      : provider === "official" && tool ? <div className="waba-tool-page">
        <Button size="sm" variant="ghost" onClick={() => { void closeTool(); }}>{zh ? "返回收件匣" : "Back to Inbox"}</Button>
        {toolError && <ErrorNotice bare>{zh ? "無法開啟對話。" : "Couldn’t open the conversation."}</ErrorNotice>}
        {tool === "templates" ? <Templates scope={scope} canSend={viewer.canTemplate} recipient={recipient} onRecipient={setRecipient} openConversation={id => { void closeTool(id); }} />
          : tool === "broadcasts" ? <Broadcasts scope={scope} rights={rights} />
          : <>{saveNotice}<AiAgent mode={mode} editable={canEdit && !replyDirty && !saveError} busy={saving} onMode={reply_mode => { void apply({ provider: "official", reply_mode }); }} /></>}
      </div>
      : <Inbox key={provider} scope={scope} canReply={viewer.canReply} canTemplate={viewer.canTemplate} assist={assist} handoff={handoff} routeId={linked ? null : route.record_id} initialId={localInboxId} onRecipient={to => openTool("templates", to)} replyDirty={replyDirty} onDirtyChange={setReplyDirty} openSettings={() => go("connection")} tools={provider === "official" ? <ToolsMenu zh={zh} disabled={replyDirty} choose={openTool} /> : null} />}
  </main>;
}
