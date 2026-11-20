import { Button,ErrorNotice,Field,Loading } from "@cadence/screen-ui";
import { useCallback,useEffect,useRef,useState,type FormEvent } from "react";
import type { DisplayScope } from "../../bridge/scope";
import type { WorkLink } from "./door";
import { addThreadNote,effectiveThreadState,emptyThread,listThreadNotes,readThreadWork,saveThreadWork,type ThreadFields,type ThreadNote,type ThreadState,type ThreadWork } from "./inboxWork";

export function threadStateLabel(state: ThreadState, zh: boolean) {
  return state === "done" ? (zh ? "已完成" : "Done") : state === "waiting" ? (zh ? "等候回覆" : "Waiting") : (zh ? "待回覆" : "Needs reply");
}

const states = ["needs_reply", "waiting", "done"] as const;
type Edit = { fields: ThreadFields; revision: number | null; choseState: boolean };
type Notes = { rows: ThreadNote[]; cursor: string | null };

export default function ContactWork({ scope, link, zh, onSaved, onDirty }: {
  scope: DisplayScope; link: WorkLink; zh: boolean;
  onSaved: (record: ThreadWork) => void; onDirty: (dirty: boolean) => void;
}) {
  const { ref, inboundVersion } = link;
  const [record, setRecord] = useState<ThreadWork | null | undefined>(undefined);
  const [draft, setDraft] = useState<Edit | null>(null);
  const [profileError, setProfileError] = useState<"read" | "save" | null>(null);
  const [notes, setNotes] = useState<Notes>();
  const [noteError, setNoteError] = useState<"read" | "save" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"profile" | "notes" | "note" | null>(null);
  const [saved, setSaved] = useState("");
  const busyRef = useRef(false);
  const noteIntent = useRef<ThreadNote | null>(null);
  const epoch = useRef(0);
  const readProfile = useCallback(async (guard = epoch.current) => {
    try {
      const next = await readThreadWork(scope, ref);
      if (guard !== epoch.current) return;
      setRecord(next);
      if (next) onSaved(next);
      setProfileError(null);
    } catch { if (guard === epoch.current) setProfileError("read"); }
  }, [scope, ref, onSaved]);
  const readNotes = useCallback(async (cursor: string | null = null, guard = epoch.current) => {
    try {
      const next = await listThreadNotes(scope, ref, cursor);
      if (guard !== epoch.current) return;
      setNotes(previous => ({ rows: cursor && previous ? [...previous.rows, ...next.rows.filter(n => !previous.rows.some(p => p.id === n.id))] : next.rows, cursor: next.cursor }));
      setNoteError(null);
    } catch { if (guard === epoch.current) setNoteError("read"); }
  }, [scope, ref]);
  useEffect(() => {
    const guard = ++epoch.current;
    void readProfile(guard); void readNotes(null, guard);
    return () => { epoch.current++; };
  }, [readProfile, readNotes]);
  useEffect(() => { onDirty(draft !== null || text !== "" || busy === "profile" || busy === "note"); }, [draft, text, busy, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const fields = draft?.fields ?? (record ? {
    name: record.name, state: effectiveThreadState(record, inboundVersion), due: record.due, seenInbound: record.seenInbound,
  } : emptyThread);
  function edit<K extends keyof ThreadFields>(key: K, value: ThreadFields[K]) {
    if (record === undefined) return;
    setSaved("");
    setDraft(previous => ({
      fields: { ...(previous?.fields ?? fields), [key]: value, ...(key === "state" ? { seenInbound: inboundVersion } : {}) },
      revision: previous ? previous.revision : record?.revision ?? null,
      choseState: key === "state" || previous?.choseState === true,
    }));
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!draft || record === undefined || busyRef.current || profileError) return;
    const intent = draft;
    const edited = {
      ...intent.fields,
      name: intent.fields.name?.trim() || null,
      ...(intent.choseState ? {} : { state: record?.state ?? "needs_reply" as const, seenInbound: record?.seenInbound ?? inboundVersion }),
    };
    const guard = epoch.current;
    busyRef.current = true; setBusy("profile"); setSaved("");
    try {
      const next = await saveThreadWork(scope, ref, edited, intent.revision);
      if (guard !== epoch.current) return;
      setRecord(next); onSaved(next); setDraft(null);
      setSaved(zh ? "已儲存對話資料。" : "Conversation details saved.");
    } catch { if (guard === epoch.current) setProfileError("save"); }
    finally { busyRef.current = false; if (guard === epoch.current) setBusy(null); }
  }
  async function postNote(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || busyRef.current || !notes) return;
    const intent = noteIntent.current?.body === body ? noteIntent.current : { id: crypto.randomUUID(), body, at: Date.now() };
    noteIntent.current = intent;
    const guard = epoch.current;
    busyRef.current = true; setBusy("note"); setNoteError(null); setSaved("");
    try {
      const next = await addThreadNote(scope, ref, intent);
      if (guard !== epoch.current) return;
      setNotes(previous => previous && { ...previous, rows: [next, ...previous.rows.filter(n => n.id !== next.id)] });
      noteIntent.current = null; setText("");
      setSaved(zh ? "已新增內部備註。" : "Internal note added.");
    } catch { if (guard === epoch.current) setNoteError("save"); }
    finally { busyRef.current = false; if (guard === epoch.current) setBusy(null); }
  }
  async function moreNotes() {
    if (!notes?.cursor || busyRef.current) return;
    const guard = epoch.current;
    busyRef.current = true; setBusy("notes");
    try { await readNotes(notes.cursor, guard); }
    finally { busyRef.current = false; if (guard === epoch.current) setBusy(null); }
  }
  const dateTime = new Intl.DateTimeFormat(zh ? "zh-HK" : "en", { dateStyle: "medium", timeStyle: "short" });
  return <>
    <section className="waba-work-section" aria-labelledby="waba-contact-work-title">
      <h4 id="waba-contact-work-title">{zh ? "對話跟進" : "Conversation work"}</h4>
      {profileError === "read" && <ErrorNotice bare onRetry={() => { void readProfile(); }}>{zh ? "無法載入對話資料。" : "Couldn’t read the conversation details."}</ErrorNotice>}
      {record === undefined ? !profileError && <Loading>{zh ? "正在載入對話資料…" : "Loading conversation details…"}</Loading> :
        <form className="waba-work-form" aria-labelledby="waba-contact-work-title" onSubmit={e => { void saveProfile(e); }}>
          <Field label={zh ? "共用名稱" : "Shared name"}>{props => <input {...props} className="field" name="shared_name" disabled={busy !== null || !!profileError} maxLength={100} value={fields.name ?? ""} onChange={e => edit("name", e.currentTarget.value)} />}</Field>
          <Field label={zh ? "狀態" : "Conversation status"}>{props => <select {...props} className="field" name="state" disabled={busy !== null || !!profileError} value={fields.state} onChange={e => { const value = states.find(state => state === e.currentTarget.value); if (value) edit("state", value); }}>
            {states.map(state => <option key={state} value={state}>{threadStateLabel(state, zh)}</option>)}
          </select>}</Field>
          <Field label={zh ? "跟進日期" : "Follow-up date"} hint={zh ? "只在收件匣提醒，不會發送訊息。" : "Inbox reminder only. No message is sent."}>{props => <input {...props} className="field" type="date" name="follow_up_on" disabled={busy !== null || !!profileError} value={fields.due ?? ""} onChange={e => edit("due", e.currentTarget.value || null)} />}</Field>
          {profileError === "save" && <ErrorNotice bare>{zh ? "無法確認儲存結果。請取消編輯並重新載入最新資料。" : "Couldn’t confirm the save. Cancel the edit and reload the latest details before trying again."}</ErrorNotice>}
          <div className="waba-work-actions">
            <Button type="submit" size="sm" variant="primary" loading={busy === "profile"} disabled={!draft || busy !== null || !!profileError}>{zh ? "儲存變更" : "Save changes"}</Button>
            {draft && <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => { setDraft(null); if (profileError) void readProfile(); }}>{zh ? "取消" : "Cancel"}</Button>}
          </div>
        </form>}
    </section>
    <section className="waba-work-section" aria-labelledby="waba-contact-notes-title">
      <h4 id="waba-contact-notes-title">{zh ? "內部備註" : "Internal notes"}</h4>
      {noteError === "read" && <ErrorNotice bare onRetry={() => { void readNotes(); }}>{zh ? "無法載入內部備註。" : "Couldn’t read internal notes."}</ErrorNotice>}
      {!notes && !noteError && <Loading>{zh ? "正在載入備註…" : "Loading notes…"}</Loading>}
      {notes && <>
        {notes.rows.length > 0 && <ol className="waba-notes" aria-labelledby="waba-contact-notes-title">
          {notes.rows.map(note => <li key={note.id}><time dateTime={new Date(note.at).toISOString()}>{dateTime.format(note.at)}</time><p>{note.body}</p></li>)}
        </ol>}
        {notes.cursor && <Button type="button" size="sm" loading={busy === "notes"} disabled={busy !== null} onClick={() => { void moreNotes(); }}>{zh ? "較早備註" : "Older notes"}</Button>}
        <form className="waba-work-form" aria-labelledby="waba-contact-notes-title" onSubmit={e => { void postNote(e); }}>
          <Field label={zh ? "新增備註" : "New internal note"}>{props => <textarea {...props} className="field" name="note" rows={2} maxLength={1000} disabled={busy !== null} value={text} onChange={e => setText(e.currentTarget.value)} />}</Field>
          {noteError === "save" && <ErrorNotice bare>{zh ? "無法確認備註已儲存。" : "Couldn’t confirm the note. Submitting it again won’t add a duplicate."}</ErrorNotice>}
          <div className="waba-work-actions">
            <Button type="submit" size="sm" loading={busy === "note"} disabled={!text.trim() || busy !== null || noteError === "read"}>{zh ? "新增備註" : "Add note"}</Button>
            {text !== "" && <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => { setText(""); noteIntent.current = null; if (noteError === "save") void readNotes(); }}>{zh ? "取消備註" : "Cancel note"}</Button>}
          </div>
        </form>
      </>}
    </section>
    {saved && <p className="waba-muted waba-work-save" role="status">{saved}</p>}
  </>;
}
