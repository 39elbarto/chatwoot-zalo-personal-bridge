import assert from "assert";
import {
  ListenerRecoveryTimer,
  ListenerRecoveryWatchdog,
  resolveListenerRecoveryTimeout,
  sanitizeDisconnectReason,
} from "../src/listenerRecovery";

type ScheduledTimer = {
  callback: () => void;
  timeoutMs: number;
  cleared: boolean;
};

function createFakeTimer() {
  const scheduled: ScheduledTimer[] = [];
  const timer: ListenerRecoveryTimer = {
    setTimeout(callback, timeoutMs) {
      const entry = { callback, timeoutMs, cleared: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimeout(handle) {
      (handle as ScheduledTimer).cleared = true;
    },
  };
  return { timer, scheduled };
}

function runActiveTimers(scheduled: ScheduledTimer[]) {
  for (const entry of scheduled) {
    if (!entry.cleared) entry.callback();
  }
}

function main() {
  assert.strictEqual(resolveListenerRecoveryTimeout(undefined), 90_000);
  assert.strictEqual(resolveListenerRecoveryTimeout(" 120000 "), 120_000);
  for (const invalid of ["0", "9999", "900001", "12.5", "invalid", "Infinity"]) {
    assert.throws(() => resolveListenerRecoveryTimeout(invalid), invalid);
  }

  assert.strictEqual(sanitizeDisconnectReason(Buffer.from(" server\nrestart\u0000 ")), "server restart");
  assert.strictEqual(sanitizeDisconnectReason(new Uint8Array(Buffer.from("rotate"))), "rotate");
  assert.strictEqual(sanitizeDisconnectReason({ reason: "must not serialize" }), null);
  assert.strictEqual(
    sanitizeDisconnectReason("retry https://chat.zalo.me/socket?key=private"),
    "retry [redacted-url]",
  );
  assert.strictEqual(sanitizeDisconnectReason("x".repeat(200))?.length, 160);

  {
    const { timer, scheduled } = createFakeTimer();
    const terminal: unknown[] = [];
    const watchdog = new ListenerRecoveryWatchdog({
      timeoutMs: 90_000,
      timer,
      onTimeout: (details) => terminal.push(details),
    });
    watchdog.unavailable("disconnected", 5008, "temporary");
    assert.strictEqual(scheduled.length, 1);
    assert.strictEqual(scheduled[0].timeoutMs, 90_000);
    watchdog.connected();
    assert.strictEqual(scheduled[0].cleared, true);
    runActiveTimers(scheduled);
    assert.deepStrictEqual(terminal, []);
  }

  {
    const { timer, scheduled } = createFakeTimer();
    const terminal: unknown[] = [];
    const watchdog = new ListenerRecoveryWatchdog({
      timeoutMs: 90_000,
      timer,
      onTimeout: (details) => terminal.push(details),
    });
    watchdog.unavailable("disconnected", 4999, "first");
    watchdog.unavailable("disconnected", 5008, "second");
    watchdog.unavailable("error", undefined, new Error("must not log"));
    assert.strictEqual(scheduled.length, 1);
    runActiveTimers(scheduled);
    runActiveTimers(scheduled);
    assert.deepStrictEqual(terminal, [{ trigger: "disconnected", code: 4999, reason: "first" }]);
    watchdog.connected();
    watchdog.unavailable("error");
    assert.strictEqual(scheduled.length, 1);
  }

  {
    const { timer, scheduled } = createFakeTimer();
    const terminal: unknown[] = [];
    const watchdog = new ListenerRecoveryWatchdog({
      timeoutMs: 90_000,
      timer,
      onTimeout: (details) => terminal.push(details),
    });
    watchdog.connected();
    watchdog.connected();
    watchdog.unavailable("error", "not-a-number", { sensitiveValue: "do not serialize" });
    watchdog.unavailable("disconnected", 4001, "closed after error");
    assert.strictEqual(scheduled.length, 1);
    runActiveTimers(scheduled);
    assert.deepStrictEqual(terminal, [{ trigger: "disconnected", code: 4001, reason: "closed after error" }]);
  }

  console.log("[test:listener-recovery] ok");
}

main();
