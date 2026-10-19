# Cadence app: WhatsApp Business (WABA)

An installable Cadence app that ships its own screens. Step 1 (WABA-1) ships **Inbox** and
**Connection**; Broadcasts, Templates and the AI agent come in later steps.
It follows the same layout as `favcrm/cadence-app-crm`: an `app/` bundle with `screens/waba/`,
built on the host's pinned screen-ui SDK.

- **Source of truth.** FavCRM owns the WhatsApp Business connection, Meta credentials, the webhook, messages, templates, consent and dispatch.
- **Host door.** The Cadence host reaches FavCRM through a declaration-gated messaging door via AgenticOS (cadence CAD-1562, agenticos-v2 AOS-287).
  The screen declares the `whatsapp.*` operations; neither the app nor the browser ever holds a credential or a company id.
- **Approvals.** Every outbound reply is prepared by the host and sent only through the host-drawn approval card over that exact text.
- **Members** get the reads only: the inbox shows without the composer or the connect action.

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
