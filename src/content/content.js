(() => {
  if (window.__FB_RADAR_CONTENT_INSTALLED__) return;
  window.__FB_RADAR_CONTENT_INSTALLED__ = true;

  const secret = crypto.randomUUID();
  let parserModulePromise = null;
  let activeRun = null;
  let scanReactionDiag = null;
  let currentBufferRunId = 0;

  function getParser() {
    if (!parserModulePromise) {
      parserModulePromise = import(chrome.runtime.getURL("src/core/graphql_parser.js"));
    }
    return parserModulePromise;
  }

  getParser().catch(() => {});

  // Kích hoạt kênh bí mật 1 lần với MAIN world
  document.dispatchEvent(new CustomEvent("fb-radar:configure", { detail: { secret } }));

  const gqlBuffer = {
    reactions: [],
    comments: [],
    shares: [],
    reactorsPageInfo: null,
    hasCursorQuery: false,
    chunkSeq: 0
  };

  document.addEventListener("fb-radar:graphql-chunk", async (ev) => {
    if (!ev?.detail || ev.detail.secret !== secret) return;
    const chunkRunId = currentBufferRunId;
    if (ev.detail.hasCursorQuery) {
      gqlBuffer.hasCursorQuery = true;
    }
    try {
      const { parseGraphqlChunks, extractInteractionsFromPayload, extractReactorsPageInfo } = await getParser();
      if (chunkRunId !== currentBufferRunId) return;
      const objs = parseGraphqlChunks(ev.detail.rawText);
      for (const obj of objs) {
        const extracted = extractInteractionsFromPayload(obj);
        gqlBuffer.reactions.push(...extracted.reactions);
        gqlBuffer.comments.push(...extracted.comments);
        gqlBuffer.shares.push(...extracted.shares);
        const pageInfo = extractReactorsPageInfo(obj);
        if (pageInfo) gqlBuffer.reactorsPageInfo = pageInfo;
      }
      gqlBuffer.chunkSeq += 1;
    } catch {
      // Bỏ qua chunk lỗi
    }
  });

  document.addEventListener("fb-radar:docid-hint", (ev) => {
    if (!ev?.detail || ev.detail.secret !== secret) return;
    chrome.runtime.sendMessage({
      type: "LEARN_DOC_ID_BODY",
      body: ev.detail.body
    }, () => {
      void chrome.runtime.lastError;
    });
  });

  function resetGqlBuffer() {
    currentBufferRunId += 1;
    gqlBuffer.reactions = [];
    gqlBuffer.comments = [];
    gqlBuffer.shares = [];
    gqlBuffer.reactorsPageInfo = null;
    gqlBuffer.hasCursorQuery = false;
    gqlBuffer.chunkSeq = 0;
    scanReactionDiag = null;
  }

  function fetchReactorsPageInMain(cursor, run) {
    if (!cursor || run.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        document.removeEventListener("fb-radar:fetch-reactors-page-done", onDone);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 6000);
      function onDone(ev) {
        if (ev?.detail?.secret === secret && ev.detail.requestId === requestId) {
          finish(Boolean(ev.detail.ok));
        }
      }
      document.addEventListener("fb-radar:fetch-reactors-page-done", onDone);
      document.dispatchEvent(
        new CustomEvent("fb-radar:fetch-reactors-page", {
          detail: { secret, requestId, cursor }
        })
      );
    });
  }

  function jitter(baseMs) {
    return baseMs + Math.floor(Math.random() * 450);
  }

  async function sleepControlled(ms, run) {
    const step = 150;
    let elapsed = 0;
    while (elapsed < ms) {
      if (run.aborted) throw new Error("ABORTED");
      if (!run.paused) elapsed += step;
      await new Promise((r) => setTimeout(r, step));
    }
  }

  async function waitForPostReady(run, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (run.aborted) throw new Error("ABORTED");
      const root = document.querySelector('[role="dialog"]') || document.querySelector('[role="main"]');
      if (root) {
        const txt = root.innerText || "";
        const hasUfiOrComments =
          Boolean(root.querySelector('[role="article"] [role="article"]')) ||
          Boolean(root.querySelector('[aria-label*="cảm xúc" i], [aria-label*="reaction" i]')) ||
          /Phù hợp nhất|Most relevant|Tất cả bình luận|All comments|Bình luận dưới tên|Write a comment/i.test(txt);

        if (hasUfiOrComments) {
          // Chờ thêm 700ms để batch comment/reaction đầu tiên gắn hoàn chỉnh vào DOM
          await sleepControlled(700, run);
          return;
        }
      }
      await sleepControlled(350, run);
    }
  }

  function findPrimaryPostRoot() {
    // Nếu bài viết đang mở trong modal permalink ([role="dialog"]), lấy chính dialog đó làm gốc
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const postDialog = dialogs
      .filter((d) => {
        const rect = d.getBoundingClientRect();
        if (rect.width < 250 || rect.height < 200) return false;
        const txt = d.innerText || "";
        return txt.length > 60 && (
          d.querySelector('[role="article"]') ||
          /Bình luận dưới tên|Write a comment|Phù hợp nhất|Most relevant/i.test(txt)
        );
      })
      .sort((a, b) => b.innerText.length - a.innerText.length)[0];
    if (postDialog) return postDialog;

    // Trên trang thường, chọn [role="article"] cấp ngoài cùng (không nằm trong article khác)
    const articles = Array.from(document.querySelectorAll('[role="main"] [role="article"], [role="article"]'));
    const topArticles = articles.filter((a) => !a.parentElement?.closest('[role="article"]'));
    // Chỉ coi một [role="article"] là toàn bộ bài viết nếu nó thật sự chứa phần bình luận/khung nhập bình luận
    const postArticles = topArticles.filter((a) => {
      const txt = a.innerText || "";
      return (
        a.querySelector('[role="article"]') ||
        /Bình luận dưới tên|Write a comment|Phù hợp nhất|Most relevant|Tất cả bình luận|All comments/i.test(txt)
      );
    });
    if (postArticles.length > 0) {
      return postArticles.sort((a, b) => b.innerText.length - a.innerText.length)[0];
    }

    return document.querySelector('[role="main"]') || document.body;
  }

  function normalizeProfileHref(href) {
    if (!href) return "";
    try {
      const u = new URL(href, location.origin);
      if (u.pathname === "/profile.php") {
        const id = u.searchParams.get("id");
        return id ? `https://www.facebook.com/profile.php?id=${id}` : `${u.origin}${u.pathname}`;
      }
      return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
    } catch {
      return href;
    }
  }

  function isLikelyAuthorProfileLink(a) {
    const rawHref = a?.getAttribute("href") || "";
    if (!rawHref || rawHref === "#") return false;

    const text = (a.textContent || "").trim();
    if (text.length < 2) return false;
    if (/^(\d+\s*(giờ|phút|ngày|tuần|tháng|năm|h|m|d|w|y)|Vừa xong|Just now|Thích|Trả lời|Phản hồi|Chia sẻ|Like|Reply|Share|Fan cứng|Top fan|Tác giả|Author)$/i.test(text)) {
      return false;
    }

    try {
      const u = new URL(a.href, location.origin);
      if (!/(?:^|\.)facebook\.com$/i.test(u.hostname)) return false;
      const p = u.pathname.toLowerCase();
      if (
        p === "/" ||
        p.startsWith("/hashtag/") ||
        p.startsWith("/photo") ||
        p.startsWith("/watch") ||
        p.startsWith("/reel") ||
        p.startsWith("/share/") ||
        p.includes("/posts/") ||
        p.includes("/permalink")
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function isInsideNestedComment(el, postRoot) {
    const art = el.closest('[role="article"]');
    if (!art || art === postRoot) return false;
    // Nếu postRoot là dialog hoặc bài gốc có article con -> phần tử nằm trong article con là thuộc comment
    return postRoot.contains(art);
  }

  function findButtonByRegex(root, regex, excludeComments = false) {
    const candidates = Array.from(root.querySelectorAll('[role="button"], button, a[role="button"]'));
    return candidates.find((el) => {
      if (excludeComments && isInsideNestedComment(el, root)) return false;
      const txt = (el.getAttribute("aria-label") || el.textContent || "").trim();
      return regex.test(txt);
    }) || null;
  }

  async function trySwitchAllComments(postRoot, run) {
    const filterBtn = findButtonByRegex(
      postRoot,
      /(Phù hợp nhất|Most relevant|Bình luận hàng đầu|Top comments)/i,
      true
    );
    if (!filterBtn) return;

    filterBtn.scrollIntoView({ block: "center", behavior: "instant" });
    filterBtn.click();
    await sleepControlled(jitter(700), run);

    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'));
    const allItem =
      menuItems.find((el) => /(Tất cả bình luận|All comments)/i.test(el.textContent || "")) ||
      menuItems.find((el) => /(Mới nhất|Newest)/i.test(el.textContent || ""));

    if (allItem) {
      allItem.click();
      await sleepControlled(jitter(1800), run);
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
  }

  async function expandComments(postRoot, maxClicks, run, onProgress) {
    const expandRegex = /(Xem thêm.*bình luận|View.*more comments|Xem các bình luận trước|View previous comments|Xem tất cả.*bình luận|Xem thêm.*\d+.*phản hồi|View.*\d+.*repl|Xem tất cả.*\d+.*phản hồi)/i;
    for (let i = 0; i < maxClicks; i++) {
      if (run.aborted) throw new Error("ABORTED");
      let btn = findButtonByRegex(postRoot, expandRegex, false);
      if (!btn && i === 0) {
        await sleepControlled(800, run);
        btn = findButtonByRegex(postRoot, expandRegex, false);
      }
      if (!btn) break;
      btn.scrollIntoView({ block: "center", behavior: "instant" });
      btn.click();
      onProgress(`Đang mở rộng bình luận (lượt ${i + 1}/${maxClicks})...`);
      await sleepControlled(jitter(1100), run);
    }
  }

  function extractTextWithEmojis(rootEl) {
    let out = "";
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue || "";
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "IMG") {
        const alt = node.getAttribute("alt") || "";
        if (alt) out += alt;
        return;
      }
      if (node.tagName === "BR") {
        out += "\n";
        return;
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(rootEl);
    return out.trim();
  }

  function detectCommentMediaLabel(art, authorLink) {
    const scope = Array.from(art.querySelectorAll("img, video, [aria-label]"));
    for (const el of scope) {
      if (el.closest('[role="article"]') !== art) continue;
      if (authorLink && authorLink.contains(el)) continue;

      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      const src = (el.getAttribute("src") || "").toLowerCase();

      if (/nhãn dán|sticker/.test(label) || src.includes("t39.1997") || src.includes("sticker")) {
        return "[Sticker]";
      }
      if (/\bgif\b/.test(label) || el.tagName === "VIDEO" || src.includes("giphy") || src.includes("tenor")) {
        return "[GIF]";
      }
    }

    const mediaImg = Array.from(art.querySelectorAll("img")).find((img) => {
      if (img.closest('[role="article"]') !== art) return false;
      if (authorLink && authorLink.contains(img)) return false;
      const src = (img.getAttribute("src") || "").toLowerCase();
      if (!src || src.includes("emoji.php") || src.includes("rsrc.php")) return false;
      const rect = img.getBoundingClientRect();
      // Hoạt động cả trong tab nền ẩn (khi rect có thể bằng 0)
      return img.naturalWidth >= 48 || rect.width >= 48 || src.includes("scontent");
    });
    return mediaImg ? "[Ảnh / GIF]" : "";
  }

  function scrapeDomComments(postRoot) {
    const results = [];
    const commentArticles = Array.from(postRoot.querySelectorAll('[role="article"]'));
    for (const art of commentArticles) {
      if (art === postRoot) continue;

      const links = Array.from(art.querySelectorAll("a[href]")).filter(isLikelyAuthorProfileLink);
      const authorLink = links[0];
      if (!authorLink) continue;

      const authorName = authorLink.textContent.trim();
      const commentPermalink = Array.from(art.querySelectorAll('a[href*="comment_id="]'))
        .find((a) => !isLikelyAuthorProfileLink(a))?.href || null;

      const dirAutoEls = Array.from(art.querySelectorAll('[dir="auto"]')).filter((el) => {
        if (el.closest('[role="article"]') !== art) return false;
        const parentDir = el.parentElement?.closest('[dir="auto"]');
        if (parentDir && art.contains(parentDir)) return false;
        if (el.closest('[role="button"], a[href*="comment_id="]')) return false;

        const t = extractTextWithEmojis(el);
        if (!t || t === authorName) return false;
        if (/^(\d+\s*(giờ|phút|ngày|tuần|tháng|năm|giây|h|m|d|w|y|s)|Vừa xong|Just now|Fan cứng|Top fan|Tác giả|Author|Đã chỉnh sửa|Edited|\d+)$/i.test(t)) {
          return false;
        }
        return true;
      });

      const uniqueLines = [...new Set(dirAutoEls.map((el) => extractTextWithEmojis(el)).filter(Boolean))];
      let text = uniqueLines.join("\n").trim();
      if (!text) {
        text = detectCommentMediaLabel(art, authorLink);
      }

      const parentArticle = art.parentElement?.closest('[role="article"]');
      let replyTo = null;
      if (parentArticle && parentArticle !== postRoot) {
        const parentAuthor = Array.from(parentArticle.querySelectorAll("a[href]")).find(isLikelyAuthorProfileLink);
        replyTo = parentAuthor ? parentAuthor.textContent.trim() : null;
      }

      results.push({
        id: null,
        actor: {
          fbId: null,
          name: authorName,
          profileUrl: normalizeProfileHref(authorLink.href)
        },
        text,
        createdTime: null,
        reactionCount: 0,
        replyTo,
        commentUrl: commentPermalink,
        source: "dom"
      });
    }
    return results;
  }

  function findScrollableInDialog(dialog) {
    const firstActor = Array.from(dialog.querySelectorAll("a[href]")).find(isLikelyAuthorProfileLink);
    let cur = firstActor?.parentElement || null;
    while (cur && cur !== dialog) {
      const style = getComputedStyle(cur);
      const scrollable = style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay";
      if (scrollable && cur.scrollHeight > cur.clientHeight + 1 && cur.clientHeight >= 100) {
        return cur;
      }
      cur = cur.parentElement;
    }

    const candidates = Array.from(dialog.querySelectorAll("div")).filter((el) => {
      const style = getComputedStyle(el);
      const scrollable = style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay";
      return scrollable && el.scrollHeight > el.clientHeight + 1 && el.clientHeight >= 100;
    });
    if (candidates.length > 0) {
      return candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    }

    const overflowBox = Array.from(dialog.querySelectorAll("div")).find((el) => {
      const style = getComputedStyle(el);
      const scrollable = style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay";
      return scrollable && el.clientHeight >= 100;
    });
    return overflowBox || dialog;
  }

  async function waitForDialogActors(dialog, run, timeoutMs = 6500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (run.aborted) throw new Error("ABORTED");
      const hasActor = Array.from(dialog.querySelectorAll("a[href]")).some(isLikelyAuthorProfileLink);
      if (hasActor) {
        await sleepControlled(300, run);
        return;
      }
      await sleepControlled(250, run);
    }
  }

  function scrapeDialogActors(dialog) {
    const actors = [];
    const seen = new Set();
    const links = Array.from(dialog.querySelectorAll("a[href]")).filter(isLikelyAuthorProfileLink);
    for (const a of links) {
      const name = (a.textContent || "").trim();
      const profileUrl = normalizeProfileHref(a.href);
      if (!name || seen.has(`${profileUrl}|${name}`)) continue;
      if (/^(Thêm bạn bè|Add friend|Nhắn tin|Message|Theo dõi|Follow|Hủy|Cancel)$/i.test(name)) continue;
      seen.add(`${profileUrl}|${name}`);
      actors.push({ fbId: null, name, profileUrl });
    }
    return actors;
  }

  async function openNewDialogAndWait(trigger, run) {
    const beforeSet = new Set(document.querySelectorAll('[role="dialog"]'));
    trigger.scrollIntoView({ block: "center", behavior: "instant" });
    trigger.click();

    let fallbackDialog = null;
    for (let i = 0; i < 24; i++) {
      await sleepControlled(200, run);
      const addedList = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => !beforeSet.has(d));
      const rich = addedList.find((d) => d.querySelector('a[href], [role="tab"]'));
      if (rich) return rich;
      if (addedList.length > 0) {
        fallbackDialog = addedList[addedList.length - 1];
      }
    }
    return fallbackDialog;
  }

  function closeModalSafe(dialog) {
    if (!dialog) return;
    const closeBtn = dialog.querySelector('[aria-label="Đóng"], [aria-label="Close"]');
    if (closeBtn) closeBtn.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  function isSafeReadOnlyTrigger(el) {
    if (!el) return false;
    // Chặn mọi nút bật/tắt trạng thái (Like/Tim) và mọi nút mở menu (Share/Filter)
    if (el.hasAttribute("aria-pressed")) return false;
    const popupType = (el.getAttribute("aria-haspopup") || "").toLowerCase();
    if (popupType === "menu" || popupType === "listbox") return false;

    const label = (el.getAttribute("aria-label") || "").trim();
    const text = (el.textContent || "").trim();
    const combined = `${label} | ${text}`;

    if (
      /^(Thích|Yêu thích|Thương thương|Haha|Wow|Buồn|Phẫn nộ|Bày tỏ cảm xúc|Chia sẻ|Bình luận|Like|Love|Care|Sad|Angry|React|Share|Comment)$/i.test(text) ||
      /(Gỡ|Thay đổi|Bày tỏ cảm xúc|Gửi nội dung|bảng feed|Remove|Change|Send this|your feed)/i.test(combined)
    ) {
      return false;
    }
    return true;
  }

  function findReactionTrigger(postRoot) {
    const btns = Array.from(postRoot.querySelectorAll('[role="button"], a[role="button"], span[role="button"]')).filter(
      (el) => !isInsideNestedComment(el, postRoot) && isSafeReadOnlyTrigger(el)
    );

    const byLabel = btns.find((el) => {
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
      return /(Tất cả cảm xúc|Xem ai đã bày tỏ|người đã bày tỏ|người khác|All reactions|See who reacted|others)/i.test(label);
    });
    if (byLabel) return byLabel;

    const notCommentOrShare = (el) => {
      const txt = (el.textContent || "").trim();
      const label = (el.getAttribute("aria-label") || "").trim();
      return !/bình luận|comment|chia sẻ|share/i.test(`${label} ${txt}`);
    };

    // Ưu tiên nút tổng số lượng ("71", "71 người") trước icon cảm xúc lẻ ("Yêu thích: 39 người")
    const byTotalCount = btns.find((el) => {
      if (!notCommentOrShare(el)) return false;
      const txt = (el.textContent || "").trim();
      return /^\d[\d.,KkMm]*(\s*(người|people))?$/i.test(txt);
    });
    if (byTotalCount) return byTotalCount;

    return btns.find((el) => {
      if (!notCommentOrShare(el)) return false;
      const label = (el.getAttribute("aria-label") || "").trim();
      return /:\s*\d[\d.,KkMm]*\s*(người|people)/i.test(label);
    }) || null;
  }

  function findShareTrigger(postRoot) {
    const btns = Array.from(postRoot.querySelectorAll('[role="button"], span[role="button"], a')).filter(
      (el) => !isInsideNestedComment(el, postRoot) && isSafeReadOnlyTrigger(el)
    );

    return btns.find((el) => {
      const label = (el.getAttribute("aria-label") || "").trim();
      const text = (el.textContent || "").trim();
      return (
        /(người đã chia sẻ|ai đã chia sẻ|See who shared|People who shared)/i.test(label) ||
        /^\d[\d.,KkMm]*\s*(lượt chia sẻ|chia sẻ|shares?)$/i.test(text) ||
        /\b\d[\d.,KkMm]*\s*(lượt chia sẻ|chia sẻ|shares?)\b/i.test(label)
      );
    }) || null;
  }

  async function scanReactionsModal(postRoot, maxScrolls, run, onProgress) {
    const domReactions = [];
    const trigger = findReactionTrigger(postRoot);
    if (!trigger) return domReactions;

    const dialog = await openNewDialogAndWait(trigger, run);
    if (!dialog) return domReactions;

    await waitForDialogActors(dialog, run);
    let scroller = findScrollableInDialog(dialog);
    let lastHeight = 0;
    let stagnant = 0;

    for (let i = 0; i < maxScrolls; i++) {
      if (run.aborted) throw new Error("ABORTED");
      if (scroller === dialog) scroller = findScrollableInDialog(dialog);

      onProgress(`Đang quét danh sách Reaction (${i + 1}/${maxScrolls})...`);
      const prevGqlCount = gqlBuffer.reactions.length;
      const rect = scroller.getBoundingClientRect();
      const cx = rect.width > 20 ? Math.round(rect.left + rect.width / 2) : 400;
      const cy = rect.height > 20 ? Math.round(rect.top + rect.height / 2) : 350;

      const spinner = dialog.querySelector('[role="progressbar"]');
      const actorLinks = Array.from(dialog.querySelectorAll("a[href]")).filter(isLikelyAuthorProfileLink);
      const lastActor = actorLinks[actorLinks.length - 1];
      if (spinner) spinner.scrollIntoView({ block: "center", behavior: "instant" });
      else if (lastActor) lastActor.scrollIntoView({ block: "end", behavior: "instant" });

      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      chrome.runtime.sendMessage({ type: "CDP_WHEEL_SCROLL", x: cx, y: cy, deltaY: 900 }, () => {
        void chrome.runtime.lastError;
      });

      let gqlGrew = false;
      for (let waitStep = 0; waitStep < 7; waitStep++) {
        await sleepControlled(250, run);
        if (gqlBuffer.reactions.length > prevGqlCount || scroller.scrollHeight > lastHeight) {
          gqlGrew = gqlBuffer.reactions.length > prevGqlCount;
          break;
        }
      }

      if (scroller.scrollHeight === lastHeight && !gqlGrew) {
        stagnant += 1;
        if (stagnant >= 2) break;
      } else {
        stagnant = 0;
        lastHeight = scroller.scrollHeight;
      }
    }

    // Lưu toàn bộ actor đang hiển thị ở tab "Tất cả" trước khi chuyển sang tab cảm xúc con
    for (const actor of scrapeDialogActors(dialog)) {
      domReactions.push({ actor, reactionType: "LIKE", source: "dom" });
    }

    async function paginateReactionsViaGraphql(label) {
      const seenCursors = new Set();
      for (let page = 0; page < maxScrolls; page++) {
        if (run.aborted) throw new Error("ABORTED");
        const pi = gqlBuffer.reactorsPageInfo;
        if (!gqlBuffer.hasCursorQuery || !pi?.hasNextPage || !pi?.endCursor || seenCursors.has(pi.endCursor)) {
          break;
        }
        seenCursors.add(pi.endCursor);
        onProgress(`Đang tải thêm Reaction ${label} (trang ${page + 2})...`);
        const ok = await fetchReactorsPageInMain(pi.endCursor, run);
        if (!ok) break;
        await sleepControlled(jitter(250), run);
      }
    }

    const tabs = Array.from(dialog.querySelectorAll('[role="tab"]'));
    const tabLabels = tabs.map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim());
    let switchedTabs = 0;

    let didFullAllTab = false;
    if (gqlBuffer.hasCursorQuery && gqlBuffer.reactorsPageInfo?.hasNextPage) {
      await paginateReactionsViaGraphql("Tất cả");
      if (tabs[0]?.getAttribute("aria-selected") === "true" && gqlBuffer.reactorsPageInfo?.hasNextPage === false) {
        didFullAllTab = true;
      }
    }
    if (
      !didFullAllTab &&
      (tabs.length >= 2 ||
        gqlBuffer.reactorsPageInfo?.hasNextPage ||
        gqlBuffer.reactions.length >= 10 ||
        domReactions.length >= 10)
    ) {
      for (let tIdx = 0; tIdx < tabs.length; tIdx++) {
        if (run.aborted) throw new Error("ABORTED");
        const tab = tabs[tIdx];
        if (tab.getAttribute("aria-selected") === "true") continue;
        const tabLabel = tabLabels[tIdx] || `#${tIdx}`;
        const prevSeq = gqlBuffer.chunkSeq;
        gqlBuffer.reactorsPageInfo = null;
        tab.click();
        switchedTabs += 1;
        onProgress(`Đang mở tab cảm xúc ${tabLabel}...`);

        for (let w = 0; w < 22; w++) {
          await sleepControlled(150, run);
          if (gqlBuffer.chunkSeq > prevSeq) break;
        }
        await sleepControlled(150, run);
        for (const actor of scrapeDialogActors(dialog)) {
          domReactions.push({ actor, reactionType: "LIKE", source: "dom" });
        }
        await paginateReactionsViaGraphql(tabLabel);
        if (tIdx === 0 && gqlBuffer.hasCursorQuery && gqlBuffer.reactorsPageInfo?.hasNextPage === false) {
          break;
        }
      }
    }

    scanReactionDiag = {
      triggerText: (trigger.getAttribute("aria-label") || trigger.textContent || "").trim().slice(0, 80),
      dialogText: (dialog.innerText || "").trim().slice(0, 180),
      dialogRoles: [...new Set(Array.from(dialog.querySelectorAll("[role]")).map((e) => e.getAttribute("role")))],
      dialogLinksCount: dialog.querySelectorAll("a[href]").length,
      dialogLinkSample: Array.from(dialog.querySelectorAll("a[href]")).slice(0, 4).map((a) => ({
        text: (a.textContent || "").trim().slice(0, 25),
        href: (a.getAttribute("href") || "").slice(0, 60)
      })),
      tabCount: tabs.length,
      tabLabels,
      switchedTabs,
      gqlAfterModal: gqlBuffer.reactions.length,
      domAfterModal: domReactions.length,
      hasCursorQuery: gqlBuffer.hasCursorQuery,
      pageInfo: gqlBuffer.reactorsPageInfo
    };

    closeModalSafe(dialog);
    await sleepControlled(500, run);
    return domReactions;
  }

  async function scanSharesModal(postRoot, maxScrolls, run, onProgress) {
    const domShares = [];
    const trigger = findShareTrigger(postRoot);
    if (!trigger) return domShares;

    const dialog = await openNewDialogAndWait(trigger, run);
    if (!dialog) return domShares;

    await waitForDialogActors(dialog, run);
    let scroller = findScrollableInDialog(dialog);
    let lastHeight = 0;
    let stagnant = 0;

    for (let i = 0; i < maxScrolls; i++) {
      if (run.aborted) throw new Error("ABORTED");
      if (scroller === dialog) scroller = findScrollableInDialog(dialog);

      onProgress(`Đang quét lượt Share công khai (${i + 1}/${maxScrolls})...`);
      const rect = scroller.getBoundingClientRect();
      const cx = rect.width > 20 ? Math.round(rect.left + rect.width / 2) : 400;
      const cy = rect.height > 20 ? Math.round(rect.top + rect.height / 2) : 350;

      const actorLinks = Array.from(dialog.querySelectorAll("a[href]")).filter(isLikelyAuthorProfileLink);
      const lastActor = actorLinks[actorLinks.length - 1];
      if (lastActor) lastActor.scrollIntoView({ block: "end", behavior: "instant" });

      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      chrome.runtime.sendMessage({ type: "CDP_WHEEL_SCROLL", x: cx, y: cy, deltaY: 900 }, () => {
        void chrome.runtime.lastError;
      });
      await sleepControlled(jitter(900), run);

      if (scroller.scrollHeight === lastHeight) {
        stagnant += 1;
        if (stagnant >= 2) break;
      } else {
        stagnant = 0;
        lastHeight = scroller.scrollHeight;
      }
    }

    for (const actor of scrapeDialogActors(dialog)) {
      domShares.push({ actor, caption: "", postUrl: null, createdTime: null, source: "dom" });
    }

    closeModalSafe(dialog);
    await sleepControlled(500, run);
    return domShares;
  }

  function mergeDedupe(primaryGql, fallbackDom, keyFn) {
    const map = new Map();
    for (const item of primaryGql) {
      const k = keyFn(item);
      if (!map.has(k)) map.set(k, item);
    }
    for (const item of fallbackDom) {
      const k = keyFn(item);
      if (!map.has(k)) map.set(k, item);
    }
    return Array.from(map.values());
  }

  async function runPostScan(options) {
    if (activeRun) activeRun.aborted = true;
    const run = { aborted: false, paused: false };
    activeRun = run;

    resetGqlBuffer();
    await waitForPostReady(run);
    const postRoot = findPrimaryPostRoot();
    const report = (text) => {
      chrome.runtime.sendMessage({ type: "SCAN_PROGRESS", postUrl: location.href, text }, () => {
        void chrome.runtime.lastError;
      });
    };

    report("Đang đọc bình luận bài viết...");
    const preComments = scrapeDomComments(postRoot);
    await trySwitchAllComments(postRoot, run);
    await expandComments(postRoot, options?.maxCommentClicks ?? 15, run, report);
    const postComments = scrapeDomComments(postRoot);
    const domComments = [...preComments, ...postComments];
    report(`Đã đọc ${domComments.length} comment trên DOM (${postRoot.tagName}), đang kiểm tra Reactions...`);

    report("Đang đọc danh sách cảm xúc (Reactions)...");
    const domReactions = await scanReactionsModal(postRoot, options?.maxReactionScrolls ?? 15, run, report);

    report("Đang đọc danh sách chia sẻ công khai (Shares)...");
    const domShares = await scanSharesModal(postRoot, options?.maxShareScrolls ?? 10, run, report);

    if (
      domComments.length === 0 &&
      gqlBuffer.comments.length === 0 &&
      domReactions.length === 0 &&
      gqlBuffer.reactions.length === 0
    ) {
      report("Bài tải chậm, đang thử đọc lại thêm 1 nhịp...");
      await sleepControlled(1800, run);
      const retryRoot = findPrimaryPostRoot();
      domComments.push(...scrapeDomComments(retryRoot));
      const retryReactions = await scanReactionsModal(retryRoot, options?.maxReactionScrolls ?? 15, run, report);
      domReactions.push(...retryReactions);
    }

    const normActorName = (n) => String(n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const seenFbIds = new Set();
    const seenUrls = new Set();
    const byNameIdx = new Map();
    const reactions = [];

    for (const r of [...gqlBuffer.reactions, ...domReactions]) {
      const fid = r.actor?.fbId || null;
      const url = r.actor?.profileUrl || null;
      const nm = normActorName(r.actor?.name);

      if ((fid && seenFbIds.has(fid)) || (url && seenUrls.has(url))) {
        continue;
      }
      if (nm && byNameIdx.has(nm) && r.source === "dom") {
          const existing = reactions[byNameIdx.get(nm)];
          if (existing?.actor && url && !existing.actor.profileUrl) {
            existing.actor.profileUrl = url;
            seenUrls.add(url);
          }
          continue;
        }
      const idx = reactions.length;
      if (fid) seenFbIds.add(fid);
      if (url) seenUrls.add(url);
      if (nm && !byNameIdx.has(nm)) byNameIdx.set(nm, idx);
      reactions.push(r);
    }

    const { mergeCommentLists } = await getParser();
    const comments = mergeCommentLists(gqlBuffer.comments, domComments);

    const shares = mergeDedupe(
      gqlBuffer.shares,
      domShares,
      (s) => `${s.actor.fbId || s.actor.profileUrl || s.actor.name}|${s.caption.slice(0, 30)}`
    );

    const reactionBreakdown = {};
    for (const r of reactions) {
      const type = r.reactionType || "LIKE";
      reactionBreakdown[type] = (reactionBreakdown[type] || 0) + 1;
    }

    const debugMeta = {
      gqlReactions: gqlBuffer.reactions.length,
      domReactions: domReactions.length,
      mergedReactions: reactions.length,
      comments: comments.length,
      reactionModal: scanReactionDiag
    };

    return {
      postKey: normalizeProfileHref(location.href),
      postUrl: location.href,
      postTitle: document.title || location.href,
      reactions,
      comments,
      shares,
      summary: {
        reactionCount: reactions.length,
        commentCount: comments.length,
        shareCount: shares.length,
        reactionBreakdown
      },
      debugMeta,
      scannedAt: Date.now()
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    if (message.type === "SCAN_CURRENT_POST") {
      runPostScan(message.options)
        .then((scan) => sendResponse({ ok: true, scan }))
        .catch((err) => {
          sendResponse({
            ok: false,
            aborted: err?.message === "ABORTED",
            error: err?.message || "Lỗi khi quét bài viết"
          });
        });
      return true;
    }

    if (message.type === "CONTROL_SCAN") {
      if (activeRun) {
        if (message.action === "pause") activeRun.paused = true;
        if (message.action === "resume") activeRun.paused = false;
        if (message.action === "stop") activeRun.aborted = true;
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
})();