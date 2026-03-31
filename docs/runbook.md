# Runbook

- Set Railway variables from `.env.example`
- Attach a persistent volume to `/data`
- Invite the bot with `View Channels`, `Read Message History`, `Send Messages`, `Embed Links`, `Attach Files`, `Use Slash Commands`
- Enable the `MESSAGE_CONTENT` privileged intent
- Start the service and run `/panel` in Discord for day-to-day administration (or `/setup` if you prefer the legacy flow)
- See [docs/discord-panel.md](docs/discord-panel.md) for the full panel guide and queue restart flow
- For glossary import use `/panel` -> `Импорт glossary` or `/glossary import`; both open a text modal, not a file picker

## Raw intake channel behavior

The bot accepts messages in a configured raw intake channel under two categories:

**Follow / crosspost messages** (existing behavior):
- Messages posted by a webhook (`webhookId` present)
- Messages with Discord crosspost flags (`Crossposted`, `IsCrosspost`, `SourceMessageDeleted`)
- Messages scoring ≥ 2 on the combination of the above signals plus `message_reference` and channel mentions are accepted with `"high"` confidence; a single webhook or crosspost flag yields `"medium"` confidence (`"likely_follow"`).

**Forwarded / shared messages** (new behavior):
- Messages using Discord's native Forward feature (identified by `messageSnapshots` in the payload)
- Messages that reference another message (`message_reference`) and also carry text content, embeds, or attachments
- Messages that carry embeds or attachments but have no webhook — e.g. a user pasted a link or shared media from an announcement into the raw channel

Accepted forwarded/shared messages are logged with `accept_reason: "forwarded_or_shared"` in the `job_created` event.

**Always rejected**:
- Bot's own messages
- Messages with no meaningful content, no reference, no embeds, and no attachments (plain user text not matching any of the above patterns) — logged as `"rejected_unsupported_raw_message"`
- Messages in channels not mapped via `/setup`
