/**
 * GET/POST /api/upscale-test  — PRIVATE test tool (delete when done).
 *
 * Purpose: test the "generate previews at 1K, then have Gemini recreate the
 * identical shot at 2K on purchase" idea, using the SAME GEMINI_API_KEY the
 * live app uses (so there is no AI Studio billing/permission puzzle).
 *
 * GET  → serves a tiny self-contained HTML test page.
 * POST → { token, imageBase64, mimeType, prompt, model, imageSize } → calls
 *        Gemini to recreate the uploaded image, returns the result as base64.
 *
 * Guard: a hardcoded TEST_TOKEN (baked into the page) stops drive-by traffic
 * from burning Gemini budget. This is a throwaway tool — DELETE this file
 * after testing so nobody can hit it.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";

export const maxDuration = 120;

// Simple obscurity guard (NOT the admin password). Baked into the page below.
const TEST_TOKEN = "upscale-test-2026";

const PER_ATTEMPT_TIMEOUT_MS = 110_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>1K &rarr; 2K Recreate Test (private)</title>
<style>
  :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  body { margin: 0; background: #f4f5f7; color: #1c2430; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 24px 20px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #6b7684; font-size: 14px; margin: 0 0 24px; }
  .card { background: #fff; border: 1px solid #e3e7ee; border-radius: 14px; padding: 20px; margin-bottom: 18px; }
  label { display: block; font-weight: 600; font-size: 14px; margin: 0 0 8px; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 180px; }
  select, textarea, input[type=file] { width: 100%; box-sizing: border-box; font-size: 15px; }
  select { padding: 10px; border: 1px solid #cfd6e0; border-radius: 10px; background: #fff; }
  textarea { padding: 12px; border: 1px solid #cfd6e0; border-radius: 10px; min-height: 110px; resize: vertical; line-height: 1.4; }
  .check { display: flex; align-items: center; gap: 10px; font-size: 14px; color: #384250; margin-top: 12px; font-weight: 500; }
  .check input { width: 18px; height: 18px; }
  button { background: #2b6cff; color: #fff; border: 0; border-radius: 12px; padding: 16px 22px; font-size: 17px; font-weight: 700; cursor: pointer; width: 100%; }
  button:disabled { background: #9db8f0; cursor: default; }
  .results { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 6px; }
  .pane { flex: 1; min-width: 240px; }
  .pane h3 { font-size: 14px; margin: 0 0 8px; color: #384250; }
  .pane img { width: 100%; border-radius: 12px; border: 1px solid #e3e7ee; display: block; background: #eef1f5; }
  .dims { font-size: 13px; color: #6b7684; margin-top: 6px; }
  .hint { font-size: 13px; color: #6b7684; margin-top: 14px; line-height: 1.5; }
  .err { background: #fff2f2; border: 1px solid #ffcccc; color: #a11; padding: 12px 14px; border-radius: 10px; font-size: 14px; margin-top: 12px; white-space: pre-wrap; }
  .spin { display: inline-block; width: 16px; height: 16px; border: 3px solid #ffffff80; border-top-color: #fff; border-radius: 50%; animation: s 0.8s linear infinite; vertical-align: -3px; margin-right: 8px; }
  @keyframes s { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="wrap">
  <h1>1K &rarr; 2K Recreate Test</h1>
  <p class="sub">Private tool. Uploads never leave your Google key. Delete this file when you're done testing.</p>

  <div class="card">
    <label>Step 1 &mdash; Choose one of your headshots</label>
    <input id="file" type="file" accept="image/*" />
    <label class="check"><input id="downsize" type="checkbox" checked /> Shrink it to 1K first (simulates the cheaper preview) &mdash; recommended</label>
  </div>

  <div class="card">
    <div class="row">
      <div>
        <label>Model</label>
        <select id="model">
          <option value="gemini-3-pro-image-preview">Nano Banana Pro (Gemini 3 Pro)</option>
          <option value="gemini-3.1-flash-image-preview">Nano Banana 2 (Flash &mdash; what your app uses)</option>
          <option value="gemini-2.5-flash-image">Nano Banana 1 (older Flash)</option>
        </select>
      </div>
      <div>
        <label>Output size</label>
        <select id="size">
          <option value="2K" selected>2K</option>
          <option value="1K">1K</option>
          <option value="4K">4K</option>
        </select>
      </div>
    </div>
    <div style="margin-top:16px">
      <label>Step 2 &mdash; The recreate instruction</label>
      <textarea id="prompt">Recreate this exact image at higher resolution. Keep the person, face, eyes, teeth, skin, hair, background, clothing, pose, and lighting perfectly identical. Do not change, add, or remove anything. Only add fine pixel-level detail and sharpness.</textarea>
    </div>
  </div>

  <button id="go" disabled>Recreate</button>
  <div id="err" class="err" style="display:none"></div>

  <div class="card" id="resultCard" style="display:none; margin-top:18px">
    <div class="results">
      <div class="pane">
        <h3>Source (sent to Gemini)</h3>
        <img id="srcImg" alt="source" />
        <div class="dims" id="srcDims"></div>
      </div>
      <div class="pane">
        <h3>Recreated result</h3>
        <img id="outImg" alt="result" />
        <div class="dims" id="outDims"></div>
      </div>
    </div>
    <p class="hint">Zoom into the <strong>eyes, teeth, hairline, and skin</strong>. If those stay identical, the recreate idea works. If they shift even slightly, that means it's quietly changing the face &mdash; and an upscaler (like Topaz) would be safer.</p>
  </div>
</div>

<script>
var TOKEN = "__TOKEN__";
var fileEl = document.getElementById("file");
var goEl = document.getElementById("go");
var errEl = document.getElementById("err");
var srcImg = document.getElementById("srcImg");
var outImg = document.getElementById("outImg");
var srcDims = document.getElementById("srcDims");
var outDims = document.getElementById("outDims");
var resultCard = document.getElementById("resultCard");
var pickedDataUrl = null;

function showErr(msg) { errEl.style.display = "block"; errEl.textContent = msg; }
function clearErr() { errEl.style.display = "none"; errEl.textContent = ""; }

// Draw an image to a canvas so we can (a) optionally shrink to ~1K and
// (b) get clean base64 to send. Portrait target width for 1K = 896px.
function processFile(file, downsize, cb) {
  var reader = new FileReader();
  reader.onload = function (e) {
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      var targetW = w, targetH = h;
      if (downsize) {
        var longSide = Math.max(w, h);
        if (longSide > 1200) {
          var scale = 1200 / longSide; // 1K portrait ~= 900x1200
          targetW = Math.round(w * scale);
          targetH = Math.round(h * scale);
        }
      }
      var canvas = document.createElement("canvas");
      canvas.width = targetW; canvas.height = targetH;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, targetW, targetH);
      var dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      cb(dataUrl, targetW, targetH);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

fileEl.addEventListener("change", function () {
  clearErr();
  var f = fileEl.files && fileEl.files[0];
  if (!f) { goEl.disabled = true; return; }
  var downsize = document.getElementById("downsize").checked;
  processFile(f, downsize, function (dataUrl, w, h) {
    pickedDataUrl = dataUrl;
    srcImg.src = dataUrl;
    srcDims.textContent = w + " x " + h + " px";
    resultCard.style.display = "block";
    outImg.removeAttribute("src");
    outDims.textContent = "";
    goEl.disabled = false;
  });
});

goEl.addEventListener("click", function () {
  if (!pickedDataUrl) return;
  clearErr();
  goEl.disabled = true;
  goEl.innerHTML = '<span class="spin"></span>Recreating (this can take up to a minute)...';
  var comma = pickedDataUrl.indexOf(",");
  var base64 = pickedDataUrl.slice(comma + 1);
  var payload = {
    token: TOKEN,
    imageBase64: base64,
    mimeType: "image/jpeg",
    prompt: document.getElementById("prompt").value,
    model: document.getElementById("model").value,
    imageSize: document.getElementById("size").value
  };
  fetch("/api/upscale-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      goEl.disabled = false;
      goEl.textContent = "Recreate";
      if (!data.ok) {
        showErr("Gemini did not return an image.\\n\\n" + (data.error || "Unknown error") + (data.modelText ? "\\n\\nModel said: " + data.modelText : ""));
        return;
      }
      var url = "data:" + (data.mimeType || "image/png") + ";base64," + data.imageBase64;
      outImg.onload = function () {
        outDims.textContent = outImg.naturalWidth + " x " + outImg.naturalHeight + " px";
      };
      outImg.src = url;
    })
    .catch(function (e) {
      goEl.disabled = false;
      goEl.textContent = "Recreate";
      showErr("Request failed: " + e.message);
    });
});
</script>
</body>
</html>`;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(PAGE_HTML.replace("__TOKEN__", TEST_TOKEN));
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const body = (req.body ?? {}) as {
    token?: unknown;
    imageBase64?: unknown;
    mimeType?: unknown;
    prompt?: unknown;
    model?: unknown;
    imageSize?: unknown;
  };

  if (body.token !== TEST_TOKEN) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ ok: false, error: "Server missing GEMINI_API_KEY" });
    return;
  }

  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
  const mimeType =
    typeof body.mimeType === "string" ? body.mimeType : "image/jpeg";
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt.trim()
      : "Recreate this exact image at higher resolution, keeping everything perfectly identical.";
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : "gemini-3-pro-image-preview";
  const imageSize =
    body.imageSize === "1K" || body.imageSize === "2K" || body.imageSize === "4K"
      ? body.imageSize
      : "2K";

  if (!imageBase64) {
    res.status(400).json({ ok: false, error: "no image provided" });
    return;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const apiCall = ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: imageBase64 } },
          ],
        },
      ],
      // 3:4 matches the app's headshots and prevents Gemini from recomposing.
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "3:4", imageSize },
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Gemini timeout after ${PER_ATTEMPT_TIMEOUT_MS}ms`)),
        PER_ATTEMPT_TIMEOUT_MS,
      );
    });

    const response = (await Promise.race([apiCall, timeoutPromise])) as Awaited<
      ReturnType<typeof ai.models.generateContent>
    >;

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const imagePart = parts.find(
      (p) => (p as { inlineData?: { data?: string } }).inlineData?.data,
    ) as { inlineData?: { mimeType?: string; data?: string } } | undefined;

    if (!imagePart?.inlineData?.data) {
      // Surface any text the model returned (e.g. a refusal) for debugging.
      const modelText = parts
        .map((p) => (p as { text?: string }).text)
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);
      res.status(200).json({
        ok: false,
        error: "Model returned no image.",
        modelText: modelText || undefined,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      imageBase64: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || "image/png",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[upscale-test] failed:", msg);
    res.status(200).json({ ok: false, error: msg });
  }
}
