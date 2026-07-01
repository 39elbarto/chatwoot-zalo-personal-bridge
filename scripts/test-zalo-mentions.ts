import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { extractZaloMentionMarkers, ZaloMentionResolver } from "../src/zaloMentions";

async function main() {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zalo-mentions-"));
  const configPath = path.join(tmpDir, "zalo-mentions.json");

  await fs.promises.writeFile(
    configPath,
    JSON.stringify(
      {
        groups: {
          "group:1234567890": {
            alice: { uid: "100000000000000001", label: "@Alice" },
            bob: { uid: "100000000000000002", label: "@Bob" },
            carol: { uid: "100000000000000003", label: "@Carol" },
            team: { disabled: true, members: ["alice", "bob", "carol"] },
          },
        },
      },
      null,
      2,
    ),
  );

  const resolver = new ZaloMentionResolver(configPath);

{
  const parsed = extractZaloMentionMarkers("[[zalo:alice,bob]] @Alice @Bob please check");
  assert.deepStrictEqual(parsed.aliases, ["alice", "bob"]);
  assert.strictEqual(parsed.text, "@Alice @Bob please check");
}

{
  const result = resolver.resolve("group:1234567890", "[[zalo:alice]] @Alice please check");
  assert.strictEqual(result.text, "@Alice please check");
  assert.deepStrictEqual(result.mentions, [{ pos: 0, uid: "100000000000000001", len: "@Alice".length }]);
  assert.deepStrictEqual(result.missingAliases, []);
}

{
  const result = resolver.resolve("group:1234567890", "[[zalo:alice,bob]] please check");
  assert.strictEqual(result.text, "@Alice @Bob please check");
  assert.deepStrictEqual(result.insertedLabels, ["@Alice", "@Bob"]);
  assert.deepStrictEqual(
    result.mentions.map((mention) => ({ pos: mention.pos, uid: mention.uid, len: mention.len })),
    [
      { pos: 0, uid: "100000000000000001", len: "@Alice".length },
      { pos: "@Alice ".length, uid: "100000000000000002", len: "@Bob".length },
    ],
  );
}

{
  const result = resolver.resolve("group:1234567890", "[[zalo:carol]] @Carol test unicode-safe path");
  assert.strictEqual(result.text, "@Carol test unicode-safe path");
  assert.deepStrictEqual(result.mentions, [{ pos: 0, uid: "100000000000000003", len: "@Carol".length }]);
}

{
  const result = resolver.resolve("group:1234567890", "[[zalo:team]] @Team check");
  assert.strictEqual(result.text, "@Team check");
  assert.deepStrictEqual(result.mentions, []);
  assert.deepStrictEqual(result.missingAliases, ["team"]);
}

{
  const result = resolver.resolve("group:unconfigured", "[[zalo:alice]] @Alice check");
  assert.strictEqual(result.text, "@Alice check");
  assert.deepStrictEqual(result.mentions, []);
  assert.deepStrictEqual(result.missingAliases, ["alice"]);
  assert.strictEqual(result.configuredGroup, false);
}

{
  const result = resolver.resolve("group:1234567890", "ordinary message");
  assert.strictEqual(result.text, "ordinary message");
  assert.deepStrictEqual(result.mentions, []);
  assert.deepStrictEqual(result.aliases, []);
}

  console.log("[test:zalo-mentions] ok");
}

main().catch((err) => {
  console.error("[test:zalo-mentions] failed", err);
  process.exit(1);
});
