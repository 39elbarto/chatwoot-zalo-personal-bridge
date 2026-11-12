import assert from "node:assert/strict";
import { safeZaloError } from "../src/safeZaloError";
import { ZaloApiError } from "@warriorteam/zalo-personal";
assert.deepEqual(safeZaloError(new ZaloApiError("PRIVATE", 600)), {error_type: "ZcaApiError", provider_code: 600});
assert.deepEqual(safeZaloError({name: "Error", error_code: "123", message: "PRIVATE", request: {token: "SECRET"}}), {error_type: "Error", provider_code: 123});
for (const error of [null, "PRIVATE", {name: "PRIVATE", code: "SECRET"}, {code: Infinity}, {code: Number.MAX_SAFE_INTEGER + 1}]) {
  assert.deepEqual(safeZaloError(error), {error_type: "unclassified", provider_code: null});
}
console.log("[test:send-diagnostics] ok");
