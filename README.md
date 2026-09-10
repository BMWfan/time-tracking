# peoplehub Time Tracking

A Chrome / Edge browser extension (Manifest V3) for **SAP SuccessFactors Time Tracking**. It books clock-in and clock-out events, fills in forgotten days, and sets the place of work — without opening the time sheet.

Nothing tenant-specific is hard-coded. Event types, places of work and your assignment are read from your own SuccessFactors instance at runtime or configured in the extension's settings.

[Home Assistant](https://www.home-assistant.io) is **optional**: switched on, it pre-fills arrival and departure from your location history and derives the place of work from the zone you were in. Switched off — the default — the extension works on its own with default times you adjust by hand.

---

## Features

### Always available

- **Clock in / clock out** from a small window, a keyboard shortcut, or a desktop shortcut — no visible page, no navigation
- **Daily total after clocking out** — taken from SuccessFactors' own valuation, so the automatic break deduction is already applied
- **Type of arrival** — office, home office, customer, travel … the list comes from `getActiveTimeEventTypesForUserAndDateTime`, so it always matches what your time profile accepts
- **Fill in missed days** — a week view marks days without bookings and offers editable arrival and departure fields
- **Complete open days** — if only the clock-out is missing, the day offers just that field
- **Place of work** — pick it per day; correctable at any time, including for days already booked
- **Silent single sign-on** — if the SuccessFactors session has expired, the extension opens a background tab; where SSO is silent you see nothing, otherwise it brings the tab forward, says it is waiting for the login and continues on its own afterwards
- **Previous / next week** — corrections are not limited to the current week

### With Home Assistant enabled

- Arrival and departure are **pre-filled from your zone history** instead of default times
- The **place of work** is derived from the zone you were in and written automatically after clocking out
- The **type of arrival** defaults to home office on days with no work-zone visit

---

## Installation

The extension is not in any store. Grab it either way:

- **Latest release** — download the ZIP from the [Releases](../../releases) page and unpack it
- **Current main** — *Code → Download ZIP*, or `git clone`

Then load it unpacked:

1. Open `chrome://extensions` or `edge://extensions/`
2. Enable **Developer mode**
3. Choose **Load unpacked** and select the folder

### Updates

An extension loaded unpacked is never updated by the browser — `update_url` is ignored for those. Instead the extension checks once a day against this repository's latest release, puts a badge on its toolbar icon and shows a notification when a newer version exists; clicking it opens the release page. The *Settings* tab shows the installed version and checks on demand.

Installing the update stays a manual step: download, replace the folder, press reload on the extensions page. Truly unattended updates would require a signed CRX, a hosted update manifest and an enterprise policy permitting installation from outside the store.

The extension ID is pinned via the `key` field in `manifest.json`, so it stays the same across reloads — desktop shortcuts keep working.

### Desktop shortcuts (optional)

Create a shortcut to your browser with the extension's panel as an app window:

```
msedge.exe --profile-directory="Default" --app=chrome-extension://<EXTENSION-ID>/panel.html?auto=in
```

`?auto=in` books the arrival, `?auto=out` the departure. The arrival window closes itself after a moment; after clocking out it stays open so the daily total remains readable.

### Keyboard shortcuts

`Alt+Shift+K` books an arrival, `Alt+Shift+G` a departure — both with the current time and the last chosen type. Change them under `chrome://extensions/shortcuts`.

---

## Configuration

Everything tenant- and person-specific lives in the extension's **Settings** tab, stored in `chrome.storage.local`. Nothing of it is in this repository.

### Required

| Setting | Meaning |
|---|---|
| Assignment ID | Your assignment in SuccessFactors. Without it nothing is booked. It appears in the payload of every clock-in request the web UI sends — open the network tab once, or ask your HR system administrator. |

### Optional

| Setting | Meaning |
|---|---|
| Default type of arrival | Pre-selected in the *Today* tab and used by the keyboard and desktop shortcuts. |
| Default times | Proposed when filling in a day and nothing better is known. Defaults to 08:00 / 16:45. |

### Home Assistant (only when the switch is on)

Turning the switch on makes these fields mandatory; the extension refuses to save an incomplete configuration.

| Setting | Meaning |
|---|---|
| Address | e.g. `https://ha.example.com`. Saving it asks for browser permission for that host — the extension ships without one. |
| Long-lived access token | Home Assistant → Profile → Security → *Long-lived access tokens*. Stored locally only, never sent anywhere else. |
| Person entity | e.g. `person.max` — the entity whose zone history is evaluated. |
| Zone without a code | Optional. A zone name that should count as work although it carries no code, e.g. a legacy `Work` zone. |
| Place of work for zones without a code | Optional. Used together with the setting above. |

Additional requirements when the switch is on:

- **Zones named with the place-of-work code** (see below), otherwise arrival times are recognised but the place of work is not
- **A person entity with location history** — the `recorder` retention decides how far back days can be filled in; the default of roughly ten days does not cover the previous week
- **Reachability from the browser** — a Home Assistant behind mutual TLS only answers once the client certificate has been presented, which a background request cannot ask for; visiting the address in a tab once per browser session is enough, or set `AutoSelectCertificateForUrls` for that host

### Zone naming

With Home Assistant enabled, the extension derives the place of work from the **zone name**, expecting the SuccessFactors code in parentheses at the end:

```
Büro Musterstadt (XXX_Office_Musterstadt)
Homeoffice (XXX_A_Homeoffice)
```

`XXX_Office_Musterstadt` is a placeholder — use the `externalCode` values of your own `cust_PlaceOfWork` picklist. The extension lists them in the place-of-work dropdown, so you can read them off there. Add a zone in that form and it works immediately; there is no location list in the code. Several zones may share a code, which is useful when a city has more than one office.

SuccessFactors provides codes and labels but **no coordinates**, so zones cannot be created automatically — you place them yourself in Home Assistant.

---

## How it works

The extension does not scrape the time sheet. It calls the same OData v4 services the web UI uses, from a tab on your SuccessFactors host, so the browser's own session applies — no token, no stored cookie.

| Purpose | Service |
|---|---|
| Book time events | `timeeventprocessing/ManageClockInClockOut.svc/v2/TimeEvents` |
| Available event types | `…/TimeEventTypes/getActiveTimeEventTypesForUserAndDateTime` |
| Week, day totals, attendance records | `timemanagement/attendance/AttendanceRecordingUi.svc/v2/TimeSheetSummary` |
| Places of work | `…/VH_cust_PlaceOfWork_OF_EmployeeTimeSheetEntry` |

Two details worth knowing:

- The **place of work** is not part of a time event. It belongs to the attendance record, which only exists once arrival and departure have been paired — that is why it is written after clocking out. The field expects the picklist's `internalId` as a string; the external code is rejected.
- Writing the place of work changes the record's `origin` from `IMPORT` to `UNKNOWN`. The times stay untouched, but the record is no longer flagged as imported from punches.

---

## Limitations

- **Approved weeks** may reject new events. The error message from SuccessFactors is shown as-is.
- **Home Assistant history retention** governs how far back days can be filled in — only relevant when the integration is on. The default keeps roughly ten days; for the previous week to be usable, raise `recorder: purge_keep_days` accordingly.
- **Deleting time events** is not possible through the API (`405`); use the web UI.
- Zone accuracy depends on your GPS radius. Radii below roughly 100 m tend to produce spurious exits during the day.

---

## Development

```bash
node --check src/background.js
node --check src/panel.js
python scripts/generate-icons.py    # regenerates icons/*.png
```

There is no build step — the repository is the extension.
