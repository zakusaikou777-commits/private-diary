/* ============================================================
   気になり帳（kininari.html）: 自分で並べた順（優先順位の番号・v52）の確認
     node .tools/test-fix-kininari-order.mjs            … 全部
     node .tools/test-fix-kininari-order.mjs o2 o5      … 名前に含む節だけ
     KN_ROOT=/別の場所 node .tools/test-fix-kininari-order.mjs … その場所の版で試す（修正前との比べ用）

   o1 並べ方に「自分で並べた順（番号）」。選ぶと 1, 2, 3… の番号。まだ並べていなければ新しい順。並べ方は端末に覚える
   o2 番号を押して打ち込むと、その位置へ動く（全角の数字も）。開き直しても同じ並び
   o3 ⠿ をつかんで動かす（PC のカードは横並びなので左右、スマホは上下）
   o4 ⠿ に移って矢印キーで動かす（動かしたあとも同じカードの ⠿ に居る）
   o5 ピン留めは上にまとまったまま（ピンより上へは動かさず、知らせる）。新しく書いたメモはいちばん上
   o6 フォルダの中で並べ替えても、ほかのフォルダのメモとの前後は変えない
   o7 ノート表示のページ一覧にも番号。⠿ のドラッグ・Alt＋矢印で並べ替え（フォルダへ動かすドラッグは始めない）
   o8 並べた順はほかの端末にも同期する
   o9 ほかの並べ方・復習の一覧には番号を出さない
   ============================================================ */
import path from "node:path";
import { ROOT, startServer, launch, newDevice, collectErrors, makeChecker, sleep, waitFor } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const SERVE_ROOT = process.env.KN_ROOT ? path.resolve(process.env.KN_ROOT) : ROOT;
const ONLY = process.argv.slice(2);
const { ok, done } = makeChecker("test-fix-kininari-order");
const DATA_KEY = "kininari:data:v2";
const FILE_NAME = "kininari-data.json";
const GD_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.events";
const server = await startServer(SERVE_ROOT);
const BASE = server.url;
const browser = await launch();
const PC = { viewport: { width: 1400, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/* ── 道具 ─────────────────────────────────────────── */
const T0 = Date.now() - 24 * 3600 * 1000;
function memo(i, title, extra = {}) {
  const t = T0 + i * 60000;
  return { id: "m" + i, title, body: "", category: "メモ", tags: [], links: [], notebookId: null, date: null, time: null,
    remind: null, srs: null, attachments: [], done: false, pinned: false, createdAt: t, updatedAt: t, ...extra };
}
// 作った順: A(1) B(2) C(3) D(4) E(5)。新しい順に並べると E D C B A
const five = () => [memo(1, "A"), memo(2, "B"), memo(3, "C"), memo(4, "D"), memo(5, "E")];
async function device(contextOptions = PC, drive = null) {
  const ctx = await newDevice(browser, { drive, contextOptions });
  await ctx.route(/\/__blank\.html$/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
  return ctx;
}
async function preset(ctx, values) {
  const p = await ctx.newPage();
  await p.goto(BASE + "__blank.html");
  await p.evaluate((o) => { for (const k in o) localStorage.setItem(k, typeof o[k] === "string" ? o[k] : JSON.stringify(o[k])); }, values);
  await p.close();
}
const cardView = (data, extra = {}) => ({ [DATA_KEY]: data, "kininari:note:view": "\"card\"", "kininari:note:viewV45": "1", ...extra });
async function openApp(ctx, sel = ".capture-input") {
  const page = await ctx.newPage();
  page.errs = collectErrors(page);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  await page.goto(BASE + "kininari.html");
  await page.waitForSelector(sel, { timeout: 15000 });
  return page;
}
const SORT = 'select:has(option[value="created"])';
const cardTitles = (page) => page.$$eval('section.list .card .title', (els) => els.map((e) => e.textContent.trim()));
const cardNums = (page) => page.$$eval('section.list .card .ro-num', (els) => els.map((e) => e.textContent.trim()));
const cardSel = (title) => `section.list .card:has(.title:text-is("${title}"))`;
async function section(name, fn) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
  console.log("\n■ " + name);
  try { await fn(); } catch (e) { ok(false, name + " が途中で止まった", String(e && e.stack || e).split("\n").slice(0, 3).join(" | ")); }
}
/** ⠿ をつかんで、相手のカードの左右（横並び）か上下へ落とす */
async function dragGrip(page, fromSel, toSel, where) {
  const g = await page.locator(fromSel + " .ro-grip").first().boundingBox();
  const t = await page.locator(toSel).first().boundingBox();
  const tx = where === "left" ? t.x + t.width * 0.2 : where === "right" ? t.x + t.width * 0.8 : t.x + t.width / 2;
  const ty = where === "top" ? t.y + t.height * 0.2 : where === "bottom" ? t.y + t.height * 0.8 : t.y + t.height / 2;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 8, g.y + g.height / 2 + 8, { steps: 3 });
  await page.mouse.move(tx, ty, { steps: 12 });
  await page.mouse.up();
  await sleep(250);
}

/* ── o1 ─────────────────────────────────────────────── */
await section("o1 並べ方に「自分で並べた順（番号）」・番号・端末に覚える", async () => {
  const ctx = await device();
  await preset(ctx, cardView({ memos: five(), notebooks: [] }));
  let page = await openApp(ctx);
  ok((await page.locator('section.list .ro-num').count()) === 0, "ふだん（新しい順）は番号を出さない");
  await page.selectOption(SORT, "manual");
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["E", "D", "C", "B", "A"]), "まだ並べていなければ新しい順", await cardTitles(page));
  ok(JSON.stringify(await cardNums(page)) === JSON.stringify(["1", "2", "3", "4", "5"]), "1〜5 の番号が付く", await cardNums(page));
  ok((await page.locator(".ro-hint").count()) === 1, "並べ替え方の案内が出る");
  await page.close();
  page = await openApp(ctx);
  ok((await page.inputValue(SORT)) === "manual" && (await cardNums(page)).length === 5, "開き直しても「自分で並べた順」のまま（端末に覚える）");
  ok(page.errs.length === 0, "o1: エラーなし", page.errs);
  await ctx.close();
});

/* ── o2 ─────────────────────────────────────────────── */
await section("o2 番号を打ち込んで動かす", async () => {
  const ctx = await device();
  await preset(ctx, cardView({ memos: five(), notebooks: [] }, { "kininari:sort": "manual" }));
  let page = await openApp(ctx);
  await page.click(cardSel("A") + " .ro-num");
  await page.fill(".ro-num-in", "1");
  await page.press(".ro-num-in", "Enter");
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["A", "E", "D", "C", "B"]), "5番目の A に 1 を打つと、いちばん上へ", await cardTitles(page));
  ok((await page.locator(".kn-full").count()) === 0, "番号を押しても、カードは開かない");
  await page.click(cardSel("E") + " .ro-num");
  await page.fill(".ro-num-in", "４");   // 全角でも
  await page.locator(".ro-num-in").blur();
  await sleep(200);
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["A", "D", "C", "E", "B"]), "全角の「４」でも動く（欄から離れたら確定）", await cardTitles(page));
  await page.click(cardSel("B") + " .ro-num");
  await page.fill(".ro-num-in", "1");
  await page.press(".ro-num-in", "Escape");
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["A", "D", "C", "E", "B"]), "Esc ならやめる（動かさない）", await cardTitles(page));
  await page.close();
  page = await openApp(ctx);
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["A", "D", "C", "E", "B"]), "開き直しても同じ並び", await cardTitles(page));
  ok(page.errs.length === 0, "o2: エラーなし", page.errs);
  await ctx.close();
});

/* ── o3 ─────────────────────────────────────────────── */
await section("o3 ⠿ をつかんで動かす（PC は左右・スマホは上下）", async () => {
  {
    const ctx = await device(PC);
    await preset(ctx, cardView({ memos: five(), notebooks: [] }, { "kininari:sort": "manual" }));
    const page = await openApp(ctx);
    // E D C / B A の横並び。E を C の右へ
    await dragGrip(page, cardSel("E"), cardSel("C"), "right");
    ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["D", "C", "E", "B", "A"]), "PC: E を C の右へ落とすと、C の次に入る", await cardTitles(page));
    await dragGrip(page, cardSel("A"), cardSel("D"), "left");
    ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["A", "D", "C", "E", "B"]), "PC: A を D の左へ落とすと、いちばん上に入る", await cardTitles(page));
    ok((await page.locator(".ro-before, .ro-after, .ro-dragging").count()) === 0, "落としたあとに、ドラッグ中の印が残らない");
    ok((await page.locator(".kn-full").count()) === 0, "⠿ を押してもカードは開かない");
    ok(page.errs.length === 0, "o3 PC: エラーなし", page.errs);
    await ctx.close();
  }
  {
    const ctx = await device(PHONE);
    await preset(ctx, cardView({ memos: five(), notebooks: [] }, { "kininari:sort": "manual" }));
    const page = await openApp(ctx);
    await dragGrip(page, cardSel("E"), cardSel("D"), "bottom");
    ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["D", "E", "C", "B", "A"]), "スマホ: E を D の下半分へ落とすと、D の次に入る", await cardTitles(page));
    const ta = await page.$eval(cardSel("D") + " .ro-grip", (el) => getComputedStyle(el).touchAction);
    ok(ta === "none", "スマホ: ⠿ を指でつかんでも画面がスクロールしない（touch-action: none）", ta);
    ok(page.errs.length === 0, "o3 スマホ: エラーなし", page.errs);
    await ctx.close();
  }
});

/* ── o4 ─────────────────────────────────────────────── */
await section("o4 矢印キーで動かす", async () => {
  const ctx = await device();
  await preset(ctx, cardView({ memos: five(), notebooks: [] }, { "kininari:sort": "manual" }));
  const page = await openApp(ctx);
  await page.focus(cardSel("E") + " .ro-grip");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await sleep(150);
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["D", "C", "E", "B", "A"]), "→ と ↓ で2つ下へ", await cardTitles(page));
  const still = await page.evaluate(() => { const a = document.activeElement; const c = a && a.closest && a.closest(".card"); return a && a.classList.contains("ro-grip") && c ? c.querySelector(".title").textContent : null; });
  ok(still === "E", "動かしたあとも、同じカードの ⠿ に居る", still);
  await page.keyboard.press("ArrowUp");
  await sleep(150);
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["D", "E", "C", "B", "A"]), "↑ で1つ上へ", await cardTitles(page));
  ok(page.errs.length === 0, "o4: エラーなし", page.errs);
  await ctx.close();
});

/* ── o5 ─────────────────────────────────────────────── */
await section("o5 ピン留めは上・新しいメモはいちばん上", async () => {
  const ctx = await device();
  const m = five();
  m[0].pinned = true;   // A をピン留め
  await preset(ctx, cardView({ memos: m, notebooks: [] }, { "kininari:sort": "manual" }));
  const page = await openApp(ctx);
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["A", "E", "D", "C", "B"]), "ピン留めの A がいちばん上（番号 1）", await cardTitles(page));
  await page.click(cardSel("C") + " .ro-num");
  await page.fill(".ro-num-in", "1");
  await page.press(".ro-num-in", "Enter");
  await sleep(150);
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["A", "C", "E", "D", "B"]), "ピンの無い C に 1 を打つと、ピンのすぐ下（2番目）まで", await cardTitles(page));
  const toast = await page.textContent("body");
  ok(/ピン留めしたメモより上には動かせません/.test(toast), "ピンより上へは動かせないことを知らせる");
  await page.fill(".capture-input", "新しく書いたメモ");
  await page.press(".capture-input", "Enter");
  await sleep(300);
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["A", "新しく書いたメモ", "C", "E", "D", "B"]), "新しく書いたメモは、ピンの次（並べたものの上）に入る", await cardTitles(page));
  ok(page.errs.length === 0, "o5: エラーなし", page.errs);
  await ctx.close();
});

/* ── o6 ─────────────────────────────────────────────── */
await section("o6 フォルダの中で並べ替えても、ほかのメモとの前後は変えない", async () => {
  const ctx = await device();
  const nb = [{ id: "f1", name: "優待", parentId: null, color: "#c0463c", createdAt: T0, updatedAt: T0 }];
  const m = five();
  // B と D をフォルダ「優待」に
  m[1].notebookId = "f1"; m[3].notebookId = "f1";
  await preset(ctx, cardView({ memos: m, notebooks: nb }, { "kininari:sort": "manual" }));
  const page = await openApp(ctx);
  await page.click('.tree-row .tree-name:has-text("優待")');
  await sleep(300);
  const inF = await cardTitles(page);
  ok(JSON.stringify(inF) === JSON.stringify(["D", "B"]), "フォルダの中は D B", inF);
  await page.click(cardSel("B") + " .ro-num");
  await page.fill(".ro-num-in", "1");
  await page.press(".ro-num-in", "Enter");
  await sleep(200);
  ok(JSON.stringify(await cardTitles(page)) === JSON.stringify(["B", "D"]), "フォルダの中で B を上へ", await cardTitles(page));
  const all = await page.evaluate((k) => {
    const d = JSON.parse(localStorage.getItem(k)).memos;
    const key = (m) => typeof m.ord === "number" ? m.ord : -m.createdAt;
    return d.filter((m) => !m.pinned).sort((a, b) => key(a) - key(b) || b.createdAt - a.createdAt).map((m) => m.title);
  }, DATA_KEY);
  ok(JSON.stringify(all) === JSON.stringify(["E", "B", "C", "D", "A"]), "「すべて」では、B と D の場所が入れ替わるだけ（E・C・A の位置はそのまま）", all);
  ok(page.errs.length === 0, "o6: エラーなし", page.errs);
  await ctx.close();
});

/* ── o7 ─────────────────────────────────────────────── */
await section("o7 ノート表示のページ一覧", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: five(), notebooks: [] }, "kininari:note:view": "\"note\"", "kininari:note:viewV45": "1", "kininari:sort": "manual" });
  const page = await openApp(ctx, ".npg-list");
  const titles = () => page.$$eval(".npg-list .npg-item .npg-tt", (els) => els.map((e) => e.textContent.trim()));
  const nums = await page.$$eval(".npg-list .npg-item .ro-num", (els) => els.map((e) => e.textContent.trim()));
  ok(JSON.stringify(nums) === JSON.stringify(["1", "2", "3", "4", "5"]), "ページにも 1〜5 の番号", nums);
  ok(!/絞り込み中/.test(await page.textContent(".npg-ftoggle")), "「自分で並べた順」は「絞り込み中」に数えない", await page.textContent(".npg-ftoggle"));
  const sel0 = await page.$eval(".npg-item.on .npg-tt", (e) => e.textContent.trim());
  await dragGrip(page, '.npg-item:has(.npg-tt:text-is("E"))', '.npg-item:has(.npg-tt:text-is("C"))', "bottom");
  ok(JSON.stringify(await titles()) === JSON.stringify(["D", "C", "E", "B", "A"]), "⠿ をつかんで C の下へ", await titles());
  const sel1 = await page.$eval(".npg-item.on .npg-tt", (e) => e.textContent.trim());
  ok(sel1 === sel0, "⠿ を押しても、開いているページは変わらない", { sel0, sel1 });
  await page.focus('.npg-item:has(.npg-tt:text-is("A"))');
  await page.keyboard.press("Alt+ArrowUp");
  await sleep(150);
  ok(JSON.stringify(await titles()) === JSON.stringify(["D", "C", "E", "A", "B"]), "ページで Alt＋↑ で1つ上へ", await titles());
  ok(page.errs.length === 0, "o7: エラーなし", page.errs);
  await ctx.close();
});

/* ── o8 ─────────────────────────────────────────────── */
await section("o8 並べた順はほかの端末にも同期する", async () => {
  const drive = createFakeDrive();
  drive.put(FILE_NAME, { app: "kininari", memos: five().map((m) => ({ ...m, synced: 1 })), notebooks: [], files: [], deleted: [] });
  const tok = { "shared:gd:token": JSON.stringify({ token: "fake." + Buffer.from(GD_SCOPE).toString("base64"), exp: Date.now() + 3600 * 1000, scope: GD_SCOPE }), "kininari:gd:linked": "1", "kininari:sort": "manual" };
  const ctxA = await device(PC, drive);
  await preset(ctxA, { ...cardView({ memos: [], notebooks: [] }), ...tok });
  const A = await openApp(ctxA);
  await waitFor(async () => (await cardTitles(A)).length === 5, { timeout: 10000 }).catch(() => {});
  await A.click(cardSel("A") + " .ro-num");
  await A.fill(".ro-num-in", "1");
  await A.press(".ro-num-in", "Enter");
  ok(JSON.stringify(await cardTitles(A)) === JSON.stringify(["A", "E", "D", "C", "B"]), "A: 並べ替えた", await cardTitles(A));
  try {
    await waitFor(() => { const f = drive.byName(FILE_NAME)[0]; const m = (drive.json(f.id).memos || []).find((x) => x.id === "m1"); return m && typeof m.ord === "number"; }, { timeout: 10000 });
    ok(true, "A: 並びが Drive に届く");
  } catch (e) { ok(false, "A: 並びが Drive に届く"); }
  const ctxB = await device(PC, drive);
  await preset(ctxB, { ...cardView({ memos: [], notebooks: [] }), ...tok });
  const B = await openApp(ctxB);
  await waitFor(async () => (await cardTitles(B)).length === 5, { timeout: 10000 }).catch(() => {});
  ok(JSON.stringify(await cardTitles(B)) === JSON.stringify(["A", "E", "D", "C", "B"]), "B: 同じ並びで出る", await cardTitles(B));
  ok(A.errs.length === 0 && B.errs.length === 0, "o8: エラーなし", [...A.errs, ...B.errs]);
  await ctxA.close(); await ctxB.close();
});

/* ── o9 ─────────────────────────────────────────────── */
await section("o9 ほかの並べ方・復習の一覧には番号を出さない", async () => {
  const ctx = await device();
  const m = five();
  m[2].ord = -1e15;   // C を並べたことがある（いちばん上）
  await preset(ctx, cardView({ memos: m, notebooks: [] }, { "kininari:sort": "manual" }));
  const page = await openApp(ctx);
  ok((await cardTitles(page))[0] === "C", "並べた C が上");
  await page.selectOption(SORT, "created");
  ok((await page.locator("section.list .ro-num, section.list .ro-grip").count()) === 0 && (await cardTitles(page))[0] === "E", "新しい順に戻すと番号は消え、並べた位置は使わない");
  await page.selectOption(SORT, "manual");
  ok((await cardTitles(page))[0] === "C", "自分で並べた順に戻すと、並べた位置のまま");
  ok(page.errs.length === 0, "o9: エラーなし", page.errs);
  await ctx.close();
});

await browser.close();
await server.close();
done();
