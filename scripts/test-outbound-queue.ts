import assert from "assert";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { OutboundDeliveryError, OutboundDeliveryQueue, type OutboundJobInput } from "../src/outboundDeliveryQueue";
import { RuntimeStatus } from "../src/runtimeStatus";
import { createServer } from "../src/server";
import { ZaloPersonalClient } from "../src/zaloClient";

async function listen(app: ReturnType<typeof createServer>) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

function testLogger(lines: string[]) {
  return {
    log: (...values: unknown[]) => lines.push(JSON.stringify(values)),
    warn: (...values: unknown[]) => lines.push(JSON.stringify(values)),
    error: (...values: unknown[]) => lines.push(JSON.stringify(values)),
  };
}

function readyStatus() {
  const status = new RuntimeStatus({ accountId: 2, inboxId: 1 });
  status.markZaloConnected();
  status.markListenerStarted();
  return status;
}

async function readJsonFixture(filePath: string): Promise<any> {
  const serialized = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(serialized);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`invalid outbound queue test fixture: ${detail}`);
  }
}

function makeServerDeps(outboundQueue: OutboundDeliveryQueue, calls: string[], status = readyStatus()) {
  let nextId = 0;
  return {
    chatwootClient: { getConversation: async () => ({ body: {} }) } as any,
    zaloClient: {
      sendText: async (_threadId: string, text: string) => { calls.push(`text:${text}`); return `z-${++nextId}`; },
      sendImage: async (_threadId: string, _url: string, filename?: string) => { calls.push(`image:${filename}`); return `z-${++nextId}`; },
      sendFile: async (_threadId: string, _url: string, filename?: string) => { calls.push(`file:${filename}`); return `z-${++nextId}`; },
      sendDocument: async (_threadId: string, _url: string, filename?: string) => { calls.push(`file:${filename}`); return `z-${++nextId}`; },
      getSelfUid: () => null,
    } as any,
    cache: { has: () => false, add: () => {}, addMany: () => {}, addWithTtl: () => {} } as any,
    inboxId: 1,
    threadMap: new Map<number, string>(),
    messageMap: new Map(),
    outboundQueue,
    runtimeStatus: status,
    threadIdPrefixes: ["zalo:", "zalo2:"],
  };
}

function webhook(messageId: number) {
  return {
    event: "message_created",
    message: {
      id: messageId,
      message_type: "outgoing",
      inbox_id: 1,
      conversation_id: 42,
      content: "Synthetic delivery check",
      attachments: [
        { data_url: "https://files.example.test/first.pdf", file_type: "application/pdf", file_name: "first.pdf" },
        { data_url: "https://files.example.test/second.png", file_type: "image/png", file_name: "second.png" },
        { data_url: "https://files.example.test/third.pdf", file_type: "application/pdf", file_name: "third.pdf" },
      ],
    },
    conversation: { id: 42, inbox_id: 1 },
    contact: { identifier: "zalo:123456789" },
  };
}

async function postWebhook(base: string, body: unknown) {
  return fetch(`${base}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
}

async function testSerialOrderRetryAndPartialFailure(root: string) {
  const calls: number[] = [];
  const logs: string[] = [];
  let active = 0;
  let maxActive = 0;
  let firstItemAttempts = 0;
  const queuePath = path.join(root, "serial", "queue.json");
  const queue = new OutboundDeliveryQueue({
    filePath: queuePath,
    logger: testLogger(logs),
    retryDelaysMs: [1],
  });
  await queue.load();
  queue.setProcessor(async (_job, item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(item.index);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (item.index === 0 && firstItemAttempts++ === 0) {
      throw new OutboundDeliveryError("pre_submit_network_failure", "retryable");
    }
    if (item.index === 2) throw new OutboundDeliveryError("permanent_attachment_rejection", "failed");
    return { zaloMessageId: `z-${item.index}` };
  });
  const job: OutboundJobInput = {
    conversationId: 12,
    messageId: 34,
    threadId: "private-thread-should-not-be-logged",
    items: [
      { kind: "text", text: "private synthetic text" },
      { kind: "image", url: "https://private.example.test/a", fileName: "private-a.png" },
      { kind: "file", url: "https://private.example.test/b", fileName: "private-b.pdf" },
      { kind: "file", url: "https://private.example.test/c", fileName: "private-c.pdf" },
    ],
  };
  await queue.enqueue(job);
  queue.start();
  await queue.waitForIdle();

  assert.deepStrictEqual(calls, [0, 0, 1, 2, 3]);
  assert.strictEqual(maxActive, 1);
  const stored = queue.snapshot()[0];
  assert.strictEqual(stored.state, "partial");
  assert.deepStrictEqual(stored.items.map((item) => item.state), ["accepted", "accepted", "failed", "accepted"]);
  assert.strictEqual(stored.items[0].attempts, 2);
  assert.strictEqual(stored.items[2].failureCategory, "permanent_attachment_rejection");

  const directoryMode = (await fs.stat(path.dirname(queuePath))).mode;
  assert.strictEqual((directoryMode & 0o777) === 0o700, true);
  assert.strictEqual(((await fs.stat(queuePath)).mode & 0o777) === 0o600, true);
  const serializedLogs = logs.join("\n");
  for (const privateValue of ["private synthetic text", "private-thread-should-not-be-logged", "private.example.test", "private-a.png"]) {
    assert(!serializedLogs.includes(privateValue), `log leaked ${privateValue}`);
  }
}

async function testPersistedCallbackAndDuplicateSuppression(root: string) {
  const queuePath = path.join(root, "callback", "private", "queue.json");
  const queue = new OutboundDeliveryQueue({ filePath: queuePath, logger: testLogger([]) });
  await queue.load();
  const calls: string[] = [];
  const app = createServer(makeServerDeps(queue, calls));
  const { server, base } = await listen(app);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    return originalFetch(_input, init);
  }) as typeof fetch;
  try {
    const first = await postWebhook(base, webhook(901));
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(await first.json(), { success: true, queued: true });
    assert.strictEqual(queue.snapshot().length, 1);
    assert.strictEqual(queue.snapshot()[0].items.length, 4);
    assert((await fs.stat(queuePath)).mode & 0o077 ? false : true, "queue file must be private");

    const duplicateWhileQueued = await postWebhook(base, webhook(901));
    assert.deepStrictEqual(await duplicateWhileQueued.json(), { success: true, queued: false, duplicate: true });
    assert.strictEqual(queue.snapshot().length, 1);
    assert.deepStrictEqual(calls, []);

    queue.start();
    await queue.waitForIdle();
    assert.deepStrictEqual(calls, [
      "text:Synthetic delivery check",
      "file:first.pdf",
      "image:second.png",
      "file:third.pdf",
    ]);
    assert.deepStrictEqual(queue.snapshot()[0].items.map((item) => item.state), ["accepted", "accepted", "accepted", "accepted"]);

    const reloaded = new OutboundDeliveryQueue({ filePath: queuePath, logger: testLogger([]) });
    await reloaded.load();
    const duplicateAfterRestart = await reloaded.enqueue({
      conversationId: 42,
      messageId: 901,
      threadId: "123456789",
      items: [],
    });
    assert.strictEqual(duplicateAfterRestart.duplicate, true);
    assert.strictEqual(calls.length, 4);
    const saved = await fs.readFile(queuePath, "utf8");
    for (const privateValue of ["Synthetic delivery check", "https://files.example.test", "first.pdf"]) {
      assert(!saved.includes(privateValue), `completed payload retained ${privateValue}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function testPersistenceFailureDoesNotSend(root: string) {
  const parent = path.join(root, "unwritable-queue-parent");
  const queuePath = path.join(parent, "queue.json");
  const queue = new OutboundDeliveryQueue({ filePath: queuePath, logger: testLogger([]) });
  await queue.load();
  await fs.writeFile(parent, "blocks directory creation", { mode: 0o600 });
  const calls: string[] = [];
  const { server, base } = await listen(createServer(makeServerDeps(queue, calls)));
  try {
    const response = await postWebhook(base, webhook(902));
    assert.strictEqual(response.status, 503);
    assert.deepStrictEqual(await response.json(), { success: false, error: "outbound_queue_unavailable" });
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(queue.snapshot().length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function testInFlightRecoveryIsNotReplayed(root: string) {
  const queuePath = path.join(root, "restart", "queue.json");
  const initial = new OutboundDeliveryQueue({ filePath: queuePath, logger: testLogger([]) });
  await initial.load();
  await initial.enqueue({
    conversationId: 3,
    messageId: 5,
    threadId: "123456789",
    items: [{ kind: "file", url: "https://example.test/in-flight.pdf", fileName: "in-flight.pdf" }],
  });
  const raw = await readJsonFixture(queuePath);
  raw.jobs[0].state = "sending";
  raw.jobs[0].items[0].state = "sending";
  raw.jobs[0].items[0].attempts = 1;
  await fs.writeFile(queuePath, JSON.stringify(raw), { mode: 0o600 });

  const recovered = new OutboundDeliveryQueue({ filePath: queuePath, logger: testLogger([]) });
  await recovered.load();
  let sendCalls = 0;
  recovered.setProcessor(async () => { sendCalls += 1; return { zaloMessageId: "unexpected" }; });
  recovered.start();
  await recovered.waitForIdle();
  assert.strictEqual(sendCalls, 0);
  assert.strictEqual(recovered.snapshot()[0].items[0].state, "unknown");
  assert.strictEqual(recovered.snapshot()[0].items[0].failureCategory, "interrupted_during_send");
}

async function testRetryLimit(root: string) {
  const queue = new OutboundDeliveryQueue({
    filePath: path.join(root, "retry-limit", "queue.json"),
    maxAttempts: 2,
    retryDelaysMs: [1],
    logger: testLogger([]),
  });
  await queue.load();
  let attempts = 0;
  queue.setProcessor(async () => {
    attempts += 1;
    throw new OutboundDeliveryError("still_pre_submit_transient", "retryable");
  });
  await queue.enqueue({
    conversationId: 4,
    messageId: 6,
    threadId: "123456789",
    items: [{ kind: "file", url: "https://example.test/retry.pdf", fileName: "retry.pdf" }],
  });
  queue.start();
  await queue.waitForIdle();
  assert.strictEqual(attempts, 2);
  assert.strictEqual(queue.snapshot()[0].items[0].state, "failed");
  assert.strictEqual(queue.snapshot()[0].items[0].attempts, 2);
}

async function testAmbiguousFetchTimeoutDoesNotRetry(root: string) {
  const queue = new OutboundDeliveryQueue({filePath: path.join(root, "fetch-unknown", "queue.json"), logger: testLogger([])});
  await queue.load();
  let calls = 0;
  queue.setProcessor(async () => { calls++; throw new OutboundDeliveryError("zalo_api_fetch_timeout", "unknown"); });
  await queue.enqueue({conversationId: 9, messageId: 10, threadId: "fixture", items: [{kind: "file", url: "https://fixture.invalid"}]});
  queue.start();
  await queue.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(queue.snapshot()[0].items[0].state, "unknown");
}

async function testUploadCallbackTimeoutRetriesOnce(root: string) {
  const queue = new OutboundDeliveryQueue({
    filePath: path.join(root, "upload-callback-timeout", "queue.json"),
    retryDelaysMs: [1],
    logger: testLogger([]),
  });
  await queue.load();
  let attempts = 0;
  let textAttempts = 0;
  queue.setProcessor(async (_job, item) => {
    if (item.kind === "text") { textAttempts++; return {zaloMessageId: "fixture-text"}; }
    attempts += 1;
    throw new OutboundDeliveryError("zalo_upload_callback_timeout", "retryable");
  });
  await queue.enqueue({
    conversationId: 5,
    messageId: 7,
    threadId: "123456789",
    items: [{kind: "text", text: "synthetic"}, { kind: "file", url: "https://example.test/callback-timeout.pdf", fileName: "callback-timeout.pdf" }],
  });
  queue.start();
  await queue.waitForIdle();

  const item = queue.snapshot()[0].items[1];
  assert.strictEqual(textAttempts, 1, "file retry must never replay accepted text");
  assert.strictEqual(attempts, 2, "upload callback timeout gets one retry only");
  assert.strictEqual(item.state, "failed", "SDK callback timeout happens before the message is submitted");
  assert.strictEqual(item.attempts, 2);
  assert.strictEqual(item.retryPending, false);
  assert.strictEqual(item.failureCategory, "zalo_upload_callback_timeout");
}

async function testInterruptedUploadCallbackRetryIsNotReplayed(root: string) {
  const queuePath = path.join(root, "upload-callback-restart", "queue.json");
  const initial = new OutboundDeliveryQueue({ filePath: queuePath, logger: testLogger([]) });
  await initial.load();
  await initial.enqueue({
    conversationId: 6,
    messageId: 8,
    threadId: "123456789",
    items: [{ kind: "file", url: "https://example.test/retry-interrupted.pdf", fileName: "retry-interrupted.pdf" }],
  });
  const raw = await readJsonFixture(queuePath);
  raw.jobs[0].items[0].attempts = 1;
  raw.jobs[0].items[0].failureCategory = "zalo_upload_callback_timeout_retry_pending";
  raw.jobs[0].items[0].retryPending = true;
  await fs.writeFile(queuePath, JSON.stringify(raw), { mode: 0o600 });

  const recovered = new OutboundDeliveryQueue({ filePath: queuePath, logger: testLogger([]) });
  await recovered.load();
  let sendCalls = 0;
  recovered.setProcessor(async () => { sendCalls += 1; return { zaloMessageId: "unexpected" }; });
  recovered.start();
  await recovered.waitForIdle();
  assert.strictEqual(sendCalls, 0);
  assert.strictEqual(recovered.snapshot()[0].items[0].state, "unknown");
  assert.strictEqual(recovered.snapshot()[0].items[0].failureCategory, "zalo_api_timeout_retry_interrupted");
}

async function testMissingProviderIdDoesNotDoubleSubmit() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;
  try {
    for (const kind of ["image", "file"] as const) {
      let sdkCalls = 0;
      const client = new ZaloPersonalClient({ imei: "", userAgent: "", language: "vi", cookieJson: "", sessionFile: "" });
      (client as any).api = {
        sendMessage: async () => {
          sdkCalls += 1;
          return {};
        },
      };
      const outcome = kind === "image"
        ? await client.sendImage("123456789", "https://example.test/private.png", "private.png")
        : await client.sendFile("123456789", "https://example.test/private.pdf", "private.pdf");
      assert.strictEqual(outcome, null);
      assert.strictEqual(sdkCalls, 1, `${kind} must not be retried through a second SDK path without an idempotency key`);
    }

    let cooldownCalls = 0;
    const cooldownClient = new ZaloPersonalClient({ imei: "", userAgent: "", language: "vi", cookieJson: "", sessionFile: "" });
    (cooldownClient as any).api = {sendMessage: async () => { cooldownCalls++; throw new Error("zalo_upload_confirmation_cooldown"); }};
    await assert.rejects(cooldownClient.sendFile("123456789", "https://example.test/fixture.pdf", "fixture.pdf"), /zalo_upload_confirmation_cooldown/);
    assert.equal(cooldownCalls, 1, "cooldown must not invoke a fallback send");

    let callbackTimeoutCalls = 0;
    const timeoutClient = new ZaloPersonalClient({ imei: "", userAgent: "", language: "vi", cookieJson: "", sessionFile: "" });
    (timeoutClient as any).api = {
      sendMessage: async () => {
        callbackTimeoutCalls += 1;
        throw new Error("zalo_upload_callback_timeout");
      },
    };
    await assert.rejects(timeoutClient.sendFile("123456789", "https://example.test/private.pdf", "private.pdf"), /zalo_upload_callback_timeout/);
    assert.strictEqual(callbackTimeoutCalls, 1, "callback timeout must not trigger URL fallback resubmission");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zalo-outbound-queue-test-"));
  try {
    await testSerialOrderRetryAndPartialFailure(root);
    await testPersistedCallbackAndDuplicateSuppression(root);
    await testPersistenceFailureDoesNotSend(root);
    await testInFlightRecoveryIsNotReplayed(root);
    await testRetryLimit(root);
    await testAmbiguousFetchTimeoutDoesNotRetry(root);
  await testUploadCallbackTimeoutRetriesOnce(root);
    await testInterruptedUploadCallbackRetryIsNotReplayed(root);
    await testMissingProviderIdDoesNotDoubleSubmit();
    console.log("[test:outbound-queue] ok");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
