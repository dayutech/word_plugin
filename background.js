const MENU_ID = "save-selected-word";
const STORAGE_KEY = "savedWords";
const CACHE_KEY = "translationCache";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "保存单词",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) {
    return;
  }

  const rawSelection = info.selectionText || "";
  const word = normalizeSelection(rawSelection);

  if (!word) {
    notify("保存失败", "请选择一个英文单词后再保存。");
    return;
  }

  try {
    const existing = await getSavedWords();
    const existsItem = existing.find((item) => item.word.toLowerCase() === word.toLowerCase());
    const meaning = await resolveMeaning(word, existsItem);
    await showMeaningOnScreen(tab?.id, word, meaning);

    if (existsItem) {
      return;
    }

    const next = [
      {
        word,
        meaning,
        pageUrl: info.pageUrl || "",
        createdAt: new Date().toISOString()
      },
      ...existing
    ];

    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (error) {
    console.error("Failed to save word:", error);
    notify("保存失败", "翻译服务不可用，请稍后重试。");
  }
});

async function resolveMeaning(word, existsItem) {
  const localMeaning = existsItem?.meaning?.trim();
  if (localMeaning) {
    return localMeaning;
  }

  const cache = await getTranslationCache();
  const key = word.toLowerCase();
  const cachedMeaning = cache[key];

  if (typeof cachedMeaning === "string" && cachedMeaning.trim()) {
    return cachedMeaning;
  }

  let meaning = "";
  try {
    meaning = await fetchChineseMeaningFromYoudao(word);
  } catch (error) {
    console.warn("Youdao translate failed, fallback to Google:", error);
  }

  if (!meaning) {
    meaning = await fetchChineseMeaningFromGoogle(word);
  }

  cache[key] = meaning;
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
  return meaning;
}

async function fetchChineseMeaningFromYoudao(word) {
  const endpoint = "https://dict.youdao.com/jsonapi";
  const params = new URLSearchParams({
    q: word
  });

  const response = await fetch(`${endpoint}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Youdao request failed: ${response.status}`);
  }

  const data = await response.json();
  const meaning = parseYoudaoMeaning(data);
  if (!meaning) {
    throw new Error("Youdao has no translation result.");
  }

  return meaning;
}

function parseYoudaoMeaning(data) {
  const pools = [
    data?.ec?.word?.[0]?.trs,
    data?.simple?.word?.[0]?.trs,
    data?.fanyi?.tran,
    data?.web_trans?.["web-translation"]
  ];
  const texts = [];

  pools.forEach((pool) => collectText(pool, texts));
  const uniqueTexts = [...new Set(texts)];
  const preferred = uniqueTexts.find((text) => /[\u4e00-\u9fff]/.test(text));
  return preferred || "";
}

function collectText(value, result) {
  if (typeof value === "string") {
    const text = value.trim();
    if (text) {
      result.push(text);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, result));
    return;
  }

  if (value && typeof value === "object") {
    Object.values(value).forEach((child) => collectText(child, result));
  }
}

async function fetchChineseMeaningFromGoogle(word) {
  const endpoint = "https://translate.googleapis.com/translate_a/single";
  const params = new URLSearchParams({
    client: "gtx",
    sl: "en",
    tl: "zh-CN",
    dt: "t",
    q: word
  });

  const response = await fetch(`${endpoint}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Translate request failed: ${response.status}`);
  }

  const data = await response.json();
  const translatedText = Array.isArray(data?.[0])
    ? data[0].map((part) => part?.[0]).filter(Boolean).join("")
    : "";

  if (!translatedText) {
    throw new Error("No translation result.");
  }

  return translatedText;
}

async function getSavedWords() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const list = data[STORAGE_KEY];
  return Array.isArray(list) ? list : [];
}

async function getTranslationCache() {
  const data = await chrome.storage.local.get(CACHE_KEY);
  const cache = data[CACHE_KEY];
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return {};
  }
  return cache;
}

function normalizeSelection(selection) {
  const word = selection.trim();
  if (!word) {
    return "";
  }

  const normalized = word.replace(/[“”"'`.,!?;:()\[\]{}<>]/g, "");
  const isSingleWord = /^[A-Za-z][A-Za-z'-]*$/.test(normalized);
  return isSingleWord ? normalized : "";
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon128.png",
    title,
    message
  });
}

async function showMeaningOnScreen(tabId, word, meaning) {
  if (!tabId) {
    notify("释义", `${word}：${meaning}`);
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [word, meaning],
      func: (selectedWord, selectedMeaning) => {
        const id = "word-saver-meaning-toast";
        const old = document.getElementById(id);
        if (old) {
          old.remove();
        }

        const toast = document.createElement("div");
        toast.id = id;
        toast.innerHTML = `<strong>${selectedWord}</strong><div>${selectedMeaning}</div>`;

        let anchorTop = null;
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const rect = selection.getRangeAt(0).getBoundingClientRect();
          if (rect && Number.isFinite(rect.top)) {
            anchorTop = rect.top;
          }
        }

        Object.assign(toast.style, {
          position: "fixed",
          right: "20px",
          bottom: "20px",
          zIndex: "2147483647",
          maxWidth: "520px",
          minWidth: "320px",
          padding: "16px 18px",
          borderRadius: "12px",
          background: "rgba(255, 252, 242, 0.98)",
          color: "#1f2937",
          border: "1px solid #f0d9aa",
          fontSize: "16px",
          lineHeight: "1.6",
          boxShadow: "0 10px 28px rgba(34, 37, 41, 0.2)",
          opacity: "0",
          transform: "translateY(8px)",
          transition: "opacity .2s ease, transform .2s ease"
        });

        const title = toast.querySelector("strong");
        if (title) {
          title.style.fontSize = "18px";
          title.style.fontWeight = "700";
        }

        const meaningDiv = toast.querySelector("div");
        if (meaningDiv) {
          meaningDiv.style.marginTop = "8px";
          meaningDiv.style.wordBreak = "break-word";
        }

        document.documentElement.appendChild(toast);
        if (anchorTop !== null) {
          const maxTop = window.innerHeight - toast.offsetHeight - 12;
          const safeTop = Math.min(Math.max(anchorTop, 12), Math.max(12, maxTop));
          toast.style.top = `${safeTop}px`;
          toast.style.bottom = "auto";
        }

        requestAnimationFrame(() => {
          toast.style.opacity = "1";
          toast.style.transform = "translateY(0)";
        });

        setTimeout(() => {
          toast.style.opacity = "0";
          toast.style.transform = "translateY(8px)";
          setTimeout(() => toast.remove(), 250);
        }, 2800);
      }
    });
  } catch (error) {
    console.warn("Render meaning on page failed:", error);
    notify("释义", `${word}：${meaning}`);
  }
}
