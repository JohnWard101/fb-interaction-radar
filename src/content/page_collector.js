(() => {
  if (window.__FB_RADAR_PAGE_COLLECTOR__) return;
  window.__FB_RADAR_PAGE_COLLECTOR__ = true;

  const UNIT_SELECTOR = '[aria-posinset], [data-pagelet^="FeedUnit"], [role="article"]';

  function buildPostUrlFromPcbId(pcbId) {
    const u = new URL(location.href);
    if (u.pathname === "/profile.php" && u.searchParams.get("id")) {
      return `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(pcbId)}&id=${encodeURIComponent(u.searchParams.get("id"))}`;
    }
    const pageSlug = u.pathname.split("/").filter(Boolean)[0];
    if (pageSlug) {
      return `https://www.facebook.com/${pageSlug}/posts/${pcbId}`;
    }
    return `https://www.facebook.com/${pcbId}`;
  }

  function cleanPostUrl(rawHref, { stripCommentParams = false, allowPhoto = false } = {}) {
    try {
      const u = new URL(rawHref, location.origin);
      if (!/(?:^|\.)facebook\.com$/i.test(u.hostname)) return null;

      if (u.searchParams.has("comment_id") || u.searchParams.has("reply_comment_id")) {
        if (!stripCommentParams) return null;
        u.searchParams.delete("comment_id");
        u.searchParams.delete("reply_comment_id");
      }

      const path = u.pathname;
      const isStrongPost =
        /\/posts\//i.test(path) ||
        /\/permalink\.php/i.test(path) ||
        /\/videos\//i.test(path) ||
        /\/reel\//i.test(path) ||
        u.searchParams.has("story_fbid");

      if (!isStrongPost) {
        if (/^\/photo/i.test(path) && u.searchParams.has("fbid")) {
          const setParam = u.searchParams.get("set") || "";
          const pcbMatch = /^(?:pcb|gm)\.(\d+)/i.exec(setParam);
          if (pcbMatch) {
            return buildPostUrlFromPcbId(pcbMatch[1]);
          }
          if (!allowPhoto) return null;
        } else {
          return null;
        }
      }

      ["fbclid", "mibextid", "__cft__[0]", "__tn__", "notif_id", "notif_t", "ref"].forEach((k) => {
        u.searchParams.delete(k);
      });
      return `${u.origin}${u.pathname}${u.search}`.replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  function hydrateUnitLinks(unit) {
    const anchors = Array.from(unit.querySelectorAll('a[href="#"], a[role="link"]')).slice(0, 20);
    for (const a of anchors) {
      a.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      a.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    }
  }

  function pickCanonicalUrlFromFeedUnit(unit) {
    const links = Array.from(unit.querySelectorAll("a[href]"));

    // 1. Link bài viết chuẩn (/posts/, /permalink.php, story_fbid=) — kể cả cắt từ link comment
    for (const a of links) {
      const url = cleanPostUrl(a.href, { stripCommentParams: true, allowPhoto: false });
      if (url && (/\/posts\//i.test(url) || /\/permalink\.php/i.test(url) || /story_fbid=/i.test(url))) {
        return url;
      }
    }
    // 2. Link video / reel hoặc tự khôi phục bài album từ set=pcb.<id>
    for (const a of links) {
      const url = cleanPostUrl(a.href, { stripCommentParams: false, allowPhoto: false });
      if (url) return url;
    }
    // 3. Fallback cuối cho bài đăng 1 ảnh đơn lẻ trong Feed Unit
    for (const a of links) {
      const label = (a.getAttribute("aria-label") || "").toLowerCase();
      if (/ảnh bìa|cover photo|ảnh đại diện|profile picture/.test(label)) continue;
      const url = cleanPostUrl(a.href, { stripCommentParams: false, allowPhoto: true });
      if (url) return url;
    }
    return null;
  }

  function getTopFeedUnits() {
    const main = document.querySelector('[role="main"]') || document.body;
    return Array.from(main.querySelectorAll(UNIT_SELECTOR)).filter(
      (el) => !el.parentElement?.closest(UNIT_SELECTOR) && (el.innerText || "").trim().length > 15
    );
  }

  function extractVisiblePostUrls(limit) {
    const found = [];
    const seen = new Set();
    const units = getTopFeedUnits();

    for (const unit of units) {
      const postUrl = pickCanonicalUrlFromFeedUnit(unit);
      if (!postUrl || seen.has(postUrl)) continue;
      seen.add(postUrl);
      found.push(postUrl);
      if (found.length >= limit) break;
    }
    return found;
  }

  function findFirstSearchResultPageUrl() {
    const root = document.querySelector('[role="main"]') || document.body;
    const links = Array.from(root.querySelectorAll("a[href]"));
    for (const a of links) {
      try {
        const u = new URL(a.href, location.origin);
        if (!/(?:^|\.)facebook\.com$/i.test(u.hostname)) continue;
        const p = u.pathname.toLowerCase();
        if (
          p === "/" ||
          p.startsWith("/search") ||
          p.startsWith("/hashtag") ||
          p.startsWith("/friends") ||
          p.startsWith("/groups") ||
          p.startsWith("/watch") ||
          p.startsWith("/marketplace")
        ) {
          continue;
        }
        const text = (a.textContent || "").trim();
        if (text.length >= 2) {
          return `${u.origin}${u.pathname}${u.searchParams.has("id") ? `?id=${u.searchParams.get("id")}` : ""}`;
        }
      } catch {
        // Bỏ qua URL không hợp lệ
      }
    }
    return null;
  }

  async function collectPagePosts({ limit = 5 }) {
    const maxScrolls = Math.min(20, Math.max(5, limit * 2));
    const all = new Set();

    const waitStart = Date.now();
    while (Date.now() - waitStart < 7000) {
      if (getTopFeedUnits().length > 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    for (let i = 0; i < maxScrolls; i++) {
      const units = getTopFeedUnits();
      for (const unit of units) {
        hydrateUnitLinks(unit);
      }
      await new Promise((r) => setTimeout(r, 250));

      for (const u of extractVisiblePostUrls(limit * 2)) {
        all.add(u);
        if (all.size >= limit) break;
      }
      if (all.size >= limit) break;

      const lastUnit = units[units.length - 1];
      if (lastUnit) {
        lastUnit.scrollIntoView({ behavior: "instant", block: "end" });
      }
      window.scrollBy(0, 1200);
      chrome.runtime.sendMessage({ type: "CDP_WHEEL_SCROLL", deltaY: 1200 }, () => {
        void chrome.runtime.lastError;
      });
      await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 400)));
    }

    return Array.from(all).slice(0, limit);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    if (message.type === "PICK_FIRST_SEARCH_PAGE") {
      const pageUrl = findFirstSearchResultPageUrl();
      sendResponse({ ok: Boolean(pageUrl), pageUrl });
      return false;
    }

    if (message.type === "COLLECT_PAGE_POSTS") {
      collectPagePosts({ limit: message.limit || 5 })
        .then((urls) => sendResponse({ ok: true, urls }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || "Lỗi thu thập bài viết" }));
      return true;
    }

    return false;
  });
})();