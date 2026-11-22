export function stripForLoopPrefix(rawText) {
  return String(rawText || "").replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;?\s*/, "");
}

export function parseGraphqlChunks(rawText) {
  const cleaned = stripForLoopPrefix(rawText);
  if (!cleaned.trim()) return [];

  const objects = [];
  const lines = cleaned.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
    try {
      objects.push(JSON.parse(trimmed));
    } catch {
      // Bỏ qua chunk chưa hoàn chỉnh hoặc không phải JSON
    }
  }
  return objects;
}

function normalizeReactionType(raw) {
  if (!raw) return "LIKE";
  const upper = String(raw).toUpperCase();
  if (upper.includes("LOVE")) return "LOVE";
  if (upper.includes("CARE") || upper.includes("SUPPORT")) return "CARE";
  if (upper.includes("HAHA")) return "HAHA";
  if (upper.includes("WOW")) return "WOW";
  if (upper.includes("SAD") || upper.includes("SORRY")) return "SAD";
  if (upper.includes("ANGRY") || upper.includes("ANGER")) return "ANGRY";
  return "LIKE";
}

function extractActorFromNode(node) {
  if (!node || typeof node !== "object") return null;
  const name = node.name || node.short_name || null;
  const id = node.id ? String(node.id) : null;
  const url = node.url || node.profile_url || (id ? `https://www.facebook.com/profile.php?id=${id}` : null);
  if (!name && !id && !url) return null;
  return {
    fbId: id && /^\d{5,22}$/.test(id) ? id : null,
    name: name || "",
    profileUrl: url || ""
  };
}

export function extractInteractionsFromPayload(rootObj) {
  const reactions = [];
  const comments = [];
  const shares = [];
  const visited = new WeakSet();

  function walk(node, context = {}) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, context);
      return;
    }

    // 1. Reaction edge (reactors.edges[])
    if (
      node.node &&
      (node.feedback_reaction_info || node.reaction_type || node.node?.__typename === "User") &&
      (context.inReactors || node.feedback_reaction_info || node.reaction_type)
    ) {
      const actor = extractActorFromNode(node.node);
      if (actor && (actor.fbId || actor.name)) {
        const rawReaction =
          node.feedback_reaction_info?.reaction_type ||
          node.feedback_reaction_info?.localized_name ||
          node.reaction_type ||
          "LIKE";
        reactions.push({
          actor,
          reactionType: normalizeReactionType(rawReaction),
          source: "graphql"
        });
      }
    }

    // 2. Comment node (Comment / CommentEdge — hỗ trợ cả text, emoji, sticker, GIF, ảnh)
    const isCommentObj =
      node.__typename === "Comment" ||
      (node.author && (
        node.body?.text !== undefined ||
        node.preferred_body?.text !== undefined ||
        Array.isArray(node.attachments) ||
        Boolean(node.sticker)
      ));

    if (isCommentObj) {
      const actor = extractActorFromNode(node.author);
      let text = String(node.body?.text ?? node.preferred_body?.text ?? "").trim();
      if (!text) {
        const rawJson = JSON.stringify(node.attachments || node.sticker || "");
        if (node.sticker || /Sticker/i.test(rawJson)) text = "[Sticker]";
        else if (/AnimatedImage|GIF/i.test(rawJson)) text = "[GIF]";
        else if (Array.isArray(node.attachments) && node.attachments.length > 0) text = "[Ảnh / Media]";
      }
      if (actor && (actor.fbId || actor.name)) {
        comments.push({
          id: node.id ? String(node.id) : null,
          actor,
          text,
          createdTime: typeof node.created_time === "number" ? node.created_time * 1000 : null,
          reactionCount: node.feedback?.reactors?.count ?? 0,
          replyTo: context.parentAuthorName || null,
          commentUrl: node.url || null,
          source: "graphql"
        });
      }
    }

    // 3. Share / Reshare node
    if (
      context.inReshares &&
      Array.isArray(node.actors) &&
      node.actors.length > 0 &&
      (node.__typename === "Story" || node.attached_story || node.message)
    ) {
      for (const rawActor of node.actors) {
        const actor = extractActorFromNode(rawActor);
        if (actor && (actor.fbId || actor.name)) {
          shares.push({
            actor,
            caption: node.message?.text ? String(node.message.text) : "",
            postUrl: node.url || null,
            createdTime: typeof node.creation_time === "number" ? node.creation_time * 1000 : null,
            source: "graphql"
          });
        }
      }
    }

    // Truyền ngữ cảnh xuống nhánh con
    for (const [key, val] of Object.entries(node)) {
      if (!val || typeof val !== "object") continue;
      const nextContext = { ...context };
      if (key === "reactors" || key === "top_reactors") nextContext.inReactors = true;
      if (key === "reshares" || key === "shared_by") nextContext.inReshares = true;
      if (isCommentObj && node.author?.name && (key === "replies" || key === "feedback")) {
        nextContext.parentAuthorName = node.author.name;
      }
      walk(val, nextContext);
    }
  }

  walk(rootObj, {});
  return { reactions, comments, shares };
}

export function extractReactorsPageInfo(rootObj) {
  let found = null;
  const visited = new WeakSet();

  function walk(node) {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const pi = node.reactors?.page_info;
    if (pi && typeof pi === "object" && ("has_next_page" in pi || "end_cursor" in pi)) {
      const candidate = {
        hasNextPage: Boolean(pi.has_next_page),
        endCursor: pi.end_cursor ? String(pi.end_cursor) : null
      };
      if (!found || (candidate.hasNextPage && candidate.endCursor)) {
        found = candidate;
      }
    }

    for (const val of Object.values(node)) {
      if (val && typeof val === "object") walk(val);
    }
  }

  walk(rootObj);
  return found;
}

function normCompare(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getUrlCommentId(commentUrl) {
  if (!commentUrl) return null;
  try {
    const u = new URL(commentUrl);
    return u.searchParams.get("reply_comment_id") || u.searchParams.get("comment_id") || null;
  } catch {
    return null;
  }
}

function enrichComment(target, incoming) {
  if (incoming.text && incoming.text.length > (target.text || "").length) {
    target.text = incoming.text;
  }
  if (!target.commentUrl && incoming.commentUrl) target.commentUrl = incoming.commentUrl;
  if (!target.replyTo && incoming.replyTo) target.replyTo = incoming.replyTo;
  if (!target.createdTime && incoming.createdTime) target.createdTime = incoming.createdTime;
  if (!target.reactionCount && incoming.reactionCount) target.reactionCount = incoming.reactionCount;
  if (target.actor && incoming.actor) {
    if (!target.actor.fbId && incoming.actor.fbId) target.actor.fbId = incoming.actor.fbId;
    if (!target.actor.profileUrl && incoming.actor.profileUrl) target.actor.profileUrl = incoming.actor.profileUrl;
    if (!target.actor.name && incoming.actor.name) target.actor.name = incoming.actor.name;
  }
}

export function mergeCommentLists(primaryList = [], secondaryList = []) {
  const merged = [];
  const byId = new Map();
  const byUrlCmtId = new Map();
  const byActorText = new Map();

  function addOrEnrich(item, allowTextMatch) {
    const cId = item?.id ? String(item.id) : null;
    const urlCmtId = getUrlCommentId(item?.commentUrl);
    const sig = `${normCompare(item?.actor?.name)}|${normCompare(item?.text)}`;

    if (cId && byId.has(cId)) {
      enrichComment(merged[byId.get(cId)], item);
      return;
    }
    if (urlCmtId && byUrlCmtId.has(urlCmtId)) {
      enrichComment(merged[byUrlCmtId.get(urlCmtId)], item);
      return;
    }

    if (allowTextMatch && !cId && item?.actor?.name) {
      const candidates = byActorText.get(sig) || [];
      const matchIdx = candidates.find((idx) => {
        const existingUrlId = getUrlCommentId(merged[idx].commentUrl);
        return !urlCmtId || !existingUrlId || existingUrlId === urlCmtId;
      });
      if (matchIdx !== undefined) {
        enrichComment(merged[matchIdx], item);
        if (urlCmtId && !byUrlCmtId.has(urlCmtId)) byUrlCmtId.set(urlCmtId, matchIdx);
        return;
      }

      const actorNorm = normCompare(item.actor.name);
      const textNorm = normCompare(item.text);
      if (textNorm.length >= 4) {
        const fuzzyIdx = merged.findIndex((m) => {
          if (normCompare(m?.actor?.name) !== actorNorm) return false;
          const mNorm = normCompare(m?.text);
          return mNorm.length >= 4 && (textNorm.includes(mNorm) || mNorm.includes(textNorm));
        });
        if (fuzzyIdx !== -1) {
          enrichComment(merged[fuzzyIdx], item);
          return;
        }
      }
    }

    const idx = merged.length;
    const copy = { ...item, actor: item.actor ? { ...item.actor } : item.actor };
    merged.push(copy);
    if (cId) byId.set(cId, idx);
    if (urlCmtId) byUrlCmtId.set(urlCmtId, idx);
    if (item?.actor?.name) {
      const list = byActorText.get(sig) || [];
      list.push(idx);
      byActorText.set(sig, list);
    }
  }

  for (const item of primaryList) addOrEnrich(item, false);
  for (const item of secondaryList) addOrEnrich(item, true);
  return merged;
}