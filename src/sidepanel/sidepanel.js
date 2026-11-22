import {
  parseMultiLines,
  parseSourceLine,
  parseTargetLine,
  describeMatrixShape
} from "../core/parser.js";
import { listRecentScans, clearAllScans, getPostScan, savePostScan } from "../core/db.js";
import { renderMatrixAndDossier } from "../core/matrix_view.js";
import { buildExportRows, rowsToCsv, buildSummaryText, buildPostOverviewLine } from "../core/insights.js";

const SAVED_INPUTS_KEY = "radar_saved_inputs_v1";
let saveInputsTimer = null;

const state = {
  mode: "mode_a",
  execMode: "bg_tab",
  sourcesByMode: { mode_a: "", mode_b: "" },
  sources: [],
  targets: [],
  scans: [],
  selectedCell: null,
  running: false,
  paused: false,
  aborted: false,
  activeScanTabId: null
};

const els = {
  segBtns: Array.from(document.querySelectorAll(".seg-btn")),
  sourceLabel: document.getElementById("sourceLabel"),
  sourceInput: document.getElementById("sourceInput"),
  sourcePreview: document.getElementById("sourcePreview"),
  modeBOptions: document.getElementById("modeBOptions"),
  useCurrentTabBtn: document.getElementById("useCurrentTabBtn"),
  useCurrentTargetTabBtn: document.getElementById("useCurrentTargetTabBtn"),
  targetInput: document.getElementById("targetInput"),
  targetPreview: document.getElementById("targetPreview"),
  matrixBadge: document.getElementById("matrixBadge"),
  startScanBtn: document.getElementById("startScanBtn"),
  clearCacheBtn: document.getElementById("clearCacheBtn"),
  cacheCount: document.getElementById("cacheCount"),
  statusNotice: document.getElementById("statusNotice"),
  pauseScanBtn: document.getElementById("pauseScanBtn"),
  stopScanBtn: document.getElementById("stopScanBtn"),
  forceRescanInput: document.getElementById("forceRescanInput"),
  matrixContainer: document.getElementById("matrixContainer"),
  resultSummary: document.getElementById("resultSummary"),
  execBtns: Array.from(document.querySelectorAll(".exec-btn")),
  autoFallbackInput: document.getElementById("autoFallbackInput"),
  docIdBadge: document.getElementById("docIdBadge"),
  postsPerPageInput: document.getElementById("postsPerPageInput"),
  delaySecondsInput: document.getElementById("delaySecondsInput"),
  exportBar: document.getElementById("exportBar"),
  copySummaryBtn: document.getElementById("copySummaryBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn")
};

function createChip(tag, label, variantClass) {
  const chip = document.createElement("span");
  chip.className = `chip ${variantClass}`;

  const tagEl = document.createElement("span");
  tagEl.className = "chip-tag";
  tagEl.textContent = tag;

  const labelEl = document.createElement("span");
  labelEl.className = "chip-label";
  labelEl.textContent = label;
  labelEl.title = label;

  chip.append(tagEl, labelEl);
  return chip;
}

function renderSources() {
  state.sources = parseMultiLines(
    els.sourceInput.value,
    (line) => parseSourceLine(line, state.mode)
  );
  els.sourcePreview.replaceChildren();

  for (const s of state.sources) {
    if (!s.valid) {
      els.sourcePreview.append(createChip("Lỗi", s.raw, "chip--err"));
    } else if (s.kind === "name") {
      els.sourcePreview.append(createChip("Tên Page", s.displayName, "chip--warn"));
    } else {
      els.sourcePreview.append(createChip("URL", s.displayName || s.canonicalUrl, "chip--exact"));
    }
  }
}

function renderTargets() {
  state.targets = parseMultiLines(els.targetInput.value, parseTargetLine);
  els.targetPreview.replaceChildren();

  for (const t of state.targets) {
    if (t.kind === "profile_id") {
      els.targetPreview.append(createChip("ID", t.displayName, "chip--exact"));
    } else if (t.kind === "username") {
      els.targetPreview.append(createChip("User", t.username, "chip--exact"));
    } else if (t.kind === "name") {
      els.targetPreview.append(createChip("Tên", t.displayName, "chip--warn"));
    } else {
      els.targetPreview.append(createChip("Lỗi", t.raw, "chip--err"));
    }
  }
}

function updateMatrixStatus() {
  const validSources = state.sources.filter((s) => s.valid);
  const validTargets = state.targets.filter((t) => t.kind !== "unresolved_url");
  const shape = describeMatrixShape(validTargets.length, validSources.length);

  els.matrixBadge.textContent = shape.label;
  els.startScanBtn.disabled = validSources.length === 0 || validTargets.length === 0;
}

function refreshAll() {
  renderSources();
  renderTargets();
  updateMatrixStatus();
}

async function refreshCacheCount() {
  try {
    const scans = await listRecentScans(100);
    els.cacheCount.textContent = String(scans.length);
  } catch {
    els.cacheCount.textContent = "0";
  }
}

function applyModeUi(mode) {
  state.mode = mode === "mode_b" ? "mode_b" : "mode_a";
  els.segBtns.forEach((b) => {
    const active = b.dataset.mode === state.mode;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", String(active));
  });

  const isModeB = state.mode === "mode_b";
  els.modeBOptions.hidden = !isModeB;
  els.sourceLabel.textContent = isModeB
    ? "Tên hoặc link Fanpage cần quét (mỗi dòng 1 Page)"
    : "Link bài viết Facebook (mỗi dòng 1 link)";
  els.sourceInput.placeholder = isModeB
    ? "Ví dụ:\nhttps://www.facebook.com/Theanh28\nVTV24"
    : "Dán 1 hoặc nhiều link bài viết Facebook (mỗi dòng 1 link)...";
}

function applyExecModeUi(execMode) {
  state.execMode = execMode === "headless_fetch" ? "headless_fetch" : "bg_tab";
  els.execBtns.forEach((b) => {
    const active = b.dataset.exec === state.execMode;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-checked", String(active));
  });
}

function persistInputs() {
  state.sourcesByMode[state.mode] = els.sourceInput.value;
  chrome.storage.local.set({
    [SAVED_INPUTS_KEY]: {
      mode: state.mode,
      execMode: state.execMode,
      sourcesByMode: state.sourcesByMode,
      targetText: els.targetInput.value,
      postsPerPage: els.postsPerPageInput?.value || "5",
      delaySeconds: els.delaySecondsInput?.value || "4",
      autoFallback: Boolean(els.autoFallbackInput?.checked),
      forceRescan: Boolean(els.forceRescanInput?.checked)
    }
  });
}

function scheduleSaveInputs() {
  clearTimeout(saveInputsTimer);
  saveInputsTimer = setTimeout(persistInputs, 250);
}

async function restoreSavedInputs() {
  const res = await chrome.storage.local.get([SAVED_INPUTS_KEY]).catch(() => null);
  const saved = res?.[SAVED_INPUTS_KEY];
  if (!saved || typeof saved !== "object") return;

  if (saved.sourcesByMode && typeof saved.sourcesByMode === "object") {
    state.sourcesByMode.mode_a = String(saved.sourcesByMode.mode_a || "");
    state.sourcesByMode.mode_b = String(saved.sourcesByMode.mode_b || "");
  }
  if (typeof saved.targetText === "string") {
    els.targetInput.value = saved.targetText;
  }
  if (saved.postsPerPage && els.postsPerPageInput) {
    els.postsPerPageInput.value = String(saved.postsPerPage);
  }
  if (saved.delaySeconds && els.delaySecondsInput) {
    els.delaySecondsInput.value = String(saved.delaySeconds);
  }
  if (typeof saved.autoFallback === "boolean" && els.autoFallbackInput) {
    els.autoFallbackInput.checked = saved.autoFallback;
  }
  if (typeof saved.forceRescan === "boolean" && els.forceRescanInput) {
    els.forceRescanInput.checked = saved.forceRescan;
  }

  applyModeUi(saved.mode);
  applyExecModeUi(saved.execMode);
  els.sourceInput.value = state.sourcesByMode[state.mode] || "";
}

els.segBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.sourcesByMode[state.mode] = els.sourceInput.value;
    applyModeUi(btn.dataset.mode);
    els.sourceInput.value = state.sourcesByMode[state.mode] || "";
    refreshAll();
    scheduleSaveInputs();
  });
});

els.sourceInput.addEventListener("input", () => {
  state.sourcesByMode[state.mode] = els.sourceInput.value;
  refreshAll();
  scheduleSaveInputs();
});

els.targetInput.addEventListener("input", () => {
  refreshAll();
  scheduleSaveInputs();
});

[els.postsPerPageInput, els.delaySecondsInput, els.autoFallbackInput, els.forceRescanInput]
  .filter(Boolean)
  .forEach((el) => el.addEventListener("change", scheduleSaveInputs));

function appendCurrentFbTabTo(textareaEl, successMsg) {
  chrome.runtime.sendMessage({ type: "GET_ACTIVE_FB_TAB" }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      els.statusNotice.textContent = "Không đọc được tab hiện tại.";
      return;
    }
    if (!res.tab.isFacebook) {
      els.statusNotice.textContent = "Tab đang mở không phải Facebook.";
      return;
    }
    const existing = textareaEl.value.trim();
    textareaEl.value = existing ? `${existing}\n${res.tab.url}` : res.tab.url;
    els.statusNotice.textContent = successMsg;
    refreshAll();
    persistInputs();
  });
}

els.useCurrentTabBtn.addEventListener("click", () => {
  appendCurrentFbTabTo(els.sourceInput, "Đã thêm URL nguồn từ tab Facebook đang mở.");
});

els.useCurrentTargetTabBtn.addEventListener("click", () => {
  appendCurrentFbTabTo(els.targetInput, "Đã thêm link profile/Page đối tượng từ tab Facebook đang mở.");
});

els.clearCacheBtn.addEventListener("click", async () => {
  await clearAllScans();
  await refreshCacheCount();
  els.statusNotice.textContent = "Đã xóa cache quét cục bộ.";
});

function enrichTargetsFromScans(targets, scans) {
  const idByUser = new Map();
  for (const scan of scans || []) {
    for (const list of [scan.reactions, scan.comments, scan.shares]) {
      for (const item of list || []) {
        const a = item?.actor;
        if (!a?.fbId || !a.profileUrl) continue;
        const u = parseTargetLine(a.profileUrl);
        if (u?.username) idByUser.set(u.username, a.fbId);
      }
    }
  }
  return targets.map((t) =>
    t.username && !t.fbId && idByUser.has(t.username)
      ? { ...t, fbId: idByUser.get(t.username) }
      : t
  );
}

function getEffectiveTargets() {
  const validTargets = state.targets.filter((t) => t.kind !== "unresolved_url");
  return enrichTargetsFromScans(validTargets, state.scans);
}

function renderMatrix() {
  els.exportBar.hidden = state.scans.length === 0;
  const effectiveTargets = getEffectiveTargets();
  renderMatrixAndDossier({
    container: els.matrixContainer,
    targets: effectiveTargets,
    scans: state.scans,
    selectedCell: state.selectedCell,
    onSelectCell: (cell) => {
      const sameCell =
        state.selectedCell?.targetKey === cell.target.key &&
        state.selectedCell?.postKey === cell.scan.postKey;
      state.selectedCell = sameCell
        ? null
        : {
            ...cell,
            targetKey: cell.target.key,
            postKey: cell.scan.postKey
          };
      renderMatrix();
    },
    onCloseDossier: () => {
      state.selectedCell = null;
      renderMatrix();
    }
  });
}

function setRunningUi(isRunning) {
  state.running = isRunning;
  els.startScanBtn.disabled = isRunning;
  els.pauseScanBtn.hidden = !isRunning;
  els.stopScanBtn.hidden = !isRunning;
  if (!isRunning) {
    state.paused = false;
    els.pauseScanBtn.textContent = "Tạm dừng";
    updateMatrixStatus();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "SCAN_PROGRESS" && state.running) {
    els.statusNotice.textContent = msg.text;
  }
});

els.pauseScanBtn.addEventListener("click", () => {
  state.paused = !state.paused;
  els.pauseScanBtn.textContent = state.paused ? "Tiếp tục" : "Tạm dừng";
  chrome.runtime.sendMessage({
    type: "CONTROL_TAB_SCAN",
    tabId: state.activeScanTabId,
    action: state.paused ? "pause" : "resume"
  });
});

els.stopScanBtn.addEventListener("click", () => {
  state.aborted = true;
  chrome.runtime.sendMessage({
    type: "CONTROL_TAB_SCAN",
    tabId: state.activeScanTabId,
    action: "stop"
  });
  els.statusNotice.textContent = "Đang dừng phiên quét...";
});

async function refreshDocIdBadge() {
  chrome.runtime.sendMessage({ type: "GET_LEARNED_DOC_STATUS" }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) return;
    els.docIdBadge.textContent = `Đã học ${res.count}/3 doc_id`;
  });
}

els.execBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    applyExecModeUi(btn.dataset.exec);
    scheduleSaveInputs();
  });
});

async function closeScannerTabIfAny() {
  if (typeof state.activeScanTabId === "number") {
    const closingId = state.activeScanTabId;
    state.activeScanTabId = null;
    await chrome.runtime.sendMessage({ type: "CLOSE_SCANNER_TAB", tabId: closingId }).catch(() => {});
  }
}

els.startScanBtn.addEventListener("click", async () => {
  const validSources = state.sources.filter((s) => s.valid);
  const forceRescan = els.forceRescanInput.checked;
  const allowAutoFallback = els.autoFallbackInput.checked;
  state.scans = [];
  state.selectedCell = null;
  state.aborted = false;
  setRunningUi(true);

  const validTargets = state.targets.filter((t) => t.kind !== "unresolved_url");
  els.statusNotice.textContent = "Đang đồng bộ ID profile đối tượng...";
  const resolvedRes = await chrome.runtime.sendMessage({
    type: "RESOLVE_TARGET_IDENTITIES",
    targets: validTargets
  }).catch(() => null);

  if (resolvedRes?.ok && Array.isArray(resolvedRes.targets)) {
    const byKey = new Map(resolvedRes.targets.map((t) => [t.key, t]));
    state.targets = state.targets.map((t) => byKey.get(t.key) || t);
  }
  if (resolvedRes?.debugSample) {
    console.log("[Radar resolve sample]", JSON.stringify(resolvedRes.debugSample));
  }
  console.log("[Radar targets]", state.targets.map((t) => ({
    key: t.key,
    fbId: t.fbId || null,
    username: t.username || null
  })));

  let postQueue = [];
  const delaySec = Math.min(15, Math.max(2, Number(els.delaySecondsInput?.value) || 4));
  const postsPerPage = Math.min(30, Math.max(1, Number(els.postsPerPageInput?.value) || 5));

  async function sleepSafe(ms) {
    let elapsed = 0;
    while (elapsed < ms) {
      if (state.aborted) return false;
      if (!state.paused) elapsed += 200;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  }

  try {
    if (state.mode === "mode_a") {
      postQueue = validSources.map((s) => ({ url: s.canonicalUrl, pageLabel: null }));
    } else {
      for (let pIdx = 0; pIdx < validSources.length; pIdx++) {
        if (state.aborted) break;
        const pageSrc = validSources[pIdx];
        els.statusNotice.textContent = `Đang tìm tối đa ${postsPerPage} bài trên "${pageSrc.displayName}" (${pIdx + 1}/${validSources.length})...`;

        const discovered = await chrome.runtime.sendMessage({
          type: "DISCOVER_PAGE_POSTS",
          payload: {
            source: pageSrc,
            limit: postsPerPage,
            execMode: state.execMode,
            preferredTabId: state.activeScanTabId,
            allowFallback: allowAutoFallback
          }
        });

        if (discovered?.tabId) state.activeScanTabId = discovered.tabId;
        if (discovered?.ok && Array.isArray(discovered.urls)) {
          for (const url of discovered.urls) {
            if (!postQueue.some((item) => item.url === url)) {
              postQueue.push({ url, pageLabel: pageSrc.displayName });
            }
          }
        }
      }
    }

    if (postQueue.length === 0 && !state.aborted) {
      els.statusNotice.textContent = "Không tìm thấy bài viết nào từ nguồn đã nhập.";
      return;
    }

    for (let i = 0; i < postQueue.length; i++) {
      if (state.aborted) break;
      const item = postQueue[i];
      const cacheKey = item.url.replace(/\/+$/, "");

      if (!forceRescan) {
        const cached = await getPostScan(cacheKey);
        if (cached) {
          if (item.pageLabel && !cached.pageLabel) cached.pageLabel = item.pageLabel;
          state.scans.push(cached);
          renderMatrix();
          els.statusNotice.textContent = `Đã dùng cache cho bài ${i + 1}/${postQueue.length}.`;
          continue;
        }
      }

      let res = null;
      if (state.execMode === "headless_fetch") {
        els.statusNotice.textContent = `[Không mở tab] Đang tải ngầm bài ${i + 1}/${postQueue.length}...`;
        res = await chrome.runtime.sendMessage({
          type: "HEADLESS_SCAN_URL",
          payload: { targetUrl: item.url }
        });

        const totalFound =
          (res?.scan?.summary?.reactionCount || 0) +
          (res?.scan?.summary?.commentCount || 0) +
          (res?.scan?.summary?.shareCount || 0);

        const needFallback =
          allowAutoFallback &&
          (!res?.ok || (res?.headlessMeta?.graphqlUsed === 0 && totalFound === 0));

        if (needFallback && !state.aborted) {
          els.statusNotice.textContent = `Option 2 chưa đủ dữ liệu (${res?.headlessMeta?.learnedSlotsCount || 0}/3 doc_id), đang tự chuyển sang Tab nền ẩn...`;
          res = await chrome.runtime.sendMessage({
            type: "PREPARE_AND_SCAN_URL",
            payload: {
              targetUrl: item.url,
              preferredTabId: state.activeScanTabId,
              options: { maxCommentClicks: 20, maxReactionScrolls: 40, maxShareScrolls: 15 }
            }
          });
          if (res?.tabId) state.activeScanTabId = res.tabId;
        }
      } else {
        els.statusNotice.textContent = `[Tab nền ẩn] Đang quét bài ${i + 1}/${postQueue.length}...`;
        res = await chrome.runtime.sendMessage({
          type: "PREPARE_AND_SCAN_URL",
          payload: {
            targetUrl: item.url,
            preferredTabId: state.activeScanTabId,
            options: { maxCommentClicks: 20, maxReactionScrolls: 40, maxShareScrolls: 15 }
          }
        });
        if (res?.tabId) state.activeScanTabId = res.tabId;
      }

      if (!res?.ok || !res.scan) {
        els.statusNotice.textContent = res?.aborted
          ? "Đã dừng phiên quét theo yêu cầu."
          : `Không quét được bài ${i + 1}: ${res?.error || "Lỗi không xác định"}`;
        if (res?.aborted) break;
        continue;
      }

      const normPost = (u) => String(u || "").split("#")[0].replace(/\/+$/, "");
      const prevScan = state.scans[state.scans.length - 1];
      if (prevScan && normPost(prevScan.postUrl) === normPost(res.scan.postUrl) && cacheKey !== prevScan.postKey) {
        els.statusNotice.textContent = `Bài ${i + 1} trả về trùng URL bài trước, đã bỏ qua.`;
        continue;
      }

      res.scan.postKey = cacheKey;
      if (res.scan.debugMeta) {
        console.log(`[Radar scan #${i + 1}]`, res.scan.postUrl, JSON.stringify(res.scan.debugMeta));
      }
      if (item.pageLabel) res.scan.pageLabel = item.pageLabel;
      const totalItems =
        (res.scan.summary?.reactionCount || 0) +
        (res.scan.summary?.commentCount || 0) +
        (res.scan.summary?.shareCount || 0);
      if (totalItems > 0) {
        await savePostScan(res.scan);
      }
      state.scans.push(res.scan);
      renderMatrix();
      await refreshCacheCount();
      await refreshDocIdBadge();

      if (i < postQueue.length - 1 && !state.aborted && state.mode === "mode_b") {
        els.statusNotice.textContent = `Tạm nghỉ an toàn ${delaySec}s trước bài tiếp theo...`;
        await sleepSafe(delaySec * 1000);
      }
    }
  } catch (err) {
    state.aborted = true;
    els.statusNotice.textContent = `Lỗi khi quét: ${err?.message || "Không rõ nguyên nhân"}`;
  } finally {
    await closeScannerTabIfAny();
    await refreshDocIdBadge();
    const validTargets = getEffectiveTargets();
    const overview = buildPostOverviewLine(validTargets, state.scans);
    els.resultSummary.textContent = overview
      ? `Đã đối soát ${state.scans.length}/${postQueue.length} bài · ${overview}`
      : `Đã đối soát ${state.scans.length}/${postQueue.length} bài`;
    if (!state.aborted && postQueue.length > 0) {
      els.statusNotice.textContent = "Hoàn tất kiểm tra ma trận (đã đóng tab nền nếu có).";
    }
    setRunningUi(false);
  }
});

refreshDocIdBadge();
refreshAll();
refreshCacheCount();
restoreSavedInputs().then(refreshAll);

function downloadBlob(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

els.copySummaryBtn.addEventListener("click", async () => {
  const validTargets = getEffectiveTargets();
  const text = buildSummaryText(validTargets, state.scans);
  try {
    await navigator.clipboard.writeText(text);
    els.statusNotice.textContent = "Đã copy bản tóm tắt kết quả vào Clipboard.";
  } catch {
    els.statusNotice.textContent = "Không truy cập được Clipboard; hãy dùng nút Xuất CSV.";
  }
});

els.exportCsvBtn.addEventListener("click", () => {
  const validTargets = getEffectiveTargets();
  const rows = buildExportRows(validTargets, state.scans);
  const csv = rowsToCsv(rows);
  downloadBlob(`fb-radar-${Date.now()}.csv`, csv, "text/csv;charset=utf-8");
  els.statusNotice.textContent = `Đã xuất ${rows.length} dòng kết quả ra file CSV.`;
});

els.exportJsonBtn.addEventListener("click", () => {
  const validTargets = getEffectiveTargets();
  const payload = {
    exportedAt: new Date().toISOString(),
    mode: state.mode,
    rows: buildExportRows(validTargets, state.scans),
    scans: state.scans
  };
  downloadBlob(`fb-radar-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
  els.statusNotice.textContent = "Đã xuất dữ liệu chi tiết ra file JSON.";
});