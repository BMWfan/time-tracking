// Die Instanz haengt am Rechenzentrum des Mandanten - DC1 heisst
// performancemanager.successfactors.eu, andere tragen eine Ziffer oder liegen
// auf .com. Deshalb ist der Host eine Einstellung; hier steht nur der
// haeufigste Standard.
const SF_GLOBS = ["https://*.successfactors.eu/*", "https://*.successfactors.com/*"];
// Der stille SSO-Durchlauf dauert Sekunden. Muss der Nutzer selbst anmelden,
// darf das dauern - deshalb der grosszuegige Rahmen statt eines Abbruchs.
// Innerhalb einer Anfrage aus dem Fenster darf nicht lange gewartet werden:
// Der Service Worker wird nach kurzer Untätigkeit beendet, und dann bleibt die
// Antwort aus und das Fenster hängt. Also kurz warten und sonst melden, dass
// eine Anmeldung offen ist — der Nutzer versucht es danach erneut.
const LOGIN_TIMEOUT_MS = 20 * 1000;

// Zeitereignistypen sind je Mandant konfiguriert. Sie werden zur Laufzeit aus
// SuccessFactors gelesen; im Code steht keine Liste. Erkannt wird lediglich,
// welcher Typ das Gehen ist und welcher Homeoffice bedeutet.
const END_PATTERN = /(^|_)end$|^ende$/i;
const HOMEOFFICE_PATTERN = /home.?office/i;

const DEFAULTS = {
  // Darstellung. Liegt im Browser-Speicher und wird von einem Update nicht
  // angefasst — eine eigene Bezeichnung und ein eigenes Symbol bleiben also
  // erhalten, während die Erweiterung selbst neutral ausgeliefert wird.
  brandName: "Time Tracking",
  brandIcon: "",
  sfHost: "performancemanager.successfactors.eu",
  // Personalnummer der Zuordnung; ohne sie kann nicht gebucht werden.
  assignmentId: "",
  startType: "",
  // Die Home-Assistant-Anbindung ist optional und standardmäßig aus. Ohne sie
  // arbeitet die Erweiterung mit Standardzeiten, die von Hand angepasst werden.
  haEnabled: false,
  haUrl: "",
  haToken: "",
  haEntity: "",
  // Zonenname ohne Code im Namen, der trotzdem als Arbeitszone gelten soll.
  haZone: "",
  // Tätigkeitsstätte für Arbeitszonen, deren Name keinen Code trägt.
  legacyPlaceId: "",
  fallbackIn: "08:00",
  fallbackOut: "16:45"
};

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// ------------------------------------------------------------------ Datum

const pad = (n) => String(n).padStart(2, "0");

function isoDate(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function mondayOf(dateLike) {
  const d = new Date(dateLike);
  d.setHours(0, 0, 0, 0);
  const shift = (d.getDay() + 6) % 7; // Montag = 0
  d.setDate(d.getDate() - shift);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatHm(minutes) {
  const m = Math.max(0, Math.round(minutes));
  return Math.floor(m / 60) + ":" + pad(m % 60);
}

// ---------------------------------------------------------------- Zustand

// Phasen: idle | working | awaiting-login | ok | error
let state = { phase: "idle", message: "", loginTabId: null, updatedAt: Date.now() };

function setState(phase, message, extra = {}) {
  state = { phase, message, loginTabId: null, ...extra, updatedAt: Date.now() };
  // Schlägt fehl, wenn kein Panel offen ist - das ist der Normalfall.
  chrome.runtime.sendMessage({ action: "state", state }).catch(() => {});
}

async function notify(title, message) {
  const { brandName, brandIcon } = await chrome.storage.local.get({
    brandName: DEFAULTS.brandName,
    brandIcon: DEFAULTS.brandIcon
  });
  chrome.notifications.create({
    type: "basic",
    iconUrl: brandIcon || "icons/128.png",
    title: (brandName || DEFAULTS.brandName) + " — " + title,
    message,
    priority: 1
  });
}

// Symbol und Sprechblase der Symbolleiste aus dem Browser-Speicher setzen. Die
// Dateien im Manifest bleiben neutral. Der Name in der Erweiterungsliste des
// Browsers stammt dagegen aus dem Manifest und ist zur Laufzeit nicht änderbar.
async function applyBrandIcon() {
  const { brandIcon, brandName } = await chrome.storage.local.get({
    brandIcon: "",
    brandName: DEFAULTS.brandName
  });

  const title = String(brandName || DEFAULTS.brandName)
    .replace(/\*\*/g, "")
    .replace(/\s*\|\s*/, " · ");
  chrome.action.setTitle({ title });
  if (!brandIcon) {
    chrome.action.setIcon({ path: { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" } });
    return;
  }
  try {
    const blob = await (await fetch(brandIcon)).blob();
    const bitmap = await createImageBitmap(blob);
    const imageData = {};
    for (const size of [16, 32, 48, 128]) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, size, size);
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    chrome.action.setIcon({ imageData });
  } catch {
    // Unbrauchbares Bild: beim Standard bleiben, statt ohne Symbol zu enden.
  }
}

chrome.runtime.onStartup.addListener(applyBrandIcon);
chrome.runtime.onInstalled.addListener(applyBrandIcon);
// Auch anwenden, wenn die Einstellung von anderswo geändert wurde.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.brandIcon || changes.brandName)) applyBrandIcon();
});
// Der Service Worker wird beendet und neu gestartet; das Symbol muss dabei
// jedes Mal neu gesetzt werden, sonst greift wieder das Standardsymbol.
applyBrandIcon();

// ------------------------------------------------------------------- Tabs

function isSfUrl(url) {
  try {
    return /(^|\.)successfactors\.(eu|com)$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Anmeldeseiten: der SSO-Umweg über Microsoft und SuccessFactors' eigene Loginmaske.
function isLoginUrl(url) {
  try {
    const u = new URL(url);
    if (!isSfUrl(url)) return true;
    return /^\/(login|sso|saml)/i.test(u.pathname);
  } catch {
    return true;
  }
}

function waitForSfTab(tabId, timeoutMs = LOGIN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let announced = false;
    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          announced
            ? "Anmeldung noch offen — nach dem Login erneut versuchen"
            : "Zeitüberschreitung beim Laden von SuccessFactors"
        )
      );
    }, timeoutMs);

    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
    function onUpdated(id, info, tab) {
      if (id !== tabId || info.status !== "complete") return;

      if (isLoginUrl(tab.url || "")) {
        if (!announced) {
          announced = true;
          setState("awaiting-login", "Anmeldung nötig — warte auf Login …", { loginTabId: tabId });
          notify(
            "Anmeldung nötig",
            "Die Sitzung ist abgelaufen. Im geöffneten Tab anmelden — danach wird automatisch weitergemacht."
          );
        }
        return;
      }

      // Erst wenn die Adresse für einen Moment stabil bleibt, ist die
      // Weiterleitungskette der Startseite durch.
      finish();
      setTimeout(() => resolve({ neededLogin: announced }), 400);
    }
    function onRemoved(id) {
      if (id !== tabId) return;
      finish();
      reject(new Error("Tab wurde geschlossen, bevor die Buchung lief"));
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

// Liefert einen nutzbaren SuccessFactors-Tab. Existiert keiner, wird einer im Hintergrund
// geöffnet und als temporär markiert, damit er hinterher wieder verschwindet.
async function acquireSfTab() {
  const cfg = await settings();
  const tabs = await chrome.tabs.query({ url: SF_GLOBS });
  const ready = tabs.find(
    (t) => t.status === "complete" && isSfUrl(t.url || "") && !isLoginUrl(t.url || "")
  );
  if (ready) return { tabId: ready.id, temporary: false };

  const home = "https://" + cfg.sfHost.replace(/^https?:\/\//, "").replace(/\/+$/, "") + "/sf/start";
  const created = await chrome.tabs.create({ url: home, active: false });
  const { neededLogin } = await waitForSfTab(created.id);
  // Musste sich der Nutzer anmelden, bleibt der Tab stehen — ihn wegzureißen
  // wäre nach der Interaktion irritierend.
  return { tabId: created.id, temporary: !neededLogin };
}

// Aufrufe werden hintereinander abgearbeitet. Sonst benutzt ein zweiter Abruf
// den Hintergrund-Tab des ersten, und dessen Aufräumen reißt ihm den Boden weg
// ("Frame with ID 0 was removed").
let sfQueue = Promise.resolve();

function runInSf(func, args) {
  const run = () => runInSfNow(func, args);
  const task = sfQueue.then(run, run);
  sfQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

// Die Startseite leitet nach dem Laden noch intern weiter. Trifft die
// Einspritzung diesen Moment, verschwindet der Rahmen mitten in der
// Ausführung — erkennbar an diesen Meldungen, und mit Abstand behebbar.
const TRANSIENT = /frame with id|no frame|frame was removed|no tab with id|cannot access/i;

async function runInSfNow(func, args, attempt = 0) {
  const { tabId, temporary } = await acquireSfTab();
  try {
    // Kurz warten, damit ein angehängter Wechsel der Adresse durch ist.
    await new Promise((r) => setTimeout(r, temporary ? 700 : 150));
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func,
      args
    });
    if (temporary) chrome.tabs.remove(tabId).catch(() => {});
    return result;
  } catch (err) {
    if (temporary) chrome.tabs.remove(tabId).catch(() => {});
    if (attempt < 2 && TRANSIENT.test(String(err && err.message))) {
      await new Promise((r) => setTimeout(r, 1200));
      return runInSfNow(func, args, attempt + 1);
    }
    throw err;
  }
}

// ------------------------------------------- Code im Seitenkontext (MAIN)
// Läuft im MAIN world der Seite: gleiche Origin, echte Session-Cookies, kein CORS.

// Bucht beliebig viele Zeitereignisse; ein CSRF-Token für alle.
function pageBook(assignmentId, entries) {
  return (async () => {
    const base = "/odatav4/timemanagement/timeeventprocessing/ManageClockInClockOut.svc/v2/";
    const p = (n) => String(n).padStart(2, "0");

    try {
      const probe = await fetch(base, {
        credentials: "include",
        headers: { "X-CSRF-Token": "Fetch", Accept: "application/json" }
      });
      const token = probe.headers.get("x-csrf-token");
      if (!token) return { ok: false, msg: "Keine gültige SuccessFactors-Sitzung", needsLogin: true };

      const results = [];
      for (const entry of entries) {
        const m = String(entry.time).match(/^(\d{1,2}):(\d{2})$/);
        if (!m) {
          results.push({ ...entry, ok: false, msg: "Ungültige Uhrzeit" });
          continue;
        }
        // Offset für genau diesen Tag berechnen, damit Sommer-/Winterzeit stimmt.
        const when = new Date(entry.date + "T00:00:00");
        when.setHours(Number(m[1]), Number(m[2]), 0, 0);
        const stamp = entry.date + "T" + p(when.getHours()) + ":" + p(when.getMinutes()) + ":00Z";
        const offset = -when.getTimezoneOffset();
        const abs = Math.abs(offset);
        const tz = (offset >= 0 ? "+" : "-") + p(Math.floor(abs / 60)) + ":" + p(abs % 60);

        const res = await fetch(base + "TimeEvents", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "OData-Version": "4.0",
            "OData-MaxVersion": "4.0",
            "Accept-Language": "de-DE",
            "X-CSRF-Token": token
          },
          body: JSON.stringify({
            assignmentId,
            creationSource: "MANUAL",
            timestampLocal: stamp,
            timeZoneOffset: tz,
            timeEventTypeCode: entry.type,
            geoFenceCode: null
          })
        });

        if (res.status === 201) {
          // 201 heisst angenommen, nicht unbedingt gueltig: SuccessFactors
          // beanstandet etwa nicht paarbare Ereignisse im Rumpf der Antwort.
          let created = null;
          try {
            created = JSON.parse(await res.text());
          } catch {}
          const status = created && created.validationStatus;
          const messages = (created && created.validationMessages) || [];
          if (status && status !== "SUCCESS") {
            const detail = messages
              .map((m) => m.message || m.messageText || "")
              .filter(Boolean)
              .join(" ");
            results.push({ ...entry, ok: false, msg: detail || ("Validierung: " + status) });
          } else {
            results.push({ ...entry, ok: true });
          }
        } else if (res.status === 401 || res.status === 403) {
          return { ok: false, msg: "Sitzung abgelaufen", needsLogin: true };
        } else {
          const raw = await res.text();
          let detail = raw;
          try {
            const parsed = JSON.parse(raw);
            detail = (parsed.error && parsed.error.message) || raw;
          } catch {}
          results.push({ ...entry, ok: false, msg: String(detail).slice(0, 200) });
        }
      }

      const failed = results.filter((r) => !r.ok);
      return { ok: failed.length === 0, results, msg: failed.length ? failed[0].msg : "" };
    } catch (err) {
      return { ok: false, msg: "Netzwerkfehler: " + String(err) };
    }
  })();
}

// Ersetzt die Zeitereignisse eines Tages. Ändern erlaubt SuccessFactors nicht
// (update_mc ist false), Löschen nur über die gebundene Aktion RequestDeletion.
// Für die Oberfläche sieht es nach Überschreiben aus.
function pageReplaceDay(assignmentId, dateIso, entries) {
  return (async () => {
    const base = "/odatav4/timemanagement/timeeventprocessing/ManageClockInClockOut.svc/v2/";
    const p = (n) => String(n).padStart(2, "0");

    const csrf = async () => {
      const probe = await fetch(base, {
        credentials: "include",
        headers: { "X-CSRF-Token": "Fetch", Accept: "application/json" }
      });
      return probe.headers.get("x-csrf-token");
    };

    try {
      const token = await csrf();
      if (!token) return { ok: false, msg: "Keine gültige SuccessFactors-Sitzung", needsLogin: true };

      const filter =
        "assignmentId eq '" + assignmentId + "' and timestampLocal ge " + dateIso +
        "T00:00:00Z and timestampLocal le " + dateIso + "T23:59:59Z";
      const listed = await fetch(
        base + "TimeEvents?$orderby=timestampLocal&$top=50&$filter=" + encodeURIComponent(filter),
        { credentials: "include", headers: { Accept: "application/json" } }
      );
      if (!listed.ok) return { ok: false, msg: "Bestand nicht lesbar (HTTP " + listed.status + ")" };
      const existing = ((await listed.json()).value || []).filter((e) => e.externalId);

      // Erst löschen: ein zweites Kommen neben einem offenen Paar lehnt
      // SuccessFactors ab.
      for (const event of existing) {
        const res = await fetch(
          base + "TimeEvents('" + encodeURIComponent(event.externalId) +
            "')/ManageClockInClockOut.svc.RequestDeletion",
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "OData-Version": "4.0",
              "X-CSRF-Token": token
            },
            body: "{}"
          }
        );
        if (!res.ok) {
          return {
            ok: false,
            msg: "Löschen von " + String(event.timestampLocal).slice(11, 16) +
                 " fehlgeschlagen (HTTP " + res.status + ") — nichts verändert"
          };
        }
      }

      const results = [];
      for (const entry of entries) {
        const m = String(entry.time).match(/^(\d{1,2}):(\d{2})$/);
        if (!m) {
          results.push({ ...entry, ok: false, msg: "Ungültige Uhrzeit" });
          continue;
        }
        const when = new Date(dateIso + "T00:00:00");
        when.setHours(Number(m[1]), Number(m[2]), 0, 0);
        const offset = -when.getTimezoneOffset();
        const abs = Math.abs(offset);
        const tz = (offset >= 0 ? "+" : "-") + p(Math.floor(abs / 60)) + ":" + p(abs % 60);

        const res = await fetch(base + "TimeEvents", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "OData-Version": "4.0",
            "OData-MaxVersion": "4.0",
            "Accept-Language": "de-DE",
            "X-CSRF-Token": token
          },
          body: JSON.stringify({
            assignmentId,
            creationSource: "MANUAL",
            timestampLocal:
              dateIso + "T" + p(when.getHours()) + ":" + p(when.getMinutes()) + ":00Z",
            timeZoneOffset: tz,
            timeEventTypeCode: entry.type,
            geoFenceCode: null
          })
        });

        const raw = await res.text();
        let created = null;
        try {
          created = JSON.parse(raw);
        } catch {}
        const status = created && created.validationStatus;
        if (res.status === 201 && (!status || status === "SUCCESS")) {
          results.push({ ...entry, ok: true });
        } else {
          const detail = ((created && created.validationMessages) || [])
            .map((x) => x.message || "")
            .filter(Boolean)
            .join(" ");
          results.push({
            ...entry,
            ok: false,
            msg: detail || (created && created.error && created.error.message) ||
                 "HTTP " + res.status
          });
        }
      }

      const failed = results.filter((r) => !r.ok);
      return {
        ok: failed.length === 0,
        removed: existing.length,
        results,
        msg: failed.length ? failed[0].msg : ""
      };
    } catch (err) {
      return { ok: false, msg: "Netzwerkfehler: " + String(err) };
    }
  })();
}

// Die für diesen Nutzer aktuell erlaubten Zeitereignistypen.
function pageTypes(assignmentId) {
  return (async () => {
    const base = "/odatav4/timemanagement/timeeventprocessing/ManageClockInClockOut.svc/v2/";
    const p = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const abs = Math.abs(offset);
    const tz = (offset >= 0 ? "+" : "-") + p(Math.floor(abs / 60)) + ":" + p(abs % 60);
    const dt =
      now.getFullYear() + "-" + p(now.getMonth() + 1) + "-" + p(now.getDate()) +
      "T" + p(now.getHours()) + ":" + p(now.getMinutes()) + ":00" + tz;
    try {
      const res = await fetch(
        base + "TimeEventTypes/getActiveTimeEventTypesForUserAndDateTime(assignmentId='" +
          assignmentId + "',dateTime=" + dt + ")",
        { credentials: "include", headers: { Accept: "application/json" } }
      );
      if (!res.ok) return { ok: false, msg: "Fehler " + res.status };
      const data = await res.json();
      return {
        ok: true,
        // Diese Liste führt das Feld als "code"; andere Dienste desselben
        // Namensraums nennen es "externalCode". Beides zulassen.
        types: (data.value || [])
          .map((t) => ({
            code: t.code || t.externalCode || t.timeEventTypeCode,
            name: t.name || t.description || t.timeEventTypeName
          }))
          .filter((t) => t.code)
      };
    } catch (err) {
      return { ok: false, msg: String(err) };
    }
  })();
}

// Liest Zeitereignisse und die von SuccessFactors bewertete Tagesarbeitszeit
// für die Woche ab mondayIso.
function pageWeek(assignmentId, mondayIso, sundayIso, waitForValuation) {
  return (async () => {
    const cico = "/odatav4/timemanagement/timeeventprocessing/ManageClockInClockOut.svc/v2/";
    const att = "/odatav4/timemanagement/attendance/AttendanceRecordingUi.svc/v2/";
    const json = async (url) => {
      const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
      if (!res.ok) {
        const e = new Error("Fehler " + res.status);
        e.status = res.status;
        throw e;
      }
      return res.json();
    };

    try {
      const filter =
        "assignmentId eq '" + assignmentId + "' and timestampLocal ge " + mondayIso +
        "T00:00:00Z and timestampLocal le " + sundayIso + "T23:59:59Z";
      const evData = await json(
        cico + "TimeEvents?$select=timestampLocal,timeEventTypeCode,creationSource&$orderby=timestampLocal&$top=200&$filter=" +
          encodeURIComponent(filter)
      );

      const byDate = {};
      for (const e of evData.value || []) {
        const stamp = String(e.timestampLocal);
        const date = stamp.slice(0, 10);
        (byDate[date] = byDate[date] || []).push({
          time: stamp.slice(11, 16),
          type: e.timeEventTypeCode,
          source: e.creationSource
        });
      }

      // Bewertung läuft nach einer Buchung asynchron nach.
      let sheet = null;
      const attempts = waitForValuation ? 6 : 1;
      for (let i = 0; i < attempts; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1500));
        if (waitForValuation) {
          try {
            const fin = await json(att + "isTimeValuationFinished(assignmentId='" + assignmentId + "')");
            if (fin && fin.value === false) continue;
          } catch {}
        }
        sheet = await json(
          att + "TimeSheetSummary(assignmentId='" + assignmentId + "',shiftDate=" + mondayIso +
            ")?$expand=days($expand=attendances)"
        );
        break;
      }

      const days = (sheet && sheet.days ? sheet.days : []).map((d) => {
        const events = byDate[d.shiftDate] || [];
        const summary = d.summary || {};
        const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
        const span =
          events.length >= 2 ? toMin(events[events.length - 1].time) - toMin(events[0].time) : null;
        // Pausen legt das System selbst an; die Tätigkeitsstätte hängt an den
        // Arbeitszeitsätzen.
        const work = (d.attendances || []).filter((a) => a.origin !== "SYSTEM_GENERATED");
        return {
          placeId: (work.find((a) => a.cust_PlaceOfWork) || {}).cust_PlaceOfWork || null,
          hasAttendance: work.length > 0,
          date: d.shiftDate,
          isWorkingDay: d.isWorkingDay,
          isMaintainable: d.isMaintainable,
          holiday: d.holiday || "",
          events,
          absences: summary.absences || 0,
          recordedMinutes: summary.recordedWorkingTimeInMinutes ?? null,
          plannedMinutes: summary.plannedWorkingTimeInMinutes ?? null,
          dayModel: summary.dayModelExternalName || null,
          spanMinutes: span
        };
      });

      return {
        ok: true,
        monday: mondayIso,
        approvalStatus: (sheet && sheet.approvalStatusText) || null,
        weekPlanned: (sheet && sheet.plannedWorkingTimeHoursAndMinutes) || null,
        weekRecorded: (sheet && sheet.recordedWorkingTimeHoursAndMinutes) || null,
        days
      };
    } catch (err) {
      return {
        ok: false,
        msg: err.status ? "Fehler " + err.status : "Netzwerkfehler: " + String(err),
        needsLogin: err.status === 401 || err.status === 403
      };
    }
  })();
}

// Auswahlliste der Tätigkeitsstätten. Geschrieben wird die internalId als
// Zeichenkette — der externe Code wird beim Speichern abgelehnt.
function pagePlaces() {
  return (async () => {
    const att = "/odatav4/timemanagement/attendance/AttendanceRecordingUi.svc/v2/";
    try {
      const res = await fetch(att + "VH_cust_PlaceOfWork_OF_EmployeeTimeSheetEntry?$top=200", {
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      if (!res.ok) return { ok: false, msg: "Fehler " + res.status };
      const data = await res.json();
      return {
        ok: true,
        places: (data.value || [])
          .filter((p) => p.internalId != null)
          .map((p) => ({ id: String(p.internalId), code: p.externalCode, label: p.label }))
      };
    } catch (err) {
      return { ok: false, msg: String(err) };
    }
  })();
}

// Setzt die Tätigkeitsstätte an allen Arbeitszeitsätzen eines Tages.
function pageSetPlace(assignmentId, dateIso, placeId) {
  return (async () => {
    const att = "/odatav4/timemanagement/attendance/AttendanceRecordingUi.svc/v2/";
    const key = "assignmentId='" + assignmentId + "',shiftDate=" + dateIso;
    try {
      const sheet = await (
        await fetch(att + "TimeSheetSummary(" + key + ")?$expand=days($expand=attendances)", {
          credentials: "include",
          headers: { Accept: "application/json" }
        })
      ).json();
      const day = (sheet.days || []).find((d) => d.shiftDate === dateIso);
      const records = ((day && day.attendances) || []).filter(
        (a) => a.origin !== "SYSTEM_GENERATED" && a.mdfSystemRecordId
      );
      if (!records.length) return { ok: false, msg: "Für diesen Tag gibt es noch keinen Erfassungssatz" };

      const probe = await fetch(att, {
        credentials: "include",
        headers: { "X-CSRF-Token": "Fetch", Accept: "application/json" }
      });
      const token = probe.headers.get("x-csrf-token");
      if (!token) return { ok: false, msg: "Keine gültige SuccessFactors-Sitzung", needsLogin: true };

      for (const rec of records) {
        const url =
          att + "TimeSheetSummary(" + key + ")/days(" + key + ")/attendances('" +
          encodeURIComponent(rec.mdfSystemRecordId) + "')";
        const res = await fetch(url, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "OData-Version": "4.0",
            "OData-MaxVersion": "4.0",
            "Accept-Language": "de-DE",
            "X-CSRF-Token": token
          },
          body: JSON.stringify({ cust_PlaceOfWork: placeId ? String(placeId) : null })
        });
        if (!res.ok) {
          const raw = await res.text();
          let detail = raw;
          try {
            detail = (JSON.parse(raw).error || {}).message || raw;
          } catch {}
          return { ok: false, msg: String(detail).slice(0, 200) };
        }
      }
      return { ok: true, count: records.length };
    } catch (err) {
      return { ok: false, msg: "Netzwerkfehler: " + String(err) };
    }
  })();
}

// -------------------------------------------------------- Home Assistant

// Arbeitszonen tragen den SuccessFactors-Code der Tätigkeitsstätte in Klammern
// am Ende ihres Namens, etwa "Büro Musterstadt (XXX_Office_Musterstadt)".
// So braucht es keine Zuordnungstabelle im Code.
function placeOfWorkFrom(zoneName) {
  const m = String(zoneName || "").match(/\(([A-Z]{2,3}_[A-Za-z0-9_]+)\)\s*$/);
  return m ? m[1] : null;
}

// Erste Ankunft und letztes Verlassen einer Arbeitszone je Tag.
async function haTimes(cfg, startIso, endIso) {
  if (!cfg.haEnabled) return { ok: false, off: true };
  if (!cfg.haUrl || !cfg.haToken) {
    return { ok: false, msg: "Home Assistant ist aktiviert, aber Adresse oder Token fehlen" };
  }

  const base = cfg.haUrl.replace(/\/+$/, "");
  const start = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T23:59:59");
  const url =
    base + "/api/history/period/" + encodeURIComponent(start.toISOString()) +
    "?filter_entity_id=" + encodeURIComponent(cfg.haEntity) +
    "&end_time=" + encodeURIComponent(end.toISOString()) +
    // Kein significant_changes_only: Home Assistant filtert damit
    // Zonenwechsel heraus, also genau die Ereignisse, die hier zählen.
    // minimal_response bleibt, es lässt nur die Attribute weg.
    "&minimal_response";

  try {
    const res = await fetch(url, { headers: { Authorization: "Bearer " + cfg.haToken } });
    if (res.status === 401) return { ok: false, msg: "Home Assistant: Token ungültig" };
    // Steht Home Assistant hinter mTLS, antwortet der Proxy ohne vorgelegtes
    // Client-Zertifikat mit 403. Chrome kann es hier nicht erfragen, weil kein
    // sichtbarer Tab da ist — ein Besuch der Seite im Tab füllt den Cache.
    if (res.status === 403) {
      return {
        ok: false,
        msg: "Home Assistant: 403 — vermutlich fehlt das Client-Zertifikat. Seite einmal im Tab öffnen und Zertifikat bestätigen."
      };
    }
    if (!res.ok) return { ok: false, msg: "Home Assistant: Fehler " + res.status };
    const data = await res.json();
    const series = (data && data[0]) || [];

    // Eine Arbeitszone ist jede Zone mit Code im Namen; der alte, fest
    // eingestellte Zonenname gilt weiter, damit bestehende Aufbauten laufen.
    const isWork = (s) => Boolean(placeOfWorkFrom(s)) || (cfg.haZone && s === cfg.haZone);

    const perDay = {};
    let prev = null;
    let prevAt = null;
    for (const point of series) {
      const at = new Date(point.last_changed || point.last_updated);
      const day = isoDate(at);
      const time = pad(at.getHours()) + ":" + pad(at.getMinutes());
      const slot = (perDay[day] = perDay[day] || { in: null, out: null, place: null, zone: null });

      const nowAtWork = isWork(point.state);
      const wasAtWork = isWork(prev);
      if (nowAtWork && !wasAtWork && !slot.in) {
        slot.in = time;
        slot.zone = point.state;
        slot.place = placeOfWorkFrom(point.state);
        // Meldet das Gerät stundenlang nichts, kann die Ankunft deutlich
        // früher gelegen haben. Dann ist der Wert ein Anhaltspunkt, keine
        // Messung — der Aufrufer soll das kennzeichnen können.
        if (prevAt && isoDate(prevAt) === day) {
          const gap = Math.round((at - prevAt) / 60000);
          if (gap > 90) {
            slot.gapMinutes = gap;
            slot.gapFrom = pad(prevAt.getHours()) + ":" + pad(prevAt.getMinutes());
          }
        }
      }
      if (!nowAtWork && wasAtWork) slot.out = time;
      prev = point.state;
      prevAt = at;
    }
    return { ok: true, perDay };
  } catch (err) {
    return { ok: false, msg: "Home Assistant nicht erreichbar: " + String(err) };
  }
}

// --------------------------------------------------------------- Ablaeufe

let placeCache = null;

let placeReason = null;

async function loadPlaces() {
  if (placeCache) return placeCache;
  try {
    const res = await runInSf(pagePlaces, []);
    if (res && res.ok) {
      placeCache = res.places;
      placeReason = null;
    } else {
      placeReason = (res && res.msg) || "Tätigkeitsstätten nicht abrufbar";
      return [];
    }
  } catch (err) {
    placeReason = String(err.message || err);
    return [];
  }
  return placeCache;
}

// Übersetzt den Code aus dem Zonennamen in die internalId, die das Feld erwartet.
async function placeIdForCode(code) {
  if (!code) return null;
  const places = await loadPlaces();
  const hit = places.find((p) => p.code === code);
  return hit ? hit.id : null;
}

async function setPlace(dateIso, placeId) {
  const cfg = await settings();
  try {
    return await runInSf(pageSetPlace, [cfg.assignmentId, dateIso, placeId || null]);
  } catch (err) {
    return { ok: false, msg: String(err.message || err) };
  }
}

let typeCache = null;

// Trennt die abgerufenen Typen in Kommen-Typen und den Gehen-Typ.
async function loadTypes() {
  if (typeCache) return typeCache;
  const cfg = await settings();
  if (!cfg.assignmentId) {
    return { start: [], end: null, reason: "Assignment-ID fehlt — in den Einstellungen hinterlegen" };
  }
  try {
    const res = await runInSf(pageTypes, [cfg.assignmentId]);
    if (!res || !res.ok) {
      return { start: [], end: null, reason: (res && res.msg) || "Typen nicht abrufbar" };
    }
    const all = res.types || [];
    if (!all.length) {
      // Leeres Ergebnis nicht merken, sonst bleibt ein einmaliger Aussetzer
      // für die restliche Sitzung hängen.
      return { start: [], end: null, reason: "Liste der Zeitereignistypen war leer" };
    }
    const end = all.find((t) => END_PATTERN.test(t.code) || END_PATTERN.test(t.name));
    typeCache = {
      start: all.filter((t) => t !== end),
      end: end ? end.code : null
    };
  } catch (err) {
    return { start: [], end: null, reason: String(err.message || err) };
  }
  return typeCache;
}

// Kommen-Typ für einen Tag: Büro, wenn eine Arbeitszone erkannt wurde,
// sonst Homeoffice — jeweils anhand der Typen des Mandanten.
async function typeForDay(cfg, wasAtOffice, atOffice) {
  const { start } = await loadTypes();
  const homeoffice = start.find(
    (t) => HOMEOFFICE_PATTERN.test(t.code) || HOMEOFFICE_PATTERN.test(t.name)
  );
  const office =
    start.find((t) => t.code === cfg.startType) ||
    start.find((t) => t !== homeoffice) ||
    start[0];
  if (atOffice) return office ? office.code : cfg.startType;
  if (wasAtOffice) return homeoffice ? homeoffice.code : cfg.startType;
  return cfg.startType;
}

async function book(kind, timeStr, typeCode, placeId) {
  const cfg = await settings();
  const label = kind === "in" ? "Kommt" : "Geht";
  if (!cfg.assignmentId) {
    const msg = "Assignment-ID fehlt — bitte in den Einstellungen hinterlegen";
    setState("error", msg);
    return { ok: false, msg };
  }
  const { end } = await loadTypes();
  const type = kind === "in" ? typeCode || cfg.startType : end;
  if (!type) {
    const msg = "Zeitereignistyp nicht ermittelbar — bitte Einstellungen prüfen";
    setState("error", msg);
    return { ok: false, msg };
  }
  const time = timeStr || pad(new Date().getHours()) + ":" + pad(new Date().getMinutes());
  const date = isoDate(new Date());

  setState("working", label + " wird gebucht …");
  try {
    const result = await runInSf(pageBook, [cfg.assignmentId, [{ date, time, type }]]);
    if (result && result.ok) {
      setState("ok", label + " gebucht um " + time);
      if (kind === "out") {
        result.week = await loadWeek(date, true);
        const today = result.week && result.week.ok
          ? result.week.days.find((d) => d.date === date)
          : null;

        // Tätigkeitsstätte erst jetzt setzen — der Erfassungssatz entsteht
        // erst, wenn Kommen und Gehen gepaart sind.
        const wanted = placeId || (today && (await placeIdForCode(today.suggestPlace)));
        if (wanted) {
          result.place = await setPlace(date, wanted);
          if (result.place && result.place.ok && result.week && result.week.ok) {
            result.week = await loadWeek(date, false);
          }
        }

        const net = today && today.recordedMinutes;
        notify(label, net
          ? "Gebucht um " + time + " — heute " + formatHm(net) + " erfasst"
          : "Gebucht um " + time);
      } else {
        notify(label, "Gebucht um " + time);
      }
      result.time = time;
      return result;
    }
    const msg = (result && result.msg) || "Unbekannter Fehler";
    setState("error", msg);
    notify(label + " fehlgeschlagen", msg);
    return result || { ok: false, msg };
  } catch (err) {
    const msg = String(err.message || err);
    setState("error", msg);
    notify(label + " fehlgeschlagen", msg);
    return { ok: false, msg };
  }
}

// Trägt für einen zurückliegenden Tag Kommen und Gehen nach.
async function bookDays(items) {
  const cfg = await settings();
  const { end, reason } = await loadTypes();
  const entries = [];
  for (const item of items) {
    if (item.in) entries.push({ date: item.date, time: item.in, type: item.type || cfg.startType });
    if (item.out) {
      // Ohne bekannten Gehen-Typ nicht stillschweigend die Haelfte buchen.
      if (!end) {
        const msg = "Gehen-Typ nicht ermittelbar" + (reason ? " (" + reason + ")" : "");
        setState("error", msg);
        return { ok: false, msg };
      }
      entries.push({ date: item.date, time: item.out, type: end });
    }
  }
  if (!entries.length) return { ok: false, msg: "Nichts zu buchen" };

  setState("working", entries.length + " Zeitereignisse werden gebucht …");
  try {
    const result = await runInSf(pageBook, [cfg.assignmentId, entries]);
    if (result && result.ok) {
      // Nach dem Nachtragen liegen beide Stempel vor, der Erfassungssatz also auch.
      for (const item of items) {
        if (!item.placeId) continue;
        setState("working", "Tätigkeitsstätte wird gesetzt …");
        await setPlace(item.date, item.placeId);
      }
      const days = new Set(entries.map((e) => e.date)).size;
      setState("ok", days === 1 ? "Tag nachgetragen" : days + " Tage nachgetragen");
      notify("Nachtrag", days === 1 ? "1 Tag nachgetragen" : days + " Tage nachgetragen");
    } else {
      const msg = (result && result.msg) || "Unbekannter Fehler";
      setState("error", msg);
      notify("Nachtrag fehlgeschlagen", msg);
    }
    return result;
  } catch (err) {
    const msg = String(err.message || err);
    setState("error", msg);
    notify("Nachtrag fehlgeschlagen", msg);
    return { ok: false, msg };
  }
}

// Überschreibt einen Tag. Die Tätigkeitsstätte wird vorher gelesen und
// hinterher wieder gesetzt — der Erfassungssatz entsteht beim Neuanlegen neu
// und käme sonst ohne sie zurück.
async function replaceDay({ date, in: inTime, out, type, placeId }) {
  const cfg = await settings();
  const { end } = await loadTypes();

  if (!inTime || !out) return { ok: false, msg: "Kommen und Gehen müssen beide gesetzt sein" };
  if (!end) return { ok: false, msg: "Gehen-Typ nicht ermittelbar" };

  const entries = [
    { time: inTime, type: type || cfg.startType },
    { time: out, type: end }
  ];
  if (!entries[0].type) return { ok: false, msg: "Art des Kommens fehlt" };

  setState("working", "Tag wird überschrieben …");
  try {
    // Bisheriger Ort sichern, falls im Formular keiner gewählt wurde.
    const before = await loadWeek(date, false);
    const previous = before && before.ok
      ? (before.days.find((d) => d.date === date) || {}).placeId || null
      : null;

    const result = await runInSf(pageReplaceDay, [cfg.assignmentId, date, entries]);
    if (!result || !result.ok) {
      const msg = (result && result.msg) || "Überschreiben fehlgeschlagen";
      setState("error", msg);
      notify("Überschreiben fehlgeschlagen", msg);
      return result || { ok: false, msg };
    }

    const wanted = placeId || previous;
    if (wanted) {
      // Der Erfassungssatz entsteht erst mit der Bewertung.
      await loadWeek(date, true);
      result.place = await setPlace(date, wanted);
    }

    setState("ok", "Tag überschrieben");
    notify("Tag überschrieben", inTime + " – " + out);
    result.week = await loadWeek(date, false);
    return result;
  } catch (err) {
    const msg = String(err.message || err);
    setState("error", msg);
    return { ok: false, msg };
  }
}

async function loadWeek(anyDateInWeek, waitForValuation = false) {
  const cfg = await settings();
  const monday = mondayOf(anyDateInWeek || new Date());
  const sunday = addDays(monday, 6);
  try {
    const week = await runInSf(pageWeek, [
      cfg.assignmentId, isoDate(monday), isoDate(sunday), waitForValuation
    ]);
    if (!week || !week.ok) return week || { ok: false, msg: "Woche nicht abrufbar" };

    // Vorschlagswerte für Tage ohne Buchung.
    const ha = await haTimes(cfg, isoDate(monday), isoDate(sunday));
    week.haOk = ha.ok;
    week.haOff = Boolean(ha.off);
    week.haMsg = ha.msg || null;
    const today = isoDate(new Date());
    for (const day of week.days) {
      const suggestion = (ha.ok && ha.perDay[day.date]) || {};
      day.suggestIn = suggestion.in || null;
      day.suggestOut = suggestion.out || null;
      day.suggestSource = suggestion.in || suggestion.out ? "ha" : "fallback";
      day.suggestPlace = suggestion.place || null;
      day.suggestZone = suggestion.zone || null;
      day.gapMinutes = suggestion.gapMinutes || null;
      day.gapFrom = suggestion.gapFrom || null;
      day.suggestPlaceId = suggestion.place
        ? await placeIdForCode(suggestion.place)
        : suggestion.in
          ? cfg.legacyPlaceId || null
          : null;
      // War an dem Tag kein Aufenthalt in der Arbeitszone, war es vermutlich
      // Homeoffice — sofern Home Assistant überhaupt Daten geliefert hat.
      day.suggestType = await typeForDay(cfg, ha.ok, Boolean(suggestion.in));
      day.isPast = day.date < today;
      day.isToday = day.date === today;
    }
    return week;
  } catch (err) {
    return { ok: false, msg: String(err.message || err) };
  }
}

// ----------------------------------------------------------- Aktualisierung

// Entpackt geladene Erweiterungen aktualisiert der Browser nicht selbst.
// Deshalb vergleichen wir die eigene Version täglich mit dem neuesten
// GitHub-Release und melden uns, wenn eine neuere vorliegt. Installiert wird
// nichts — das bleibt ein bewusster Schritt des Nutzers.
const REPO = "BMWfan/time-tracking";
const UPDATE_ALARM = "update-check";

function parseVersion(text) {
  return String(text || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
}

// > 0, wenn a neuer als b ist.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function checkForUpdate({ quiet = true } = {}) {
  const current = chrome.runtime.getManifest().version;
  try {
    const res = await fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!res.ok) {
      // Ein privates Repository antwortet ohne Anmeldung mit 404. Einen Token
      // dafür in die Erweiterung zu legen wäre unangemessen, also bleibt die
      // Prüfung in diesem Fall aus.
      const error =
        res.status === 404
          ? "Keine öffentlichen Releases — Prüfung nicht möglich"
          : "GitHub: Fehler " + res.status;
      const info = { checkedAt: Date.now(), error, current };
      await chrome.storage.local.set({ updateInfo: info });
      chrome.action.setBadgeText({ text: "" });
      return info;
    }
    const data = await res.json();
    const latest = String(data.tag_name || "").replace(/^v/i, "");
    const newer = compareVersions(latest, current) > 0;
    const info = {
      checkedAt: Date.now(),
      current,
      latest,
      newer,
      url: data.html_url || "https://github.com/" + REPO + "/releases",
      notes: (data.name || "").slice(0, 120)
    };
    await chrome.storage.local.set({ updateInfo: info });

    if (newer) {
      chrome.action.setBadgeText({ text: "↑" });
      chrome.action.setBadgeBackgroundColor({ color: "#FF9500" });
      if (quiet) {
        // Nur einmal je Version stören.
        const { notifiedVersion } = await chrome.storage.local.get({ notifiedVersion: "" });
        if (notifiedVersion === latest) return info;
        await chrome.storage.local.set({ notifiedVersion: latest });
      }
      notify(
        "Version " + latest + " verfügbar",
        "Installiert ist " + current + ". Zum Herunterladen auf diese Meldung klicken."
      );
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
    return info;
  } catch (err) {
    const info = { checkedAt: Date.now(), error: String(err), current };
    await chrome.storage.local.set({ updateInfo: info });
    return info;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 60 * 24 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate();
});

chrome.notifications.onClicked.addListener(async (id) => {
  const { updateInfo } = await chrome.storage.local.get({ updateInfo: null });
  if (updateInfo && updateInfo.newer && updateInfo.url) {
    chrome.tabs.create({ url: updateInfo.url });
    chrome.notifications.clear(id);
  }
});

// ------------------------------------------------------------ Panelfenster

// Ein echtes Fenster statt eines Action-Popups: Popups schließen sich, sobald
// der Fokus wechselt — genau dann, wenn man sich gerade anmelden soll.
let panelWindowId = null;

async function openPanel() {
  if (panelWindowId != null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true, drawAttention: true });
      return;
    } catch {
      panelWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("panel.html"),
    type: "popup",
    // Startmaß; das Panel misst seinen Inhalt und passt das Fenster selbst an.
    width: 560,
    height: 760
  });
  panelWindowId = win.id;
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === panelWindowId) panelWindowId = null;
});

chrome.action.onClicked.addListener(openPanel);

// -------------------------------------------------------------- Ausloeser

chrome.commands.onCommand.addListener((command) => {
  if (command === "punch-in") book("in", null);
  if (command === "punch-out") book("out", null);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.action === "book") {
    book(msg.kind, msg.time || null, msg.type || null, msg.placeId || null).then(sendResponse);
    return true;
  }
  if (msg.action === "types") {
    loadTypes().then(({ start, end, reason }) =>
      sendResponse({ ok: true, types: start, endType: end, reason: reason || null })
    );
    return true;
  }
  if (msg.action === "refresh-lists") {
    // Zwischenspeicher verwerfen und beide Listen erneut holen.
    typeCache = null;
    placeCache = null;
    placeReason = null;
    Promise.all([loadTypes(), loadPlaces()]).then(([types, places]) =>
      sendResponse({
        ok: true,
        types: types.start,
        endType: types.end,
        typeReason: types.reason || null,
        places,
        placeReason: places.length ? null : placeReason
      })
    );
    return true;
  }
  if (msg.action === "sf-hosts") {
    // Die eigene Instanz steht in den offenen Tabs — verlässlicher als eine
    // gepflegte Liste der SAP-Rechenzentren.
    chrome.tabs.query({ url: SF_GLOBS }).then((tabs) => {
      const hosts = new Set();
      for (const tab of tabs) {
        try {
          hosts.add(new URL(tab.url).hostname);
        } catch {}
      }
      sendResponse({ ok: true, hosts: [...hosts].sort() });
    });
    return true;
  }
  if (msg.action === "brand-changed") {
    applyBrandIcon();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "check-update") {
    checkForUpdate({ quiet: false }).then(sendResponse);
    return true;
  }
  if (msg.action === "update-info") {
    chrome.storage.local
      .get({ updateInfo: null })
      .then(({ updateInfo }) =>
        sendResponse(updateInfo || { current: chrome.runtime.getManifest().version })
      );
    return true;
  }
  if (msg.action === "places") {
    loadPlaces().then((places) =>
      sendResponse({ ok: true, places, reason: places.length ? null : placeReason })
    );
    return true;
  }
  if (msg.action === "set-place") {
    setPlace(msg.date, msg.placeId || null).then(sendResponse);
    return true;
  }
  if (msg.action === "week") {
    loadWeek(msg.date || null, Boolean(msg.wait)).then(sendResponse);
    return true;
  }
  if (msg.action === "replace-day") {
    replaceDay(msg.day || {}).then(sendResponse);
    return true;
  }
  if (msg.action === "book-days") {
    bookDays(msg.items || []).then(sendResponse);
    return true;
  }
  if (msg.action === "get-settings") {
    settings().then(sendResponse);
    return true;
  }
  if (msg.action === "set-settings") {
    chrome.storage.local.set(msg.values || {}).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === "set-start-type") {
    chrome.storage.local.set({ startType: msg.type }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === "get-state") {
    sendResponse(state);
    return false;
  }
  if (msg.action === "focus-login" && state.loginTabId != null) {
    chrome.tabs.update(state.loginTabId, { active: true }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
