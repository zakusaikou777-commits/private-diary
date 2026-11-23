/* ============================================================
   気になり帳（kininari.html）: 入口と共通の自動同期・「今すぐ全部同期」でつなぐ・ログイン切れ（v51）の確認
     node .tools/test-fix-kininari-sync.mjs              … 全部
     node .tools/test-fix-kininari-sync.mjs k2 k3        … 名前に含む節だけ
     KN_ROOT=/別の場所 node .tools/test-fix-kininari-sync.mjs … その場所の版で試す（修正前との比べ用）

   k1 自動同期は入口と同じスイッチ（はじめはON）。気になり帳だけのスイッチが無くても、つないだ端末は自動で同期する。
      入口でOFFにすると止まり、ONに戻すと送る。気になり帳の設定のスイッチも同じもの
   k2 入口（index.html）の中で、つないでいない気になり帳を「今すぐ全部同期」でつなぐ（Drive の分とマージ。置き換えない）。
      そのあとは書いただけで自動で送る
   k3 ログインが切れているとき: 自動の同期ではログイン画面を出さない（「切れています」と出す）。気になり帳の中を押すと
      その場でつなぎ直して送る。文字を打つ欄を押したときは出さない。閉じられたら、そのページではもう出さない
   k4 入口でタブに戻った知らせ（nkShown）で、ほかの端末の分を取り込む
   ============================================================ */
import path from "node:path";
import { ROOT, startServer, launch, newDevice, collectErrors, makeChecker, sleep, waitFor } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const SERVE_ROOT = process.env.KN_ROOT ? path.resolve(process.env.KN_ROOT) : ROOT;
const ONLY = process.argv.slice(2);
const { ok, done } = makeChecker("test-fix-kininari-sync");
const DATA_KEY = "kininari:data:v2";
const FILE_NAME = "kininari-data.json";
const GD_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.events";
const SEED_TITLES = ["行ってみたいカフェをリストにする", "歯医者の予約をとる", "気になる記事をあとで読む", "あの曲のアーティスト名を調べる"];
const server = await startServer(SERVE_ROOT);
const BASE = server.url;
const browser = await launch();

/* ── 道具 ─────────────────────────────────────────── */
let clock = Date.now() - 3600 * 1000;
function memo(id, title, extra = {}) {
  clock += 1000;
  return { id, title, body: "", category: "メモ", tags: [], links: [], notebookId: null, date: null, time: null,
    remind: null, srs: null, attachments: [], done: false, pinned: false, createdAt: clock, updatedAt: clock, ...extra };
}
const backup = (memos) => ({ app: "kininari", memos, notebooks: [], files: [], deleted: [] });
const tokenLS = (expMs = 3600 * 1000) => ({ "shared:gd:token": JSON.stringify({ token: "fake." + Buffer.from(GD_SCOPE).toString("base64"), exp: Date.now() + expMs, scope: GD_SCOPE }) });
async function device({ drive = null, contextOptions = {} } = {}) {
  const ctx = await newDevice(browser, { drive, contextOptions });
  // カード表示の画面（.capture-input）を使う
  await ctx.addInitScript(() => {
    try {
      if (localStorage.getItem("kininari:note:view") == null) {
        localStorage.setItem("kininari:note:view", "\"card\"");
        localStorage.setItem("kininari:note:viewV45", "1");
      }
    } catch (e) {}
  });
  await ctx.route(/\/__blank\.html$/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
  return ctx;
}
async function preset(ctx, values) {
  const p = await ctx.newPage();
  await p.goto(BASE + "__blank.html");
  await p.evaluate((o) => { for (const k in o) { if (o[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, typeof o[k] === "string" ? o[k] : JSON.stringify(o[k])); } }, values);
  await p.close();
}
async function openApp(ctx) {
  const page = await ctx.newPage();
  page.errs = collectErrors(page);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  await page.goto(BASE + "kininari.html");
  await page.waitForSelector(".capture-input", { timeout: 15000 });
  return page;
}
async function addMemo(page, title) {
  await page.fill(".capture-input", title);
  await page.press(".capture-input", "Enter");
}
const driveTitles = (drive) => { const f = drive.byName(FILE_NAME)[0]; return f ? ((drive.json(f.id) || {}).memos || []).map((m) => m.title) : []; };
async function onDrive(drive, title, ms = 10000) {
  try { await waitFor(() => driveTitles(drive).includes(title), { timeout: ms }); return true; } catch (e) { return false; }
}
const localTitles = (page) => page.evaluate((k) => ((JSON.parse(localStorage.getItem(k) || "null") || {}).memos || []).map((m) => m.title), DATA_KEY);
const gisCalls = (page) => page.evaluate(() => (window.__fakeGisCalls || []).map((c) => ({ activation: c.activation, frame: c.frame })));
const expire = (page) => page.evaluate(() => { const o = JSON.parse(localStorage.getItem("shared:gd:token")); o.exp = Date.now() - 1000; localStorage.setItem("shared:gd:token", JSON.stringify(o)); });
async function section(name, fn) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
  console.log("\n■ " + name);
  try { await fn(); } catch (e) { ok(false, name + " が途中で止まった", String(e && e.stack || e).split("\n").slice(0, 3).join(" | ")); }
}

/* ── k1 共通のスイッチ ──────────────────────────────── */
await section("k1 自動同期は入口と同じスイッチ（はじめはON）", async () => {
  const drive = createFakeDrive();
  drive.put(FILE_NAME, backup([memo("p1", "スマホのメモ", { synced: 1 })]));
  const ctx = await device({ drive });
  // つないだ端末。気になり帳だけのスイッチ（kininari:gd:auto）も入口のスイッチも、まだ何も決めていない
  await preset(ctx, { ...tokenLS(), "kininari:gd:linked": "1" });
  const page = await openApp(ctx);
  try { await waitFor(async () => (await localTitles(page)).includes("スマホのメモ"), { timeout: 10000 }); } catch (e) {}
  ok((await localTitles(page)).includes("スマホのメモ"), "開いたら Drive の分を取り込む（何も設定していなくても自動同期はON）");
  await addMemo(page, "書いただけで送る");
  ok(await onDrive(drive, "書いただけで送る"), "書いただけで Drive へ送る");
  // 入口で自動同期をOFF（同じ端末の別のページから）
  const other = await ctx.newPage();
  await other.goto(BASE + "__blank.html");
  await other.evaluate(() => localStorage.setItem("shared:nksync:auto", "0"));
  await sleep(300);
  await addMemo(page, "OFFの間のメモ");
  await sleep(4500);
  ok(!driveTitles(drive).includes("OFFの間のメモ"), "入口で自動同期をOFFにすると、気になり帳も送らない");
  await other.evaluate(() => localStorage.setItem("shared:nksync:auto", "1"));
  ok(await onDrive(drive, "OFFの間のメモ"), "ONに戻すと、OFFの間に書いた分も送る");
  // 気になり帳の設定のスイッチ（単体で開いたとき）は、入口と同じスイッチ
  await page.click('button[aria-label="端末間でデータを引き継ぐ"]');
  await page.click('.data-tab:has-text("Google Drive")');
  await page.waitForSelector(".gd-auto input");
  ok(await page.isChecked(".gd-auto input"), "設定のスイッチは ON と出る");
  await page.uncheck(".gd-auto input");
  ok((await page.evaluate(() => localStorage.getItem("shared:nksync:auto"))) === "0", "設定でOFFにすると、入口のスイッチもOFF");
  await page.check(".gd-auto input");
  ok((await page.evaluate(() => localStorage.getItem("shared:nksync:auto"))) === "1", "ONに戻すと入口もON");
  ok(page.errs.length === 0, "k1: エラーなし", page.errs);
  await ctx.close();
});

/* ── k2 入口の「今すぐ全部同期」でつなぐ ───────────────── */
await section("k2 入口の中: つないでいない気になり帳を「今すぐ全部同期」でつなぐ", async () => {
  const drive = createFakeDrive();
  const phone = [memo("p1", "スマホで書いた1", { synced: 1 }), memo("p2", "スマホで書いた2", { synced: 1 })];
  drive.put(FILE_NAME, backup(phone));
  const ctx = await device({ drive, contextOptions: { viewport: { width: 1280, height: 800 } } });
  await ctx.addInitScript(() => {
    if (window.top === window) {
      window.__fakeGis = { mode: "popupBlocked", delay: 50 };   // 1回のクリックで開けるログイン画面は1つだけ
      try { localStorage.setItem("shared:gd:cid", "test-client"); } catch (e) {}
    }
  });
  // PC: 気になり帳にはこの端末だけのメモがある。連携はしていない（入口の中では同期ボタンが隠れている）
  await preset(ctx, { [DATA_KEY]: { memos: [memo("pc1", "PCだけのメモ")], notebooks: [] } });
  const page = await ctx.newPage();
  page.errs = collectErrors(page);
  await page.goto(BASE + "index.html");
  await page.waitForFunction(() => window.google && google.accounts && google.accounts.oauth2, null, { timeout: 10000 });
  await page.click("#knBackupBtn");
  await page.click("#knSyncAll");
  await waitFor(async () => !/同期中/.test(await page.textContent("#knStatus")), { timeout: 40000, label: "全タブの同期の終わり" }).catch(() => {});
  try { await waitFor(() => driveTitles(drive).includes("PCだけのメモ"), { timeout: 15000 }); } catch (e) {}
  const status = await page.textContent("#knStatus");
  const row = (status.match(/気になり帳[^📕📝✓🎞🎧🌿]*/u) || [""])[0];
  ok(!/未接続/.test(row), "気になり帳が「未接続」のままにならない", row);
  const dt = driveTitles(drive);
  ok(dt.includes("スマホで書いた1") && dt.includes("スマホで書いた2") && dt.includes("PCだけのメモ"), "Drive の分とこの端末の分をマージする（置き換えない）", dt);
  ok(!dt.some((t) => SEED_TITLES.includes(t)), "触っていない見本のメモは Drive に持ち込まない", dt);
  const calls = await gisCalls(page);
  ok(calls.length >= 1 && calls.every((c) => c.frame.endsWith("index.html")), "ログイン画面を頼むのは入口だけ（1回）", calls);
  const fr = page.frames().find((f) => { try { return new URL(f.url()).pathname.endsWith("/kininari.html"); } catch (e) { return false; } });
  ok(fr && (await fr.evaluate(() => localStorage.getItem("kininari:gd:linked"))) === "1", "つないだ印が残る");
  ok(fr && (await localTitles(fr)).includes("スマホで書いた1"), "PC の気になり帳にスマホのメモが入る");
  // そのあとは、気になり帳で書いただけで送る
  await page.click("#knModalX");
  await page.click('.apptab[data-app="kininari"]');
  await fr.waitForSelector(".capture-input");
  await addMemo(fr, "PCで書いたあとのメモ");
  ok(await onDrive(drive, "PCで書いたあとのメモ"), "つないだあとは、書いただけで自動で送る（カード表示）");
  // ノート表示でも同じデータ
  await fr.evaluate(() => { localStorage.setItem("kininari:note:view", "\"note\""); location.reload(); });
  await fr.waitForSelector(".nv-wrap, .nv, [class*='nv-']", { timeout: 15000 }).catch(() => {});
  ok((await localTitles(fr)).includes("PCで書いたあとのメモ"), "ノート表示に切り替えても同じメモ（同じデータを同期している）");
  ok(page.errs.length === 0, "k2: エラーなし", page.errs);
  await ctx.close();
});

/* ── k3 ログインが切れているとき ─────────────────────── */
await section("k3 ログインが切れていたら、気になり帳の中を押したときにつなぎ直す", async () => {
  const drive = createFakeDrive();
  drive.put(FILE_NAME, backup([memo("p1", "前からのメモ", { synced: 1 })]));
  const ctx = await device({ drive });
  await preset(ctx, { ...tokenLS(), "kininari:gd:linked": "1" });
  const page = await openApp(ctx);
  try { await waitFor(async () => (await localTitles(page)).includes("前からのメモ"), { timeout: 10000 }); } catch (e) {}
  await page.evaluate(() => { window.__fakeGis = { mode: "popupBlocked" }; });   // 本物と同じく、押した直後でなければ止められる
  await expire(page);
  await addMemo(page, "切れている間のメモ");
  await sleep(4500);
  ok(!driveTitles(drive).includes("切れている間のメモ"), "ログインが切れていると、自動では送れない");
  ok((await gisCalls(page)).length === 0, "自動の同期ではログイン画面を頼まない（ブラウザに止められる画面を出さない）");
  const tip = await page.getAttribute('button[aria-label="端末間でデータを引き継ぐ"]', "title");
  ok(/ログインが切れています/.test(tip || ""), "同期ボタンに「ログインが切れています」と出る", tip);
  // 文字を打つ欄を押しても出さない
  await page.click(".capture-input");
  await sleep(300);
  ok((await gisCalls(page)).length === 0, "文字を打つ欄を押したときは、ログイン画面を出さない");
  // 気になり帳の中（見出し）を押す → その場でつなぎ直して送る
  await page.click("h1");
  ok(await onDrive(drive, "切れている間のメモ"), "気になり帳の中を押すと、つなぎ直して送る");
  const c1 = await gisCalls(page);
  ok(c1.length === 1 && c1[0].activation, "ログイン画面は押した直後に1回だけ", c1);
  await page.click("h1");
  await sleep(300);
  ok((await gisCalls(page)).length === 1, "つながっている間は、押しても出さない");
  // 閉じられたら、このページではもう出さない
  await expire(page);
  await page.evaluate(() => { window.__fakeGis = { mode: "cancel" }; });
  await addMemo(page, "閉じられたあとのメモ");
  await sleep(4000);
  await page.click("h1");
  await sleep(500);
  ok((await gisCalls(page)).length === 2, "もう一度切れたら、押したときにまた頼む");
  await page.click("h1");
  await sleep(500);
  ok((await gisCalls(page)).length === 2, "閉じられたら、このページではもう自分からは出さない");
  ok(page.errs.length === 0, "k3: エラーなし", page.errs);
  await ctx.close();
});

/* ── k4 入口でタブに戻ったとき ──────────────────────── */
await section("k4 入口でタブに戻った知らせ（nkShown）で取り込む", async () => {
  const drive = createFakeDrive();
  const f = drive.put(FILE_NAME, backup([memo("p1", "前からのメモ", { synced: 1 })]));
  const ctx = await device({ drive });
  await preset(ctx, { ...tokenLS(), "kininari:gd:linked": "1" });
  const page = await openApp(ctx);
  try { await waitFor(async () => (await localTitles(page)).includes("前からのメモ"), { timeout: 10000 }); } catch (e) {}
  await sleep(500);
  // ほかの端末が書いた
  const cur = drive.json(f.id);
  cur.memos.push(memo("p9", "ほかの端末で足したメモ", { synced: 1 }));
  drive.write(f.id, cur);
  // 開いてから1分たったことにして、タブに戻った知らせを送る
  await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 61000; window.postMessage({ nkShown: true }, location.origin); });
  try { await waitFor(async () => (await localTitles(page)).includes("ほかの端末で足したメモ"), { timeout: 10000 }); } catch (e) {}
  ok((await localTitles(page)).includes("ほかの端末で足したメモ"), "タブに戻った知らせで、ほかの端末の分を取り込む");
  ok(page.errs.length === 0, "k4: エラーなし", page.errs);
  await ctx.close();
});

await browser.close();
await server.close();
done();
