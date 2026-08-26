# Privacy Policy

**Extension**: Browser Companion · History & Tab Manager
**Version**: 4.1
**Effective Date**: August 26, 2026
**Developer / Contact**: This is an open-source extension hosted at https://github.com/yoyo636/chromium-history-cleaner . For any questions regarding this policy, please reach us via the Issues section of this repository.

---

## 1. TL;DR

**This extension does not collect, store, transmit, or sell any user data on any server. All data processing happens locally on your device (in your browser).** The extension contains no analytics SDK, no advertising SDK, no trackers, and no third-party code; it does not load any external CDN resources.

---

## 2. Data We Process

This extension reads local data **only when you actively use a feature**, through official browser APIs, solely to fulfill the requested function:

| Data category | Purpose | Leaves device? |
| --- | --- | --- |
| Browsing history (visit time / title / URL) | History module: query, preview, filter, delete by range, export; Stats module: visit analysis | No |
| Tab info (title / URL / window) | Tabs module: batch close, dedupe, close by domain, copy URLs, save session | No |
| Bookmarks | Bookmarks module: dedupe, dead-link check, export (JSON / HTML), delete | No |
| Download records (filename / source URL / file size) | Downloads module: view, open, show folder, remove record; Cleanup module: real size display | No |
| Browsing data (cache / cookies / history / form data / passwords etc.) | Cleared via system APIs **only after you click "Clean" and confirm**. The extension never reads or stores the contents of cookies or passwords | No |
| Saved sessions (list of URLs) | Sessions module: save / restore / delete, stored in the extension's local storage | No |
| Web interaction signals (mouse movement / scrolling / typing rhythm / long tasks / frame rate) | Eye-care & Performance modules compute fatigue level and resource usage locally for progressive reading adjustments and load alerts | No |
| Fingerprint API call events (whether pages read Canvas / WebGL fingerprint APIs) | Privacy module generates a local report to help you identify potential tracking; "Shield" mode randomizes fingerprint output locally | No |
| Preferences (theme / default time range / toggles) | Save your personalized settings in the extension's local storage | No |

**We explicitly do NOT collect**: your name, email, account credentials, passwords, payment information, real identity, or any personally identifiable information.

---

## 3. Incognito (Private Browsing) Mode

In incognito windows, this extension follows the browser's incognito semantics:
- Records produced in incognito mode (e.g., privacy fingerprint reports, fatigue data) are also stored locally only and are handled by the browser's incognito rules when the session ends.
- The Privacy module marks whether a fingerprint call occurred in incognito mode, helping you understand which sites attempt to identify your device during incognito browsing.
- Note: incognito mode alone cannot prevent fingerprint-based device identification. The extension's "Shield" mode randomizes Canvas / WebGL fingerprints locally to reduce identifiability; this involves no data transmission.

---

## 4. Storage and Retention

- Data produced by the extension (preferences, saved sessions, daily fatigue curve, privacy events, performance snapshots) is stored in the browser-provided `chrome.storage.local` and is **never uploaded to any remote server**.
- Built-in browser data (history, bookmarks, downloads) is managed by the browser itself; this extension only queries or deletes it on your instruction.
- You can, at any time:
  - Click "Clear records" on the Privacy page to delete local privacy events;
  - Delete saved sessions on the Sessions page;
  - **Uninstall the extension** to remove all local data produced by it (uninstalling removes `chrome.storage.local` data together with the extension).
  - The extension keeps no server-side copy, so no separate server-side deletion request is needed.

---

## 5. Sharing and Third Parties

- **We do not** sell, rent, or share your data with any third party.
- The extension contains no third-party analytics, advertising, crash-reporting, or statistics SDKs; all code is bundled inside the extension package and no external scripts or CDNs are loaded.
- Network requests are limited to two types, both executed by the browser and carrying no user data: (1) the bookmarks "dead-link check" sends a `HEAD` request to a bookmark URL (transmitting only that URL itself, to determine whether the link is broken); (2) normal navigation initiated by you. No other network transmission is made by the extension.

---

## 6. Permissions

This extension declares the following permissions, all used for the functions described above under the principle of least privilege:

| Permission | Purpose |
| --- | --- |
| `history` | History query, delete by range / by URL, export |
| `tabs` / `sessions` | Tab management, restore recently closed, save sessions |
| `bookmarks` | Bookmark dedupe, dead-link check, export, delete |
| `downloads` | Download record management, export files to disk |
| `browsingData` | Clear browsing data (cache, cookies, etc.) after your confirmation |
| `tabCapture` | Audio module: capture the current tab's audio stream for spectrum classification only when you click "Analyze" |
| `scripting` / `host_permissions` (http/https) | Privacy module script injection (fingerprint monitoring & randomization), eye-care / performance content scripts |
| `notifications` | High-load and auto-mute alerts |
| `storage` | Store preferences, sessions, and local fatigue / privacy / performance data |

---

## 7. Children's Privacy

This extension is not designed for children under 13 and does not knowingly collect personal information from children.

---

## 8. Policy Changes

If this policy changes, we will update this page and the store listing with a new effective date. Material changes will be announced on the store page.

---

## 9. Contact Us

For any questions about this policy or the extension's data handling, please contact us via the GitHub repository Issues: https://github.com/yoyo636/chromium-history-cleaner/issues

---

*Last updated: August 26, 2026.*
