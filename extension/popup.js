// CRAAP Checker — popup.js
// Handles tab scraping, backend communication, UI rendering, and tab switching.

const API_ENDPOINT = "http://127.0.0.1:5000/api/analyze";
const API_STREAM_ENDPOINT = "http://127.0.0.1:5000/api/analyze/stream";
const CHAT_ENDPOINT = "http://127.0.0.1:5000/api/chat";
const TAB_STORAGE_KEY = "craap_active_tab";

// ——— DOM References ———
const actionSection   = document.getElementById("action-section");
const loadingSection  = document.getElementById("loading-section");
const resultsSection  = document.getElementById("results-section");
const errorSection    = document.getElementById("error-section");

const analyzeBtn      = document.getElementById("analyze-btn");
const reanalyzeBtn    = document.getElementById("reanalyze-btn");
const retryBtn        = document.getElementById("retry-btn");
const errorMessage    = document.getElementById("error-message");
const ieeeBtn         = document.getElementById("ieee-btn");
const toast           = document.getElementById("toast");
const sourcesSection  = document.getElementById("sources-section");
const sourcesList     = document.getElementById("sources-list");
const walkthroughSection = document.getElementById("walkthrough-section");
const walkthroughList = document.getElementById("walkthrough-list");
const wtPrev          = document.getElementById("wt-prev");
const wtNext          = document.getElementById("wt-next");
const wtCounter       = document.getElementById("wt-counter");
const chatMessages    = document.getElementById("chat-messages");
const chatInput       = document.getElementById("chat-input");
const chatSend        = document.getElementById("chat-send");
const chatSection     = document.getElementById("chat-section");
const researchEmpty   = document.getElementById("research-empty");

// Holds the latest analysis result for IEEE generation
let lastResult = null;
let currentTabId = null;
let scrapedText = "";
let scrapedUrl = "";
let chatHistory = [];

// Walkthrough state
let walkthroughSteps = [];
let chatCallouts = [];
let currentWtStep = 0;

// ——— Section Visibility ———
function showSection(section) {
  [actionSection, loadingSection, resultsSection, errorSection].forEach(
    (s) => s.classList.add("hidden")
  );
  section.classList.remove("hidden");
}

// ——— Score Color Tier ———
function getTier(score) {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "fair";
  if (score >= 20) return "poor";
  return "bad";
}

function getTierLabel(score) {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Fair";
  if (score >= 20) return "Poor";
  return "Unreliable";
}

// ——— Render Results ———
function renderResults(data) {
  lastResult = data;
  const overall = data.overall_score;
  const tier = getTier(overall);

  // Master score ring
  const circumference = 2 * Math.PI * 60; // r=60
  const offset = circumference - (overall / 100) * circumference;
  const ring = document.getElementById("score-ring-fill");
  ring.style.strokeDashoffset = offset;
  ring.classList.add(`ring-${tier}`);

  document.getElementById("master-score").textContent = overall;
  document.getElementById("master-score").className = `score-value score-${tier}`;

  const badge = document.getElementById("score-badge");
  badge.textContent = getTierLabel(overall);
  badge.className = `score-badge badge-${tier}`;

  // Individual metrics
  const metrics = ["currency", "relevance", "authority", "accuracy", "purpose"];
  metrics.forEach((metric) => {
    const score = data[`${metric}_score`];
    const mTier = getTier(score);

    document.getElementById(`${metric}-score`).textContent = score;
    document.getElementById(`${metric}-score`).className = `metric-score score-${mTier}`;

    const bar = document.getElementById(`${metric}-bar`);
    bar.style.width = `${score}%`;
    bar.classList.add(`bar-${mTier}`);

    const rationale = data[`${metric}_rationale`] || "";
    document.getElementById(`${metric}-rationale`).textContent = rationale;
  });

  // Summary
  document.getElementById("summary-rationale").textContent =
    data.summary_rationale || "No summary available.";

  // IEEE Citation button — always available
  ieeeBtn.classList.remove("hidden");

  // Recommended Sources
  renderSources(data.recommended_sources || []);

  // Research Walkthrough
  renderWalkthrough(data.walkthrough || []);

  showSection(resultsSection);
}

// ——— Render Recommended Sources ———
function renderSources(sources) {
  sourcesList.innerHTML = "";
  if (!sources || sources.length === 0) {
    sourcesSection.classList.add("hidden");
    return;
  }

  sources.forEach((src) => {
    const item = document.createElement("div");
    item.className = "source-item";

    const link = document.createElement("a");
    link.className = "source-title";
    link.textContent = src.title || "Untitled Source";
    link.href = src.url || "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const meta = document.createElement("div");
    meta.className = "source-meta";
    const parts = [src.authors, src.source, src.year].filter(Boolean);
    meta.textContent = parts.join(" \u2022 ");

    const rel = document.createElement("div");
    rel.className = "source-relevance";
    rel.textContent = src.relevance || "";

    item.appendChild(link);
    item.appendChild(meta);
    if (src.relevance) item.appendChild(rel);
    sourcesList.appendChild(item);
  });

  sourcesSection.classList.remove("hidden");
  if (researchEmpty) researchEmpty.classList.add("hidden");
}

// ——— Reset UI for re-analysis ———
function resetResults() {
  const ring = document.getElementById("score-ring-fill");
  ring.style.strokeDashoffset = 376.99;
  ring.className = "score-ring-fill";

  ["currency", "relevance", "authority", "accuracy", "purpose"].forEach((m) => {
    const bar = document.getElementById(`${m}-bar`);
    bar.style.width = "0%";
    bar.className = "metric-bar-fill";
    document.getElementById(`${m}-score`).textContent = "—";
    document.getElementById(`${m}-rationale`).textContent = "";
  });

  document.getElementById("master-score").textContent = "0";
  document.getElementById("summary-rationale").textContent = "";
  ieeeBtn.classList.add("hidden");
  sourcesSection.classList.add("hidden");
  sourcesList.innerHTML = "";
  walkthroughSection.classList.add("hidden");
  walkthroughList.innerHTML = "";
  walkthroughSteps = [];
  chatCallouts = [];
  currentWtStep = 0;
  chatHistory = [];
  chatMessages.innerHTML = '<div class="chat-msg chat-bot"><span class="chat-avatar">AI</span><div class="chat-bubble">I\'ve analyzed this article. Ask me anything about its claims, sources, or how to use it in your research!</div></div>';
  lastResult = null;
  if (researchEmpty) researchEmpty.classList.remove("hidden");
}

// ——— IEEE Citation Generator ———
function formatIEEECitation(data, url) {
  const author = data.meta_author || "Unknown Author";
  const title = data.meta_title || "Untitled";
  const siteName = data.meta_site_name || new URL(url).hostname;
  const pubDate = data.meta_date || "n.d.";

  // Format author: "John Smith" → "J. Smith"
  let authorFormatted = author;
  if (author !== "Unknown Author" && author.includes(" ")) {
    const parts = author.trim().split(/\s+/);
    const last = parts.pop();
    const initials = parts.map((p) => p.charAt(0).toUpperCase() + ".").join(" ");
    authorFormatted = `${initials} ${last}`;
  }

  // Accessed date: today
  const now = new Date();
  const months = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec."];
  const accessed = `${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

  // IEEE standard for online sources:
  // [1] A. Author, "Title," Website Name, Date Published. [Online]. Available: URL. [Accessed: Mon. Day, Year].
  return `[1] ${authorFormatted}, \u201C${title},\u201D ${siteName}, ${pubDate}. [Online]. Available: ${url}. [Accessed: ${accessed}].`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.classList.add("toast-show");
  setTimeout(() => {
    toast.classList.remove("toast-show");
    toast.classList.add("hidden");
  }, 2000);
}

async function copyIEEECitation() {
  if (!lastResult) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || "";
  const citation = formatIEEECitation(lastResult, url);

  try {
    await navigator.clipboard.writeText(citation);
    showToast("Copied to clipboard!");
  } catch {
    // Fallback for clipboard API restrictions
    const ta = document.createElement("textarea");
    ta.value = citation;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast("Copied to clipboard!");
  }
}

// ——— Pipeline Step Progress Helpers ———
function resetPipelineSteps() {
  document.querySelectorAll(".pipeline-step").forEach((el) => {
    el.classList.remove("step-active", "step-done");
  });
}

function markStepActive(stepName) {
  const el = document.querySelector(`.pipeline-step[data-step="${stepName}"]`);
  if (el) {
    el.classList.add("step-active");
    el.classList.remove("step-done");
  }
}

function markStepDone(stepName) {
  const el = document.querySelector(`.pipeline-step[data-step="${stepName}"]`);
  if (el) {
    el.classList.remove("step-active");
    el.classList.add("step-done");
  }
}

// ——— Main Analysis Flow ———
async function runAnalysis() {
  resetResults();
  resetPipelineSteps();
  showSection(loadingSection);

  // Immediately mark crawler as active (it starts first)
  markStepActive("crawler");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab.id;

    const [{ result: scraped }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        text: document.body.innerText,
        url: document.URL,
      }),
    });

    // Send text (up to 30k chars) for analysis
    const truncatedText = scraped.text.substring(0, 30000);
    scrapedText = truncatedText;
    scrapedUrl = scraped.url;

    // Use SSE streaming endpoint for live progress
    const response = await fetch(API_STREAM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: truncatedText, url: scraped.url }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `Server returned ${response.status}`);
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalData = null;
    // Track which agents are running (all 4 start after crawler)
    let agentsActivated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete line in buffer

      let eventName = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventName = line.slice(7).trim();
        } else if (line.startsWith("data: ") && eventName) {
          const jsonStr = line.slice(6);
          try {
            const payload = JSON.parse(jsonStr);

            if (eventName === "crawler") {
              markStepDone("crawler");
              // All 4 agents fire in parallel after crawler
              if (!agentsActivated) {
                agentsActivated = true;
                markStepActive("analyzer");
                markStepActive("highlighter");
                markStepActive("researcher");
                markStepActive("guide");
              }
            } else if (eventName === "complete") {
              finalData = payload;
            } else if (eventName === "error") {
              throw new Error(payload.error || "Analysis failed.");
            } else {
              // Agent completed: analyzer, highlighter, researcher, or guide
              markStepDone(eventName);
            }
          } catch (e) {
            if (e.message && !e.message.includes("JSON")) throw e;
            console.warn("SSE parse error:", e);
          }
          eventName = null;
        }
      }
    }

    if (!finalData) {
      throw new Error("Analysis completed but no results received.");
    }

    renderResults(finalData);
    setActiveTab("score");

    // Persist results in background so popup can restore after close
    chrome.runtime.sendMessage({
      type: "CRAAP_SAVE_RESULT",
      tabId: tab.id,
      data: finalData,
      url: scraped.url,
      text: truncatedText,
    });

    // ——— Inject content script & send sentence highlights ———
    if (finalData.sentences && finalData.sentences.length > 0) {
      await injectHighlights(tab.id, finalData.sentences);
    }
  } catch (err) {
    console.error("CRAAP Checker error:", err);
    errorMessage.textContent = err.message || "Failed to analyze this page.";
    showSection(errorSection);
  }
}

// ——— Inject highlights into the active tab ———
async function injectHighlights(tabId, sentences) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    // Small delay to ensure the content script listener is registered
    await new Promise((r) => setTimeout(r, 100));

    chrome.tabs.sendMessage(tabId, {
      type: "CRAAP_HIGHLIGHT",
      sentences: sentences,
    });
  } catch (err) {
    console.warn("Could not inject highlights:", err);
  }
}

// ——— Restore cached results when popup opens ———
async function restoreCachedResults() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab.id;

    const cached = await chrome.runtime.sendMessage({
      type: "CRAAP_GET_RESULT",
      tabId: tab.id,
    });

    if (cached && cached.data) {
      renderResults(cached.data);
      if (cached.text) scrapedText = cached.text;
      if (cached.url) scrapedUrl = cached.url;

      // Restore chat history
      const chatCached = await chrome.runtime.sendMessage({
        type: "CRAAP_GET_CHAT",
        tabId: tab.id,
      });
      if (chatCached && chatCached.history) {
        chatHistory = chatCached.history;
        chatMessages.innerHTML = chatCached.messages;
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    }
  } catch (err) {
    // No cached data — stay on the action section (normal first-visit state)
  }
}

// Auto-restore on popup open
restoreCachedResults();

// ——— Walkthrough Rendering ———
const TYPE_ICONS = {
  thesis: "\u{1F4DD}", evidence: "\u{1F4CA}", methodology: "\u{2699}\uFE0F",
  limitation: "\u26A0\uFE0F", conclusion: "\u{1F3C1}", definition: "\u{1F4D6}",
  context: "\u{1F30D}", caveat: "\u{1F6A9}",
  chat: "\u{1F4AC}", // chat bubble icon for AI callouts
};

function renderWalkthrough(steps) {
  walkthroughList.innerHTML = "";
  walkthroughSteps = steps || [];
  currentWtStep = 0;

  // Merge guide steps and chat callouts
  const allChecks = [...walkthroughSteps];
  
  if (allChecks.length === 0 && chatCallouts.length === 0) {
    walkthroughSection.classList.add("hidden");
    return;
  }

  allChecks.forEach((step, i) => {
    const el = document.createElement("div");
    el.className = `wt-step ${i === 0 ? "wt-step-active" : ""}`;
    el.dataset.index = i;

    const icon = TYPE_ICONS[step.type] || "\u{1F4CC}";
    const typeLabel = (step.type || "context").toString();
    const positionHint = (step.position_hint || "").toString().trim();
    const positionBadge = positionHint
      ? `<span class="wt-step-pos">${escapeHtmlPopup(positionHint)}</span>`
      : "";
    el.innerHTML = `
      <div class="wt-step-header">
        <span class="wt-step-icon">${icon}</span>
        <span class="wt-step-num">Check ${i + 1}</span>
        <span class="wt-step-type">${escapeHtmlPopup(typeLabel)}</span>
        ${positionBadge}
      </div>
      <div class="wt-step-title">• ${escapeHtmlPopup(step.title || `Research Check ${i + 1}`)}</div>
      <div class="wt-step-summary">${escapeHtmlPopup(step.summary || "Useful passage for source evaluation and citation decisions.")}</div>
    `;

    el.addEventListener("click", () => {
      setActiveWtStep(i);
      scrollToExcerpt(step.excerpt);
    });

    walkthroughList.appendChild(el);
  });

  // Render chat callouts with distinct styling
  renderChatCallouts();

  updateWtNav();
  walkthroughSection.classList.remove("hidden");
  if (researchEmpty) researchEmpty.classList.add("hidden");
}

function renderChatCallouts() {
  chatCallouts.forEach((callout, i) => {
    const globalIndex = walkthroughSteps.length + i;
    const el = document.createElement("div");
    el.className = "wt-step wt-step-chat";
    el.dataset.index = globalIndex;

    const icon = TYPE_ICONS.chat;
    el.innerHTML = `
      <div class="wt-step-header">
        <span class="wt-step-icon">${icon}</span>
        <span class="wt-step-num">AI ${i + 1}</span>
        <span class="wt-step-type wt-type-chat">${escapeHtmlPopup(callout.label || "Callout")}</span>
        <span class="wt-step-pos wt-pos-chat">chat</span>
      </div>
      <div class="wt-step-title">• ${escapeHtmlPopup(callout.label || "AI Callout")}</div>
      ${callout.note ? `<div class="wt-step-summary">${escapeHtmlPopup(callout.note)}</div>` : ""}
    `;

    el.addEventListener("click", () => {
      // Deselect all
      walkthroughList.querySelectorAll(".wt-step").forEach(s => s.classList.remove("wt-step-active"));
      el.classList.add("wt-step-active");
      scrollToExcerpt(callout.excerpt);
    });

    walkthroughList.appendChild(el);
  });
}

function addChatCallouts(callouts) {
  if (!callouts || !Array.isArray(callouts) || callouts.length === 0) return;
  
  // Add new callouts to the array
  chatCallouts.push(...callouts);
  
  // Re-render the entire walkthrough board
  if (walkthroughSteps.length > 0 || chatCallouts.length > 0) {
    renderWalkthrough(walkthroughSteps);
  }
}

function setActiveWtStep(index) {
  currentWtStep = index;
  walkthroughList.querySelectorAll(".wt-step").forEach((el, i) => {
    el.classList.toggle("wt-step-active", i === index);
  });
  updateWtNav();
  // Scroll the step into view within the popup
  const active = walkthroughList.querySelector(".wt-step-active");
  if (active) active.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function updateWtNav() {
  wtCounter.textContent = `${currentWtStep + 1} / ${walkthroughSteps.length}`;
  wtPrev.disabled = currentWtStep === 0;
  wtNext.disabled = currentWtStep >= walkthroughSteps.length - 1;
}

function scrollToExcerpt(excerpt) {
  if (!excerpt || !currentTabId) return;
  chrome.tabs.sendMessage(currentTabId, {
    type: "CRAAP_SCROLL_TO",
    text: excerpt,
  });
}

// ——— Mini Chatbox ———
function addChatMessage(role, text) {
  const msg = document.createElement("div");
  msg.className = `chat-msg chat-${role}`;
  const avatar = role === "bot" ? "AI" : "You";
  msg.innerHTML = `<span class="chat-avatar">${avatar}</span><div class="chat-bubble">${escapeHtmlPopup(text)}</div>`;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function persistChat() {
  if (!currentTabId) return;
  chrome.runtime.sendMessage({
    type: "CRAAP_SAVE_CHAT",
    tabId: currentTabId,
    history: chatHistory,
    messages: chatMessages.innerHTML,
  }).catch(() => {});
}

async function sendChatMessage() {
  const question = chatInput.value.trim();
  if (!question) return;

  chatInput.value = "";
  addChatMessage("user", question);

  // Show typing indicator
  const typing = document.createElement("div");
  typing.className = "chat-msg chat-bot chat-typing";
  typing.innerHTML = '<span class="chat-avatar">AI</span><div class="chat-bubble"><span class="typing-dots" aria-label="Typing"><span></span><span></span><span></span></span></div>';
  chatMessages.appendChild(typing);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: scrapedText,
        url: scrapedUrl,
        question: question,
        history: chatHistory,
      }),
    });

    typing.remove();

    if (!response.ok) throw new Error("Chat request failed");

    const data = await response.json();
    const answer = data.answer || "I couldn't find an answer to that.";

    addChatMessage("bot", answer);
    chatHistory.push({ role: "user", text: question });
    chatHistory.push({ role: "model", text: answer });
    persistChat();

    // Scroll to referenced text on the page if provided
    if (data.scroll_to && currentTabId) {
      scrollToExcerpt(data.scroll_to);
      // Show a scroll indicator in the chat
      const indicator = document.createElement("div");
      indicator.className = "chat-msg chat-bot chat-scroll-indicator";
      indicator.innerHTML = '<span class="chat-avatar">\u2192</span><div class="chat-bubble chat-scroll-bubble">Scrolled to the relevant passage on the page</div>';
      chatMessages.appendChild(indicator);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Inject visual callouts/highlights if provided
    if (data.callouts && Array.isArray(data.callouts) && data.callouts.length > 0 && currentTabId) {
      chrome.tabs.sendMessage(currentTabId, {
        type: "CRAAP_CHAT_CALLOUT",
        callouts: data.callouts,
      });
      
      // Add callouts to the research board
      addChatCallouts(data.callouts);
      
      // Show callout indicator in chat
      const calloutIndicator = document.createElement("div");
      calloutIndicator.className = "chat-msg chat-bot chat-scroll-indicator";
      const count = data.callouts.length;
      calloutIndicator.innerHTML = `<span class="chat-avatar">\u{1F4CC}</span><div class="chat-bubble chat-scroll-bubble">Added ${count} callout${count > 1 ? 's' : ''} to Research tab</div>`;
      chatMessages.appendChild(calloutIndicator);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  } catch (err) {
    typing.remove();
    addChatMessage("bot", "Sorry, something went wrong. Please try again.");
  }
}

function escapeHtmlPopup(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

// ——— Tab Switching ———
function setActiveTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("tab-btn-active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-content").forEach((content) => {
    content.classList.toggle("tab-content-active", content.dataset.tabContent === tabName);
  });
  // Persist active tab
  chrome.storage.session.set({ [TAB_STORAGE_KEY]: tabName }).catch(() => {});
}

// Restore persisted tab on popup open
chrome.storage.session.get(TAB_STORAGE_KEY).then((result) => {
  if (result[TAB_STORAGE_KEY]) {
    setActiveTab(result[TAB_STORAGE_KEY]);
  }
}).catch(() => {});

// ——— Event Listeners ———
analyzeBtn.addEventListener("click", runAnalysis);
reanalyzeBtn.addEventListener("click", runAnalysis);
retryBtn.addEventListener("click", runAnalysis);
ieeeBtn.addEventListener("click", copyIEEECitation);

wtPrev.addEventListener("click", () => {
  if (currentWtStep > 0) {
    setActiveWtStep(currentWtStep - 1);
    scrollToExcerpt(walkthroughSteps[currentWtStep].excerpt);
  }
});
wtNext.addEventListener("click", () => {
  if (currentWtStep < walkthroughSteps.length - 1) {
    setActiveWtStep(currentWtStep + 1);
    scrollToExcerpt(walkthroughSteps[currentWtStep].excerpt);
  }
});

chatSend.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});

// Tab bar clicks
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
});
