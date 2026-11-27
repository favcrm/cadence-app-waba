import { Button, Detail, ErrorNotice, Field, Loading, Select, type DrawerEdit } from "@cadence/screen-ui";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { channel } from "../../bridge/channel";
import type { DisplayScope } from "../../bridge/scope";
import { errorText, formatMediaBytes, formatMediaDuration, isPdfMedia, mediaBadge, mediaExtTone, mediaKindLabel, when, type Conversation, type Message, type WorkLink } from "./door";
import FrameDrawer from "./FrameDrawer";
import {
  addThreadNote,
  dueLabel,
  effectiveThreadState,
  emptyThread,
  listThreadNotes,
  readThreadWork,
  saveThreadWork,
  type ThreadFields,
  type ThreadNote,
  type ThreadState,
  type ThreadWork,
} from "./inboxWork";

export function threadStateLabel(state: ThreadState, zh: boolean) {
  return state === "done" ? (zh ? "已完成" : "Done") : state === "waiting" ? (zh ? "等候回覆" : "Waiting") : (zh ? "待回覆" : "Needs reply");
}

const states = ["needs_reply", "waiting", "done"] as const;
type Edit = { fields: ThreadFields; revision: number | null; choseState: boolean };
type Notes = { rows: ThreadNote[]; cursor: string | null };

export interface ContactDrawerProps {
  scope: DisplayScope;
  conversation: Conversation;
  conversationId: string;
  workLink: WorkLink | null;
  title: string;
  subtitle: string;
  phone: string | null;
  group: boolean;
  zh: boolean;
  avatar: ReactNode;
  mediaMessages: Message[];
  loadedMedia: Map<string, { url: string; mimeType: string; fileName: string | null }>;
  hostMediaDownload: boolean;
  unavailablePreview: string;
  dueDay: string;
  onSaved: (record: ThreadWork) => void;
  onDirty: (dirty: boolean) => void;
  onLoadInline: (messageId: string, priority?: "user" | "auto") => Promise<{ url: string; mimeType: string; fileName: string | null }>;
  onOpenLightbox: (messageId: string) => void;
  onClose: () => void;
}

export default function ContactDrawer({
  scope,
  conversation,
  conversationId,
  workLink,
  title,
  subtitle,
  phone,
  group,
  zh,
  avatar,
  mediaMessages,
  loadedMedia,
  hostMediaDownload,
  unavailablePreview,
  dueDay,
  onSaved,
  onDirty,
  onLoadInline,
  onOpenLightbox,
  onClose,
}: ContactDrawerProps) {
  const ref = workLink?.ref ?? null;
  const inboundVersion = workLink?.inboundVersion ?? 0;

  const [record, setRecord] = useState<ThreadWork | null | undefined>(() => workLink ? undefined : null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Edit | null>(null);
  const [profileError, setProfileError] = useState<"read" | "save" | null>(null);
  const [notes, setNotes] = useState<Notes | undefined>(undefined);
  const [noteError, setNoteError] = useState<"read" | "save" | null>(null);
  const [addingNote, setAddingNote] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"profile" | "notes" | "note" | null>(null);
  const [saved, setSaved] = useState("");
  const busyRef = useRef(false);
  const noteIntent = useRef<ThreadNote | null>(null);
  const epoch = useRef(0);

  const readProfile = useCallback(async (guard = epoch.current) => {
    if (!ref) return;
    try {
      const next = await readThreadWork(scope, ref);
      if (guard !== epoch.current) return;
      setRecord(next);
      if (next) onSaved(next);
      setProfileError(null);
    } catch {
      if (guard === epoch.current) setProfileError("read");
    }
  }, [scope, ref, onSaved]);

  const readNotes = useCallback(async (cursor: string | null = null, guard = epoch.current) => {
    if (!ref) return;
    try {
      const next = await listThreadNotes(scope, ref, cursor);
      if (guard !== epoch.current) return;
      setNotes(previous => ({
        rows: cursor && previous ? [...previous.rows, ...next.rows.filter(n => !previous.rows.some(p => p.id === n.id))] : next.rows,
        cursor: next.cursor,
      }));
      setNoteError(null);
    } catch {
      if (guard === epoch.current) setNoteError("read");
    }
  }, [scope, ref]);

  useEffect(() => {
    if (!ref) return;
    const guard = ++epoch.current;
    void readProfile(guard);
    void readNotes(null, guard);
    return () => { epoch.current++; };
  }, [ref, readProfile, readNotes]);

  useEffect(() => {
    onDirty((editing && draft !== null) || (addingNote && text !== "") || busy === "profile" || busy === "note");
  }, [editing, draft, addingNote, text, busy, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const fields = draft?.fields ?? (record ? {
    name: record.name,
    state: effectiveThreadState(record, inboundVersion),
    due: record.due,
    seenInbound: record.seenInbound,
  } : emptyThread);

  function startEdit() {
    if (!workLink || record === undefined || profileError || busy !== null) return;
    setSaved("");
    setProfileError(null);
    setDraft(null);
    setEditing(true);
  }

  function cancelEdit() {
    if (busy === "profile") return;
    setDraft(null);
    setEditing(false);
    if (profileError === "save") {
      setProfileError(null);
      void readProfile();
    }
  }

  function editField<K extends keyof ThreadFields>(key: K, value: ThreadFields[K]) {
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
    if (!ref || record === undefined || busyRef.current || profileError === "read") return;
    if (!draft) {
      setEditing(false);
      return;
    }
    const edited = {
      ...draft.fields,
      name: draft.fields.name?.trim() || null,
      ...(draft.choseState ? {} : { state: record?.state ?? ("needs_reply" as const), seenInbound: record?.seenInbound ?? inboundVersion }),
    };
    const guard = epoch.current;
    busyRef.current = true;
    setBusy("profile");
    setSaved("");
    try {
      const next = await saveThreadWork(scope, ref, edited, draft.revision);
      if (guard !== epoch.current) return;
      setRecord(next);
      onSaved(next);
      setDraft(null);
      setEditing(false);
      setProfileError(null);
      setSaved(zh ? "已儲存對話資料。" : "Conversation details saved.");
    } catch {
      if (guard === epoch.current) setProfileError("save");
    } finally {
      busyRef.current = false;
      if (guard === epoch.current) setBusy(null);
    }
  }

  function cancelNote() {
    if (busy === "note") return;
    setText("");
    noteIntent.current = null;
    setAddingNote(false);
    if (noteError === "save") {
      setNoteError(null);
      void readNotes();
    }
  }

  async function postNote(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!ref || !body || busyRef.current || !notes) return;
    const intent = noteIntent.current?.body === body ? noteIntent.current : { id: crypto.randomUUID(), body, at: Date.now() };
    noteIntent.current = intent;
    const guard = epoch.current;
    busyRef.current = true;
    setBusy("note");
    setNoteError(null);
    setSaved("");
    try {
      const next = await addThreadNote(scope, ref, intent);
      if (guard !== epoch.current) return;
      setNotes(previous => previous && { ...previous, rows: [next, ...previous.rows.filter(n => n.id !== next.id)] });
      noteIntent.current = null;
      setText("");
      setAddingNote(false);
      setSaved(zh ? "已新增內部備註。" : "Internal note added.");
    } catch {
      if (guard === epoch.current) setNoteError("save");
    } finally {
      busyRef.current = false;
      if (guard === epoch.current) setBusy(null);
    }
  }

  async function moreNotes() {
    if (!ref || !notes?.cursor || busyRef.current) return;
    const guard = epoch.current;
    busyRef.current = true;
    setBusy("notes");
    try {
      await readNotes(notes.cursor, guard);
    } finally {
      busyRef.current = false;
      if (guard === epoch.current) setBusy(null);
    }
  }

  const effectiveState = effectiveThreadState(record, inboundVersion);
  const dueTone = record?.due ? (record.due < dueDay ? "overdue" : record.due === dueDay ? "due" : "scheduled") : null;
  const label = group ? (zh ? "群組詳情" : "Group details") : (zh ? "聯絡人詳情" : "Contact details");
  const dateTime = new Intl.DateTimeFormat(zh ? "zh-HK" : "en", { dateStyle: "medium", timeStyle: "short" });

  const detailItems = [
    group
      ? { key: "type", term: zh ? "類型" : "Type", value: subtitle }
      : {
          key: "phone",
          term: zh ? "電話" : "Phone",
          value: phone ? <bdi dir="ltr">{phone}</bdi> : <span className="waba-muted">{zh ? "未有電話號碼" : "Phone not available"}</span>,
        },
    ...(workLink && record !== undefined ? [
      { key: "shared_name", term: zh ? "共用名稱" : "Shared name", value: record?.name ?? "—" },
      {
        key: "state",
        term: zh ? "對話狀態" : "Status",
        value: <span className="waba-drawer-pill" data-state={effectiveState}>
          <span className="waba-work-dot" aria-hidden="true" />
          <span>{threadStateLabel(effectiveState, zh)}</span>
        </span>,
      },
      {
        key: "due",
        term: zh ? "跟進日期" : "Follow-up",
        value: record?.due
          ? <span className="waba-drawer-due"><bdi dir="ltr">{record.due}</bdi>{dueTone !== "scheduled" ? ` · ${dueLabel(record.due, dueDay, zh)}` : ""}</span>
          : "—",
      },
    ] : []),
    ...(conversation.status ? [{ key: "channel_status", term: zh ? "頻道狀態" : "Channel status", value: conversation.status }] : []),
    ...(conversation.lastInboundAt ? [{ key: "last_inbound", term: zh ? "最後收到訊息" : "Last inbound", value: when(conversation.lastInboundAt) }] : []),
  ];

  const overviewPanel = <>
    <section className="waba-drawer-sect" aria-labelledby="waba-contact-overview-title">
      <h4 id="waba-contact-overview-title">{zh ? "基本資料" : "Details"}</h4>
      <Detail className="waba-detail" label={label} items={detailItems} />
      {workLink && profileError === "read" && (
        <ErrorNotice bare onRetry={() => { void readProfile(); }}>{zh ? "無法載入對話資料。" : "Couldn’t read the conversation details."}</ErrorNotice>
      )}
      {workLink && record === undefined && !profileError && (
        <Loading>{zh ? "正在載入聯絡資料…" : "Loading contact details…"}</Loading>
      )}
    </section>
    {workLink && <section className="waba-drawer-sect" aria-labelledby="waba-contact-notes-title">
      <div className="waba-drawer-sect-head">
        <h4 id="waba-contact-notes-title">{zh ? "內部備註" : "Internal notes"}</h4>
        {notes && !addingNote && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { setSaved(""); setNoteError(null); setAddingNote(true); }}>
            {zh ? "新增備註" : "Add note"}
          </Button>
        )}
      </div>
      {noteError === "read" && (
        <ErrorNotice bare onRetry={() => { void readNotes(); }}>{zh ? "無法載入內部備註。" : "Couldn’t read internal notes."}</ErrorNotice>
      )}
      {!notes && !noteError && <Loading>{zh ? "正在載入備註…" : "Loading notes…"}</Loading>}
      {notes && <>
        {notes.rows.length > 0 ? (
          <ol className="waba-notes" aria-labelledby="waba-contact-notes-title">
            {notes.rows.map(note => (
              <li key={note.id}>
                <time dateTime={new Date(note.at).toISOString()}>{dateTime.format(note.at)}</time>
                <p>{note.body}</p>
              </li>
            ))}
          </ol>
        ) : !addingNote && (
          <p className="waba-muted">{zh ? "暫未有內部備註，助理可在此記錄摘要。" : "No internal notes yet. Your assistant can add notes here."}</p>
        )}
        {notes.cursor && (
          <div className="waba-work-actions">
            <Button type="button" size="sm" loading={busy === "notes"} disabled={busy !== null} onClick={() => { void moreNotes(); }}>
              {zh ? "較早備註" : "Older notes"}
            </Button>
          </div>
        )}
        {addingNote && (
          <form className="waba-work-form" aria-labelledby="waba-contact-notes-title" onSubmit={e => { void postNote(e); }}>
            <Field label={zh ? "新增備註" : "New internal note"}>
              {props => <textarea {...props} className="field" name="note" rows={3} maxLength={1000} disabled={busy !== null} value={text} onChange={e => setText(e.currentTarget.value)} />}
            </Field>
            {noteError === "save" && (
              <ErrorNotice bare>{zh ? "無法確認備註已儲存。" : "Couldn’t confirm the note. Submitting it again won’t add a duplicate."}</ErrorNotice>
            )}
            <div className="waba-work-actions">
              <Button type="submit" size="sm" variant="primary" loading={busy === "note"} disabled={!text.trim() || busy !== null}>{zh ? "儲存備註" : "Save note"}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={cancelNote}>{zh ? "取消" : "Cancel"}</Button>
            </div>
          </form>
        )}
      </>}
    </section>}
    {saved && <p className="waba-muted waba-work-save" role="status">{saved}</p>}
  </>;

  const visualItems = mediaMessages.filter(m => m.previewJpeg !== null || m.media?.kind === "image" || m.media?.kind === "video");
  const fileItems = mediaMessages.filter(m => m.media?.kind === "document" || m.media?.kind === "audio");
  const totalMediaCount = mediaMessages.length;
  const drawerAutoTried = useRef<Set<string>>(new Set());
  const [savingMediaId, setSavingMediaId] = useState<string | null>(null);
  const [savedMediaIds, setSavedMediaIds] = useState<Set<string>>(() => new Set());
  const [mediaSaveError, setMediaSaveError] = useState<string | null>(null);

  useEffect(() => {
    drawerAutoTried.current.clear();
  }, [conversationId]);

  useEffect(() => {
    if (!hostMediaDownload) return;
    for (const m of visualItems) {
      if (m.media?.kind === "image" && m.media.available && !loadedMedia.get(m.id)?.url && !drawerAutoTried.current.has(m.id)) {
        drawerAutoTried.current.add(m.id);
        void onLoadInline(m.id, "auto").catch(() => undefined);
      }
    }
  }, [visualItems, hostMediaDownload, loadedMedia, onLoadInline]);

  async function saveDrawerMedia(messageId: string) {
    if (savingMediaId) return;
    setSavingMediaId(messageId);
    setMediaSaveError(null);
    try {
      await channel.saveMedia(conversationId, messageId, scope.provider === "linked" ? "linked" : "official");
      setSavedMediaIds(curr => new Set(curr).add(messageId));
    } catch (e) {
      setMediaSaveError(errorText(e, zh ? "無法下載檔案。" : "Couldn’t save attachment."));
    } finally {
      setSavingMediaId(null);
    }
  }

  const mediaPanel = totalMediaCount > 0 ? <>
    {visualItems.length > 0 && <section className="waba-drawer-sect" aria-labelledby="waba-contact-media-title">
      <h4 id="waba-contact-media-title">{zh ? `相片與影片 (${visualItems.length})` : `Photos & videos (${visualItems.length})`}</h4>
      <ul className="waba-contact-media-grid">{visualItems.map(m => {
        const inline = loadedMedia.get(m.id);
        const inlineImageUrl = m.media?.kind !== "video" && inline?.url && inline.mimeType.toLowerCase().startsWith("image/") ? inline.url : null;
        const dur = m.media ? formatMediaDuration(m.media.durationSeconds) : null;
        const canOpen = !!m.media && (m.media.kind === "image" || m.media.kind === "video") && m.media.available && hostMediaDownload;
        const thumbSrc = inlineImageUrl ?? (m.previewJpeg ? `data:image/jpeg;base64,${m.previewJpeg}` : null);
        const tileAlt = m.media?.fileName ?? (m.media ? mediaKindLabel(m.media, zh) : (zh ? "相片預覽" : "Photo preview"));
        const inner = <>
          {thumbSrc
            ? <img src={thumbSrc} alt={tileAlt} loading="lazy" decoding="async" />
            : <span className="waba-contact-tile-fallback">{m.media ? mediaBadge(m.media) : "IMG"}</span>}
          {m.media?.kind === "video" && <span className="waba-contact-video-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="m8 5.5 11 6.5-11 6.5Z" /></svg>
            {dur && <span>{dur}</span>}
          </span>}
        </>;
        return <li key={m.id}>
          {canOpen
            ? <button type="button" className="waba-contact-tile" aria-label={tileAlt} onClick={() => onOpenLightbox(m.id)}>{inner}</button>
            : <div className="waba-contact-tile waba-contact-tile-static" aria-label={!thumbSrc ? unavailablePreview : tileAlt}>{inner}</div>}
        </li>;
      })}</ul>
    </section>}
    {fileItems.length > 0 && <section className="waba-drawer-sect" aria-labelledby="waba-contact-files-title">
      <h4 id="waba-contact-files-title">{zh ? `檔案與語音 (${fileItems.length})` : `Files & audio (${fileItems.length})`}</h4>
      {mediaSaveError && <ErrorNotice bare>{mediaSaveError}</ErrorNotice>}
      <ul className="waba-contact-files">{fileItems.map(m => {
        const media = m.media!;
        const label = media.fileName ?? mediaKindLabel(media, zh);
        const dur = formatMediaDuration(media.durationSeconds);
        const bytes = formatMediaBytes(media.byteLength);
        const sub = [dur, bytes, !media.available ? (zh ? "無法提供" : "Unavailable") : null].filter(Boolean).join(" · ");
        const isSaving = savingMediaId === m.id;
        const isSaved = savedMediaIds.has(m.id);
        const canPreviewPdf = isPdfMedia(media) && media.available && channel.hostPdfPreview;
        const docContent = <>
          <span className="waba-doc-badge" data-ext={mediaExtTone(media)}>{mediaBadge(media)}</span>
          <span className="waba-doc-meta">
            <span className="waba-doc-name" title={label}>{label}</span>
            {sub && <span className="waba-doc-sub">{sub}</span>}
          </span>
        </>;
        return <li key={m.id} className="waba-doc-card">
          {canPreviewPdf ? (
            <button
              type="button"
              className="waba-doc-open"
              aria-label={zh ? `檢視 PDF：${label}` : `Preview PDF: ${label}`}
              onClick={() => channel.previewPdf(conversationId, m.id, scope.provider === "linked" ? "linked" : "official")}
            >
              {docContent}
            </button>
          ) : docContent}
          {media.available && hostMediaDownload && (
            <button
              type="button"
              className="waba-media-icon-btn"
              data-saved={isSaved ? "true" : undefined}
              disabled={savingMediaId !== null}
              aria-busy={isSaving || undefined}
              aria-label={isSaved ? (zh ? "已下載" : "Saved") : (zh ? `下載 ${label}` : `Save ${label}`)}
              title={isSaved ? (zh ? "已下載" : "Saved") : (zh ? "下載" : "Save")}
              onClick={() => { void saveDrawerMedia(m.id); }}
            >
              {isSaving
                ? <span className="waba-inline-spin" aria-hidden="true" />
                : isSaved
                ? <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7" /></svg>
                : <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14" /></svg>}
            </button>
          )}
        </li>;
      })}</ul>
    </section>}
  </>
    : <section className="waba-drawer-sect" aria-labelledby="waba-contact-media-title">
        <h4 id="waba-contact-media-title">{zh ? "已分享的媒體" : "Shared media"}</h4>
        <p className="waba-muted">{zh ? "已載入的訊息沒有分享的媒體或檔案。" : "No shared media or files in loaded messages."}</p>
      </section>;

  const drawerEdit: DrawerEdit | null = editing && workLink ? {
    formId: "waba-contact-work-form",
    title: zh ? "編輯聯絡資料" : "Edit contact details",
    saveLabel: zh ? "儲存變更" : "Save changes",
    pending: busy === "profile",
    onCancel: cancelEdit,
    body: <form id="waba-contact-work-form" className="waba-work-form" onSubmit={e => { void saveProfile(e); }}>
      <Field label={zh ? "共用名稱" : "Shared name"}>
        {props => <input {...props} className="field" name="shared_name" disabled={busy !== null} maxLength={100} value={fields.name ?? ""} onChange={e => editField("name", e.currentTarget.value)} />}
      </Field>
      <Field label={zh ? "對話狀態" : "Conversation status"}>
        {props => <Select {...props} size="sm" full disabled={busy !== null} value={fields.state} options={states.map(state => ({ value: state, label: threadStateLabel(state, zh) }))} onChange={next => {
          const matched = states.find(state => state === next);
          if (matched) editField("state", matched);
        }} />}
      </Field>
      <Field label={zh ? "跟進日期" : "Follow-up date"} hint={zh ? "只在收件匣提醒，不會發送訊息。" : "Inbox reminder only. No message is sent."}>
        {props => <input {...props} className="field" type="date" name="follow_up_on" disabled={busy !== null} value={fields.due ?? ""} onChange={e => editField("due", e.currentTarget.value || null)} />}
      </Field>
      {profileError === "save" && (
        <ErrorNotice bare>{zh ? "無法確認儲存結果。請取消編輯並重新載入最新資料。" : "Couldn’t confirm the save. Cancel the edit and reload the latest details before trying again."}</ErrorNotice>
      )}
    </form>,
  } : null;

  const pills = workLink && record !== undefined ? <>
    <span className="waba-drawer-pill" data-state={effectiveState}>
      <span className="waba-work-dot" aria-hidden="true" />
      <span>{threadStateLabel(effectiveState, zh)}</span>
    </span>
    {record?.due && dueTone && (
      <span className="waba-drawer-pill" data-tone={dueTone}>{dueLabel(record.due, dueDay, zh)}</span>
    )}
  </> : undefined;

  return <FrameDrawer
    kind="waba-contact"
    label={label}
    avatar={avatar}
    title={title}
    subtitle={subtitle !== title ? (phone ? <bdi dir="ltr">{phone}</bdi> : subtitle) : undefined}
    pills={pills}
    tabs={[
      { id: "overview", label: zh ? "概覽" : "Overview", panel: overviewPanel },
      { id: "media", label: totalMediaCount > 0 ? (zh ? `媒體 (${totalMediaCount})` : `Media (${totalMediaCount})`) : (zh ? "媒體" : "Media"), panel: mediaPanel },
    ]}
    edit={drawerEdit}
    note={workLink ? (zh ? "主要由助理更新" : "Updated by your assistant") : (zh ? "唯讀檢視" : "Read-only view")}
    secondary={workLink && record !== undefined && !profileError ? (
      <Button size="sm" disabled={busy !== null || addingNote} onClick={startEdit}>{zh ? "手動編輯" : "Edit"}</Button>
    ) : undefined}
    onClose={onClose}
  />;
}
