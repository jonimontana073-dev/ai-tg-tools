// /api/download-image
// Прокси для скачивания сгенерированной аватарки с правильным
// Content-Type и Content-Disposition, чтобы браузер/Telegram сохраняли
// файл с нормальным расширением (.jpg/.png), а не как .bin.

const ALLOWED_HOSTS = ["image.pollinations.ai"];
const TIMEOUT_MS = 15000;

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ success: false, error: "METHOD_NOT_ALLOWED", message: "Только GET" });
    return;
  }

  try {
    const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
    if (!rawUrl) {
      res.status(400).json({ success: false, error: "BAD_REQUEST", message: "Не передан адрес картинки" });
      return;
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (parseErr) {
      res.status(400).json({ success: false, error: "BAD_REQUEST", message: "Некорректный адрес" });
      return;
    }

    if (ALLOWED_HOSTS.indexOf(parsed.hostname) === -1) {
      res.status(400).json({ success: false, error: "BAD_REQUEST", message: "Источник не поддерживается" });
      return;
    }

    const upstream = await fetchWithTimeout(parsed.toString(), {}, TIMEOUT_MS);
    if (!upstream.ok) {
      res.status(502).json({ success: false, error: "UPSTREAM_ERROR", message: "Не удалось получить картинку" });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const extension = contentType.indexOf("png") !== -1 ? "png" : "jpg";
    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", "attachment; filename=\"avatar." + extension + "\"");
    res.status(200).send(buffer);
  } catch (err) {
    console.error("[download-image] ошибка:", err && err.message ? err.message : err);
    res.status(500).json({ success: false, error: "INTERNAL_ERROR", message: "Внутренняя ошибка сервера" });
  }
};
