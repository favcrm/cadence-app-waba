import { ApiError,Button,EmptyState,ErrorNotice,Loading,Notice } from "@cadence/screen-ui";
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
import { patchRoute } from "../../bridge/route";
import { markUnreachable,scopeError,useScope } from "../../bridge/scope";
import Broadcasts from "./Broadcasts";
import AiAgent from "./AiAgent";
import Connection from "./Connection";
import { readPreferences,savePreferences,type Preferences,type Provider,type SavedPreferences } from "./preferences";
import Inbox from "./Inbox";
import Templates,{ type Recipient } from "./Templates";
import "./waba.css";
export default function WabaScreen() {
  const snapshot = useScope();
  // The template recipient outlives a section switch: the host re-pushes the
  // route into this frame, and the host's nav links drop the record id.
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [saved, setSaved] = useState<SavedPreferences | null | undefined>();
  const [readError, setReadError] = useState(false);
  const [saveError, setSaveError] = useState<"owner" | "uncertain" | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInProgress = useRef(false);
  const [pick, setPick] = useState<Provider | null>(null);
  const provider = saved?.profile.provider;
  const [replyDirty, setReplyDirty] = useState(false);
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
  const section = snapshot?.route.section;
  useLayoutEffect(() => {
    if (routeFocus.current !== section) return;
    routeFocus.current = null;
    document.getElementById(section === "inbox" ? "waba-inbox-title" : "waba-provider-title")?.focus();
  }, [section]);
  if (!snapshot || !installScope) return scopeError() ? <ErrorNotice>{scopeError()}</ErrorNotice> : <Loading>Waiting for the verified WhatsApp mount…</Loading>;
  const { route, actions } = snapshot;
  const zh = snapshot.presentationLocale === "zh-TW";
  async function go(section: "inbox" | "connection") {
    routeFocus.current = section;
    try { await patchRoute({ section, view: "list", record_id: null }); }
    catch (e) { routeFocus.current = null; throw e; }
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
    : settings ? <>
      <div className="waba-connection-picker">
        <fieldset className="waba-provider" aria-describedby="waba-provider-hint" disabled={!canEdit || replyDirty || saving || !!saveError}>
          <legend id="waba-provider-title" tabIndex={-1}>{zh ? "收件匣連線" : "Inbox connection"}</legend>
          <label><input type="radio" name="waba-provider" value="official" checked={chosen === "official"} onChange={() => setPick("official")} /> {zh ? "官方 API (FavCRM)" : "Official API (FavCRM)"}</label>
          <label><input type="radio" name="waba-provider" value="linked" checked={chosen === "linked"} onChange={() => setPick("linked")} /> {zh ? "已連結裝置" : "Linked device"}</label>
        </fieldset>
        <p id="waba-provider-hint" className="waba-muted">{!canEdit
          ? (zh ? "只有工作區擁有人可設定連線。" : "Only a workspace owner can set the connection.")
          : replyDirty ? (zh ? "請先完成目前的回覆。" : "Finish the current reply before changing the connection.")
          : (zh ? "此安裝每次只使用一個連線。儲存不會中斷任何連線。" : "This installation uses one connection at a time. Saving doesn’t disconnect either provider.")}</p>
        <div className="waba-head">
          {canEdit && <Button size="sm" variant="primary" loading={saving} disabled={!chosen || chosen === provider || replyDirty || !!saveError}
            onClick={() => { if (chosen) void apply({ provider: chosen, reply_mode: mode }); }}>{zh ? "儲存連線" : "Save connection"}</Button>}
          {scope && <Button size="sm" disabled={saving || chosen !== provider} onClick={() => { setReturnError(false); void go("inbox").catch(() => setReturnError(true)); }}>{zh ? "開啟收件匣" : "Open Inbox"}</Button>}
        </div>
        {saveNotice}
        {returnError && <ErrorNotice bare>{zh ? "無法開啟收件匣，請從側欄選取收件匣。" : "Couldn’t open the Inbox. Choose Inbox in the sidebar."}</ErrorNotice>}
      </div>
      {linked && <Notice>Test accounts only: a crash can currently lose incoming test messages. Do not use this connection for production traffic.</Notice>}
      {scope && <Connection key={provider} scope={scope} canConnect={viewer.canConnect} />}
    </> : !scope ? <EmptyState name="connection" title={zh ? "選擇 WhatsApp 連線" : "Choose a WhatsApp connection"}>{zh ? "請由工作區擁有人在設定中選取連線。" : "A workspace owner needs to choose a connection in Settings."} <Button size="sm" onClick={() => { setReturnError(false); void go("connection").catch(() => setReturnError(true)); }}>{zh ? "開啟設定" : "Open Settings"}</Button>{returnError && <p>{zh ? "請在側欄選取設定。" : "Choose Settings in the sidebar."}</p>}</EmptyState>
      : linked && route.section !== "inbox" ? <Notice state="read-only">{zh ? "此功能只適用於官方 API。" : "This section requires the official API."}</Notice>
      : route.section === "templates" ? <Templates scope={scope} canSend={viewer.canTemplate} routeId={route.record_id} recipient={recipient} onRecipient={setRecipient} />
      : route.section === "ai" ? <>{saveNotice}<AiAgent mode={mode} editable={canEdit && !replyDirty && !saveError} busy={saving} onMode={reply_mode => { void apply({ provider: "official", reply_mode }); }} /></>
      : route.section === "broadcasts" ? <Broadcasts scope={scope} rights={rights} routeId={route.record_id} creating={route.view === "new"} />
      : <Inbox key={provider} scope={scope} canReply={viewer.canReply} canTemplate={viewer.canTemplate} assist={assist} handoff={handoff} routeId={linked ? null : route.record_id} onRecipient={setRecipient} replyDirty={replyDirty} onDirtyChange={setReplyDirty} openSettings={() => go("connection")} />}
  </main>;
}
