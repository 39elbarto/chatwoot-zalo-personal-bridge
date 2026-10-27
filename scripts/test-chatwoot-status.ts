import assert from "assert";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { ChatwootClient } from "../src/chatwootClient";
import { OutboundDeliveryError, OutboundDeliveryQueue } from "../src/outboundDeliveryQueue";
import { createServer } from "../src/server";
import { RuntimeStatus } from "../src/runtimeStatus";

async function waitDurableAck(queue: OutboundDeliveryQueue, conversationId: number, messageId: number): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if ((await queue.retryState(conversationId, messageId))?.state === "acknowledged") return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("durable feedback acknowledgement timeout");
}

async function main() {
  const originalFetch = globalThis.fetch;
  const calls: Array<{url: string; body: any}> = [];
  const client = new ChatwootClient({baseUrl: "https://chatwoot.example.test", apiToken: "fixture", accountId: 1, inboxId: 1, inboxIdentifier: "fixture"});
  try {
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({url: String(url), body});
      return new Response(JSON.stringify({status: body.status, content_attributes:{external_error:body.external_error}}), {status: 200});
    }) as typeof fetch;
    await client.markOutboundFailed(7, 8, "Attachment failed.");
    assert.equal(calls[0].url, "https://chatwoot.example.test/api/v1/accounts/1/conversations/7/messages/8");
    assert.deepEqual(calls[0].body, {status: "failed", external_error: "Attachment failed."});
    globalThis.fetch = (async (url: any) => {
      assert.equal(String(url), "https://chatwoot.example.test/api/v1/accounts/1/conversations/7/messages?after=8&before=9");
      return new Response(JSON.stringify({payload:[{id:8,status:"sent"}]}), {status:200});
    }) as typeof fetch;
    assert.equal((await client.getMessageForRetry(7, 8))?.status, "sent");
    globalThis.fetch = (async () => new Response(JSON.stringify({status:"sent"}), {status:200})) as typeof fetch;
    await assert.rejects(client.markOutboundFailed(7, 8, "Attachment failed."), /unconfirmed/);
  } finally { globalThis.fetch = originalFetch; }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zalo-status-test-"));
  try {
    const filePath = path.join(root, "queue.json");
    const logger = {log() {}, warn() {}, error() {}};
    const queue = new OutboundDeliveryQueue({filePath, logger});
    await queue.load();
    const processed: string[] = [];
    let feedback = 0;
    queue.setTerminalHandler(async job => { feedback++; assert.equal(job.state, "partial"); throw new Error("fixture"); });
    queue.setProcessor(async (job, item) => {
      processed.push(`${job.messageId}:${item.kind}`);
      if (item.kind === "file") throw new OutboundDeliveryError("synthetic_failure", "failed");
      return {zaloMessageId: "synthetic-id"};
    });
    queue.start();
    await queue.enqueue({conversationId: 1, messageId: 1, threadId:"fixture", items:[{kind:"text", text:"fixture"},{kind:"file",url:"https://fixture.invalid"}]});
    await queue.enqueue({conversationId: 1, messageId: 2, threadId:"fixture", items:[{kind:"text",text:"fixture"}]});
    await queue.waitForIdle();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(processed, ["1:text", "1:file", "2:text"]);
    assert.equal(feedback, 1);
    await queue.enqueue({conversationId: 1, messageId: 1, threadId:"fixture", items:[{kind:"text",text:"fixture"}]});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(feedback, 2);
    assert.equal(processed.length, 3, "duplicate feedback must not replay Zalo items");
    const feedbackQueue = new OutboundDeliveryQueue({filePath: path.join(root, "feedback.json"), logger});
    await feedbackQueue.load();
    const updates: string[] = [];
    createServer({
      chatwootClient: {markOutboundFailed: async (_conversation: number, _message: number, error: string) => {
        updates.push(error);
        if (updates.length === 1) throw new Error("synthetic unavailable");
      }} as any,
      zaloClient: {} as any, cache: {} as any, inboxId: 1, threadMap: new Map(), messageMap: new Map(),
      outboundQueue: feedbackQueue, runtimeStatus: new RuntimeStatus({accountId: 1, inboxId: 1}),
    });
    const isolated: number[] = [];
    feedbackQueue.setProcessor(async (job, item) => {
      isolated.push(job.messageId);
      if (item.kind === "file") throw new OutboundDeliveryError("attachment_failed", "failed");
      return {zaloMessageId: "fixture"};
    });
    feedbackQueue.start();
    await feedbackQueue.enqueue({conversationId:1,messageId:3,threadId:"fixture",items:[{kind:"text",text:"fixture"},{kind:"file",url:"https://fixture.invalid"}]});
    await feedbackQueue.enqueue({conversationId:1,messageId:4,threadId:"fixture",items:[{kind:"text",text:"fixture"}]});
    await feedbackQueue.waitForIdle();
    assert.deepEqual(isolated, [3, 3, 4], "feedback must not hold the sending queue");
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(updates.length, 2, "failed writeback is retried independently");
    assert.match(updates[1], /attachment/i);
    assert.match(updates[1], /some content/i);
    // A reset observed during an in-flight report must cause one subsequent report,
    // not allow the old generation to be acknowledged or run both reports at once.
    const concurrentPath = path.join(root, "concurrent-feedback.json");
    const concurrent = new OutboundDeliveryQueue({filePath:concurrentPath,logger});
    await concurrent.load();
    concurrent.setProcessor(async () => { throw new OutboundDeliveryError("attachment_head_status","failed"); });
    concurrent.start();
    await concurrent.enqueue({conversationId:3,messageId:50,threadId:"fixture",items:[{kind:"file",url:"https://fixture.invalid"}]});
    await concurrent.waitForIdle();
    let releaseFirst: (() => void) | undefined; let reportCount = 0; let activeReports = 0; let maxReports = 0;
    concurrent.setTerminalHandler(async () => {
      reportCount++; activeReports++; maxReports = Math.max(maxReports,activeReports);
      if (reportCount === 1) await new Promise<void>(resolve => {releaseFirst=resolve;});
      activeReports--;
    });
    while (!releaseFirst) await new Promise(resolve => setImmediate(resolve));
    await concurrent.reassertPendingRetry(3,50,0);
    assert.equal(concurrent.snapshot()[0].statusFeedback?.retryGeneration,1);
    assert.equal(reportCount,1);
    releaseFirst();
    await waitDurableAck(concurrent, 3, 50);
    assert.equal(reportCount,2); assert.equal(maxReports,1);
    assert.equal(JSON.parse(await fs.readFile(concurrentPath,"utf8")).jobs[0].statusFeedback.state,"acknowledged");
    // Simulate a crash after the terminal state was persisted but before any report was sent.
    const crashPath = path.join(root, "crash.json");
    const beforeCrash = new OutboundDeliveryQueue({filePath: crashPath, logger});
    await beforeCrash.load();
    beforeCrash.setProcessor(async () => { throw new OutboundDeliveryError("failed", "failed"); });
    beforeCrash.start();
    await beforeCrash.enqueue({conversationId: 2, messageId: 20, threadId: "fixture", items: [{kind: "file",url: "https://fixture.invalid"}]});
    await beforeCrash.waitForIdle();
    assert.equal(JSON.parse(await fs.readFile(crashPath, "utf8")).jobs[0].statusFeedback.state, "pending");
    const pendingCrashState = await fs.readFile(crashPath);
    for (const handlerBeforeLoad of [false, true]) {
      await fs.writeFile(crashPath, pendingCrashState, {mode: 0o600});
      const afterCrash = new OutboundDeliveryQueue({filePath: crashPath, logger});
      let afterCrashReports = 0;
      let afterCrashSends = 0;
      afterCrash.setProcessor(async () => { afterCrashSends++; return {zaloMessageId: "unexpected"}; });
      if (handlerBeforeLoad) afterCrash.setTerminalHandler(async () => { afterCrashReports++; });
      await afterCrash.load();
      if (!handlerBeforeLoad) afterCrash.setTerminalHandler(async () => { afterCrashReports++; });
      // Feedback recovery must work before Zalo is ready, without starting the sender.
      await waitDurableAck(afterCrash, 2, 20);
      assert.equal(afterCrashReports, 1);
      assert.equal(afterCrashSends, 0);
      assert.equal(JSON.parse(await fs.readFile(crashPath, "utf8")).jobs[0].statusFeedback.state, "acknowledged");
    }
    const afterAck = new OutboundDeliveryQueue({filePath: crashPath, logger});
    await afterAck.load();
    let afterAckReports = 0;
    afterAck.setTerminalHandler(async () => { afterAckReports++; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(afterAckReports, 0, "an acknowledged report must not be replayed on restart");
    // A new in-flight job becomes unknown on restart and reports without resending.
    const interruptedPath = path.join(root, "interrupted.json");
    const seed = new OutboundDeliveryQueue({filePath: interruptedPath, logger});
    await seed.load();
    await seed.enqueue({conversationId: 2, messageId: 21, threadId: "fixture", items: [{kind: "file",url: "https://fixture.invalid"}]});
    const interrupted = JSON.parse(await fs.readFile(interruptedPath, "utf8"));
    interrupted.jobs[0].state = "sending";
    interrupted.jobs[0].items[0].state = "sending";
    interrupted.jobs[0].items[0].attempts = 1;
    await fs.writeFile(interruptedPath, JSON.stringify(interrupted), {mode: 0o600});
    const resumed = new OutboundDeliveryQueue({filePath: interruptedPath, logger});
    await resumed.load();
    assert.equal(resumed.snapshot()[0].items[0].state, "unknown");
    assert.equal(resumed.snapshot()[0].statusFeedback?.state, "pending");
    let resumedSends = 0;
    let resumedReports = 0;
    resumed.setProcessor(async () => { resumedSends++; return {zaloMessageId: "unexpected"}; });
    resumed.setTerminalHandler(async () => { resumedReports++; });
    resumed.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(resumedSends, 0);
    assert.equal(resumedReports, 1);
    // Existing v1 records have no opt-in and must not produce historical feedback.
    const legacyPath = path.join(root, "legacy.json");
    const legacy = JSON.parse(await fs.readFile(crashPath, "utf8"));
    delete legacy.jobs[0].statusFeedback;
    await fs.writeFile(legacyPath, JSON.stringify(legacy), {mode: 0o600});
    const oldQueue = new OutboundDeliveryQueue({filePath: legacyPath, logger});
    await oldQueue.load();
    let legacyReports = 0;
    oldQueue.setTerminalHandler(async () => { legacyReports++; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(legacyReports, 0, "legacy terminal jobs must not be backfilled");
    // Exercise message_updated through the real callback handler and authoritative read.
    const retryPath = path.join(root, "native-retry.json");
    const retryQueue = new OutboundDeliveryQueue({filePath: retryPath, logger});
    await retryQueue.load();
    const reports: string[] = [];
    let remoteStatus = "failed";
    let deleted = false;
    let remotePrivate = false;
    let remoteInbox = 1;
    let readFails = false;
    const app = createServer({
      chatwootClient: {
        markOutboundFailed: async (_c: number, _m: number, detail: string) => { reports.push(detail); remoteStatus = "failed"; },
        getMessageForRetry: async (_c: number, m: number) => {
          if (readFails) throw new Error("fixture read failed");
          return {id:m,conversation_id:10,inbox_id:remoteInbox,message_type:1,private:remotePrivate,status:remoteStatus,content_attributes:{deleted}};
        },
      } as any,
      zaloClient: {} as any, cache: {} as any, inboxId: 1, threadMap: new Map(), messageMap: new Map(),
      outboundQueue: retryQueue, runtimeStatus: (() => { const st = new RuntimeStatus({accountId:1,inboxId:1}); st.markZaloConnected(); st.markListenerStarted(); return st; })(),
    });
    const processedRetry: string[] = [];
    let fileCalls = 0;
    retryQueue.setProcessor(async (job, item) => {
      processedRetry.push(`${job.messageId}:${item.kind}`);
      if (job.messageId === 30 && item.kind === "file" && fileCalls++ === 0) throw new OutboundDeliveryError("attachment_head_status", "failed");
      if (job.messageId === 31) throw new OutboundDeliveryError("ambiguous", "unknown");
      if (job.messageId === 32) throw new OutboundDeliveryError("attachment_head_status", "failed");
      return {zaloMessageId:"fixture"};
    });
    retryQueue.start();
    const http = app.listen(0);
    await new Promise<void>(resolve => http.once("listening", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("fixture server address");
    const callbackUrl = `http://127.0.0.1:${address.port}/callback`;
    const update = (id: number) => fetch(callbackUrl, {signal:AbortSignal.timeout(10_000),method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({event:"message_updated",id,conversation:{id:10,inbox_id:1}})});
    const waitAck = (id: number) => waitDurableAck(retryQueue, 10, id);
    try {
      await retryQueue.enqueue({conversationId:10,messageId:30,threadId:"fixture",items:[{kind:"text",text:"fixture"},{kind:"file",url:"https://fixture.invalid"}]});
      await retryQueue.waitForIdle(); await waitAck(30);
      await update(30); // status=failed: writeback webhook, never replay.
      assert.deepEqual(processedRetry, ["30:text", "30:file"]);
      remoteStatus = "sent"; readFails = true;
      assert.equal((await update(30)).status, 503);
      assert.equal(processedRetry.length, 2, "failed authoritative read must not send");
      readFails = false; deleted = true;
      await update(30); assert.equal(processedRetry.length, 2, "deleted message cannot retry");
      deleted = false; remotePrivate = true;
      await update(30); assert.equal(processedRetry.length, 2, "private message cannot retry");
      remotePrivate = false; remoteInbox = 2;
      await update(30); assert.equal(processedRetry.length, 2, "other inbox cannot retry");
      remoteInbox = 1;
      await Promise.all([update(30), update(30)]);
      await retryQueue.waitForIdle();
      assert.deepEqual(processedRetry, ["30:text", "30:file", "30:file"], "retry must preserve accepted text and deduplicate updates");
      await update(30);
      assert.equal(processedRetry.length, 3, "late update cannot resend completed job");
      const restored = new OutboundDeliveryQueue({filePath:retryPath,logger});
      await restored.load();
      let restoredSends = 0;
      restored.setProcessor(async () => {restoredSends++; return {zaloMessageId:"unexpected"};}); restored.start();
      await restored.waitForIdle(); assert.equal(restoredSends, 0);
      await retryQueue.enqueue({conversationId:10,messageId:31,threadId:"fixture",items:[{kind:"file",url:"https://fixture.invalid"}]});
      await retryQueue.waitForIdle(); await waitAck(31);
      const oldReports = reports.length;
      remoteStatus = "sent"; await update(31); await waitAck(31);
      assert.equal(processedRetry.filter(x => x === "31:file").length, 1, "unknown outcome must never replay");
      assert.equal(reports.length, oldReports + 1, "unknown retry reset must reassert failure");
      assert.match(reports.at(-1)!, /unknown/i);
      await retryQueue.enqueue({conversationId:10,messageId:32,threadId:"fixture",items:[{kind:"file",url:"https://fixture.invalid"}]});
      await retryQueue.waitForIdle(); await waitAck(32);
      retryQueue.pause(); remoteStatus = "sent";
      await update(32);
      assert.equal(retryQueue.snapshot().find(j => j.messageId === 32)?.items[0].retryPending, true);
      assert.equal(await retryQueue.applyNativeRetry(10, 32, 0), "ignored", "stale generation cannot trigger another retry");
      const interruptedRetry = new OutboundDeliveryQueue({filePath:retryPath,logger});
      await interruptedRetry.load();
      const interruptedItem = interruptedRetry.snapshot().find(j => j.messageId === 32)?.items[0];
      assert.equal(interruptedItem?.state, "unknown", "a retry interrupted before sending must not replay after restart");
      let interruptedRetrySends = 0;
      interruptedRetry.setProcessor(async () => { interruptedRetrySends++; return {zaloMessageId:"unexpected"}; });
      interruptedRetry.start(); await interruptedRetry.waitForIdle();
      assert.equal(interruptedRetrySends, 0);
    } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
    // A failed local acknowledgement must stay pending; UI Retry reasserts it without sending.
    const ackFailPath = path.join(root, "ack-failure.json");
    let storageErrors = 0; let ackFailureReports = 0; let ackFailureSends = 0;
    const ackFailureQueue = new OutboundDeliveryQueue({filePath:ackFailPath,logger,onStorageError:() => {storageErrors++;}});
    await ackFailureQueue.load();
    let ackRemoteStatus = "failed";
    let reads = 0;
    let releaseAckFailure: (() => void) | undefined;
    let signalAckWrite!: () => void;
    const ackWriteStarted = new Promise<void>(resolve => { signalAckWrite = resolve; });
    const originalRename = fs.rename;
    const ackApp = createServer({
      chatwootClient: {
        markOutboundFailed: async () => {
          ackFailureReports++; ackRemoteStatus = "failed";
          if (ackFailureReports === 1) (fs as any).rename = async () => {
            signalAckWrite();
            await new Promise<void>(resolve => { releaseAckFailure = resolve; });
            throw new Error("fixture storage failure");
          };
        },
        getMessageForRetry: async (_c:number,m:number) => { reads++; return {id:m,conversation_id:11,inbox_id:1,message_type:1,private:false,status:ackRemoteStatus,content_attributes:{}}; },
      } as any,
      zaloClient:{} as any, cache:{} as any, inboxId:1,threadMap:new Map(),messageMap:new Map(),outboundQueue:ackFailureQueue,
      runtimeStatus:(() => { const st = new RuntimeStatus({accountId:1,inboxId:1}); st.markZaloConnected(); st.markListenerStarted(); return st; })(),
    });
    ackFailureQueue.setProcessor(async () => { ackFailureSends++; throw new OutboundDeliveryError("attachment_head_status","failed"); });
    ackFailureQueue.start();
    const ackHttp = ackApp.listen(0); await new Promise<void>(resolve => ackHttp.once("listening",resolve));
    const ackAddress = ackHttp.address(); if (!ackAddress || typeof ackAddress === "string") throw new Error("fixture server address");
    try {
      await ackFailureQueue.enqueue({conversationId:11,messageId:40,threadId:"fixture",items:[{kind:"file",url:"https://fixture.invalid"}]});
      await ackFailureQueue.waitForIdle();
      await ackWriteStarted;
      let signalEntered!: () => void;
      const callbackEntered = new Promise<void>(resolve => { signalEntered = resolve; });
      const originalRetryState = ackFailureQueue.retryState.bind(ackFailureQueue);
      ackFailureQueue.retryState = (...args) => { signalEntered(); return originalRetryState(...args); };
      ackRemoteStatus = "sent";
      const ackCallbackUrl = `http://127.0.0.1:${ackAddress.port}/callback`;
      const resetPromise = fetch(ackCallbackUrl,{signal:AbortSignal.timeout(10_000),method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({event:"message_updated",id:40,conversation:{id:11,inbox_id:1}})});
      await callbackEntered;
      assert.equal(reads,0, "native retry must not observe acknowledgement before persistence resolves");
      (fs as any).rename = originalRename;
      releaseAckFailure!();
      const reset = await resetPromise;
      assert.equal(reset.status,200);
      assert.equal(storageErrors,1);
      await waitDurableAck(ackFailureQueue, 11, 40);
      assert.equal(ackFailureReports,2); assert.equal(ackFailureSends,1);
      assert.equal(JSON.parse(await fs.readFile(ackFailPath,"utf8")).jobs[0].statusFeedback.state,"acknowledged");
      const ackRestart = new OutboundDeliveryQueue({filePath:ackFailPath,logger}); await ackRestart.load();
      let repeated = 0; ackRestart.setTerminalHandler(async () => {repeated++;});
      await new Promise(resolve => setImmediate(resolve)); assert.equal(repeated,0);
    } finally {
      releaseAckFailure?.();
      (fs as any).rename = originalRename;
      await new Promise<void>(resolve => ackHttp.close(() => resolve()));
    }
    const recovered = new OutboundDeliveryQueue({filePath, logger});
    await recovered.load();
    let recoveredFeedback = 0;
    recovered.setTerminalHandler(async () => { recoveredFeedback++; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recoveredFeedback, 1, "partial jobs must be reported after restart");
  } finally { await fs.rm(root, {recursive:true, force:true}); }
  console.log("[test:chatwoot-status] ok");
}
main().catch(error => {console.error(error); process.exitCode = 1;});
