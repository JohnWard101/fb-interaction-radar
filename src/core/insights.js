import { buildTargetDossier } from "./matcher.js";

const REACTION_ORDER = ["LOVE", "LIKE", "CARE", "HAHA", "WOW", "SAD", "ANGRY"];

export function computePostPulse(scan) {
  const breakdown = scan?.summary?.reactionBreakdown || {};
  const entries = [];
  let total = 0;

  for (const type of REACTION_ORDER) {
    const count = Number(breakdown[type] || 0);
    if (count > 0) {
      total += count;
      entries.push({ type, count });
    }
  }

  for (const [type, rawCount] of Object.entries(breakdown)) {
    if (REACTION_ORDER.includes(type)) continue;
    const count = Number(rawCount || 0);
    if (count > 0) {
      total += count;
      entries.push({ type, count });
    }
  }

  const withPct = entries
    .sort((a, b) => b.count - a.count)
    .map((e) => ({
      ...e,
      pct: total > 0 ? Math.round((e.count / total) * 100) : 0
    }));

  let mood = "Chưa có dữ liệu cảm xúc";
  if (total > 0) {
    const positive = (breakdown.LOVE || 0) + (breakdown.LIKE || 0) + (breakdown.CARE || 0);
    const amused = breakdown.HAHA || 0;
    const negative = (breakdown.ANGRY || 0) + (breakdown.SAD || 0);
    if (negative / total >= 0.35) mood = "Tranh luận / Phản ứng trái chiều";
    else if (amused / total >= 0.35) mood = "Thiên về giải trí / Hài hước";
    else if (positive / total >= 0.65) mood = `Tích cực (${Math.round((positive / total) * 100)}%)`;
    else mood = "Cảm xúc đa chiều";
  }

  return { total, entries: withPct, mood };
}

export function computeCommentRank(comment, scan) {
  const all = Array.isArray(scan?.comments) ? scan.comments : [];
  if (all.length === 0 || !comment) return null;

  const hasTimestamps = all.filter((c) => typeof c.createdTime === "number").length >= 2;
  let rank = -1;

  if (hasTimestamps && typeof comment.createdTime === "number") {
    const sorted = [...all].sort((a, b) => (a.createdTime ?? Infinity) - (b.createdTime ?? Infinity));
    rank = sorted.findIndex((c) => c === comment || (c.id && comment.id && c.id === comment.id)) + 1;
  } else {
    rank = all.findIndex((c) => c === comment || (c.id && comment.id && c.id === comment.id)) + 1;
  }

  if (rank <= 0) return null;
  const isEarly = all.length >= 5 && rank <= Math.max(1, Math.ceil(all.length * 0.2));
  return { rank, total: all.length, isEarly };
}

export function buildExportRows(targets, scans) {
  const rows = [];
  for (const target of targets) {
    for (let i = 0; i < scans.length; i++) {
      const scan = scans[i];
      const dossier = buildTargetDossier(target, scan);
      rows.push({
        targetName: target.displayName,
        targetInput: target.canonicalUrl || target.raw,
        postIndex: i + 1,
        pageLabel: scan.pageLabel || "",
        postUrl: scan.postUrl,
        reacted: dossier.hasReact ? "Co" : "Khong",
        reactionTypes: dossier.reactionTypes.join("|"),
        commentCount: dossier.commentCount,
        commentsText: dossier.comments.map((c) => c.text || "[Media]").join(" || "),
        publicShareCount: dossier.shareCount,
        engagementDepth: dossier.depth,
        matchConfidence: dossier.confidence,
        scannedAt: new Date(scan.scannedAt || Date.now()).toISOString()
      });
    }
  }
  return rows;
}

function escapeCsvCell(val) {
  let str = String(val ?? "");
  // Chống CSV Formula Injection khi mở bằng Excel
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function rowsToCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsvCell(row[h])).join(","));
  }
  // BOM UTF-8 để Excel hiển thị chuẩn tiếng Việt
  return `\uFEFF${lines.join("\r\n")}`;
}

export function buildPostOverviewLine(targets, scans, precomputedRows = null) {
  if (!targets?.length || !scans?.length) return "";
  const rows = precomputedRows || buildExportRows(targets, scans);
  const totalTargets = targets.length;
  const parts = [];

  for (let i = 0; i < scans.length; i++) {
    const postIndex = i + 1;
    const postRows = rows.filter((r) => r.postIndex === postIndex);
    const reactHits = postRows.filter((r) => r.reacted === "Co").length;
    const cmtHits = postRows.filter((r) => r.commentCount > 0).length;
    parts.push(`${reactHits}/${totalTargets} react post ${postIndex} · ${cmtHits}/${totalTargets} cmt post ${postIndex}`);
  }

  return parts.join(" | ");
}

export function buildSummaryText(targets, scans) {
  const rows = buildExportRows(targets, scans);
  if (!rows.length) return "Chưa có dữ liệu đối soát.";
  const overview = buildPostOverviewLine(targets, scans, rows);
  const detailLines = rows
    .map((r) => {
      const postTag = r.pageLabel ? `${r.pageLabel} #${r.postIndex}` : `Bài #${r.postIndex}`;
      const reactStr = r.reacted === "Co" ? `React:${r.reactionTypes}` : "React:Không";
      const cmtStr = `CMT:${r.commentCount}`;
      const shareStr = `Share:${r.publicShareCount}`;
      return `- ${r.targetName} | ${postTag} | ${reactStr} | ${cmtStr} | ${shareStr} (${r.engagementDepth})`;
    })
    .join("\n");
  return `${overview}\n${detailLines}`;
}