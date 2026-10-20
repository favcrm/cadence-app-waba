import { Field,Notice } from "@cadence/screen-ui";
import { useState } from "react";
import { writeMode,type CopilotMode } from "./copilotPref";

/** The AI agent section: how the assistant helps with replies. Automatic
 *  replies are not available in this version, so there is nothing to enable. */
export default function AiAgent({ installId, mode, persisted, onMode }: { installId: string; mode: CopilotMode; persisted: boolean; onMode: (m: CopilotMode) => void }) {
  const [kept, setKept] = useState(persisted);
  return <section className="waba-page" aria-label="AI agent">
    <header className="waba-head"><h1>AI agent</h1></header>
    <div className="waba-card">
      <Field label="Reply help" hint={mode === "copilot" ? "Copilot: the assistant can draft a reply for you to review. You still edit and approve every send." : "Human-only: the assistant controls are hidden. You write every reply yourself."}>
        {c => <select {...c} className="field" value={mode} onChange={e => { const m = e.target.value as CopilotMode; setKept(writeMode(installId, m)); onMode(m); }}>
          <option value="copilot">Copilot — draft replies for me to review</option>
          <option value="human-only">Human-only — no assistant drafts</option>
        </select>}
      </Field>
      {!kept && <p className="waba-muted">This choice is kept for this session only.</p>}
      <p>Automatic replies: unavailable</p>
      <Notice state="ai-note">Nothing is ever sent without your approval of the exact text.</Notice>
    </div>
  </section>;
}
