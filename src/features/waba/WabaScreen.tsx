import { ErrorNotice,Loading } from "@cadence/screen-ui";
import { useMemo,useState } from "react";
import { scopeError,useScope } from "../../bridge/scope";
import Broadcasts from "./Broadcasts";
import AiAgent from "./AiAgent";
import Connection from "./Connection";
import { readMode,type CopilotMode } from "./copilotPref";
import Inbox from "./Inbox";
import Templates,{ type Recipient } from "./Templates";
import "./waba.css";
export default function WabaScreen() {
  const snapshot = useScope();
  // The template recipient outlives a section switch: the host re-pushes the
  // route into this frame, and the host's nav links drop the record id.
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  // The host re-pushes the scope every few seconds as a new object; pages key
  // their reads on this stable one, so a push never resets loaded data or forms.
  const installId = snapshot?.scope.installId, contextId = snapshot?.scope.contextId;
  const scope = useMemo(() => installId === undefined || contextId === undefined ? null : { installId, contextId }, [installId, contextId]);
  // Per-install copilot preference; kept in state so the section and the Inbox agree.
  const [prefs, setPrefs] = useState<Record<string, CopilotMode>>({});
  if (!snapshot || !scope) return scopeError() ? <ErrorNotice>{scopeError()}</ErrorNotice> : <Loading>Waiting for the verified WhatsApp mount…</Loading>;
  const { route, actions } = snapshot;
  // Display affordances only, derived from the host-granted actions (members
  // get the reads); the host independently refuses every write it did not grant.
  const can = (...verbs: string[]) => verbs.every(v => actions.includes(v));
  const viewer = { canConnect: can("whatsapp.connect_session"), canReply: can("whatsapp.reply.prepare", "whatsapp.reply.send"), canTemplate: can("whatsapp.template.prepare", "whatsapp.template.send") };
  const rights = { draft: can("whatsapp.broadcast.draft"), estimate: can("whatsapp.broadcast.estimate"), test: can("whatsapp.broadcast.test.prepare", "whatsapp.broadcast.test.send"), send: can("whatsapp.broadcast.prepare", "whatsapp.broadcast.send"), stop: can("whatsapp.broadcast.stop") };
  const stored = readMode(scope.installId);
  const mode = prefs[scope.installId] ?? stored.mode;
  // The copilot is offered only in copilot mode and only where the host granted its reads.
  const copilot = mode === "copilot" && can("whatsapp.draft.show");
  const assist = { show: copilot, brief: copilot && can("chat.whatsapp.brief"), open: copilot && can("chat.whatsapp.open"), discard: copilot && can("whatsapp.draft.discard") };
  return <main className="app-outlet waba" key={`${scope.installId}:${scope.contextId}:${snapshot.digest}`}>
    {route.section === "connection" ? <Connection scope={scope} canConnect={viewer.canConnect} />
      : route.section === "templates" ? <Templates scope={scope} canSend={viewer.canTemplate} routeId={route.record_id} recipient={recipient} onRecipient={setRecipient} />
      : route.section === "ai" ? <AiAgent installId={scope.installId} mode={mode} persisted={stored.persisted} onMode={m => setPrefs(p => ({ ...p, [scope.installId]: m }))} />
      : route.section === "broadcasts" ? <Broadcasts scope={scope} rights={rights} routeId={route.record_id} creating={route.view === "new"} />
      : <Inbox scope={scope} canReply={viewer.canReply} canTemplate={viewer.canTemplate} assist={assist} routeId={route.record_id} onRecipient={setRecipient} />}
  </main>;
}
