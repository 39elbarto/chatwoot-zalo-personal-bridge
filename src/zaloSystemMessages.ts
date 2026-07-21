export function normalizeActionlistSystemMessage(
  rawText: string,
): { content: string; isPrivate: boolean; friendName?: string; langUsed?: "en" | "vi"; finalText?: string } | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  let outer: any;
  try {
    outer = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!outer || outer.action !== "msginfo.actionlist") {
    return null;
  }

  const title: string | undefined = typeof outer?.title === "string" ? outer.title : undefined;
  const safeDebugBase = {
    action: "msginfo.actionlist",
    hasTitle: !!title,
    titlePreview: title ? title.slice(0, 60) : undefined,
  };

  let inner: any;
  if (typeof outer.params !== "string") {
    console.log("[zalo-system-actionlist-error]", {
      reason: "invalid-structure",
      debug: { ...safeDebugBase, innerKeys: [] },
    });
    const fallback = title?.trim() ? `🤝 [Zalo system] ${title.trim()}` : "🤝 [Zalo system] actionlist (unparsed)";
    return { content: fallback, isPrivate: true, finalText: fallback.replace(/^🤝 \\[Zalo system\\] /, "") };
  }

  try {
    inner = JSON.parse(outer.params);
  } catch {
    console.log("[zalo-system-actionlist-error]", {
      reason: "params-parse-failed",
      debug: { ...safeDebugBase, innerKeys: [] },
    });
    const fallback = title?.trim() ? `🤝 [Zalo system] ${title.trim()}` : "🤝 [Zalo system] actionlist (unparsed)";
    return { content: fallback, isPrivate: true, finalText: fallback.replace(/^🤝 \\[Zalo system\\] /, "") };
  }

  const friendName: string | undefined =
    typeof inner?.simpleInfos?.[0]?.dpn === "string" ? inner.simpleInfos[0].dpn : undefined;

  const templateEn: string | undefined = typeof inner?.msg?.en === "string" ? inner.msg.en : undefined;
  const templateVi: string | undefined = typeof inner?.msg?.vi === "string" ? inner.msg.vi : undefined;

  const langUsed: "en" | "vi" | undefined = templateEn ? "en" : templateVi ? "vi" : undefined;
  const template = templateEn || templateVi;

  const buildFromTemplate = () => {
    if (!template || !friendName) return null;
    // Zalo uses printf-like placeholder: %1$s
    const replaced = template.split("%1$s").join(friendName).split("%s").join(friendName);
    return replaced.trim();
  };

  const finalText = buildFromTemplate() || (title ? title.trim() : null);
  if (!finalText) {
    console.log("[zalo-system-actionlist-error]", {
      reason: "invalid-structure",
      debug: {
        ...safeDebugBase,
        innerKeys: inner && typeof inner === "object" ? Object.keys(inner).slice(0, 20) : [],
      },
    });
    const fallback = title?.trim() ? `🤝 [Zalo system] ${title.trim()}` : "🤝 [Zalo system] actionlist (unparsed)";
    return { content: fallback, isPrivate: true, finalText: fallback.replace(/^🤝 \\[Zalo system\\] /, "") };
  }

  return {
    content: `🤝 [Zalo system] ${finalText}`,
    isPrivate: true,
    friendName,
    langUsed,
    finalText,
  };
}

export function normalizeShowProfileSystemMessage(
  rawText: string,
): { content: string; isPrivate: boolean; friendName?: string; finalText?: string } | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  let outer: any;
  try {
    outer = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!outer || outer.action !== "show.profile") return null;

  const title: string | undefined = typeof outer?.title === "string" ? outer.title : undefined;
  const description: string | undefined = typeof outer?.description === "string" ? outer.description : undefined;

  let inner: any = null;
  if (typeof outer?.params === "string") {
    try {
      inner = JSON.parse(outer.params);
    } catch {
      inner = null;
    }
  } else if (outer?.params && typeof outer.params === "object") {
    inner = outer.params;
  }

  const notifyTxt: string | undefined = typeof inner?.notifyTxt === "string" ? inner.notifyTxt : undefined;
  const previewTxt: string | undefined = typeof inner?.previewTxt === "string" ? inner.previewTxt : undefined;

  // Attempt to extract name from "Say hello to <name>"
  let friendName: string | undefined;
  if (previewTxt) {
    const m = previewTxt.match(/to\s+(.+)$/i);
    if (m) friendName = m[1].trim();
  }

  const parts = [description, notifyTxt, previewTxt, title].filter((v) => v && v.trim().length > 0) as string[];
  const finalText = parts.length ? parts[0].trim() : "New friend notification";

  const content = friendName
    ? `🤝 [Zalo system] ${finalText.replace(/to\\s+.+$/i, `to ${friendName}`)}`
    : `🤝 [Zalo system] ${finalText}`;

  if (!finalText) {
    return {
      content: "🤝 [Zalo system] friend notification",
      isPrivate: true,
    };
  }

  return {
    content,
    isPrivate: true,
    friendName,
    finalText,
  };
}

export function normalizeCalltimeSystemMessage(
  rawText: string,
): {
  content: string;
  isPrivate: boolean;
  finalText?: string;
  durationSec?: number;
  isCaller?: boolean;
  callType?: string;
} | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  let outer: any;
  try {
    outer = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!outer || outer.action !== "recommened.calltime") {
    return null;
  }

  const title: string | undefined = typeof outer?.title === "string" ? outer.title : undefined;
  const description: string | undefined = typeof outer?.description === "string" ? outer.description : undefined;
  const safeDebugBase = {
    action: "recommened.calltime",
    hasTitle: !!title,
    hasDescription: !!description,
    titlePreview: title ? title.slice(0, 40) : undefined,
    descriptionPreview: description ? description.slice(0, 40) : undefined,
  };

  let inner: any = null;
  if (typeof outer?.params === "string") {
    try {
      inner = JSON.parse(outer.params);
    } catch {
      inner = null;
    }
  } else if (outer?.params && typeof outer.params === "object") {
    inner = outer.params;
  }

  const duration = typeof inner?.duration === "number" ? inner.duration : typeof inner?.duration === "string" ? Number(inner.duration) : null;
  const durationSec = duration && !Number.isNaN(duration) ? Math.max(0, Math.round(duration)) : null;
  const isCallerRaw = inner?.isCaller;
  const isCaller =
    typeof isCallerRaw === "number"
      ? isCallerRaw === 1
      : typeof isCallerRaw === "boolean"
        ? isCallerRaw
        : undefined;
  const calltypeRaw = inner?.calltype;
  const callType =
    typeof calltypeRaw === "number"
      ? calltypeRaw === 1
        ? "video"
        : "audio"
      : typeof calltypeRaw === "string" && calltypeRaw.trim()
        ? calltypeRaw.trim()
        : undefined;

  const fmt = (sec: number) => {
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const baseLabel = callType === "video" ? "Video call" : "Call";
  const direction = isCaller === true ? "Outgoing" : isCaller === false ? "Incoming" : "Call";
  const timePart = durationSec !== null ? ` (${fmt(durationSec)})` : "";
  const finalText = `${direction} ${baseLabel}${timePart}`.trim();

  if (!finalText || !finalText.replace(/\s+/g, "").length) {
    console.log("[zalo-system-calltime-error]", {
      reason: "invalid-structure",
      debug: { ...safeDebugBase, innerKeys: inner && typeof inner === "object" ? Object.keys(inner).slice(0, 20) : [] },
    });
    const fallbackBase = description?.trim() || title?.trim() || "Call";
    const fallback = `📞 [Zalo system] ${fallbackBase}`;
    return { content: fallback, isPrivate: true, finalText: fallback.replace(/^📞 \\[Zalo system\\] /, "") };
  }

  return {
    content: `📞 [Zalo system] ${finalText}`,
    isPrivate: true,
    finalText,
    durationSec: durationSec ?? undefined,
    isCaller,
    callType,
  };
}

export function normalizeMisscallSystemMessage(
  rawText: string,
): {
  content: string;
  isPrivate: boolean;
  finalText?: string;
  reason?: number;
  isCaller?: boolean;
  callType?: string;
} | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  let outer: any;
  try {
    outer = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!outer || outer.action !== "recommened.misscall") {
    return null;
  }

  const title: string | undefined = typeof outer?.title === "string" ? outer.title : undefined;
  const description: string | undefined = typeof outer?.description === "string" ? outer.description : undefined;
  const safeDebugBase = {
    action: "recommened.misscall",
    hasTitle: !!title,
    hasDescription: !!description,
    titlePreview: title ? title.slice(0, 40) : undefined,
    descriptionPreview: description ? description.slice(0, 40) : undefined,
  };

  let inner: any = null;
  if (typeof outer?.params === "string") {
    try {
      inner = JSON.parse(outer.params);
    } catch {
      inner = null;
    }
  } else if (outer?.params && typeof outer.params === "object") {
    inner = outer.params;
  }

  const reason =
    typeof inner?.reason === "number"
      ? inner.reason
      : typeof inner?.reason === "string" && inner.reason.trim()
        ? Number(inner.reason)
        : null;
  const isCallerRaw = inner?.isCaller;
  const isCaller =
    typeof isCallerRaw === "number"
      ? isCallerRaw === 1
      : typeof isCallerRaw === "boolean"
        ? isCallerRaw
        : undefined;
  const calltypeRaw = inner?.calltype;
  const callType =
    typeof calltypeRaw === "number"
      ? calltypeRaw === 1
        ? "video"
        : "audio"
      : typeof calltypeRaw === "string" && calltypeRaw.trim()
        ? calltypeRaw.trim()
        : undefined;

  const baseLabel = callType === "video" ? "Video call" : "Call";
  const direction = isCaller === true ? "Outgoing" : isCaller === false ? "Incoming" : "Call";
  const missed = "Missed";
  const finalText = `${missed} ${direction} ${baseLabel}`.trim().replace(/\s+/g, " ");

  if (!finalText || !finalText.replace(/\s+/g, "").length) {
    console.log("[zalo-system-misscall-error]", {
      reason: "invalid-structure",
      debug: { ...safeDebugBase, innerKeys: inner && typeof inner === "object" ? Object.keys(inner).slice(0, 20) : [] },
    });
    const fallbackBase = description?.trim() || title?.trim() || "Missed call";
    const fallback = `📞 [Zalo system] ${fallbackBase}`;
    return { content: fallback, isPrivate: true, finalText: fallback.replace(/^📞 \\[Zalo system\\] /, "") };
  }

  return {
    content: `📞 [Zalo system] ${finalText}`,
    isPrivate: true,
    finalText,
    reason: reason ?? undefined,
    isCaller,
    callType,
  };
}

export function normalizeRecommendedUserMessage(
  rawText: string,
): { content: string; title?: string; phone?: string; qrCodeUrl?: string; href?: string } | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  let outer: any;
  try {
    outer = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!outer || outer.action !== "recommened.user") {
    return null;
  }

  const title: string | undefined = typeof outer?.title === "string" ? outer.title.trim() : undefined;
  const href: string | undefined = typeof outer?.href === "string" ? outer.href.trim() : undefined;
  const description: string | undefined = typeof outer?.description === "string" ? outer.description : undefined;

  let inner: any = null;
  if (typeof description === "string" && description.trim().startsWith("{")) {
    try {
      inner = JSON.parse(description);
    } catch {
      inner = null;
    }
  }

  const phone: string | undefined = typeof inner?.phone === "string" ? inner.phone.trim() : undefined;
  const qrCodeUrl: string | undefined = typeof inner?.qrCodeUrl === "string" ? inner.qrCodeUrl.trim() : undefined;

  const label = title && title.length ? title : "Contact";
  const parts: string[] = [`📇 [Zalo contact card] ${label}`];
  if (phone) parts.push(`Phone: ${phone}`);
  if (href && href.length && href !== "https://zalo.me") parts.push(href);

  const content = parts.join("\n");
  if (!content || !content.trim()) {
    console.log("[zalo-recommened-user-error]", {
      reason: "invalid-structure",
      debug: {
        action: "recommened.user",
        hasTitle: !!title,
        hasDescription: !!description,
        hasPhone: !!phone,
        hasQr: !!qrCodeUrl,
        titlePreview: title ? title.slice(0, 60) : undefined,
      },
    });
    return { content: "📇 [Zalo contact card] (unparsed)" };
  }

  if (!phone && !qrCodeUrl) {
    console.log("[zalo-recommened-user-unparsed]", {
      action: "recommened.user",
      hasTitle: !!title,
      hasDescription: !!description,
      titlePreview: title ? title.slice(0, 60) : undefined,
    });
  }

  return {
    content,
    title,
    phone,
    qrCodeUrl,
    href,
  };
}

export type RecommendedLinkMessage = {
  content: string;
  preview: string;
  title: string;
  description?: string;
  href?: string;
};

const normalizeHumanText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (/^(?:\{|\[).*(?:\}|\])$/s.test(normalized)) return undefined;
  if (/(?:\/storage\/emulated|content:\/\/|file:\/\/)/i.test(normalized)) return undefined;
  return normalized;
};

const normalizeHttpUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\\\//g, "/");
  if (!normalized || /\s/.test(normalized)) return undefined;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
};

const urlFromTitle = (title: string | undefined): string | undefined => {
  if (!title) return undefined;
  const match = title.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  if (!match) return undefined;
  return normalizeHttpUrl(match.replace(/[),.;!?]+$/, ""));
};

const withoutUrl = (value: string | undefined, url: string | undefined): string | undefined => {
  if (!value || !url) return value;
  const candidate = value.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  if (!candidate) return value;
  const candidateUrl = normalizeHttpUrl(candidate.replace(/[),.;!?]+$/, ""));
  if (!candidateUrl || candidateUrl.toLowerCase() !== url.toLowerCase()) return value;
  return normalizeHumanText(value.replace(candidate, "").replace(/\s+([,.;:!?])/g, "$1").replace(/[-–—,:;]+$/, ""));
};

export function normalizeRecommendedLinkMessage(rawText: string): RecommendedLinkMessage | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  let outer: any;
  try {
    outer = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!outer || outer.action !== "recommened.link") return null;

  let params: any = null;
  if (typeof outer.params === "string") {
    try {
      const parsed = JSON.parse(outer.params);
      params = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      params = null;
    }
  } else if (outer.params && typeof outer.params === "object") {
    params = outer.params;
  }

  const outerTitle = normalizeHumanText(outer.title);
  const extractedTitleUrl = urlFromTitle(outerTitle);
  const href = normalizeHttpUrl(outer.href) || normalizeHttpUrl(params?.href) || extractedTitleUrl;
  const authoredTitle = withoutUrl(outerTitle, extractedTitleUrl);
  const mediaTitle = normalizeHumanText(params?.mediaTitle);
  const title = authoredTitle || mediaTitle || "Shared link";

  const rawDescription = normalizeHumanText(outer.description);
  const descriptionWithoutUrl = withoutUrl(rawDescription, href);
  const description =
    descriptionWithoutUrl && descriptionWithoutUrl.toLowerCase() !== title.toLowerCase()
      ? descriptionWithoutUrl
      : undefined;

  const parts = [`🔗 ${title}`];
  if (description) parts.push(description);
  if (href) parts.push(href);

  return {
    content: parts.join("\n\n"),
    preview: href ? `${title} — ${href}` : title,
    title,
    description,
    href,
  };
}

export function buildRecommendedLinkMapping(
  normalized: RecommendedLinkMessage,
  isSelf: boolean,
  quote?: Record<string, unknown>,
): { preview: string; sender: "self" | "contact"; quote?: Record<string, unknown> } {
  return {
    preview: normalized.preview,
    sender: isSelf ? "self" : "contact",
    quote,
  };
}
