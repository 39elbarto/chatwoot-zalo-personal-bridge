export type AccountIdentityState =
  | "not_configured"
  | "match"
  | "mismatch"
  | "unknown_with_expectation";

export type RuntimeErrorCategory =
  | "configuration_invalid"
  | "storage_initialization_failed"
  | "outbound_queue_failed"
  | "authentication_failed"
  | "identity_unknown"
  | "identity_mismatch"
  | "listener_start_failed"
  | "listener_disconnected"
  | "listener_error"
  | "event_handler_failed"
  | "chatwoot_write_failed"
  | "conversation_lookup_failed"
  | "callback_processing_failed"
  | "attachment_fetch_failed"
  | "zalo_text_send_failed"
  | "zalo_image_send_failed"
  | "zalo_file_send_failed"
  | "zalo_fallback_send_failed";

export type RuntimeStatusSnapshot = {
  process_started_at: string;
  zalo_connected: boolean;
  listener_started: boolean;
  account_state: AccountIdentityState;
  chatwoot_mapping: {
    account_id: number;
    inbox_id: number;
  };
  last_event_at: string | null;
  last_inbound_chatwoot_write_at: string | null;
  last_outbound_zalo_send_at: string | null;
  last_error_category: RuntimeErrorCategory | null;
};

export type RuntimeHealth = RuntimeStatusSnapshot & {
  ok: boolean;
  readiness: "ready" | "not_ready";
  account_match: boolean | null;
};

export type RuntimeClock = () => Date;

export function resolveAccountIdentityState(
  expectedUid: string | null | undefined,
  actualUid: string | null | undefined,
): AccountIdentityState {
  const expected = expectedUid?.trim() || "";
  if (!expected) return "not_configured";
  const actual = actualUid?.trim() || "";
  if (!actual) return "unknown_with_expectation";
  return actual === expected ? "match" : "mismatch";
}

export function isRuntimeReady(
  state: Pick<RuntimeStatusSnapshot, "zalo_connected" | "listener_started" | "account_state">,
): boolean {
  const accountAllowed = state.account_state === "not_configured" || state.account_state === "match";
  return state.zalo_connected && state.listener_started && accountAllowed;
}

export function serializeRuntimeHealth(state: RuntimeStatusSnapshot): RuntimeHealth {
  const ok = isRuntimeReady(state);
  let accountMatch: boolean | null = false;
  if (state.account_state === "not_configured") accountMatch = null;
  else if (state.account_state === "match") accountMatch = true;
  return {
    ok,
    readiness: ok ? "ready" : "not_ready",
    ...state,
    account_match: accountMatch,
  };
}

export class RuntimeStatus {
  private readonly state: RuntimeStatusSnapshot;

  constructor(
    mapping: { accountId: number; inboxId: number },
    private readonly clock: RuntimeClock = () => new Date(),
  ) {
    this.state = {
      process_started_at: this.now(),
      zalo_connected: false,
      listener_started: false,
      account_state: "not_configured",
      chatwoot_mapping: {
        account_id: mapping.accountId,
        inbox_id: mapping.inboxId,
      },
      last_event_at: null,
      last_inbound_chatwoot_write_at: null,
      last_outbound_zalo_send_at: null,
      last_error_category: null,
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  snapshot(): RuntimeStatusSnapshot {
    return {
      ...this.state,
      chatwoot_mapping: { ...this.state.chatwoot_mapping },
    };
  }

  health(): RuntimeHealth {
    return serializeRuntimeHealth(this.snapshot());
  }

  isReady(): boolean {
    return isRuntimeReady(this.state);
  }

  markZaloConnected(): void {
    this.state.zalo_connected = true;
  }

  markZaloDisconnected(): void {
    this.state.zalo_connected = false;
  }

  markListenerStarted(): void {
    this.state.listener_started = true;
  }

  markListenerStopped(): void {
    this.state.listener_started = false;
  }

  setAccountState(state: AccountIdentityState): void {
    this.state.account_state = state;
  }

  markEventReceived(): void {
    this.state.last_event_at = this.now();
  }

  markInboundChatwootWrite(): void {
    this.state.last_inbound_chatwoot_write_at = this.now();
  }

  markOutboundZaloSend(): void {
    this.state.last_outbound_zalo_send_at = this.now();
  }

  setError(category: RuntimeErrorCategory): void {
    this.state.last_error_category = category;
  }
}
