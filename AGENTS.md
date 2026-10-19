# Cadence WhatsApp Business app development

This repository is the installable `waba` app. Read README.md before modifying it. Preserve
the installed app identity `waba`. The layout and tooling follow `favcrm/cadence-app-crm`.

Keep the generic shell/chat, shared visual components, authorization, scoped storage,
credentials, approval gates and effect execution in the Cadence host. Screens call only the
host's declared `whatsapp.*` screen operations (cadence CAD-1562); use their exact names and
argument shapes. Never vendor host controls to force a build.

No credentials, company ids, production state or real customer data in this repository. No
host rollout or external sends. Work on a task branch; check existing work before creating a
duplicate PR. Report exact source/artifact revisions, real check exit codes, and unimplemented
interfaces honestly.

Checks: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run build`,
`pnpm run verify`, `python3 scripts/package_app.py check --source app`,
`python3 -m unittest discover -s tests/unit`, and `cadence app check app` with a host build
that knows the `whatsapp.*` operations. The SDK must first be extracted to
`.cadence-ui/package` exactly as the CI step does.
