const STORAGE_KEY = "savedWords";
const UI_MODE_KEY = "uiMode";
const SYNC_WORD_PREFIX = "savedWord::";
const SYNC_MAX_ITEM_BYTES = 7600;
const MAX_WORD_LEN = 128;
const MAX_MEANING_LEN = 1500;
const MAX_PAGE_URL_LEN = 1024;
const MAIN_MODE_MEMORY = "memory";
const MAIN_MODE_RECITE = "recite";
const RECITE_VIEW_WORD = "word";
const RECITE_VIEW_MEANING = "meaning";
const ITEMS_PER_PAGE = 10;
const PART_CARD = "card";
const PART_REVEAL = "reveal";
const PART_DELETE = "delete";
const PAGER_PREV = "prev";
const PAGER_NEXT = "next";
const TOP_SEARCH = "search";
const TOP_CLEAR = "clear";
const TOP_MODE_MEMORY = "mode_memory";
const TOP_MODE_RECITE = "mode_recite";
const TOP_RECITE_WORD = "recite_word";
const TOP_RECITE_MEANING = "recite_meaning";

const DEFAULT_UI_MODE = {
  main: MAIN_MODE_MEMORY,
  reciteView: RECITE_VIEW_WORD
};

const wordList = document.getElementById("wordList");
const countEl = document.getElementById("count");
const emptyEl = document.getElementById("empty");
const searchInput = document.getElementById("searchInput");
const searchPanel = document.getElementById("searchPanel");
const searchToggleBtn = document.getElementById("searchToggleBtn");
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
let currentPageItems = [];
let currentTotalPages = 1;
let selection = null;

async function init() {
  const [savedWords, savedUiMode] = await Promise.all([getSavedWords(), getUiMode()]);
  cache = savedWords;
  uiMode = savedUiMode;
  if (uiMode.main === MAIN_MODE_RECITE) {
    startReciteRound();
  }
  syncModeControls();
  bindEvents();
  renderCurrentList({ resetPage: true });
}

function bindEvents() {
  searchInput.addEventListener("input", () => {
    renderCurrentList({ resetPage: true, preferredSelection: selection });
  });

  searchToggleBtn.addEventListener("click", () => {
    setSelection({ type: "top", id: TOP_SEARCH });
    const willOpen = searchPanel.hidden;
    searchPanel.hidden = !willOpen;
    searchToggleBtn.classList.toggle("is-active", willOpen);
    if (willOpen) {
      searchInput.focus();
      return;
    }

    if (searchInput.value.trim()) {
      searchInput.value = "";
      renderCurrentList({ resetPage: true, preferredSelection: { type: "top", id: TOP_SEARCH } });
    }
  });

  clearBtn.addEventListener("click", async () => {
    setSelection({ type: "top", id: TOP_CLEAR });
    if (!cache.length) {
      return;
    }

    const ok = confirm("确定清空全部单词吗？");
    if (!ok) {
      return;
    }

    const deletedWords = cache.map((item) => item.word);
    cache = [];
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
    await markWordsDeletedInSync(deletedWords);
    startReciteRound();
    renderCurrentList({ resetPage: true, preferredSelection: { type: "top", id: TOP_CLEAR } });
  });

  modeMemoryBtn.addEventListener("click", async () => {
    setSelection({ type: "top", id: TOP_MODE_MEMORY });
    uiMode.main = MAIN_MODE_MEMORY;
    revealedKeys.clear();
    await saveUiMode();
    syncModeControls();
    renderCurrentList({ resetPage: true, preferredSelection: { type: "top", id: TOP_MODE_MEMORY } });
  });

  modeReciteBtn.addEventListener("click", async () => {
    setSelection({ type: "top", id: TOP_MODE_RECITE });
    uiMode.main = MAIN_MODE_RECITE;
    startReciteRound();
    await saveUiMode();
    syncModeControls();
    renderCurrentList({ resetPage: true, preferredSelection: { type: "top", id: TOP_MODE_RECITE } });
  });

  reciteWordBtn.addEventListener("click", async () => {
    setSelection({ type: "top", id: TOP_RECITE_WORD });
    uiMode.main = MAIN_MODE_RECITE;
    uiMode.reciteView = RECITE_VIEW_WORD;
    revealedKeys.clear();
    if (!reciteOrderKeys.length) {
      startReciteRound();
    }
    await saveUiMode();
    syncModeControls();
    renderCurrentList({ resetPage: true, preferredSelection: { type: "top", id: TOP_RECITE_WORD } });
  });

  reciteMeaningBtn.addEventListener("click", async () => {
    setSelection({ type: "top", id: TOP_RECITE_MEANING });
    uiMode.main = MAIN_MODE_RECITE;
    uiMode.reciteView = RECITE_VIEW_MEANING;
    revealedKeys.clear();
    if (!reciteOrderKeys.length) {
      startReciteRound();
    }
    await saveUiMode();
    syncModeControls();
    renderCurrentList({ resetPage: true, preferredSelection: { type: "top", id: TOP_RECITE_MEANING } });
  });

  prevPageBtn.addEventListener("click", () => {
    setSelection({ type: "pager", part: PAGER_PREV });
    if (currentPage <= 1) {
      return;
    }
    currentPage -= 1;
    renderCurrentList({ preferredSelection: { type: "pager", part: PAGER_PREV } });
  });

  nextPageBtn.addEventListener("click", () => {
    setSelection({ type: "pager", part: PAGER_NEXT });
    if (currentPage >= currentTotalPages) {
      return;
    }
    currentPage += 1;
    renderCurrentList({ preferredSelection: { type: "pager", part: PAGER_NEXT } });
  });

  document.addEventListener("keydown", handleKeyboardNavigation);
}

function handleKeyboardNavigation(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }

  const target = event.target;
  if (target instanceof HTMLElement) {
    const tag = target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || target.isContentEditable) {
      return;
    }
  }

  if (event.key === "ArrowDown") {
    if (moveSelectionVertical(1)) {
      event.preventDefault();
    }
    return;
  }

  if (event.key === "ArrowUp") {
    if (moveSelectionVertical(-1)) {
      event.preventDefault();
    }
    return;
  }

  if (event.key === "ArrowRight") {
    if (moveSelectionHorizontal(1)) {
      event.preventDefault();
    }
    return;
  }

  if (event.key === "ArrowLeft") {
    if (moveSelectionHorizontal(-1)) {
      event.preventDefault();
    }
    return;
  }

  if (event.key === "Enter") {
    if (handleEnterAction()) {
      event.preventDefault();
    }
  }
}

function moveSelectionVertical(step) {
  if (!selection) {
    const firstTop = getFirstTopSelection();
    if (firstTop) {
      setSelection(firstTop);
      return true;
    }
    if (!currentPageItems.length) {
      if (!pager.hidden) {
        setSelection({ type: "pager", part: PAGER_NEXT });
        return true;
      }
      return false;
    }
    setSelection({ type: "item", itemKey: currentPageItems[0], part: PART_CARD });
    return true;
  }

  if (selection.type === "top") {
    const topRows = getTopControlRows();
    const pos = findTopPosition(selection.id, topRows);
    if (!pos) {
      return false;
    }

    const targetRowIndex = pos.row + step;
    if (targetRowIndex >= 0 && targetRowIndex < topRows.length) {
      const targetRow = topRows[targetRowIndex];
      const targetCol = Math.min(pos.col, targetRow.length - 1);
      setSelection({ type: "top", id: targetRow[targetCol] });
      return true;
    }

    if (step > 0) {
      if (currentPageItems.length) {
        setSelection({ type: "item", itemKey: currentPageItems[0], part: PART_CARD });
        return true;
      }
      if (!pager.hidden) {
        setSelection({ type: "pager", part: PAGER_NEXT });
        return true;
      }
    }
    return false;
  }

  if (selection.type === "item") {
    const index = currentPageItems.indexOf(selection.itemKey);
    if (index < 0) {
      return false;
    }

    const nextIndex = index + step;
    if (nextIndex >= 0 && nextIndex < currentPageItems.length) {
      setSelection({ type: "item", itemKey: currentPageItems[nextIndex], part: selection.part });
      return true;
    }

    if (step > 0 && !pager.hidden) {
      setSelection({ type: "pager", part: PAGER_NEXT });
      return true;
    }

    if (step < 0) {
      const topSelection = getLastTopSelectionForItemPart(selection.part);
      if (topSelection) {
        setSelection(topSelection);
        return true;
      }
      if (!pager.hidden) {
        setSelection({ type: "pager", part: PAGER_PREV });
        return true;
      }
    }

    return false;
  }

  if (selection.type === "pager" && step < 0) {
    if (currentPageItems.length) {
      setSelection({ type: "item", itemKey: currentPageItems[currentPageItems.length - 1], part: PART_CARD });
      return true;
    }
    const topRows = getTopControlRows();
    if (topRows.length) {
      const lastRow = topRows[topRows.length - 1];
      setSelection({ type: "top", id: lastRow[Math.min(1, lastRow.length - 1)] });
      return true;
    }
  }

  return false;
}

function moveSelectionHorizontal(step) {
  if (!selection) {
    const firstTop = getFirstTopSelection();
    if (firstTop) {
      setSelection(firstTop);
      return true;
    }
    if (currentPageItems.length) {
      setSelection({ type: "item", itemKey: currentPageItems[0], part: PART_CARD });
      return true;
    }
    return false;
  }

  if (selection.type === "top") {
    const topRows = getTopControlRows();
    const pos = findTopPosition(selection.id, topRows);
    if (!pos) {
      return false;
    }
    const targetCol = pos.col + step;
    if (targetCol < 0 || targetCol >= topRows[pos.row].length) {
      return false;
    }
    setSelection({ type: "top", id: topRows[pos.row][targetCol] });
    return true;
  }

  if (selection.type === "pager") {
    const nextPart = step > 0 ? PAGER_NEXT : PAGER_PREV;
    if (selection.part === nextPart) {
      return false;
    }
    setSelection({ type: "pager", part: nextPart });
    return true;
  }

  if (selection.type !== "item") {
    return false;
  }

  const parts = getAvailableItemParts();
  const currentPart = normalizeItemPart(selection.part);
  const index = parts.indexOf(currentPart);
  const nextIndex = index + step;
  if (nextIndex < 0 || nextIndex >= parts.length) {
    return false;
  }

  setSelection({ type: "item", itemKey: selection.itemKey, part: parts[nextIndex] });
  return true;
}

function handleEnterAction() {
  if (!selection) {
    return false;
  }

  if (selection.type === "top") {
    const button = getTopButtonById(selection.id);
    if (!button) {
      return false;
    }
    button.click();
    return true;
  }

  if (selection.type === "pager") {
    if (selection.part === PAGER_NEXT) {
      if (currentPage < currentTotalPages) {
        currentPage += 1;
        renderCurrentList({ preferredSelection: { type: "pager", part: PAGER_NEXT } });
      }
      return true;
    }

    if (selection.part === PAGER_PREV) {
      if (currentPage > 1) {
        currentPage -= 1;
        renderCurrentList({ preferredSelection: { type: "pager", part: PAGER_PREV } });
      }
      return true;
    }

    return false;
  }

  if (selection.type !== "item") {
    return false;
  }

  if (selection.part === PART_REVEAL) {
    toggleRevealByKey(selection.itemKey);
    return true;
  }

  if (selection.part === PART_DELETE) {
    void deleteItemByKey(selection.itemKey);
    return true;
  }

  return false;
}

function render(list, totalCount) {
  wordList.innerHTML = "";
  countEl.textContent = `${cache.length}词`;
  emptyEl.style.display = totalCount ? "none" : "block";

  list.forEach((item) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const itemKey = normalizeWordKey(item.word);
    const wordEl = node.querySelector(".word");
    const meaningEl = node.querySelector(".meaning");
    const revealBtn = node.querySelector(".reveal");
    const deleteBtn = node.querySelector(".delete");

    node.dataset.itemKey = itemKey;
    wordEl.textContent = item.word;
    meaningEl.textContent = item.meaning;

    applyItemModeClass(node, itemKey);
    bindRevealButtonState(revealBtn, itemKey);

    node.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".icon-btn")) {
        return;
      }
      setSelection({ type: "item", itemKey, part: PART_CARD });
    });

    revealBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      setSelection({ type: "item", itemKey, part: PART_REVEAL });
      toggleRevealByKey(itemKey);
    });

    deleteBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      setSelection({ type: "item", itemKey, part: PART_DELETE });
      await deleteItemByKey(itemKey);
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

function bindRevealButtonState(button, itemKey) {
  if (uiMode.main !== MAIN_MODE_RECITE) {
    button.hidden = true;
    button.classList.remove("is-active");
    return;
  }

  button.hidden = false;
  const isRevealed = revealedKeys.has(itemKey);
  if (uiMode.reciteView === RECITE_VIEW_WORD) {
    button.title = isRevealed ? "隐藏释义" : "显示释义";
  } else {
    button.title = isRevealed ? "隐藏单词" : "显示单词";
  }
  button.setAttribute("aria-label", button.title);
  button.classList.toggle("is-active", isRevealed);
}

function toggleRevealByKey(itemKey) {
  if (uiMode.main !== MAIN_MODE_RECITE) {
    return;
  }

  if (revealedKeys.has(itemKey)) {
    revealedKeys.delete(itemKey);
  } else {
    revealedKeys.add(itemKey);
  }

  renderCurrentList({ preferredSelection: { type: "item", itemKey, part: PART_REVEAL } });
}

async function deleteItemByKey(itemKey) {
  const fallback = getDeleteFallbackSelection(itemKey);
  const deletedItem = cache.find((entry) => normalizeWordKey(entry.word) === itemKey);
  cache = cache.filter((entry) => normalizeWordKey(entry.word) !== itemKey);
  revealedKeys.delete(itemKey);
  await chrome.storage.local.set({ [STORAGE_KEY]: cache });
  await markWordsDeletedInSync([deletedItem?.word || itemKey]);
  if (uiMode.main === MAIN_MODE_RECITE) {
    startReciteRound();
  }
  renderCurrentList({ preferredSelection: fallback });
}

function getDeleteFallbackSelection(itemKey) {
  const index = currentPageItems.indexOf(itemKey);
  if (index < 0) {
    return null;
  }

  if (index + 1 < currentPageItems.length) {
    return { type: "item", itemKey: currentPageItems[index + 1], part: PART_CARD };
  }

  if (index - 1 >= 0) {
    return { type: "item", itemKey: currentPageItems[index - 1], part: PART_CARD };
  }

  if (!pager.hidden) {
    return { type: "pager", part: nextPageBtn.disabled ? PAGER_PREV : PAGER_NEXT };
  }

  return getFirstTopSelection();
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
  const preferredSelection = options.preferredSelection || null;
  const filtered = getFilteredList();
  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));

  if (resetPage) {
    currentPage = 1;
  }
  currentPage = Math.min(Math.max(currentPage, 1), totalPages);

  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const currentItems = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  currentPageItems = currentItems.map((item) => normalizeWordKey(item.word));
  currentTotalPages = totalPages;

  render(currentItems, filtered.length);
  renderPager(filtered.length, totalPages);
  reconcileSelection(preferredSelection);
  applySelectionStyles();
}

function renderPager(totalCount, totalPages) {
  pager.hidden = totalCount === 0 || totalPages <= 1;
  pageInfo.textContent = `${currentPage} / ${totalPages}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;
}

function reconcileSelection(preferredSelection) {
  if (preferredSelection) {
    selection = normalizeSelection(preferredSelection);
  }

  if (selection?.type === "top" && isTopButtonVisible(selection.id)) {
    return;
  }

  if (!currentPageItems.length) {
    if (!pager.hidden) {
      const defaultPagerPart = nextPageBtn.disabled ? PAGER_PREV : PAGER_NEXT;
      if (selection?.type !== "pager") {
        selection = { type: "pager", part: defaultPagerPart };
      } else {
        selection = { type: "pager", part: selection.part === PAGER_PREV ? PAGER_PREV : PAGER_NEXT };
      }
    } else {
      const topDefault = getFirstTopSelection();
      selection = topDefault || null;
    }
    return;
  }

  if (selection?.type === "item" && currentPageItems.includes(selection.itemKey)) {
    selection = normalizeSelection(selection);
    return;
  }

  if (selection?.type === "pager" && !pager.hidden) {
    selection = normalizeSelection(selection);
    return;
  }

  if (selection?.type === "top") {
    const topDefault = getFirstTopSelection();
    selection = topDefault || null;
    return;
  }

  selection = { type: "item", itemKey: currentPageItems[0], part: PART_CARD };
}

function setSelection(nextSelection) {
  selection = normalizeSelection(nextSelection);
  applySelectionStyles();
}

function normalizeSelection(nextSelection) {
  if (!nextSelection) {
    return null;
  }

  if (nextSelection.type === "top") {
    const id = isTopId(nextSelection.id) ? nextSelection.id : TOP_SEARCH;
    if (isTopButtonVisible(id)) {
      return { type: "top", id };
    }
    const topDefault = getFirstTopSelection();
    return topDefault || null;
  }

  if (nextSelection.type === "pager") {
    return {
      type: "pager",
      part: nextSelection.part === PAGER_PREV ? PAGER_PREV : PAGER_NEXT
    };
  }

  return {
    type: "item",
    itemKey: normalizeWordKey(nextSelection.itemKey),
    part: normalizeItemPart(nextSelection.part)
  };
}

function normalizeItemPart(part) {
  const parts = getAvailableItemParts();
  if (parts.includes(part)) {
    return part;
  }
  return PART_CARD;
}

function getAvailableItemParts() {
  const parts = [PART_CARD];
  if (uiMode.main === MAIN_MODE_RECITE) {
    parts.push(PART_REVEAL);
  }
  parts.push(PART_DELETE);
  return parts;
}

function applySelectionStyles() {
  document.querySelectorAll(".item.is-kb-selected").forEach((node) => node.classList.remove("is-kb-selected"));
  document.querySelectorAll(".icon-btn.is-kb-selected").forEach((node) => node.classList.remove("is-kb-selected"));
  document.querySelectorAll(".pager-btn.is-kb-selected").forEach((node) => node.classList.remove("is-kb-selected"));
  document.querySelectorAll(".mode-btn.is-kb-selected").forEach((node) => node.classList.remove("is-kb-selected"));
  document.querySelectorAll(".clear.is-kb-selected").forEach((node) => node.classList.remove("is-kb-selected"));
  document.querySelectorAll(".search-toggle.is-kb-selected").forEach((node) => node.classList.remove("is-kb-selected"));

  if (!selection) {
    return;
  }

  if (selection.type === "top") {
    const topButton = getTopButtonById(selection.id);
    if (topButton) {
      topButton.classList.add("is-kb-selected");
      scrollSelectedIntoView(topButton);
    }
    return;
  }

  if (selection.type === "pager") {
    if (selection.part === PAGER_PREV) {
      prevPageBtn.classList.add("is-kb-selected");
      scrollSelectedIntoView(prevPageBtn);
    } else {
      nextPageBtn.classList.add("is-kb-selected");
      scrollSelectedIntoView(nextPageBtn);
    }
    return;
  }

  const itemNode = getRenderedItemNode(selection.itemKey);
  if (!itemNode) {
    return;
  }

  if (selection.part === PART_CARD) {
    itemNode.classList.add("is-kb-selected");
    scrollSelectedIntoView(itemNode);
    return;
  }

  if (selection.part === PART_REVEAL) {
    const btn = itemNode.querySelector(".reveal");
    if (btn && !btn.hidden) {
      btn.classList.add("is-kb-selected");
      scrollSelectedIntoView(btn);
      return;
    }
    itemNode.classList.add("is-kb-selected");
    scrollSelectedIntoView(itemNode);
    return;
  }

  const deleteBtn = itemNode.querySelector(".delete");
  if (deleteBtn) {
    deleteBtn.classList.add("is-kb-selected");
    scrollSelectedIntoView(deleteBtn);
  } else {
    itemNode.classList.add("is-kb-selected");
    scrollSelectedIntoView(itemNode);
  }
}

function getRenderedItemNode(itemKey) {
  const rows = wordList.querySelectorAll(".item");
  for (const row of rows) {
    if (row.dataset.itemKey === itemKey) {
      return row;
    }
  }
  return null;
}

function scrollSelectedIntoView(element) {
  if (!element || typeof element.scrollIntoView !== "function") {
    return;
  }
  element.scrollIntoView({
    block: "nearest",
    inline: "nearest"
  });
}

function isTopId(id) {
  return [
    TOP_SEARCH,
    TOP_CLEAR,
    TOP_MODE_MEMORY,
    TOP_MODE_RECITE,
    TOP_RECITE_WORD,
    TOP_RECITE_MEANING
  ].includes(id);
}

function getTopButtonById(id) {
  if (id === TOP_SEARCH) {
    return searchToggleBtn;
  }
  if (id === TOP_CLEAR) {
    return clearBtn;
  }
  if (id === TOP_MODE_MEMORY) {
    return modeMemoryBtn;
  }
  if (id === TOP_MODE_RECITE) {
    return modeReciteBtn;
  }
  if (id === TOP_RECITE_WORD) {
    return reciteWordBtn;
  }
  if (id === TOP_RECITE_MEANING) {
    return reciteMeaningBtn;
  }
  return null;
}

function isTopButtonVisible(id) {
  const button = getTopButtonById(id);
  if (!button || button.hidden) {
    return false;
  }
  const styles = window.getComputedStyle(button);
  return styles.display !== "none" && styles.visibility !== "hidden";
}

function getTopControlRows() {
  const rows = [
    [TOP_SEARCH, TOP_CLEAR],
    [TOP_MODE_MEMORY, TOP_MODE_RECITE]
  ];
  if (!reciteSubModes.hidden) {
    rows.push([TOP_RECITE_WORD, TOP_RECITE_MEANING]);
  }
  return rows
    .map((row) => row.filter((id) => isTopButtonVisible(id)))
    .filter((row) => row.length > 0);
}

function getFirstTopSelection() {
  const rows = getTopControlRows();
  if (!rows.length) {
    return null;
  }
  return { type: "top", id: rows[0][0] };
}

function getLastTopSelectionForItemPart(part) {
  const rows = getTopControlRows();
  if (!rows.length) {
    return null;
  }
  const lastRow = rows[rows.length - 1];
  const colHint = part === PART_DELETE || part === PART_REVEAL ? 1 : 0;
  return {
    type: "top",
    id: lastRow[Math.min(colHint, lastRow.length - 1)]
  };
}

function findTopPosition(id, rows) {
  for (let row = 0; row < rows.length; row += 1) {
    const col = rows[row].indexOf(id);
    if (col >= 0) {
      return { row, col };
    }
  }
  return null;
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

async function markWordsDeletedInSync(words) {
  const deleteMap = new Map();
  asWordArray(words).forEach((word) => {
    const rawWord = String(word || "").trim();
    const key = normalizeWordKey(rawWord);
    if (key) {
      deleteMap.set(key, rawWord || key);
    }
  });
  if (!deleteMap.size) {
    return;
  }

  const syncSnapshot = await getSyncSnapshot();
  const entries = syncSnapshot.wordEntries;
  const deletedAt = new Date().toISOString();
  deleteMap.forEach((rawWord, key) => {
    const current = entries.get(key);
    const canonicalWord = current?.word || rawWord || key;
    entries.set(key, buildDeletedSyncEntry(canonicalWord, deletedAt));
  });

  await applySyncWordEntries(entries, syncSnapshot.all);
}

function asWordArray(value) {
  return Array.isArray(value) ? value : [];
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
