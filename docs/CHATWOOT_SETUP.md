# Chatwoot Setup

## Create an API Inbox

1. In Chatwoot, create a new API inbox.
2. Copy the inbox ID into `CHATWOOT_INBOX_ID`.
3. Copy the inbox identifier into `CHATWOOT_INBOX_IDENTIFIER`.
4. Create or choose a Chatwoot user access token and set `CHATWOOT_API_TOKEN`.
5. Set `CHATWOOT_BASE_URL` to the public Chatwoot URL.

## Configure Webhook

Set the inbox webhook URL to:

```text
https://bridge.example.com/webhooks/chatwoot
```

If your Chatwoot version supports event filtering, send only `message_created`.

## Required Message Filters

The bridge accepts:

- public outgoing messages
- public template messages

The bridge skips:

- private notes
- non-`message_created` events
- messages marked with `additional_attributes.source = zalo_native`
- messages for a different inbox ID

This prevents loops when the bridge writes incoming Zalo messages back into Chatwoot.

## Template Caveats

Chatwoot can emit automations/canned replies as template message type. The bridge normalizes simple Markdown before sending text to Zalo. Formatting differences should be treated separately from transport delivery: first confirm the template reaches Zalo, then adjust Chatwoot copy if needed.
