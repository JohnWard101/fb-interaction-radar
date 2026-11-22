const RESERVED_FB_PATHS = new Set([
  "watch", "reel", "reels", "groups", "events", "marketplace",
  "gaming", "bookmarks", "notifications", "messages", "friends",
  "pages", "permalink.php", "photo", "photo.php", "story.php",
  "share", "login", "help", "settings", "search", "hashtag"
]);

export function foldVietnamese(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tryParseUrl(raw) {
  const trimmed = raw.trim();
  const withScheme = /^(?:www\.|m\.|mbasic\.)?(?:facebook\.com|fb\.com)\//i.test(trimmed)
    ? `https://${trimmed}`
    : trimmed;

  try {
    const url = new URL(withScheme);
    if (!/(?:^|\.)(?:facebook\.com|fb\.com)$/i.test(url.hostname)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function parseTargetLine(rawLine) {
  const raw = String(rawLine || "").trim();
  if (!raw) return null;

  // Trường hợp dán trực tiếp numeric Facebook ID (tối thiểu 6 chữ số)
  if (/^\d{6,22}$/.test(raw)) {
    return {
      key: `id:${raw}`,
      raw,
      kind: "profile_id",
      fbId: raw,
      username: null,
      displayName: `ID ${raw}`,
      foldedName: null,
      canonicalUrl: `https://www.facebook.com/profile.php?id=${raw}`
    };
  }

  const url = tryParseUrl(raw);
  if (url) {
    const path = url.pathname.replace(/\/+$/, "");
    const segments = path.split("/").filter(Boolean);

    // 1. /profile.php?id=1000...
    const idParam = url.searchParams.get("id");
    if (path.toLowerCase() === "/profile.php" && idParam && /^\d{6,22}$/.test(idParam)) {
      return {
        key: `id:${idParam}`,
        raw,
        kind: "profile_id",
        fbId: idParam,
        username: null,
        displayName: `ID ${idParam}`,
        foldedName: null,
        canonicalUrl: `https://www.facebook.com/profile.php?id=${idParam}`
      };
    }

    // 2. /people/Ten-Nguoi-Dung/1000...
    if (segments[0]?.toLowerCase() === "people" && segments[2] && /^\d{6,22}$/.test(segments[2])) {
      const cleanName = decodeURIComponent(segments[1]).replace(/-/g, " ");
      return {
        key: `id:${segments[2]}`,
        raw,
        kind: "profile_id",
        fbId: segments[2],
        username: null,
        displayName: cleanName,
        foldedName: foldVietnamese(cleanName),
        canonicalUrl: `https://www.facebook.com/profile.php?id=${segments[2]}`
      };
    }

    // 3. /groups/<gid>/user/<uid>/
    const userIdx = segments.findIndex((s) => s.toLowerCase() === "user");
    if (userIdx !== -1 && segments[userIdx + 1] && /^\d{6,22}$/.test(segments[userIdx + 1])) {
      const uid = segments[userIdx + 1];
      return {
        key: `id:${uid}`,
        raw,
        kind: "profile_id",
        fbId: uid,
        username: null,
        displayName: `ID ${uid}`,
        foldedName: null,
        canonicalUrl: `https://www.facebook.com/profile.php?id=${uid}`
      };
    }

    // 4. /username hoặc /page-slug
    const first = segments[0];
    if (first && !RESERVED_FB_PATHS.has(first.toLowerCase())) {
      const username = first.toLowerCase();
      return {
        key: `user:${username}`,
        raw,
        kind: "username",
        fbId: null,
        username,
        displayName: first,
        foldedName: foldVietnamese(first.replace(/[._-]/g, " ")),
        canonicalUrl: `https://www.facebook.com/${first}`
      };
    }

    // Link Facebook nhưng không phải profile rõ ràng (ví dụ link /share/... hoặc /watch...)
    return {
      key: `url:${url.href}`,
      raw,
      kind: "unresolved_url",
      fbId: null,
      username: null,
      displayName: url.pathname,
      foldedName: null,
      canonicalUrl: url.href
    };
  }

  // Trường hợp nhập tên hiển thị
  const folded = foldVietnamese(raw);
  return {
    key: `name:${folded}`,
    raw,
    kind: "name",
    fbId: null,
    username: null,
    displayName: raw,
    foldedName: folded,
    canonicalUrl: null
  };
}

export function parseSourceLine(rawLine, mode) {
  const raw = String(rawLine || "").trim();
  if (!raw) return null;

  const url = tryParseUrl(raw);
  if (mode === "mode_a") {
    if (!url) {
      return {
        key: `invalid:${raw}`,
        raw,
        kind: "invalid_post_url",
        valid: false,
        reason: "Hướng A cần URL bài viết Facebook hợp lệ",
        canonicalUrl: null
      };
    }
    ["fbclid", "mibextid", "__cft__[0]", "__tn__", "notif_id", "notif_t", "ref"].forEach((k) => {
      url.searchParams.delete(k);
    });
    const cleanUrl = `${url.origin}${url.pathname}${url.search}`.replace(/\/+$/, "");
    return {
      key: `post:${cleanUrl}`,
      raw,
      kind: "post_url",
      valid: true,
      canonicalUrl: cleanUrl
    };
  }

  // Hướng B: danh sách Trang / Profile cần quét bài mới nhất
  const parsedAsPage = parseTargetLine(raw);
  if (!parsedAsPage || parsedAsPage.kind === "unresolved_url") {
    return {
      key: `invalid:${raw}`,
      raw,
      kind: "invalid_page",
      valid: false,
      reason: "Không nhận diện được Trang Facebook",
      canonicalUrl: null
    };
  }
  return {
    ...parsedAsPage,
    valid: true,
    isNameQuery: parsedAsPage.kind === "name"
  };
}

export function parseMultiLines(text, itemParser) {
  const seen = new Set();
  const items = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const parsed = itemParser(line);
    if (!parsed || seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    items.push(parsed);
  }
  return items;
}

export function describeMatrixShape(targetCount, sourceCount) {
  if (targetCount === 0 || sourceCount === 0) {
    return { code: "empty", label: "Chưa đủ đầu vào" };
  }
  if (targetCount === 1 && sourceCount === 1) {
    return { code: "1x1", label: "1 Đối tượng × 1 Nguồn" };
  }
  if (targetCount > 1 && sourceCount === 1) {
    return { code: "Nx1", label: `${targetCount} Đối tượng × 1 Nguồn` };
  }
  if (targetCount === 1 && sourceCount > 1) {
    return { code: "1xM", label: `1 Đối tượng × ${sourceCount} Nguồn` };
  }
  return { code: "NxM", label: `${targetCount} Đối tượng × ${sourceCount} Nguồn` };
}