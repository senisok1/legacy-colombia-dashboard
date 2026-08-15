/**
 * Legacy Colombia homepage "Reserve" section — compact inline calendar.
 *
 * 2026-08-06: Seni reported the /book-direct/ page's cross-page handoff to
 * the homepage's OwnerRez booking widget (via or_arrival/or_departure URL
 * params + a scrollIntoView jump) still wasn't landing reliably in real use,
 * and proposed a simpler fix: put a compact calendar directly in the empty
 * space on the homepage's "07 — RESERVE" section itself, right next to the
 * booking widget, so picking dates updates the widget in place with zero
 * navigation and zero scrolling. Confirmed live 2026-08-06 that the left
 * column of that section (heading + bullet list + phone/email buttons,
 * Elementor id bd191ac) has ~1350px of empty vertical space below its last
 * child (b63d5ea) — this widget is meant to be inserted there as a new
 * child, as a sibling immediately after b63d5ea.
 *
 * This is a deliberately separate, smaller script from booking-calendar.js
 * (which stays as-is on /book-direct/ for direct links/SEO/sharing) rather
 * than a shared module — different container size, different CSS, and most
 * importantly different "apply" behavior:
 *
 *   - booking-calendar.js: builds a link with or_arrival/or_departure query
 *     params pointing at the homepage, because it lives on a different page
 *     than the widget it's trying to prefill.
 *   - This script: lives on the SAME page as the widget, so instead of
 *     building a link, it reaches out to the already-rendered
 *     <iframe class="ownerrez-widget-iframe"> element directly and rewrites
 *     its src in place with updated or_arrival/or_departure params. This
 *     never touches the iframe's cross-origin document (that's not
 *     possible), only the iframe ELEMENT's own src attribute from the
 *     parent page — which is allowed, and is exactly what causes OwnerRez's
 *     app to reload itself with the new dates baked in, the same way it
 *     would on a fresh page load with those params present. Confirmed via
 *     https://www.ownerrez.com/support/articles/prepopulate-widget-fields
 *     that the widget app reads or_arrival/or_departure off its own iframe
 *     URL — this is the first-party, documented mechanism, just applied
 *     directly instead of via a parent-page reload.
 *
 * Embed on the WordPress homepage, inside the left column of the "07 —
 * RESERVE" section, right after the phone/email buttons block:
 *
 *   <div id="lc-mini-booking-calendar"></div>
 *   <script src="https://crm.legacyestaterentals.com/reserve-mini-calendar.js" defer></script>
 *
 * Same data source as booking-calendar.js — a single fetch to the CRM's
 * public availability API (src/app/api/public/availability/route.ts), which
 * makes zero live OwnerRez calls per request.
 */
(function () {
  "use strict";

  var API_BASE = "https://crm.legacyestaterentals.com";
  var AVAILABILITY_ENDPOINT = API_BASE + "/api/public/availability";
  var WIDGET_IFRAME_SELECTOR = ".ownerrez-widget-iframe";
  var WIDGET_CARD_ID = "book-form-card";

  // Fallback only — used if the OwnerRez widget iframe can't be found on the
  // page at all (shouldn't happen on the homepage, but this keeps the
  // "Request" action useful instead of silently failing if the widget's own
  // embed script hasn't run yet or the markup ever changes).
  var FALLBACK_BASE = "https://legacycolombia.com/";
  var FALLBACK_ANCHOR = "#" + WIDGET_CARD_ID;

  var CONTAINER_ID = "lc-mini-booking-calendar";
  var STYLE_ID = "lc-mini-booking-calendar-styles";

  // 2026-08-06: this same script file is loaded on both the English homepage
  // and the new real Spanish page at /es/ (see the hreflang work in
  // functions.php) — detect which one we're on by URL path so the widget's
  // own UI strings (month/day names, buttons, hints) match the surrounding
  // page's language instead of always showing English on /es/.
  var IS_SPANISH = /^\/es(\/|$)/.test(window.location.pathname);

  var WEEKDAY_LABELS = IS_SPANISH
    ? ["D", "L", "M", "M", "J", "V", "S"]
    : ["S", "M", "T", "W", "T", "F", "S"];
  var MONTH_LABELS = IS_SPANISH
    ? ["enero", "febrero", "marzo", "abril", "mayo", "junio",
       "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
    : ["January", "February", "March", "April", "May", "June",
       "July", "August", "September", "October", "November", "December"];

  var STR = IS_SPANISH ? {
    selectDates: "Selecciona tus fechas",
    prevMonth: "Mes anterior",
    nextMonth: "Mes siguiente",
    hint: function (n) {
      return "Haz clic en una fecha para empezar, haz clic de nuevo para elegir tu salida — mínimo " + n + " noches.";
    },
    arrivalPrefix: "Llegada: ",
    arrivalSuffix: " — ahora elige una fecha de salida.",
    nightSingular: "noche",
    nightPlural: "noches",
    estTotal: function (amount) { return " · Total estimado " + amount + " (antes de impuestos/comisiones)"; },
    clear: "Borrar",
    appliedBase: "✓ Fechas aplicadas al formulario de reserva",
    appliedBelow: " (más abajo)",
    booked: "Reservado",
    loading: "Cargando disponibilidad…",
    errorHtml: function (fallbackUrl) {
      return 'No pudimos cargar el calendario en este momento — ' +
        '<a href="' + fallbackUrl + '">usa el formulario de reserva</a> o contáctanos directamente.';
    },
  } : {
    selectDates: "Select Your Dates",
    prevMonth: "Previous month",
    nextMonth: "Next month",
    hint: function (n) {
      return "Click a date to start, click again to set your departure — " + n + "-night minimum.";
    },
    arrivalPrefix: "Arrival: ",
    arrivalSuffix: " — now pick a departure date.",
    nightSingular: "night",
    nightPlural: "nights",
    estTotal: function (amount) { return " · Est. total " + amount + " (before taxes/fees)"; },
    clear: "Clear",
    appliedBase: "✓ Dates applied to the booking form",
    appliedBelow: " below",
    booked: "Booked",
    loading: "Loading availability…",
    errorHtml: function (fallbackUrl) {
      return 'Couldn’t load the calendar right now — ' +
        '<a href="' + fallbackUrl + '">use the booking form</a> or contact us directly.';
    },
  };

  // Same slate + gold palette as booking-calendar.js (pulled from the live
  // site's own computed styles) — kept visually consistent with the rest of
  // this section, just sized down to fit a narrower column.
  var css = [
    "#lc-mini-cal{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;",
    "color:#334155;width:100%;max-width:440px;margin-top:8px;}",
    // Text colors below were originally copied from booking-calendar.js,
    // which lives on a light-background page — this widget instead sits
    // directly on the homepage's dark navy "07 — RESERVE" section
    // (confirmed live 2026-08-06: section background rgb(22,40,53) /
    // #162835), so headings need to be light, not dark-slate, or they're
    // invisible. Colors below are pulled from that same section's other
    // text (cream bullet list rgb(243,236,225), heading rgb(235,235,235)).
    "#lc-mini-cal-label{font-size:13px;font-weight:700;color:#F3ECE1;margin:0 0 10px;",
    "text-transform:uppercase;letter-spacing:.04em;}",
    "#lc-mini-cal-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}",
    ".lc-mini-nav-btn{background:#1E293B;color:#fff;border:none;border-radius:7px;padding:6px 11px;",
    "font-size:12px;font-weight:600;cursor:pointer;}",
    ".lc-mini-nav-btn:disabled{opacity:.35;cursor:default;}",
    ".lc-mini-nav-btn:not(:disabled):hover{background:#C9A227;}",
    "#lc-mini-cal-month-label{font-size:13.5px;font-weight:700;color:#F3ECE1;}",
    "#lc-mini-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;}",
    ".lc-mini-weekday{text-align:center;font-size:10px;font-weight:700;color:#94A3B8;",
    "text-transform:uppercase;padding-bottom:3px;}",
    ".lc-mini-day{border-radius:6px;padding:3px 2px;min-height:38px;display:flex;",
    "flex-direction:column;align-items:center;justify-content:center;font-size:11px;",
    "border:1px solid #E2E8F0;background:#F8FAFC;transition:transform .1s ease;}",
    ".lc-mini-day.lc-mini-empty{border:none;background:transparent;}",
    ".lc-mini-day.lc-mini-available{background:#fff;cursor:pointer;}",
    ".lc-mini-day.lc-mini-available:hover{border-color:#C9A227;transform:translateY(-1px);}",
    ".lc-mini-day.lc-mini-booked{background:#FEF2F2;border-color:#FCA5A5;color:#B91C1C;}",
    ".lc-mini-day.lc-mini-today{border:2px solid #C9A227;background:#FDF8EC;}",
    ".lc-mini-day.lc-mini-selected{background:#C9A227;border-color:#C9A227;}",
    ".lc-mini-day.lc-mini-selected .lc-mini-day-num,.lc-mini-day.lc-mini-selected .lc-mini-day-rate{color:#fff;}",
    ".lc-mini-day.lc-mini-in-range{background:#FBF0D2;border-color:#EBD8A0;}",
    ".lc-mini-day-num{font-weight:700;color:#1E293B;line-height:1.1;}",
    ".lc-mini-day.lc-mini-booked .lc-mini-day-num{color:#B91C1C;}",
    ".lc-mini-day-rate{font-size:8.5px;color:#8A7420;margin-top:1px;font-weight:600;line-height:1;}",
    ".lc-mini-day.lc-mini-booked .lc-mini-day-rate{color:#B91C1C;}",
    // Booked-day label — was missing entirely in the first version (only
    // booking-calendar.js had this); Seni flagged the compact calendar
    // should show it too. Sits inside the day's own light-pink cell
    // background (same as booking-calendar.js), so the existing dark-red
    // color still reads fine there.
    ".lc-mini-day-status{font-size:7.5px;color:#B91C1C;margin-top:1px;text-transform:uppercase;",
    "letter-spacing:.02em;line-height:1;font-weight:700;}",
    "#lc-mini-cal-hint{font-size:11.5px;color:#B9C6D0;margin:10px 0 0;}",
    "#lc-mini-cal-selection{margin-top:10px;padding:10px 12px;background:#F8FAFC;",
    "border:1px solid #E2E8F0;border-radius:8px;font-size:13px;color:#1E293B;display:none;}",
    "#lc-mini-cal-selection.lc-mini-active{display:block;}",
    "#lc-mini-cal-selection strong{color:#1E293B;}",
    "#lc-mini-cal-selection button{background:none;border:none;color:#B91C1C;font-size:11.5px;",
    "text-decoration:underline;cursor:pointer;margin-left:8px;padding:0;}",
    "#lc-mini-cal-applied{margin-top:6px;font-size:12px;color:#4ADE80;font-weight:600;display:none;}",
    "#lc-mini-cal-applied.lc-mini-active{display:block;}",
    "#lc-mini-cal-loading,#lc-mini-cal-error{padding:20px 0;color:#94A3B8;font-size:13px;}",
    "#lc-mini-cal-error a{color:#C9A227;}",
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
  var byDate = {};
  var minDate = null;
  var maxDate = null;
  var minNights = 2;
  var viewYear, viewMonth;
  var selectedArrival = null;
  var selectedDeparture = null;

  var containerEl, gridEl, monthLabelEl, prevBtn, nextBtn, selectionEl, appliedEl;

  function render() {
    containerEl.innerHTML = "";

    var label = document.createElement("p");
    label.id = "lc-mini-cal-label";
    label.textContent = STR.selectDates;
    containerEl.appendChild(label);

    var navEl = document.createElement("div");
    navEl.id = "lc-mini-cal-nav";
    prevBtn = document.createElement("button");
    prevBtn.className = "lc-mini-nav-btn";
    prevBtn.type = "button";
    prevBtn.textContent = "←";
    prevBtn.setAttribute("aria-label", STR.prevMonth);
    prevBtn.addEventListener("click", function () {
      shiftMonth(-1);
    });
    monthLabelEl = document.createElement("div");
    monthLabelEl.id = "lc-mini-cal-month-label";
    nextBtn = document.createElement("button");
    nextBtn.className = "lc-mini-nav-btn";
    nextBtn.type = "button";
    nextBtn.textContent = "→";
    nextBtn.setAttribute("aria-label", STR.nextMonth);
    nextBtn.addEventListener("click", function () {
      shiftMonth(1);
    });
    navEl.appendChild(prevBtn);
    navEl.appendChild(monthLabelEl);
    navEl.appendChild(nextBtn);
    containerEl.appendChild(navEl);

    gridEl = document.createElement("div");
    gridEl.id = "lc-mini-cal-grid";
    containerEl.appendChild(gridEl);

    var hint = document.createElement("p");
    hint.id = "lc-mini-cal-hint";
    hint.textContent = STR.hint(minNights);
    containerEl.appendChild(hint);

    selectionEl = document.createElement("div");
    selectionEl.id = "lc-mini-cal-selection";
    containerEl.appendChild(selectionEl);

    appliedEl = document.createElement("p");
    appliedEl.id = "lc-mini-cal-applied";
    containerEl.appendChild(appliedEl);

    renderMonth();
    updateSelectionUI();
  }

  function shiftMonth(delta) {
    var d = new Date(Date.UTC(viewYear, viewMonth + delta, 1));
    var candidateEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    if (candidateEnd < minDate || d > maxDate) return;
    viewYear = d.getUTCFullYear();
    viewMonth = d.getUTCMonth();
    renderMonth();
  }

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
      selectedArrival = dateStr;
      selectedDeparture = null;
    } else if (dateStr === selectedArrival) {
      selectedArrival = null;
      selectedDeparture = null;
    } else if (isValidDeparture(selectedArrival, dateStr)) {
      selectedDeparture = dateStr;
    } else {
      selectedArrival = dateStr;
      selectedDeparture = null;
    }

    renderMonth();
    updateSelectionUI();

    // Fewer clicks, per Seni's ask: as soon as both dates are picked, push
    // them straight into the booking widget right away — no separate
    // "apply"/"request" button to click.
    if (selectedArrival && selectedDeparture) {
      applyDatesToWidget(selectedArrival, selectedDeparture);
    }
  }

  function clearSelection() {
    selectedArrival = null;
    selectedDeparture = null;
    appliedEl.className = "";
    appliedEl.textContent = "";
    renderMonth();
    updateSelectionUI();
  }

  function updateSelectionUI() {
    appliedEl.className = "";
    appliedEl.textContent = "";

    if (!selectedArrival) {
      selectionEl.className = "";
      selectionEl.innerHTML = "";
      return;
    }

    if (!selectedDeparture) {
      selectionEl.className = "lc-mini-active";
      selectionEl.innerHTML =
        STR.arrivalPrefix + "<strong>" + formatShort(selectedArrival) + "</strong>" + STR.arrivalSuffix;
      return;
    }

    var nights = nightsBetween(selectedArrival, selectedDeparture);
    var rangeDates = datesInRange(selectedArrival, selectedDeparture);
    var known = rangeDates.map(function (d) { return byDate[d] && byDate[d].rateCents; }).filter(Boolean);
    var totalText = "";
    if (known.length === rangeDates.length) {
      var total = known.reduce(function (sum, c) { return sum + c; }, 0);
      totalText = STR.estTotal(formatMoney(total));
    }

    selectionEl.className = "lc-mini-active";
    selectionEl.innerHTML =
      "<strong>" + formatShort(selectedArrival) + " → " + formatShort(selectedDeparture) + "</strong>" +
      " (" + nights + " " + (nights === 1 ? STR.nightSingular : STR.nightPlural) + ")" + totalText +
      ' <button type="button" id="lc-mini-cal-clear">' + STR.clear + '</button>';
    document.getElementById("lc-mini-cal-clear").addEventListener("click", clearSelection);
  }

  // ---- Wire the selection straight into the OwnerRez widget iframe ----
  function findWidgetIframe() {
    return document.querySelector(WIDGET_IFRAME_SELECTOR);
  }

  function applyDatesToWidget(arrival, departure, attemptsLeft) {
    if (attemptsLeft === undefined) attemptsLeft = 10;
    var iframe = findWidgetIframe();

    if (!iframe || !iframe.src) {
      // The widget's own embed script may not have finished creating the
      // iframe yet (unlikely by the time a visitor has clicked two dates,
      // but cheap to guard against) — retry briefly before giving up.
      if (attemptsLeft > 0) {
        setTimeout(function () {
          applyDatesToWidget(arrival, departure, attemptsLeft - 1);
        }, 300);
        return;
      }
      // Last resort: navigate with the query params so at least the
      // page-load prefill path (documented by OwnerRez) picks them up.
      window.location.href =
        FALLBACK_BASE + "?or_arrival=" + arrival + "&or_departure=" + departure + FALLBACK_ANCHOR;
      return;
    }

    try {
      var url = new URL(iframe.src);
      url.searchParams.set("or_arrival", arrival);
      url.searchParams.set("or_departure", departure);
      iframe.src = url.toString();

      appliedEl.className = "lc-mini-active";
      appliedEl.textContent = STR.appliedBase +
        (widgetIsOffscreen() ? STR.appliedBelow : "") + ".";

      // Courtesy nudge on stacked/mobile layouts where the widget ends up
      // below this calendar — no-op on desktop where it's already visible
      // beside it (block:"nearest" avoids jumping when nothing needs to move).
      var card = document.getElementById(WIDGET_CARD_ID);
      if (card) {
        try {
          card.style.scrollMarginTop = "100px";
          card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } catch (e) {
          /* non-critical */
        }
      }
    } catch (e) {
      appliedEl.className = "";
      appliedEl.textContent = "";
    }
  }

  function widgetIsOffscreen() {
    var card = document.getElementById(WIDGET_CARD_ID);
    if (!card) return false;
    var rect = card.getBoundingClientRect();
    return rect.top > window.innerHeight || rect.bottom < 0;
  }

  function renderMonth() {
    gridEl.innerHTML = "";
    monthLabelEl.textContent = MONTH_LABELS[viewMonth] + " " + viewYear;

    var monthStart = new Date(Date.UTC(viewYear, viewMonth, 1));
    var monthEnd = new Date(Date.UTC(viewYear, viewMonth + 1, 0));
    prevBtn.disabled = new Date(Date.UTC(viewYear, viewMonth, 0)) < minDate;
    nextBtn.disabled = new Date(Date.UTC(viewYear, viewMonth + 1, 1)) > maxDate;

    var rangeDates = selectedArrival && selectedDeparture ? datesInRange(selectedArrival, selectedDeparture) : [];

    WEEKDAY_LABELS.forEach(function (label, i) {
      var el = document.createElement("div");
      el.className = "lc-mini-weekday notranslate";
      el.setAttribute("translate", "no");
      el.textContent = label;
      gridEl.appendChild(el);
    });

    var leadingBlanks = monthStart.getUTCDay();
    for (var b = 0; b < leadingBlanks; b++) {
      var blank = document.createElement("div");
      blank.className = "lc-mini-day lc-mini-empty";
      gridEl.appendChild(blank);
    }

    for (var day = 1; day <= monthEnd.getUTCDate(); day++) {
      var dateObj = new Date(Date.UTC(viewYear, viewMonth, day));
      var dateStr = dateObj.toISOString().slice(0, 10);
      var info = byDate[dateStr];

      var cell = document.createElement("div");
      cell.className = "lc-mini-day";
      if (info) {
        if (dateStr === selectedArrival || dateStr === selectedDeparture) cell.className += " lc-mini-selected";
        else if (rangeDates.indexOf(dateStr) !== -1) cell.className += " lc-mini-in-range";
        else if (info.isToday) cell.className += " lc-mini-today";
        else if (!info.available) cell.className += " lc-mini-booked";
        else cell.className += " lc-mini-available";

        if (info.available) {
          cell.addEventListener("click", (function (d) {
            return function () { handleDayClick(d); };
          })(dateStr));
        }
      }

      var num = document.createElement("div");
      num.className = "lc-mini-day-num";
      num.textContent = String(day);
      cell.appendChild(num);

      if (info) {
        if (!info.available) {
          // Was missing in the first version — booking-calendar.js has
          // this "Booked" label but this compact variant didn't. Seni
          // flagged it should be here too.
          var status = document.createElement("div");
          status.className = "lc-mini-day-status";
          status.textContent = STR.booked;
          cell.appendChild(status);
        } else if (info.rateCents) {
          var rate = document.createElement("div");
          rate.className = "lc-mini-day-rate";
          rate.textContent = formatMoney(info.rateCents);
          cell.appendChild(rate);
        }
      }

      gridEl.appendChild(cell);
    }
  }

  function showLoading() {
    containerEl.innerHTML = '<div id="lc-mini-cal-loading">' + STR.loading + '</div>';
  }

  function showError() {
    containerEl.innerHTML =
      '<div id="lc-mini-cal-error">' + STR.errorHtml(FALLBACK_BASE + FALLBACK_ANCHOR) + '</div>';
  }

  // 2026-08-06: /book-direct/ now 301-redirects to this homepage with a
  // #book-form-card hash (see functions.php's template_redirect hook, added
  // after .htaccess-level redirects turned out to have no effect on this
  // Cloudways stack). The browser's native anchor-scroll fires on initial
  // paint, before *this calendar's own* async availability fetch resolves
  // and swaps "Loading availability…" for the full grid — that swap alone
  // adds a few hundred px of height right in the left column the anchor
  // lives in, on top of whatever above-the-fold images are still loading.
  // A single window "load" + fixed-delay guess (first attempt, same day)
  // undershot by ~2700px in real-world testing because it fired before our
  // OWN content had finished expanding. Re-scrolling right after our own
  // render() call (in addition to a window "load" pass for other page
  // content, plus a couple of trailing timeouts as a final safety net) ties
  // the fix to the actual event that shifts layout instead of a guessed
  // delay. No-op whenever the hash doesn't match.
  function rescrollToCardIfNeeded() {
    if (window.location.hash !== "#" + WIDGET_CARD_ID) return;
    var card = document.getElementById(WIDGET_CARD_ID);
    if (!card) return;
    // 2026-08-06: confirmed live that this site's global CSS sets
    // `html{scroll-behavior:smooth}`, which makes scrollIntoView() animate
    // instead of snapping instantly — and since this function fires from
    // several different trigger points (render completion, window load, a
    // couple of trailing timeouts), each subsequent call was interrupting
    // the previous call's still-in-progress animation, so the page never
    // actually finished settling at the card (confirmed: scrollY stuck at 0
    // for 4+ seconds straight). Forcing instant behavior just for this call,
    // then restoring whatever the page had, makes every call land
    // immediately and deterministically regardless of how many times this
    // runs or how large the jump is.
    var prevBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    card.scrollIntoView({ block: "start" });
    document.documentElement.style.scrollBehavior = prevBehavior;
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
        // The grid just replaced the "Loading…" placeholder — this is the
        // single biggest, most reliable layout-shift point for this section,
        // so rescroll on the next frame once the browser's laid it out.
        requestAnimationFrame(function () {
          requestAnimationFrame(rescrollToCardIfNeeded);
        });
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

  if (window.location.hash === "#" + WIDGET_CARD_ID) {
    if (document.readyState === "complete") {
      setTimeout(rescrollToCardIfNeeded, 300);
    } else {
      window.addEventListener("load", function () {
        setTimeout(rescrollToCardIfNeeded, 300);
      });
    }
    // Trailing safety net for any other slow-loading content (fonts, other
    // widgets on the page) that might still shift things after both of the
    // above have already fired.
    setTimeout(rescrollToCardIfNeeded, 1200);
    setTimeout(rescrollToCardIfNeeded, 2500);
  }
})();
