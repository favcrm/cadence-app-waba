import { ErrorNotice,Loading } from "@cadence/screen-ui";
import { scopeError,useScope } from "../../bridge/scope";
import Connection from "./Connection";
import Inbox from "./Inbox";
import "./waba.css";
export default function WabaScreen() {
  const snapshot = useScope();
  if (!snapshot) return scopeError() ? <ErrorNotice>{scopeError()}</ErrorNotice> : <Loading>Waiting for the verified WhatsApp mount…</Loading>;
  const { scope, route, actions } = snapshot;
  // Display affordances only, derived from the host-granted actions (members
  // get the reads); the host independently refuses every write it did not grant.
  const viewer = { canConnect: actions.includes("whatsapp.connect_session"), canReply: actions.includes("whatsapp.reply.prepare") && actions.includes("whatsapp.reply.send") };
  return <main className="app-outlet waba" key={`${scope.installId}:${scope.contextId}:${snapshot.digest}`}>
    {route.section === "connection" ? <Connection scope={scope} canConnect={viewer.canConnect} /> : <Inbox scope={scope} canReply={viewer.canReply} routeId={route.record_id} />}
  </main>;
}
