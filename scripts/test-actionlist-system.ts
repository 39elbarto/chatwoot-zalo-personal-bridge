import { normalizeActionlistSystemMessage } from "../src/zaloSystemMessages";

const sample = `{
  "title": "Bạn vừa kết bạn với Aiptt",
  "description": "",
  "href": "",
  "thumb": "",
  "childnumber": 0,
  "action": "msginfo.actionlist",
  "params": "{\\"msg\\":{\\"vi\\":\\"%1$s đã đồng ý kết bạn\\",\\"en\\":\\"%1$s is now your friend\\",\\"my\\":\\"%1$s is now your friend\\"},\\"avatarUrl\\":[\\"https://s160-ava-talk.zadn.vn/c/4/0/e/18/160/55936591feb7894934c2ae34c42b3112.jpg\\"],\\"simpleInfos\\":[{\\"uid\\":6602930749030378524,\\"dpn\\":\\"Aiptt\\",\\"avt\\":\\"https://s160-ava-talk.zadn.vn/c/4/0/e/18/160/55936591feb7894934c2ae34c42b3112.jpg\\"}],\\"highLightsV2\\":[{\\"uid\\":6602930749030378524,\\"dpn\\":\\"Aiptt\\",\\"ignoreNickname\\":0,\\"type\\":0,\\"ts\\":0}],\\"totalUpdateMem\\":0}",
  "type": ""
}`;

const threadId = process.argv[2] || "TEST_THREAD_ID";
const msgId = process.argv[3] || "TEST_MSG_ID";

console.log("[test-actionlist-system] input", { threadId, msgId });
const normalized = normalizeActionlistSystemMessage(sample);
if (!normalized) {
  console.error("[test-actionlist-system] normalize returned null");
  process.exit(1);
}

console.log("[test-actionlist-system] normalized", {
  content: normalized.content,
  isPrivate: normalized.isPrivate,
  friendName: normalized.friendName,
  langUsed: normalized.langUsed,
});

console.log("[test-actionlist-system] expected Chatwoot note payload", {
  conversationId: "<resolved in runtime>",
  content: normalized.content,
  private: true,
  source: "zalo_system_actionlist",
});
