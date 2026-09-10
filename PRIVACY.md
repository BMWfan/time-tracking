# Privacy Policy

**Time Tracking** — last updated 2026-09-10

## Summary

The extension has no backend. It talks to your employer's SAP SuccessFactors instance and, if you switch that on, to your own Home Assistant instance. The author operates no server, receives no data, and has no way to see what you book.

## What is stored, and where

Everything is kept in `chrome.storage.local` on your own device:

| Data | Purpose |
|---|---|
| Assignment ID | Identifies your assignment when booking time events |
| Default arrival type and default times | Pre-selection in the user interface |
| Home Assistant address and access token | Only when the integration is enabled; used to read your zone history |
| Person entity, zone name, fallback place of work | Only when the integration is enabled |
| Last update check result | Shows whether a newer release exists |

None of it is transmitted anywhere except to the two hosts you configure. The Home Assistant token is sent only to the address you entered, as an `Authorization` header.

## Network connections

| Host | When | Why |
|---|---|---|
| `*.successfactors.eu` | On every booking and when reading the week | Reads and writes your time events, day totals and place of work using your existing browser session. No credentials are stored — the browser's own session applies. |
| Your Home Assistant address | Only with the integration enabled | Reads the location history of the person entity you configured |
| `api.github.com` | Once a day | Compares the installed version with this repository's latest release |

## What the extension does not do

- No analytics, telemetry, tracking or advertising
- No transmission of data to the author or any third party
- No reading of browsing history, bookmarks or other sites
- No storage of passwords; sign-in happens in your browser as usual

## Permissions

| Permission | Reason |
|---|---|
| `scripting` | Runs the API calls in a tab on your SuccessFactors host so that your browser session authenticates them |
| `tabs` | Finds an existing SuccessFactors tab or opens one in the background, and waits for the sign-in when the session expired |
| `notifications` | Reports the result of a booking and the daily total |
| `storage` | Stores the settings listed above |
| `alarms` | Schedules the daily update check |
| `https://*.successfactors.eu/*` | The instance the extension works with |
| `https://api.github.com/*` | Update check |
| Optional host permission | Requested at runtime only when you save a Home Assistant address, and only for that address |

## Removal

Uninstalling the extension deletes everything it stored. Time events already booked live in SuccessFactors and are unaffected.

## Contact

Issues and questions: <https://github.com/BMWfan/time-tracking/issues>
