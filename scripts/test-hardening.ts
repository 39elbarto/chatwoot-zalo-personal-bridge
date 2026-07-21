import assert from "assert";
import type { AddressInfo } from "net";
import { buildNativeAgentMessageBody } from "../src/chatwootClient";
import { RuntimeStatus, resolveAccountIdentityState } from "../src/runtimeStatus";
import { createServer, normalizeRoutePrefixes, normalizeThreadId, resolveThreadId } from "../src/server";
import { extractQuoteReference } from "../src/zaloClient";
import { normalizeRecommendedLinkMessage } from "../src/zaloSystemMessages";

const linkCases = [
  {
    raw: {
      action: "recommened.link",
      title: "Book a visit",
      description: "Choose a time",
      href: "https://example.test/booking",
      params: "{}",
    },
    content: "🔗 Book a visit\n\nChoose a time\n\nhttps://example.test/booking",
  },
  {
    raw: {
      action: "recommened.link",
      title: "Services",
      params: { href: "https://example.test/services" },
    },
    content: "🔗 Services\n\nhttps://example.test/services",
  },
  {
    raw: {
      action: "recommened.link",
      title: "See https://example.test/help",
      description: "Help",
    },
    content: "🔗 See\n\nHelp\n\nhttps://example.test/help",
  },
  {
    raw: {
      action: "recommened.link",
      title: "Unsafe",
      href: "javascript:unsafe()",
      params: { href: "data:text/plain,x" },
    },
    content: "🔗 Unsafe",
  },
];

async function main() {
  for (const test of linkCases) {
    const normalized = normalizeRecommendedLinkMessage(JSON.stringify(test.raw));
    assert(normalized);
    assert.strictEqual(normalized.content, test.content);
    assert(!normalized.content.includes("params"));
    assert(!normalized.content.includes("/storage/emulated"));
  }
  const malformed = normalizeRecommendedLinkMessage(
    '{"action":"recommened.link","title":"Page","params":"{broken"}',
  );
  assert.strictEqual(malformed?.content, "🔗 Page");
  const duplicate = normalizeRecommendedLinkMessage(JSON.stringify({
    action: "recommened.link",
    title: "Read HTTPS://EXAMPLE.TEST/Guide",
    description: "HTTPS://EXAMPLE.TEST/Guide",
    href: "https://example.test/Guide",
  }));
  assert.strictEqual(duplicate?.content.match(/https?:\/\//gi)?.length, 1);

  const accepted: Array<[unknown, string]> = [
    ["1234567890", "1234567890"],
    [" zalo:1234567890 ", "1234567890"],
    ["zalo-alt:1234567890-dup", "1234567890"],
    ["group:1234567890", "group:1234567890"],
  ];
  for (const [raw, expected] of accepted) {
    assert.strictEqual(normalizeThreadId(raw as string, ["zalo:", "zalo-alt:"]), expected);
  }
  for (const raw of ["", "0", "group:0", "-1", "1.2", "zalo:zalo-alt:123", "123 456", "group::123"]) {
    assert.strictEqual(normalizeThreadId(raw, ["zalo:", "zalo-alt:"]), null, raw);
  }
  assert.deepStrictEqual(resolveThreadId([
    { raw: "bad", source: "threadMap" },
    { raw: "zalo-alt:1234567890", source: "contactIdentifier" },
  ], ["zalo-alt:"]), { threadId: "1234567890", source: "contactIdentifier" });
  assert.deepStrictEqual(normalizeRoutePrefixes(["/bridge-a/", "bridge-b", "/bridge-a", "../bad"]), [
    "/bridge-a",
    "/bridge-b",
  ]);

  assert.strictEqual(resolveAccountIdentityState("", "1234567890"), "not_configured");
  assert.strictEqual(resolveAccountIdentityState("1234567890", "1234567890"), "match");
  assert.strictEqual(resolveAccountIdentityState("1234567890", "1000000001"), "mismatch");
  assert.strictEqual(resolveAccountIdentityState("1234567890", null), "unknown_with_expectation");

  assert.deepStrictEqual(extractQuoteReference({ globalMsgId: 8001, msg: "Earlier" }), {
    targetMsgId: "8001",
    targetPreview: "Earlier",
  });
  assert.deepStrictEqual(extractQuoteReference(JSON.stringify({ qmsgId: "8002", content: "Quoted" })), {
    targetMsgId: "8002",
    targetPreview: "Quoted",
  });
  const nativeBody = buildNativeAgentMessageBody({
    content: "Reply",
    replyToId: 1201,
    targetZaloMsgId: "8001",
  });
  assert.strictEqual(nativeBody.reply_to, 1201);
  assert.deepStrictEqual(nativeBody.content_attributes, { in_reply_to: 1201 });

  let sdkCalls = 0;
  const status = new RuntimeStatus({ accountId: 1, inboxId: 1 });
  status.setAccountState("match");
  const app = createServer({
    chatwootClient: { getConversation: async () => ({ body: {} }) } as any,
    zaloClient: {
      sendText: async () => { sdkCalls += 1; return "1"; },
      sendImage: async () => { sdkCalls += 1; return "1"; },
      sendFile: async () => { sdkCalls += 1; return "1"; },
      sendDocument: async () => { sdkCalls += 1; return "1"; },
      getSelfUid: () => null,
    } as any,
    cache: { has: () => false, add: () => {}, addMany: () => {}, addWithTtl: () => {} } as any,
    inboxId: 1,
    threadMap: new Map(),
    messageMap: new Map(),
    runtimeStatus: status,
    threadIdPrefixes: ["zalo:", "zalo-alt:"],
    routePrefixes: ["/bridge-a"],
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const healthPaths = ["/health", "/bridge-a/health"];
  for (const path of healthPaths) {
    assert.strictEqual((await fetch(base + path, { signal: AbortSignal.timeout(5_000) })).status, 503);
  }
  const blocked = await fetch(base + "/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(5_000),
  });
  assert.strictEqual(blocked.status, 503);
  assert.strictEqual(sdkCalls, 0);

  status.markZaloConnected();
  status.markListenerStarted();
  const healthPayloads = [];
  for (const path of healthPaths) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(5_000) });
    assert.strictEqual(response.status, 200);
    healthPayloads.push(await response.json());
  }
  for (const payload of healthPayloads) assert.deepStrictEqual(payload, healthPayloads[0]);
  const serialized = JSON.stringify(healthPayloads[0]).toLowerCase();
  for (const forbidden of ["uid", "token", "cookie", "imei", "thread_id", "contact_id"]) {
    assert(!serialized.includes(forbidden), forbidden);
  }

  const callbackPaths = ["/callback", "/webhooks/chatwoot", "/bridge-a/callback"];
  const invalidPayload = {
    event: "message_created",
    message: { id: 99, message_type: "outgoing", inbox_id: 1, content: "test" },
    contact: { identifier: "zalo:not-a-thread" },
  };
  for (const path of callbackPaths) {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invalidPayload),
      signal: AbortSignal.timeout(5_000),
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { success: true, skipped: "invalid_thread_id" });
  }
  assert.strictEqual(sdkCalls, 0);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  console.log("[test:hardening] ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
