// Migration test fixture: reproduces the previously deployed 1.4.1 timeout patch.
// This script is not an install or build hook.
const fs = require("node:fs/promises");
const path = require("node:path");

const CALLBACK_TIMEOUT_MARKER = "zalo_upload_callback_timeout";
const CALLBACK_TIMEOUT_MS = 90_000;
const SUPPORTED_SDK_VERSIONS = new Set(["1.4.1", "1.4.2"]);

function replaceExactlyOnce(source, pattern, label, replacement) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one SDK match, found ${matches.length}`);
  }
  return source.replace(pattern, (...args) => replacement(args));
}

function patchSdkSource(source) {
  if (source.includes(CALLBACK_TIMEOUT_MARKER)) return { source, changed: false };

  const openingPattern = /^([ \t]*)await new Promise\(\(resolve\) => \{\r?\n([ \t]*)if \(data\.fileType == "video" \|\| data\.fileType == "others"\) \{\r?\n([ \t]*)const uploadCallback = async \(wsData\) => \{/gm;
  let patched = replaceExactlyOnce(source, openingPattern, "upload callback opening", ([, promiseIndent, branchIndent, callbackIndent]) => {
    const nestedIndent = `${callbackIndent}    `;
    return `${promiseIndent}await new Promise((resolve, reject) => {\n` +
      `${branchIndent}if (data.fileType == "video" || data.fileType == "others") {\n` +
      `${callbackIndent}const callbackKey = resData.fileId.toString();\n` +
      `${callbackIndent}const uploadCallbackTimeout = setTimeout(() => {\n` +
      `${nestedIndent}ctx.uploadCallbacks.delete(callbackKey);\n` +
      `${nestedIndent}const timeoutError = new Error("${CALLBACK_TIMEOUT_MARKER}");\n` +
      `${nestedIndent}timeoutError.name = "ZaloUploadCallbackTimeoutError";\n` +
      `${nestedIndent}reject(timeoutError);\n` +
      `${callbackIndent}}, ${CALLBACK_TIMEOUT_MS});\n` +
      `${callbackIndent}const uploadCallback = async (wsData) => {`;
  });

  const callbackPattern = /^([ \t]*)const uploadCallback = async \(wsData\) => \{\r?\n([ \t]*)const result = (.+);\r?\n([ \t]*)results\[atmIndex\] = result;\r?\n([ \t]*)resolve\(\);\r?\n([ \t]*)\};\r?\n([ \t]*)ctx\.uploadCallbacks\.set\(resData\.fileId\.toString\(\), uploadCallback\);/gm;
  patched = replaceExactlyOnce(patched, callbackPattern, "upload callback body", ([, callbackIndent, bodyIndent, resultExpression, , , , setIndent]) => {
    const nestedIndent = `${bodyIndent}    `;
    return `${callbackIndent}const uploadCallback = async (wsData) => {\n` +
      `${bodyIndent}try {\n` +
      `${nestedIndent}const result = ${resultExpression};\n` +
      `${nestedIndent}results[atmIndex] = result;\n` +
      `${nestedIndent}clearTimeout(uploadCallbackTimeout);\n` +
      `${nestedIndent}resolve();\n` +
      `${bodyIndent}} catch (error) {\n` +
      `${nestedIndent}clearTimeout(uploadCallbackTimeout);\n` +
      `${nestedIndent}reject(error);\n` +
      `${bodyIndent}}\n` +
      `${callbackIndent}};\n` +
      `${setIndent}ctx.uploadCallbacks.set(callbackKey, uploadCallback);`;
  });

  return { source: patched, changed: true };
}

function parseManifest(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid @warriorteam/zalo-personal package manifest", { cause: error });
  }
}

async function sdkPaths() {
  const entryPath = require.resolve("@warriorteam/zalo-personal");
  const sdkRoot = path.resolve(path.dirname(entryPath), "..", "..");
  const manifestText = await fs.readFile(path.join(sdkRoot, "package.json"), "utf8");
  const manifest = parseManifest(manifestText);
  if (!SUPPORTED_SDK_VERSIONS.has(manifest.version)) {
    throw new Error(`Unsupported @warriorteam/zalo-personal version: ${manifest.version}`);
  }
  return {
    version: manifest.version,
    files: [
      path.join(sdkRoot, "dist", "apis", "uploadAttachment.js"),
      path.join(sdkRoot, "dist", "cjs", "apis", "uploadAttachment.cjs"),
    ],
  };
}

async function applyPatchToInstalledSdk() {
  const sdk = await sdkPaths();
  let changedCount = 0;
  for (const filePath of sdk.files) {
    const original = await fs.readFile(filePath, "utf8");
    const result = patchSdkSource(original);
    if (result.changed) {
      await fs.writeFile(filePath, result.source, "utf8");
      changedCount += 1;
    }
  }
  if (changedCount > 0) {
    console.log(`[zalo-sdk-patch] bounded attachment callback wait for SDK ${sdk.version}`);
  }
}

if (require.main === module) {
  applyPatchToInstalledSdk().catch((error) => {
    console.error("[zalo-sdk-patch] failed to patch attachment callback timeout", error);
    process.exitCode = 1;
  });
}

module.exports = { patchSdkSource, applyPatchToInstalledSdk };
