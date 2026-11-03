/* ============================================================
   気になり帳（kininari.html）の v45 の検証
     1) Recall（Chrome拡張）との分類合わせ（protocol v1）
        - クリップ（#knadd=）の src:"recall" → memo.rc、f「未分類」→ フォルダなし
        - window.__kininariRecall.apply(payload) の動き（移す・作る・空の「未分類」を片付ける・
          同じ内容は二度書かない・壊れた内容・index.html の iframe の中・別の端末への同期・同時に呼ばれたとき）
     2) ノート表示を OneNote の形に（一番上のフォルダ＝ノートブック、中のフォルダ＝セクション）と、
        ノート表示を標準に（一度だけの切り替え）

     node .tools/test-recall-sync.mjs                 … 全部
     node .tools/test-recall-sync.mjs clip apply      … 名前に含む節だけ
     KN_ROOT=/path/to/dir node .tools/test-recall-sync.mjs   … 別の場所の一式を検証する
                                                       （直す前の版で「落ちる」ことを確かめる用）

   画面はふだん 1400×900（スマホの節だけ 390×844）。2台の端末は fake-drive.mjs を共有し、
   Googleログインは gis-stub.js に差し替える（.tools/lib/harness.mjs）。
   ============================================================ */
import path from "node:path";
import { ROOT, startServer, launch, newDevice, collectErrors, makeChecker, sleep, waitFor } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const SERVE_ROOT = process.env.KN_ROOT ? path.resolve(process.env.KN_ROOT) : ROOT;
const ONLY = process.argv.slice(2);
const { ok, done } = makeChecker("test-recall-sync");
const DATA_KEY = "kininari:data:v2";
const TOMB_KEY = "kininari:deleted:v1";
const FILE_NAME = "kininari-data.json";
const GD_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.events";
const WIDE = { width: 1400, height: 900 };
const NARROW = { width: 390, height: 844 };
const NB_COLORS = ["#C0463C", "#3E6CA3", "#57845A", "#C98A1B", "#8E5BA6", "#3E8E8A", "#B5654A", "#6F7F3F"];

const server = await startServer(SERVE_ROOT);
const BASE = server.url;
const browser = await launch();
console.log("検証する kininari.html: " + path.join(SERVE_ROOT, "kininari.html"));

/* ── 共通の部品 ─────────────────────────────────────────── */
const scopedTokenLS = (scope = GD_SCOPE) => ({ "shared:gd:token": JSON.stringify({ token: "fake." + Buffer.from(scope).toString("base64"), exp: Date.now() + 3600 * 1000, scope }) });
const linkedLS = () => ({ ...scopedTokenLS(), "kininari:gd:linked": "1", "kininari:gd:auto": "1" });
let clock = Date.now() - 3600 * 1000;
function memo(id, title, extra = {}) {
  clock += 1000;
  return { id, title, body: "", category: "メモ", tags: [], links: [], notebookId: null, date: null, time: null,
    remind: null, srs: null, attachments: [], done: false, pinned: false, createdAt: clock, updatedAt: clock, ...extra };
}
function folder(id, name, extra = {}) {
  return { id, name, color: "#3E6CA3", parentId: null, pinned: false, createdAt: 1000, updatedAt: 1000, ...extra };
}
async function device({ drive = null, viewport = WIDE } = {}) {
  const ctx = await newDevice(browser, { drive, contextOptions: { viewport } });
  await ctx.route(/\/__blank\.html$/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
  return ctx;
}
async function preset(ctx, values) {
  const p = await ctx.newPage();
  await p.goto(BASE + "__blank.html");
  await p.evaluate((o) => { for (const k in o) localStorage.setItem(k, typeof o[k] === "string" ? o[k] : JSON.stringify(o[k])); }, values);
  await p.close();
}
async function openApp(ctx, suffix = "") {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  page.on("dialog", (dlg) => dlg.accept().catch(() => {}));
  await page.goto(BASE + "kininari.html" + suffix);
  await page.waitForSelector(".capture-input, .nv", { timeout: 15000 });
  return { page, errors };
}
const lsData = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), DATA_KEY);
const lsRaw = (page, k = DATA_KEY) => page.evaluate((key) => localStorage.getItem(key), k);
const memoOf = async (page, id) => ((await lsData(page)) || { memos: [] }).memos.find((m) => m.id === id) || null;
const folderNamed = (data, name) => ((data || {}).notebooks || []).filter((f) => f.name === name);
/** Recall の差し込み（executeScript の func）と同じ形で呼ぶ。関数が無ければ null */
const recallApply = (frame, payload) => frame.evaluate((p) => {
  const r = window.__kininariRecall;
  return r && typeof r.apply === "function" ? Promise.resolve(r.apply(p)) : null;
}, payload);
const waitRecall = (frame, timeout = 10000) => frame.waitForFunction(() => !!(window.__kininariRecall && window.__kininariRecall.v === 1), null, { timeout }).then(() => true, () => false);
/** 1件のクリップを受け取る（新しいタブで #knadd= を開き、結果の印を待つ） */
async function clipIn(ctx, clip) {
  const p = await ctx.newPage();
  const errors = collectErrors(p);
  await p.goto(BASE + "kininari.html#knadd=" + encodeURIComponent(JSON.stringify(clip)));
  const st = await p.waitForFunction(() => window.__kininariClipStatus || null, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => null);
  await p.close();
  return { st, errors };
}

async function section(name, fn) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
  console.log("\n■ " + name);
  try { await fn(); }
  catch (e) { ok(false, name + " が途中で止まった", String(e && e.stack || e).split("\n").slice(0, 4).join(" | ")); }
}

/* 利用者の今の状態: Recall から送ったメモが「未分類」フォルダに入っている（rc は無い）。
   Recall では 学習 / 遊戯王関係 / 未分類 に分けてある */
const U = (n) => "https://news.example/a/" + n;
const realFolders = () => [
  folder("fu", "未分類", { color: "#C98A1B", createdAt: 1000 }),
  folder("fl", "学習", { color: "#3E6CA3", createdAt: 2000 }),
  folder("fe", "英語", { color: "#57845A", parentId: "fl", createdAt: 3000 }),
  folder("fo", "その他", { color: "#8E5BA6", createdAt: 4000 })
];
const realMemos = () => [
  memo("m1", "学習の記事", { notebookId: "fu", links: [U(1)] }),
  memo("m2", "カードの記事", { notebookId: "fu", links: [U(2)] }),
  memo("m3", "まだ分けていない記事", { notebookId: "fu", links: [U(3)] }),
  memo("m4", "フォルダなしの記事", { notebookId: null, links: [U(4)] }),
  memo("m5", "自分で分けた記事", { notebookId: "fo", links: [U(5)] }),
  memo("m6", "Recall に無い記事", { notebookId: "fu", links: ["https://other.example/x"] }),
  // URL の書き方の違い（# 以降・末尾の /）は、クリップの重複判定と同じく同じページとみなす
  memo("m7", "書き方の違うURL", { notebookId: "fu", links: [U(7) + "/#frag"] }),
  memo("m8", "リンクの無いメモ", { notebookId: "fu" })
];
const realPayload = () => ({
  v: 1,
  cats: [{ name: "学習", color: "#123456" }, { name: "遊戯王関係", color: "#abcdef" }, { name: "  新しい分類 ", color: "red" }, { name: "未分類", color: "#000000" }],
  items: [
    { u: U(1), f: "学習" },
    { u: U(2), f: "遊戯王関係" },
    { u: U(3), f: "" },
    { u: U(4), f: "学習" },
    { u: U(5), f: "遊戯王関係" },
    { u: U(7), f: "遊戯王関係" },
    { u: "https://not-in-kininari.example/", f: "学習" }
  ]
});

/* ── 1. クリップ ──────────────────────────────────────────── */
await section("1 clip: Recall からのクリップは rc を覚える・「未分類」はフォルダなし", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: [], notebooks: [folder("fl", "学習")] } });
  const { page, errors } = await openApp(ctx);
  const c1 = await clipIn(ctx, { t: "Recallの学習", u: "https://clip.example/1", n: "", c: "調べる", f: "学習", src: "recall" });
  const c2 = await clipIn(ctx, { t: "Recallの未分類", u: "https://clip.example/2", n: "", f: "", src: "recall" });
  const c3 = await clipIn(ctx, { t: "古いRecallの未分類", u: "https://clip.example/3", n: "", f: " 未分類 ", src: "recall" });
  const c4 = await clipIn(ctx, { t: "ほかの拡張の未分類", u: "https://clip.example/4", n: "", f: "未分類" });
  const c5 = await clipIn(ctx, { t: "ほかの拡張", u: "https://clip.example/5", n: "", f: "学習" });
  const c6 = await clipIn(ctx, { t: "Recallの新しい分類", u: "https://clip.example/6", n: "", f: " 遊戯王関係 ", src: "recall" });
  ok([c1, c2, c3, c4, c5, c6].every((c) => c.st === "saved"), "（前提）クリップをすべて受け取る", [c1, c2, c3, c4, c5, c6].map((c) => c.st));
  const d = await lsData(page);
  const by = (t) => d.memos.find((m) => m.title === t) || {};
  ok(by("Recallの学習").rc === "学習" && by("Recallの学習").notebookId === "fl", "src:\"recall\" のクリップは rc に分類名を覚え、そのフォルダへ入る", by("Recallの学習"));
  ok(by("Recallの未分類").rc === "" && by("Recallの未分類").notebookId === null, "Recall の未分類（f:\"\"）は rc \"\"・フォルダなし", by("Recallの未分類"));
  ok(by("古いRecallの未分類").rc === "" && by("古いRecallの未分類").notebookId === null, "f「未分類」（古い Recall）は rc \"\"・フォルダなし", by("古いRecallの未分類"));
  ok(by("ほかの拡張の未分類").notebookId === null && !("rc" in by("ほかの拡張の未分類")), "ほかの拡張の f「未分類」もフォルダなし（rc は付けない）", by("ほかの拡張の未分類"));
  ok(folderNamed(d, "未分類").length === 0, "「未分類」という名前のフォルダは作らない", d.notebooks.map((f) => f.name));
  ok(by("ほかの拡張").notebookId === "fl" && !("rc" in by("ほかの拡張")), "src の無いクリップは今までどおり（rc は付けない）", by("ほかの拡張"));
  ok(by("Recallの新しい分類").rc === "遊戯王関係" && folderNamed(d, "遊戯王関係").length === 1 && by("Recallの新しい分類").notebookId === folderNamed(d, "遊戯王関係")[0].id,
     "無いフォルダは作り、rc は前後の空白を除いた名前", { m: by("Recallの新しい分類"), f: d.notebooks.map((f) => f.name) });
  // 読み込み直し（normalizeMemo）でも rc は残る。文字列でない rc は「無い」として捨て、長すぎる rc は切り詰める
  await page.evaluate((k) => {
    const v = JSON.parse(localStorage.getItem(k));
    v.memos.push({ id: "bad1", title: "変な rc", rc: 5, links: [], createdAt: 1, updatedAt: 1 });
    v.memos.push({ id: "bad2", title: "長い rc", rc: "x".repeat(300), links: [], createdAt: 1, updatedAt: 1 });
    localStorage.setItem(k, JSON.stringify(v));
  }, DATA_KEY);
  await page.reload();
  await page.waitForSelector(".capture-input, .nv");
  const d2 = await lsData(page);
  const b1 = d2.memos.find((m) => m.id === "bad1"), b2 = d2.memos.find((m) => m.id === "bad2");
  ok(d2.memos.find((m) => m.title === "Recallの学習").rc === "学習" && d2.memos.find((m) => m.title === "Recallの未分類").rc === "", "読み込み直しても rc は残る（\"\" も）");
  ok(b1 && !("rc" in b1), "文字列でない rc は捨てる", b1);
  ok(b2 && b2.rc.length === 100, "rc は100文字まで", b2 && b2.rc.length);
  ok(errors.length === 0 && [c1, c2, c3, c4, c5, c6].every((c) => c.errors.length === 0), "エラーが無い", errors);
  await ctx.close();
});

/* ── 2. 分類合わせ（利用者の今の状態）──────────────────────────── */
await section("2 apply: 「未分類」フォルダのメモを Recall の分類へ移す・空の「未分類」を片付ける", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: realMemos(), notebooks: realFolders() } });
  const { page, errors } = await openApp(ctx);
  ok(await waitRecall(page), "読み込んだあと window.__kininariRecall（v:1）がある");
  ok(await page.evaluate(() => typeof window.__kininariRecall.apply === "function" && Object.isFrozen(window.__kininariRecall)), "apply があり、書き換えられない");
  const before = await lsData(page);
  const t0 = Date.now();
  const r = await recallApply(page, realPayload());
  ok(r && r.ok === true && r.v === 1, "結果は ok:true・v:1", r);
  const d = await lsData(page);
  const fid = (n) => (folderNamed(d, n)[0] || {}).id;
  const m = (id) => d.memos.find((x) => x.id === id) || {};
  ok(m("m1").notebookId === "fl" && m("m1").rc === "学習", "「未分類」フォルダのメモ → 学習（今あるフォルダ）", m("m1"));
  ok(fid("遊戯王関係") && m("m2").notebookId === fid("遊戯王関係") && m("m2").rc === "遊戯王関係", "→ 遊戯王関係（無いので作る）", m("m2"));
  ok(m("m3").notebookId === null && m("m3").rc === "", "Recall で未分類 → フォルダなし（rc \"\"）", m("m3"));
  ok(m("m4").notebookId === "fl" && m("m4").rc === "学習", "フォルダなしのメモ（rc 無し）→ 学習", m("m4"));
  ok(m("m5").notebookId === "fo" && m("m5").rc === "遊戯王関係", "自分で別のフォルダに分けたメモ（rc 無し）はそのまま・rc だけ覚える", m("m5"));
  ok(m("m7").notebookId === fid("遊戯王関係"), "URL の # 以降・末尾の / の違いは同じページとみなす", m("m7"));
  const b6 = before.memos.find((x) => x.id === "m6"), b8 = before.memos.find((x) => x.id === "m8");
  ok(JSON.stringify(m("m6")) === JSON.stringify(b6) && JSON.stringify(m("m8")) === JSON.stringify(b8), "Recall に無いページ・リンクの無いメモは触らない（「未分類」に残る）");
  ok(folderNamed(d, "未分類").length === 1, "メモの残っている「未分類」フォルダは消さない");
  ok(r.moved === 5, "moved は実際にフォルダが替わった件数（m1 m2 m3 m4 m7）", r.moved);
  ok(JSON.stringify(r.created) === JSON.stringify(["遊戯王関係", "新しい分類"]), "created は作ったフォルダ（分類の順。「未分類」は作らない）", r.created);
  ok(folderNamed(d, "新しい分類").length === 1 && NB_COLORS.includes(folderNamed(d, "新しい分類")[0].color) && folderNamed(d, "遊戯王関係")[0].color === "#abcdef",
     "色は Recall の色（#rrggbb のときだけ）、それ以外はアプリの色", d.notebooks.map((f) => f.name + f.color));
  ok(folderNamed(d, "新しい分類")[0].parentId === null && folderNamed(d, "遊戯王関係")[0].parentId === null, "作るフォルダは一番上（ノートブック）");
  ok(folderNamed(d, "学習").length === 1 && d.notebooks.find((f) => f.id === "fl").color === "#3E6CA3", "今あるフォルダは作り直さない・色も変えない");
  const moved = ["m1", "m2", "m3", "m4", "m5", "m7"].every((id) => m(id).updatedAt >= t0);
  ok(moved, "変えたメモには updatedAt が打たれる（同期で他端末に勝つ）", ["m1", "m2", "m3", "m4", "m5", "m7"].map((id) => m(id).updatedAt - t0));
  ok(JSON.stringify(r.removed) === "[]", "removed は空（まだメモがある）", r.removed);
  // m6・m8 を自分で移すと「未分類」が空になる → 次の合わせで片付く
  await page.evaluate((k) => {
    const v = JSON.parse(localStorage.getItem(k));
    v.memos.forEach((x) => { if (x.id === "m6" || x.id === "m8") x.notebookId = "fo"; });
    localStorage.setItem(k, JSON.stringify(v));
  }, DATA_KEY);
  await page.reload();
  await waitRecall(page);
  const r2 = await recallApply(page, realPayload());
  const d2 = await lsData(page);
  ok(r2.ok && JSON.stringify(r2.removed) === JSON.stringify(["未分類"]) && folderNamed(d2, "未分類").length === 0, "空になった「未分類」フォルダは消す", { removed: r2.removed, f: d2.notebooks.map((f) => f.name) });
  const tombs = JSON.parse((await lsRaw(page, TOMB_KEY)) || "[]");
  ok(tombs.some((t) => t.id === "fu"), "消したフォルダの墓標を残す（他端末から戻ってこない）", tombs);
  const names = (r2.folders || []).map((f) => f.name);
  ok(!names.includes("未分類") && ["学習", "英語", "その他", "遊戯王関係", "新しい分類"].every((n) => names.includes(n)), "folders は「未分類」を除くすべてのフォルダ", r2.folders);
  const en = (r2.folders || []).find((f) => f.name === "英語"), gk = (r2.folders || []).find((f) => f.name === "学習");
  ok(en && en.parent === "学習" && gk && gk.parent === null && gk.color === "#3E6CA3", "folders の各項目は { name, color, parent（親の名前 / null）}", { en, gk });
  ok((r2.folders || []).every((f) => Object.keys(f).sort().join() === "color,name,parent" && (f.color === "" || /^#[0-9a-f]{6}$/i.test(f.color))), "形は name / color / parent だけ（color は #rrggbb か \"\"）", r2.folders);
  // 画面にも出る（ノート表示の左）。トーストで知らせる
  await page.waitForSelector('.ns-row:has(.nm:text-is("遊戯王関係"))', { timeout: 5000 }).catch(() => {});
  ok(await page.$('.ns-row:has(.nm:text-is("遊戯王関係"))') && !(await page.$('.ns-row:has(.nm:text-is("未分類"))')), "左の一覧に作ったフォルダが出て、「未分類」は消える");
  ok(/Recall の分類に合わせました/.test(await page.textContent(".toast").catch(() => "")), "合わせたことをトーストで知らせる");
  // 同じ内容をもう一度 → 何も変えない（保存もしない）
  const raw1 = await lsRaw(page);
  const r3 = await recallApply(page, realPayload());
  ok(r3.ok && r3.moved === 0 && r3.created.length === 0 && r3.removed.length === 0, "同じ内容をもう一度 → moved 0・created []", r3);
  ok((await lsRaw(page)) === raw1, "同じ内容では保存し直さない（updatedAt も変わらない）");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 3. 分類の変更に付いていく ─────────────────────────────── */
await section("3 follow: Recall で分類を替えたときだけ移す（気になり帳で移したものは、それまでそのまま）", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: realMemos(), notebooks: realFolders() } });
  const { page, errors } = await openApp(ctx);
  await waitRecall(page);
  await recallApply(page, realPayload());
  // 気になり帳で m1（rc 学習）を「その他」へ移す → Recall が同じ 学習 のままなら動かさない
  await page.evaluate((k) => {
    const v = JSON.parse(localStorage.getItem(k));
    v.memos.forEach((x) => { if (x.id === "m1") { x.notebookId = "fo"; x.updatedAt = Date.now(); } });
    localStorage.setItem(k, JSON.stringify(v));
  }, DATA_KEY);
  await page.reload();
  await waitRecall(page);
  const r1 = await recallApply(page, realPayload());
  ok(r1.moved === 0 && (await memoOf(page, "m1")).notebookId === "fo", "rc と Recall の分類が同じなら、気になり帳で移した場所のまま", { r1, m1: await memoOf(page, "m1") });
  // Recall で m5（自分で分けたもの・rc 遊戯王関係）を 学習 へ、m1 を未分類へ替える
  const p2 = realPayload();
  p2.items.find((i) => i.u === U(5)).f = "学習";
  p2.items.find((i) => i.u === U(1)).f = "";
  const r2 = await recallApply(page, p2);
  const m5 = await memoOf(page, "m5"), m1 = await memoOf(page, "m1");
  ok(m5.notebookId === "fl" && m5.rc === "学習", "Recall で分類を替えると、自分で分けたメモも新しい分類へ移る", m5);
  ok(m1.notebookId === null && m1.rc === "", "Recall で未分類に替えると、フォルダなしへ", m1);
  ok(r2.moved === 2, "moved 2", r2.moved);
  // 大文字小文字・前後の空白の違いは同じフォルダ（増やさない・動かさない）
  const p3 = JSON.parse(JSON.stringify(p2));
  p3.items.find((i) => i.u === U(2)).f = "  遊戯王関係 ";
  p3.cats.push({ name: "がくしゅう", color: "" });
  await page.evaluate((k) => {
    const v = JSON.parse(localStorage.getItem(k));
    v.notebooks.push({ id: "fab", name: "Abc", color: "#3E6CA3", parentId: "fl", pinned: false, createdAt: 9000, updatedAt: 9000 });
    localStorage.setItem(k, JSON.stringify(v));
  }, DATA_KEY);
  await page.reload();
  await waitRecall(page);
  p3.items.push({ u: U(9), f: "abc" });
  await page.evaluate(([k, u]) => {
    const v = JSON.parse(localStorage.getItem(k));
    v.memos.push({ id: "m9", title: "入れ子の中へ", links: [u], notebookId: null, createdAt: 1, updatedAt: 1 });
    localStorage.setItem(k, JSON.stringify(v));
  }, [DATA_KEY, U(9)]);
  await page.reload();
  await waitRecall(page);
  const r3 = await recallApply(page, p3);
  const d3 = await lsData(page);
  ok(r3.ok && folderNamed(d3, "遊戯王関係").length === 1 && (await memoOf(page, "m2")).rc === "遊戯王関係", "前後の空白の違いは同じ分類（フォルダを増やさない）", r3);
  ok((await memoOf(page, "m9")).notebookId === "fab" && !d3.notebooks.some((f) => f.name === "abc"), "名前の照合は大文字小文字を区別せず、入れ子の中のフォルダも探す", await memoOf(page, "m9"));
  ok(JSON.stringify(r3.created) === JSON.stringify(["がくしゅう"]), "Recall にだけある分類はフォルダとして足す", r3.created);
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 4. 壊れた内容 ───────────────────────────────────────── */
await section("4 bad: 形の合わない内容は ok:false か、その項目だけ飛ばす（落ちない）", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: realMemos(), notebooks: realFolders() } });
  const { page, errors } = await openApp(ctx);
  await waitRecall(page);
  const raw0 = await lsRaw(page);
  const bad = await page.evaluate(async () => {
    const out = [];
    for (const p of [null, undefined, "x", 5, [], { v: 1 }, { cats: "x", items: 5 }]) {
      try { out.push(await window.__kininariRecall.apply(p)); } catch (e) { out.push({ threw: String(e) }); }
    }
    return out;
  });
  ok(bad.every((r) => r && r.ok === false && typeof r.error === "string" && r.error), "オブジェクトでない・配列が無い内容は { ok:false, error }", bad);
  const r = await recallApply(page, {
    v: 1,
    cats: [null, 5, "学習", { name: 7 }, { name: "" }, { name: "   " }, { name: "未分類" }, { name: { x: 1 } }, { name: "色が変", color: 12 }],
    items: [null, 5, { u: 5, f: "x" }, { u: "javascript:alert(1)", f: "学習" }, { u: U(1), f: 9 }, { u: U(2) }, { u: U(3), f: null }, { u: "", f: "学習" }, [U(4), "学習"]]
  });
  const d = await lsData(page);
  ok(r && r.ok === true && r.moved === 0 && JSON.stringify(r.created) === JSON.stringify(["色が変"]), "形の合わない項目だけ飛ばす（使えるものは使う）", r);
  ok(folderNamed(d, "色が変").length === 1 && NB_COLORS.includes(folderNamed(d, "色が変")[0].color), "色が文字列でなければアプリの色");
  const rest = JSON.parse(raw0);
  ok(rest.memos.every((m0) => JSON.stringify(d.memos.find((x) => x.id === m0.id)) === JSON.stringify(m0)), "メモは1件も変わらない");
  ok(errors.length === 0, "エラーが無い（例外で落ちない）", errors);
  await ctx.close();
});

/* ── 5. 書きかけのページを巻き戻さない ──────────────────────────── */
await section("5 live: ノート表示の自動保存（書きかけ）と重なっても、移した場所が残る", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: realMemos(), notebooks: realFolders() }, "kininari:note:view": "\"note\"", "kininari:note:sel": { f: "all", p: "m1" } });
  const { page, errors } = await openApp(ctx);
  await waitRecall(page);
  await page.waitForFunction(() => { const i = document.querySelector(".np-title"); return i && i.value === "学習の記事"; });
  await page.click(".np-title");
  await page.keyboard.press("End");
  await page.keyboard.type("（追記）");   // 題名は 0.7 秒後に保存（まだ保存していない）
  const r = await recallApply(page, realPayload());
  ok(r.ok && (await memoOf(page, "m1")).notebookId === "fl", "（前提）書きかけのページを移す");
  const m1 = await waitFor(async () => { const m = await memoOf(page, "m1"); return m && /（追記）/.test(m.title) ? m : null; }, { timeout: 5000, label: "題名の保存" }).catch(() => null);
  ok(m1 && m1.notebookId === "fl" && m1.rc === "学習", "あとから題名が保存されても、移した場所と rc は残る", m1);
  await page.waitForFunction(() => (document.querySelector(".np-path") || {}).textContent === "学習", null, { timeout: 3000 }).catch(() => {});
  ok((await page.textContent(".np-path").catch(() => "")) === "学習", "開いているページの場所の表示も、移した先になる");
  // 画面の state から保存する操作（＋ 新しいノートブック）でも巻き戻らない
  await page.click(".ns-add");
  await page.fill(".ns-form input", "あとで作る");
  await page.press(".ns-form input", "Enter");
  await sleep(300);
  const d = await lsData(page);
  ok(d.memos.find((x) => x.id === "m2").notebookId === (folderNamed(d, "遊戯王関係")[0] || {}).id && folderNamed(d, "あとで作る").length === 1, "そのあとフォルダを作っても、合わせた結果はそのまま");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 6. 同時に呼ばれたとき ───────────────────────────────────── */
await section("6 serial: 同時に呼ばれても1回ずつ（フォルダを二重に作らない・あとの呼び出しが前の結果を土台にする）", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: realMemos(), notebooks: realFolders() } });
  const { page, errors } = await openApp(ctx);
  await waitRecall(page);
  const p1 = realPayload();
  const p2 = realPayload();
  p2.items.find((i) => i.u === U(1)).f = "遊戯王関係";
  const rs = await page.evaluate(([a, b]) => Promise.all([window.__kininariRecall.apply(a), window.__kininariRecall.apply(a), window.__kininariRecall.apply(b)]), [p1, p2]);
  const d = await lsData(page);
  ok(rs.every((r) => r.ok), "3つとも ok", rs);
  ok(rs[0].moved === 5 && rs[1].moved === 0 && rs[1].created.length === 0, "同じ内容の2回目は、1回目の結果を土台にして何もしない", rs.map((r) => [r.moved, r.created]));
  ok(rs[2].moved === 1 && (await memoOf(page, "m1")).notebookId === (folderNamed(d, "遊戯王関係")[0] || {}).id && (await memoOf(page, "m1")).rc === "遊戯王関係", "最後の呼び出し（分類の変更）が最後に効く", rs[2]);
  ok(folderNamed(d, "遊戯王関係").length === 1 && folderNamed(d, "新しい分類").length === 1, "フォルダを二重に作らない", d.notebooks.map((f) => f.name));
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 7. index.html の中（iframe）──────────────────────────────── */
await section("7 iframe: index.html の中の気になり帳でも呼べる（差し込みは全部のフレームに）", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: realMemos(), notebooks: realFolders() } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.goto(BASE + "index.html");
  await page.click('.apptab[data-app="kininari"]');
  const kf = await waitFor(() => page.frames().find((f) => /kininari\.html/.test(f.url())) || null, { label: "気になり帳の iframe", timeout: 10000 }).catch(() => null);
  ok(!!kf, "（前提）気になり帳の iframe が開く");
  ok(kf && await waitRecall(kf, 15000), "iframe の中の気になり帳に __kininariRecall がある");
  // Recall と同じく、すべてのフレームで「あれば呼ぶ」
  const results = [];
  for (const f of page.frames()) results.push(await recallApply(f, realPayload()).catch(() => null));
  const hits = results.filter(Boolean);
  ok(hits.length === 1 && hits[0].ok && hits[0].moved === 5, "呼べるのは気になり帳のフレームだけで、結果が返る", results);
  const d = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), DATA_KEY);
  ok(d.memos.find((m) => m.id === "m1").notebookId === "fl" && folderNamed(d, "遊戯王関係").length === 1, "iframe の中でも保存される");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 8. 別の端末へ（Drive 経由）─────────────────────────────── */
await section("8 sync: 合わせた結果が Drive に載り、別の端末にも届く（「未分類」の削除も）", async () => {
  const drive = createFakeDrive();
  drive.put(FILE_NAME, { app: "kininari", memos: realMemos(), notebooks: realFolders(), files: [], deleted: [] });
  const ctxA = await device({ drive });
  await preset(ctxA, linkedLS());
  const { page: a, errors: eA } = await openApp(ctxA);
  await waitFor(async () => ((await lsData(a)) || { memos: [] }).memos.some((m) => m.id === "m1") && (await lsRaw(a, "kininari:gd:sync")), { label: "端末Aの最初の同期", timeout: 15000 });
  const ctxB = await device({ drive });
  await preset(ctxB, linkedLS());
  const { page: b, errors: eB } = await openApp(ctxB);
  await waitFor(async () => folderNamed(await lsData(b), "未分類").length === 1 && (await lsRaw(b, "kininari:gd:sync")), { label: "端末Bの最初の同期", timeout: 15000 });
  // m6・m8 を先に「その他」へ（「未分類」を空にして、削除も届くか確かめる）
  const p = realPayload();
  await waitRecall(a);
  await a.evaluate((k) => {
    const v = JSON.parse(localStorage.getItem(k));
    v.memos.forEach((x) => { if (x.id === "m6" || x.id === "m8") { x.notebookId = "fo"; x.updatedAt = Date.now(); } });
    localStorage.setItem(k, JSON.stringify(v));
  }, DATA_KEY);
  await a.reload();
  await waitRecall(a);
  const r = await recallApply(a, p);
  ok(r.ok && r.moved === 5 && r.removed.join() === "未分類", "（前提）端末Aで合わせる", r);
  const onDrive = await waitFor(() => {
    const f = drive.byName(FILE_NAME)[0];
    const j = f && drive.json(f.id);
    const m1 = j && j.memos.find((m) => m.id === "m1");
    return m1 && m1.notebookId === "fl" && m1.rc === "学習" && !j.notebooks.some((x) => x.name === "未分類") ? j : null;
  }, { label: "Drive への送信", timeout: 15000 }).catch(() => null);
  ok(!!onDrive, "結果を返すまでに Drive へ送る（裏で開いたタブをすぐ閉じても載る）");
  ok(onDrive && (onDrive.deleted || []).some((t) => t.id === "fu"), "「未分類」の墓標も Drive に載る", onDrive && onDrive.deleted);
  await b.reload();
  const got = await waitFor(async () => {
    const d = await lsData(b);
    const m2 = d.memos.find((m) => m.id === "m2");
    const yg = folderNamed(d, "遊戯王関係")[0];
    return yg && m2 && m2.notebookId === yg.id && folderNamed(d, "未分類").length === 0 ? d : null;
  }, { label: "端末Bの受け取り", timeout: 20000 }).catch(() => null);
  ok(!!got, "端末Bにも届く（移したメモ・作ったフォルダ・「未分類」の削除）", got && got.notebooks.map((f) => f.name));
  ok(got && got.memos.find((m) => m.id === "m5").rc === "遊戯王関係" && got.memos.find((m) => m.id === "m3").rc === "", "rc も届く（\"\" も）");
  await waitRecall(b);
  const rb = await recallApply(b, p);
  ok(rb.ok && rb.moved === 0 && rb.created.length === 0, "端末Bで同じ内容を合わせても、何も変わらない", rb);
  ok(eA.length === 0 && eB.length === 0, "エラーが無い", [eA, eB]);
  await Promise.all([ctxA.close(), ctxB.close()]);
});

/* ── 9. ノートブックとセクション ───────────────────────────────── */
const NB_FOLDERS = [
  folder("nb1", "学習", { color: "#3E6CA3", createdAt: 1000 }),
  folder("s1", "英語", { color: "#57845A", parentId: "nb1", createdAt: 1100 }),
  folder("s2", "数学", { color: "#C98A1B", parentId: "nb1", createdAt: 1200 }),
  folder("g1", "微分", { color: "#8E5BA6", parentId: "s2", createdAt: 1300 }),
  folder("nb2", "遊戯王関係", { color: "#C0463C", createdAt: 2000 })
];
const nbMemos = () => [
  memo("a", "英単語", { notebookId: "s1" }),
  memo("b", "ベクトル", { notebookId: "s2" }),
  memo("c", "極限", { notebookId: "g1" }),
  memo("d", "学習の目標", { notebookId: "nb1" }),
  memo("e", "デッキ案", { notebookId: "nb2" }),
  memo("f", "どこにも無い")
];
const rowSel = (name) => `.ns-row:has(.nm:text-is("${name}"))`;
const nbkSel = (name) => `.ns-nbk:has(.ns-row.ns-nb .nm:text-is("${name}"))`;
const pageItems = (page) => page.$$eval(".npg-item", (els) => els.map((e) => ({ t: e.querySelector(".npg-tt").textContent, f: (e.querySelector(".npg-f") || {}).textContent || "" })));
await section("9 notebook: 一番上のフォルダはノートブック・中はセクション（OneNote の形）", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: nbMemos(), notebooks: NB_FOLDERS }, "kininari:note:view": "\"note\"" });
  const { page, errors } = await openApp(ctx);
  await page.waitForSelector(".ns-row");
  const rows0 = await page.$$eval(".ns-body .ns-row .nm", (e) => e.map((x) => x.textContent));
  ok(rows0[0] === "すべて" && rows0[1] === "フォルダなし", "「すべて」「フォルダなし」はいちばん上のまま", rows0);
  const nbs = await page.$$eval(".ns-row.ns-nb", (e) => e.map((x) => ({ n: x.querySelector(".nm").textContent, book: !!x.querySelector(".ns-book"), tw: !!x.querySelector(".tw") })));
  ok(nbs.length === 2 && nbs.every((x) => x.book && x.tw) && nbs.map((x) => x.n).join() === "学習,遊戯王関係", "一番上のフォルダはノートブックの行（ノートの印と、たたむ矢印。中が無くても矢印）", nbs);
  const book = await page.$eval(rowSel("遊戯王関係") + " .ns-book", (e) => getComputedStyle(e).backgroundColor).catch(() => null);
  ok(book === "rgb(192, 70, 60)", "ノートの印はフォルダの色", book);
  ok(!(await page.$(rowSel("英語"))), "はじめはたたんである（選んでいないノートブック）");
  ok(((await page.textContent(".ns-head").catch(() => "")) || "").includes("ノートブック"), "見出しは「ノートブック」");
  ok(((await page.textContent(".ns-add").catch(() => "")) || "").trim() === "＋ 新しいノートブック", "「＋ 新しいノートブック」（以前の「＋ 新しいフォルダ」）");
  // 件数は中のセクションの分も足す
  const cnt = async (n) => page.$eval(rowSel(n) + " .cnt", (e) => e.textContent).catch(() => null);
  ok((await cnt("学習")) === "4" && (await cnt("遊戯王関係")) === "1", "ノートブックの件数は中のセクションの分も足す（学習: 自分1＋英語1＋数学1＋微分1）", [await cnt("学習"), await cnt("遊戯王関係")]);
  // 矢印でセクションを出す
  await page.click(rowSel("学習") + " .tw");
  await page.waitForSelector(rowSel("英語"));
  const secs = await page.$$eval(".ns-nbk.open .ns-row.ns-sec", (e) => e.map((x) => x.querySelector(".nm").textContent));
  ok(secs.join() === "英語,数学", "ノートブックの下にセクションが並ぶ", secs);
  const band = await page.$eval(rowSel("数学") + " .ns-tab", (e) => getComputedStyle(e).backgroundColor);
  ok(band === "rgb(201, 138, 27)", "セクションは左に色の帯（セクションの色）", band);
  const xNb = (await page.locator(rowSel("学習")).boundingBox()).x, xSec = (await page.locator(rowSel("数学")).boundingBox()).x;
  ok(xSec > xNb + 15, "セクションは字下げして出す", { xNb, xSec });
  ok((await cnt("数学")) === "2", "中にフォルダのあるセクションも、その分を足す", await cnt("数学"));
  ok(!(await page.$(rowSel("微分"))), "セクションの中のフォルダは、はじめはたたんである");
  await page.click(rowSel("数学") + " .tw");
  await page.waitForSelector(rowSel("微分") + ".ns-sub", { timeout: 3000 }).catch(() => {});
  const xSub = ((await page.locator(rowSel("微分")).boundingBox().catch(() => null)) || { x: 0 }).x;
  ok(xSub > xSec + 8, "さらに中のフォルダは、セクションの下にもう一段下げて出す", { xSec, xSub });
  // ノートブックを選ぶと、中のセクションのページもまとめて並び、各ページにセクション名が出る
  await page.click(rowSel("学習") + " .ns-name");
  const items = await pageItems(page);
  ok(items.length === 4 && ["英単語", "ベクトル", "極限", "学習の目標"].every((t) => items.some((i) => i.t === t)), "ノートブックを選ぶと、中のセクション（とその中）のページもまとめて並ぶ", items);
  ok(items.find((i) => i.t === "極限").f === "微分" && items.find((i) => i.t === "英単語").f === "英語" && items.find((i) => i.t === "学習の目標").f === "学習", "各ページにセクション（フォルダ）の名前が出る", items);
  ok(String(items.length) === await cnt("学習"), "左の件数と並ぶページの数が同じ");
  await page.click(rowSel("英語") + " .ns-name");
  const items2 = await pageItems(page);
  ok(items2.length === 1 && items2[0].t === "英単語", "中の無いセクションは、そのページだけ", items2);
  await page.click(rowSel("数学") + " .ns-name");
  ok((await pageItems(page)).map((i) => i.t).sort().join() === ["ベクトル", "極限"].sort().join(), "中にフォルダのあるセクションも、中のページをまとめて並べる");
  // ノートブックを選ぶと開く
  ok(!(await page.$(nbkSel("遊戯王関係") + ".open")), "（前提）遊戯王関係はたたんである");
  await page.click(rowSel("遊戯王関係") + " .ns-name");
  await page.waitForSelector(nbkSel("遊戯王関係") + ".open .ns-addsec", { timeout: 3000 }).catch(() => {});
  ok(await page.$(nbkSel("遊戯王関係") + ".open .ns-addsec"), "ノートブックを選ぶと開き、「＋ セクション」が出る");
  // ＋ セクション
  await page.click(nbkSel("遊戯王関係") + " .ns-addsec");
  ok((await page.getAttribute(".ns-secform input", "placeholder")) === "セクション名", "「＋ セクション」で名前の欄が出る");
  await page.fill(".ns-secform input", "デッキ");
  await page.press(".ns-secform input", "Enter");
  await page.waitForSelector(rowSel("デッキ") + ".ns-sec.on", { timeout: 3000 }).catch(() => {});
  const d = await lsData(page);
  const deck = folderNamed(d, "デッキ")[0];
  ok(deck && deck.parentId === "nb2", "ノートブックの中にフォルダ（セクション）を作る", deck);
  ok(await page.$(rowSel("デッキ") + ".ns-sec.on"), "作ったセクションを開く");
  // 変換中の Enter では作らない・Escape でやめる
  await page.click(nbkSel("遊戯王関係") + " .ns-addsec");
  await page.fill(".ns-secform input", "かんじ");
  for (const how of ["composing", "229"]) {
    await page.$eval(".ns-secform input", (el, how) => {
      const init = { key: "Enter", code: "Enter", bubbles: true, cancelable: true };
      if (how === "composing") init.isComposing = true; else init.keyCode = 229;
      el.dispatchEvent(new KeyboardEvent("keydown", init));
    }, how);
  }
  await sleep(150);
  ok(!folderNamed(await lsData(page), "かんじ").length, "変換を確定する Enter ではセクションを作らない");
  await page.press(".ns-secform input", "Escape");
  ok(!(await page.$(".ns-secform")), "Escape でやめる");
  // ページの場所（ノートブック › セクション）。押すとフォルダへ移せる
  await page.click(rowSel("数学") + " .ns-name");
  await page.click('.npg-item:has(.npg-tt:text-is("極限"))');
  await page.waitForFunction(() => { const i = document.querySelector(".np-title"); return i && i.value === "極限"; });
  ok((await page.textContent(".np-path")) === "学習 › 数学 › 微分", "ページの上に場所（ノートブック › セクション › …）が出る", await page.textContent(".np-path"));
  await page.click(".np-path");
  await page.waitForSelector(".kn-dlg .fp-opt");
  await page.click('.kn-dlg .fp-opt:has-text("遊戯王関係")');
  const c = await waitFor(async () => { const m = await memoOf(page, "c"); return m && m.notebookId === "nb2" ? m : null; }, { timeout: 4000, label: "移動" }).catch(() => null);
  ok(!!c, "場所を押すと、別のフォルダへ移せる");
  await page.waitForFunction(() => (document.querySelector(".np-path") || {}).textContent === "遊戯王関係", null, { timeout: 3000 }).catch(() => {});
  ok((await page.textContent(".np-path")) === "遊戯王関係", "移すと場所の表示も替わる", await page.textContent(".np-path"));
  await page.click(rowSel("フォルダなし") + " .ns-name");
  await page.click('.npg-item:has(.npg-tt:text-is("どこにも無い"))');
  await page.waitForFunction(() => { const i = document.querySelector(".np-title"); return i && i.value === "どこにも無い"; });
  ok((await page.textContent(".np-path")) === "フォルダなし", "フォルダに入っていないページは「フォルダなし」");
  // ⋯ の操作（名前の変更）はセクションでもそのまま
  await page.click(rowSel("英語") + " .ns-more");
  await page.click('.modal .fa-btn:has-text("名前を変更")');
  await page.fill(".modal .fa-form input", "英会話");
  await page.press(".modal .fa-form input", "Enter");
  await page.waitForSelector(rowSel("英会話"), { timeout: 3000 }).catch(() => {});
  ok(await page.$(rowSel("英会話") + ".ns-sec"), "⋯ の「名前を変更」はセクションでも使える");
  await page.click(rowSel("英会話") + " .ns-more");
  await page.click('.modal .fa-btn:has-text("サブフォルダを追加")');
  await page.fill(".modal .fa-form input", "発音");
  await page.press(".modal .fa-form input", "Enter");
  await page.waitForSelector(rowSel("発音") + ".ns-sub", { timeout: 3000 }).catch(() => {});
  ok(await page.$(rowSel("発音") + ".ns-sub"), "⋯ の「サブフォルダを追加」はセクションの下に出る");
  // 読み込み直すと、選んでいるフォルダが見えるように上の階層が開く
  await page.click(rowSel("微分") + " .ns-name");
  await page.reload();
  await page.waitForSelector(rowSel("微分") + ".on", { timeout: 5000 }).catch(() => {});
  ok(await page.$(rowSel("微分") + ".on"), "読み込み直しても、選んでいたフォルダが見える（ノートブックとセクションを開く）");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 10. ノート表示を標準に ───────────────────────────────────── */
await section("10 default: ノート表示が標準・カード表示を覚えていた端末も一度だけノート表示へ", async () => {
  const ctx = await device();
  const { page, errors } = await openApp(ctx);
  ok(await page.$(".nv") && !(await page.$(".capture-input")), "初めての端末はノート表示");
  ok((await lsRaw(page, "kininari:note:viewV45")) === "1", "一度だけの切り替えの印を残す");
  await ctx.close();
  // 前の版で「カード表示」を覚えていた端末
  const ctx2 = await device();
  await preset(ctx2, { "kininari:note:view": "\"card\"" });
  const { page: p2, errors: e2 } = await openApp(ctx2);
  ok(await p2.$(".nv"), "カード表示を覚えていた端末も、一度だけノート表示にする");
  ok((await lsRaw(p2, "kininari:note:view")) === "\"note\"" && (await lsRaw(p2, "kininari:note:viewV45")) === "1", "ノート表示を覚え直し、印を残す");
  await p2.click('.vs-b:has-text("カード表示")');
  await p2.waitForSelector(".capture-input");
  await p2.reload();
  await p2.waitForSelector(".capture-input, .nv");
  ok(await p2.$(".capture-input") && !(await p2.$(".nv")), "そのあと自分でカード表示を選べば、読み込み直してもカード表示のまま");
  await p2.reload();
  await p2.waitForSelector(".capture-input, .nv");
  ok(await p2.$(".capture-input"), "何度読み込み直してもカード表示のまま");
  ok(errors.length === 0 && e2.length === 0, "エラーが無い", [errors, e2]);
  await ctx2.close();
});

/* ── 11. スマホ ──────────────────────────────────────────── */
await section("11 phone: スマホ（上に一覧・下にページ）でも同じノートブックとセクション", async () => {
  const ctx = await device({ viewport: NARROW });
  await preset(ctx, { [DATA_KEY]: { memos: nbMemos(), notebooks: NB_FOLDERS } });
  const { page, errors } = await openApp(ctx);
  await page.waitForSelector(".nv-split .nv-top .ns", { timeout: 5000 }).catch(() => {});
  ok(await page.$(".nv-split .nv-top .ns"), "スマホでもはじめからノート表示（上に一覧・下にページ）");
  ok((await page.$$(".nv-top .ns-row.ns-nb .ns-book")).length === 2, "上の左の列にノートブックの行（ノートの印）");
  await page.click(".nv-top " + rowSel("学習") + " .ns-name");
  await page.waitForSelector(".nv-top " + rowSel("数学") + ".ns-sec", { timeout: 3000 }).catch(() => {});
  ok(await page.$(".nv-top " + rowSel("数学") + ".ns-sec") && await page.$(".nv-top .ns-addsec"), "ノートブックを押すと、セクションと「＋ セクション」が出る");
  const items = await pageItems(page);
  ok(items.length === 4 && items.find((i) => i.t === "極限").f === "微分", "ノートブックのページは、中のセクションの分もまとめて並び、セクション名が出る", items);
  const fits = await page.evaluate(() => { const b = document.querySelector(".nv-top .ns-body"); return b.scrollWidth <= b.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; });
  ok(fits, "細い列でも横にはみ出さない");
  const xs = await page.evaluate(() => {
    const x = (n) => { const r = [...document.querySelectorAll(".nv-top .ns-row")].find((e) => e.querySelector(".nm").textContent === n); return r ? r.getBoundingClientRect().x : null; };
    return { nb: x("学習"), sec: x("数学") };
  });
  ok(xs.sec > xs.nb + 6, "セクションは字下げ（詰めた幅で）", xs);
  await page.click(".nv-top " + rowSel("数学") + " .ns-name");
  await page.click('.npg-item:has(.npg-tt:text-is("ベクトル"))');
  await page.waitForFunction(() => { const i = document.querySelector(".np-title"); return i && i.value === "ベクトル"; });
  ok((await page.textContent(".np-path")) === "学習 › 数学", "下のページにも場所（ノートブック › セクション）", await page.textContent(".np-path"));
  await page.click(".nhsplit-btn");
  const info = await page.textContent(".nhsplit-info").catch(() => "");
  ok(info === "学習 › 数学 › ベクトル", "たたんだときの帯も ノートブック › セクション › ページ", info);
  await page.click(".nhsplit-btn");
  await page.click(".nv-top " + nbkSel("学習") + " .ns-addsec");
  await page.fill(".nv-top .ns-secform input", "物理");
  await page.press(".nv-top .ns-secform input", "Enter");
  await sleep(300);
  const ph = folderNamed(await lsData(page), "物理")[0];
  ok(ph && ph.parentId === "nb1", "スマホでも「＋ セクション」で作れる", ph);
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

await browser.close();
await server.close();
done();
