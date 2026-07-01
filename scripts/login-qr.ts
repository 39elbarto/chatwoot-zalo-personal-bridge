import fs from "fs";
import path from "path";
import dotenv from "dotenv";
// qrcode-terminal / pngjs / jsqr have no bundled types; use require to keep ts-node happy.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const qrcode: any = require("qrcode-terminal");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PNG }: any = require("pngjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsQR: any = require("jsqr");

const zaloEntrypoint = require.resolve("@warriorteam/zalo-personal");
const zaloPackageDir = path.resolve(path.dirname(zaloEntrypoint), "..", "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loginQRModule: any = require(path.join(zaloPackageDir, "dist/cjs/apis/loginQR.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loginModule: any = require(path.join(zaloPackageDir, "dist/cjs/apis/login.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const contextModule: any = require(path.join(zaloPackageDir, "dist/cjs/context.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const apisModule: any = require(path.join(zaloPackageDir, "dist/cjs/apis.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Zalo, LoginQRCallbackEventType }: any = require("@warriorteam/zalo-personal");

const originalSdkLoginQR = loginQRModule.loginQR;
loginQRModule.loginQR = async function patchedLoginQR(ctx: any, options: any, callback: any) {
  try {
    return await originalSdkLoginQR(ctx, options, callback);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cookies = ctx?.cookie?.toJSON?.()?.cookies;
    if (message === "Can't login" && Array.isArray(cookies) && cookies.length > 0) {
      console.warn(
        "[login:qr] SDK reported false-negative login state after confirmed QR login; reusing recovered session cookies.",
      );
      return {
        cookies,
        userInfo: {
          name: "Recovered from QR session",
          avatar: "",
        },
      };
    }
    throw err;
  }
};

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function stripOuterQuotes(value: string | undefined): string | undefined {
  if (!value) return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function upsertEnvFile(envPath: string, updates: Record<string, string>) {
  let raw = "";
  try {
    raw = await fs.promises.readFile(envPath, "utf8");
  } catch {
    raw = "";
  }

  const lines = raw.split(/\r?\n/);
  const seen = new Set<string>();

  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${value}`);
    }
  }

  await fs.promises.writeFile(envPath, nextLines.join("\n"), "utf8");
}

function handleQrEvent(event: any) {
  switch (event.type) {
    case LoginQRCallbackEventType.QRCodeGenerated: {
      console.log("[login:qr] QR generated. Scan it in Zalo app.");
      const data: any = event.data || {};
      const qrDir = path.resolve(process.cwd(), "data");
      const qrPath = path.join(qrDir, "qr.png");

      let savedPng = false;
      if (typeof data.image === "string" && data.image.length > 0) {
        try {
          void fs.promises.mkdir(qrDir, { recursive: true });
          const buf = Buffer.from(data.image.replace(/^data:image\/png;base64,/, ""), "base64");
          void fs.promises.writeFile(qrPath, buf);
          console.log(`[login:qr] QR PNG saved to ${qrPath}`);
          console.log("[login:qr] IMPORTANT: scan this PNG (not the ASCII QR below).");
          savedPng = true;

          try {
            const png = PNG.sync.read(buf);
            const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
            if (qr?.data) {
              console.log("[login:qr] Rendering QR in terminal from PNG payload:");
              qrcode.generate(qr.data, { small: true });
            } else {
              console.log("[login:qr] Could not decode QR payload from PNG; scan qr.png.");
            }
          } catch (err) {
            console.log(
              "[login:qr] Failed to decode QR from PNG; scan qr.png.",
              (err as Error).message,
            );
          }
        } catch (err) {
          console.warn("[login:qr] Failed to save QR PNG:", (err as Error).message);
        }
      } else if (event.actions?.saveToFile) {
        void event.actions.saveToFile(qrPath);
        console.log(`[login:qr] QR PNG saved to ${qrPath}`);
        console.log("[login:qr] IMPORTANT: scan this PNG (not the ASCII QR below).");
        savedPng = true;
      }

      if (!savedPng) {
        const qrPayload = data.qrCodeUrl || data.url || data.code;
        if (typeof qrPayload === "string" && qrPayload.length > 0) {
          console.log("[login:qr] Fallback ASCII QR payload:", qrPayload);
          qrcode.generate(qrPayload, { small: true });
        } else {
          console.log("[login:qr] No QR payload string available for ASCII render.");
        }
      }
      break;
    }
    case LoginQRCallbackEventType.QRCodeScanned:
      console.log(
        `[login:qr] QR scanned by ${event.data?.display_name || "unknown"}, waiting confirmation…`,
      );
      break;
    case LoginQRCallbackEventType.QRCodeExpired:
      console.log("[login:qr] QR expired, regenerating…");
      event.actions?.retry?.();
      break;
    case LoginQRCallbackEventType.QRCodeDeclined:
      console.log("[login:qr] Login declined in app.");
      break;
    case LoginQRCallbackEventType.GotLoginInfo:
      console.log("[login:qr] Login confirmed, runtime login in progress…");
      break;
    default:
      break;
  }
}

async function main() {
  const language = process.env.ZALO_LANGUAGE || "vi";
  const envUserAgent = stripOuterQuotes(process.env.ZALO_USER_AGENT);
  const userAgent = envUserAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
  const imei = stripOuterQuotes(process.env.ZALO_IMEI) || process.env.ZALO_IMEI;
  const sessionFile = stripOuterQuotes(process.env.ZALO_SESSION_FILE) || "./data/session.json";
  const serviceName = path.basename(process.cwd());

  if (!imei) throw new Error("ZALO_IMEI must be set before QR login");

  const zalo = new Zalo({ selfListen: true, logging: true });
  console.log("[login:qr] Generating QR code…");
  console.log("[login:qr] Open Zalo app → Discover/More → QR Code → Scan QR, then confirm login.");

  const ctx = contextModule.createContext((zalo as any).options?.apiType, (zalo as any).options?.apiVersion);
  Object.assign(ctx.options, (zalo as any).options);
  ctx.imei = imei;
  ctx.userAgent = userAgent;
  ctx.language = language;

  const qrResult = await loginQRModule.loginQR(ctx, { userAgent, language }, handleQrEvent);
  const cookies = qrResult?.cookies || ctx?.cookie?.toJSON?.()?.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("QR login did not return session cookies.");
  }

  ctx.cookie = (zalo as any).parseCookies(cookies);
  const runtimeLogin = await loginModule.login(ctx, true);
  const runtimeInfo = runtimeLogin?.data;
  const serverInfo = await loginModule.getServerInfo(ctx, true);
  if (!runtimeLogin || !runtimeInfo || !serverInfo) {
    throw new Error("QR login completed, but runtime context initialization failed.");
  }

  ctx.secretKey = runtimeInfo.zpw_enk;
  ctx.uid = runtimeInfo.uid;
  ctx.settings = serverInfo.setttings || serverInfo.settings;
  ctx.extraVer = serverInfo.extra_ver;
  ctx.loginInfo = runtimeInfo;
  const api = new apisModule.API(ctx, runtimeInfo.zpw_service_map_v3, runtimeInfo.zpw_ws);

  const sessionPath = path.resolve(sessionFile);
  await fs.promises.mkdir(path.dirname(sessionPath), { recursive: true });
  const savedCtx = api.getContext?.();
  const sessionPayload = {
    imei,
    userAgent,
    language,
    cookie: cookies,
    context: savedCtx
      ? {
          uid: savedCtx.uid,
          secretKey: savedCtx.secretKey,
          settings: savedCtx.settings,
          extraVer: savedCtx.extraVer,
          loginInfo: savedCtx.loginInfo,
          apiType: savedCtx.API_TYPE,
          apiVersion: savedCtx.API_VERSION,
        }
      : undefined,
  };
  await fs.promises.writeFile(sessionPath, JSON.stringify(sessionPayload, null, 2), "utf8");

  const envPath = path.resolve(process.cwd(), ".env");
  const cookieJson = JSON.stringify(cookies);
  const quotedUA = `"${userAgent.replace(/"/g, '\\"')}"`;
  await upsertEnvFile(envPath, {
    ZALO_IMEI: imei,
    ZALO_USER_AGENT: quotedUA,
    ZALO_LANGUAGE: language,
    ZALO_COOKIE_JSON: cookieJson,
    ZALO_SESSION_FILE: sessionFile,
  });

  if (savedCtx?.secretKey && savedCtx?.loginInfo?.zpw_service_map_v3 && savedCtx?.loginInfo?.zpw_ws) {
    console.log("[login:qr] Full runtime context captured and stored.");
  } else {
    console.warn(
      "[login:qr] Session cookies were saved, but the SDK did not expose a full runtime context. Restart the bridge and verify it reconnects.",
    );
  }
  console.log("[login:qr] Saved:");
  console.log(`- session: ${sessionPath}`);
  console.log(`- env updated: ${envPath}`);
  console.log(`[login:qr] Restart bridge: sudo systemctl restart ${serviceName}`);
}

main().catch((err) => {
  console.error("[login:qr] Failed:", err);
  process.exit(1);
});
