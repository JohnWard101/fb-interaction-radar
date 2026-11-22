# Interaction Radar for Facebook

A Manifest V3 Chromium Side Panel extension that cross-checks public Facebook interactions (**Reactions**, **Comments**, and **Shares**) across multiple posts or Pages against a target list of profiles, rendered as an interactive **Target × Post** matrix directly in your browser.

> **Local-first:** All scanning, caching (IndexedDB + `chrome.storage.local`), and matching happen locally inside your active Facebook browser session. No external backend server is used.

---

## Features

- **Two Source Modes:**
  - **Mode A (By Post URLs):** Scan one or more specific Facebook post, video, or reel URLs.
  - **Mode B (By Pages / Profiles):** Enter Page names or URLs to automatically discover and scan up to `N` recent posts per Page with a configurable delay.
- **Flexible Target Input:** Accepts numeric Facebook IDs, `profile.php?id=...`, `/people/.../<id>`, `/groups/.../user/<id>`, `/username` links, or plain display names.
- **Dual Execution Engines:**
  - **Option 1 (Popup Scanner Window):** Opens a temporary unfocused popup window, hooks `/api/graphql` in the `MAIN` world (`main_tapper.js`), expands comments, switches reaction tabs/paginates cursors, and merges with DOM fallbacks.
  - **Option 2 (Headless Fetch):** Fetches post SSR HTML and replays auto-learned GraphQL `doc_id`s (`learnedDocIds`), with optional automatic fallback to Option 1 when data is incomplete.
- **Matrix & Dossier Inspector:**
  - Click any cell to inspect engagement depth (`Passive`, `Vocal`, `Advocate`), match confidence (`exact_id`, `exact_username`, `exact_name`, `partial_name`), post reaction mood breakdown, comment text/media tags, and comment position rank.
- **Export & Cache:**
  - Copy text summary to clipboard, export **CSV** (with UTF-8 BOM for Excel and CSV formula-injection escaping), or export full **JSON**.
  - Local IndexedDB scan cache (`Quét lại từ Facebook` toggle to force refresh).

---

## Project Structure

```text
├── manifest.json
├── src/
│   ├── background/
│   │   └── background.js        # Tab/window orchestration, debugger keep-awake, DNR headers, profile ID resolver
│   ├── content/
│   │   ├── content.js           # DOM expansion, modal/tab reaction scanning, comment/share scraping
│   │   ├── main_tapper.js       # MAIN-world fetch/XHR hook for GraphQL chunks & cursor pagination
│   │   └── page_collector.js    # Mode B post URL collector & Page search picker
│   ├── core/
│   │   ├── db.js                # IndexedDB post scan cache
│   │   ├── graphql_parser.js    # GraphQL chunk parser, interaction extractor, comment merger
│   │   ├── insights.js          # Sentiment pulse, comment rank, CSV/JSON/summary builders
│   │   ├── matcher.js           # Target-to-actor identity matcher & dossier builder
│   │   ├── matrix_view.js       # Matrix table & dossier UI renderer
│   │   ├── parser.js            # Multi-line URL/ID/name input parser & Vietnamese accent folder
│   │   └── ssr_parser.js        # SSR HTML token, interaction, post URL, and profile ID extractor
│   └── sidepanel/
│       ├── sidepanel.html
│       ├── sidepanel.css
│       └── sidepanel.js         # Side Panel state, scan queue, exports
└── tests/
    └── core.test.mjs            # Node unit tests for core parsers, matcher, and insights
```

---

## Installation (Developer Mode)

1. Clone or download this repository.
2. Open Chrome / Opera / Edge and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project root folder (the folder containing `manifest.json`).
5. Make sure you are signed in to Facebook in the same browser profile, then click the extension icon to open the Side Panel.

### Running Unit Tests

Requires Node.js (v18+):

```bash
node --test
```

---

## Known Limits & Constraints

### 1. Visibility & Session Scope
- **Public / visible data only:** Uses your active browser session. It cannot read posts your account cannot view, private shares (only publicly visible reshares appear), or interactions hidden by user/post privacy settings.
- **Account safety & rate limits:** Scanning many posts or Pages too quickly on a single Facebook account may trigger Facebook rate limits or temporary security checkpoints. Use Mode B's delay setting (`2–15s`) conservatively.

### 2. Built-in Scan Caps
To prevent runaway tabs and excessive requests, Option 1 caps each post scan at:
- **Reactions:** `maxReactionScrolls = 40` (~400 reactions per tab/cursor pass). Posts with thousands of reactions will be truncated at that cap.
- **Comments:** `maxCommentClicks = 20` "View more comments / replies" expansion clicks. Very deep comment threads may not be fully expanded.
- **Shares:** `maxShareScrolls = 15` scroll steps in the public shares dialog.
- **Mode B discovery:** `1–30` recent posts per Page (`page_collector.js` scrolls up to `5–20` steps).

### 3. Option 2 (Headless Fetch) Limitations
- **Warm-up required:** Headless GraphQL queries depend on `doc_id` templates auto-learned during normal browsing or Option 1 runs (`0/3` slots: `reactions`, `comments`, `shares`). Until learned (or when Facebook rotates `doc_id`s), Option 2 falls back to SSR HTML only or triggers Option 1 auto-fallback.
- **Single-page fetch:** `handleHeadlessScan` queries only the first GraphQL batch per learned slot (no cursor pagination in headless mode).
- **Page name search:** Searching a Page by name (rather than URL) in Mode B cannot run in pure headless fetch and requires a browser tab.

### 4. Identity Matching Edge Cases
- **Plain display names:** Searching by name only (no URL or numeric ID) folds Vietnamese accents and allows partial substring matching (`>= 4` characters), which can produce false positives for common names. Always prefer profile URLs or numeric IDs.
- **Restricted profiles:** If a target's profile hides its numeric ID in SSR HTML (`extractProfileIdentityFromHtml`), the extension falls back to `username` matching and cross-post GraphQL enrichment (`enrichTargetsFromScans`). If an actor only appears as `profile.php?id=...` on a single scanned post with no `username` link, it cannot match a `username`-only target.
- **DOM-only reaction fallback:** When reactions are scraped strictly from DOM links rather than intercepted GraphQL responses, Facebook does not expose individual reaction types in link text, so DOM fallback entries default to `LIKE`.

### 5. Browser & Distribution Constraints
- **Popup & debugger banner:** Option 1 opens a temporary unfocused popup window (`chrome.windows.create`) to prevent background-tab React/IntersectionObserver throttling and attaches `chrome.debugger` for keep-awake and wheel dispatch (browsers may display a *"started debugging this browser"* banner while a scan is active).
- **Facebook UI/Schema changes:** Relies on Facebook Comet's DOM attributes (`[role="dialog"]`, `[role="tab"]`, `[role="article"]`) and GraphQL payload shapes, which Facebook may change at any time.
- **Chrome Web Store:** Due to the `debugger` permission and `https://*.facebook.com/*` host scraping behavior, this project is best used unpacked locally or distributed privately rather than as a Public Chrome Web Store listing.

---

## Disclaimer

This tool is intended for personal workflow automation and authorized public-data cross-checking only. It is not affiliated with, endorsed by, or connected to Meta Platforms, Inc. or Facebook. You are responsible for complying with applicable terms of service and privacy laws.
```
