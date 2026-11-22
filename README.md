# Cadence app: WhatsApp Business (WABA)

An installable Cadence app with **Inbox** and **Settings**. The Inbox's **Tools**
menu shows **Templates**, **Broadcasts** and **AI agent** only for Official API.
These tools no longer have independent sidebar routes.
It follows the same layout as `favcrm/cadence-app-crm`: an `app/` bundle with `screens/waba/`,
built on the host's pinned screen-ui SDK.

- **Source of truth.** FavCRM owns the WhatsApp Business connection, Meta credentials, the webhook, messages, templates, consent and dispatch.
- **Host door.** The Cadence host reaches FavCRM through a declaration-gated messaging door via AgenticOS (cadence CAD-1562, agenticos-v2 AOS-287).
  The screen declares the `whatsapp.*` operations; neither the app nor the browser ever holds a credential or a company id.
- **Approvals.** The host prepares outbound replies and confirms the exact recipient and text. Existing linked-device replies use the trusted board composer when available; other replies use the host-drawn approval card.
- **Members** get the reads only: the inbox shows without the composer or the connect action.
- **Linked photo previews.** On a compatible hosted backend, the inbox displays bounded JPEG previews supplied with ordinary linked-device photos. It never fetches provider URLs or shows view-once photos. Older messages, documents, video and audio do not gain photo previews.
- **Inbox layout.** `0.3.3` keeps a floating reply dock below the history and shows what identity WhatsApp actually provides. The workspace owner chooses one active provider in Settings. Provider choice and AI reply mode are saved per installation on hosted Cadence (`app-storage/v1`), without disconnecting either provider. Provider availability and send approvals remain host-enforced; this setting is not a credential binding. Use a storage-compatible forward build once the migration is applied. Outbound media is not available.
- **0.3.4.** The transcript uses the full conversation pane; the floating reply dock keeps its original width. Selected conversations keep keyboard focus in the desktop list, while narrow layouts move focus into the thread. Status and provider choice belong to Settings, not the list toolbar.
- **Standalone inbox (`0.3.5`).** On a supported linked-device host, an owner can open Contact details to save a shared name, add a private note, set the conversation status, or set a follow-up date. Names are searchable across saved contacts; Follow-ups due includes older conversations. A new inbound message reopens Waiting or Done when the inbox reads it. Follow-ups never send messages. No CRM install or contact sync is required. The app's schema-2 migration preserves provider settings; work attached to a previous linked account is retained but hidden after the account is reset. Older hosts and Official API keep their existing inbox without these controls.
- **Full phone numbers (`0.3.6`).** Linked chats show the full known number even when a shared name is saved. On a compatible host, numbers already learned during pairing or normal sync can identify existing chats. If there is no phone mapping, no number is guessed. Reply routing and account-scoped work IDs are unchanged.
- **Existing linked replies (`0.3.7`).** On a compatible board, an owner replies in an existing linked-device thread using the board composer: Send or Enter once sends, and Shift+Enter adds a line. The board confirms the exact recipient and edited text. Older hosts, Official API and new-number messages retain their existing approval flow.
- **Reply availability (`0.3.8`).** A compatible board keeps the linked reply dock read-only while it verifies the chat. A single status below the conversation header explains a block without hiding history. The app displays host status only; it cannot authorize or send a reply.
- **Inbox layout (`0.3.9`).** The conversation list sits in its own scrollable panel. All and Unread filter loaded chats; keep loading older conversations to extend either view. Follow-up filters remain separate from unread status. A compatible board aligns the text reply dock to the right-hand conversation, or to the full conversation on narrow screens.
- **Inbox layout and unread (`0.3.10`).** On compatible boards the reply dock follows the measured message pane, including when Contact details narrows it, and hides while narrow Contact details replaces the pane. Older boards retain their existing layout. Unread appears only when loaded conversations provide unread counts; if those counts become unavailable, the inbox returns to All.
- **Inbox scroll (`0.3.11`).** Closing mobile Contact details keeps the latest message in view if the reader was already at the bottom. Readers browsing older history are not jumped to the latest message.
- **Overlay composer (`0.3.12`).** Compatible boards float the existing text reply dock inside the conversation. The conversation alone clears the dock so messages and thread actions stay visible; the Inbox rail runs to the bottom. Older boards keep their existing layout.
- **Overlay inset acknowledgement (`0.3.13`).** Replaces the 0.3.12 preflight candidate. The app acknowledges each current overlay inset only after committing conversation padding and preserving the reader's scroll position; compatible boards limit the dock to the acknowledged space.
- **Older message scroll (`0.3.14`).** Loading older rows preserves the reader's position as the dock resizes. Jump to latest takes precedence while an older page is still loading.
- **Floating reply card (`0.3.17`).** The history keeps its full viewport and scrolls behind the board-owned card. Only the message list gets trailing padding equal to the measured dock plus breathing room. Loading older messages or opening narrow Contact Details preserves the reading position. Earlier boards keep the in-flow composer.
- **Linked inbound media (`0.3.18`).** On a compatible host (`wa_media_download=1` / `screen-whatsapp-media.v1`), linked-device messages render inbound and outbound media metadata, captions, explicit unavailable reasons, full-resolution image lightbox, inline voice/audio and video playback via in-memory `blob:` URLs, and host-mediated file downloads while preserving JPEG thumbnail fallbacks on older hosts.
- **Unified status filter & UI polish (`0.3.19`).** Replaces the native `Follow-up` `<select>` with a single-row Option B queue switcher (`@cadence/screen-ui` `Select`) paired with a fast `Due` triage toggle, clean silhouette avatars for phone/group/unknown contacts, non-blank attachment previews, clickable thread status pills, and stronger outbound bubble separation.

Plan: cadence CAD-1465 (`cad1465-waba-plan-20261018.md`).

## Layout

- `app/` — the installable bundle: `app.md`, `app-chat.json`, `workflows/`, and the built `screens/waba/`.
- `src/` — screen source. `src/bridge/` is the frame bridge (copied from CRM, narrowed to the WhatsApp operations).
- `scripts/` — `build_screen.mjs`, `verify_screen.mjs`, `screen_inputs.mjs` and `package_app.py`, copied from CRM.
- `tests/unit/` — packager and SDK-provenance tests.

## Build

```sh
mkdir -p .cadence-ui && tar -xzf .cadence-ui/cadence-screen-ui-1.0.0.tgz -C .cadence-ui
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm run build && pnpm run verify
python3 scripts/package_app.py check --source app
```

The build writes `app/screens/waba/{screens.json,runtime.js,client.js,waba.css}` with asset caps and
source/SDK/toolchain provenance. Commit the rebuilt screen with any source change.
