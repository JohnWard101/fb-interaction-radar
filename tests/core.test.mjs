import test from "node:test";
import assert from "node:assert/strict";
import { parseTargetLine, parseMultiLines, describeMatrixShape } from "../src/core/parser.js";
import { matchActorToTarget, buildTargetDossier } from "../src/core/matcher.js";

test("parseTargetLine nhận diện profile.php?id=, /people/.../id và username", () => {
  const byId = parseTargetLine("https://www.facebook.com/profile.php?id=1000123456789&sk=about");
  assert.equal(byId.kind, "profile_id");
  assert.equal(byId.fbId, "1000123456789");

  const byPeople = parseTargetLine("https://m.facebook.com/people/Nguyen-Van-A/1000999888777/");
  assert.equal(byPeople.kind, "profile_id");
  assert.equal(byPeople.fbId, "1000999888777");
  assert.equal(byPeople.displayName, "Nguyen Van A");

  const byUser = parseTargetLine("https://www.facebook.com/Zuck/");
  assert.equal(byUser.kind, "username");
  assert.equal(byUser.username, "zuck");
});

test("parseMultiLines loại trùng và giữ nguyên tên có dấu phẩy", () => {
  const items = parseMultiLines(
    "https://facebook.com/zuck\nhttps://m.facebook.com/zuck/\nTrần, Minh Anh",
    parseTargetLine
  );
  assert.equal(items.length, 2);
});

test("matchActorToTarget ưu tiên exact_id rồi exact_username rồi tên bỏ dấu", () => {
  const targetId = parseTargetLine("1000123456789");
  const m1 = matchActorToTarget({ fbId: "1000123456789", name: "Ai Do" }, targetId);
  assert.equal(m1.matched, true);
  assert.equal(m1.confidence, "exact_id");

  const targetName = parseTargetLine("Nguyễn Văn An");
  const m2 = matchActorToTarget({ name: "Nguyen Van An" }, targetName);
  assert.equal(m2.matched, true);
  assert.equal(m2.confidence, "exact_name");
});

test("buildTargetDossier tổng hợp đúng react, comment, share và depth", () => {
  const target = parseTargetLine("https://www.facebook.com/minh.tran");
  const scan = {
    postUrl: "https://www.facebook.com/page/posts/123",
    reactions: [{ actor: { profileUrl: "https://facebook.com/minh.tran", name: "Minh" }, reactionType: "LOVE" }],
    comments: [{ actor: { username: "minh.tran", name: "Minh" }, text: "Quá hay", replyTo: null }],
    shares: []
  };
  const dossier = buildTargetDossier(target, scan);
  assert.equal(dossier.hasReact, true);
  assert.deepEqual(dossier.reactionTypes, ["LOVE"]);
  assert.equal(dossier.hasComment, true);
  assert.equal(dossier.hasShare, false);
  assert.match(dossier.depth, /Vocal/);
});

test("describeMatrixShape phân loại đủ 4 dạng ma trận", () => {
  assert.equal(describeMatrixShape(1, 1).code, "1x1");
  assert.equal(describeMatrixShape(3, 1).code, "Nx1");
  assert.equal(describeMatrixShape(1, 4).code, "1xM");
  assert.equal(describeMatrixShape(3, 4).code, "NxM");
});

import { parseGraphqlChunks, extractInteractionsFromPayload } from "../src/core/graphql_parser.js";

test("parseGraphqlChunks bỏ tiền tố for (;;); và đọc nhiều dòng JSON", () => {
  const raw = 'for (;;);{"data":{"ok":1}}\n{"data":{"ok":2}}';
  const chunks = parseGraphqlChunks(raw);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].data.ok, 2);
});

test("extractInteractionsFromPayload trích xuất reaction, comment và share", () => {
  const payload = {
    data: {
      reactors: {
        edges: [
          {
            node: { id: "1000111222333", name: "Lan Anh", url: "https://www.facebook.com/lan.anh" },
            feedback_reaction_info: { reaction_type: "HAHA" }
          }
        ]
      },
      comments: {
        edges: [
          {
            node: {
              __typename: "Comment",
              id: "cmt_1",
              author: { id: "1000444555666", name: "Minh Quân", url: "https://www.facebook.com/minh.quan" },
              body: { text: "Chuẩn bài luôn" },
              created_time: 1700000000
            }
          }
        ]
      },
      reshares: {
        edges: [
          {
            node: {
              __typename: "Story",
              actors: [{ id: "1000777888999", name: "Huy Hoàng", url: "https://www.facebook.com/huy.hoang" }],
              message: { text: "Đáng đọc" }
            }
          }
        ]
      }
    }
  };

  const out = extractInteractionsFromPayload(payload);
  assert.equal(out.reactions.length, 1);
  assert.equal(out.reactions[0].reactionType, "HAHA");
  assert.equal(out.comments.length, 1);
  assert.equal(out.comments[0].text, "Chuẩn bài luôn");
  assert.equal(out.shares.length, 1);
  assert.equal(out.shares[0].caption, "Đáng đọc");
});

import { extractTokensFromHtml, extractInteractionsFromSsrHtml, classifyDocIdRequest } from "../src/core/ssr_parser.js";

test("extractTokensFromHtml tách được fb_dtsg, lsd và feedbackId", () => {
  const html = `
    <title>CLB Tài Năng Trẻ</title>
    <script>["DTSGInitialData",[],{"token":"NAc123:456"},258]</script>
    <script>["LSD",[],{"token":"AVo999"},323]</script>
    <script type="application/json">{"feedback":{"id":"ZmVlZGJhY2s6OTk5"}}</script>
  `;
  const tokens = extractTokensFromHtml(html);
  assert.equal(tokens.fbDtsg, "NAc123:456");
  assert.equal(tokens.lsd, "AVo999");
  assert.equal(tokens.feedbackId, "ZmVlZGJhY2s6OTk5");
  assert.equal(tokens.title, "CLB Tài Năng Trẻ");
});

test("extractInteractionsFromSsrHtml đọc được comment nhúng sẵn trong HTML", () => {
  const html = `
    <script type="application/json">
      {"node":{"__typename":"Comment","id":"c1","author":{"id":"1000123","name":"Hoàng Lượng","url":"https://www.facebook.com/Taoo.ditcondimemay"},"body":{"text":"Tham gia thôi nào"}}}
    </script>
  `;
  const out = extractInteractionsFromSsrHtml(html);
  assert.equal(out.comments.length, 1);
  assert.equal(out.comments[0].text, "Tham gia thôi nào");
});

test("classifyDocIdRequest nhận diện doc_id của Reactions modal", () => {
  const body = new URLSearchParams({
    fb_api_req_friendly_name: "CometUFIReactionsDialogTabContentRefetchQuery",
    doc_id: "789123456789",
    variables: JSON.stringify({ feedbackID: "ZmVlZGJhY2s6MTEx", scale: 1 })
  }).toString();

  const parsed = classifyDocIdRequest(body);
  assert.equal(parsed.slot, "reactions");
  assert.equal(parsed.docId, "789123456789");
  assert.equal(parsed.feedbackKey, "feedbackID");
});

import { extractProfileIdentityFromHtml } from "../src/core/ssr_parser.js";

test("extractProfileIdentityFromHtml bỏ qua USER_ID người xem và lấy đúng ID chủ profile", () => {
  const html = `
    <title>Hoàng Lượng | Facebook</title>
    <meta property="al:ios:url" content="fb://profile/1000888777666" />
    <script>{"USER_ID":"999999999"}</script>
  `;
  const idInfo = extractProfileIdentityFromHtml(html);
  assert.equal(idInfo.fbId, "1000888777666");
  assert.equal(idInfo.name, "Hoàng Lượng");
});

import { mergeCommentLists, extractReactorsPageInfo } from "../src/core/graphql_parser.js";

test("mergeCommentLists gộp trùng comment giữa GraphQL và DOM nhưng vẫn giữ nếu comment 2 lần thật", () => {
  const gql = [
    { id: "Y29tOjE=", actor: { fbId: "100", name: "Hoàng Lượng", profileUrl: "" }, text: "Tham gia thôi nào", createdTime: 1700000000 }
  ];
  const dom = [
    { id: null, actor: { fbId: null, name: "Hoàng Lượng", profileUrl: "https://www.facebook.com/Taoo.ditcondimemay" }, text: "Tham gia thôi nào", commentUrl: "https://www.facebook.com/p?comment_id=555" }
  ];
  const once = mergeCommentLists(gql, dom);
  assert.equal(once.length, 1);
  assert.equal(once[0].actor.profileUrl, "https://www.facebook.com/Taoo.ditcondimemay");
  assert.equal(once[0].createdTime, 1700000000);

  const gqlTwice = [
    { id: "Y29tOjE=", actor: { fbId: "100", name: "Hoàng Lượng" }, text: "Tham gia thôi nào" },
    { id: "Y29tOjI=", actor: { fbId: "100", name: "Hoàng Lượng" }, text: "Tham gia thôi nào" }
  ];
  assert.equal(mergeCommentLists(gqlTwice, []).length, 2);
});

import { extractPostUrlsFromPageHtml } from "../src/core/ssr_parser.js";

test("extractPostUrlsFromPageHtml tách link bài viết hợp lệ và bỏ qua link comment", () => {
  const html = `
    "permalink_url":"https:\\/\\/www.facebook.com\\/clbytc\\/posts\\/pfbid01?fbclid=abc"
    "url":"https:\\/\\/www.facebook.com\\/clbytc\\/posts\\/pfbid01?comment_id=999"
    "url":"https:\\/\\/www.facebook.com\\/clbytc\\/videos\\/123456789"
  `;
  const urls = extractPostUrlsFromPageHtml(html, 5);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], "https://www.facebook.com/clbytc/posts/pfbid01");
  assert.equal(urls[1], "https://www.facebook.com/clbytc/videos/123456789");
});

test("extractInteractionsFromPayload bắt được comment chỉ có Sticker hoặc GIF (body null)", () => {
  const payload = {
    data: {
      node: {
        __typename: "Comment",
        id: "Y29tOjk5",
        author: { id: "1000111", name: "Diệu Linh", url: "https://www.facebook.com/dieu.linh" },
        body: null,
        attachments: [{ style_type_renderer: { __typename: "StoryAttachmentStickerStyleRenderer" } }]
      }
    }
  };
  const out = extractInteractionsFromPayload(payload);
  assert.equal(out.comments.length, 1);
  assert.equal(out.comments[0].text, "[Sticker]");
});

import { computePostPulse, computeCommentRank, buildExportRows, rowsToCsv, buildSummaryText } from "../src/core/insights.js";

test("buildSummaryText tạo dòng tổng quan X/Y react post N và cmt post N", () => {
  const t1 = parseTargetLine("https://www.facebook.com/user1");
  const t2 = parseTargetLine("https://www.facebook.com/user2");
  const s1 = {
    postUrl: "https://www.facebook.com/p/1",
    reactions: [{ actor: { username: "user1", name: "U1" }, reactionType: "LIKE" }],
    comments: [
      { actor: { username: "user1", name: "U1" }, text: "Hi" },
      { actor: { username: "user2", name: "U2" }, text: "Hello" }
    ],
    shares: []
  };
  const summary = buildSummaryText([t1, t2], [s1]);
  assert.equal(summary.startsWith("1/2 react post 1 · 2/2 cmt post 1\n"), true);
});

test("computePostPulse và computeCommentRank tính đúng tỷ lệ cảm xúc và vị trí bình luận", () => {
  const c1 = { id: "1", createdTime: 1000 };
  const c2 = { id: "2", createdTime: 2000 };
  const c3 = { id: "3", createdTime: 3000 };
  const c4 = { id: "4", createdTime: 4000 };
  const c5 = { id: "5", createdTime: 5000 };
  const scan = {
    summary: { reactionBreakdown: { LOVE: 7, LIKE: 3 } },
    comments: [c5, c1, c3, c2, c4]
  };

  const pulse = computePostPulse(scan);
  assert.equal(pulse.total, 10);
  assert.match(pulse.mood, /Tích cực \(100%\)/);

  const rank = computeCommentRank(c1, scan);
  assert.equal(rank.rank, 1);
  assert.equal(rank.isEarly, true);
});

test("rowsToCsv chống CSV formula injection và giữ UTF-8 BOM", () => {
  const target = parseTargetLine("https://www.facebook.com/zuck");
  const scan = {
    postUrl: "https://www.facebook.com/page/posts/1",
    reactions: [],
    comments: [{ actor: { username: "zuck", name: "Mark" }, text: "=CMD() nguy hiểm" }],
    shares: [],
    scannedAt: 1700000000000
  };
  const rows = buildExportRows([target], [scan]);
  const csv = rowsToCsv(rows);
  assert.equal(csv.startsWith("\uFEFF"), true);
  assert.equal(csv.includes("'=CMD() nguy hiểm"), true);
});

test("extractPostUrlsFromPageHtml khôi phục được bài viết từ post_id và set=pcb trong SSR HTML", () => {
  const html = `
    "post_id":"1015999888777666"
    "uri":"https://www.facebook.com/photo/?fbid=123&set=pcb.2025111222333444"
  `;
  const urls = extractPostUrlsFromPageHtml(html, 5, "https://www.facebook.com/clbytc");
  assert.equal(urls.length, 2);
  assert.equal(urls[0], "https://www.facebook.com/clbytc/posts/1015999888777666");
  assert.equal(urls[1], "https://www.facebook.com/clbytc/posts/2025111222333444");
});

test("buildTargetDossier ưu tiên reaction thật từ GraphQL và loại bỏ LIKE đoán từ DOM", () => {
  const target = parseTargetLine("https://www.facebook.com/minh.tran");
  const scan = {
    postUrl: "https://www.facebook.com/page/posts/1",
    reactions: [
      { actor: { username: "minh.tran", name: "Minh" }, reactionType: "LOVE", source: "graphql" },
      { actor: { username: "minh.tran", name: "Minh" }, reactionType: "LIKE", source: "dom" }
    ],
    comments: [],
    shares: []
  };
  const dossier = buildTargetDossier(target, scan);
  assert.deepEqual(dossier.reactionTypes, ["LOVE"]);
});

test("extractProfileIdentityFromHtml không rò rỉ USER_ID người xem sang username khác", () => {
  const html = `
    <title>Bùi Khánh Linh | Facebook</title>
    <script>{"CurrentUserInitialData":{"USER_ID":"999999999"}}</script>
    <script>{"userID":"999999999","userVanity":"taoo.ditcondimemay"}</script>
  `;
  const other = extractProfileIdentityFromHtml(html, "bui.khanh.linh.804501");
  assert.equal(other.fbId, null);

  const self = extractProfileIdentityFromHtml(html, "taoo.ditcondimemay");
  assert.equal(self.fbId, "999999999");
});

test("extractReactorsPageInfo đọc đúng hasNextPage và endCursor", () => {
  const payload = {
    data: {
      node: {
        reactors: {
          edges: [],
          page_info: { has_next_page: true, end_cursor: "AQHR_CURSOR_2" }
        }
      }
    }
  };
  const info = extractReactorsPageInfo(payload);
  assert.deepEqual(info, { hasNextPage: true, endCursor: "AQHR_CURSOR_2" });
});