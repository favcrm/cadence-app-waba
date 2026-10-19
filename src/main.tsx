import { ErrorNotice } from "@cadence/screen-ui";
import "@cadence/screen-ui/styles.css";
import { createRoot } from "react-dom/client";
import { channel } from "./bridge/channel";
import { installSandboxFormActions } from "./bridge/sandboxForms";
import WabaScreen from "./features/waba/WabaScreen";
const outlet = document.getElementById("root") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "root" }));
const root = createRoot(outlet);
try { installSandboxFormActions(document); channel.start(); root.render(<WabaScreen />); }
catch (e) { root.render(<ErrorNotice>{e instanceof Error ? e.message : "WhatsApp bridge unavailable"}</ErrorNotice>); }
