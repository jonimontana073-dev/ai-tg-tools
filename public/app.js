(function () {

  var avatarBusy = false;
  var textBusy = false;
  var avatarSafetyTimer = null;
  var lastAvatarRequestAt = 0;
  var AVATAR_COOLDOWN_MS = 10000;

  var RANDOM_PROMPTS = [
    "young woman with short silver hair, calm eyes, dark background",
    "man in hoodie, soft smile, cinematic side light",
    "androgynous face with freckles, golden hour light",
    "astronaut portrait, visor reflections, soft fog",
    "cyberpunk character, neon reflections in eyes",
    "artist with paint on cheeks, creative studio vibe",
    "warrior with braided hair, epic lighting, fog",
    "friendly robot portrait, soft neon accents"
  ];

  function fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    var opts = options || {};
    opts.signal = controller.signal;
    return fetch(url, opts).finally(function () {
      clearTimeout(timer);
    });
  }

  window.addEventListener("load", function () {

    var userGreeting = document.getElementById("userGreeting");
    var tgStatus = document.getElementById("tgStatus");
    var panelAvatar = document.getElementById("panel-avatar");
    var panelHumanize = document.getElementById("panel-humanize");
    var avatarPreview = document.getElementById("avatarPreview");
    var avatarFrame = document.getElementById("avatarFrame");
    var avatarLoader = document.getElementById("avatarLoader");
    var avatarPrompt = document.getElementById("avatarPrompt");
    var styleSelect = document.getElementById("styleSelect");
    var styleCycleBtn = document.getElementById("styleCycleBtn");
    var generateAvatarBtn = document.getElementById("generateAvatarBtn");
    var randomPromptBtn = document.getElementById("randomPromptBtn");
    var sourceText = document.getElementById("sourceText");
    var resultText = document.getElementById("resultText");
    var textLoader = document.getElementById("textLoader");
    var humanizeBtn = document.getElementById("humanizeBtn");
    var clearTextBtn = document.getElementById("clearTextBtn");
    var copyResultBtn = document.getElementById("copyResultBtn");
    var toast = document.getElementById("toast");
    var tabButtons = document.querySelectorAll(".tabbar-item");

    var toastTimer = null;

    function showToast(message) {
      if (!toast) return;
      toast.textContent = message;
      toast.hidden = false;
      toast.classList.add("is-visible");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toast.classList.remove("is-visible");
        setTimeout(function () {
          toast.hidden = true;
        }, 220);
      }, 2800);
    }

    function initTelegram() {
      var attempts = 0;
      var maxAttempts = 20;

      var waitTimer = setInterval(function () {
        attempts += 1;

        if (window.Telegram && window.Telegram.WebApp) {
          clearInterval(waitTimer);
          var tg = window.Telegram.WebApp;

          try {
            tg.ready();
            tg.expand();
          } catch (err) {}

          // Цвета приложения намеренно фиксированы (тёмная палитра из styles.css)
          // и НЕ подстраиваются под тему Telegram пользователя — иначе на части
          // светлых/смешанных тем получается тёмный текст на тёмном фоне.

          var user = tg.initDataUnsafe && tg.initDataUnsafe.user;
          if (userGreeting) {
            if (user) {
              var firstName = user.first_name || "";
              var lastName = user.last_name || "";
              var fullName = (firstName + " " + lastName).replace(/^\s+|\s+$/g, "");
              userGreeting.textContent = fullName ? "Привет, " + fullName
                : (user.username ? "@" + user.username : "Telegram Mini App");
            } else {
              userGreeting.textContent = "Telegram Mini App";
            }
          }

          if (tgStatus) {
            tgStatus.classList.add("is-online");
            tgStatus.classList.remove("is-offline");
          }
          var statusEl = document.getElementById("tgStatusText");
          if (statusEl) statusEl.textContent = "Online";

          if (tg.MainButton) tg.MainButton.hide();
          return;
        }

        if (attempts >= maxAttempts) {
          clearInterval(waitTimer);
          var fallbackStatus = document.getElementById("tgStatusText");
          if (fallbackStatus) fallbackStatus.textContent = "Браузер";
          if (tgStatus) {
            tgStatus.classList.add("is-offline");
            tgStatus.classList.remove("is-online");
          }
          if (userGreeting) userGreeting.textContent = "Демо-режим";
        }
      }, 100);
    }

    function switchTab(name) {
      if (!name) return;

      Array.prototype.forEach.call(tabButtons, function (tab) {
        var isActive = tab.getAttribute("data-tab") === name;
        tab.classList.toggle("is-active", isActive);
        tab.setAttribute("aria-selected", isActive ? "true" : "false");
      });

      if (panelAvatar) {
        var showAvatar = name === "avatar";
        panelAvatar.style.display = showAvatar ? "block" : "none";
        panelAvatar.hidden = !showAvatar;
        panelAvatar.classList.toggle("is-active", showAvatar);
      }
      if (panelHumanize) {
        var showHumanize = name === "humanize";
        panelHumanize.style.display = showHumanize ? "block" : "none";
        panelHumanize.hidden = !showHumanize;
        panelHumanize.classList.toggle("is-active", showHumanize);
      }

      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback) {
        window.Telegram.WebApp.HapticFeedback.selectionChanged();
      }
    }

    // ---------- АВАТАРЫ ----------

    function hideAvatarLoader() {
      clearTimeout(avatarSafetyTimer);
      avatarBusy = false;
      if (avatarLoader) {
        avatarLoader.style.display = "none";
        avatarLoader.hidden = true;
      }
      if (avatarFrame) avatarFrame.classList.remove("is-loading");
      if (avatarPreview) avatarPreview.style.opacity = "1";
      if (generateAvatarBtn) {
        generateAvatarBtn.disabled = false;
        generateAvatarBtn.textContent = "Сгенерировать";
      }
      if (randomPromptBtn) randomPromptBtn.disabled = false;
    }

    async function generateAvatar() {
      if (avatarBusy || !avatarPrompt) return;

      var prompt = avatarPrompt.value.replace(/^\s+|\s+$/g, "");
      if (!prompt) {
        showToast("Опишите аватар");
        return;
      }

      var sinceLast = Date.now() - lastAvatarRequestAt;
      if (sinceLast < AVATAR_COOLDOWN_MS) {
        showToast("Подождите " + Math.ceil((AVATAR_COOLDOWN_MS - sinceLast) / 1000) + " сек.");
        return;
      }
      lastAvatarRequestAt = Date.now();
      avatarBusy = true;

      if (avatarLoader) {
        avatarLoader.style.display = "flex";
        avatarLoader.hidden = false;
      }
      if (avatarFrame) avatarFrame.classList.add("is-loading");
      if (avatarPreview) avatarPreview.style.opacity = "0.3";
      if (generateAvatarBtn) {
        generateAvatarBtn.disabled = true;
        generateAvatarBtn.textContent = "Генерация…";
      }
      if (randomPromptBtn) randomPromptBtn.disabled = true;

      var style = styleSelect ? styleSelect.value : "";

      avatarSafetyTimer = setTimeout(function () {
        hideAvatarLoader();
        showToast("Сервер занят, повторите");
      }, 30000);

      try {
        var response = await fetchWithTimeout(
          "/api/generate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: prompt, style: style })
          },
          28000
        );
        var data = await response.json().catch(function () { return {}; });

        if (!response.ok || !data.success) {
          hideAvatarLoader();
          showToast((data && data.message) || "Все ИИ-сервера заняты, повторите");
          return;
        }

        if (avatarPreview) avatarPreview.src = data.url;
        hideAvatarLoader();
        showToast("Аватар готов!");
      } catch (err) {
        hideAvatarLoader();
        showToast("Ошибка сети, повторите");
      }
    }

    // ---------- ОЧЕЛОВЕЧИВАНИЕ ТЕКСТА ----------

    async function humanizeText() {
      if (textBusy || !sourceText) return;

      var source = sourceText.value.replace(/^\s+|\s+$/g, "");
      if (!source) {
        showToast("Введите текст для обработки");
        return;
      }

      textBusy = true;
      if (resultText) resultText.value = "";
      if (copyResultBtn) copyResultBtn.disabled = true;
      if (textLoader) {
        textLoader.style.display = "block";
        textLoader.hidden = false;
      }
      if (humanizeBtn) humanizeBtn.disabled = true;

      try {
        var response = await fetchWithTimeout(
          "/api/chat",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: source })
          },
          28000
        );
        var data = await response.json().catch(function () { return {}; });

        if (!response.ok || !data.success) {
          showToast((data && data.message) || "Все ИИ-сервера заняты, повторите");
          return;
        }

        if (resultText) resultText.value = data.text;
      } catch (err) {
        showToast("Ошибка сети, повторите");
      } finally {
        textBusy = false;
        if (textLoader) {
          textLoader.style.display = "none";
          textLoader.hidden = true;
        }
        if (humanizeBtn) humanizeBtn.disabled = false;
        if (copyResultBtn && resultText) {
          copyResultBtn.disabled = !(resultText.value.length > 0);
        }
      }
    }

    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        try {
          var tempInput = document.createElement("textarea");
          tempInput.value = text;
          tempInput.style.position = "fixed";
          tempInput.style.left = "-9999px";
          document.body.appendChild(tempInput);
          tempInput.focus();
          tempInput.select();
          var copied = document.execCommand("copy");
          document.body.removeChild(tempInput);
          copied ? resolve() : reject(new Error("copy failed"));
        } catch (err) {
          reject(err);
        }
      });
    }

    initTelegram();
    hideAvatarLoader();

    if (avatarPreview) {
      avatarPreview.src = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">' +
        '<rect width="200" height="200" rx="40" fill="#121821"/>' +
        '<circle cx="100" cy="78" r="32" fill="#2a3545"/>' +
        '<ellipse cx="100" cy="158" rx="52" ry="30" fill="#2a3545"/>' +
        "</svg>"
      );
    }

    Array.prototype.forEach.call(tabButtons, function (tabBtn) {
      tabBtn.addEventListener("click", function (e) {
        e.preventDefault();
        var target = e.target;
        while (target && !target.classList.contains("tabbar-item")) {
          target = target.parentElement;
        }
        if (target) switchTab(target.getAttribute("data-tab"));
      });
    });

    if (generateAvatarBtn) generateAvatarBtn.addEventListener("click", generateAvatar);

    if (randomPromptBtn) {
      randomPromptBtn.addEventListener("click", function () {
        if (!avatarPrompt) return;
        avatarPrompt.value = RANDOM_PROMPTS[Math.floor(Math.random() * RANDOM_PROMPTS.length)];
        showToast("Случайное описание");
      });
    }

    if (styleCycleBtn && styleSelect) {
      styleCycleBtn.addEventListener("click", function () {
        var options = styleSelect.options;
        if (!options || options.length === 0) return;
        styleSelect.selectedIndex = (styleSelect.selectedIndex + 1) % options.length;
        showToast("Стиль: " + options[styleSelect.selectedIndex].text);
      });
    }

    if (humanizeBtn) humanizeBtn.addEventListener("click", humanizeText);

    if (clearTextBtn) {
      clearTextBtn.addEventListener("click", function () {
        if (sourceText) sourceText.value = "";
        if (resultText) resultText.value = "";
        if (copyResultBtn) copyResultBtn.disabled = true;
      });
    }

    if (copyResultBtn) {
      copyResultBtn.addEventListener("click", function () {
        if (!resultText) return;
        var textToCopy = resultText.value.replace(/^\s+|\s+$/g, "");
        if (!textToCopy) return;
        copyToClipboard(textToCopy)
          .then(function () { showToast("Скопировано!"); })
          .catch(function () { showToast("Не удалось скопировать"); });
      });
    }

  });

})();
