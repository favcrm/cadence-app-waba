import { Field,Notice } from "@cadence/screen-ui";
import { useScope } from "../../bridge/scope";
import type { CopilotMode } from "./preferences";

/** The AI agent section: how the assistant helps with replies. Automatic
 *  replies are not available in this version, so there is nothing to enable. */
export default function AiAgent({ mode, editable, busy, onMode }: { mode: CopilotMode; editable: boolean; busy: boolean; onMode: (m: CopilotMode) => void }) {
  const zh = useScope()?.presentationLocale === "zh-TW";
  return <section className="waba-page" aria-label={zh ? "AI 助理" : "AI agent"}>
    <header className="waba-head"><h1>{zh ? "AI 助理" : "AI agent"}</h1></header>
    <div className="waba-card">
      <Field label={zh ? "回覆模式" : "Reply mode"} hint={mode === "copilot"
        ? (zh ? "助理可擬寫草稿，每次傳送仍須由你核准。" : "The assistant can draft replies. You still approve each send.")
        : (zh ? "隱藏助理草稿，由你撰寫回覆。" : "Assistant drafts are hidden. You write the replies.")}>
        {c => <select {...c} className="field" value={mode} disabled={!editable || busy} onChange={e => onMode(e.currentTarget.value === "human-only" ? "human-only" : "copilot")}>
          <option value="copilot">{zh ? "助理草擬回覆" : "Copilot"}</option>
          <option value="human-only">{zh ? "只限人手回覆" : "Human-only"}</option>
        </select>}
      </Field>
      <p className="waba-muted">{busy ? (zh ? "正在儲存…" : "Saving…") : editable ? (zh ? "此模式會儲存至此應用程式安裝。" : "This mode is saved for this installation.") : (zh ? "只有工作區擁有人可更改模式。" : "Only a workspace owner can change the mode.")}</p>
      <Notice state="ai-note">{zh ? "每次傳送均須核准訊息內容。" : "Nothing is sent without your approval of the exact text."}</Notice>
    </div>
  </section>;
}
