---
app: waba
title: WhatsApp Business
version: '0.1.0'
summary: Connect a WhatsApp Business number through FavCRM, read its inbox and send operator-approved replies. The app holds no credentials.
needs:
  connections: []
  requires:
    contracts: {app-screens: [1], screen-records: [1], screen-startup: [1]}
---

# WhatsApp Business

This bundle carries the app's own Inbox and Connection screens under
`screens/waba/`. They call the host's WhatsApp door (`whatsapp.*`
screen operations, cadence CAD-1562), which reaches FavCRM through
AgenticOS. FavCRM owns the connection, Meta credentials, webhook,
messages and send policy. Neither this bundle nor the browser ever
holds a credential or a company id.

The door runs only on a hosted AgenticOS workspace. A self-hosted
daemon refuses every WhatsApp operation, and the screens show that as
an unavailable status, never as "disconnected".

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
  the read fails.
- **Inbox.** Conversations, a conversation and its messages. A reply is
  prepared by the host, which computes its digest, and then sent only
  through the host-drawn approval card over that exact text. An
  `uncertain` reply is never resent; its recorded status can be read.
  When the 24-hour window is closed, free text cannot be sent.

Members see the inbox read-only: the host grants them the reads only,
so the composer and the connect action are not shown.

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
