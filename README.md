# Cadence app: WhatsApp Business (WABA)

An installable Cadence app with **Inbox** and **Settings**. The Inbox's **Tools**
menu shows **Templates**, **Broadcasts** and **AI agent** only for Official API.
These tools no longer have independent sidebar routes.
It follows the same layout as `favcrm/cadence-app-crm`: an `app/` bundle with `screens/waba/`,
built on the host's pinned screen-ui SDK.

- **Source of truth.** FavCRM owns the WhatsApp Business connection, Meta credentials, the webhook, messages, templates, consent and dispatch.
- **Host door.** The Cadence host reaches FavCRM through a declaration-gated messaging door via AgenticOS (cadence CAD-1562, agenticos-v2 AOS-287).
  The screen declares the `whatsapp.*` operations; neither the app nor the browser ever holds a credential or a company id.
- **Approvals.** Every outbound reply is prepared by the host and sent only through the host-drawn approval card over that exact text.
- **Members** get the reads only: the inbox shows without the composer or the connect action.
- **Linked photo previews.** On a compatible hosted backend, the inbox displays bounded JPEG previews supplied with ordinary linked-device photos. It never fetches provider URLs or shows view-once photos. Older messages, documents, video and audio do not gain photo previews.
- **Inbox layout.** `0.3.3` keeps a floating reply dock below the history and shows what identity WhatsApp actually provides. The workspace owner chooses one active provider in Settings. Provider choice and AI reply mode are saved per installation on hosted Cadence (`app-storage/v1`), without disconnecting either provider. Provider availability and send approvals remain host-enforced; this setting is not a credential binding. Use a storage-compatible forward build once the migration is applied. Outbound media is not available.
- **0.3.4.** The transcript uses the full conversation pane; the floating reply dock keeps its original width. Selected conversations keep keyboard focus in the desktop list, while narrow layouts move focus into the thread. Status and provider choice belong to Settings, not the list toolbar.
- **Standalone inbox (`0.3.5`).** On a supported linked-device host, an owner can open Contact details to save a shared name, add a private note, set the conversation status, or set a follow-up date. Names are searchable across saved contacts; Follow-ups due includes older conversations. A new inbound message reopens Waiting or Done when the inbox reads it. Follow-ups never send messages. No CRM install or contact sync is required. The app's schema-2 migration preserves provider settings; work attached to a previous linked account is retained but hidden after the account is reset. Older hosts and Official API keep their existing inbox without these controls.
- **Full phone numbers (`0.3.6`).** Linked chats show the full known number even when a shared name is saved. On a compatible host, numbers already learned during pairing or normal sync can identify existing chats. If there is no phone mapping, no number is guessed. Reply routing and account-scoped work IDs are unchanged.

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
