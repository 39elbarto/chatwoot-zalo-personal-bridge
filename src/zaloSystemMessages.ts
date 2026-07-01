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

export function normalizeRecommendedLinkMessage(
  rawText: string,
): { content: string; title?: string; description?: string; href?: string; thumb?: string; mediaTitle?: string } | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  let outer: any;
  try {
    outer = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!outer || outer.action !== "recommened.link") {
    return null;
  }

  const title: string | undefined = typeof outer?.title === "string" ? outer.title.trim() : undefined;
  const description: string | undefined = typeof outer?.description === "string" ? outer.description.trim() : undefined;
  const href: string | undefined = typeof outer?.href === "string" ? outer.href.trim() : undefined;
  const thumb: string | undefined = typeof outer?.thumb === "string" ? outer.thumb.trim() : undefined;

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

  const mediaTitle: string | undefined = typeof inner?.mediaTitle === "string" ? inner.mediaTitle.trim() : undefined;

  // Use mediaTitle if available, otherwise fall back to description or title
  const displayTitle = mediaTitle || description || title || "Link";
  const parts: string[] = [`🔗 [Link Preview]`];

  if (displayTitle && displayTitle.length) {
    parts.push(displayTitle);
  }

  if (href && href.length) {
    parts.push(href);
  }

  const content = parts.join("\n");
  if (!content || !content.trim()) {
    console.log("[zalo-recommened-link-error]", {
      reason: "invalid-structure",
      debug: {
        action: "recommened.link",
        hasTitle: !!title,
        hasDescription: !!description,
        hasHref: !!href,
        hasThumb: !!thumb,
        hasMediaTitle: !!mediaTitle,
        titlePreview: title ? title.slice(0, 60) : undefined,
        descriptionPreview: description ? description.slice(0, 60) : undefined,
        hrefPreview: href ? href.slice(0, 80) : undefined,
      },
    });
    return { content: "🔗 [Link Preview] (unparsed)" };
  }

  if (!href) {
    console.log("[zalo-recommened-link-no-href]", {
      action: "recommened.link",
      hasTitle: !!title,
      hasDescription: !!description,
      hasMediaTitle: !!mediaTitle,
      titlePreview: title ? title.slice(0, 60) : undefined,
    });
  }

  return {
    content,
    title,
    description,
    href,
    thumb,
    mediaTitle,
  };
}
