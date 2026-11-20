import { Field } from "@cadence/screen-ui";
import { useScope } from "../../bridge/scope";
import type { CopilotMode } from "./preferences";

/** The AI agent section: how the assistant helps with replies. Automatic
 *  replies are not available in this version, so there is nothing to enable. */
export default function AiAgent({ mode, editable, busy, onMode }: { mode: CopilotMode; editable: boolean; busy: boolean; onMode: (m: CopilotMode) => void }) {
  const zh = useScope()?.presentationLocale === "zh-TW";
  return <section className="waba-page waba-settings" aria-labelledby="waba-ai-title">
    <header className="waba-head"><h1 id="waba-ai-title" tabIndex={-1}>{zh ? "AI 助理" : "AI agent"}</h1></header>
    <Field label={zh ? "回覆模式" : "Reply mode"} hint={mode === "copilot"
      ? (zh ? "助理可擬寫草稿，每次傳送仍須由你核准。" : "The assistant can draft replies. You still approve each send.")
      : (zh ? "隱藏助理草稿。由你撰寫及核准回覆。" : "Assistant drafts are hidden. You write and approve replies.")}>
      {c => <select {...c} className="field" value={mode} disabled={!editable || busy} onChange={e => onMode(e.currentTarget.value === "human-only" ? "human-only" : "copilot")}>
        <option value="copilot">{zh ? "助理草擬回覆" : "Copilot"}</option>
        <option value="human-only">{zh ? "只限人手回覆" : "Human-only"}</option>
      </select>}
    </Field>
    {busy ? <p className="waba-muted" role="status">{zh ? "正在儲存…" : "Saving…"}</p> : !editable &&
      <p className="waba-muted">{zh ? "只有工作區擁有人可更改模式。" : "Only a workspace owner can change the mode."}</p>}
  </section>;
}
