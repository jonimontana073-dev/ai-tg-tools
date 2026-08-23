// /api/telegram-webhook
// Простой обработчик команд бота. Сейчас умеет ровно одну вещь:
// отвечать на /appss_verify кодом подтверждения владения ботом для appss.pro.
// Токен бота читается ТОЛЬКО из переменной окружения Vercel — в код не зашит.

const VERIFY_COMMAND = "/appss_verify";
const VERIFY_CODE = "appss_7ef59a";

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("[telegram-webhook] TELEGRAM_BOT_TOKEN не задан в Environment Variables");
    return;
  }
  const url = "https://api.telegram.org/bot" + token + "/sendMessage";
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}

module.exports = async function handler(req, res) {
  // Telegram всегда ждёт 200 OK, иначе будет повторять доставку апдейта снова и снова.
  if (req.method !== "POST") {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    const update = req.body && typeof req.body === "object" ? req.body : {};
    const message = update.message || update.edited_message;
    const text = message && typeof message.text === "string" ? message.text.trim() : "";
    const chatId = message && message.chat && message.chat.id;

    if (chatId && text.toLowerCase().indexOf(VERIFY_COMMAND) === 0) {
      await sendTelegramMessage(chatId, VERIFY_CODE);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[telegram-webhook] ошибка:", err && err.message ? err.message : err);
    res.status(200).json({ ok: true });
  }
};
