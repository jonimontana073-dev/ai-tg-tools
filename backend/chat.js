// /api/chat.js
// Каскад текстовых провайдеров. Ключи читаются ТОЛЬКО из переменных
// окружения Vercel (process.env) — их не видно в браузере ни при каком
// раскладе, в отличие от прежней схемы с config.js.

const MAX_INPUT_LENGTH = 6000;
const PROVIDER_TIMEOUT_MS = 15000;

const HUMANIZE_INSTRUCTION =
  "Ты переписываешь текст как конкретный живой человек — уставший копирайтер, " +
  "который пишет второпях, а не как редактор или ассистент. Обязательно сделай ВСЁ " +
  "из списка: " +
  "1) Начни не с той же мысли, что в оригинале — поменяй заход, добавь короткую " +
  "личную реплику или риторический вопрос в начале. " +
  "2) Резко чередуй длину предложений: минимум одно предложение из 3-5 слов, минимум " +
  "одно длинное на 25+ слов со сложной структурой. " +
  "3) Замени порядок аргументов из оригинала — не иди по пунктам в том же порядке. " +
  "4) Никогда не используй: 'более того', 'таким образом', 'важно отметить', " +
  "'в заключение', 'погружаясь в мир', 'нельзя не отметить', 'в современном мире', " +
  "'играет ключевую роль', 'является основой', 'следует отметить'. " +
  "5) Используй разговорные слова и сокращения там, где уместно. Разрешены немного " +
  "неидеальные, естественные формулировки. " +
  "6) Добавь одну простую конкретику или сравнение от себя, не выдумывая фактов, " +
  "которых не было. " +
  "7) Сохрани весь исходный смысл и факты. " +
  "8) Верни только готовый текст без пояснений, без кавычек, без списков, без markdown.";

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

// Best-effort троттлинг в рамках одного тёплого инстанса функции.
// Не замена настоящему rate-limit сервису, но снижает случайный флуд.
const lastRequestByKey = new Map();
const MIN_INTERVAL_MS = 3000;

function isRateLimited(key) {
  const now = Date.now();
  const last = lastRequestByKey.get(key) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    return true;
  }
  lastRequestByKey.set(key, now);
  return false;
}

// Groq, Gemini (OpenAI-совместимый эндпоинт) и OpenRouter принимают
// одинаковый формат запроса — один обработчик на всех троих.
async function callOpenAiCompatible(baseUrl, apiKey, model, sourceText, extraHeaders) {
  if (!apiKey) {
    throw new Error("not-configured");
  }
  const headers = {
    "Authorization": "Bearer " + apiKey,
    "Content-Type": "application/json",
    ...(extraHeaders || {})
  };

  const response = await fetchWithTimeout(
    baseUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: HUMANIZE_INSTRUCTION },
          { role: "user", content: sourceText }
        ],
        temperature: 1.05,
        frequency_penalty: 0.6,
        presence_penalty: 0.4
      })
    },
    PROVIDER_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error("status-" + response.status);
  }
  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  if (!content) {
    throw new Error("empty-response");
  }
  return content;
}

function buildProviders(sourceText) {
  return [
    {
      name: "groq",
      run: () =>
        callOpenAiCompatible(
          "https://api.groq.com/openai/v1/chat/completions",
          process.env.GROQ_API_KEY,
          process.env.GROQ_MODEL || "openai/gpt-oss-120b",
          sourceText
        )
    },
    {
      name: "gemini",
      run: () =>
        callOpenAiCompatible(
          "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
          process.env.GEMINI_API_KEY,
          process.env.GEMINI_MODEL || "gemini-2.5-flash",
          sourceText
        )
    },
    {
      name: "openrouter",
      run: () =>
        callOpenAiCompatible(
          "https://openrouter.ai/api/v1/chat/completions",
          process.env.OPENROUTER_API_KEY,
          process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
          sourceText,
          { "HTTP-Referer": "https://vercel.app", "X-Title": "AI TG TOOLS" }
        )
    }
  ];
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
      res.status(429).json({ success: false, error: "RATE_LIMITED", message: "Слишком часто, подождите пару секунд" });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const sourceText = typeof body.text === "string" ? body.text.trim() : "";

    if (!sourceText) {
      res.status(400).json({ success: false, error: "BAD_REQUEST", message: "Пустой текст" });
      return;
    }
    if (sourceText.length > MAX_INPUT_LENGTH) {
      res.status(400).json({
        success: false,
        error: "TEXT_TOO_LONG",
        message: "Текст слишком длинный (максимум " + MAX_INPUT_LENGTH + " символов)"
      });
      return;
    }

    const cleanedText = sourceText.replace(/[\r\n]+/g, " ");
    const providers = buildProviders(cleanedText);
    const failures = [];

    for (const provider of providers) {
      try {
        const result = await provider.run();
        res.status(200).json({ success: true, text: result, provider: provider.name });
        return;
      } catch (err) {
        failures.push(provider.name + ": " + (err && err.message ? err.message : "unknown"));
      }
    }

    console.error("[api/chat] все провайдеры отказали:", failures.join(" | "));

    res.status(503).json({
      success: false,
      error: "ALL_AI_PROVIDERS_BUSY",
      message: "Ошибка: " + failures.join(" | ")
    });
  } catch (err) {
    console.error("[api/chat] внутренняя ошибка:", err && err.message ? err.message : err);
    res.status(500).json({ success: false, error: "INTERNAL_ERROR", message: "Внутренняя ошибка сервера" });
  }
};
