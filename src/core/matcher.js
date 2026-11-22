import { foldVietnamese, parseTargetLine } from "./parser.js";

function extractActorIdentity(actor) {
  const fbId = actor?.fbId ? String(actor.fbId).trim() : null;
  let username = actor?.username ? String(actor.username).toLowerCase().trim() : null;

  if (!username && actor?.profileUrl) {
    const parsed = parseTargetLine(actor.profileUrl);
    if (parsed?.username) username = parsed.username;
    if (!fbId && parsed?.fbId) {
      return {
        fbId: parsed.fbId,
        username,
        foldedName: foldVietnamese(actor?.name || "")
      };
    }
  }

  return {
    fbId,
    username,
    foldedName: foldVietnamese(actor?.name || "")
  };
}

export function matchActorToTarget(actor, target) {
  const id = extractActorIdentity(actor);

  if (target.fbId && id.fbId && target.fbId === id.fbId) {
    return { matched: true, confidence: "exact_id", score: 100 };
  }

  if (target.username && id.username && target.username === id.username) {
    return { matched: true, confidence: "exact_username", score: 95 };
  }

  if (target.kind === "name" && target.foldedName && id.foldedName) {
    if (target.foldedName === id.foldedName) {
      return { matched: true, confidence: "exact_name", score: 80 };
    }
    // Khớp một phần có kiểm soát (chỉ khi từ khóa >= 4 ký tự để tránh nhiễu)
    if (target.foldedName.length >= 4 && id.foldedName.includes(target.foldedName)) {
      return { matched: true, confidence: "partial_name", score: 55 };
    }
  }

  return { matched: false, confidence: "none", score: 0 };
}

export function buildTargetDossier(target, postScan) {
  const reactions = [];
  const comments = [];
  const shares = [];

  for (const r of postScan?.reactions || []) {
    const m = matchActorToTarget(r.actor, target);
    if (m.matched) reactions.push({ ...r, match: m });
  }

  for (const c of postScan?.comments || []) {
    const m = matchActorToTarget(c.actor, target);
    if (m.matched) comments.push({ ...c, match: m });
  }

  for (const s of postScan?.shares || []) {
    const m = matchActorToTarget(s.actor, target);
    if (m.matched) shares.push({ ...s, match: m });
  }

  // 1 người chỉ có 1 reaction trên 1 bài: ưu tiên nguồn GraphQL có loại cảm xúc thật, bỏ bản đoán DOM nếu đã có GraphQL
  const gqlReactions = reactions.filter((r) => r.source === "graphql");
  const effectiveReactions = gqlReactions.length > 0 ? gqlReactions : reactions;
  const hasReact = effectiveReactions.length > 0;
  const hasComment = comments.length > 0;
  const hasShare = shares.length > 0;

  let depth = "Chưa thấy tương tác";
  if (hasShare || comments.length >= 2) {
    depth = "Advocate (Lan tỏa / Thảo luận sâu)";
  } else if (hasComment) {
    depth = "Vocal (Có bình luận)";
  } else if (hasReact) {
    depth = "Passive (Chỉ thả cảm xúc)";
  }

  const bestConfidence = [
    ...reactions.map((x) => x.match),
    ...comments.map((x) => x.match),
    ...shares.map((x) => x.match)
  ].sort((a, b) => b.score - a.score)[0] || null;

  return {
    targetKey: target.key,
    targetLabel: target.displayName,
    postUrl: postScan?.postUrl || "",
    hasReact,
    reactionTypes: [...new Set(effectiveReactions.map((r) => r.reactionType || "LIKE"))],
    hasComment,
    commentCount: comments.length,
    comments,
    hasShare,
    shareCount: shares.length,
    shares,
    depth,
    confidence: bestConfidence?.confidence || "none",
    scannedAt: postScan?.scannedAt || Date.now()
  };
}