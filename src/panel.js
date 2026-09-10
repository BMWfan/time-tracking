const $ = (id) => document.getElementById(id);
// Bezeichnungen kommen aus SuccessFactors, nicht aus einer Liste im Code.
const LABELS = {};
const BUSY = new Set(["working", "awaiting-login"]);
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

const auto = new URLSearchParams(location.search).get("auto");
let currentMonday = null;
let weekData = null;
let startTypes = [];
let endType = null;
let places = [];

// ------------------------------------------------------------- Hilfsmittel

const pad = (n) => String(n).padStart(2, "0");

function hm(minutes) {
  const m = Math.max(0, Math.round(minutes));
  return Math.floor(m / 60) + ":" + pad(m % 60);
}

function isoDate(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function mondayOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function muted(text) {
  const el = document.createElement("span");
  el.className = "muted";
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------- Ansichten

const VIEWS = ["today", "week", "settings"];

function showView(name) {
  for (const v of VIEWS) {
    $("view-" + v).hidden = v !== name;
    $("tab-" + v).setAttribute("aria-selected", String(v === name));
  }
  if (name === "week" && !weekData) loadWeek(currentMonday || new Date());
  if (name === "settings") loadSettings();
  fitWindow();
}

for (const v of VIEWS) $("tab-" + v).addEventListener("click", () => showView(v));

// ------------------------------------------------------------------ Status

function renderStatus(st) {
  const { phase, message } = st || {};
  const busy = BUSY.has(phase);
  $("in").disabled = $("out").disabled = busy;
  $("book-all").disabled = busy;

  const box = $("status");
  if (!phase || phase === "idle") {
    box.className = "hidden";
    box.textContent = "";
    return;
  }

  box.className = "";
  box.textContent = "";
  const icon = document.createElement("span");
  const text = document.createElement("span");
  text.textContent = message || "";

  if (phase === "working") {
    icon.className = "spinner";
  } else if (phase === "awaiting-login") {
    icon.className = "spinner";
    box.classList.add("wait");
  } else if (phase === "ok") {
    icon.className = "dot ok";
    icon.textContent = "✓";
    box.classList.add("ok");
  } else {
    icon.className = "dot err";
    icon.textContent = "!";
    box.classList.add("err");
  }
  box.append(icon, text);

  if (phase === "awaiting-login") {
    const jump = document.createElement("button");
    jump.className = "link";
    jump.textContent = "Zum Login";
    jump.addEventListener("click", () => chrome.runtime.sendMessage({ action: "focus-login" }));
    box.append(jump);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.action === "state") renderStatus(msg.state);
});

// ------------------------------------------------------------------- Heute

function renderToday(day) {
  const box = $("today");
  box.textContent = "";
  if (!day) {
    box.append(muted("Heutige Buchungen nicht abrufbar"));
    return;
  }
  if (!day.events.length) {
    box.append(muted("Heute noch keine Buchung."));
    return;
  }

  for (const ev of day.events) {
    const row = document.createElement("div");
    row.className = "ev";
    const time = document.createElement("b");
    time.textContent = ev.time;
    const name = document.createElement("span");
    name.textContent = LABELS[ev.type] || ev.type;
    row.append(time, name);
    box.append(row);
  }

  if (day.recordedMinutes == null) return;

  const total = document.createElement("div");
  total.className = "ev total";
  const value = document.createElement("b");
  value.textContent = hm(day.recordedMinutes);
  const note = document.createElement("span");
  // Spanne minus bewertete Zeit: Mittagspause plus etwaige Unterbrechungen.
  const deducted = day.spanMinutes != null ? day.spanMinutes - day.recordedMinutes : null;
  note.textContent = deducted && deducted > 0 ? "erfasst — " + deducted + " min abgezogen" : "erfasst";
  total.append(value, note);
  box.append(total);

  if (day.plannedMinutes) {
    const diff = day.recordedMinutes - day.plannedMinutes;
    const row = document.createElement("div");
    row.className = "ev";
    row.append(muted("Soll " + hm(day.plannedMinutes)), muted((diff >= 0 ? "+" : "−") + hm(Math.abs(diff))));
    box.append(row);
  }
}

function applyWeek(week, { renderTodayToo = true } = {}) {
  weekData = week;
  if (week && week.ok) {
    currentMonday = new Date(week.monday + "T00:00:00");
    if (renderTodayToo) {
      const today = isoDate(new Date());
      const day = week.days.find((d) => d.date === today);
      if (day) {
        renderToday(day);
        // Vorschlag aus Home Assistant übernehmen, solange nichts gewählt wurde.
        if (places.length && !$("placeOfWork").value) {
          fillPlaceSelect($("placeOfWork"), day.placeId || day.suggestPlaceId || "");
        }
      }
    }
    renderWeek(week);
  } else {
    $("today").textContent = "";
    $("today").append(muted((week && week.msg) || "Nicht abrufbar"));
    $("week-body").textContent = "";
    $("week-body").append(muted((week && week.msg) || "Nicht abrufbar"));
  }
}

function loadWeek(anyDate, wait = false) {
  const target = anyDate || new Date();
  $("week-body").textContent = "";
  $("week-body").append(muted("Lade Woche …"));
  chrome.runtime.sendMessage({ action: "week", date: isoDate(new Date(target)), wait }, applyWeek);
}

// Füllt ein <select> mit den für den Nutzer zulässigen Kommen-Typen.
function fillTypeSelect(select, selected) {
  select.textContent = "";
  for (const t of startTypes) {
    const opt = document.createElement("option");
    opt.value = t.code;
    opt.textContent = t.name;
    if (t.code === selected) opt.selected = true;
    select.append(opt);
  }
}

// Tätigkeitsstätten; leerer Eintrag heißt "nicht setzen".
function fillPlaceSelect(select, selectedId) {
  select.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "— keine Angabe —";
  select.append(none);
  for (const p of places) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    if (String(p.id) === String(selectedId)) opt.selected = true;
    select.append(opt);
  }
}

function book(kind) {
  const type = kind === "in" ? $("startType").value || null : null;
  const placeId = kind === "out" ? $("placeOfWork").value || null : null;
  chrome.runtime.sendMessage({ action: "book", kind, type, placeId, time: $("time").value || null }, (res) => {
    if (!res || !res.ok) return;
    // Beim Ausstempeln liegt die bewertete Woche schon bei; sonst nachladen.
    if (res.week) applyWeek(res.week);
    else loadWeek(new Date());
    // Nach dem Ausstempeln bleibt das Fenster stehen, damit die Tagessumme lesbar ist.
    if (auto && kind !== "out") setTimeout(() => window.close(), 2500);
  });
}

$("in").addEventListener("click", () => book("in"));
$("out").addEventListener("click", () => book("out"));

// Die zuletzt gewählte Art merken, damit Tastenkürzel und Verknüpfungen sie nutzen.
$("startType").addEventListener("change", () => {
  chrome.runtime.sendMessage({ action: "set-start-type", type: $("startType").value });
});

// -------------------------------------------------------------- Nachtragen

// Nachtragbar ist jeder Arbeitstag ohne Buchung — auch der heutige, etwa wenn
// man das Gebäude längst verlassen hat und die Zone nicht mehr greift.
function isOpen(day) {
  return (
    (day.isPast || day.isToday) &&
    day.isWorkingDay &&
    day.isMaintainable !== false &&
    !day.holiday &&
    !day.absences &&
    day.events.length === 0
  );
}

function nowHm() {
  const d = new Date();
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function suggestion(day, cfgFallback) {
  // Für heute ist die aktuelle Uhrzeit die bessere Annahme als eine Standard-Endzeit.
  const fallbackOut = day.isToday ? nowHm() : cfgFallback.out;
  return {
    in: day.suggestIn || cfgFallback.in,
    out: day.suggestOut || fallbackOut,
    fromHa: Boolean(day.suggestIn || day.suggestOut)
  };
}

let fallback = { in: "08:00", out: "16:45" };
let fallbackType = "";

// Auswahl plus Speichern für die Tätigkeitsstätte eines gebuchten Tages.
function placeEditor(day, selectedId) {
  const fields = document.createElement("div");
  fields.className = "day-fields";

  const place = document.createElement("select");
  fillPlaceSelect(place, selectedId);

  const save = document.createElement("button");
  save.textContent = "Ort sichern";
  save.addEventListener("click", () => {
    save.disabled = true;
    chrome.runtime.sendMessage(
      { action: "set-place", date: day.date, placeId: place.value || null },
      () => loadWeek(currentMonday)
    );
  });

  fields.append(place, save);
  return fields;
}

function renderWeek(week) {
  const body = $("week-body");
  body.textContent = "";

  const monday = new Date(week.monday + "T00:00:00");
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const fmt = (d) => pad(d.getDate()) + "." + pad(d.getMonth() + 1) + ".";
  $("week-label").textContent =
    fmt(monday) + "–" + fmt(sunday) + (week.approvalStatus ? " · " + week.approvalStatus : "");

  let openCount = 0;

  for (const day of week.days) {
    const date = new Date(day.date + "T00:00:00");
    const wrap = document.createElement("div");
    wrap.className = "day";

    const head = document.createElement("div");
    head.className = "day-head";
    const title = document.createElement("b");
    title.textContent = WEEKDAYS[(date.getDay() + 6) % 7] + ", " + fmt(date);
    const tag = document.createElement("span");
    tag.className = "tag";

    // Ein Tag, dessen letztes Ereignis kein Ende ist, hängt offen.
    const last = day.events[day.events.length - 1];
    const needsEnd = Boolean(last) && Boolean(endType) && last.type !== endType;

    if (day.holiday) tag.textContent = day.holiday;
    else if (!day.isWorkingDay) tag.textContent = "kein Arbeitstag";
    else if (day.absences) tag.textContent = "Abwesenheit";
    else if (needsEnd) tag.textContent = "Ende fehlt";
    else if (day.events.length) tag.textContent = day.recordedMinutes ? hm(day.recordedMinutes) + " erfasst" : "gebucht";
    else if (day.isToday) tag.textContent = "heute · nicht gebucht";
    else if (!day.isPast) tag.textContent = "offen";
    else tag.textContent = "nicht gebucht";

    head.append(title, tag);
    wrap.append(head);

    if (day.events.length) {
      wrap.classList.add("done");
      const times = document.createElement("div");
      times.className = "src";
      times.textContent = day.events.map((e) => e.time + " " + (LABELS[e.type] || e.type)).join("  ·  ");
      wrap.append(times);

      if (needsEnd) {
        // Offener Tag: nur das Ende fehlt noch.
        const fields = document.createElement("div");
        fields.className = "day-fields";

        // Das Ende muss nach dem letzten Stempel liegen, sonst lässt sich das
        // Paar nicht bilden.
        const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
        const after = (t) => t && toMin(t) > toMin(last.time);
        const proposed = [day.suggestOut, day.isToday ? nowHm() : fallback.out].find(after) || last.time;

        const to = document.createElement("input");
        to.type = "time";
        to.step = 60;
        to.value = proposed;
        to.min = last.time;

        const go = document.createElement("button");
        go.textContent = "Ende buchen";
        go.addEventListener("click", () => {
          go.disabled = true;
          chrome.runtime.sendMessage(
            {
              action: "book-days",
              items: [{ date: day.date, out: to.value, placeId: day.suggestPlaceId || null }]
            },
            () => loadWeek(currentMonday, true)
          );
        });

        fields.append(to, go);
        wrap.append(fields);
        wrap.classList.remove("done");
      }

      if (day.placeId) {
        // Gesetzter Ort wird angezeigt; das Stiftsymbol öffnet die Korrektur.
        const hit = places.find((p) => String(p.id) === String(day.placeId));
        const line = document.createElement("div");
        line.className = "src place-line";

        const label = document.createElement("span");
        label.textContent = hit ? hit.label : "Tätigkeitsstätte gesetzt";

        const edit = document.createElement("button");
        edit.className = "icon-btn";
        edit.title = "Tätigkeitsstätte ändern";
        edit.setAttribute("aria-label", "Tätigkeitsstätte ändern");
        edit.textContent = "✎";
        edit.addEventListener("click", () => {
          line.replaceWith(placeEditor(day, day.placeId));
        });

        line.append(label, edit);
        wrap.append(line);
      } else if (day.hasAttendance) {
        // Noch kein Ort hinterlegt: nachtragbar.
        wrap.append(placeEditor(day, day.suggestPlaceId || ""));
      }
    } else if (isOpen(day)) {
      openCount++;
      const s = suggestion(day, fallback);

      const fields = document.createElement("div");
      fields.className = "day-fields";

      const type = document.createElement("select");
      type.dataset.role = "type";
      fillTypeSelect(type, day.suggestType || fallbackType);

      const place = document.createElement("select");
      place.dataset.role = "place";
      fillPlaceSelect(place, day.suggestPlaceId || "");

      const from = document.createElement("input");
      from.type = "time";
      from.step = 60;
      from.value = s.in;
      from.dataset.role = "in";

      const to = document.createElement("input");
      to.type = "time";
      to.step = 60;
      to.value = s.out;
      to.dataset.role = "out";

      const go = document.createElement("button");
      go.textContent = "Übernehmen";
      go.addEventListener("click", () => {
        chrome.runtime.sendMessage(
          {
            action: "book-days",
            items: [
              { date: day.date, in: from.value, out: to.value, type: type.value, placeId: place.value || null }
            ]
          },
          () => loadWeek(currentMonday, true)
        );
      });

      fields.append(type, place, from, to, go);
      wrap.append(fields);
      wrap.dataset.date = day.date;

      const src = document.createElement("div");
      src.className = "src";
      src.textContent = s.fromHa
        ? day.suggestZone
          ? "Aus Home Assistant · " + day.suggestZone.replace(/\s*\([^)]*\)\s*$/, "")
          : "Vorschlag aus Home Assistant"
        : "Vorschlag: Standardzeiten";
      wrap.append(src);
    }

    body.append(wrap);
  }

  $("book-all").hidden = openCount === 0;
  $("week-hint").textContent = week.haOk === false && openCount
    ? week.haMsg + " — es werden Standardzeiten vorgeschlagen."
    : "";
  fitWindow();
}

$("prev-week").addEventListener("click", () => {
  const d = new Date(currentMonday || new Date());
  d.setDate(d.getDate() - 7);
  loadWeek(d);
});
$("next-week").addEventListener("click", () => {
  const d = new Date(currentMonday || new Date());
  d.setDate(d.getDate() + 7);
  loadWeek(d);
});

$("book-all").addEventListener("click", () => {
  const items = [...document.querySelectorAll(".day[data-date]")].map((el) => ({
    date: el.dataset.date,
    in: el.querySelector('input[data-role="in"]').value,
    out: el.querySelector('input[data-role="out"]').value,
    type: el.querySelector('select[data-role="type"]').value,
    placeId: el.querySelector('select[data-role="place"]').value || null
  }));
  if (!items.length) return;
  chrome.runtime.sendMessage({ action: "book-days", items }, () => loadWeek(currentMonday, true));
});

// ----------------------------------------------------------- Einstellungen

const SETTING_IDS = ["haUrl", "haToken", "haEntity", "haZone", "assignmentId"];

function loadSettings() {
  chrome.runtime.sendMessage({ action: "get-settings" }, (cfg) => {
    if (!cfg) return;
    for (const id of SETTING_IDS) $(id).value = cfg[id] || "";
    fallback = { in: cfg.fallbackIn || "08:00", out: cfg.fallbackOut || "16:45" };
    fallbackType = cfg.startType || (startTypes[0] && startTypes[0].code) || "";
    fillTypeSelect($("startType"), fallbackType);
    fillTypeSelect($("defaultStartType"), fallbackType);
    fillPlaceSelect($("legacyPlaceId"), cfg.legacyPlaceId || "");
  });
}

function loadTypes() {
  chrome.runtime.sendMessage({ action: "types" }, (res) => {
    startTypes = (res && res.types) || [];
    endType = (res && res.endType) || null;
    for (const t of startTypes) LABELS[t.code] = t.name;
    if (endType) LABELS[endType] = "Ende";
    chrome.runtime.sendMessage({ action: "places" }, (r2) => {
      places = (r2 && r2.places) || [];
      fillPlaceSelect($("placeOfWork"), "");
      loadSettings();
      if (weekData && weekData.ok) renderWeek(weekData);
    });
  });
}

$("save-settings").addEventListener("click", async () => {
  const values = {};
  for (const id of SETTING_IDS) values[id] = $(id).value.trim();
  if ($("defaultStartType").value) values.startType = $("defaultStartType").value;
  values.legacyPlaceId = $("legacyPlaceId").value || "";

  // Zugriff auf die Home-Assistant-Adresse muss der Nutzer ausdrücklich erlauben.
  if (values.haUrl) {
    try {
      const origin = new URL(values.haUrl).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        renderStatus({ phase: "error", message: "Zugriff auf Home Assistant nicht erlaubt" });
        return;
      }
    } catch {
      renderStatus({ phase: "error", message: "Ungültige Home-Assistant-Adresse" });
      return;
    }
  }

  chrome.runtime.sendMessage({ action: "set-settings", values }, () => {
    renderStatus({ phase: "ok", message: "Einstellungen gespeichert" });
    weekData = null;
  });
});

// ------------------------------------------------------- Fenstergroesse

// chrome.windows rechnet in Bildschirmpixeln, das Layout in CSS-Pixeln. Bei
// Windows-Skalierung über 100 % fallen die auseinander, deshalb messen wir den
// Inhalt und rechnen mit devicePixelRatio um.
let fitTimer = null;

function fitWindow() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    const ratio = window.devicePixelRatio || 1;
    const frameW = window.outerWidth - window.innerWidth;
    const frameH = window.outerHeight - window.innerHeight;
    const cssW = document.documentElement.scrollWidth + frameW;
    const cssH = document.documentElement.scrollHeight + frameH;

    const width = Math.min(Math.round(cssW * ratio) + 2, screen.availWidth);
    const height = Math.min(Math.round(cssH * ratio) + 2, screen.availHeight);

    chrome.windows.getCurrent((win) => {
      if (!win || win.id == null) return;
      if (Math.abs(win.width - width) < 4 && Math.abs(win.height - height) < 4) return;
      chrome.windows.update(win.id, { width, height });
    });
  }, 120);
}

// ------------------------------------------------------------------- Start

chrome.runtime.sendMessage({ action: "get-state" }, (st) => {
  renderStatus(st);
  if ((auto === "in" || auto === "out") && !BUSY.has(st && st.phase)) book(auto);
});

loadTypes();
loadWeek(new Date());
window.addEventListener("load", fitWindow);
fitWindow();
