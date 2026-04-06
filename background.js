const MENU_ID = "save-selected-word";
const STORAGE_KEY = "savedWords";
const CACHE_KEY = "translationCache";
const SYNC_WORD_PREFIX = "savedWord::";
const SYNC_MAX_ITEM_BYTES = 7600;
const MAX_WORD_LEN = 128;
const MAX_MEANING_LEN = 1500;
const MAX_PAGE_URL_LEN = 1024;

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

    await setSavedWords(next);
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
  const localData = await chrome.storage.local.get(STORAGE_KEY);
  const localList = mergeWordLists(asWordArray(localData[STORAGE_KEY]), []);
  const localMap = new Map(localList.map((item) => [normalizeWordKey(item.word), item]));

  const syncSnapshot = await getSyncSnapshot();
  const syncEntries = syncSnapshot.wordEntries;

  const conflictKeys = [];
  syncEntries.forEach((entry, key) => {
    if (entry.deleted && localMap.has(key)) {
      conflictKeys.push(key);
    }
  });

  conflictKeys.forEach((key) => {
    localMap.delete(key);
    syncEntries.delete(key);
  });

  const mergedMap = new Map(localMap);
  syncEntries.forEach((entry, key) => {
    if (entry.deleted) {
      return;
    }
    const nextItem = syncEntryToWordItem(entry);
    const currentItem = mergedMap.get(key);
    mergedMap.set(key, currentItem ? mergeWordItem(currentItem, nextItem) : nextItem);
  });

  const merged = sortWordList(Array.from(mergedMap.values()));
  const localAfterConflict = sortWordList(Array.from(localMap.values()));
  if (!isSameWordList(localAfterConflict, merged)) {
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  }

  const desiredSyncEntries = new Map();
  merged.forEach((item) => {
    desiredSyncEntries.set(normalizeWordKey(item.word), buildActiveSyncEntry(item));
  });
  syncEntries.forEach((entry, key) => {
    if (entry.deleted && !mergedMap.has(key)) {
      desiredSyncEntries.set(key, buildDeletedSyncEntry(entry.word, entry.deletedAt));
    }
  });

  await applySyncWordEntries(desiredSyncEntries, syncSnapshot.all);
  return merged;
}

async function setSavedWords(list) {
  const merged = mergeWordLists(asWordArray(list), []);
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });

  const syncSnapshot = await getSyncSnapshot();
  const desiredSyncEntries = new Map();
  merged.forEach((item) => {
    desiredSyncEntries.set(normalizeWordKey(item.word), buildActiveSyncEntry(item));
  });
  syncSnapshot.wordEntries.forEach((entry, key) => {
    if (entry.deleted && !desiredSyncEntries.has(key)) {
      desiredSyncEntries.set(key, buildDeletedSyncEntry(entry.word, entry.deletedAt));
    }
  });
  await applySyncWordEntries(desiredSyncEntries, syncSnapshot.all);
}

function asWordArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeWordKey(word) {
  return String(word || "").trim().toLowerCase();
}

function normalizeWordItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const word = String(item.word || "").trim().slice(0, MAX_WORD_LEN);
  if (!word) {
    return null;
  }

  const meaning = String(item.meaning || "").trim().slice(0, MAX_MEANING_LEN);
  const pageUrl = String(item.pageUrl || "").trim().slice(0, MAX_PAGE_URL_LEN);
  const createdAt = String(item.createdAt || "").trim() || new Date().toISOString();
  return { word, meaning, pageUrl, createdAt };
}

function mergeWordItem(current, next) {
  if (!current) {
    return next;
  }

  const currentTime = toTime(current.createdAt);
  const nextTime = toTime(next.createdAt);
  const newer = nextTime >= currentTime ? next : current;
  const older = newer === next ? current : next;
  return {
    word: newer.word || older.word,
    meaning: newer.meaning || older.meaning,
    pageUrl: newer.pageUrl || older.pageUrl,
    createdAt: newer.createdAt || older.createdAt || new Date().toISOString()
  };
}

function mergeWordLists(primary, secondary) {
  const map = new Map();
  [...asWordArray(primary), ...asWordArray(secondary)].forEach((item) => {
    const normalized = normalizeWordItem(item);
    if (!normalized) {
      return;
    }
    const key = normalizeWordKey(normalized.word);
    map.set(key, mergeWordItem(map.get(key), normalized));
  });
  return sortWordList(Array.from(map.values()));
}

function sortWordList(list) {
  return [...asWordArray(list)].sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt));
}

function toTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isSameWordList(a, b) {
  return JSON.stringify(asWordArray(a)) === JSON.stringify(asWordArray(b));
}

function buildActiveSyncEntry(item) {
  const normalized = normalizeWordItem(item);
  return normalized ? { ...normalized } : null;
}

function buildDeletedSyncEntry(word, deletedAt) {
  const fallback = String(word || "").trim();
  if (!fallback) {
    return null;
  }
  return {
    word: fallback.slice(0, MAX_WORD_LEN),
    deleted: true,
    deletedAt: String(deletedAt || "").trim() || new Date().toISOString()
  };
}

function normalizeSyncEntry(value, fallbackWord = "") {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybeDeleted = value.deleted === true;
  if (maybeDeleted) {
    const word = String(value.word || fallbackWord || "").trim().slice(0, MAX_WORD_LEN);
    if (!word) {
      return null;
    }
    return buildDeletedSyncEntry(word, value.deletedAt);
  }

  return buildActiveSyncEntry(value);
}

function syncEntryToWordItem(entry) {
  return {
    word: entry.word,
    meaning: entry.meaning || "",
    pageUrl: entry.pageUrl || "",
    createdAt: entry.createdAt || new Date().toISOString()
  };
}

function mergeSyncEntry(current, next) {
  if (!current) {
    return next;
  }
  if (current.deleted && !next.deleted) {
    return current;
  }
  if (!current.deleted && next.deleted) {
    return next;
  }
  if (current.deleted && next.deleted) {
    return toTime(next.deletedAt) >= toTime(current.deletedAt) ? next : current;
  }
  return buildActiveSyncEntry(mergeWordItem(syncEntryToWordItem(current), syncEntryToWordItem(next)));
}

function getSyncWordKey(word) {
  return `${SYNC_WORD_PREFIX}${encodeURIComponent(normalizeWordKey(word))}`;
}

function parseWordFromSyncKey(storageKey) {
  const encoded = String(storageKey || "").slice(SYNC_WORD_PREFIX.length);
  if (!encoded) {
    return "";
  }
  try {
    return decodeURIComponent(encoded);
  } catch (error) {
    return encoded;
  }
}

async function getSyncSnapshot() {
  const all = await safeSyncGet(null);
  const wordEntries = new Map();

  const legacyList = mergeWordLists(asWordArray(all[STORAGE_KEY]), []);
  legacyList.forEach((item) => {
    wordEntries.set(normalizeWordKey(item.word), buildActiveSyncEntry(item));
  });

  Object.entries(all).forEach(([storageKey, value]) => {
    if (!storageKey.startsWith(SYNC_WORD_PREFIX)) {
      return;
    }
    const fallbackWord = parseWordFromSyncKey(storageKey);
    const normalized = normalizeSyncEntry(value, fallbackWord);
    if (!normalized) {
      return;
    }
    const key = normalizeWordKey(normalized.word);
    wordEntries.set(key, mergeSyncEntry(wordEntries.get(key), normalized));
  });

  return { all, wordEntries };
}

async function applySyncWordEntries(wordEntries, allSnapshot) {
  const all = allSnapshot && typeof allSnapshot === "object" ? allSnapshot : {};
  const payload = {};
  wordEntries.forEach((entry, key) => {
    const syncKey = getSyncWordKey(key);
    if (!syncKey || !entry) {
      return;
    }
    if (getStorageEntryBytes(syncKey, entry) > SYNC_MAX_ITEM_BYTES) {
      return;
    }
    payload[syncKey] = entry;
  });

  const desiredKeys = new Set(Object.keys(payload));
  const existingKeys = Object.keys(all).filter((key) => key.startsWith(SYNC_WORD_PREFIX));
  const removeKeys = existingKeys.filter((key) => !desiredKeys.has(key));
  if (STORAGE_KEY in all) {
    removeKeys.push(STORAGE_KEY);
  }
  if (removeKeys.length) {
    await safeSyncRemove(removeKeys);
  }

  for (const [key, value] of Object.entries(payload)) {
    if (JSON.stringify(all[key]) === JSON.stringify(value)) {
      continue;
    }
    await safeSyncSet({ [key]: value }, key);
  }
}

function getStorageEntryBytes(key, value) {
  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify({ [key]: value })).length;
}

async function safeSyncGet(keys) {
  try {
    return await chrome.storage.sync.get(keys);
  } catch (error) {
    console.warn("sync.get failed:", error);
    return {};
  }
}

async function safeSyncSet(payload, label = "") {
  try {
    await chrome.storage.sync.set(payload);
    return true;
  } catch (error) {
    console.warn("sync.set failed:", label || Object.keys(payload)[0] || "", error);
    return false;
  }
}

async function safeSyncRemove(keys) {
  try {
    await chrome.storage.sync.remove(keys);
    return true;
  } catch (error) {
    console.warn("sync.remove failed:", keys, error);
    return false;
  }
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
