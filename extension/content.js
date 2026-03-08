// CRAAP Checker — content.js
// Injected into the active tab to highlight sentences on the live DOM.
// Receives messages from popup.js with sentence-level credibility data.

(() => {
  // Guard against double-injection
  if (window.__craapCheckerInjected) return;
  window.__craapCheckerInjected = true;

  // ——— Tooltip ———
  const tooltip = document.createElement("div");
  tooltip.id = "craap-tooltip";
  document.body.appendChild(tooltip);

  // Allow mouse interaction with tooltip (for TTS button)
  tooltip.addEventListener("mouseleave", () => {
    tooltipLocked = false;
    hideTooltip();
  });
  tooltip.addEventListener("mouseenter", () => {
    tooltipLocked = true;
  });

  let tooltipVisible = false;
  let tooltipLocked = false; // lock tooltip open when speaker is clicked

  const SPEAKER_SVG = `<svg class="craap-tts-btn" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;

  function buildTooltipHTML(score, rationale, suggestedFix) {
    const tier = score >= 70 ? "good" : score >= 40 ? "warn" : "bad";
    let html = `<div class="craap-tip-header"><strong>Credibility: ${score}/100</strong><span class="craap-tts-wrap" data-tts>${SPEAKER_SVG}</span></div>`;
    html += `<div class="craap-tip-rationale">${escapeHtml(rationale)}</div>`;
    if (suggestedFix && score < 40) {
      html += `<div class="craap-tip-fix"><span class="craap-tip-fix-label">\u{1F4A1} Suggested Fix</span>${escapeHtml(suggestedFix)}</div>`;
    }
    return { html, tier };
  }

  function showTooltip(e, score, rationale, suggestedFix) {
    if (tooltipLocked) return;
    const { html, tier } = buildTooltipHTML(score, rationale, suggestedFix);
    tooltip.className = `craap-tooltip craap-tip-${tier}`;
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
    positionTooltip(e);
    tooltipVisible = true;
    bindTTSButton(rationale, suggestedFix);
  }

  function hideTooltip() {
    if (tooltipLocked) return;
    tooltip.style.display = "none";
    tooltipVisible = false;
  }

  function positionTooltip(e) {
    const pad = 12;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    // Prevent overflow off right/bottom edge
    const rect = tooltip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - pad;
    tooltip.style.left = `${x + window.scrollX}px`;
    tooltip.style.top = `${y + window.scrollY}px`;
  }

  document.addEventListener("mousemove", (e) => {
    if (tooltipVisible && !tooltipLocked) positionTooltip(e);
  });

  // ——— TTS (Browser Speech Synthesis) ———
  function bindTTSButton(rationale, suggestedFix) {
    const btn = tooltip.querySelector("[data-tts]");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const fullText = suggestedFix
        ? `${rationale}. Suggested fix: ${suggestedFix}`
        : rationale;
      playTTS(fullText);
    });
  }

  function playTTS(critiqueText) {
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const btn = tooltip.querySelector("[data-tts]");
    if (btn) btn.classList.add("craap-tts-playing");

    const utterance = new SpeechSynthesisUtterance(critiqueText);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onend = () => {
      if (btn) btn.classList.remove("craap-tts-playing");
    };
    utterance.onerror = () => {
      if (btn) btn.classList.remove("craap-tts-playing");
    };

    window.speechSynthesis.speak(utterance);
  }

  // ——— Utilities ———
  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function getColor(score) {
    if (score >= 70) return "craap-hl-green";
    if (score >= 40) return "craap-hl-yellow";
    return "craap-hl-red";
  }

  // ——— Core: walk text nodes and wrap matching sentences ———
  function highlightSentences(sentences) {
    // Remove any previous highlights first
    clearHighlights();

    // Build a list sorted longest-first so longer matches take priority
    const sorted = [...sentences].sort(
      (a, b) => b.sentence.length - a.sentence.length
    );

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          // Skip our own tooltip, script, style, and already-highlighted nodes
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT")
            return NodeFilter.FILTER_REJECT;
          if (parent.closest("#craap-tooltip"))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    // Collect text nodes first (mutating DOM while walking is unsafe)
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const entry of sorted) {
      const needle = entry.sentence;
      if (!needle || needle.length < 8) continue; // skip very short fragments

      for (let i = 0; i < textNodes.length; i++) {
        const node = textNodes[i];
        if (!node.parentNode) continue; // already detached

        const idx = node.textContent.indexOf(needle);
        if (idx === -1) continue;

        // Split the text node: [before][mark][after]
        const before = node.textContent.substring(0, idx);
        const match = node.textContent.substring(idx, idx + needle.length);
        const after = node.textContent.substring(idx + needle.length);

        const mark = document.createElement("mark");
        mark.className = `craap-highlight ${getColor(entry.score)}`;
        mark.dataset.score = entry.score;
        mark.dataset.rationale = entry.rationale || "";
        mark.textContent = match;

        // Add visible fix badge for low-credibility sentences with suggested fixes
        if (entry.suggested_fix && entry.score < 40) {
          mark.classList.add("craap-has-fix");
          const badge = document.createElement("span");
          badge.className = "craap-fix-badge";
          badge.textContent = "\u{1F4A1}";
          badge.title = "Click for suggested fix";
          mark.appendChild(badge);
        }

        // Hover events — show tooltip with rationale + suggested fix
        mark.addEventListener("mouseenter", (e) => {
          showTooltip(
            e,
            entry.score,
            entry.rationale || "No rationale available.",
            entry.suggested_fix || null
          );
        });
        mark.addEventListener("mouseleave", () => {
          // Delay hide so user can move mouse into tooltip for TTS button
          setTimeout(() => {
            if (!tooltipLocked && !tooltip.matches(":hover")) hideTooltip();
          }, 200);
        });

        const parent = node.parentNode;
        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        frag.appendChild(mark);
        if (after) {
          const afterNode = document.createTextNode(after);
          frag.appendChild(afterNode);
          // Replace current node in our list so further matches can find the remainder
          textNodes[i] = afterNode;
        }
        parent.replaceChild(frag, node);

        // Only highlight the first occurrence of each sentence
        break;
      }
    }
  }

  function clearHighlights() {
    document.querySelectorAll("mark.craap-highlight").forEach((mark) => {
      const text = document.createTextNode(mark.textContent);
      mark.parentNode.replaceChild(text, mark);
    });
    // Normalize adjacent text nodes so future searches work
    document.body.normalize();
  }

  // ——— Listen for messages from popup ———
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "CRAAP_HIGHLIGHT") {
      try {
        highlightSentences(msg.sentences || []);
        sendResponse({ success: true, count: (msg.sentences || []).length });
      } catch (err) {
        console.error("[CRAAP Checker] highlight error:", err);
        sendResponse({ success: false, error: err.message });
      }
    } else if (msg.type === "CRAAP_CLEAR") {
      clearHighlights();
      sendResponse({ success: true });
    } else if (msg.type === "CRAAP_SCROLL_TO") {
      try {
        scrollToText(msg.text);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    } else if (msg.type === "CRAAP_CHAT_CALLOUT") {
      try {
        injectChatCallouts(msg.callouts || []);
        sendResponse({ success: true, count: (msg.callouts || []).length });
      } catch (err) {
        console.error("[CRAAP Checker] callout error:", err);
        sendResponse({ success: false, error: err.message });
      }
    }
    return true; // keep channel open for async sendResponse
  });

  // ——— Scroll to text excerpt and flash-highlight it ———
  function normalizeWS(s) {
    return s.replace(/\s+/g, " ").trim();
  }

  // Build the full visible text of the page once for fuzzy matching
  function getBodyText() {
    return document.body.innerText || "";
  }

  // Find the best actual substring in the page that matches the needle,
  // even if whitespace differs or the AI truncated slightly.
  function findBestMatch(needle) {
    const normNeedle = normalizeWS(needle);
    const bodyText = getBodyText();
    const normBody = normalizeWS(bodyText);

    // 1. Try exact normalized match
    let idx = normBody.indexOf(normNeedle);
    if (idx !== -1) return normNeedle;

    // 2. Case-insensitive
    idx = normBody.toLowerCase().indexOf(normNeedle.toLowerCase());
    if (idx !== -1) return normBody.substring(idx, idx + normNeedle.length);

    // 3. Try progressively shorter substrings from the middle
    const words = normNeedle.split(" ");
    for (let len = words.length - 1; len >= Math.min(5, words.length); len--) {
      const sub = words.slice(0, len).join(" ");
      idx = normBody.toLowerCase().indexOf(sub.toLowerCase());
      if (idx !== -1) return normBody.substring(idx, idx + sub.length);
    }

    return null;
  }

  function scrollToText(needle) {
    if (!needle || needle.length < 4) return;

    // First check if it's already in a highlight mark
    const marks = document.querySelectorAll("mark.craap-highlight");
    for (const mark of marks) {
      if (normalizeWS(mark.textContent).toLowerCase().includes(normalizeWS(needle).toLowerCase())) {
        mark.scrollIntoView({ behavior: "smooth", block: "center" });
        flashElement(mark);
        return;
      }
    }

    // Use fuzzy matching to find the best real substring
    const bestMatch = findBestMatch(needle);
    const searchText = bestMatch || needle;

    // Walk text nodes to find and highlight
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT")
            return NodeFilter.FILTER_REJECT;
          if (parent.closest("#craap-tooltip"))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    // Collect all text nodes for potential multi-node spanning
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    // Try single-node match first (fast path)
    for (const node of textNodes) {
      const idx = node.textContent.indexOf(searchText);
      if (idx === -1) continue;
      wrapAndFlash(node, idx, searchText.length);
      return;
    }

    // Case-insensitive single-node fallback
    const lowerSearch = searchText.toLowerCase();
    for (const node of textNodes) {
      const idx = node.textContent.toLowerCase().indexOf(lowerSearch);
      if (idx === -1) continue;
      wrapAndFlash(node, idx, searchText.length);
      return;
    }

    // Multi-node match: build a concatenated view and find the span
    let concat = "";
    const nodeMap = []; // { node, startInConcat, endInConcat }
    for (const node of textNodes) {
      const start = concat.length;
      concat += node.textContent;
      nodeMap.push({ node, start, end: concat.length });
    }

    let matchIdx = concat.indexOf(searchText);
    if (matchIdx === -1) matchIdx = concat.toLowerCase().indexOf(lowerSearch);
    if (matchIdx === -1) return; // truly not found

    const matchEnd = matchIdx + searchText.length;

    // Find the first node that contains the start of the match — scroll to it
    for (const entry of nodeMap) {
      if (entry.end > matchIdx) {
        // This node contains the start of the match
        const localIdx = matchIdx - entry.start;
        const localLen = Math.min(entry.end - matchIdx, searchText.length);
        wrapAndFlash(entry.node, localIdx, localLen);
        return;
      }
    }
  }

  function wrapAndFlash(node, idx, length) {
    const before = node.textContent.substring(0, idx);
    const match = node.textContent.substring(idx, idx + length);
    const after = node.textContent.substring(idx + length);

    const span = document.createElement("span");
    span.className = "craap-scroll-flash craap-flash-active";
    span.textContent = match;

    const parent = node.parentNode;
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));
    parent.replaceChild(frag, node);

    span.scrollIntoView({ behavior: "smooth", block: "center" });

    // Remove wrapper after animation
    setTimeout(() => {
      const textNode = document.createTextNode(span.textContent);
      if (span.parentNode) {
        span.parentNode.replaceChild(textNode, span);
        textNode.parentNode.normalize();
      }
    }, 4500);
  }

  function flashElement(el) {
    el.classList.add("craap-flash-active");
    setTimeout(() => el.classList.remove("craap-flash-active"), 2000);
  }

  // ——— Chat Callouts: Persistent annotated highlights ———
  function injectChatCallouts(callouts) {
    // Clear previous chat callouts
    document.querySelectorAll("mark.craap-callout").forEach((mark) => {
      const text = document.createTextNode(mark.textContent.replace(/\s*\[.*?\]\s*$/, ""));
      mark.parentNode.replaceChild(text, mark);
    });
    document.body.normalize();

    if (!callouts || callouts.length === 0) return;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT")
            return NodeFilter.FILTER_REJECT;
          if (parent.closest("#craap-tooltip"))
            return NodeFilter.FILTER_REJECT;
          // Don't annotate existing highlights
          if (parent.closest("mark.craap-highlight, mark.craap-callout"))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    // Sort callouts by excerpt length (longest first)
    const sorted = [...callouts].sort(
      (a, b) => (b.excerpt || "").length - (a.excerpt || "").length
    );

    for (const callout of sorted) {
      const needle = (callout.excerpt || "").trim();
      if (!needle || needle.length < 8) continue;

      const label = callout.label || "Note";
      const note = callout.note || "";

      for (let i = 0; i < textNodes.length; i++) {
        const node = textNodes[i];
        if (!node.parentNode) continue;

        const idx = node.textContent.indexOf(needle);
        if (idx === -1) continue;

        const before = node.textContent.substring(0, idx);
        const match = node.textContent.substring(idx, idx + needle.length);
        const after = node.textContent.substring(idx + needle.length);

        const mark = document.createElement("mark");
        mark.className = "craap-callout";
        mark.dataset.label = label;
        mark.dataset.note = note;
        mark.textContent = match;

        // Add badge
        const badge = document.createElement("span");
        badge.className = "craap-callout-badge";
        badge.textContent = `[${label}]`;
        mark.appendChild(badge);

        // Hover tooltip for note
        if (note) {
          mark.addEventListener("mouseenter", (e) => {
            showCalloutTooltip(e, label, note);
          });
          mark.addEventListener("mouseleave", () => {
            hideCalloutTooltip();
          });
        }

        const parent = node.parentNode;
        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        frag.appendChild(mark);
        if (after) {
          const afterNode = document.createTextNode(after);
          frag.appendChild(afterNode);
          textNodes[i] = afterNode;
        }
        parent.replaceChild(frag, node);

        // Scroll to first callout
        if (callout === sorted[0]) {
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
          flashElement(mark);
        }

        break; // Only highlight first occurrence
      }
    }
  }

  // Simple callout tooltip (different from main tooltip)
  let calloutTooltip = null;

  function showCalloutTooltip(e, label, note) {
    if (!calloutTooltip) {
      calloutTooltip = document.createElement("div");
      calloutTooltip.id = "craap-callout-tooltip";
      document.body.appendChild(calloutTooltip);
    }

    calloutTooltip.innerHTML = `<div class="craap-callout-tip-label">${escapeHtml(label)}</div><div class="craap-callout-tip-note">${escapeHtml(note)}</div>`;
    calloutTooltip.style.display = "block";

    const pad = 12;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const rect = calloutTooltip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - pad;
    calloutTooltip.style.left = `${x + window.scrollX}px`;
    calloutTooltip.style.top = `${y + window.scrollY}px`;
  }

  function hideCalloutTooltip() {
    if (calloutTooltip) {
      calloutTooltip.style.display = "none";
    }
  }
})();
