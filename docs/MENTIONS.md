# Zalo Group Mentions

The bridge supports explicit mention markers in Chatwoot messages:

```text
[[zalo:alice,bob]] please check this
```

For a configured group, the bridge removes the marker, inserts missing labels if needed, and sends native mention metadata to Zalo.

## Config File

Default path:

```text
data/zalo-mentions.json
```

Example:

```json
{
  "groups": {
    "group:1234567890": {
      "alice": { "uid": "100000000000000001", "label": "@Alice" },
      "bob": { "uid": "100000000000000002", "label": "@Bob" },
      "team": { "disabled": true, "members": ["alice", "bob"] }
    }
  }
}
```

Use fake IDs in examples and tests. Real group IDs, user UIDs, staff names, aliases, and team mappings belong only in your private runtime `data/` directory.
