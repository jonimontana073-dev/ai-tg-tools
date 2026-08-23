// /api/generate.js
// Provider #1: Pollinations (анонимный image-эндпоинт, ключ не нужен).
// Provider #2: Hugging Face Inference API (нужен HF_API_KEY в переменных окружения).

const MAX_PROMPT_LENGTH = 500;
const PROVIDER_TIMEOUT_MS = 10000;
const CYRILLIC_RE = /[а-яё]/i;

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const lastRequestByKey = new Map();
const MIN_INTERVAL_MS = 8000;

function isRateLimited(key) {
  const now = Date.now();
  const last = lastRequestByKey.get(key) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    return true;
  }
  lastRequestByKey.set(key, now);
  return false;
}

async function translateToEnglish(text) {
  const params = new URLSearchParams({ q: text.slice(0, 400), langpair: "ru|en" });
  const response = await fetchWithTimeout(
    "https://api.mymemory.translated.net/get?" + params.toString(),
    {},
    6000
  );
  if (!response.ok) {
    throw new Error("translate-status-" + response.status);
  }
  const data = await response.json();
  const translated = data && data.responseData && data.responseData.translatedText;
  if (!translated) {
    throw new Error("translate-empty");
  }
  return translated;
}

async function checkPollinationsImage(promptForModel, style) {
  const stylePart = style ? ", " + style : "";
  const fullPrompt = (promptForModel + stylePart + ", high resolution, 8k, photorealistic, detailed face")
    .replace(/[\r\n]+/g, " ");
  const seed = Math.floor(Math.random() * 100000);
  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(fullPrompt) +
    "?width=512&height=512&nologo=true&seed=" + seed + "&t=" + Date.now();

  const response = await fetchWithTimeout(url, {}, PROVIDER_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error("pollinations-image-status-" + response.status);
  }
  return url;
}

async function generateViaHuggingFace(promptForModel, style) {
  const token = process.env.HF_API_KEY || process.env.HF_TOKEN;
  if (!token) {
    throw new Error("hf-not-configured");
  }
  const model = process.env.HF_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell";
  const stylePart = style ? ", " + style : "";
  const fullPrompt = (promptForModel + stylePart + ", high resolution, photorealistic, detailed face")
    .replace(/[\r\n]+/g, " ");

  const requestOnce = () =>
    fetchWithTimeout(
      "https://api-inference.huggingface.co/models/" + model,
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ inputs: fullPrompt })
      },
      PROVIDER_TIMEOUT_MS
    );

  let response = await requestOnce();

  if (response.status === 503) {
    let waitSeconds = 8;
    try {
      const loadingInfo = await response.clone().json();
      if (loadingInfo && loadingInfo.estimated_time) {
        waitSeconds = Math.min(12, Math.ceil(loadingInfo.estimated_time));
      }
    } catch (parseErr) {
      /* тело не JSON */
    }
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    response = await requestOnce();
  }

  if (!response.ok) {
    throw new Error("hf-status-" + response.status);
  }

  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return "data:image/png;base64," + base64;
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "METHOD_NOT_ALLOWED", message: "Только POST" });
    return;
  }

  try {
    const clientKey = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").toString();
    if (isRateLimited(clientKey)) {
      res.status(429).json({ success: false, error: "RATE_LIMITED", message: "Слишком часто, подождите немного" });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const style = typeof body.style === "string" ? body.style.trim() : "";

    if (!rawPrompt) {
      res.status(400).json({ success: false, error: "BAD_REQUEST", message: "Пустое описание" });
      return;
    }
    if (rawPrompt.length > MAX_PROMPT_LENGTH) {
      res.status(400).json({
        success: false,
        error: "PROMPT_TOO_LONG",
        message: "Описание слишком длинное (максимум " + MAX_PROMPT_LENGTH + " символов)"
      });
      return;
    }

    let promptForModel = rawPrompt.replace(/[\r\n]+/g, " ");
    if (CYRILLIC_RE.test(promptForModel)) {
      try {
        promptForModel = await translateToEnglish(promptForModel);
      } catch (translateErr) {
        // перевод не удался — используем оригинал
      }
    }

    var pollError = null;
    var hfError = null;

    try {
      const url = await checkPollinationsImage(promptForModel, style);
      res.status(200).json({ success: true, url, provider: "pollinations" });
      return;
    } catch (pollErr) {
      pollError = pollErr && pollErr.message ? pollErr.message : "unknown";
    }

    try {
      const dataUrl = await generateViaHuggingFace(promptForModel, style);
      res.status(200).json({ success: true, url: dataUrl, provider: "huggingface" });
      return;
    } catch (hfErr) {
      hfError = hfErr && hfErr.message ? hfErr.message : "unknown";
    }

    console.error("[api/generate] оба провайдера отказали — pollinations:", pollError, "| huggingface:", hfError);

    res.status(503).json({
      success: false,
      error: "ALL_AI_PROVIDERS_BUSY",
      message: "Ошибка: pollinations=" + pollError + " | huggingface=" + hfError
    });
  } catch (err) {
    console.error("[api/generate] внутренняя ошибка:", err && err.message ? err.message : err);
    res.status(500).json({ success: false, error: "INTERNAL_ERROR", message: "Внутренняя ошибка сервера" });
  }
};
