# Cadence app: WhatsApp Business (WABA)

An installable Cadence app that ships its own screens: Inbox, Broadcasts, Templates, AI agent and Connection.
It follows the same layout as `favcrm/cadence-app-crm`: an `app/` bundle with `screens/waba/`, built on the host's screen-ui SDK.

- **Source of truth.** FavCRM owns the WhatsApp Business connection, Meta credentials, the webhook, messages, templates, consent and dispatch.
- **Host door.** The Cadence host reaches FavCRM through a declaration-gated messaging door via AgenticOS (cadence CAD-1562, agenticos-v2 AOS-287).
  Neither the app nor the browser ever holds a credential.
- **Approvals.** Every outbound message is a host `send` effect behind a host-drawn approval.

Plan: cadence CAD-1465 (`cad1465-waba-plan-20261018.md`). Step 1 is connect, inbox and an operator-approved reply.
