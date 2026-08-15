/**
 * Legacy Colombia "Book Direct" availability calendar.
 *
 * Standalone, dependency-free vanilla JS — same conventions as
 * chat-widget.js (no build step, no framework, full URLs throughout since
 * this script's origin differs from the CRM API it calls). Renders a large,
 * multi-month availability grid with per-night rates into a container
 * element on the page, modeled after the reference layout at
 * https://legacylookoutsc.com/contact/ (per Seni's 2026-08-06 request).
 *
 * Embed on the WordPress "Book Direct" page with:
 *
 *   <div id="lc-booking-calendar"></div>
 *   <script src="https://crm.legacyestaterentals.com/booking-calendar.js" defer></script>
 *
 * Data comes from a single fetch to the CRM's public availability API (see
 * src/app/api/public/availability/route.ts) — that route itself makes ZERO
 * live OwnerRez calls per request (rates come from the daily-refreshed
 * rate_snapshots table, availability from an already-cached bookings list),
 * so this widget can be loaded by any number of website visitors without
 * adding any OwnerRez API load. Scoped to Legacy Colombia's main listing
 * ("Luxury Waterfront Wellness Retreat") only.
 *
 * Rates won't be present for every date — the underlying data has dense
 * (daily) coverage for the next ~60 days and sparse (weekly) coverage out to
 * a year, so gaps in the rate row are expected and normal, matching how the
 * reference site's own calendar behaves.
 *
 * 2026-08-06 revision: Seni reported two real issues with the first version —
 * (1) the calendar was pure display, clicking a date did nothing, so there
 * was no way to actually "request" specific dates; (2) the color palette
 * (a warm gold/cream guess borrowed from chat-widget.js) didn't match the
 * real site theme. Fixed both: colors below are pulled directly from the
 * live site's own computed styles (hero button background rgb(201,162,39) =
 * #C9A227, heading color rgb(30,41,59) = #1E293B, body text rgb(51,65,85) =
 * #334155 — this site uses a slate + gold palette, not warm cream/charcoal).
 * And clicking available days now builds an actual arrival/departure
 * selection (enforcing the minimum-stay and skipping over booked nights),
 * shown in a summary line, with the CTA button carrying the selected dates
 * as or_arrival/or_departure query params (see the note by BOOK_FORM_BASE
 * below) to the homepage's booking widget.
 */
(function () {
  "use strict";

  var API_BASE = "https://crm.legacyestaterentals.com";
  var AVAILABILITY_ENDPOINT = API_BASE + "/api/public/availability";
  var BOOK_FORM_BASE = "https://legacycolombia.com/";
  // Points at the actual Elementor container wrapping the homepage's
  // booking widget (id="book-form-card" — confirmed live 2026-08-06; there
  // is no element with id="book" on the page, so that anchor never did
  // anything). The visible widget itself is OwnerRez's own cross-origin
  // iframe embed, which reads or_arrival/or_departure off the parent page's
  // URL and prefills itself automatically (see the query-string comment
  // where this is used below) — this script doesn't touch its fields
  // directly. chat-widget.js's second IIFE handles scrolling the visitor
  // down to #book-form-card itself via JS, since native hash-jumping proved
  // unreliable this far down the page — the fragment here is just a
  // harmless, semantically-correct fallback.
  var BOOK_FORM_ANCHOR = "#book-form-card";

  var CONTAINER_ID = "lc-booking-calendar";
  var STYLE_ID = "lc-booking-calendar-styles";
  var WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTH_LABELS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // ---- Styles — matched to the live site's own computed styles (see header
  // comment): gold accent #C9A227, slate-800 headings #1E293B, slate-600 body
  // text #334155, slate-200 borders #E2E8F0, slate-50 surface #F8FAFC. ----
  var css = [
    "#lc-cal{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;",
    "max-width:880px;margin:0 auto;color:#334155;}",
    "#lc-cal-header{text-align:center;margin-bottom:18px;}",
    "#lc-cal-title{font-size:22px;font-weight:700;margin:0 0 4px;color:#1E293B;}",
    "#lc-cal-subtitle{font-size:14px;color:#64748B;margin:0;}",
    "#lc-cal-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}",
    ".lc-cal-nav-btn{background:#1E293B;color:#fff;border:none;border-radius:8px;padding:9px 16px;",
    "font-size:14px;font-weight:600;cursor:pointer;}",
    ".lc-cal-nav-btn:disabled{opacity:.35;cursor:default;}",
    ".lc-cal-nav-btn:not(:disabled):hover{background:#C9A227;}",
    "#lc-cal-month-label{font-size:17px;font-weight:700;color:#1E293B;}",
    "#lc-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;}",
    ".lc-cal-weekday{text-align:center;font-size:12px;font-weight:700;color:#94A3B8;",
    "text-transform:uppercase;letter-spacing:.03em;padding-bottom:4px;}",
    ".lc-cal-day{border-radius:10px;padding:8px 4px;min-height:56px;display:flex;",
    "flex-direction:column;align-items:center;justify-content:flex-start;font-size:13px;",
    "border:1px solid #E2E8F0;background:#F8FAFC;transition:transform .1s ease;}",
    ".lc-cal-day.lc-empty{border:none;background:transparent;}",
    ".lc-cal-day.lc-available{background:#fff;cursor:pointer;}",
    ".lc-cal-day.lc-available:hover{border-color:#C9A227;transform:translateY(-1px);}",
    ".lc-cal-day.lc-booked{background:#FEF2F2;border-color:#FCA5A5;color:#B91C1C;}",
    ".lc-cal-day.lc-today{border:2px solid #C9A227;background:#FDF8EC;}",
    ".lc-cal-day.lc-selected{background:#C9A227;border-color:#C9A227;}",
    ".lc-cal-day.lc-selected .lc-cal-day-num,.lc-cal-day.lc-selected .lc-cal-day-rate{color:#fff;}",
    ".lc-cal-day.lc-in-range{background:#FBF0D2;border-color:#EBD8A0;}",
    ".lc-cal-day-num{font-weight:700;color:#1E293B;}",
    ".lc-cal-day.lc-booked .lc-cal-day-num{color:#B91C1C;}",
    ".lc-cal-day-rate{font-size:11px;color:#8A7420;margin-top:3px;font-weight:600;}",
    ".lc-cal-day.lc-booked .lc-cal-day-rate{color:#B91C1C;}",
    ".lc-cal-day-status{font-size:9.5px;color:#B91C1C;margin-top:2px;text-transform:uppercase;",
    "letter-spacing:.03em;}",
    "#lc-cal-legend{display:flex;flex-wrap:wrap;gap:16px;justify-content:center;margin:18px 0 6px;",
    "font-size:12.5px;color:#64748B;}",
    ".lc-cal-legend-item{display:flex;align-items:center;gap:6px;}",
    ".lc-cal-legend-swatch{width:14px;height:14px;border-radius:4px;display:inline-block;",
    "border:1px solid #E2E8F0;}",
    "#lc-cal-note{text-align:center;font-size:12.5px;color:#94A3B8;margin-top:6px;}",
    "#lc-cal-selection{text-align:center;margin-top:18px;padding:12px 16px;background:#F8FAFC;",
    "border:1px solid #E2E8F0;border-radius:10px;font-size:14px;color:#1E293B;display:none;}",
    "#lc-cal-selection.lc-active{display:block;}",
    "#lc-cal-selection strong{color:#1E293B;}",
    "#lc-cal-selection button{background:none;border:none;color:#B91C1C;font-size:12.5px;",
    "text-decoration:underline;cursor:pointer;margin-left:10px;padding:0;}",
    "#lc-cal-hint{text-align:center;font-size:12.5px;color:#64748B;margin-top:14px;}",
    "#lc-cal-cta{display:flex;justify-content:center;margin-top:14px;}",
    "#lc-cal-cta a{background:#C9A227;color:#fff;text-decoration:none;font-weight:700;",
    "font-size:14.5px;padding:13px 30px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,0.12);",
    "transition:background .15s ease;}",
    "#lc-cal-cta a:hover{background:#AD8A1F;}",
    "#lc-cal-cta a.lc-disabled{background:#CBD5E1;pointer-events:none;}",
    "#lc-cal-loading,#lc-cal-error{text-align:center;padding:40px 10px;color:#94A3B8;font-size:14px;}",
    "@media (max-width:640px){.lc-cal-day{min-height:46px;font-size:11.5px;padding:6px 2px;}",
    ".lc-cal-day-rate{font-size:9.5px;}#lc-cal-title{font-size:19px;}}",
  ].join("");

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ---- Date helpers (all UTC-based, matching the API's YYYY-MM-DD dates) ----
  function parseISODate(s) {
    var parts = s.split("-").map(Number);
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  }
  function formatMoney(cents) {
    return "$" + Math.round(cents / 100).toLocaleString("en-US");
  }
  function formatShort(dateStr) {
    var d = parseISODate(dateStr);
    return MONTH_LABELS[d.getUTCMonth()].slice(0, 3) + " " + d.getUTCDate();
  }
  function nightsBetween(a, b) {
    return Math.round((parseISODate(b) - parseISODate(a)) / 86400000);
  }
  // All stay_dates from arrival (inclusive) to departure (exclusive) — the
  // actual nights of the stay.
  function datesInRange(arrival, departure) {
    var out = [];
    var cur = parseISODate(arrival);
    var end = parseISODate(departure);
    while (cur < end) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  // ---- State ----
  var byDate = {}; // date string -> { available, rateCents, isToday }
  var minDate = null;
  var maxDate = null;
  var propertyName = "";
  var minNights = 2;
  var viewYear, viewMonth; // UTC year / 0-based month currently displayed
  var selectedArrival = null; // date string or null
  var selectedDeparture = null; // date string or null

  var containerEl, navEl, gridEl, monthLabelEl, prevBtn, nextBtn, selectionEl, ctaLinkEl;

  function render() {
    containerEl.innerHTML = "";

    var header = document.createElement("div");
    header.id = "lc-cal-header";
    header.innerHTML =
      '<p id="lc-cal-title">Check Availability &amp; Rates</p>' +
      '<p id="lc-cal-subtitle">' + (propertyName || "Legacy Colombia") + "</p>";
    containerEl.appendChild(header);

    navEl = document.createElement("div");
    navEl.id = "lc-cal-nav";
    prevBtn = document.createElement("button");
    prevBtn.className = "lc-cal-nav-btn";
    prevBtn.type = "button";
    prevBtn.textContent = "← Prev";
    prevBtn.addEventListener("click", function () {
      shiftMonth(-1);
    });
    monthLabelEl = document.createElement("div");
    monthLabelEl.id = "lc-cal-month-label";
    nextBtn = document.createElement("button");
    nextBtn.className = "lc-cal-nav-btn";
    nextBtn.type = "button";
    nextBtn.textContent = "Next →";
    nextBtn.addEventListener("click", function () {
      shiftMonth(1);
    });
    navEl.appendChild(prevBtn);
    navEl.appendChild(monthLabelEl);
    navEl.appendChild(nextBtn);
    containerEl.appendChild(navEl);

    gridEl = document.createElement("div");
    gridEl.id = "lc-cal-grid";
    containerEl.appendChild(gridEl);

    var legend = document.createElement("div");
    legend.id = "lc-cal-legend";
    legend.innerHTML =
      '<span class="lc-cal-legend-item"><span class="lc-cal-legend-swatch" style="background:#fff;"></span>Available</span>' +
      '<span class="lc-cal-legend-item"><span class="lc-cal-legend-swatch" style="background:#FEF2F2;border-color:#FCA5A5;"></span>Booked</span>' +
      '<span class="lc-cal-legend-item"><span class="lc-cal-legend-swatch" style="background:#C9A227;border-color:#C9A227;"></span>Selected</span>' +
      '<span class="lc-cal-legend-item"><span class="lc-cal-legend-swatch" style="background:#FDF8EC;border-color:#C9A227;"></span>Today</span>';
    containerEl.appendChild(legend);

    var hint = document.createElement("p");
    hint.id = "lc-cal-hint";
    hint.textContent = "Click an available date to select your arrival, then click again for your departure.";
    containerEl.appendChild(hint);

    var note = document.createElement("p");
    note.id = "lc-cal-note";
    note.textContent =
      "Rates shown are per night in USD and may vary by length of stay. " +
      minNights + "-night minimum stay. Rates not shown for every date are still bookable — just ask.";
    containerEl.appendChild(note);

    selectionEl = document.createElement("div");
    selectionEl.id = "lc-cal-selection";
    containerEl.appendChild(selectionEl);

    var cta = document.createElement("div");
    cta.id = "lc-cal-cta";
    ctaLinkEl = document.createElement("a");
    ctaLinkEl.href = BOOK_FORM_BASE + BOOK_FORM_ANCHOR;
    cta.appendChild(ctaLinkEl);
    containerEl.appendChild(cta);

    renderMonth();
    updateSelectionUI();
  }

  function shiftMonth(delta) {
    var d = new Date(Date.UTC(viewYear, viewMonth + delta, 1));
    var candidateStart = d;
    var candidateEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    // Don't navigate past the range the API actually returned data for.
    if (candidateEnd < minDate || candidateStart > maxDate) return;
    viewYear = d.getUTCFullYear();
    viewMonth = d.getUTCMonth();
    renderMonth();
  }

  // A candidate departure is only valid if every night from arrival up to
  // (not including) the candidate is actually available — otherwise the
  // guest would be "selecting" a stay that jumps over a booked night.
  function isValidDeparture(arrival, candidate) {
    if (parseISODate(candidate) <= parseISODate(arrival)) return false;
    if (nightsBetween(arrival, candidate) < minNights) return false;
    return datesInRange(arrival, candidate).every(function (d) {
      var info = byDate[d];
      return info && info.available;
    });
  }

  function handleDayClick(dateStr) {
    var info = byDate[dateStr];
    if (!info || !info.available) return;

    if (!selectedArrival || (selectedArrival && selectedDeparture)) {
      // Starting a fresh selection.
      selectedArrival = dateStr;
      selectedDeparture = null;
    } else if (dateStr === selectedArrival) {
      // Clicked the same day again — clear it.
      selectedArrival = null;
      selectedDeparture = null;
    } else if (isValidDeparture(selectedArrival, dateStr)) {
      selectedDeparture = dateStr;
    } else {
      // Not a valid departure (too soon, or a booked night in between) —
      // treat this click as a new arrival instead of showing an error.
      selectedArrival = dateStr;
      selectedDeparture = null;
    }

    renderMonth();
    updateSelectionUI();
  }

  function clearSelection() {
    selectedArrival = null;
    selectedDeparture = null;
    renderMonth();
    updateSelectionUI();
  }

  function updateSelectionUI() {
    if (!selectedArrival) {
      selectionEl.className = "";
      selectionEl.innerHTML = "";
      ctaLinkEl.textContent = "Request These Dates";
      ctaLinkEl.href = BOOK_FORM_BASE + BOOK_FORM_ANCHOR;
      ctaLinkEl.classList.remove("lc-disabled");
      return;
    }

    if (!selectedDeparture) {
      selectionEl.className = "lc-active";
      selectionEl.innerHTML =
        "Arrival: <strong>" + formatShort(selectedArrival) + "</strong> — now pick a departure date " +
        "(minimum " + minNights + " nights).";
      ctaLinkEl.textContent = "Select a departure date";
      ctaLinkEl.classList.add("lc-disabled");
      return;
    }

    var nights = nightsBetween(selectedArrival, selectedDeparture);
    var rangeDates = datesInRange(selectedArrival, selectedDeparture);
    var known = rangeDates.map(function (d) { return byDate[d] && byDate[d].rateCents; }).filter(Boolean);
    var totalText = "";
    if (known.length === rangeDates.length) {
      var total = known.reduce(function (sum, c) { return sum + c; }, 0);
      totalText = " · Est. total " + formatMoney(total) + " (before taxes/fees)";
    }

    selectionEl.className = "lc-active";
    selectionEl.innerHTML =
      "<strong>" + formatShort(selectedArrival) + " → " + formatShort(selectedDeparture) + "</strong>" +
      " (" + nights + " night" + (nights === 1 ? "" : "s") + ")" + totalText +
      ' <button type="button" id="lc-cal-clear">Clear</button>';
    document.getElementById("lc-cal-clear").addEventListener("click", clearSelection);

    ctaLinkEl.textContent = "Request " + formatShort(selectedArrival) + " – " + formatShort(selectedDeparture);
    ctaLinkEl.classList.remove("lc-disabled");
    ctaLinkEl.href =
      // or_arrival / or_departure (not arrival/departure) — OwnerRez's own
      // widget-embed script on the homepage reads exactly these two param
      // names off the parent page URL and bakes them into its booking
      // widget's iframe automatically. See
      // https://www.ownerrez.com/support/articles/prepopulate-widget-fields
      // — confirmed live 2026-08-06 that this is the real, first-party
      // mechanism (an earlier version of this tried to prefill a Gravity
      // Forms field that turned out not to be the actual visible form at
      // all — the real one is OwnerRez's cross-origin iframe widget).
      BOOK_FORM_BASE + "?or_arrival=" + selectedArrival + "&or_departure=" + selectedDeparture + BOOK_FORM_ANCHOR;
  }

  function renderMonth() {
    gridEl.innerHTML = "";
    monthLabelEl.textContent = MONTH_LABELS[viewMonth] + " " + viewYear;

    var monthStart = new Date(Date.UTC(viewYear, viewMonth, 1));
    var monthEnd = new Date(Date.UTC(viewYear, viewMonth + 1, 0));
    prevBtn.disabled = new Date(Date.UTC(viewYear, viewMonth, 0)) < minDate;
    nextBtn.disabled = new Date(Date.UTC(viewYear, viewMonth + 1, 1)) > maxDate;

    var rangeDates = selectedArrival && selectedDeparture ? datesInRange(selectedArrival, selectedDeparture) : [];

    WEEKDAY_LABELS.forEach(function (label) {
      var el = document.createElement("div");
      // notranslate + translate="no": found while previewing the page with
      // GTranslate active — auto-translators read 3-letter weekday
      // abbreviations as English homographs out of calendar context (e.g.
      // "Wed" -> "to marry", "Sat" -> "sat down" in Spanish) instead of as
      // day names. These headers are compact/iconographic like a calendar
      // app's, not prose, so it's better for them to stay put than mistranslate.
      el.className = "lc-cal-weekday notranslate";
      el.setAttribute("translate", "no");
      el.textContent = label;
      gridEl.appendChild(el);
    });

    var leadingBlanks = monthStart.getUTCDay();
    for (var b = 0; b < leadingBlanks; b++) {
      var blank = document.createElement("div");
      blank.className = "lc-cal-day lc-empty";
      gridEl.appendChild(blank);
    }

    for (var day = 1; day <= monthEnd.getUTCDate(); day++) {
      var dateObj = new Date(Date.UTC(viewYear, viewMonth, day));
      var dateStr = dateObj.toISOString().slice(0, 10);
      var info = byDate[dateStr];

      var cell = document.createElement("div");
      cell.className = "lc-cal-day";
      if (info) {
        if (dateStr === selectedArrival || dateStr === selectedDeparture) cell.className += " lc-selected";
        else if (rangeDates.indexOf(dateStr) !== -1) cell.className += " lc-in-range";
        else if (info.isToday) cell.className += " lc-today";
        else if (!info.available) cell.className += " lc-booked";
        else cell.className += " lc-available";

        if (info.available) {
          cell.addEventListener("click", (function (d) {
            return function () { handleDayClick(d); };
          })(dateStr));
        }
      }

      var num = document.createElement("div");
      num.className = "lc-cal-day-num";
      num.textContent = String(day);
      cell.appendChild(num);

      if (info) {
        if (!info.available) {
          var status = document.createElement("div");
          status.className = "lc-cal-day-status";
          status.textContent = "Booked";
          cell.appendChild(status);
        } else if (info.rateCents) {
          var rate = document.createElement("div");
          rate.className = "lc-cal-day-rate";
          rate.textContent = formatMoney(info.rateCents);
          cell.appendChild(rate);
        }
      }

      gridEl.appendChild(cell);
    }
  }

  function showLoading() {
    containerEl.innerHTML = '<div id="lc-cal-loading">Loading availability…</div>';
  }

  function showError() {
    containerEl.innerHTML =
      '<div id="lc-cal-error">Couldn’t load the availability calendar right now. ' +
      'Please <a href="' + BOOK_FORM_BASE + BOOK_FORM_ANCHOR + '">contact us directly</a> to check dates.</div>';
  }

  function init() {
    containerEl = document.getElementById(CONTAINER_ID);
    if (!containerEl) return;
    injectStyles();
    showLoading();

    fetch(AVAILABILITY_ENDPOINT, { method: "GET" })
      .then(function (res) {
        if (!res.ok) throw new Error("bad status");
        return res.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.days) || data.days.length === 0) throw new Error("empty");
        propertyName = data.property && data.property.name;
        minNights = data.minNights || 2;
        byDate = {};
        data.days.forEach(function (d) {
          byDate[d.date] = d;
        });
        minDate = parseISODate(data.days[0].date);
        maxDate = parseISODate(data.days[data.days.length - 1].date);
        var todayEntry = data.days.filter(function (d) { return d.isToday; })[0];
        var startDate = todayEntry ? parseISODate(todayEntry.date) : minDate;
        viewYear = startDate.getUTCFullYear();
        viewMonth = startDate.getUTCMonth();
        render();
      })
      .catch(function () {
        showError();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
