import { Button,Detail,ErrorNotice,Loading,Notice } from "@cadence/screen-ui";
import { useCallback,useEffect,useState } from "react";
import { useOnPush,type DisplayScope } from "../../bridge/scope";
import { serviceCall } from "../../bridge/services";
import { errorText,parseConnect,parseStatus,when,type ConnectSession,type Status } from "./door";

type Read = { state: "unknown" } | { state: "reading" } | { state: "ok"; status: Status } | { state: "failed"; text: string };
/** Signup phases. Only an authoritative status read ever shows "connected";
 *  closing or finishing the signup page just wakes that read. */
type Signup = { phase: "idle" } | { phase: "minting" } | { phase: "open" | "manual"; link: ConnectSession } | { phase: "expired" } | { phase: "incomplete"; link: ConnectSession | null } | { phase: "failed"; text: string };

const expired = (link: ConnectSession) => !!link.expiresAt && Date.parse(link.expiresAt) <= Date.now();

export default function Connection({ scope, canConnect }: { scope: DisplayScope; canConnect: boolean }) {
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
      setSignup({ phase: "failed", text: errorText(e, "Cadence could not get a signup link.") });
    }
  }

  const status = read.state === "ok" ? read.status : null;
  return <section className="waba-page" aria-labelledby="waba-connection-title">
    <header className="waba-head">
      <h1 id="waba-connection-title">Connection</h1>
      <Button size="sm" onClick={() => { void refresh(signup.phase === "open" || signup.phase === "manual" || signup.phase === "incomplete"); }} loading={read.state === "reading"}>Check status</Button>
    </header>
    {read.state === "unknown" || read.state === "reading" ? <Loading>Reading the WhatsApp connection from FavCRM…</Loading>
      : read.state === "failed" ? <ErrorNotice onRetry={() => { void refresh(); }}>
          Status unknown: the lookup failed, so this is not a disconnected state. {read.text}
        </ErrorNotice>
      : <StatusCard status={read.status} />}
    {status && !status.connected && !canConnect && <Notice state="read-only">Only the workspace operator can connect a WhatsApp number.</Notice>}
    {canConnect && status && !status.connected && <div className="waba-card" data-signup={signup.phase}>
      <h2>Connect a number</h2>
      <p>Signup runs on FavCRM&apos;s hosted page with your own Meta login. Cadence never sees a Meta or FavCRM credential.</p>
      {signup.phase === "open" && <Notice>The signup page opened in a new tab. When you finish or close it, choose <strong>Check status</strong>.</Notice>}
      {signup.phase === "manual" && <ManualLink link={signup.link} />}
      {signup.phase === "expired" && <ErrorNotice>The signup link expired before signup finished. Get a new link to try again.</ErrorNotice>}
      {signup.phase === "incomplete" && <Notice>Signup is not complete yet. If you cancelled or closed the page, get a new link to start again.</Notice>}
      {signup.phase === "incomplete" && signup.link && <ManualLink link={signup.link} />}
      {signup.phase === "failed" && <ErrorNotice>Signup could not start: {signup.text}</ErrorNotice>}
      <Button variant="primary" onClick={() => { void connect(); }} loading={signup.phase === "minting"}>
        {signup.phase === "idle" || signup.phase === "minting" ? "Connect WhatsApp" : "Get a new signup link"}
      </Button>
    </div>}
  </section>;
}

function ManualLink({ link }: { link: ConnectSession }) {
  return <div className="waba-manual" role="group" aria-label="Signup link">
    <p>Your browser blocked the signup window. Copy this one-time link into a new browser tab, finish signup there, then choose <strong>Check status</strong>.</p>
    <label htmlFor="waba-signup-link">Signup link</label>
    <input id="waba-signup-link" className="field" readOnly value={link.url} onFocus={e => e.currentTarget.select()} />
    <p className="waba-muted">Expires {when(link.expiresAt)}. Anyone with this link can start signup, so don&apos;t share it.</p>
  </div>;
}

function StatusCard({ status }: { status: Status }) {
  const hook = status.webhook;
  const health = !hook ? "Unknown" : hook.subscribed === true ? (hook.error ? "Subscribed, with errors" : "Healthy") : hook.subscribed === false ? "Not subscribed" : "Unknown";
  return <div className="waba-card" data-connected={String(status.connected)}>
    <h2>{status.connected ? "Connected" : "Not connected"}</h2>
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
