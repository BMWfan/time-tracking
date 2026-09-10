const $ = (id) => document.getElementById(id);
// Bezeichnungen kommen aus SuccessFactors, nicht aus einer Liste im Code.
const LABELS = {};
const BUSY = new Set(["working", "awaiting-login"]);
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

const auto = new URLSearchParams(location.search).get("auto");
let currentMonday = null;
let weekData = null;
let startTypes = [];
let typeReason = null;
let endType = null;
let places = [];
let placeReason = null;

// ------------------------------------------------------------- Hilfsmittel

// Anfrage an den Dienst mit Zeitgrenze. Wird der Service Worker mitten in der
// Bearbeitung beendet, bleibt die Antwort sonst aus und das Fenster hängt.
function ask(message, onDone, timeoutMs = 25000) {
  let settled = false;
  const finish = (res) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onDone(res);
  };
  const timer = setTimeout(
    () => finish({ ok: false, msg: "Zeitüberschreitung — erneut versuchen" }),
    timeoutMs
  );
  chrome.runtime.sendMessage(message, (res) => {
    if (chrome.runtime.lastError) {
      finish({ ok: false, msg: "Verbindung zum Dienst abgebrochen — erneut versuchen" });
      return;
    }
    finish(res);
  });
}

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

// Erfolg und Fehler sind Rückmeldungen zu einer Handlung, keine Zustände —
// sie verschwinden von selbst wieder.
let statusTimer = null;

function renderStatus(st) {
  const { phase, message } = st || {};
  const busy = BUSY.has(phase);
  $("in").disabled = $("out").disabled = busy;
  $("book-all").disabled = busy;

  clearTimeout(statusTimer);

  const box = $("status");
  if (!phase || phase === "idle") {
    box.className = "hidden";
    box.textContent = "";
    return;
  }

  if (phase === "ok" || phase === "error") {
    statusTimer = setTimeout(() => renderStatus({ phase: "idle" }), phase === "ok" ? 5000 : 12000);
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
  ask({ action: "week", date: isoDate(new Date(target)), wait }, applyWeek, wait ? 40000 : 25000);
}

// Füllt ein <select> mit den für den Nutzer zulässigen Kommen-Typen. Ist die
// Liste leer, steht der Grund im Menü — ein leeres Menü erklärt sich nicht.
function fillTypeSelect(select, selected) {
  select.textContent = "";
  if (!startTypes.length) {
    const hint = document.createElement("option");
    hint.value = "";
    hint.disabled = true;
    hint.selected = true;
    hint.textContent = "— " + (typeReason || "keine Typen abrufbar") + " —";
    select.append(hint);
    return;
  }
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
  // Ohne abrufbare Liste erklärt der Eintrag, woran es liegt.
  none.textContent = places.length
    ? "— keine Angabe —"
    : "— " + (placeReason || "Tätigkeitsstätten nicht abrufbar") + " —";
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
  ask({ action: "book", kind, type, placeId, time: $("time").value || null }, (res) => {
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

// Formular zum Bearbeiten eines gebuchten Tages: jedes Zeitereignis eine
// Zeile mit Uhrzeit, Art und Papierkorb, dazu die Tätigkeitsstätte. Gespeichert
// wird der Tag als Ganzes — SuccessFactors erlaubt kein Ändern einzelner
// Ereignisse, also löscht der Dienst sie und legt die verbliebenen neu an.
function dayEditor(day, onCancel) {
  const box = document.createElement("div");
  const rows = document.createElement("div");
  box.append(rows);

  function addRow(time, type) {
    const row = document.createElement("div");
    row.className = "day-fields";

    const when = document.createElement("input");
    when.type = "time";
    when.step = 60;
    when.value = time || "";
    when.dataset.role = "time";

    const kind = document.createElement("select");
    kind.dataset.role = "type";
    fillTypeSelect(kind, type || fallbackType);

    const drop = document.createElement("button");
    drop.className = "icon-btn danger";
    drop.title = "Zeitereignis entfernen";
    drop.setAttribute("aria-label", "Zeitereignis entfernen");
    drop.textContent = "✕";
    drop.addEventListener("click", () => {
      row.remove();
      fitWindow();
    });

    row.append(when, kind, drop);
    rows.append(row);
  }

  for (const ev of day.events) addRow(ev.time, ev.type);

  const add = document.createElement("button");
  add.className = "link";
  add.textContent = "Zeitereignis hinzufügen";
  add.addEventListener("click", () => {
    addRow("", fallbackType);
    fitWindow();
  });

  // Ein Ort je Erfassungssatz: ein halber Tag Homeoffice und ein halber im
  // Büro sind zwei Sätze mit zwei verschiedenen Stätten.
  const placeBox = document.createElement("div");
  const ranges = day.attendances && day.attendances.length
    ? day.attendances
    : [{ start: null, end: null, placeId: day.placeId || day.suggestPlaceId || null }];

  for (const range of ranges) {
    const label = document.createElement("div");
    label.className = "src";
    label.textContent = range.start
      ? "Tätigkeitsstätte " + range.start + "–" + range.end
      : "Tätigkeitsstätte";
    const select = document.createElement("select");
    select.dataset.role = "place";
    fillPlaceSelect(select, range.placeId || day.suggestPlaceId || "");
    placeBox.append(label, select);
  }

  const actions = document.createElement("div");
  actions.className = "day-fields";
  const save = document.createElement("button");
  save.textContent = "Speichern";
  const cancel = document.createElement("button");
  cancel.className = "link";
  cancel.textContent = "Abbrechen";
  cancel.addEventListener("click", onCancel);

  save.addEventListener("click", () => {
    const events = [...rows.querySelectorAll(".day-fields")].map((row) => ({
      time: row.querySelector('input[data-role="time"]').value,
      type: row.querySelector('select[data-role="type"]').value
    }));

    if (events.some((e) => !e.time || !e.type)) {
      renderStatus({ phase: "error", message: "Jede Zeile braucht Uhrzeit und Art" });
      return;
    }
    if (!events.length && !confirm("Alle Zeitereignisse dieses Tages löschen?")) return;

    const placeIds = [...placeBox.querySelectorAll('select[data-role="place"]')].map(
      (el) => el.value || null
    );

    save.disabled = true;
    ask(
      { action: "replace-day", day: { date: day.date, events, placeIds } },
      (res) => {
        save.disabled = false;
        if (res && res.week) applyWeek(res.week);
        else loadWeek(currentMonday, true);
      },
      90000
    );
  });

  actions.append(save, cancel);
  box.append(add, placeBox, actions);
  return box;
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
    // Ein offenes Kommen erkennt man auch ohne Typenliste: Ereignisse treten
    // paarweise auf, eine ungerade Anzahl heißt, das Gehen fehlt.
    const needsEnd = Boolean(last) &&
      (endType ? last.type !== endType : day.events.length % 2 === 1);

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
          ask(
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

      // Der Stift öffnet den ganzen Tag zum Bearbeiten — Zeiten, Art, Ort.
      const line = document.createElement("div");
      line.className = "src place-line";

      const label = document.createElement("span");
      const hit = places.find((p) => String(p.id) === String(day.placeId));
      label.textContent = day.placeId
        ? hit
          ? hit.label
          : "Tätigkeitsstätte gesetzt"
        : "Ohne Tätigkeitsstätte";

      const edit = document.createElement("button");
      edit.className = "icon-btn";
      edit.title = "Tag bearbeiten";
      edit.setAttribute("aria-label", "Tag bearbeiten");
      edit.textContent = "✎";
      edit.addEventListener("click", () => {
        const editor = dayEditor(day, () => editor.replaceWith(line));
        line.replaceWith(editor);
        fitWindow();
      });

      line.append(label, edit);
      wrap.append(line);
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
        ask(
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
      if (day.gapMinutes) {
        // Vor der ersten Ankunft fehlten Meldungen — der Wert kann zu spät sein.
        src.classList.add("warn");
        src.textContent =
          "Unsicher: ab " + day.gapFrom + " für " + hm(day.gapMinutes) +
          " Stunden keine Standortmeldung — Ankunft womöglich früher";
      } else {
        src.textContent = s.fromHa
          ? day.suggestZone
            ? "Aus Home Assistant · " + day.suggestZone.replace(/\s*\([^)]*\)\s*$/, "")
            : "Vorschlag aus Home Assistant"
          : "Vorschlag: Standardzeiten";
      }
      wrap.append(src);
    }

    body.append(wrap);
  }

  $("book-all").hidden = openCount === 0;
  // Nur melden, wenn die Anbindung aktiv ist und trotzdem nichts liefert.
  $("week-hint").textContent =
    week.haOk === false && !week.haOff && week.haMsg && openCount
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
  ask(
            {
              action: "book-days", items }, () => loadWeek(currentMonday, true));
});

// ----------------------------------------------------------- Einstellungen

const SETTING_IDS = [
  "brandName", "assignmentId", "fallbackIn", "fallbackOut",
  "haUrl", "haToken", "haEntity", "haZone"
];

const OTHER_HOST = "__other__";

// Auswahl der Instanz: gefundene Adressen aus offenen Tabs, der gespeicherte
// Wert und ein Eintrag für freie Eingabe.
function fillHostSelect(hosts, selected) {
  const select = $("sfHost");
  select.textContent = "";

  const known = [...new Set([...hosts, selected].filter(Boolean))].sort();
  for (const host of known) {
    const opt = document.createElement("option");
    opt.value = host;
    opt.textContent = host;
    if (host === selected) opt.selected = true;
    select.append(opt);
  }

  const other = document.createElement("option");
  other.value = OTHER_HOST;
  other.textContent = "Andere Adresse eingeben …";
  if (!known.length) other.selected = true;
  select.append(other);

  syncHostField();
}

function syncHostField() {
  const custom = $("sfHost").value === OTHER_HOST;
  $("sfHostCustom").hidden = !custom;
  if (custom) $("sfHostCustom").focus();
  fitWindow();
}

function chosenHost() {
  const value = $("sfHost").value;
  if (value !== OTHER_HOST) return value;
  return $("sfHostCustom").value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

$("sfHost").addEventListener("change", syncHostField);

function syncHaFields() {
  $("ha-fields").hidden = !$("haEnabled").checked;
  fitWindow();
}

$("haEnabled").addEventListener("change", syncHaFields);

function loadSettings() {
  chrome.runtime.sendMessage({ action: "get-settings" }, (cfg) => {
    if (!cfg) return;
    for (const id of SETTING_IDS) $(id).value = cfg[id] || "";
    $("haEnabled").checked = Boolean(cfg.haEnabled);
    syncHaFields();
    brandIcon = cfg.brandIcon || "";
    renderBrand(cfg.brandName, brandIcon);
    chrome.runtime.sendMessage({ action: "sf-hosts" }, (res) =>
      fillHostSelect((res && res.hosts) || [], cfg.sfHost)
    );
    fallback = { in: cfg.fallbackIn || "08:00", out: cfg.fallbackOut || "16:45" };
    fallbackType = cfg.startType || (startTypes[0] && startTypes[0].code) || "";
    fillTypeSelect($("startType"), fallbackType);
    fillTypeSelect($("defaultStartType"), fallbackType);
    fillPlaceSelect($("legacyPlaceId"), cfg.legacyPlaceId || "");
  });
}

function loadTypes() {
  renderStatus({ phase: "working", message: "Lade Daten aus SuccessFactors …" });
  ask({ action: "types" }, (res) => {
    startTypes = (res && res.types) || [];
    typeReason = (res && (res.reason || res.msg)) || null;
    endType = (res && res.endType) || null;
    for (const t of startTypes) LABELS[t.code] = t.name;
    if (endType) LABELS[endType] = "Ende";
    ask({ action: "places" }, (r2) => {
      places = (r2 && r2.places) || [];
      placeReason = (r2 && (r2.reason || r2.msg)) || null;
      fillPlaceSelect($("placeOfWork"), "");
      loadSettings();
      if (weekData && weekData.ok) renderWeek(weekData);

      const problem = typeReason || placeReason;
      renderStatus(problem ? { phase: "error", message: problem } : { phase: "idle" });
    });
  });
}

$("save-settings").addEventListener("click", async () => {
  const values = {};
  for (const id of SETTING_IDS) values[id] = $(id).value.trim();
  if ($("defaultStartType").value) values.startType = $("defaultStartType").value;
  values.legacyPlaceId = $("legacyPlaceId").value || "";
  values.haEnabled = $("haEnabled").checked;
  values.brandIcon = brandIcon;

  const host = chosenHost();
  if (!host || !/successfactors\.(eu|com)$/i.test(host)) {
    renderStatus({ phase: "error", message: "SuccessFactors-Adresse fehlt oder passt nicht" });
    return;
  }
  values.sfHost = host;

  if (values.haEnabled && (!values.haUrl || !values.haToken)) {
    renderStatus({ phase: "error", message: "Für Home Assistant fehlen Adresse oder Token" });
    return;
  }

  // Zugriff auf die Home-Assistant-Adresse muss der Nutzer ausdrücklich erlauben.
  if (values.haEnabled && values.haUrl) {
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
    renderBrand(values.brandName, brandIcon);
    chrome.runtime.sendMessage({ action: "brand-changed" });
    weekData = null;
  });
});

// ---------------------------------------------------------- Darstellung

// Eigenes Symbol: auf 128 × 128 verkleinern und als Data-URI ablegen. So bleibt
// der Browser-Speicher klein und das Bild in jeder Größe brauchbar.
function toIconDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Bild nicht lesbar"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Bildformat nicht unterstützt"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const ctx = canvas.getContext("2d");
        // Quadratischer Ausschnitt aus der Mitte, damit nichts verzerrt.
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

let brandIcon = "";

// Setzt **Text** fett und trennt an | in Wortmarke und kleineren Titel.
// Aufgebaut wird über Textknoten, damit aus der Einstellung kein Markup
// in die Seite gelangt.
function appendMarkup(target, text) {
  for (const part of String(text).split(/(\*\*[^*]+\*\*)/)) {
    if (!part) continue;
    const bold = part.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      const b = document.createElement("b");
      b.textContent = bold[1];
      target.append(b);
    } else {
      target.append(document.createTextNode(part));
    }
  }
}

function renderBrand(name, icon) {
  const raw = name || "Time Tracking";
  const [left, right] = raw.split("|");

  const h1 = $("brand-name");
  h1.textContent = "";
  const wordmark = document.createElement("span");
  wordmark.className = "wm";
  appendMarkup(wordmark, left.trim());
  h1.append(wordmark);

  if (right && right.trim()) {
    const rule = document.createElement("span");
    rule.className = "rule";
    rule.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "title";
    appendMarkup(title, right.trim());
    h1.append(rule, title);
  }

  // Favicon steuert Titelzeile und Taskleiste. Ein blosses Ändern von href
  // greift nicht zuverlässig — der Knoten muss ersetzt werden.
  const old = $("favicon");
  const link = document.createElement("link");
  link.id = "favicon";
  link.rel = "icon";
  link.type = "image/png";
  link.href = icon || "icons/128.png";
  old.replaceWith(link);

  const preview = $("brand-preview");
  preview.textContent = "";
  if (icon) {
    const mark = document.createElement("img");
    mark.src = icon;
    mark.alt = "";
    $("brand-mark").replaceChildren(mark.cloneNode());
    preview.append(mark);
  }
  document.title = raw.replace(/\*\*/g, "").replace(/\s*\|\s*/, " · ");
}

$("brand-pick").addEventListener("click", () => $("brandIconFile").click());

$("brandIconFile").addEventListener("change", async () => {
  const file = $("brandIconFile").files[0];
  if (!file) return;
  try {
    brandIcon = await toIconDataUrl(file);
    renderBrand($("brandName").value, brandIcon);
    renderStatus({ phase: "ok", message: "Symbol gewählt — jetzt speichern" });
  } catch (err) {
    renderStatus({ phase: "error", message: String(err.message || err) });
  }
});

$("brand-reset").addEventListener("click", () => {
  brandIcon = "";
  $("brand-preview").textContent = "";
  renderStatus({ phase: "ok", message: "Symbol zurückgesetzt — jetzt speichern" });
});

// ----------------------------------------------------------- Aktualisierung

function renderUpdate(info) {
  if (!info) return;
  $("version-line").textContent = "Version " + (info.current || "—");

  const hint = $("update-hint");
  hint.textContent = "";
  hint.className = "hint";

  if (info.error) {
    hint.textContent = "Prüfung fehlgeschlagen: " + info.error;
    hint.classList.add("err");
  } else if (info.newer) {
    const text = document.createElement("span");
    text.textContent = "Version " + info.latest + " ist verfügbar. ";
    const link = document.createElement("button");
    link.className = "link";
    link.textContent = "Release öffnen";
    link.addEventListener("click", () => chrome.tabs.create({ url: info.url }));
    hint.append(text, link);
  } else if (info.latest) {
    hint.textContent = "Aktuellste Version installiert.";
  }
  fitWindow();
}

// Holt Zeitereignistypen und Tätigkeitsstätten erneut — nötig, wenn beim
// Öffnen des Fensters keine angemeldete SuccessFactors-Sitzung bestand.
$("refresh-lists").addEventListener("click", () => {
  renderStatus({ phase: "working", message: "Lade Listen …" });
  ask({ action: "refresh-lists" }, (res) => {
    startTypes = (res && res.types) || [];
    typeReason = (res && res.typeReason) || null;
    endType = (res && res.endType) || null;
    places = (res && res.places) || [];
    placeReason = (res && res.placeReason) || null;

    for (const t of startTypes) LABELS[t.code] = t.name;
    if (endType) LABELS[endType] = "Ende";

    fillTypeSelect($("startType"), fallbackType);
    fillTypeSelect($("defaultStartType"), fallbackType);
    fillPlaceSelect($("placeOfWork"), "");
    fillPlaceSelect($("legacyPlaceId"), "");

    const problem = typeReason || placeReason;
    renderStatus(
      problem
        ? { phase: "error", message: problem }
        : { phase: "ok", message: startTypes.length + " Typen, " + places.length + " Orte geladen" }
    );
    weekData = null;
    if (!$("view-week").hidden) loadWeek(currentMonday);
  });
});

$("check-update").addEventListener("click", () => {
  $("update-hint").textContent = "Prüfe …";
  ask({ action: "check-update" }, renderUpdate, 15000);
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
  // Eine abgeschlossene Meldung von vorhin gehört nicht in ein frisches Fenster.
  const stale =
    st && (st.phase === "ok" || st.phase === "error") && Date.now() - (st.updatedAt || 0) > 30000;
  renderStatus(stale ? { phase: "idle" } : st);
  if ((auto === "in" || auto === "out") && !BUSY.has(st && st.phase)) book(auto);
});

loadTypes();
loadWeek(new Date());
window.addEventListener("load", fitWindow);
fitWindow();
