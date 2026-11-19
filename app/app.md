---
app: waba
title: WhatsApp Business
version: '0.3.2'
summary: Use the official WhatsApp Business connection or a test-only linked device for the inbox and owner-approved replies. The app holds no credentials.
needs:
  connections: []
  requires:
    contracts: {app-screens: [1], screen-records: [1], screen-startup: [1]}
listing:
  tagline: Answer WhatsApp Business chats with AI drafts you approve
  category: customers
  tags: [whatsapp, inbox, messaging]
  publisher:
    name: Cadence
  about: WhatsApp Business connects a FavCRM WhatsApp number to Cadence. A separate linked-device connection is available for disposable-account testing only. Read conversations and approve the exact recipient and text before sending. Templates, broadcasts and the AI agent use the official connection.
  can:
    - Show WhatsApp conversations and messages in one inbox
    - Draft a reply with the assistant, then send only the text you approve
    - Take a conversation over from the AI and hand it back
    - Send approved templates, also when the 24-hour window is closed
    - Send a broadcast you approve, now or scheduled
  data:
    stores:
      - Assistant reply drafts and the AI agent mode you choose
      - Official data stays in FavCRM; linked-device message contents and identifiers are encrypted
      - Linked-device activity timestamps are indexed locally in plaintext
    personal: true
---

# WhatsApp Business

This bundle carries the app's own Inbox, Templates, Broadcasts and
Connection screens under `screens/waba/`. The official WhatsApp door
(`whatsapp.*` screen operations, cadence CAD-1562 and CAD-1590) reaches
FavCRM through AgenticOS. A workspace may separately enable a linked
device for a disposable-account test. Neither this bundle nor the browser
holds a provider credential or selects a workspace id.

Linked-device ingress can lose messages after a crash and is not for
production traffic. The official and linked-device inboxes are separate.
A host without linked-device support refuses that selection; it does not
change the official connection.

## Set up once

From a trusted Cadence source checkout, install this directory, then
approve the exact bundle digest it returns:

```sh
cadence app catalog install <path-to>/app
cadence app catalog approve INSTALL_ID --digest BUNDLE_DIGEST
```

## Screens

- **Connection.** The operator gets a one-hour FavCRM signup link and
  finishes Meta signup with their own login. The link is held in memory
  only. Status always comes from an authoritative read: number,
  business name and webhook health, or an explicit unknown state when
  the read fails. For a linked device, an owner opens workspace account
  settings to start the session and scan the locally rendered QR.
- **Inbox.** Conversations, a conversation and its messages. A reply is
  prepared by the host, which computes its digest, and then sent only
  through the host-drawn approval card over that exact text. An
  `uncertain` reply is never resent; its recorded status can be read.
  When the official connection's 24-hour window is closed, free text
  cannot be sent. A linked-device reply is accepted only when the exact
  WhatsApp server ACK is recorded; acceptance does not confirm delivery.
  Never retry an uncertain send automatically.
- **Templates.** The templates FavCRM holds, with status, revision and
  variables. "Use in conversation" picks a conversation (kept while you
  move between pages) and sends an approved template through the
  host-drawn approval card, also when the 24-hour window is closed.
- **Broadcasts.** Draft (template, variables, and a segment or up to
  1000 accounts), estimate (eligible and excluded), a test send to one
  typed number (at most 5 per broadcast per day), then a review that
  FavCRM freezes and the operator approves in the host card to send now
  or schedule (5 minutes to 7 days ahead). Results come per recipient.
  Stop cancels unsent recipients only and is final; clone to send
  again. "Accepted" or "scheduled" is never a delivery. Meta charges the
  WhatsApp Business Account per delivered marketing message.

- **AI agent.** Choose copilot or human-only for this install (a
  session-only choice where the browser refuses storage). In copilot
  mode the Inbox offers "Draft with assistant": the operator confirms
  the guidance in the host card, the Assistant reads this one
  conversation (last 20 text messages, phone masked) and parks a draft.
  The draft shows as "Assistant draft" with Insert (fills the composer,
  never prepares or sends) and Discard; a successful send discards it.
  Members see the draft read-only. "Automatic replies: unavailable".

- **Takeover.** A taken-over conversation shows "Taken over" (FavCRM's AI is
  paused there). "Take over" pauses it; the app also does so just before your
  first reply on a conversation that is not taken over, and prepares nothing
  if that fails. "Hand back to AI" opens a host card; confirming lets FavCRM's
  AI reply automatically again, and the host refuses it, with its reason, if
  the takeover changed meanwhile. Members see the banner only.

Members see every page read-only: the host grants them the reads only,
so the composer, the connect action and every draft, test, send and
stop control are not shown.

## Reply draft workflow

The `reply-draft` workflow turns a pasted customer message into one
independently reviewed reply draft. It is text for a person to read and
paste into the composer. It sends nothing and reads no conversation.

```sh
cadence app run create INSTALL_ID --workflow reply-draft --inputs ./inputs.json --owner-pm OWNER_PM --request-id UNIQUE_REQUEST_ID
```

Inputs are single-line strings: `customer_message`, `facts`, `writer`
and `reviewer` (two different registered workers in the owner PM
group). Never present an approved draft as a sent reply.
