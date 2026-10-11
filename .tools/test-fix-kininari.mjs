/* ============================================================
   気になり帳（kininari.html）の不具合修正の検証

     node .tools/test-fix-kininari.mjs
     KN_ROOT=/path/to/dir node .tools/test-fix-kininari.mjs   … 別の場所の kininari.html を検証する
                                                              （直す前の版で「落ちる」ことを確かめる用）
     node .tools/test-fix-kininari.mjs sync clip              … 名前に含む節だけ走らせる

   2台の端末 = ブラウザのコンテキスト2つ。Drive は fake-drive.mjs を共有し、
   Googleログインは gis-stub.js に差し替える（.tools/lib/harness.mjs）。
   ============================================================ */
import path from "node:path";
import { ROOT, GIS_STUB, startServer, launch, newDevice, collectErrors, makeChecker, sleep, waitFor } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const SERVE_ROOT = process.env.KN_ROOT ? path.resolve(process.env.KN_ROOT) : ROOT;
const ONLY = process.argv.slice(2);
const { ok, done } = makeChecker("test-fix-kininari");

const DATA_KEY = "kininari:data:v2";
const FILE_NAME = "kininari-data.json";
const GD_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.events";
const TOKEN = "fake." + Buffer.from(GD_SCOPE).toString("base64");
const IMG = path.join(ROOT, "icon-192.png");
const SEED_TITLES = ["行ってみたいカフェをリストにする", "歯医者の予約をとる", "気になる記事をあとで読む", "あの曲のアーティスト名を調べる"];

const server = await startServer(SERVE_ROOT);
const BASE = server.url;
const browser = await launch();
console.log("検証する kininari.html: " + path.join(SERVE_ROOT, "kininari.html"));

/* ── 共通の部品 ─────────────────────────────────────────── */
let clock = Date.now() - 3600 * 1000;
function memo(id, title, extra = {}) {
  clock += 1000;
  return { id, title, body: "", category: "メモ", tags: [], links: [], notebookId: null, date: null, time: null,
    remind: null, srs: null, attachments: [], done: false, pinned: false, createdAt: clock, updatedAt: clock, ...extra };
}
function backup(memos, extra = {}) {
  return { app: "kininari", memos, notebooks: [], files: [], deleted: [], ...extra };
}
const tokenLS = () => ({ "shared:gd:token": JSON.stringify({ token: TOKEN, exp: Date.now() + 3600 * 1000 }) });
const linkedLS = ({ file = "", sync = "", auto = false } = {}) => ({
  ...tokenLS(), "kininari:gd:linked": "1", "kininari:gd:auto": auto ? "1" : "0", "kininari:gd:file": file, "kininari:gd:sync": sync
});

// gis-stub.js は initTokenClient に渡した callback しか呼ばないが、気になり帳は本物のGISの
// 書き方どおり、あとから client.callback / client.error_callback を差し替えて使う。そのままだと
// 「Googleで接続する」が終わらないので、差し替えた方を呼ぶ形にしてから配る。
const GIS_PATCHED = (() => {
  const pairs = [
    ["requestAccessToken: function (o) {", "requestAccessToken: function (o) { var self = this;"],
    ["if (cfg.error_callback) cfg.error_callback(", "var ec = self.error_callback || cfg.error_callback; if (ec) ec("],
    ["cfg.callback({", "(self.callback || cfg.callback)({"]
  ];
  if (!pairs.every(([a]) => GIS_STUB.includes(a))) return GIS_STUB;
  return pairs.reduce((s, [a, b]) => s.replace(a, b), GIS_STUB);
})();

/** 端末1台。__blank.html（中身の無いページ）と __host.html（iframe でアプリを開くシェルの代わり）を用意する */
async function device({ drive = null, contextOptions = {}, wrapDrive = null } = {}) {
  const d = wrapDrive ? { handle: wrapDrive } : drive;
  const ctx = await newDevice(browser, { drive: d, contextOptions });
  await ctx.route(/accounts\.google\.com\/gsi\/client/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: GIS_PATCHED }));
  await ctx.route(/\/__blank\.html$/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
  await ctx.route(/\/__host\.html$/, (r) => r.fulfill({ status: 200, contentType: "text/html", body:
    `<!doctype html><title>host</title><iframe id="f" src="kininari.html" style="width:1000px;height:700px"></iframe>
     <script>window.__st=[];addEventListener("message",function(e){if(e.data&&e.data.nkSyncStatus)window.__st.push(e.data.nkSyncStatus);});</script>` }));
  return ctx;
}
/** 開く前に localStorage を入れておく（値が文字列でなければ JSON にする） */
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
  await page.waitForSelector(".capture-input", { timeout: 15000 });
  return { page, errors };
}
const lsData = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), DATA_KEY);
const ls = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);
const titlesOf = (list) => (list || []).map((m) => m.title);
const driveMemos = (drive, id) => (drive.json(id) || {}).memos || [];
const nbsp = (s) => String(s == null ? "" : s).replace(/ /g, " ");

async function openDataModal(page) {
  await page.click('button[aria-label="端末間でデータを引き継ぐ"]');
  await page.waitForSelector(".modal .data-tabs");
  await page.click('.data-tab:has-text("Google Drive")');
}
/** ボタンを押して、新しく出た結果の文を返す（前の文には印を付けて見分ける。React の要素は消さない） */
async function clickAndWaitMsg(page, label) {
  await page.evaluate(() => { document.querySelectorAll(".data-msg").forEach((e) => e.setAttribute("data-old", "1")); });
  await page.click(`.data-actions button:has-text("${label}")`);
  await page.waitForSelector(".data-msg:not([data-old])", { timeout: 30000 });
  return page.textContent(".data-msg:not([data-old])");
}

async function section(name, fn) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
  console.log("\n■ " + name);
  try { await fn(); }
  catch (e) { ok(false, name + " が途中で止まった", String(e && e.stack || e).split("\n").slice(0, 3).join(" | ")); }
}

/* ── 1. 初めて送る端末が Drive を上書きしない ─────────────────────────── */
await section("1 sync: 初回の送信はマージする（シェルの now / 接続直後の保存 / 再接続）", async () => {
  const drive = createFakeDrive();
  const A = [memo("a1", "Aのメモ1"), memo("a2", "Aのメモ2"), memo("a3", "Aのメモ3")].map((m) => ({ ...m, synced: 1 }));
  const f = drive.put(FILE_NAME, backup(A));
  const t0 = f.modifiedTime;
  const aIds = A.map((m) => m.id);

  // 端末B: シェルの中。トークンはあるが、気になり帳は連携していない
  const ctxB = await device({ drive });
  await preset(ctxB, tokenLS());
  const host = await ctxB.newPage();
  await host.goto(BASE + "__host.html");
  const frame = () => host.frame({ url: /kininari\.html/ });
  await waitFor(() => frame(), { label: "iframe" });
  await frame().waitForSelector(".capture-input");
  await waitFor(() => host.evaluate(() => window.__st.length > 0), { label: "最初の状態報告" });
  const nLog = drive.log.length;
  await host.evaluate(() => { window.__st = []; document.getElementById("f").contentWindow.postMessage({ nkSync: "now" }, location.origin); });
  await sleep(1500);
  const writes = drive.log.slice(nLog).filter((r) => r.method !== "GET");
  const st1 = await host.evaluate(() => window.__st.map((s) => s.phase));
  ok(writes.length === 0, "未連携のとき now で Drive に書かない", writes);
  ok(st1.length > 0 && st1.every((p) => p === "off"), "未連携のとき now には off と返す", st1);
  ok(JSON.stringify(driveMemos(drive, f.id).map((m) => m.id)) === JSON.stringify(aIds), "Drive の中身はそのまま");

  // 連携した直後（同期の記録はまだ無い）に now → 取り込んでマージしてから送る
  await frame().evaluate(() => localStorage.setItem("kininari:gd:linked", "1"));
  await frame().evaluate(() => location.reload());
  await sleep(300);
  await waitFor(() => frame(), { label: "iframe 再読み込み" });
  await frame().waitForSelector(".capture-input");
  await host.evaluate(() => { window.__st = []; document.getElementById("f").contentWindow.postMessage({ nkSync: "now" }, location.origin); });
  await waitFor(() => host.evaluate(() => window.__st.some((s) => s.phase === "ok" || s.phase === "error")), { label: "now の結果", timeout: 15000 });
  const st2 = await host.evaluate(() => window.__st.map((s) => s.phase + ":" + s.msg));
  ok(st2.some((p) => p.startsWith("ok")), "連携済みなら now で同期できる", st2);
  const dm = driveMemos(drive, f.id);
  ok(aIds.every((id) => dm.some((m) => m.id === id)), "2台目の初回送信で、Drive にあったメモが残る", titlesOf(dm));
  ok(!dm.some((m) => SEED_TITLES.includes(m.title)), "触っていない見本のメモは Drive に持ち込まない", titlesOf(dm));
  const bData = await frame().evaluate((k) => JSON.parse(localStorage.getItem(k)), DATA_KEY);
  ok(aIds.every((id) => bData.memos.some((m) => m.id === id)), "端末Bに Drive のメモが入る", titlesOf(bData.memos));
  ok(!bData.memos.some((m) => SEED_TITLES.includes(m.title)), "端末Bの見本は消える（すでに Drive にメモがあるので）", titlesOf(bData.memos));

  // 端末C: 単体で開き、自分のメモを1件書いてから「Googleで接続する」→「Driveへ保存」
  const ctxC = await device({ drive });
  const { page: c } = await openApp(ctxC);
  await c.fill(".capture-input", "Cのメモ");
  await c.press(".capture-input", "Enter");
  await openDataModal(c);
  await c.click('button:has-text("Googleで接続する")');
  await c.waitForSelector('button:has-text("Driveへ保存（アップロード）")', { timeout: 10000 });
  const msgC = await clickAndWaitMsg(c, "Driveへ保存（アップロード）");
  ok(/保存しました/.test(msgC), "接続直後の「Driveへ保存」が成功する", msgC);
  const dm2 = driveMemos(drive, f.id);
  ok(aIds.every((id) => dm2.some((m) => m.id === id)) && dm2.some((m) => m.title === "Cのメモ"), "接続直後の保存で、Drive のメモと端末Cのメモが両方残る", titlesOf(dm2));
  ok(!dm2.some((m) => SEED_TITLES.includes(m.title)), "端末Cの見本も持ち込まない", titlesOf(dm2));

  // 端末D: 前に別の Drive と同期していた（synced 印が残っている）が、連携を解除してあった。再接続して保存
  const ctxD = await device({ drive });
  await preset(ctxD, { [DATA_KEY]: { memos: [memo("d1", "Dの古いメモ", { synced: 1 })], notebooks: [] } });
  const { page: dpg } = await openApp(ctxD);
  await openDataModal(dpg);
  await dpg.click('button:has-text("Googleで接続する")');
  await dpg.waitForSelector('button:has-text("Driveへ保存（アップロード）")', { timeout: 10000 });
  const msgD = await clickAndWaitMsg(dpg, "Driveへ保存（アップロード）");
  const dm3 = driveMemos(drive, f.id);
  const dData = await lsData(dpg);
  ok(/保存しました/.test(msgD) && dm3.some((m) => m.id === "d1") && aIds.every((id) => dm3.some((m) => m.id === id)), "再接続の保存で、前の同期の印が付いたメモも消えずに載る", titlesOf(dm3));
  ok(dData.memos.some((m) => m.id === "d1") && aIds.every((id) => dData.memos.some((m) => m.id === id)), "再接続した端末Dにも両方残る", titlesOf(dData.memos));

  // 端末A: 最初に同期した時点の記録のまま開く（自動同期）。自分のメモが消えないこと
  const ctxA = await device({ drive });
  await preset(ctxA, { ...linkedLS({ file: f.id, sync: t0, auto: true }), [DATA_KEY]: { memos: A, notebooks: [] } });
  const { page: a } = await openApp(ctxA);
  await waitFor(async () => (await ls(a, "kininari:gd:sync")) !== t0, { label: "端末Aの自動同期", timeout: 15000 }).catch(() => {});
  const aData = await lsData(a);
  ok(aIds.every((id) => aData.memos.some((m) => m.id === id)), "端末Aのメモは他端末の初回送信のあとも残る", titlesOf(aData.memos));
  ok(aData.memos.some((m) => m.title === "Cのメモ") && aData.memos.some((m) => m.id === "d1"), "端末Aに他端末のメモが入る", titlesOf(aData.memos));
  await Promise.all([ctxA, ctxB, ctxC, ctxD].map((c2) => c2.close()));
});

/* ── 2. 保存前の画像が掃除で消えない ───────────────────────────── */
await section("2 attach: 保存前の画像・古い記録の掃除", async () => {
  const ctx = await device();
  const { page } = await openApp(ctx);
  await page.click(".body-toggle");
  await page.waitForSelector(".capture-body .rich-area");
  await page.setInputFiles('.capture-body input[type=file][accept="image/*"]', IMG);
  await page.waitForSelector(".capture-body .rich-area img[data-kid]", { timeout: 10000 });
  const kid = await page.getAttribute(".capture-body .rich-area img[data-kid]", "data-kid");
  const rec0 = await page.evaluate((id) => idbGet(id).then((r) => r && { at: r.at || 0 }), kid);
  ok(rec0 && rec0.at > Date.now() - 60000, "本文に貼った画像の記録に保存時刻（at）が付く", rec0);
  ok(await page.evaluate((id) => pendingFileIds.has(id), kid), "本文に貼った画像は保存前の印（pendingFileIds）に入る");

  // 別タブ（クリップや共有で裏に開くタブと同じ）を開くと、起動時の掃除が走る
  const p2 = await ctx.newPage();
  await p2.goto(BASE + "kininari.html");
  await p2.waitForSelector(".capture-input");
  await sleep(1200);
  ok(await page.evaluate((id) => idbGet(id).then((r) => !!r), kid), "別のタブの起動時の掃除で、書きかけの画像が消えない");
  await p2.close();

  // 同じタブで自動同期のマージ（applyMerged → gcAttachments）が走っても消えない
  const kept = await page.evaluate(async (args) => {
    await gcAttachments(JSON.parse(localStorage.getItem(args.k)).memos);
    return !!(await idbGet(args.id));
  }, { k: DATA_KEY, id: kid });
  ok(kept, "保存前に掃除が走っても本文の画像が残る");

  await page.click("button.add");
  await sleep(300);
  const d = await lsData(page);
  const saved = d.memos.find((m) => (m.body || "").includes(kid));
  ok(!!saved, "保存したメモの本文に画像のIDが入る", titlesOf(d.memos));
  await page.click(`.card .title:text-is("${saved ? saved.title : "画像メモ"}")`);
  await page.waitForSelector('.kn-full .memo-rich img[src^="blob:"]', { timeout: 5000 }).catch(() => {});
  ok(await page.$('.kn-full .memo-rich img[src^="blob:"]'), "保存した画像が表示される");
  await page.click(".kn-full-x");

  // 時刻の無い古い記録はすぐ消さず、時刻を付けて寝かせる。古くて使われていないものだけ消す
  const res = await page.evaluate(async (k) => {
    const old = Date.now() - 8 * 86400000;
    await idbPut({ id: "legacy1", blob: new Blob(["x"]), name: "x", type: "text/plain", size: 1 });
    await idbPut({ id: "stale1", blob: new Blob(["x"]), name: "x", type: "text/plain", size: 1, at: old });
    await idbPut({ id: "fresh1", blob: new Blob(["x"]), name: "x", type: "text/plain", size: 1, at: Date.now() - 3600000 });
    await idbPut({ id: "used1", blob: new Blob(["x"]), name: "x", type: "text/plain", size: 1, at: old });
    const memos = JSON.parse(localStorage.getItem(k)).memos.concat([{ id: "mx", attachments: [{ id: "used1" }], body: "" }]);
    await gcAttachments(memos);
    const g = async (id) => { const r = await idbGet(id); return r ? { at: r.at || 0 } : null; };
    return { legacy: await g("legacy1"), stale: await g("stale1"), fresh: await g("fresh1"), used: await g("used1") };
  }, DATA_KEY);
  ok(res.legacy && res.legacy.at > Date.now() - 60000, "時刻の無い記録は消さずに時刻を付ける", res.legacy);
  ok(res.stale === null, "使われていない7日より前の記録は消す", res.stale);
  ok(!!res.fresh, "使われていない新しい記録はまだ消さない", res.fresh);
  ok(!!res.used, "メモが使っている記録は古くても消さない", res.used);
  await ctx.close();
});

/* ── 3. 1行の本文の & < > 空白が編集のたびに増えない ───────────────────── */
await section("3 body: 1行の本文の往復", async () => {
  const ctx = await device();
  const legacy = [
    memo("L1", "旧メモ1", { body: "Q&A と AT&T\n2行目" }),
    memo("L2", "旧メモ2", { body: "x < y" }),
    memo("L3", "旧メモ3", { body: "駅前の新しいところが気になる" })
  ];
  await preset(ctx, { [DATA_KEY]: { memos: legacy, notebooks: [] } });
  const { page, errors } = await openApp(ctx);
  const card = (title) => page.locator(".card", { has: page.locator(`.title:text-is("${title}")`) });
  const excerpt = async (title) => nbsp(await card(title).locator(".body.excerpt").textContent().catch(() => ""));
  const fullText = async (title) => {
    await card(title).locator(".title").click();
    await page.waitForSelector(".kn-full");
    const t = await page.evaluate(() => { const el = document.querySelector(".kn-full .memo-rich, .kn-full .body"); return el ? el.innerText : ""; });
    await page.click(".kn-full-x");
    await page.waitForSelector(".kn-full", { state: "detached" });
    return nbsp(t);
  };
  const bodyOf = async (title) => ((await lsData(page)).memos.find((m) => m.title === title) || {}).body;

  // 旧版で保存された素の文章は、これまでどおりに見える
  ok((await excerpt("旧メモ1")) === "Q&A と AT&T 2行目", "旧版の素の文章（& を含む）の抜粋は変わらない", await excerpt("旧メモ1"));
  ok((await fullText("旧メモ1")) === "Q&A と AT&T\n2行目", "旧版の素の文章は改行も含めてそのまま表示される", await fullText("旧メモ1"));
  ok((await excerpt("旧メモ3")) === "駅前の新しいところが気になる", "見本の本文はそのまま");
  ok((await excerpt("旧メモ2")) === "x < y", "旧版の「x < y」は x < y と表示される（&lt; のままにならない）", await excerpt("旧メモ2"));

  const cases = [["Q&A", "Q&A"], ["a  b", "a  b"], ["abc ", "abc"], ["<tag>", "<tag>"]];
  let i = 0;
  for (const [typed, shown] of cases) {
    const title = "本文" + (++i);
    await page.fill(".capture-input", title);
    await page.waitForSelector(".capture-body .rich-area");
    await page.click(".capture-body .rich-area");
    await page.keyboard.type(typed);
    await page.click("button.add");
    await page.waitForSelector(`.card .title:text-is("${title}")`);
    const b1 = await bodyOf(title);
    ok((await excerpt(title)) === shown, `「${typed}」の抜粋が ${JSON.stringify(shown)} になる`, { excerpt: await excerpt(title), body: b1 });
    ok(nbsp(await fullText(title)).replace(/\s+$/, "") === shown, `「${typed}」を全画面で開くと ${JSON.stringify(shown)}`, await fullText(title));
    // 開き直して1文字足して保存 → さらにもう一度、何も変えずに保存
    await card(title).locator('button.mini:has-text("編集")').click();
    await page.waitForSelector(".kn-full .rich-area");
    const inEditor = nbsp(await page.textContent(".kn-full .rich-area"));
    ok(inEditor === typed, `「${typed}」を編集で開くと元の文字のまま`, inEditor);
    await page.click(".kn-full .rich-area");
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.click(".kn-full-b.solid");
    await page.waitForSelector(".kn-full", { state: "detached" });
    const b2 = await bodyOf(title);
    const want2 = (typed + "!").replace(/^\s+|\s+$/g, "");
    ok((await excerpt(title)) === want2, `「${typed}」に1文字足すと ${JSON.stringify(want2)}`, { excerpt: await excerpt(title), body: b2 });
    await card(title).locator('button.mini:has-text("編集")').click();
    await page.waitForSelector(".kn-full .rich-area");
    await page.click(".kn-full .rich-area");
    await page.click(".kn-full-b.solid");
    await page.waitForSelector(".kn-full", { state: "detached" });
    const b3 = await bodyOf(title);
    ok(b3 === b2 && !/&amp;amp;|&amp;nbsp;|&amp;lt;/.test(b3), `「${typed}」を開いて保存し直しても変わらない`, { b2, b3 });
  }

  // ふつうの書式つき本文
  await page.fill(".capture-input", "書式");
  await page.waitForSelector(".capture-body .rich-area");
  await page.click(".capture-body .rich-area");
  await page.keyboard.type("前 ");
  await page.click('.capture-body .rich-b:text-is("B")');
  await page.keyboard.type("太字");
  await page.click("button.add");
  await page.waitForSelector('.card .title:text-is("書式")');
  await card("書式").locator(".title").click();
  await page.waitForSelector(".kn-full .memo-rich");
  const rich = await page.evaluate(() => { const el = document.querySelector(".kn-full .memo-rich"); return { html: el.innerHTML, text: el.innerText }; });
  await page.click(".kn-full-x");
  ok(/font-weight|<b>/.test(rich.html) && nbsp(rich.text).includes("前 太字"), "書式つきの本文はHTMLとして表示される", rich);
  ok(errors.length === 0, "ページのエラーが無い", errors);
  await ctx.close();
});

/* ── 4. 日本語入力の確定のEnterで動かない ───────────────────────────── */
await section("4 ime: 変換確定のEnter", async () => {
  // 入力欄ごとに別の端末で確かめる（直す前の版で1か所が崩れても、ほかの欄の結果が出るように）
  const folderA = { id: "F1", name: "フォルダA", parentId: null, pinned: false, createdAt: Date.now() - 5000, updatedAt: Date.now() - 5000 };
  const imeCase = async (name, data, fn) => {
    const ctx = await device();
    try {
      if (data) await preset(ctx, { [DATA_KEY]: data });
      const { page } = await openApp(ctx);
      const imeKey = (sel, key, how) => page.$eval(sel, (el, a) => {
        const init = { key: a.key, code: a.key, bubbles: true, cancelable: true };
        if (a.how === "composing") init.isComposing = true; else init.keyCode = 229;
        el.dispatchEvent(new KeyboardEvent("keydown", init));
      }, { key, how });
      await fn(page, imeKey);
    } catch (e) {
      ok(false, name + ": 途中で止まった", String(e && e.message || e).split("\n")[0]);
    }
    await ctx.close();
  };

  await imeCase("メモ欄", null, async (page, imeKey) => {
    const count = async () => (await lsData(page)).memos.length;
    const n0 = await count();
    await page.fill(".capture-input", "かんじ");
    await imeKey(".capture-input", "Enter", "composing");
    await imeKey(".capture-input", "Enter", "229");
    await sleep(200);
    ok((await count()) === n0 && (await page.inputValue(".capture-input")) === "かんじ", "メモ欄: 変換確定のEnterでは追加しない");
    await page.press(".capture-input", "Enter");
    await sleep(200);
    ok((await count()) === n0 + 1, "メモ欄: ふつうのEnterで追加する");
  });

  await imeCase("フォルダ", null, async (page, imeKey) => {
    await page.click(".sidebar .add-root");
    const inp = ".sidebar .add-root-form input";
    await page.fill(inp, "フォルダA");
    await imeKey(inp, "Enter", "composing");
    await sleep(150);
    ok((await lsData(page)).notebooks.length === 0 && !!(await page.$(inp)), "フォルダ: 変換確定のEnterでは作らない");
    await imeKey(inp, "Escape", "composing");
    await sleep(150);
    ok(!!(await page.$(inp)), "フォルダ: 変換の取り消しのEscapeでは欄を閉じない");
    await page.press(inp, "Enter");
    await sleep(200);
    const nb = (await lsData(page)).notebooks;
    ok(nb.length === 1 && nb[0].name === "フォルダA", "フォルダ: ふつうのEnterで作る", nb);
  });

  await imeCase("サブフォルダ", { memos: [], notebooks: [folderA] }, async (page, imeKey) => {
    await page.click(".sidebar .tree-more");
    await page.click('.fa-btn:has-text("サブフォルダを追加")');
    await page.fill(".fa-form input", "サブ");
    await imeKey(".fa-form input", "Enter", "composing");
    await sleep(150);
    ok((await lsData(page)).notebooks.length === 1 && !!(await page.$(".fa-form input")), "サブフォルダ: 変換確定のEnterでは作らない");
    await page.press(".fa-form input", "Enter");
    await sleep(200);
    ok((await lsData(page)).notebooks.length === 2, "サブフォルダ: ふつうのEnterで作る");
  });

  await imeCase("名前の変更", { memos: [], notebooks: [folderA] }, async (page, imeKey) => {
    await page.click(".sidebar .tree-more");
    await page.click('.fa-btn:has-text("名前を変更")');
    await page.fill(".fa-form input", "改名");
    await imeKey(".fa-form input", "Enter", "229");
    await sleep(150);
    ok((await lsData(page)).notebooks.some((f) => f.name === "フォルダA") && !!(await page.$(".fa-form input")), "名前の変更: 変換確定のEnterでは確定しない");
    await page.press(".fa-form input", "Enter");
    await sleep(200);
    ok((await lsData(page)).notebooks.some((f) => f.name === "改名"), "名前の変更: ふつうのEnterで確定する");
  });

  await imeCase("リンク", null, async (page, imeKey) => {
    await page.click(".body-toggle");
    await page.waitForSelector(".capture-body .rich-area");
    await page.click('.capture-body .rich-b[title="リンク"]');
    await page.waitForSelector(".kn-dlg input[inputmode=url]");
    await page.fill(".kn-dlg input[inputmode=url]", "https://example.com/");
    await imeKey(".kn-dlg input[inputmode=url]", "Enter", "composing");
    await sleep(150);
    ok(!!(await page.$(".kn-dlg")), "リンク: 変換確定のEnterではダイアログを閉じない");
    if (await page.$(".kn-dlg")) await page.press(".kn-dlg input[inputmode=url]", "Enter");
    await sleep(150);
    ok(!(await page.$(".kn-dlg")) && !!(await page.$('.capture-body .rich-area a[href="https://example.com/"]')), "リンク: ふつうのEnterで入る");
  });

  await imeCase("タグ・リンク欄", null, async (page, imeKey) => {
    await page.click(".detail-toggle");
    // （欄から出ると打ちかけの分は追加される作りなので、フォーカスを動かす前に確かめる）
    await page.fill(".capture-detail .tag-input", "たぐ");
    await imeKey(".capture-detail .tag-input", "Enter", "composing");
    await sleep(150);
    ok(!(await page.$(".capture-detail .tag-chip.on")), "タグ欄: 変換確定のEnterでは追加しない");
    await page.press(".capture-detail .tag-input", "Enter");
    await sleep(150);
    ok(!!(await page.$('.capture-detail .tag-chip.on:has-text("たぐ")')), "タグ欄: ふつうのEnterで追加する");
    await page.fill(".capture-detail .link-input", "example.org");
    await imeKey(".capture-detail .link-input", "Enter", "229");
    await sleep(150);
    ok(!(await page.$(".capture-detail .link-row")), "リンク欄: 変換確定のEnterでは追加しない");
    await page.press(".capture-detail .link-input", "Enter");
    await sleep(150);
    ok(!!(await page.$(".capture-detail .link-row")), "リンク欄: ふつうのEnterで追加する");
  });
});

/* ── 5. 「Driveから取得」の同期時刻 ─────────────────────────────── */
await section("5 sync: 「Driveから取得」は取り込んだ版の時刻を記録する", async () => {
  const drive = createFakeDrive();
  const f = drive.put(FILE_NAME, backup([memo("p1", "Drive1", { synced: 1 })]));
  let armed = false;
  const wrap = async (route) => {
    const u = new URL(route.request().url());
    await drive.handle(route);
    // 中身を渡した直後に、別の端末が書いたことにする
    if (armed && u.searchParams.get("alt") === "media") {
      armed = false;
      drive.write(f.id, backup([memo("p1", "Drive1", { synced: 1 }), memo("p2", "あとから他端末", { synced: 1 })]));
    }
  };
  const ctx = await device({ wrapDrive: wrap });
  await preset(ctx, linkedLS({ file: f.id, sync: f.modifiedTime }));
  const { page } = await openApp(ctx);
  await openDataModal(page);
  armed = true;
  const got = drive.files.get(f.id).modifiedTime;
  const msg = await clickAndWaitMsg(page, "Driveから取得（ダウンロード）");
  const syncT = await ls(page, "kininari:gd:sync");
  ok(/取り込みました/.test(msg), "取得できる", msg);
  ok(syncT === got && syncT < drive.files.get(f.id).modifiedTime, "記録する同期時刻は取り込んだ版のもの（その後の他端末の書き込みより前）", { syncT, got, now: drive.files.get(f.id).modifiedTime });
  await page.close();
  await preset(ctx, { "kininari:gd:auto": "1" });
  const { page: p2 } = await openApp(ctx);
  await waitFor(async () => ((await lsData(p2)).memos || []).some((m) => m.id === "p2"), { label: "次の同期で取り込む", timeout: 10000 }).catch(() => {});
  ok(((await lsData(p2)).memos || []).some((m) => m.id === "p2"), "次の自動同期で、取得の直後に他端末が書いた分も取り込む");
  await ctx.close();
});

/* ── 6. 編集が削除に勝つ／初めての相手では印を信用しない ───────────────── */
await section("6 merge: mergeById", async () => {
  const ctx = await device();
  const { page } = await openApp(ctx);
  const r = await page.evaluate(() => {
    const L = [
      { id: "x", title: "削除の後に編集", updatedAt: 2000, synced: 1 },
      { id: "y", title: "墓標なしで消えた", updatedAt: 1000, synced: 1 },
      { id: "z", title: "削除の方が新しい", updatedAt: 1000, synced: 1 },
      { id: "n", title: "未送信", updatedAt: 500 }
    ];
    const tombs = [{ id: "x", at: 1500 }, { id: "z", at: 1500 }];
    const known = mergeById(L, [], 12345, tombs);
    const unknown = mergeById(L, [], 0, []);
    return { known: known.map((o) => o.id).sort(), unknown: unknown.map((o) => o.id).sort(), unknownSynced: unknown.filter((o) => o.synced).length };
  });
  ok(JSON.stringify(r.known) === JSON.stringify(["n", "x"]), "削除より後に編集したものは残し、墓標なし・削除が新しいものは消す", r.known);
  ok(JSON.stringify(r.unknown) === JSON.stringify(["n", "x", "y", "z"]) && r.unknownSynced === 0, "最終同期が分からない相手とは、同期済みの印を外して全部残す", r);
  await ctx.close();
});

/* ── 7. AIの変な返事・描画中の例外 ───────────────────────────────── */
await section("7 ai: 形の崩れたAIの返事と、エラー時の画面", async () => {
  const ctx = await device();
  const ms = [memo("m1", "ひとつめ"), memo("m2", "ふたつめ"), memo("m3", "みっつめ")];
  await preset(ctx, { [DATA_KEY]: { memos: ms, notebooks: [] }, "kininari:apikey": "sk-test" });
  await ctx.route("https://api.anthropic.com/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({
      summary: { not: "a string" },
      tags: { m1: "文字列", m2: [1, { x: 1 }, "良いタグ", null], m3: null, __proto__: ["x"] },
      groups: [{ name: { x: 1 }, ids: "m1" }, { name: "まとめ", ids: ["m1", "m2", 5] }, null, "x"]
    }) }]
  }) }));
  const { page, errors } = await openApp(ctx);
  await page.click(".ai-btn");
  await page.waitForSelector(".modal .ai-sec, .modal .ai-error, .kn-crash", { timeout: 10000 }).catch(() => {});
  await sleep(300);
  ok(!!(await page.$(".wrap .modal .ai-sec")), "変な形の返事でも画面が消えずに結果が出る", errors);
  ok(!!(await page.$('.ai-tagrow button:has-text("良いタグ")')) && !!(await page.$('.ai-grp:has-text("まとめ")')), "使える部分（文字列のタグ・正しいグループ）は出る");
  ok(!errors.some((e) => /pageerror/.test(e)), "未処理の例外が無い", errors);
  await ctx.close();

  // 描画中に例外（壊れたメモ）→ 真っ白ではなく、案内と再読み込みのボタンを出す
  const ctx2 = await device();
  await preset(ctx2, { [DATA_KEY]: { memos: [memo("b1", "壊れたメモ", { category: { broken: true } })], notebooks: [] } });
  const page2 = await ctx2.newPage();
  const errs2 = collectErrors(page2);
  await page2.goto(BASE + "kininari.html");
  await page2.waitForSelector(".kn-crash", { timeout: 8000 }).catch(() => {});
  ok(!!(await page2.$(".kn-crash")) && !!(await page2.$('.kn-crash button:has-text("再読み込み")')), "描画中の例外では案内と再読み込みボタンを出す", await page2.evaluate(() => document.getElementById("root").innerHTML.slice(0, 200)));
  ok(errs2.some((e) => /気になり帳/.test(e)), "例外は console にも出す（握りつぶさない）", errs2);
  if (await page2.$(".kn-crash button")) {
    const nav = page2.waitForEvent("framenavigated", { timeout: 5000 }).then(() => true, () => false);
    await page2.click(".kn-crash button");
    ok(await nav, "再読み込みボタンで読み込み直す");
  }
  await ctx2.close();
});

/* ── 8. バックアップのファイル名は端末の日付 ───────────────────────────── */
await section("8 backup: ファイル名の日付", async () => {
  const ctx = await device({ contextOptions: { timezoneId: "Asia/Tokyo", acceptDownloads: true } });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date("2026-10-11T20:30:00Z"));   // 日本では 10/12 の朝
  await page.goto(BASE + "kininari.html");
  await page.waitForSelector(".capture-input");
  await page.click('button[aria-label="端末間でデータを引き継ぐ"]');
  await page.click('.data-tab:has-text("書き出す")');
  await page.waitForSelector('button:has-text("ファイルで保存（.json）")', { timeout: 10000 });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('button:has-text("ファイルで保存（.json）")')]);
  ok(dl.suggestedFilename() === "kininari-backup-2026-10-12.json", "日本時間の日付でファイル名を付ける", dl.suggestedFilename());
  await ctx.close();
});

/* ── 9. クリップの受け取り ───────────────────────────────────────── */
await section("9 clip: 番号つきの重複判定・結果の合図", async () => {
  const ctx = await device();
  const clipUrl = (p, q = "") => BASE + "kininari.html" + q + "#knadd=" + encodeURIComponent(JSON.stringify(p));
  const recv = async (url) => {
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.accept().catch(() => {}));
    await page.goto(url);
    await page.waitForSelector(".capture-input");
    await waitFor(() => page.evaluate(() => window.__kininariClipStatus || (window.__kininariClipSaved ? "(flag)" : "")), { timeout: 5000, label: "合図" }).catch(() => {});
    await sleep(100);
    const r = await page.evaluate((k) => ({ status: window.__kininariClipStatus, flag: !!window.__kininariClipSaved,
      memos: (JSON.parse(localStorage.getItem(k) || "{}").memos || []), href: location.href }), DATA_KEY);
    await page.close();
    return r;
  };
  const nTitle = (r, t) => r.memos.filter((m) => m.title === t).length;
  const K1 = "0123456789abcdef0123456789abcdef", K2 = "fedcba9876543210fedcba9876543210", K3 = "aaaabbbbccccddddeeeeffff00001111";

  let r = await recv(clipUrl({ t: "記事A", u: "https://ex.com/a", n: "選択1", c: "調べる", f: "", k: K1 }));
  ok(r.status === "saved" && r.flag && nTitle(r, "記事A") === 1, "番号つき(k): 保存して saved と合図", r.status);
  ok(r.memos.find((m) => m.title === "記事A").body.includes("選択1"), "n はこれまでどおり本文（選んだ文章）として入る");
  r = await recv(clipUrl({ t: "記事A", u: "https://ex.com/a", n: "選択1", c: "調べる", f: "", k: K1 }));
  ok(r.status === "dup" && r.flag && nTitle(r, "記事A") === 1, "同じ番号がもう一度届いたら dup（2件目は作らない・保存済みの合図も立てる）", r.status);
  r = await recv(clipUrl({ t: "記事A", u: "https://ex.com/a", n: "選択1", c: "調べる", f: "", k: K3 }));
  ok(r.status === "saved" && nTitle(r, "記事A") === 2, "別の番号なら、同じページ・同じ内容でも新しいメモにする", r.status);

  r = await recv(clipUrl({ t: "記事B", u: "https://ex.com/b", n: "x" }, "?kn_clip=" + K2));
  ok(r.status === "saved" && nTitle(r, "記事B") === 1 && /kn_clip=/.test(r.href) && !/#/.test(r.href), "番号つき(?kn_clip=): 保存する（クエリは残し、# だけ消す）", r);
  r = await recv(clipUrl({ t: "記事B", u: "https://ex.com/b", n: "x" }, "?kn_clip=" + K2));
  ok(r.status === "dup" && nTitle(r, "記事B") === 1, "同じ ?kn_clip= がもう一度届いたら dup", r.status);
  const stored = await (async () => { const p = await ctx.newPage(); await p.goto(BASE + "__blank.html"); const v = await p.evaluate(() => JSON.parse(localStorage.getItem("kininari:clipNonces") || "[]")); await p.close(); return v; })();
  ok(Array.isArray(stored) && stored.some((x) => x.n === K1 && x.at) && stored.some((x) => x.n === K2), "受け取った番号は kininari:clipNonces に残る", stored);

  // 番号の無いクリップ（古い拡張・Recall）
  r = await recv(clipUrl({ t: "記事C", u: "https://ex.com/c", n: "選択1" }));
  ok(r.status === "saved" && nTitle(r, "記事C") === 1, "番号なし: 保存する");
  r = await recv(clipUrl({ t: "記事C", u: "https://ex.com/c#part", n: "選択2" }));
  ok(r.status === "saved" && nTitle(r, "記事C") === 2, "番号なし: 同じページでも選んだ文章が違えば新しいメモにする", { status: r.status, n: nTitle(r, "記事C") });
  r = await recv(clipUrl({ t: "記事C", u: "https://ex.com/c", n: "選択2" }));
  ok(r.status === "dup" && r.flag && nTitle(r, "記事C") === 2, "番号なし: 10分以内に同じページ・同じ題名・同じ文章なら dup", r.status);
  r = await recv(clipUrl({ t: "記事C（別題）", u: "https://ex.com/c", n: "選択2" }));
  ok(r.status === "saved", "番号なし: 題名が違えば新しいメモにする", r.status);

  // 受け取れない形
  r = await recv(BASE + "kininari.html#knadd=%7Bbroken");
  ok(r.status === "parse" && !r.flag, "壊れたJSONは parse（保存済みの合図は立てない）", r);
  r = await recv(clipUrl([1, 2]));
  ok(r.status === "parse" && !r.flag, "オブジェクトでないものは parse", r);

  // 長いURL（約32000文字）
  const big = "長".repeat(3600);
  const longUrl = clipUrl({ t: "長いクリップ", u: "https://ex.com/long", n: big, k: "1234567890abcdef1234567890abcdef" });
  r = await recv(longUrl);
  const lm = r.memos.find((m) => m.title === "長いクリップ");
  ok(longUrl.length >= 32000 && r.status === "saved" && lm && lm.body.includes(big), "約" + longUrl.length + "文字のURLでも全部取り込める", { len: longUrl.length, status: r.status });
  await ctx.close();

  // 容量不足
  const ctxQ = await device();
  const fill = await ctxQ.newPage();
  await fill.goto(BASE + "__blank.html");
  await fill.evaluate(() => {
    let size = 1 << 20, i = 0;
    while (size >= 256) {
      try { localStorage.setItem("filler" + (i++), "x".repeat(size)); } catch (e) { size = size >> 1; }
    }
  });
  await fill.close();
  const pq = await ctxQ.newPage();
  await pq.goto(clipUrl({ t: "入らない", u: "https://ex.com/q", n: "y".repeat(20000), k: "abcdefabcdefabcdefabcdefabcdefab" }));
  await pq.waitForSelector(".capture-input");
  await sleep(300);
  const q = await pq.evaluate(() => ({ status: window.__kininariClipStatus, flag: !!window.__kininariClipSaved, nonces: localStorage.getItem("kininari:clipNonces") }));
  ok(q.status === "quota" && !q.flag && !q.nonces, "保存できないときは quota（保存済みの合図も番号も残さない）", q);
  await ctxQ.close();

  // 自動同期中は、Drive へ送り終えてから saved を立てる
  const drive = createFakeDrive();
  const f = drive.put(FILE_NAME, backup([memo("s1", "Driveのメモ", { synced: 1 })]));
  const ctxS = await device({ drive });
  await preset(ctxS, linkedLS({ file: f.id, sync: f.modifiedTime, auto: true }));
  const ps = await ctxS.newPage();
  await ps.goto(clipUrl({ t: "送ってから合図", u: "https://ex.com/s", n: "z", k: "9999aaaa9999aaaa9999aaaa9999aaaa" }));
  let seenAt = null;
  await waitFor(async () => {
    const s = await ps.evaluate(() => window.__kininariClipStatus || "");
    if (s) seenAt = { s, onDrive: driveMemos(drive, f.id).some((m) => m.title === "送ってから合図") };
    return !!s;
  }, { timeout: 15000, interval: 5, label: "saved" }).catch(() => {});
  ok(seenAt && seenAt.s === "saved" && seenAt.onDrive, "saved の合図は Drive に載ってから立つ", seenAt);
  await ctxS.close();
});

/* ── 10. 送信の直前にほかの端末が書いた分を消さない ───────────────────── */
await section("10 sync: 書く直前の確認（取りこぼし防止）", async () => {
  const drive = createFakeDrive();
  const base1 = [memo("a1", "最初のメモ", { synced: 1 })];
  const f = drive.put(FILE_NAME, backup(base1));
  let mode = "off", writes = 0;
  const wrap = async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    await drive.handle(route);
    const isMeta = req.method() === "GET" && /\/drive\/v3\/files\/[^/]+$/.test(u.pathname) && !u.searchParams.get("alt");
    if (isMeta && (mode === "once" || mode === "always")) {
      writes++;
      drive.write(f.id, backup([...base1, memo("b" + writes, "他端末" + writes, { synced: 1 })]));
      if (mode === "once") mode = "off";
    }
  };
  const ctx = await device({ wrapDrive: wrap });
  await preset(ctx, { ...linkedLS({ file: f.id, sync: f.modifiedTime }), [DATA_KEY]: { memos: base1, notebooks: [] } });
  const { page } = await openApp(ctx);
  await page.fill(".capture-input", "この端末の新しいメモ");
  await page.press(".capture-input", "Enter");
  await openDataModal(page);
  mode = "once";
  const msg = await clickAndWaitMsg(page, "Driveへ保存（アップロード）");
  const dm = titlesOf(driveMemos(drive, f.id));
  ok(/保存しました/.test(msg) && dm.includes("他端末1") && dm.includes("この端末の新しいメモ") && dm.includes("最初のメモ"), "送信中に他端末が書いた分も残る（取り込み直してから書く）", { msg, dm });

  // 書くたびに毎回割り込まれるときは、3回で諦めて上書きしない
  await page.fill(".capture-input", "もう1件");
  await page.press(".capture-input", "Enter");
  mode = "always";
  const msg2 = await clickAndWaitMsg(page, "Driveへ保存（アップロード）");
  mode = "off";
  const dm2 = titlesOf(driveMemos(drive, f.id));
  ok(!/保存しました/.test(msg2) && dm2.includes("他端末" + writes) && !dm2.includes("もう1件"), "割り込みが続くときは上書きせずに知らせる", { msg2, dm2, writes });
  await ctx.close();
});

/* ── 11. 覚えているファイルが消えた・ゴミ箱に入った ───────────────────── */
await section("11 sync: 同期ファイルの削除・ゴミ箱", async () => {
  // (a) 覚えているIDのファイルが無い → 名前で探し直してマージ
  const drive = createFakeDrive();
  const f = drive.put(FILE_NAME, backup([memo("r1", "Driveにあるメモ", { synced: 1 })]));
  const ctx = await device({ drive });
  await preset(ctx, { ...linkedLS({ file: "gone123", sync: "2026-10-01T00:00:00.000Z" }),
    [DATA_KEY]: { memos: [memo("k1", "前に送ったメモ", { synced: 1 }), memo("k2", "まだ送っていないメモ")], notebooks: [] } });
  const { page } = await openApp(ctx);
  await openDataModal(page);
  const msg = await clickAndWaitMsg(page, "Driveへ保存（アップロード）");
  const dm = titlesOf(driveMemos(drive, f.id));
  ok(/保存しました/.test(msg), "覚えているファイルが消えていても保存できる", msg);
  ok(["Driveにあるメモ", "前に送ったメモ", "まだ送っていないメモ"].every((t) => dm.includes(t)), "名前で見つけたファイルとマージする（どちらのメモも消えない）", dm);
  ok((await ls(page, "kininari:gd:file")) === f.id, "同期先のIDを見つけたファイルに直す");
  await ctx.close();

  // (b) 覚えているIDのファイルがゴミ箱の中 → 使わない（ほかに無ければ新しく作る）
  const drive2 = createFakeDrive();
  const t = drive2.put(FILE_NAME, backup([memo("t1", "ゴミ箱の中", { synced: 1 })]));
  t.trashed = true;
  const tBefore = drive2.text(t.id);
  const ctx2 = await device({ drive: drive2 });
  await preset(ctx2, { ...linkedLS({ file: t.id, sync: t.modifiedTime }), [DATA_KEY]: { memos: [memo("u1", "この端末のメモ")], notebooks: [] } });
  const { page: p2 } = await openApp(ctx2);
  await openDataModal(p2);
  const msg2 = await clickAndWaitMsg(p2, "Driveへ保存（アップロード）");
  const live = drive2.byName(FILE_NAME);
  const newId = await ls(p2, "kininari:gd:file");
  ok(/保存しました/.test(msg2) && live.length === 1 && live[0].id !== t.id && newId === live[0].id, "ゴミ箱のファイルには書かず、新しいファイルを使う", { msg2, newId, live: live.map((x) => x.id), trashed: t.id });
  ok(drive2.text(t.id) === tBefore, "ゴミ箱のファイルの中身は変えない");
  ok(live[0] && titlesOf(driveMemos(drive2, live[0].id)).includes("この端末のメモ"), "新しいファイルにこの端末のメモが載る");
  await ctx2.close();

  // (c) 開いたときの自動同期でも、消えたIDに固執しない
  const drive3 = createFakeDrive();
  const f3 = drive3.put(FILE_NAME, backup([memo("r3", "Driveのメモ3", { synced: 1 })]));
  const ctx3 = await device({ drive: drive3 });
  await preset(ctx3, { ...linkedLS({ file: "gone456", sync: "2026-10-01T00:00:00.000Z", auto: true }), [DATA_KEY]: { memos: [memo("k3", "端末のメモ3", { synced: 1 })], notebooks: [] } });
  const { page: p3 } = await openApp(ctx3);
  await waitFor(async () => (await ls(p3, "kininari:gd:file")) === f3.id, { timeout: 10000, label: "探し直し" }).catch(() => {});
  const d3 = await lsData(p3);
  ok((await ls(p3, "kininari:gd:file")) === f3.id && titlesOf(d3.memos).includes("Driveのメモ3") && titlesOf(d3.memos).includes("端末のメモ3"), "開いたときの自動同期でも探し直してマージする", titlesOf(d3.memos));
  await ctx3.close();
});

/* ── 12. 本文の画像の blob: URL を返す ───────────────────────────── */
await section("12 blob: 本文が変わったら前の blob: URL を返す", async () => {
  const ctx = await device();
  await ctx.addInitScript(() => {
    window.__revoked = [];
    const rv = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u) => { window.__revoked.push(u); return rv(u); };
  });
  await preset(ctx, { [DATA_KEY]: { memos: [memo("i1", "画像つき", { body: '<p>一枚目</p><img data-kid="kimg1" alt="">' })], notebooks: [] } });
  const { page } = await openApp(ctx);
  await page.evaluate(() => idbPut({ id: "kimg1", blob: new Blob(["x"], { type: "image/png" }), name: "a", type: "image/png", size: 1, at: Date.now() }));
  await page.click('.card .title:text-is("画像つき")');
  await page.waitForSelector('.kn-full .memo-rich img[src^="blob:"]', { timeout: 5000, state: "attached" });
  const u1 = await page.getAttribute(".kn-full .memo-rich img", "src");
  await page.evaluate((k) => {
    const d = JSON.parse(localStorage.getItem(k));
    d.memos[0] = { ...d.memos[0], body: '<p>二枚目</p><img data-kid="kimg1" alt="">', updatedAt: Date.now() };
    const v = JSON.stringify(d);
    localStorage.setItem(k, v);
    window.dispatchEvent(new StorageEvent("storage", { key: k, newValue: v }));
  }, DATA_KEY);
  await page.waitForSelector('.kn-full .memo-rich:has-text("二枚目") img[src^="blob:"]', { timeout: 5000, state: "attached" });
  const u2 = await page.getAttribute(".kn-full .memo-rich img", "src");
  const revoked = await page.evaluate(() => window.__revoked);
  ok(u1 !== u2 && revoked.includes(u1) && !revoked.includes(u2), "本文が変わったら前の blob: URL を返し、新しいものは使い続ける", { u1, u2, revoked });
  await ctx.close();
});

await browser.close();
await server.close();
done();
