import { extractInteractionsFromPayload } from "./graphql_parser.js";

export function extractTokensFromHtml(html) {
  const text = String(html || "");
  const fbDtsg =
    text.match(/"DTSGInitialData"[^}]*?"token":"([^"]+)"/)?.[1] ||
    text.match(/"dtsg":\{"token":"([^"]+)"/)?.[1] ||
    text.match(/name="fb_dtsg"\s+value="([^"]+)"/)?.[1] ||
    null;

  const lsd =
    text.match(/"LSD"[^}]*?"token":"([^"]+)"/)?.[1] ||
    text.match(/name="lsd"\s+value="([^"]+)"/)?.[1] ||
    null;

  const feedbackId =
    text.match(/"feedback":\{"id":"(ZmVlZGJhY2s[^"]+)"/)?.[1] ||
    text.match(/"feedback_id":"([^"]+)"/)?.[1] ||
    text.match(/"feedbackID":"([^"]+)"/)?.[1] ||
    text.match(/"feedback":\{"id":"([^"]+)"/)?.[1] ||
    null;

  const title =
    text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "";

  return { fbDtsg, lsd, feedbackId, title };
}

export function extractInteractionsFromSsrHtml(html) {
  const tokens = extractTokensFromHtml(html);
  const reactions = [];
  const comments = [];
  const shares = [];

  const scriptRegex = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(String(html || ""))) !== null) {
    const rawJson = match[1]?.trim();
    if (!rawJson || (rawJson[0] !== "{" && rawJson[0] !== "[")) continue;
    try {
      const parsed = JSON.parse(rawJson);
      const out = extractInteractionsFromPayload(parsed);
      reactions.push(...out.reactions);
      comments.push(...out.comments);
      shares.push(...out.shares);
    } catch {
      // Bỏ qua script JSON không hợp lệ
    }
  }

  return {
    ...tokens,
    reactions,
    comments,
    shares
  };
}

export function extractPostUrlsFromPageHtml(html, limit = 5, pageUrl = "") {
  const text = String(html || "").replace(/\\\//g, "/");
  const urls = [];
  const seen = new Set();

  function addUrl(rawUrl) {
    try {
      const cleanedRaw = rawUrl.replace(/\\u0025/g, "%").replace(/\\u0026/g, "&");
      const u = new URL(cleanedRaw);
      if (u.searchParams.has("comment_id") || u.searchParams.has("reply_comment_id")) return;
      ["fbclid", "mibextid", "__cft__[0]", "__tn__"].forEach((k) => u.searchParams.delete(k));
      const normalized = `${u.origin}${u.pathname}${u.search}`.replace(/\/+$/, "");
      if (!seen.has(normalized)) {
        seen.add(normalized);
        urls.push(normalized);
      }
    } catch {
      // Bỏ qua URL lỗi
    }
  }

  // 1. Link bài viết đầy đủ nhúng trong JSON SSR
  const fullRegex = /https:\/\/(?:www|m)\.facebook\.com\/[^\s"'<>\\]+?(?:\/posts\/[^\s"'<>\\]+|\/permalink\.php\?[^\s"'<>\\]+|\/videos\/[^\s"'<>\\]+|\/reel\/[^\s"'<>\\]+)/gi;
  let match;
  while ((match = fullRegex.exec(text)) !== null && urls.length < limit) {
    addUrl(match[0]);
  }

  // 2. Fallback từ set=pcb.<id> hoặc "post_id":"..." nếu biết slug/ID Page nguồn
  if (urls.length < limit && pageUrl) {
    let pageSlug = null;
    try {
      const pu = new URL(pageUrl);
      pageSlug = pu.pathname.split("/").filter(Boolean)[0] || null;
    } catch {
      pageSlug = null;
    }

    if (pageSlug && pageSlug !== "profile.php") {
      const idRegex = /(?:"post_id":"(\d{12,22})"|set=(?:pcb|gm)\.(\d{12,22}))/g;
      while ((match = idRegex.exec(text)) !== null && urls.length < limit) {
        const pid = match[1] || match[2];
        if (pid) addUrl(`https://www.facebook.com/${pageSlug}/posts/${pid}`);
      }
    }
  }

  return urls.slice(0, limit);
}

export function extractProfileIdentityFromHtml(html, expectedUsername = null) {
  const text = String(html || "");
  const viewerId =
    text.match(/"CurrentUserInitialData"[\s\S]{0,400}?"USER_ID":"(\d{6,22})"/)?.[1] ||
    text.match(/"USER_ID":"(\d{6,22})"/)?.[1] ||
    null;

  const vanityMatch = text.match(/"userID":"(\d{6,22})","userVanity":"([^"]*)"/);
  const matchedVanityId =
    vanityMatch &&
    expectedUsername &&
    vanityMatch[2] &&
    vanityMatch[2].toLowerCase() === String(expectedUsername).toLowerCase()
      ? vanityMatch[1]
      : null;

  const explicitDeeplinkId = text.match(/fb:\/\/(?:profile|page)\/(?:\?id=)?(\d{6,22})/)?.[1] || null;
  const userIdsInHtml = [...text.matchAll(/"userID":"(\d{6,22})"/g)].map((m) => m[1]);
  const scopedIds = [
    text.match(/"profile_id":"(\d{6,22})"/)?.[1],
    text.match(/"profile_owner":\{"id":"(\d{6,22})"/)?.[1],
    text.match(/"delegate_page":\{"id":"(\d{6,22})"/)?.[1],
    ...userIdsInHtml
  ].filter(Boolean);

  const escUser = expectedUsername
    ? String(expectedUsername).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : null;
  const selfVanityMatched = Boolean(
    escUser && new RegExp(`"(?:userVanity|vanity)":"${escUser}"`, "i").test(text)
  );

  const fbId =
    explicitDeeplinkId ||
    matchedVanityId ||
    scopedIds.find((id) => id !== viewerId) ||
    (selfVanityMatched ? viewerId : null);

  const rawTitle = text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "";
  const name = rawTitle.replace(/\s*\|\s*Facebook\s*$/i, "").trim() || null;

  return { fbId, name };
}

export function classifyDocIdRequest(bodyStr) {
  if (typeof bodyStr !== "string" || !bodyStr.includes("doc_id=")) return null;
  const params = new URLSearchParams(bodyStr);
  const docId = params.get("doc_id");
  const friendlyName = params.get("fb_api_req_friendly_name") || "";
  const rawVars = params.get("variables");

  if (!docId || !/^\d+$/.test(docId)) return null;

  let slot = null;
  if (/ReactionsList|Reactors|CometUFIReactionsDialog/i.test(friendlyName)) {
    slot = "reactions";
  } else if (/CommentsList|CometUFIComment|Depth\d+Comments|FocusedStoryViewUFI|CommentListComponents/i.test(friendlyName)) {
    slot = "comments";
  } else if (/ResharesDialog|ResharesList|CometReshares|SharesDialog/i.test(friendlyName)) {
    slot = "shares";
  }

  if (!slot) return null;

  let variablesTemplate = null;
  let feedbackKey = null;
  if (rawVars) {
    try {
      const parsedVars = JSON.parse(rawVars);
      for (const [k, v] of Object.entries(parsedVars)) {
        if (
          typeof v === "string" &&
          (/feedback/i.test(k) || k === "id" || k === "nodeID" || v.startsWith("ZmVlZGJhY2s")) &&
          v.length >= 6
        ) {
          feedbackKey = k;
          break;
        }
      }
      if (feedbackKey) {
        delete parsedVars.cursor;
        delete parsedVars.after;
        variablesTemplate = parsedVars;
      }
    } catch {
      // Bỏ qua variables không parse được
    }
  }

  if (!feedbackKey || !variablesTemplate) return null;

  return {
    slot,
    docId,
    friendlyName,
    feedbackKey,
    variablesTemplate,
    learnedAt: Date.now()
  };
}