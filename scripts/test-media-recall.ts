import assert from "assert";
import { detectMediaContentType, resolveMediaMetadata } from "../src/mediaMetadata";
import { MappingAwareMap, RecallCoordinator, type RecallMapping } from "../src/recallCoordinator";
import { normalizeGifPayload, normalizeSharedFilePayload, normalizeUndoPayload } from "../src/zaloClient";

const silentLogger = { log: () => undefined, warn: () => undefined };

async function main() {
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n");
  assert.strictEqual(detectMediaContentType(pdf), "application/pdf");
  assert.strictEqual(detectMediaContentType(Buffer.from("GIF89a", "ascii")), "image/gif");

  assert.deepStrictEqual(
    resolveMediaMetadata({
      fileName: "Downloading",
      mediaUrl: "https://files.example.test/object/abc123",
      contentTypeHint: "application/octet-stream",
      responseContentType: "application/octet-stream",
      buffer: pdf,
    }),
    { fileName: "Downloading.pdf", contentType: "application/pdf" },
  );

  assert.deepStrictEqual(
    resolveMediaMetadata({
      fileName: "report.pdf",
      mediaUrl: "https://files.example.test/object/abc123",
      contentTypeHint: "application/octet-stream",
      responseContentType: "application/octet-stream",
      buffer: pdf,
    }),
    { fileName: "report.pdf", contentType: "application/pdf" },
  );

  assert.deepStrictEqual(
    resolveMediaMetadata({
      fileName: "file.bin",
      buffer: pdf,
    }),
    { fileName: "file.pdf", contentType: "application/pdf" },
  );

  assert.deepStrictEqual(
    resolveMediaMetadata({ fileName: "payload", buffer: Buffer.from("unknown") }),
    { fileName: "payload.bin", contentType: "application/octet-stream" },
  );

  const gif = normalizeGifPayload(
    {
      href: "https://cdn.example.test/animation.gif",
      thumb: "https://cdn.example.test/preview.png",
      params: JSON.stringify({ small: "https:\\/\\/cdn.example.test\\/small.gif", width: 498, height: 498 }),
    },
    "1000000000001",
  );
  assert.deepStrictEqual(gif, {
    mediaUrl: "https://cdn.example.test/animation.gif",
    fileName: "zalo-gif-1000000000001.gif",
    text: undefined,
  });

  assert.deepStrictEqual(
    normalizeSharedFilePayload(
      {
        title: "Downloading",
        href: "https://files.example.test/object/abc123",
        params: JSON.stringify({ fileExt: "", fType: 1 }),
      },
      "1000000000002",
    ),
    {
      mediaUrl: "https://files.example.test/object/abc123",
      fileName: "Downloading",
      text: "Downloading",
    },
  );

  assert.deepStrictEqual(
    normalizeSharedFilePayload({ title: "report", href: "https://files.example.test/x", params: { fileExt: ".pdf" } }, "3"),
    { mediaUrl: "https://files.example.test/x", fileName: "report.pdf", text: "report" },
  );

  const undo = normalizeUndoPayload({
    threadId: "2000000000001",
    isSelf: false,
    data: {
      msgId: "1000000000010",
      uidFrom: "3000000000001",
      content: { globalMsgId: 1000000000001, cliMsgId: 4000000000001, deleteMsg: 1 },
    },
  } as any);
  assert.strictEqual(undo?.type, "undo");
  assert.strictEqual(undo?.targetMsgId, "1000000000001");

  const mappings = new Map<string, RecallMapping>();
  const deleted: Array<[number, number]> = [];
  let coordinator: RecallCoordinator;
  const awareMap = new MappingAwareMap<RecallMapping>((key) => void coordinator.mappingAvailable(key));
  coordinator = new RecallCoordinator({
    lookup: (id) => awareMap.get(id) || mappings.get(id),
    deleteMessage: async (conversationId, cwId) => {
      deleted.push([conversationId, cwId]);
    },
    onDeleted: (id) => {
      awareMap.delete(id);
      mappings.delete(id);
    },
    logger: silentLogger,
  });

  assert.strictEqual(
    await coordinator.recall({ targetMsgId: "1000000000001", threadId: "2000000000001" }),
    "pending",
  );
  awareMap.set("1000000000001", { conversationId: 1, cwId: 101 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(deleted, [[1, 101]]);
  assert.strictEqual(
    await coordinator.recall({ targetMsgId: "1000000000001", threadId: "2000000000001" }),
    "duplicate",
  );

  mappings.set("1000000000002", { conversationId: 1, cwId: 102 });
  assert.strictEqual(
    await coordinator.recall({ targetMsgId: "1000000000002", threadId: "2000000000001" }),
    "deleted",
  );
  assert.deepStrictEqual(deleted, [[1, 101], [1, 102]]);

  mappings.set("invalid", { conversationId: 0, cwId: 0 });
  assert.strictEqual(await coordinator.recall({ targetMsgId: "invalid", threadId: "2000000000001" }), "invalid");

  console.log("[test:media-recall] ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
