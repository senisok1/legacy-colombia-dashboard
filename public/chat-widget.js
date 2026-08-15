/**
 * Legacy Colombia website chat widget.
 *
 * Standalone, dependency-free vanilla JS — no build step, no React, no CDN
 * dependencies. Embed on legacycolombia.com with:
 *
 *   <script src="https://crm.legacyestaterentals.com/chat-widget.js" defer></script>
 *
 * It injects a floating "Chat Live" bubble (bottom-right, with an
 * attention-grabbing label pill) that expands into a small chat panel.
 * Visitor messages are sent to the CRM app's public API (different origin
 * from this script, so full URLs are used throughout, not relative paths).
 *
 * If the AI can't confidently answer, the panel asks for the visitor's
 * name, email, and phone, then escalates to Seni over WhatsApp — he can
 * approve/edit/reject the AI's suggested answer right from his own WhatsApp
 * app. Once he does, this script polls for the answer every few seconds and
 * shows it live in the chat if the visitor is still here. If they've left
 * (tab closed, or no answer within ~10 minutes), Seni's answer instead goes
 * out by email and/or WhatsApp text using the contact info collected.
 *
 * State is in-memory only (a plain array + a few variables) — nothing is
 * written to localStorage/sessionStorage/cookies, matching this app's
 * existing convention of not persisting visitor-side state client-side.
 * Reloading the page simply starts a fresh conversation, which is fine for
 * this use case (a pending escalation still resolves server-side either
 * way, it just won't show up live in a reloaded tab).
 */
(function () {
  "use strict";

  var API_BASE = "https://crm.legacyestaterentals.com";
  var CHAT_ENDPOINT = API_BASE + "/api/public/chat-widget";
  var ESCALATE_ENDPOINT = API_BASE + "/api/public/chat-widget/escalate";
  var POLL_ENDPOINT = API_BASE + "/api/public/chat-widget/poll";
  var LEAVE_ENDPOINT = API_BASE + "/api/public/chat-widget/leave";
  var OWNER_NAME = "Seni";

  var POLL_INTERVAL_MS = 4000;
  var POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — matches the server-side fallback window

  // ---- In-memory state ----
  var history = []; // { role: 'user' | 'assistant', content: string }
  var isOpen = false;
  var isSending = false;
  var pendingEscalationQuestion = null; // the visitor question that triggered escalation, if any
  var activeEscalationId = null;
  var pollTimer = null;
  var pollDeadline = 0;

  // ---- Styles (single injected <style> block, no external CSS) ----
  var STYLE_ID = "lc-chat-widget-styles";
  var css = [
    "#lc-chat-launcher{position:fixed;bottom:20px;right:20px;z-index:2147483000;display:flex;",
    "align-items:center;gap:10px;}",
    "#lc-chat-live-badge{background:#1f8a4c;color:#fff;font-family:-apple-system,BlinkMacSystemFont,",
    "'Segoe UI',Roboto,Arial,sans-serif;font-size:12.5px;font-weight:700;letter-spacing:.2px;",
    "padding:8px 14px 8px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,0.22);",
    "display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;",
    "animation:lc-badge-pop .4s ease .2s both;}",
    "#lc-chat-live-badge:hover{filter:brightness(1.08);}",
    "#lc-chat-live-dot{width:8px;height:8px;border-radius:50%;background:#baffc9;",
    "box-shadow:0 0 0 rgba(186,255,201,0.6);animation:lc-pulse 1.8s infinite;}",
    "@keyframes lc-pulse{0%{box-shadow:0 0 0 0 rgba(186,255,201,0.6);}",
    "70%{box-shadow:0 0 0 7px rgba(186,255,201,0);}100%{box-shadow:0 0 0 0 rgba(186,255,201,0);}}",
    "@keyframes lc-badge-pop{0%{opacity:0;transform:translateX(8px) scale(.9);}",
    "100%{opacity:1;transform:translateX(0) scale(1);}}",
    "#lc-chat-bubble{width:60px;height:60px;border-radius:50%;flex-shrink:0;",
    "background:#b8935f;box-shadow:0 4px 16px rgba(0,0,0,0.25);cursor:pointer;",
    "display:flex;align-items:center;justify-content:center;transition:transform .15s ease;border:none;padding:0;}",
    "#lc-chat-bubble:hover{transform:scale(1.06);}",
    "#lc-chat-bubble svg{width:28px;height:28px;fill:#fff;}",
    "#lc-chat-panel{position:fixed;bottom:92px;right:20px;width:340px;max-width:calc(100vw - 32px);",
    "height:460px;max-height:calc(100vh - 140px);background:#fff;border-radius:14px;",
    "box-shadow:0 10px 40px rgba(0,0,0,0.25);display:none;flex-direction:column;overflow:hidden;",
    "z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;}",
    "#lc-chat-panel.lc-open{display:flex;}",
    "#lc-chat-header{background:#2b2b2b;color:#fff;padding:14px 16px;display:flex;",
    "align-items:center;justify-content:space-between;flex-shrink:0;}",
    "#lc-chat-header-title{font-size:15px;font-weight:600;}",
    "#lc-chat-header-sub{font-size:12px;color:#c9c9c9;margin-top:2px;}",
    "#lc-chat-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;",
    "padding:4px;opacity:.8;}",
    "#lc-chat-close:hover{opacity:1;}",
    "#lc-chat-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;",
    "background:#f7f5f2;}",
    ".lc-msg{max-width:82%;padding:9px 12px;border-radius:14px;font-size:13.5px;line-height:1.4;",
    "white-space:pre-wrap;word-wrap:break-word;}",
    ".lc-msg-user{align-self:flex-end;background:#b8935f;color:#fff;border-bottom-right-radius:4px;}",
    ".lc-msg-assistant{align-self:flex-start;background:#fff;color:#2b2b2b;border:1px solid #e5e0d8;",
    "border-bottom-left-radius:4px;}",
    ".lc-msg-system{align-self:center;background:transparent;color:#8a8a8a;font-size:12px;",
    "text-align:center;max-width:100%;}",
    "#lc-chat-typing{align-self:flex-start;font-size:12.5px;color:#999;padding:2px 12px;}",
    "#lc-chat-input-row{display:flex;gap:8px;padding:10px;border-top:1px solid #ece7de;flex-shrink:0;",
    "background:#fff;}",
    "#lc-chat-input{flex:1;border:1px solid #ddd6c9;border-radius:20px;padding:9px 14px;font-size:13.5px;",
    "outline:none;font-family:inherit;}",
    "#lc-chat-input:focus{border-color:#b8935f;}",
    "#lc-chat-send{background:#b8935f;border:none;color:#fff;border-radius:20px;padding:0 16px;",
    "font-size:13.5px;font-weight:600;cursor:pointer;flex-shrink:0;}",
    "#lc-chat-send:disabled{opacity:.5;cursor:default;}",
    ".lc-escalate-form{align-self:stretch;background:#fff;border:1px solid #e5e0d8;border-radius:12px;",
    "padding:12px;display:flex;flex-direction:column;gap:8px;}",
    ".lc-escalate-label{font-size:12.5px;color:#555;margin-bottom:2px;}",
    ".lc-escalate-input{border:1px solid #ddd6c9;border-radius:8px;padding:8px 10px;font-size:13px;",
    "outline:none;font-family:inherit;width:100%;box-sizing:border-box;}",
    ".lc-escalate-input:focus{border-color:#b8935f;}",
    ".lc-escalate-submit{background:#2b2b2b;color:#fff;border:none;border-radius:8px;padding:9px;",
    "font-size:13px;font-weight:600;cursor:pointer;margin-top:2px;}",
    ".lc-escalate-submit:disabled{opacity:.5;cursor:default;}",
    ".lc-escalate-error{color:#b23b3b;font-size:12px;}",
    "@media (max-width:420px){#lc-chat-panel{right:12px;left:12px;width:auto;bottom:84px;}",
    "#lc-chat-launcher{right:16px;bottom:16px;}}",
  ].join("");

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  // ---- DOM construction ----
  var launcherEl, badgeEl, bubbleEl, panelEl, messagesEl, inputEl, sendBtnEl;

  function createLauncher() {
    launcherEl = document.createElement("div");
    launcherEl.id = "lc-chat-launcher";

    badgeEl = document.createElement("div");
    badgeEl.id = "lc-chat-live-badge";
    badgeEl.setAttribute("role", "button");
    badgeEl.setAttribute("aria-label", "Chat live with us");
    var dot = document.createElement("span");
    dot.id = "lc-chat-live-dot";
    var label = document.createElement("span");
    label.textContent = "Chat Live";
    badgeEl.appendChild(dot);
    badgeEl.appendChild(label);
    badgeEl.addEventListener("click", togglePanel);

    bubbleEl = document.createElement("button");
    bubbleEl.id = "lc-chat-bubble";
    bubbleEl.setAttribute("aria-label", "Open chat");
    bubbleEl.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>';
    bubbleEl.addEventListener("click", togglePanel);

    launcherEl.appendChild(badgeEl);
    launcherEl.appendChild(bubbleEl);
    document.body.appendChild(launcherEl);
  }

  function createPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "lc-chat-panel";

    var header = document.createElement("div");
    header.id = "lc-chat-header";
    header.innerHTML =
      '<div><div id="lc-chat-header-title">Legacy Colombia</div>' +
      '<div id="lc-chat-header-sub">Ask us anything</div></div>';
    var closeBtn = document.createElement("button");
    closeBtn.id = "lc-chat-close";
    closeBtn.setAttribute("aria-label", "Close chat");
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", togglePanel);
    header.appendChild(closeBtn);

    messagesEl = document.createElement("div");
    messagesEl.id = "lc-chat-messages";

    var inputRow = document.createElement("div");
    inputRow.id = "lc-chat-input-row";
    inputEl = document.createElement("input");
    inputEl.id = "lc-chat-input";
    inputEl.type = "text";
    inputEl.placeholder = "Type a message...";
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
    sendBtnEl = document.createElement("button");
    sendBtnEl.id = "lc-chat-send";
    sendBtnEl.type = "button";
    sendBtnEl.textContent = "Send";
    sendBtnEl.addEventListener("click", handleSend);
    inputRow.appendChild(inputEl);
    inputRow.appendChild(sendBtnEl);

    panelEl.appendChild(header);
    panelEl.appendChild(messagesEl);
    panelEl.appendChild(inputRow);
    document.body.appendChild(panelEl);

    appendMessage(
      "assistant",
      "Hi! Ask me anything about the villa — amenities, house rules, add-on experiences, or the area. If I can't answer something precisely, I'll get you connected with " +
        OWNER_NAME +
        "."
    );
  }

  function togglePanel() {
    isOpen = !isOpen;
    if (panelEl) {
      panelEl.classList.toggle("lc-open", isOpen);
    }
    // The "Chat Live" badge is there to grab a first-time visitor's
    // attention — once they've actually opened the chat, it's just visual
    // clutter next to the open panel, so hide it while open and bring it
    // back when they close the panel.
    if (badgeEl) {
      badgeEl.style.display = isOpen ? "none" : "flex";
    }
    if (isOpen && inputEl) {
      setTimeout(function () {
        inputEl.focus();
      }, 50);
    }
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendMessage(role, text) {
    var el = document.createElement("div");
    el.className = "lc-msg lc-msg-" + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function appendSystemNote(text) {
    var el = document.createElement("div");
    el.className = "lc-msg lc-msg-system";
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function setTyping(show) {
    var existing = document.getElementById("lc-chat-typing");
    if (show && !existing) {
      var el = document.createElement("div");
      el.id = "lc-chat-typing";
      el.textContent = "Typing...";
      messagesEl.appendChild(el);
      scrollToBottom();
    } else if (!show && existing) {
      existing.remove();
    }
  }

  // ---- Networking ----
  function postJson(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            var msg = (data && data.error) || "Request failed (" + res.status + ")";
            throw new Error(msg);
          }
          return data;
        });
    });
  }

  function handleSend() {
    if (isSending) return;
    var text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = "";
    appendMessage("user", text);
    history.push({ role: "user", content: text });

    isSending = true;
    sendBtnEl.disabled = true;
    setTyping(true);

    postJson(CHAT_ENDPOINT, { message: text, history: history })
      .then(function (data) {
        setTyping(false);
        var reply = data && data.reply ? data.reply : "Sorry, I didn't catch that — could you try again?";
        appendMessage("assistant", reply);
        history.push({ role: "assistant", content: reply });

        if (data && data.needsEscalation) {
          pendingEscalationQuestion = text;
          showEscalationForm();
        }
      })
      .catch(function () {
        setTyping(false);
        appendSystemNote("Something went wrong — please try again in a moment.");
      })
      .then(function () {
        isSending = false;
        sendBtnEl.disabled = false;
      });
  }

  function showEscalationForm() {
    var existing = document.getElementById("lc-escalate-form");
    if (existing) existing.remove();

    var wrap = document.createElement("div");
    wrap.className = "lc-escalate-form";
    wrap.id = "lc-escalate-form";

    var prompt = document.createElement("div");
    prompt.className = "lc-escalate-label";
    prompt.textContent = "I'll get you a precise answer from " + OWNER_NAME + " — how can we reach you?";
    wrap.appendChild(prompt);

    var nameInput = document.createElement("input");
    nameInput.className = "lc-escalate-input";
    nameInput.type = "text";
    nameInput.placeholder = "Your name";
    wrap.appendChild(nameInput);

    var emailInput = document.createElement("input");
    emailInput.className = "lc-escalate-input";
    emailInput.type = "email";
    emailInput.placeholder = "Email";
    wrap.appendChild(emailInput);

    var phoneInput = document.createElement("input");
    phoneInput.className = "lc-escalate-input";
    phoneInput.type = "tel";
    phoneInput.placeholder = "Phone (with country code)";
    wrap.appendChild(phoneInput);

    var errorEl = document.createElement("div");
    errorEl.className = "lc-escalate-error";
    errorEl.style.display = "none";
    wrap.appendChild(errorEl);

    var submitBtn = document.createElement("button");
    submitBtn.className = "lc-escalate-submit";
    submitBtn.type = "button";
    submitBtn.textContent = "Send";
    wrap.appendChild(submitBtn);

    submitBtn.addEventListener("click", function () {
      var name = nameInput.value.trim();
      var email = emailInput.value.trim();
      var phone = phoneInput.value.trim();
      errorEl.style.display = "none";

      if (!name || !email || !phone) {
        errorEl.textContent = "Please fill in your name, email, and phone.";
        errorEl.style.display = "block";
        return;
      }

      submitBtn.disabled = true;
      nameInput.disabled = true;
      emailInput.disabled = true;
      phoneInput.disabled = true;

      var conversationSummary = history
        .map(function (m) {
          return (m.role === "user" ? "Visitor: " : "AI: ") + m.content;
        })
        .join("\n")
        .slice(0, 2000);

      postJson(ESCALATE_ENDPOINT, {
        question: pendingEscalationQuestion || "",
        visitorName: name,
        visitorEmail: email,
        visitorPhone: phone,
        conversationSummary: conversationSummary,
      })
        .then(function (data) {
          wrap.remove();
          appendSystemNote(
            "Thanks! I'm getting you a precise answer from " + OWNER_NAME + " now — hang tight..."
          );
          pendingEscalationQuestion = null;
          if (data && data.escalationId) {
            startPolling(data.escalationId);
          }
        })
        .catch(function () {
          errorEl.textContent = "Couldn't send that — please try again.";
          errorEl.style.display = "block";
          submitBtn.disabled = false;
          nameInput.disabled = false;
          emailInput.disabled = false;
          phoneInput.disabled = false;
        });
    });

    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  // ---- Live answer polling ----
  // After an escalation is created, poll every few seconds so Seni's
  // WhatsApp-approved answer can appear right in this chat if the visitor
  // is still here — a real "live" feel without needing websockets. Stops
  // on: a real answer, an explicit "nothing coming" signal (Seni said NO,
  // or the escalation id wasn't found), or the 10-minute timeout, at which
  // point the answer will instead arrive by email/WhatsApp (see
  // api/cron/check-messages's fallback sweep).
  function startPolling(escalationId) {
    stopPolling();
    activeEscalationId = escalationId;
    pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    setTyping(true);
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    setTyping(false);
  }

  function pollOnce() {
    if (!activeEscalationId) {
      stopPolling();
      return;
    }
    if (Date.now() > pollDeadline) {
      stopPolling();
      appendSystemNote(
        "Thanks for your patience — " + OWNER_NAME + " will follow up with you directly by email or WhatsApp shortly."
      );
      activeEscalationId = null;
      return;
    }

    postJson(POLL_ENDPOINT, { escalationId: activeEscalationId })
      .then(function (data) {
        if (data && data.answered && data.answer) {
          stopPolling();
          appendMessage("assistant", data.answer);
          history.push({ role: "assistant", content: data.answer });
          activeEscalationId = null;
        } else if (data && data.stopPolling) {
          stopPolling();
          appendSystemNote(
            OWNER_NAME + " will follow up with you directly by email or WhatsApp."
          );
          activeEscalationId = null;
        }
        // otherwise: not answered yet, keep polling silently
      })
      .catch(function () {
        // Transient network hiccup — just try again on the next tick rather
        // than giving up the whole wait over one failed poll.
      });
  }

  // A visitor closing the tab/navigating away is the main case the fallback
  // delivery exists for — send a best-effort beacon so the server can fall
  // back to email/WhatsApp right away instead of waiting out the full
  // timeout. sendBeacon can't guarantee delivery (especially on mobile
  // backgrounding), which is exactly why the 10-minute timeout above still
  // exists as a backstop.
  function sendLeaveBeacon() {
    if (!activeEscalationId || !navigator.sendBeacon) return;
    try {
      navigator.sendBeacon(LEAVE_ENDPOINT, JSON.stringify({ escalationId: activeEscalationId }));
    } catch (e) {
      // Best-effort only — nothing to do if this throws.
    }
  }

  // ---- Init ----
  function init() {
    injectStyles();
    createLauncher();
    createPanel();
    window.addEventListener("pagehide", sendLeaveBeacon);
    window.addEventListener("beforeunload", sendLeaveBeacon);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/**
 * Book Direct -> homepage booking widget handoff.
 *
 * Added 2026-08-06, corrected same day after live testing: the "Request
 * These Dates" button on the Book Direct calendar (booking-calendar.js)
 * links to
 * https://legacycolombia.com/?or_arrival=YYYY-MM-DD&or_departure=YYYY-MM-DD#book-form-card
 *
 * First version of this tried to prefill a Gravity Forms date field
 * (input_1_5/input_1_6) directly. Live inspection showed that form isn't
 * what's actually on screen at all — the tan "Book the estate directly"
 * card is OwnerRez's own hosted Inquiry/Booking widget, rendered in a
 * cross-origin <iframe class="ownerrez-widget-iframe"> pointed at
 * app.ownerrez.com. The Gravity Forms markup exists lower in the same
 * Elementor container but isn't the visible/active form — editing its
 * fields had no visible effect. Cross-origin means this script can't reach
 * into the iframe's DOM at all, so field-by-field prefill isn't an option
 * here regardless.
 *
 * OwnerRez solves this itself: their widget-embed script reads `or_arrival`
 * / `or_departure` (format YYYY-MM-DD) straight off the PARENT page's URL
 * at load time and bakes them into the iframe's own src before creating it
 * — this is their documented, first-party mechanism, not a workaround (see
 * https://www.ownerrez.com/support/articles/prepopulate-widget-fields).
 * Confirmed live: loading this page with those two params on the URL
 * produces an iframe src that already contains matching or_arrival/
 * or_departure values. So all this script needs to do is make sure the
 * link carries the right param NAMES — the actual prefill is entirely
 * OwnerRez's widget's own job, not something to reimplement here.
 *
 * What's left for this script: getting the visitor's eyes to the widget at
 * all. It sits ~13,000px down a very long homepage, and this site's
 * `window.scrollTo` / `scrollBy` / `documentElement.scrollTop` all turned
 * out to be silent no-ops when tested live (only genuine wheel/touch input
 * moves the page — a plain `#hash` jump didn't land correctly either at
 * this distance). `element.scrollIntoView()` was the one thing that did
 * work, so that's used below, with a temporary `scroll-margin-top` on the
 * card so it clears the sticky nav instead of landing tucked under it.
 *
 * Deliberately a separate IIFE from the chat widget above — same file only
 * because it's already loaded site-wide via one <script> tag in <head>,
 * and this needs to run on the homepage specifically. No-ops instantly if
 * the query params aren't present.
 */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  // Just confirming the handoff actually happened — OwnerRez's own widget
  // script (not this one) is what reads or_arrival/or_departure and prefills
  // the iframe.
  if (!params.get("or_arrival") || !params.get("or_departure")) return;

  var CARD_ID = "book-form-card"; // the Elementor container wrapping the OwnerRez widget iframe
  var HEADER_CLEARANCE_PX = 100; // roughly the sticky nav's height, so the card isn't tucked under it
  var MAX_WAIT_MS = 6000;
  var POLL_INTERVAL_MS = 150;

  function tryScroll() {
    var card = document.getElementById(CARD_ID);
    if (!card) return false;

    card.style.scrollMarginTop = HEADER_CLEARANCE_PX + "px";
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  }

  function init() {
    var waited = 0;
    var timer = setInterval(function () {
      var done = tryScroll();
      waited += POLL_INTERVAL_MS;
      if (done || waited >= MAX_WAIT_MS) clearInterval(timer);
    }, POLL_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
