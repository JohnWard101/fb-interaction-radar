import { buildTargetDossier } from "./matcher.js";
import { computePostPulse, computeCommentRank } from "./insights.js";

function createPill(text, cls) {
  const span = document.createElement("span");
  span.className = `status-pill ${cls}`;
  span.textContent = text;
  return span;
}

export function renderMatrixAndDossier({
  container,
  targets,
  scans,
  selectedCell,
  onSelectCell,
  onCloseDossier
}) {
  container.classList.remove("matrix-empty");
  container.replaceChildren();

  if (!scans.length || !targets.length) {
    const empty = document.createElement("div");
    empty.className = "matrix-empty";
    empty.textContent = "Chưa có dữ liệu quét. Hãy nhập nguồn và đối tượng rồi bấm Bắt đầu.";
    container.append(empty);
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "matrix-scroll";

  const table = document.createElement("table");
  table.className = "matrix-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.textContent = "Đối tượng \\ Bài viết";
  headRow.append(corner);

  scans.forEach((scan, idx) => {
    const th = document.createElement("th");
    th.title = scan.postUrl;
    const title = document.createElement("div");
    title.className = "th-title";
    title.textContent = scan.pageLabel ? `${scan.pageLabel} · #${idx + 1}` : `Bài #${idx + 1}`;
    const sub = document.createElement("div");
    sub.className = "th-sub";
    sub.textContent = `${scan.summary?.reactionCount ?? 0}R · ${scan.summary?.commentCount ?? 0}C · ${scan.summary?.shareCount ?? 0}S`;
    th.append(title, sub);
    headRow.append(th);
  });
  thead.append(headRow);

  const tbody = document.createElement("tbody");

  targets.forEach((target) => {
    const tr = document.createElement("tr");
    const nameCell = document.createElement("th");
    nameCell.scope = "row";
    nameCell.className = "row-target";
    nameCell.textContent = target.displayName;
    nameCell.title = target.canonicalUrl || target.raw;
    tr.append(nameCell);

    scans.forEach((scan) => {
      const dossier = buildTargetDossier(target, scan);
      const td = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cell-btn";

      const isSelected =
        selectedCell?.targetKey === target.key && selectedCell?.postKey === scan.postKey;
      if (isSelected) btn.classList.add("is-selected");

      const anyHit = dossier.hasReact || dossier.hasComment || dossier.hasShare;
      if (!anyHit) {
        btn.append(createPill("Chưa thấy", "pill--none"));
      } else {
        if (dossier.hasReact) {
          btn.append(createPill(dossier.reactionTypes.join("/"), "pill--react"));
        }
        if (dossier.hasComment) {
          btn.append(createPill(`CMT (${dossier.commentCount})`, "pill--cmt"));
        }
        if (dossier.hasShare) {
          btn.append(createPill(`Share (${dossier.shareCount})`, "pill--share"));
        }
      }

      btn.addEventListener("click", () => onSelectCell({ target, scan, dossier }));
      td.append(btn);
      tr.append(td);
    });

    tbody.append(tr);
  });

  table.append(thead, tbody);
  wrap.append(table);
  container.append(wrap);

  if (selectedCell?.dossier) {
    container.append(renderDossierCard(selectedCell, onCloseDossier));
  }
}

function renderDossierCard({ target, scan, dossier }, onCloseDossier) {
  const card = document.createElement("div");
  card.className = "dossier-card";

  const head = document.createElement("div");
  head.className = "dossier-head";

  const title = document.createElement("div");
  title.className = "dossier-title";
  title.textContent = `${target.displayName} · ${dossier.depth}`;

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "6px";

  const link = document.createElement("a");
  link.href = scan.postUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "ghost-btn";
  link.textContent = "Mở bài viết";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghost-btn";
  closeBtn.textContent = "Đóng";
  closeBtn.addEventListener("click", () => {
    if (typeof onCloseDossier === "function") onCloseDossier();
  });

  actions.append(link, closeBtn);
  head.append(title, actions);
  card.append(head);

  const meta = document.createElement("div");
  meta.className = "dossier-meta";
  meta.textContent = `Độ khớp: ${dossier.confidence} · Reaction bài: ${scan.summary?.reactionCount ?? 0} · Comment quét được: ${scan.summary?.commentCount ?? 0}`;
  card.append(meta);

  const pulse = computePostPulse(scan);
  if (pulse.total > 0) {
    const pulseBox = document.createElement("div");
    pulseBox.className = "pulse-box";

    const pulseLabel = document.createElement("div");
    pulseLabel.className = "pulse-label";
    pulseLabel.textContent = `Sắc thái bài viết: ${pulse.mood} (${pulse.entries.map((e) => `${e.type} ${e.pct}%`).join(" · ")})`;

    const pulseBar = document.createElement("div");
    pulseBar.className = "pulse-bar";
    pulse.entries.forEach((e) => {
      const seg = document.createElement("span");
      seg.className = `pulse-seg pulse--${e.type.toLowerCase()}`;
      seg.style.width = `${Math.max(4, e.pct)}%`;
      seg.title = `${e.type}: ${e.count} (${e.pct}%)`;
      pulseBar.append(seg);
    });

    pulseBox.append(pulseLabel, pulseBar);
    card.append(pulseBox);
  }

  if (dossier.comments.length > 0) {
    const list = document.createElement("ul");
    list.className = "dossier-comments";
    dossier.comments.forEach((c) => {
      const li = document.createElement("li");
      const quote = document.createElement("div");
      quote.className = "cmt-text";
      quote.textContent = c.text || "(Bình luận bằng ảnh / sticker)";

      const sub = document.createElement("div");
      sub.className = "cmt-sub";
      const parts = [];
      if (c.replyTo) parts.push(`Trả lời: ${c.replyTo}`);
      if (c.createdTime) parts.push(new Date(c.createdTime).toLocaleString("vi-VN"));
      if (c.reactionCount) parts.push(`${c.reactionCount} react`);

      const rankInfo = computeCommentRank(c, scan);
      if (rankInfo) {
        parts.push(
          rankInfo.isEarly
            ? `Top sớm (#${rankInfo.rank}/${rankInfo.total})`
            : `Vị trí #${rankInfo.rank}/${rankInfo.total}`
        );
      }

      const subText = document.createElement("span");
      subText.textContent = parts.join(" · ") || `Nguồn: ${c.source}`;
      sub.append(subText);

      if (c.commentUrl) {
        const jump = document.createElement("a");
        jump.href = c.commentUrl;
        jump.target = "_blank";
        jump.rel = "noopener noreferrer";
        jump.className = "cmt-jump";
        jump.textContent = "Tới cmt";
        sub.append(" · ", jump);
      }
      li.append(quote, sub);
      list.append(li);
    });
    card.append(list);
  }

  return card;
}