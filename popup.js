const STORAGE_KEY = "savedWords";
const UI_MODE_KEY = "uiMode";
const MAIN_MODE_MEMORY = "memory";
const MAIN_MODE_RECITE = "recite";
const RECITE_VIEW_WORD = "word";
const RECITE_VIEW_MEANING = "meaning";
const DEFAULT_UI_MODE = {
  main: MAIN_MODE_MEMORY,
  reciteView: RECITE_VIEW_WORD
};

const wordList = document.getElementById("wordList");
const countEl = document.getElementById("count");
const emptyEl = document.getElementById("empty");
const searchInput = document.getElementById("searchInput");
const clearBtn = document.getElementById("clearBtn");
const template = document.getElementById("wordItemTemplate");
const modeMemoryBtn = document.getElementById("modeMemoryBtn");
const modeReciteBtn = document.getElementById("modeReciteBtn");
const reciteWordBtn = document.getElementById("reciteWordBtn");
const reciteMeaningBtn = document.getElementById("reciteMeaningBtn");
const reciteSubModes = document.getElementById("reciteSubModes");
const pager = document.getElementById("pager");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const pageInfo = document.getElementById("pageInfo");

let cache = [];
let uiMode = { ...DEFAULT_UI_MODE };
let reciteOrderKeys = [];
let revealedKeys = new Set();
let currentPage = 1;

async function init() {
  const [savedWords, savedUiMode] = await Promise.all([getSavedWords(), getUiMode()]);
  cache = savedWords;
  uiMode = savedUiMode;
  if (uiMode.main === MAIN_MODE_RECITE) {
    startReciteRound();
  }
  syncModeControls();
  renderCurrentList({ resetPage: true });
}

searchInput.addEventListener("input", () => {
  renderCurrentList({ resetPage: true });
});

clearBtn.addEventListener("click", async () => {
  if (!cache.length) {
    return;
  }

  const ok = confirm("确定清空全部单词吗？");
  if (!ok) {
    return;
  }

  cache = [];
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  startReciteRound();
  renderCurrentList({ resetPage: true });
});

modeMemoryBtn.addEventListener("click", async () => {
  uiMode.main = MAIN_MODE_MEMORY;
  revealedKeys.clear();
  await saveUiMode();
  syncModeControls();
  renderCurrentList({ resetPage: true });
});

modeReciteBtn.addEventListener("click", async () => {
  uiMode.main = MAIN_MODE_RECITE;
  startReciteRound();
  await saveUiMode();
  syncModeControls();
  renderCurrentList({ resetPage: true });
});

reciteWordBtn.addEventListener("click", async () => {
  uiMode.main = MAIN_MODE_RECITE;
  uiMode.reciteView = RECITE_VIEW_WORD;
  revealedKeys.clear();
  if (!reciteOrderKeys.length) {
    startReciteRound();
  }
  await saveUiMode();
  syncModeControls();
  renderCurrentList({ resetPage: true });
});

reciteMeaningBtn.addEventListener("click", async () => {
  uiMode.main = MAIN_MODE_RECITE;
  uiMode.reciteView = RECITE_VIEW_MEANING;
  revealedKeys.clear();
  if (!reciteOrderKeys.length) {
    startReciteRound();
  }
  await saveUiMode();
  syncModeControls();
  renderCurrentList({ resetPage: true });
});

prevPageBtn.addEventListener("click", () => {
  if (currentPage <= 1) {
    return;
  }
  currentPage -= 1;
  renderCurrentList();
});

nextPageBtn.addEventListener("click", () => {
  currentPage += 1;
  renderCurrentList();
});

window.addEventListener("resize", () => {
  renderCurrentList({ resetPage: true });
});

function render(list, totalCount) {
  wordList.innerHTML = "";
  countEl.textContent = `已保存 ${cache.length} 个单词`;
  emptyEl.style.display = totalCount ? "none" : "block";

  list.forEach((item) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const itemKey = normalizeWordKey(item.word);
    const wordEl = node.querySelector(".word");
    const meaningEl = node.querySelector(".meaning");
    const revealBtn = node.querySelector(".reveal");
    wordEl.textContent = item.word;
    meaningEl.textContent = item.meaning;
    applyItemModeClass(node, itemKey);
    bindRevealAction(revealBtn, itemKey);

    node.querySelector(".delete").addEventListener("click", async () => {
      cache = cache.filter((entry) => normalizeWordKey(entry.word) !== itemKey);
      revealedKeys.delete(itemKey);
      await chrome.storage.local.set({ [STORAGE_KEY]: cache });
      if (uiMode.main === MAIN_MODE_RECITE) {
        startReciteRound();
      }
      renderCurrentList();
    });

    wordList.appendChild(node);
  });
}

function applyItemModeClass(node, itemKey) {
  node.classList.remove("mode-memory", "mode-recite-word", "mode-recite-meaning", "is-revealed");
  if (uiMode.main === MAIN_MODE_MEMORY) {
    node.classList.add("mode-memory");
    return;
  }
  if (revealedKeys.has(itemKey)) {
    node.classList.add("is-revealed");
  }
  if (uiMode.reciteView === RECITE_VIEW_MEANING) {
    node.classList.add("mode-recite-meaning");
    return;
  }
  node.classList.add("mode-recite-word");
}

function bindRevealAction(button, itemKey) {
  if (uiMode.main !== MAIN_MODE_RECITE) {
    button.hidden = true;
    button.classList.remove("is-active");
    return;
  }

  button.hidden = false;
  const isRevealed = revealedKeys.has(itemKey);
  if (uiMode.reciteView === RECITE_VIEW_WORD) {
    button.title = isRevealed ? "隐藏释义" : "显示释义";
    button.setAttribute("aria-label", button.title);
  } else {
    button.title = isRevealed ? "隐藏单词" : "显示单词";
    button.setAttribute("aria-label", button.title);
  }
  button.classList.toggle("is-active", isRevealed);

  button.addEventListener("click", () => {
    if (revealedKeys.has(itemKey)) {
      revealedKeys.delete(itemKey);
    } else {
      revealedKeys.add(itemKey);
    }
    renderCurrentList();
  });
}

function syncModeControls() {
  modeMemoryBtn.classList.toggle("is-active", uiMode.main === MAIN_MODE_MEMORY);
  modeReciteBtn.classList.toggle("is-active", uiMode.main === MAIN_MODE_RECITE);
  reciteWordBtn.classList.toggle("is-active", uiMode.reciteView === RECITE_VIEW_WORD);
  reciteMeaningBtn.classList.toggle("is-active", uiMode.reciteView === RECITE_VIEW_MEANING);
  reciteSubModes.hidden = uiMode.main !== MAIN_MODE_RECITE;
}

function getFilteredList() {
  const baseList = uiMode.main === MAIN_MODE_RECITE ? getReciteOrderedList() : cache;
  const keyword = searchInput.value.trim().toLowerCase();
  if (!keyword) {
    return baseList;
  }
  return baseList.filter((item) => {
    const word = String(item.word || "").toLowerCase();
    const meaning = String(item.meaning || "").toLowerCase();
    return word.includes(keyword) || meaning.includes(keyword);
  });
}

function renderCurrentList(options = {}) {
  const resetPage = Boolean(options.resetPage);
  const filtered = getFilteredList();
  const itemsPerPage = calculateItemsPerPage();
  const totalPages = Math.max(1, Math.ceil(filtered.length / itemsPerPage));

  if (resetPage) {
    currentPage = 1;
  }
  currentPage = Math.min(Math.max(currentPage, 1), totalPages);

  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentItems = filtered.slice(startIndex, startIndex + itemsPerPage);
  render(currentItems, filtered.length);
  renderPager(filtered.length, totalPages);
}

function renderPager(totalCount, totalPages) {
  pager.hidden = totalCount === 0 || totalPages <= 1;
  pageInfo.textContent = `${currentPage} / ${totalPages}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;
}

function calculateItemsPerPage() {
  const listHeight = wordList.clientHeight;
  if (!listHeight) {
    return 1;
  }

  const probe = template.content.firstElementChild.cloneNode(true);
  probe.querySelector(".word").textContent = "configuration";
  probe.querySelector(".meaning").textContent = "配置；结构；安排";
  applyItemModeClass(probe, "__probe__");
  if (uiMode.main === MAIN_MODE_RECITE) {
    probe.classList.add("is-revealed");
  }

  const revealBtn = probe.querySelector(".reveal");
  revealBtn.hidden = uiMode.main !== MAIN_MODE_RECITE;

  probe.style.visibility = "hidden";
  probe.style.position = "absolute";
  probe.style.pointerEvents = "none";
  wordList.appendChild(probe);

  const itemHeight = probe.getBoundingClientRect().height || 66;
  probe.remove();

  const styles = getComputedStyle(wordList);
  const gap = Number.parseFloat(styles.rowGap || styles.gap || "8") || 8;
  return Math.max(1, Math.floor((listHeight + gap) / (itemHeight + gap)));
}

async function getSavedWords() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const list = data[STORAGE_KEY];
  return Array.isArray(list) ? list : [];
}

async function getUiMode() {
  const data = await chrome.storage.local.get(UI_MODE_KEY);
  const value = data[UI_MODE_KEY];
  const main = value?.main === MAIN_MODE_RECITE ? MAIN_MODE_RECITE : MAIN_MODE_MEMORY;
  const reciteView = value?.reciteView === RECITE_VIEW_MEANING ? RECITE_VIEW_MEANING : RECITE_VIEW_WORD;
  return { main, reciteView };
}

async function saveUiMode() {
  await chrome.storage.local.set({ [UI_MODE_KEY]: uiMode });
}

function getReciteOrderedList() {
  if (!reciteOrderKeys.length) {
    startReciteRound();
  }

  const itemByKey = new Map();
  cache.forEach((item) => {
    itemByKey.set(normalizeWordKey(item.word), item);
  });

  const ordered = [];
  reciteOrderKeys.forEach((key) => {
    const item = itemByKey.get(key);
    if (item) {
      ordered.push(item);
      itemByKey.delete(key);
    }
  });

  if (itemByKey.size > 0) {
    const rest = shuffledCopy(Array.from(itemByKey.values()));
    rest.forEach((item) => {
      reciteOrderKeys.push(normalizeWordKey(item.word));
    });
    ordered.push(...rest);
  }

  return ordered;
}

function startReciteRound() {
  reciteOrderKeys = shuffledCopy(cache.map((item) => normalizeWordKey(item.word)));
  revealedKeys.clear();
}

function normalizeWordKey(word) {
  return String(word || "").trim().toLowerCase();
}

function shuffledCopy(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

init();
