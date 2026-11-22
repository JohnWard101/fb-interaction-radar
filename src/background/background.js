import {
  parseGraphqlChunks,
  extractInteractionsFromPayload,
  mergeCommentLists
} from "../core/graphql_parser.js";
import {
  extractInteractionsFromSsrHtml,
  classifyDocIdRequest,
  extractProfileIdentityFromHtml,
  extractPostUrlsFromPageHtml
} from "../core/ssr_parser.js";

const DNR_RULE_ID = 9901;
const attachedDebuggerTabs = new Set();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Page.screencastFrame" && source.tabId && params?.sessionId) {
    chrome.debugger.sendCommand(
      { tabId: source.tabId },
      "Page.screencastFrameAck",
      { sessionId: params.sessionId },
      () => { void chrome.runtime.lastError; }
    );
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId) attachedDebuggerTabs.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedDebuggerTabs.delete(tabId);
});

async function attachKeepAwakeDebugger(tabId) {
  if (attachedDebuggerTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedDebuggerTabs.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" });
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
    await chrome.debugger.sendCommand({
      tabId },
      "Page.startScreencast",
      { format: "jpeg", quality: 5, maxWidth: 320, maxHeight: 240, everyNthFrame: 60 }
    ).catch(() => {});
  } catch {
    attachedDebuggerTabs.delete(tabId);
  }
}

async function detachKeepAwakeDebugger(tabId) {
  if (!attachedDebuggerTabs.has(tabId)) return;
  attachedDebuggerTabs.delete(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Page.stopScreencast").catch(() => {});
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.error("Failed to set sidePanel behavior:", err);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "GET_ACTIVE_FB_TAB") {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab) {
        sendResponse({ ok: false, error: "Không tìm thấy tab đang mở." });
        return;
      }
      const isFacebook = typeof tab.url === "string" && /^https:\/\/([^/]+\.)?facebook\.com\//i.test(tab.url);
      sendResponse({
        ok: true,
        tab: {
          id: tab.id,
          url: tab.url || "",
          title: tab.title || "",
          isFacebook
        }
      });
    });
    return true; // giữ kênh message mở cho async sendResponse
  }

  if (message.type === "PREPARE_AND_SCAN_URL") {
    handlePrepareAndScan(message.payload)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || "Lỗi điều phối tab" }));
    return true;
  }

  if (message.type === "DISCOVER_PAGE_POSTS") {
    handleDiscoverPagePosts(message.payload)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || "Lỗi tìm bài trên Page" }));
    return true;
  }

  if (message.type === "HEADLESS_SCAN_URL") {
    handleHeadlessScan(message.payload)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || "Lỗi quét ngầm không mở tab" }));
    return true;
  }

  if (message.type === "CDP_WHEEL_SCROLL") {
    const tabId = _sender?.tab?.id;
    if (typeof tabId === "number" && attachedDebuggerTabs.has(tabId)) {
      chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Number(message.x) || 400,
        y: Number(message.y) || 350,
        deltaX: 0,
        deltaY: Number(message.deltaY) || 1200
      }, () => {
        void chrome.runtime.lastError;
        sendResponse({ ok: true });
      });
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }

  if (message.type === "CLOSE_SCANNER_TAB") {
    const finish = async () => {
      if (typeof message.tabId === "number") {
        await detachKeepAwakeDebugger(message.tabId);
        await new Promise((r) => chrome.tabs.remove(message.tabId, () => { void chrome.runtime.lastError; r(); }));
      }
    };
    finish().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "LEARN_DOC_ID_BODY") {
    saveLearnedDocId(message.body)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "RESOLVE_TARGET_IDENTITIES") {
    resolveTargetIdentities(message.targets || [])
      .then((res) => sendResponse({ ok: true, targets: res.targets, debugSample: res.debugSample }))
      .catch(() => sendResponse({ ok: true, targets: message.targets || [] }));
    return true;
  }

  if (message.type === "GET_LEARNED_DOC_STATUS") {
    chrome.storage.local.get(["learnedDocIds"], (res) => {
      const map = res?.learnedDocIds || {};
      sendResponse({
        ok: true,
        slots: Object.keys(map),
        count: Object.keys(map).length
      });
    });
    return true;
  }

  if (message.type === "CONTROL_TAB_SCAN") {
    if (typeof message.tabId === "number") {
      chrome.tabs.sendMessage(message.tabId, {
        type: "CONTROL_SCAN",
        action: message.action
      }, () => {
        void chrome.runtime.lastError;
        sendResponse({ ok: true });
      });
      return true;
    }
  }

  return false;
});

async function resolveTargetIdentities(targets) {
  const stored = await chrome.storage.local.get(["resolvedProfilesV3"]);
  const cache = stored?.resolvedProfilesV3 || {};
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  let dirty = false;
  let debugSample = null;
  const enriched = [];

  for (const t of targets) {
    if (t.kind !== "username" || t.fbId || !t.canonicalUrl) {
      enriched.push(t);
      continue;
    }
    const cached = cache[t.username];
    if (cached && cached.fbId && Date.now() - cached.cachedAt < maxAgeMs) {
      enriched.push({ ...t, fbId: cached.fbId });
      continue;
    }
    try {
      const res = await fetch(t.canonicalUrl, { method: "GET", credentials: "include" });
      const html = res.ok ? await res.text() : "";
      const { fbId } = res.ok ? extractProfileIdentityFromHtml(html, t.username) : { fbId: null };
      if (!debugSample) {
        debugSample = {
          username: t.username,
          status: res.status,
          finalUrl: res.url,
          htmlLen: html.length,
          extractedFbId: fbId,
          profileIdHit: html.match(/"profile_id":"(\d{6,22})"/)?.[1] || null,
          viewerHit: html.match(/"USER_ID":"(\d{6,22})"/)?.[1] || null
        };
      }
      if (fbId) {
        cache[t.username] = { fbId, cachedAt: Date.now() };
        dirty = true;
        enriched.push({ ...t, fbId });
        continue;
      }
    } catch (err) {
      if (!debugSample) {
        debugSample = { username: t.username, error: err?.message || "fetch error" };
      }
    }
    enriched.push(t);
  }

  // Chống trùng fbId giữa các username khác nhau nếu HTML trả về cùng ID mặc định
  const fbIdOwners = new Map();
  for (const t of enriched) {
    if (t.kind === "username" && t.fbId) {
      const set = fbIdOwners.get(t.fbId) || new Set();
      set.add(t.username);
      fbIdOwners.set(t.fbId, set);
    }
  }
  const safeEnriched = enriched.map((t) => {
    if (t.kind === "username" && t.fbId && fbIdOwners.get(t.fbId)?.size > 1) {
      if (cache[t.username]) {
        delete cache[t.username];
        dirty = true;
      }
      const { fbId: _dropped, ...rest } = t;
      return rest;
    }
    return t;
  });

  if (dirty) {
    await chrome.storage.local.set({ resolvedProfilesV3: cache });
  }
  return { targets: safeEnriched, debugSample };
}

let docIdWriteQueue = Promise.resolve();

function saveLearnedDocId(bodyStr) {
  const info = classifyDocIdRequest(bodyStr);
  if (!info) return Promise.resolve();
  docIdWriteQueue = docIdWriteQueue.then(async () => {
    const stored = await chrome.storage.local.get(["learnedDocIds"]);
    const current = stored?.learnedDocIds || {};
    current[info.slot] = info;
    await chrome.storage.local.set({ learnedDocIds: current });
  }).catch(() => {});
  return docIdWriteQueue;
}

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => finish(new Error("Quá thời gian tải trang Facebook.")), timeoutMs);

    function onUpdated(updatedId, info) {
      if (updatedId === tabId && info.status === "complete") {
        finish();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab?.status === "complete") {
        finish();
      }
    });
  });
}

function navigateTabAndWait(tabId, targetUrl, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Quá thời gian tải trang Facebook.")), timeoutMs);
    function onUpdated(updatedId, info) {
      if (updatedId !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url: targetUrl }).catch((err) => finish(err));
  });
}

function normalizeUrlCompare(raw) {
  try {
    const u = new URL(raw);
    ["fbclid", "mibextid", "__cft__[0]", "__tn__"].forEach((k) => u.searchParams.delete(k));
    return `${u.origin}${u.pathname}${u.search}`.replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

// OPTION 1: Dùng cửa sổ popup riêng (active trong cửa sổ của nó) để tránh Chrome throttle IntersectionObserver
async function handlePrepareAndScan({ targetUrl, preferredTabId, options }) {
  const { tabId, created } = await ensureScannerTab(preferredTabId, targetUrl);

  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["src/content/main_tapper.js"]
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: ["src/content/content.js"]
  });

  const scanRes = await chrome.tabs.sendMessage(tabId, {
    type: "SCAN_CURRENT_POST",
    options
  });

  return { ...scanRes, tabId, createdBackgroundTab: created };
}

function dedupeBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, item);
  }
  return Array.from(map.values());
}

async function queryGraphqlWithLearnedDoc({ finalUrl, fbDtsg, lsd, feedbackId, docTemplate }) {
  const vars = structuredClone(docTemplate.variablesTemplate);
  vars[docTemplate.feedbackKey] = feedbackId;

  const form = new URLSearchParams();
  form.set("fb_dtsg", fbDtsg);
  if (lsd) form.set("lsd", lsd);
  form.set("fb_api_caller_class", "RelayModern");
  form.set("fb_api_req_friendly_name", docTemplate.friendlyName);
  form.set("variables", JSON.stringify(vars));
  form.set("doc_id", docTemplate.docId);

  const res = await fetch("https://www.facebook.com/api/graphql/", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-FB-Friendly-Name": docTemplate.friendlyName
    },
    body: form.toString()
  });

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}`);
  }

  const rawText = await res.text();
  const objs = parseGraphqlChunks(rawText);
  const out = { reactions: [], comments: [], shares: [] };
  for (const obj of objs) {
    const extracted = extractInteractionsFromPayload(obj);
    out.reactions.push(...extracted.reactions);
    out.comments.push(...extracted.comments);
    out.shares.push(...extracted.shares);
  }
  return out;
}

// OPTION 2: Quét ngầm KHÔNG mở tab (Fetch SSR HTML + GraphQL theo doc_id đã tự học)
async function handleHeadlessScan({ targetUrl }) {
  const pageRes = await fetch(targetUrl, {
    method: "GET",
    credentials: "include",
    redirect: "follow"
  });

  if (!pageRes.ok) {
    return { ok: false, error: `Không tải được HTML bài viết (HTTP ${pageRes.status}).` };
  }

  const finalUrl = pageRes.url || targetUrl;
  const html = await pageRes.text();
  const ssr = extractInteractionsFromSsrHtml(html);

  const allReactions = [...ssr.reactions];
  const allComments = [...ssr.comments];
  const allShares = [...ssr.shares];

  const stored = await chrome.storage.local.get(["learnedDocIds"]);
  const docMap = stored?.learnedDocIds || {};
  const learnedSlots = Object.keys(docMap);
  let graphqlUsed = 0;

  if (ssr.fbDtsg && ssr.feedbackId && learnedSlots.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [DNR_RULE_ID],
      addRules: [
        {
          id: DNR_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "set", value: "https://www.facebook.com" },
              { header: "Referer", operation: "set", value: finalUrl }
            ]
          },
          condition: {
            urlFilter: "https://www.facebook.com/api/graphql*",
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ["xmlhttprequest"]
          }
        }
      ]
    });

    try {
      const results = await Promise.allSettled(
        learnedSlots.map((slot) =>
          queryGraphqlWithLearnedDoc({
            finalUrl,
            fbDtsg: ssr.fbDtsg,
            lsd: ssr.lsd,
            feedbackId: ssr.feedbackId,
            docTemplate: docMap[slot]
          })
        )
      );
      for (const res of results) {
        if (res.status !== "fulfilled") continue;
        allReactions.push(...res.value.reactions);
        allComments.push(...res.value.comments);
        allShares.push(...res.value.shares);
        graphqlUsed += 1;
      }
    } finally {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [DNR_RULE_ID]
      });
    }
  }

  const reactions = dedupeBy(allReactions, (r) => `${r.actor.fbId || r.actor.profileUrl || r.actor.name}`);
  const comments = mergeCommentLists(allComments, []);
  const shares = dedupeBy(allShares, (s) => `${s.actor.fbId || s.actor.profileUrl || s.actor.name}|${s.caption.slice(0, 30)}`);

  const reactionBreakdown = {};
  for (const r of reactions) {
    const type = r.reactionType || "LIKE";
    reactionBreakdown[type] = (reactionBreakdown[type] || 0) + 1;
  }

  return {
    ok: true,
    headlessMeta: {
      hasTokens: Boolean(ssr.fbDtsg && ssr.feedbackId),
      learnedSlotsCount: learnedSlots.length,
      graphqlUsed
    },
    scan: {
      postKey: targetUrl.replace(/\/+$/, ""),
      postUrl: finalUrl,
      postTitle: ssr.title || finalUrl,
      reactions,
      comments,
      shares,
      summary: {
        reactionCount: reactions.length,
        commentCount: comments.length,
        shareCount: shares.length,
        reactionBreakdown
      },
      scannedAt: Date.now()
    }
  };
}

async function ensureScannerTab(preferredTabId, targetUrl) {
  let tabId = preferredTabId || null;
  let created = false;

  if (tabId) {
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (!existing) tabId = null;
  }

  if (!tabId) {
    let tab = null;
    try {
      const win = await chrome.windows.create({
        url: targetUrl,
        type: "popup",
        focused: false,
        width: 900,
        height: 700
      });
      tab = win?.tabs?.[0] || null;
    } catch {
      tab = null;
    }
    if (!tab) {
      tab = await chrome.tabs.create({ url: targetUrl, active: false });
    }
    tabId = tab.id;
    created = true;
    await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    await attachKeepAwakeDebugger(tabId);
    await waitForTabComplete(tabId);
    await new Promise((r) => setTimeout(r, 1800));
  } else {
    await attachKeepAwakeDebugger(tabId);
    const current = await chrome.tabs.get(tabId);
    if (normalizeUrlCompare(current.url || "") !== normalizeUrlCompare(targetUrl)) {
      await navigateTabAndWait(tabId, targetUrl);
      await new Promise((r) => setTimeout(r, 1800));
    }
  }

  return { tabId, created };
}

async function ensureBackgroundTab(preferredTabId, targetUrl) {
  const { tabId } = await ensureScannerTab(preferredTabId, targetUrl);
  return tabId;
}

async function handleDiscoverPagePosts({ source, limit = 5, execMode = "bg_tab", preferredTabId = null, allowFallback = true }) {
  // Nếu là tên Page (không phải URL) -> dùng Tab nền tìm trên Facebook Search nếu có thể
  if (source.isNameQuery) {
    if (execMode === "headless_fetch" && !allowFallback) {
      return { ok: false, error: "Tìm Page theo tên cần dùng Tab nền ẩn (hoặc bật tự chuyển sang Tab nền)." };
    }
    const searchUrl = `https://www.facebook.com/search/pages/?q=${encodeURIComponent(source.displayName)}`;
    const tabId = await ensureBackgroundTab(preferredTabId, searchUrl);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["src/content/page_collector.js"]
    });
    const picked = await chrome.tabs.sendMessage(tabId, { type: "PICK_FIRST_SEARCH_PAGE" });
    if (!picked?.ok || !picked.pageUrl) {
      return { ok: false, tabId, error: `Không tìm thấy Page nào khớp "${source.displayName}".` };
    }
    preferredTabId = tabId;
    source = { ...source, canonicalUrl: picked.pageUrl };
  }

  if (execMode === "headless_fetch") {
    try {
      const res = await fetch(source.canonicalUrl, { method: "GET", credentials: "include", redirect: "follow" });
      if (res.ok) {
        const html = await res.text();
        const urls = extractPostUrlsFromPageHtml(html, limit, res.url || source.canonicalUrl);
        if (urls.length > 0 || !allowFallback) {
          return { ok: true, urls, pageUrl: res.url || source.canonicalUrl, tabId: preferredTabId };
        }
      }
    } catch {
      if (!allowFallback) {
        return { ok: false, error: `Không tải được Page "${source.displayName}".` };
      }
    }
  }

  const tabId = await ensureBackgroundTab(preferredTabId, source.canonicalUrl);
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: ["src/content/page_collector.js"]
  });
  const collected = await chrome.tabs.sendMessage(tabId, {
    type: "COLLECT_PAGE_POSTS",
    limit
  });
  return {
    ok: Boolean(collected?.ok),
    urls: collected?.urls || [],
    pageUrl: source.canonicalUrl,
    tabId,
    error: collected?.error
  };
}