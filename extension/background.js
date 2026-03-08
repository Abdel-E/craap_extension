// CRAAP Checker — background.js (Service Worker)
// Persists analysis results per tab so the popup can restore state after closing.

// Store keyed by tabId → { data, url, text, timestamp }
const STORAGE_KEY = "craap_tab_results";
const CHAT_STORAGE_KEY = "craap_tab_chats";

// ——— Save result for a tab ———
async function saveResult(tabId, data, url, text) {
  const store = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY] || {};
  store[tabId] = { data, url, text, timestamp: Date.now() };
  await chrome.storage.session.set({ [STORAGE_KEY]: store });
}

// ——— Retrieve result for a tab ———
async function getResult(tabId) {
  const store = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY] || {};
  return store[tabId] || null;
}

// ——— Save chat history for a tab ———
async function saveChatHistory(tabId, history, messages) {
  const store = (await chrome.storage.session.get(CHAT_STORAGE_KEY))[CHAT_STORAGE_KEY] || {};
  store[tabId] = { history, messages, timestamp: Date.now() };
  await chrome.storage.session.set({ [CHAT_STORAGE_KEY]: store });
}

// ——— Retrieve chat history for a tab ———
async function getChatHistory(tabId) {
  const store = (await chrome.storage.session.get(CHAT_STORAGE_KEY))[CHAT_STORAGE_KEY] || {};
  return store[tabId] || null;
}

// ——— Clear result when tab is closed ———
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const store = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY] || {};
  const chatStore = (await chrome.storage.session.get(CHAT_STORAGE_KEY))[CHAT_STORAGE_KEY] || {};
  let changed = false;
  if (store[tabId]) { delete store[tabId]; changed = true; }
  if (chatStore[tabId]) { delete chatStore[tabId]; changed = true; }
  if (changed) {
    await chrome.storage.session.set({ [STORAGE_KEY]: store, [CHAT_STORAGE_KEY]: chatStore });
  }
});

// ——— Clear result when tab navigates to a new page ———
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url) {
    const store = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY] || {};
    const chatStore = (await chrome.storage.session.get(CHAT_STORAGE_KEY))[CHAT_STORAGE_KEY] || {};
    const cached = store[tabId];
    if (cached && cached.url !== changeInfo.url) {
      delete store[tabId];
      delete chatStore[tabId];
      await chrome.storage.session.set({ [STORAGE_KEY]: store, [CHAT_STORAGE_KEY]: chatStore });
    }
  }
});

// ——— Message handler for popup communication ———
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CRAAP_SAVE_RESULT") {
    saveResult(msg.tabId, msg.data, msg.url, msg.text).then(() => {
      sendResponse({ success: true });
    });
    return true; // async
  }

  if (msg.type === "CRAAP_GET_RESULT") {
    getResult(msg.tabId).then((result) => {
      sendResponse(result);
    });
    return true; // async
  }

  if (msg.type === "CRAAP_SAVE_CHAT") {
    saveChatHistory(msg.tabId, msg.history, msg.messages).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === "CRAAP_GET_CHAT") {
    getChatHistory(msg.tabId).then((result) => {
      sendResponse(result);
    });
    return true;
  }

  if (msg.type === "CRAAP_OPEN_SIDEPANEL") {
    chrome.sidePanel.open({ windowId: msg.windowId }).catch((e) => console.warn("sidePanel.open failed:", e));
    return false;
  }
});
