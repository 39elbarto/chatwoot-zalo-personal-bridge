import { createHash } from "crypto";

export function contentKey(threadId: string, content: string) {
  const hash = createHash("sha256").update(content).digest("hex");
  return `${threadId}:${hash}`;
}
