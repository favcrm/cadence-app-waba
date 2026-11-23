import { Button,Detail,ErrorNotice,Loading,Notice } from "@cadence/screen-ui";
import { useCallback,useEffect,useState } from "react";
import { useOnPush,useScope,type DisplayScope } from "../../bridge/scope";
import { serviceCall } from "../../bridge/services";
import { errorText,parseConnect,parseStatus,when,type ConnectSession,type Status } from "./door";

type Read = { state: "unknown" } | { state: "reading" } | { state: "ok"; status: Status } | { state: "failed"; text: string };
/** Signup phases. Only an authoritative status read ever shows "connected";
 *  closing or finishing the signup page just wakes that read. */
type Signup = { phase: "idle" } | { phase: "minting" } | { phase: "open" | "manual"; link: ConnectSession } | { phase: "expired" } | { phase: "incomplete"; link: ConnectSession | null } | { phase: "failed"; text: string };

const expired = (link: ConnectSession) => !!link.expiresAt && Date.parse(link.expiresAt) <= Date.now();

export default function Connection({ scope, canConnect }: { scope: DisplayScope; canConnect: boolean }) {
  const linked = scope.provider === "linked";
  const zh = useScope()?.presentationLocale === "zh-TW";
  const [read, setRead] = useState<Read>({ state: "unknown" });
  // The link lives in memory only; it is never stored or logged.
  const [signup, setSignup] = useState<Signup>({ phase: "idle" });
  // `afterSignup`: the operator says signup finished or was closed; the read decides.
  // `quiet` is a host-push refresh: no loading state, and a failed read keeps the last status.
  const refresh = useCallback(async (afterSignup = false, quiet = false) => {
    if (!quiet) setRead({ state: "reading" });
    try {
      const status = parseStatus(await serviceCall(scope, "whatsapp.status", {}));
      setRead({ state: "ok", status });
      if (afterSignup) setSignup(s => status.connected ? { phase: "idle" } : { phase: "incomplete", link: (s.phase === "open" || s.phase === "manual") && !expired(s.link) ? s.link : null });
    } catch (e) {
      // A failed lookup is its own state, never a fabricated "not connected".
      setRead(r => quiet && r.state === "ok" ? r : { state: "failed", text: errorText(e, "The status lookup failed.") });
    }
  }, [scope]);
  useEffect(() => { void refresh(); }, [refresh]);
  useOnPush(() => refresh(false, true));
  // A link that outlives its expiry is refused here, never reused.
  useEffect(() => {
    if (signup.phase !== "open" && signup.phase !== "manual" || !signup.link.expiresAt) return;
    const left = Date.parse(signup.link.expiresAt) - Date.now();
    const timer = setTimeout(() => setSignup({ phase: "expired" }), Math.max(0, Math.min(left, 2 ** 31 - 1)));
    return () => clearTimeout(timer);
  }, [signup]);

  async function connect() {
    setSignup({ phase: "minting" });
    try {
      const link = parseConnect(await serviceCall(scope, "whatsapp.connect_session", {}));
      if (expired(link)) { setSignup({ phase: "expired" }); return; }
      // The screen frame is sandboxed, so the browser usually blocks this
      // popup; the manual link below is the recovery path.
      let opened: Window | null = null;
      try { opened = window.open(link.url, "_blank", "noopener,noreferrer"); } catch { opened = null; }
      setSignup({ phase: opened ? "open" : "manual", link });
    } catch (e) {
      setSignup({ phase: "failed", text: errorText(e, linked ? "Cadence could not open WhatsApp Settings." : "Cadence could not get a signup link.") });
    }
  }

  const status = read.state === "ok" ? read.status : null;
  return <section className="waba-page" aria-labelledby="waba-connection-title">
    <header className="waba-head">
      <h2 id="waba-connection-title">{zh ? "連線狀態" : "Connection status"}</h2>
      <Button size="sm" onClick={() => { void refresh(signup.phase === "open" || signup.phase === "manual" || signup.phase === "incomplete"); }} loading={read.state === "reading"}>{zh ? "檢查狀態" : "Check status"}</Button>
    </header>
    {read.state === "unknown" || read.state === "reading" ? <Loading>{zh ? "正在檢查連線…" : "Checking the connection…"}</Loading>
      : read.state === "failed" ? <ErrorNotice onRetry={() => { void refresh(); }}>
          {zh ? "無法確認連線狀態。" : "Couldn’t verify the connection."} {read.text}
        </ErrorNotice>
      : <StatusCard status={read.status} linked={linked} zh={zh} />}
    {status && !status.connected && !canConnect && <Notice state="read-only">Only the workspace operator can connect a WhatsApp number.</Notice>}
    {canConnect && status && (linked || !status.connected) && <div className="waba-card" data-signup={signup.phase}>
      <h3>{linked ? (zh ? "管理已連結裝置" : "Manage linked device") : (zh ? "連接電話號碼" : "Connect a number")}</h3>
      <p>{linked ? (zh ? "開啟 Cadence WhatsApp 設定，再以 WhatsApp 掃描二維碼。" : "Open Cadence WhatsApp Settings to pair with a WhatsApp QR code.")
        : (zh ? "請在 FavCRM 使用你的 Meta 帳戶完成設定。" : "Finish setup in FavCRM with your Meta account.")}</p>
      {signup.phase === "open" && <Notice>{linked
        ? (zh ? "已在分頁開啟 Cadence WhatsApp 設定。完成配對後，請選「檢查狀態」。" : <>Cadence WhatsApp Settings opened in a new tab. After pairing, choose <strong>Check status</strong>.</>)
        : <>The signup page opened in a new tab. When you finish or close it, choose <strong>Check status</strong>.</>}</Notice>}
      {signup.phase === "manual" && <ManualLink link={signup.link} linked={linked} zh={zh} />}
      {signup.phase === "expired" && <ErrorNotice>The signup link expired before signup finished. Get a new link to try again.</ErrorNotice>}
      {signup.phase === "incomplete" && <Notice>{linked
        ? (zh ? "已連結裝置尚未連線。請開啟 Cadence WhatsApp 設定完成配對，然後檢查狀態。" : "The linked device is not connected yet. Open Cadence WhatsApp Settings to pair it, then check status.")
        : "Signup is not complete yet. If you cancelled or closed the page, get a new link to start again."}</Notice>}
      {signup.phase === "incomplete" && signup.link && <ManualLink link={signup.link} linked={linked} zh={zh} />}
      {signup.phase === "failed" && <ErrorNotice>{linked ? (zh ? "無法開啟 Cadence WhatsApp 設定" : "Cadence WhatsApp Settings could not open") : "Signup could not start"}: {signup.text}</ErrorNotice>}
      <Button variant="primary" onClick={() => { void connect(); }} loading={signup.phase === "minting"}>
        {linked ? (zh ? "開啟 Cadence WhatsApp 設定" : "Open Cadence WhatsApp Settings") : signup.phase === "idle" || signup.phase === "minting" ? (zh ? "連接 WhatsApp" : "Connect WhatsApp") : (zh ? "取得新連結" : "Get a new signup link")}
      </Button>
    </div>}
  </section>;
}

function ManualLink({ link, linked, zh }: { link: ConnectSession; linked: boolean; zh: boolean }) {
  return <div className="waba-manual" role="group" aria-label={linked ? (zh ? "Cadence WhatsApp 設定連結" : "Cadence WhatsApp Settings link") : "Signup link"}>
    <p>{linked
      ? (zh ? <>瀏覽器已封鎖新分頁。請複製此 Cadence WhatsApp 設定連結到新分頁配對裝置，然後選<strong>檢查狀態</strong>。</> : <>Your browser blocked the new tab. Copy this Cadence WhatsApp Settings link into a new browser tab, pair the device there, then choose <strong>Check status</strong>.</>)
      : <>Your browser blocked the signup window. Copy this one-time link into a new browser tab, finish signup there, then choose <strong>Check status</strong>.</>}</p>
    <label htmlFor="waba-signup-link">{linked ? (zh ? "Cadence WhatsApp 設定連結" : "Cadence WhatsApp Settings link") : "Signup link"}</label>
    <input id="waba-signup-link" className="field" readOnly value={link.url} onFocus={e => e.currentTarget.select()} />
    <p className="waba-muted">{linked ? (zh ? "開啟 Cadence WhatsApp 設定需由工作區擁有人登入。" : "Cadence WhatsApp Settings require a signed-in workspace owner.") : <>Expires {when(link.expiresAt)}. Anyone with this link can start signup, so don&apos;t share it.</>}</p>
  </div>;
}

function linkedStateLabel(state: string | null, connected: boolean, zh: boolean): string {
  switch (state) {
    case "connected": return zh ? "已連線" : "Connected";
    case "connecting": return zh ? "正在連線" : "Connecting";
    case "pairing": return zh ? "等待配對（二維碼）" : "Waiting for QR pairing";
    case "stopped": return zh ? "已停止" : "Stopped";
    case "reauthorization_required": return zh ? "需要重新連結" : "Re-linking required";
    case "disconnected": return zh ? "已中斷連線" : "Disconnected";
    case "idle": return zh ? "未啟動" : "Idle";
    default: return connected ? (zh ? "已連線" : "Connected") : (zh ? "未連線" : "Not connected");
  }
}

function StatusCard({ status, linked, zh }: { status: Status; linked: boolean; zh: boolean }) {
  const title = status.connected ? (zh ? "已連線" : "Connected") : (zh ? "未連線" : "Not connected");
  if (linked) {
    const label = linkedStateLabel(status.state, status.connected, zh);
    return <>
      <p className="waba-linked-status" data-connected={String(status.connected)} data-state={status.state ?? undefined}>
        <strong>{label}</strong>
      </p>
      {status.state === "stopped" && <Notice state="stopped">{zh
        ? "已連結裝置工作階段已停止（$0/月，保留配對裝置）。請在 Cadence WhatsApp 設定啟動，或執行 cadence connection whatsapp start --provider linked。"
        : "The linked device session is stopped ($0/mo, device stays paired). Start it in Cadence WhatsApp Settings or run cadence connection whatsapp start --provider linked."}</Notice>}
      {status.state === "reauthorization_required" && <Notice state="warning">{zh
        ? "已連結裝置需要重新掃描二維碼配對，請開啟 Cadence WhatsApp 設定。"
        : "The linked device session needs re-pairing with a fresh QR code in Cadence WhatsApp Settings."}</Notice>}
    </>;
  }
  const hook = status.webhook;
  const health = !hook ? "Unknown" : hook.subscribed === true ? (hook.error ? "Subscribed, with errors" : "Healthy") : hook.subscribed === false ? "Not subscribed" : "Unknown";
  return <div className="waba-card" data-connected={String(status.connected)} data-paused={status.paused === true ? "true" : undefined}>
    <h3>{title}</h3>
    {status.paused === true && <Notice state="paused">{zh
      ? "官方 WhatsApp 已被工作區覆蓋層暫停。可執行 cadence connection whatsapp start --provider official，或透過擁有人核准的 whatsapp.start 恢復。"
      : "Official WhatsApp is paused for this workspace. Resume it via cadence connection whatsapp start --provider official or an owner-approved whatsapp.start action."}</Notice>}
    {status.connected ? <Detail label="WhatsApp connection" items={[
      { key: "number", term: "Number", value: status.displayPhoneNumber ?? "—" },
      { key: "business", term: "Business name", value: status.verifiedName ?? "—" },
      { key: "waba", term: "WhatsApp Business account", value: status.wabaId ?? "—" },
      { key: "phone", term: "Phone number ID", value: status.phoneNumberId ?? "—" },
      { key: "webhook", term: "Webhook health", value: health },
      ...(hook?.status ? [{ key: "hook-status", term: "Webhook status", value: hook.status }] : []),
      ...(hook?.error ? [{ key: "hook-error", term: "Webhook error", value: hook.error }] : []),
      ...(hook && hook.fields.length ? [{ key: "hook-fields", term: "Webhook fields", value: hook.fields.join(", ") }] : []),
      { key: "observed", term: "Checked", value: when(status.observedAt) },
    ]} /> : <p>FavCRM reports no connected WhatsApp number for this workspace.</p>}
  </div>;
}
