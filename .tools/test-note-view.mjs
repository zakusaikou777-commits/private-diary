/* ============================================================
   気になり帳（kininari.html）の「ノート表示」（OneNote風）の検証

     node .tools/test-note-view.mjs              … 全部
     node .tools/test-note-view.mjs canvas pdf   … 名前に含む節だけ

   画面はふだん 1400×900（狭い画面の節だけ 390×844）。2台の端末は fake-drive.mjs を共有し、
   Googleログインは gis-stub.js に差し替える（.tools/lib/harness.mjs）。
   PDF は検証の中で手書きする（1ページ・Helvetica の文字と青い四角。xref の位置も正しく書く）。
   ============================================================ */
import path from "node:path";
import fs from "node:fs";
import { ROOT, startServer, launch, newDevice, collectErrors, makeChecker, sleep, waitFor } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const ONLY = process.argv.slice(2);
const { ok, done } = makeChecker("test-note-view");
const DATA_KEY = "kininari:data:v2";
const FILE_NAME = "kininari-data.json";
const GD_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.events";
const WIDE = { width: 1400, height: 900 };
const NARROW = { width: 390, height: 844 };
const ICON_B64 = fs.readFileSync(path.join(ROOT, "icon-192.png")).toString("base64");

const server = await startServer(ROOT);
const BASE = server.url;
const browser = await launch();

/* ── 共通の部品 ─────────────────────────────────────────── */
/** 小さな PDF（各ページに文字＋塗りつぶしの四角）。xref の各行は20バイト、位置は実際のバイト数で書く */
function makePdf(text, pages = 1) {
  const font = 3 + pages * 2;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => (3 + i * 2) + " 0 R").join(" ")}] /Count ${pages} >>`
  ];
  for (let i = 0; i < pages; i++) {
    const stream = `0.25 0.4 0.75 rg 20 20 260 50 re f\nBT /F1 30 Tf 24 110 Td (${text} ${i + 1}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    objs.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const PDF_B64 = makePdf("Hello PDF").toString("base64");
const PDF25_B64 = makePdf("Page", 25).toString("base64");

const scopedTokenLS = (scope = GD_SCOPE) => ({ "shared:gd:token": JSON.stringify({ token: "fake." + Buffer.from(scope).toString("base64"), exp: Date.now() + 3600 * 1000, scope }) });
let clock = Date.now() - 3600 * 1000;
function memo(id, title, extra = {}) {
  clock += 1000;
  return { id, title, body: "", category: "メモ", tags: [], links: [], notebookId: null, date: null, time: null,
    remind: null, srs: null, attachments: [], done: false, pinned: false, createdAt: clock, updatedAt: clock, ...extra };
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
async function openApp(ctx) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  page.on("dialog", (dlg) => dlg.accept().catch(() => {}));
  await page.goto(BASE + "kininari.html");
  await page.waitForSelector(".capture-input, .nv", { timeout: 15000 });
  return { page, errors };
}
const lsData = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), DATA_KEY);
const memoOf = async (page, id) => ((await lsData(page)) || { memos: [] }).memos.find((m) => m.id === id) || null;
const memoByTitle = async (page, t) => ((await lsData(page)) || { memos: [] }).memos.find((m) => m.title === t) || null;
const snap8 = (v) => Math.round(v / 8) * 8;
async function toNote(page) {
  await page.click('.vs-b:has-text("ノート表示")');
  await page.waitForSelector(".nv");
}
async function selectPage(page, title) {
  await page.click(`.npg-item:has(.npg-tt:text-is("${title}"))`);
  await page.waitForFunction((t) => { const i = document.querySelector(".np-title"); return i && i.value === t; }, title);
}
/** ページの紙の上の座標（倍率 100% のとき）を画面の座標にする */
async function canvasToScreen(page, x, y) {
  return page.evaluate(([x, y]) => {
    const r = document.querySelector(".nc-canvas").getBoundingClientRect();
    const m = /scale\(([\d.]+)\)/.exec(document.querySelector(".nc-canvas").style.transform || "");
    const z = m ? Number(m[1]) : 1;
    return { x: r.left + x * z, y: r.top + y * z };
  }, [x, y]);
}
async function blockBox(page, id, sel = "") {
  return page.locator(`.nb[data-bid="${id}"] ${sel}`.trim()).first().boundingBox();
}
async function dragBy(page, box, dx, dy, at = "center") {
  const sx = at === "center" ? box.x + box.width / 2 : box.x + box.width - 2;
  const sy = at === "center" ? box.y + box.height / 2 : box.y + box.height - 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dx / 2, sy + dy / 2, { steps: 4 });
  await page.mouse.move(sx + dx, sy + dy, { steps: 4 });
  await page.mouse.up();
}
/** 画面の中で画像（w×h の単色 PNG）を作って貼り付ける（今いる要素に paste を送る） */
async function pastePng(page, w, h) {
  await page.evaluate(([w, h]) => new Promise((res) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#c0463c"; g.fillRect(0, 0, w, h);
    c.toBlob((b) => {
      const dt = new DataTransfer();
      dt.items.add(new File([b], "shot.png", { type: "image/png" }));
      (document.activeElement || document.body).dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
      res();
    }, "image/png");
  }), [w, h]);
}
/** デスクトップからファイルを落としたことにする（画面の座標 x,y の要素に dragover → drop） */
async function dropFile(page, x, y, { name, type, b64 }) {
  await page.evaluate(({ x, y, name, type, b64 }) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u], name, { type }));
    const el = document.elementFromPoint(x, y);
    const opt = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt };
    el.dispatchEvent(new DragEvent("dragover", opt));
    el.dispatchEvent(new DragEvent("drop", opt));
  }, { x, y, name, type, b64 });
}
/** PDF の絵に、白くない点がいくつあるか */
const pdfInk = (page, scope = "") => page.evaluate((scope) => {
  const c = document.querySelector(scope + " .nb-pdf canvas[data-done]");
  if (!c || !c.width) return 0;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) n++;
  return n;
}, scope);
const waitSaved = (page, id, pred, label, timeout = 6000) => waitFor(async () => { const m = await memoOf(page, id); return m && pred(m) ? m : null; }, { timeout, label }).catch(() => null);

async function section(name, fn) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
  console.log("\n■ " + name);
  try { await fn(); }
  catch (e) { ok(false, name + " が途中で止まった", String(e && e.stack || e).split("\n").slice(0, 4).join(" | ")); }
}

/* 見本のデータ: フォルダ2つ（1つは入れ子）とメモ */
const FOLDERS = [
  { id: "fa", name: "仕事", color: "#3E6CA3", parentId: null, pinned: false, createdAt: 1000, updatedAt: 1000 },
  { id: "fb", name: "読書", color: "#57845A", parentId: null, pinned: false, createdAt: 2000, updatedAt: 2000 },
  { id: "fc", name: "小説", color: "#C98A1B", parentId: "fb", pinned: false, createdAt: 3000, updatedAt: 3000 }
];
const baseMemos = () => [
  memo("m1", "会議のメモ", { notebookId: "fa", body: "<p>議題は<b>三つ</b></p>" }),
  memo("m2", "", { notebookId: "fa", body: "題名の無いページ" }),
  memo("m3", "ピン留めのページ", { notebookId: "fa", pinned: true }),
  memo("m4", "読みたい本", { notebookId: "fb" }),
  memo("m5", "フォルダなしのメモ", { body: "素の文章\n二行目 Q&amp;A" })
];

/* ── 1. 切り替え ─────────────────────────────────────────── */
await section("1 toggle: カード表示とノート表示の切り替え（端末に覚える）", async () => {
  const ctx = await device();
  const { page, errors } = await openApp(ctx);
  ok(await page.$(".capture-input") && !(await page.$(".nv")), "はじめはカード表示（今までどおり）");
  ok((await page.getAttribute('.vs-b:has-text("カード表示")', "aria-pressed")) === "true", "切り替えのボタンがカード表示を指している");
  await toNote(page);
  ok(await page.$(".nv .ns") && await page.$(".nv .npg") && await page.$(".nv .np-area"), "ノート表示で3つの面が出る");
  ok((await page.evaluate(() => localStorage.getItem("kininari:note:view"))) === "\"note\"", "表示の種類を端末に覚える（kininari:note:view）");
  await page.reload();
  await page.waitForSelector(".nv", { timeout: 10000 });
  ok(!(await page.$(".capture-input")), "読み込み直してもノート表示のまま");
  await page.click('.vs-b:has-text("カード表示")');
  await page.waitForSelector(".capture-input");
  await page.reload();
  await page.waitForSelector(".capture-input");
  ok(!(await page.$(".nv")), "カード表示に戻すと、読み込み直してもカード表示");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 2. 3つの面・区切り・たたむ ───────────────────────────── */
await section("2 panes: フォルダ・ページ一覧・区切りの幅", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: baseMemos(), notebooks: FOLDERS }, "kininari:note:view": "\"note\"" });
  const { page, errors } = await openApp(ctx);
  await page.waitForSelector(".ns-row");
  const rows = await page.$$eval(".ns-row .nm", (els) => els.map((e) => e.textContent));
  ok(rows[0] === "すべて" && rows[1] === "フォルダなし" && rows.includes("仕事") && rows.includes("読書") && !rows.includes("小説"), "左に すべて・フォルダなし・フォルダ（入れ子は閉じたまま）", rows);
  const tab = await page.$eval('.ns-row:has(.nm:text-is("仕事")) .ns-tab', (e) => getComputedStyle(e).backgroundColor);
  ok(tab === "rgb(62, 108, 163)", "フォルダの色が見出しの帯になる", tab);
  await page.click('.ns-row:has(.nm:text-is("読書")) .tw');
  ok(await page.$('.ns-row:has(.nm:text-is("小説"))'), "矢印で入れ子のフォルダが開く");
  const cnt = await page.$eval('.ns-row:has(.nm:text-is("仕事")) .cnt', (e) => e.textContent);
  ok(cnt === "3", "フォルダのページ数が出る", cnt);
  await page.click('.ns-row:has(.nm:text-is("仕事")) .ns-name');
  const items = await page.$$eval(".npg-item .npg-tt", (els) => els.map((e) => e.textContent));
  ok(items.length === 3 && items[0] === "ピン留めのページ", "フォルダのページだけが並び、ピン留めが先頭", items);
  ok(items.includes("（無題）"), "題名の無いページは「（無題）」", items);
  await page.click('.ns-row:has(.nm:text-is("フォルダなし")) .ns-name');
  const items2 = await page.$$eval(".npg-item .npg-tt", (els) => els.map((e) => e.textContent));
  ok(items2.length === 1 && items2[0] === "フォルダなしのメモ", "「フォルダなし」はどこにも入っていないページだけ", items2);
  // 検索欄は中の一覧の上にあり、全体から探す
  await page.fill(".nv-search input", "読みたい");
  await sleep(150);
  const items3 = await page.$$eval(".npg-item .npg-tt", (els) => els.map((e) => e.textContent));
  ok(items3.length === 1 && items3[0] === "読みたい本", "検索はフォルダに関係なく全体から", items3);
  await page.fill(".nv-search input", "");
  // 区切りをドラッグして幅を変える → 読み込み直しても同じ → ダブルクリックで元の幅
  const w0 = (await page.locator(".ns").boundingBox()).width;
  const sp = await page.locator(".nsplit").first().boundingBox();
  await dragBy(page, sp, 80, 0);
  const w1 = (await page.locator(".ns").boundingBox()).width;
  ok(Math.abs(w0 - 240) < 2 && Math.abs(w1 - 320) < 2, "左の区切りをドラッグすると幅が変わる", { w0, w1 });
  const sp2 = await page.locator(".nsplit").nth(1).boundingBox();
  await dragBy(page, sp2, -60, 0);
  const m1 = (await page.locator(".npg").boundingBox()).width;
  ok(Math.abs(m1 - 220) < 2, "中の区切りでページ一覧の幅が変わる", m1);
  await page.reload();
  await page.waitForSelector(".ns");
  const w2 = (await page.locator(".ns").boundingBox()).width, m2 = (await page.locator(".npg").boundingBox()).width;
  ok(Math.abs(w2 - 320) < 2 && Math.abs(m2 - 220) < 2, "幅は端末に覚え、読み込み直しても同じ", { w2, m2, saved: await page.evaluate(() => localStorage.getItem("kininari:note:w")) });
  await page.dblclick(".nsplit >> nth=0");
  const w3 = (await page.locator(".ns").boundingBox()).width;
  ok(Math.abs(w3 - 240) < 2, "ダブルクリックで元の幅に戻る", w3);
  const sp3 = await page.locator(".nsplit").first().boundingBox();
  await dragBy(page, sp3, 900, 0);
  const w4 = (await page.locator(".ns").boundingBox()).width;
  ok(Math.abs(w4 - 420) < 2, "幅には上限がある", w4);
  await page.dblclick(".nsplit >> nth=0");
  // ≡ で左をたたむ
  await page.click(".ns-head .ns-ham");
  ok(!(await page.$(".ns")) && await page.$(".ns-mini"), "≡ で左の一覧をたたむ");
  await page.reload();
  await page.waitForSelector(".nv");
  ok(!(await page.$(".ns")) && await page.$(".ns-mini"), "たたんだことも覚える");
  await page.click(".ns-mini .ns-ham");
  ok(await page.$(".ns"), "もう一度押すと出る");
  // ページを左のフォルダへドラッグして移す
  await page.click('.ns-row:has(.nm:text-is("すべて")) .ns-name');
  await page.dragAndDrop('.npg-item:has(.npg-tt:text-is("読みたい本"))', '.ns-row:has(.nm:text-is("仕事"))');
  const m4 = await waitSaved(page, "m4", (m) => m.notebookId === "fa", "ドラッグでの移動");
  ok(m4 && m4.notebookId === "fa", "ページを左のフォルダへドラッグすると、そのフォルダへ移る", m4 && m4.notebookId);
  await page.dragAndDrop('.npg-item:has(.npg-tt:text-is("読みたい本"))', '.ns-row:has(.nm:text-is("フォルダなし"))');
  const m4b = await waitSaved(page, "m4", (m) => m.notebookId === null, "フォルダなしへ");
  ok(m4b && m4b.notebookId === null, "「フォルダなし」へ落とすとフォルダから出る");
  // 新しいフォルダ（Enter で作る。変換中の Enter では作らない）
  await page.click(".ns-add");
  await page.fill(".ns-form input", "旅行");
  await page.press(".ns-form input", "Enter");
  await page.waitForSelector('.ns-row.on:has(.nm:text-is("旅行"))');
  ok((await lsData(page)).notebooks.some((f) => f.name === "旅行"), "＋新しいフォルダで作り、そのフォルダを開く");
  // フォルダの操作は今までの画面（名前の変更・削除など）
  await page.click('.ns-row:has(.nm:text-is("旅行")) .ns-more');
  await page.waitForSelector('.modal .fa-btn:has-text("名前を変更")');
  ok(true, "⋯ でフォルダの操作（今までの画面）が開く");
  await page.click(".modal .modal-close");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 3〜8. ページの中身（箱）────────────────────────────────── */
await section("3 canvas: ページの追加・文字の箱・画像・ドラッグ・大きさ・削除・元に戻す", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: baseMemos(), notebooks: FOLDERS }, "kininari:note:view": "\"note\"" });
  const { page, errors } = await openApp(ctx);
  await page.click('.ns-row:has(.nm:text-is("読書")) .ns-name');
  await page.click(".npg-add");
  await page.waitForSelector(".np-title");
  ok(await page.evaluate(() => document.activeElement === document.querySelector(".np-title")), "＋ページの追加でタイトルに焦点が来る");
  const fresh = (await lsData(page)).memos[0];
  ok(fresh.title === "" && fresh.notebookId === "fb" && !fresh.canvas, "選んでいるフォルダに、題名の空のページができる（中身はまだ書かない）", { t: fresh.title, nb: fresh.notebookId });
  const id = fresh.id;
  ok((await page.$$eval(".npg-item.on .npg-tt", (e) => e.map((x) => x.textContent))).join() === "（無題）", "作ったページが一覧で選ばれている");
  await page.keyboard.type("ノートの検証");
  const mt = await waitSaved(page, id, (m) => m.title === "ノートの検証", "題名の自動保存");
  ok(mt, "題名は打つと自動で保存される");
  ok((await page.textContent(".np-when")).match(/\d+年\d+月\d+日\(.\)\s+\d\d:\d\d/), "タイトルの下に作った日時が出る", await page.textContent(".np-when"));

  // 何も無い所を押すと、そこに文字の箱ができて書ける
  const cv = await page.locator(".nc-canvas").boundingBox();
  const P = { x: 300, y: 200 };
  await page.mouse.click(cv.x + P.x, cv.y + P.y);
  await page.waitForSelector(".nb-text:focus");
  await page.keyboard.type("はじめての箱");
  const m1 = await waitSaved(page, id, (m) => m.canvas && m.canvas.blocks.some((b) => b.t === "text" && /はじめての箱/.test(b.html)), "文字の自動保存");
  const tb = m1 && m1.canvas.blocks.find((b) => b.t === "text");
  ok(tb && tb.x === snap8(P.x - 8) && tb.y === snap8(P.y - 14), "押した所に箱ができ、位置は 8px の升目にそろう", tb && { x: tb.x, y: tb.y });
  ok(m1 && m1.body === "はじめての箱", "本文（body）は箱から作られる", m1 && m1.body);
  ok(m1 && await page.evaluate((m) => noteSigOf(m.body) === m.canvas.sig && m.canvas.v === 1, m1), "canvas に v と sig（本文の指紋）が入る");
  const t1 = await page.evaluate(() => Date.now());

  // 空の箱は、焦点が外れたら片付ける
  await page.mouse.click(cv.x + 700, cv.y + 500);
  await page.waitForSelector(".nb-text:focus");
  const emptyId = await page.evaluate(() => document.activeElement.closest(".nb").getAttribute("data-bid"));
  const nEmpty = await page.$$eval(".nb-text", (e) => e.length);
  await page.mouse.click(cv.x + 600, cv.y + 100);
  await sleep(100);
  const nAfter = await page.$$eval(".nb-text", (e) => e.length);
  ok(nEmpty === 2 && nAfter === 2 && !(await page.$(`.nb[data-bid="${emptyId}"]`)), "何も書かなかった箱は片付く（新しく押した所にまた箱ができる）", { nEmpty, nAfter });
  ok(!(await memoOf(page, id)).canvas.blocks.some((b) => b.id === emptyId), "作っただけの空の箱は保存しない");
  await page.keyboard.press("Escape");

  // 画像を貼る: 押した所（空の箱）に画像の箱ができる
  const Q = { x: 120, y: 360 };
  await page.mouse.click(cv.x + Q.x, cv.y + Q.y);
  await page.waitForSelector(".nb-text:focus");
  await pastePng(page, 200, 100);
  await page.waitForSelector(".nb-img img[src^='blob:']", { timeout: 8000 });
  const m2 = await waitSaved(page, id, (m) => m.canvas && m.canvas.blocks.some((b) => b.t === "img"), "画像の箱の保存");
  const ib = m2 && m2.canvas.blocks.find((b) => b.t === "img");
  ok(ib && ib.x === snap8(Q.x - 8) && ib.y === snap8(Q.y - 14) && ib.w === 200 && ib.h === 100, "貼り付けた画像が、押した所に元の縦横比で置かれる", ib);
  ok(m2 && (await page.$$eval(".nb-text", (e) => e.length)) === 1, "画像を貼った空の箱は片付く");
  ok(m2 && new RegExp(`<img data-kid="${ib.kid}"`).test(m2.body), "画像は本文に <img data-kid> として入る（以前の版でも見える）", m2 && m2.body);
  const rec = await page.evaluate((k) => idbGet(k).then((r) => r && { at: r.at, size: r.size, type: r.type }), ib.kid);
  ok(rec && rec.at >= t1 - 60000 && rec.size > 0, "画像は添付と同じ形で端末に置く（at つき）", rec);
  ok(await page.evaluate((k) => pendingFileIds.has(k), ib.kid), "保存されるまで掃除しない印（pendingFileIds）に入る");

  // 帯をドラッグして動かす（8px の升目にそろう）
  const bar = await blockBox(page, ib.id, ".nb-bar");
  await dragBy(page, bar, 53, 37);
  const m3 = await waitSaved(page, id, (m) => { const b = m.canvas.blocks.find((x) => x.id === ib.id); return b && b.x !== ib.x; }, "移動の保存");
  const ib3 = m3 && m3.canvas.blocks.find((b) => b.id === ib.id);
  ok(ib3 && ib3.x === snap8(ib.x + 53) && ib3.y === snap8(ib.y + 37), "上の帯をドラッグすると動き、位置は升目にそろう", ib3 && { x: ib3.x, y: ib3.y, want: [snap8(ib.x + 53), snap8(ib.y + 37)] });
  // Ctrl+Z で動かす前に戻る、Ctrl+Y でやり直す
  await page.keyboard.press("Control+z");
  const m3u = await waitSaved(page, id, (m) => { const b = m.canvas.blocks.find((x) => x.id === ib.id); return b && b.x === ib.x && b.y === ib.y; }, "元に戻す");
  ok(m3u, "Ctrl+Z で動かす前の位置に戻る");
  await page.keyboard.press("Control+y");
  const m3r = await waitSaved(page, id, (m) => { const b = m.canvas.blocks.find((x) => x.id === ib.id); return b && b.x === ib3.x; }, "やり直す");
  ok(m3r, "Ctrl+Y でやり直せる");
  // 矢印で少しずつ動かす（Shift で 10px）
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  const m3n = await waitSaved(page, id, (m) => { const b = m.canvas.blocks.find((x) => x.id === ib.id); return b && b.x === ib3.x + 1 && b.y === ib3.y + 10; }, "矢印");
  ok(m3n, "矢印で 1px、Shift＋矢印で 10px 動く");

  // 右下の角で大きさを変える（縦横比はそのまま）
  const corner = await blockBox(page, ib.id, ".nb-rc");
  await dragBy(page, corner, 80, 10);
  const m4 = await waitSaved(page, id, (m) => { const b = m.canvas.blocks.find((x) => x.id === ib.id); return b && b.w !== 200; }, "大きさの保存");
  const ib4 = m4 && m4.canvas.blocks.find((b) => b.id === ib.id);
  ok(ib4 && ib4.w === 280 && ib4.h === 140, "角をドラッグすると縦横比を保ったまま大きくなる", ib4 && { w: ib4.w, h: ib4.h });
  const imgBox = await page.locator(`.nb[data-bid="${ib.id}"] img`).boundingBox();
  ok(Math.abs(imgBox.width - 280) < 2 && Math.abs(imgBox.height - 140) < 2, "画面の画像も同じ大きさ", imgBox);
  // 文字の箱の右の端で幅を変える（文字は折り返す）
  const tid = tb.id;
  const tw0 = (await blockBox(page, tid)).width;
  await page.hover(`.nb[data-bid="${tid}"] .nb-text`);
  const rw = await blockBox(page, tid, ".nb-rw");
  await dragBy(page, rw, -150, 0);
  const m5 = await waitSaved(page, id, (m) => { const b = m.canvas.blocks.find((x) => x.id === tid); return b && b.w < 400; }, "幅の保存");
  const tb5 = m5 && m5.canvas.blocks.find((b) => b.id === tid);
  ok(tb5 && tb5.w === snap8(400 - 150) && Math.abs((await blockBox(page, tid)).width - tb5.w) < 3, "右の端をドラッグすると文字の箱の幅が変わる", { before: tw0, after: tb5 && tb5.w });

  // 選んで Delete → 消える → 「元に戻す」で戻る
  await page.click(`.nb[data-bid="${ib.id}"] img`);
  await page.keyboard.press("Delete");
  const m6 = await waitSaved(page, id, (m) => !m.canvas.blocks.some((b) => b.id === ib.id), "削除の保存");
  ok(m6 && !(await page.$(`.nb[data-bid="${ib.id}"]`)) && !/<img/.test(m6.body), "選んで Delete を押すと箱が消える（本文の画像も消える）");
  ok(await page.$('.nc-toast button:has-text("元に戻す")'), "「元に戻す」が出る");
  await page.click('.nc-toast button:has-text("元に戻す")');
  const m7 = await waitSaved(page, id, (m) => m.canvas.blocks.some((b) => b.id === ib.id), "元に戻すの保存");
  ok(m7 && await page.$(`.nb[data-bid="${ib.id}"] img[src^="blob:"]`), "「元に戻す」で箱が戻る");
  // × ボタンでも消せる
  await page.click(`.nb[data-bid="${ib.id}"] img`);
  await page.click(`.nb[data-bid="${ib.id}"] .nb-x`);
  ok(!(await page.$(`.nb[data-bid="${ib.id}"]`)), "選んだ箱の × でも消せる");
  await page.keyboard.press("Control+z");
  await page.waitForSelector(`.nb[data-bid="${ib.id}"]`);
  ok(true, "Ctrl+Z でも消した箱が戻る");

  // 書式（太字）とリンク
  await page.click(`.nb[data-bid="${tid}"] .nb-text`);
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.click('.nc-tb button[aria-label="太字"]');
  const m8 = await waitSaved(page, id, (m) => /<b>|font-weight/.test(m.canvas.blocks.find((b) => b.id === tid).html), "太字");
  ok(m8 && /<b>|font-weight/.test(m8.body), "書式の道具で太字にできる（本文にも入る）", m8 && m8.body);
  await page.keyboard.press("End");
  await page.click('.nc-tb button[aria-label="リンク"]');
  await page.waitForSelector(".kn-dlg input");
  await page.fill(".kn-dlg input >> nth=0", "例のサイト");
  await page.fill(".kn-dlg input >> nth=1", "example.com/a");
  await page.click('.kn-dlg button:has-text("OK")');
  const m9 = await waitSaved(page, id, (m) => /href="https:\/\/example\.com\/a"/.test(m.body), "リンク");
  ok(m9, "リンクのダイアログで本文にリンクを入れられる（https:// を補う）", m9 && m9.body);
  await page.click('.nc-tb button[aria-label="リンク"]');
  await page.waitForSelector(".kn-dlg input");
  await page.fill(".kn-dlg input >> nth=1", "javascript:alert(1)");
  await page.click('.kn-dlg button:has-text("OK")');
  await sleep(900);
  ok(!/javascript:/i.test((await memoOf(page, id)).body), "javascript: のリンクは入らない");

  // HTML の貼り付けはサニタイズし、ネットの画像は読み込まない
  await page.click(`.nb[data-bid="${tid}"] .nb-text`);
  await page.keyboard.press("End");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/html", '<p>貼った<b>文</b><img src="https://example.com/x.png" onerror="window.__xss=1"><a href="javascript:alert(1)">悪い</a><script>window.__xss=2</script></p>');
    dt.setData("text/plain", "貼った文");
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  });
  const m10 = await waitSaved(page, id, (m) => /貼った/.test(m.body), "HTML の貼り付け");
  const html10 = m10 ? m10.canvas.blocks.find((b) => b.id === tid).html : "";
  ok(m10 && /<b>文<\/b>/.test(html10) && !/example\.com\/x\.png|onerror|<script|javascript:/i.test(html10 + m10.body), "貼った HTML はサニタイズされ、ネットの画像・スクリプト・危ないリンクは残らない", html10);
  ok(!(await page.evaluate(() => window.__xss)), "貼り付けでスクリプトが動かない");

  // 画像の箱を「挿入」から入れる（最後に押した所 / いちばん下）
  await page.keyboard.press("Escape");
  await page.setInputFiles(".nc-tb input[type=file]", { name: "icon.png", mimeType: "image/png", buffer: Buffer.from(ICON_B64, "base64") });
  const m11 = await waitSaved(page, id, (m) => m.canvas.blocks.filter((b) => b.t === "img").length === 2, "挿入");
  ok(m11, "「挿入」から画像を入れられる");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 9. PDF ──────────────────────────────────────────────── */
let pdfCtxState = null;
await section("4 pdf: PDF を落とすとページの絵が出る・倍率", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: baseMemos(), notebooks: FOLDERS }, "kininari:note:view": "\"note\"" });
  const { page, errors } = await openApp(ctx);
  const reqs = [];
  page.on("request", (r) => reqs.push(r.url()));
  await selectPage(page, "会議のメモ");
  ok(!reqs.some((u) => /pdfjs/.test(u)), "PDF の無いページでは pdf.js を読まない");
  const id = "m1";
  const D = { x: 280, y: 120 };
  const pt = await canvasToScreen(page, D.x, D.y);
  await dropFile(page, pt.x, pt.y, { name: "見本.pdf", type: "application/pdf", b64: PDF_B64 });
  await page.waitForSelector(".nb-pdf canvas[data-done]", { timeout: 20000 });
  const m = await waitSaved(page, id, (m) => m.canvas && m.canvas.blocks.some((b) => b.t === "pdf"), "PDF の保存");
  const pb = m && m.canvas.blocks.find((b) => b.t === "pdf");
  ok(pb && pb.x === snap8(D.x) && pb.y === snap8(D.y), "落とした所に PDF の箱ができる", pb && { x: pb.x, y: pb.y });
  ok((await pdfInk(page)) > 200, "PDF のページが絵として描かれる（白くない点がある）", await pdfInk(page));
  ok(reqs.some((u) => /vendor\/pdfjs\/pdf\.min\.mjs/.test(u)), "pdf.js は同じフォルダの vendor/pdfjs から読む");
  ok(m && m.attachments.some((a) => a.id === pb.kid && a.type === "application/pdf" && a.size > 0), "PDF は添付（attachments）にも入る（以前の版でも添付として見える）", m && m.attachments);
  ok(m && !/data-kid/.test(m.body) && /三つ/.test(m.body), "PDF は本文には入らず、本文の文字はそのまま", m && m.body);
  ok(await page.$('.nb-pdfbar button:has-text("開く")') && await page.$('.nb-pdfbar button:has-text("ダウンロード")'), "PDF の帯に 開く・ダウンロード");
  // 倍率
  await page.click('.nc-zoom button[aria-label="拡大"]');
  await page.click('.nc-zoom button[aria-label="拡大"]');
  const tr = await page.$eval(".nc-canvas", (e) => e.style.transform);
  ok(tr === "scale(1.2)" && (await page.evaluate(() => localStorage.getItem("kininari:note:zoom"))) === "120", "＋で拡大し、倍率を端末に覚える", tr);
  const box = await page.locator(".nc-scroll").boundingBox();
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 200);
  await page.keyboard.up("Control");
  await page.waitForFunction(() => document.querySelector(".nc-canvas").style.transform === "scale(1.1)", null, { timeout: 3000 }).catch(() => {});
  ok((await page.$eval(".nc-canvas", (e) => e.style.transform)) === "scale(1.1)", "Ctrl＋ホイールでも倍率が変わる");
  await sleep(600);
  ok((await pdfInk(page)) > 200, "倍率を変えても PDF が描き直される");
  await page.click(".nc-zoom .zv");
  ok((await page.$eval(".nc-canvas", (e) => e.style.transform)) === "none", "倍率の数字を押すと 100% に戻る");
  // PDF の箱の幅を変えると描き直す
  const rw = await blockBox(page, pb.id, ".nb-rw");
  await dragBy(page, rw, -200, 0);
  await sleep(700);
  const cw = await page.$eval(".nb-pdf canvas[data-done]", (c) => c.width);
  const m2 = await waitSaved(page, id, (mm) => mm.canvas.blocks.find((b) => b.id === pb.id).w < 560, "PDF の幅");
  ok(m2 && cw > 0 && (await pdfInk(page)) > 100, "PDF の箱の幅を変えても描ける", { w: m2 && m2.canvas.blocks.find((b) => b.id === pb.id).w, cw });
  pdfCtxState = { kid: pb.kid };
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 10. 見るだけでは書かない / 以前の版の書き換え ─────────────── */
await section("5 compat: 見るだけでは書かない・以前の版で本文が変わったときの作り直し", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: baseMemos(), notebooks: FOLDERS }, "kininari:note:view": "\"note\"" });
  const { page, errors } = await openApp(ctx);
  const before = await memoOf(page, "m5");
  await page.click('.ns-row:has(.nm:text-is("フォルダなし")) .ns-name');
  await selectPage(page, "フォルダなしのメモ");
  const txt = await page.$eval(".nb-text", (e) => e.innerHTML);
  ok(/素の文章<br>二行目 Q&amp;A/.test(txt), "canvas の無いメモは本文を1つの箱で出す（改行・& もそのまま）", txt);
  const pos = await page.evaluate(() => { const c = document.querySelector(".nc-canvas").getBoundingClientRect(); const b = document.querySelector(".nb").getBoundingClientRect(); return { x: b.left - c.left, y: b.top - c.top }; });
  ok(Math.abs(pos.x - 24) < 2 && Math.abs(pos.y - 24) < 2, "箱は (24, 24) に置かれる", pos);
  await page.click('.ns-row:has(.nm:text-is("すべて")) .ns-name');
  await selectPage(page, "会議のメモ");
  ok(/議題は<b>三つ<\/b>/.test(await page.$eval(".nb-text", (e) => e.innerHTML)), "HTML の本文もそのまま出る");
  await sleep(1200);
  const after = await memoOf(page, "m5");
  ok(JSON.stringify(after) === JSON.stringify(before) && !after.canvas, "見ただけではメモを書き換えない（canvas も作らない）");

  // 画像と PDF と文字のあるページを作り、以前の版が本文だけを書き換えたことにする
  const built = await page.evaluate(async (pdfB64) => {
    const png = await new Promise((r) => { const c = document.createElement("canvas"); c.width = 60; c.height = 40; c.getContext("2d").fillRect(0, 0, 60, 40); c.toBlob(r, "image/png"); });
    const bin = atob(pdfB64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    await idbPut({ id: "kimg1", blob: png, name: "a.png", type: "image/png", size: png.size, at: Date.now() });
    await idbPut({ id: "kpdf1", blob: new Blob([u], { type: "application/pdf" }), name: "b.pdf", type: "application/pdf", size: u.length, at: Date.now() });
    const blocks = [
      { id: "bt1", t: "text", x: 24, y: 40, w: 400, html: "最初の文" },
      { id: "bi1", t: "img", x: 480, y: 40, w: 120, h: 80, kid: "kimg1", name: "a.png", type: "image/png" },
      { id: "bt2", t: "text", x: 24, y: 200, w: 400, html: "次の文" },
      { id: "bp1", t: "pdf", x: 480, y: 240, w: 300, kid: "kpdf1", name: "b.pdf", type: "application/pdf", size: u.length }
    ];
    const m = { id: "cv1", title: "箱のページ", category: "メモ", tags: [], links: [], notebookId: null, date: null, time: null, remind: null, srs: null, attachments: [], done: false, pinned: false, createdAt: Date.now() - 5000, updatedAt: Date.now() - 5000 };
    Object.assign(m, notePatchOf(blocks, m));
    const d = JSON.parse(localStorage.getItem("kininari:data:v2"));
    d.memos.unshift(m);
    localStorage.setItem("kininari:data:v2", JSON.stringify(d));
    return m;
  }, PDF_B64);
  ok(built.body === '<div>最初の文</div><img data-kid="kimg1" alt=""><div>次の文</div>' && built.attachments.length === 1 && built.attachments[0].id === "kpdf1", "本文は読む順（上→下、左→右）に作られる。PDF は添付へ", { body: built.body, att: built.attachments });
  await page.reload();
  await page.waitForSelector(".nv");
  await page.click('.ns-row:has(.nm:text-is("すべて")) .ns-name');
  await selectPage(page, "箱のページ");
  ok((await page.$$(".nb")).length === 4, "保存したとおりの箱が出る（作り直さない）");
  // 以前の版（canvas を知らない）が本文を書き換えた
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("kininari:data:v2"));
    const m = d.memos.find((x) => x.id === "cv1");
    m.body = '<div>古い版で書き直した本文</div><img data-kid="kimg1" alt=""><div>もう一行</div>';
    m.updatedAt = Date.now();
    localStorage.setItem("kininari:data:v2", JSON.stringify(d));
  });
  const stored = await memoOf(page, "cv1");
  await page.reload();
  await page.waitForSelector(".nv");
  await selectPage(page, "箱のページ");
  await page.waitForSelector(".nb-pdf canvas[data-done]", { timeout: 20000 }).catch(() => {});
  const shown = await page.evaluate(() => [...document.querySelectorAll(".nb")].map((e) => {
    const c = document.querySelector(".nc-canvas").getBoundingClientRect(), r = e.getBoundingClientRect();
    return { id: e.getAttribute("data-bid"), x: Math.round(r.left - c.left), y: Math.round(r.top - c.top), text: e.querySelector(".nb-text") ? e.querySelector(".nb-text").innerHTML : null };
  }));
  const img = shown.find((s) => s.id === "bi1"), pdf = shown.find((s) => s.id === "bp1"), texts = shown.filter((s) => s.text != null);
  ok(img && img.x === 480 && img.y === 40 && pdf && pdf.x === 480 && pdf.y === 240, "画像と PDF の箱は位置ごと残る", shown);
  ok(texts.length === 1 && /古い版で書き直した本文/.test(texts[0].text) && /もう一行/.test(texts[0].text) && texts[0].x === 24 && texts[0].y === 40, "文字の箱は新しい本文1つになり、最初の文字の箱の位置に置かれる", texts);
  ok(texts.length === 1 && !/<img/.test(texts[0].text), "画像の箱にある画像は、文字の箱に重ねて出さない");
  await sleep(1000);
  ok(JSON.stringify(await memoOf(page, "cv1")) === JSON.stringify(stored), "作り直しは見るだけでは保存しない");
  // 書くと、作り直した形で保存される（何も失わない）
  await page.click('.nb[data-bid="bt1"] .nb-text');
  await page.keyboard.press("End");
  await page.keyboard.type("！");
  const m2 = await waitSaved(page, "cv1", (m) => /！/.test(m.body), "作り直し後の保存");
  ok(m2 && m2.canvas.blocks.length === 3 && /古い版で書き直した本文/.test(m2.body) && /data-kid="kimg1"/.test(m2.body) && m2.attachments.some((a) => a.id === "kpdf1") && await page.evaluate((m) => noteSigOf(m.body) === m.canvas.sig, m2), "書くと作り直した形で保存し、画像・PDF・文字のどれも失わない", m2 && { body: m2.body, n: m2.canvas.blocks.length });
  // 以前の版で添付が足された（箱の無い添付）→ いちばん下に出る
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("kininari:data:v2"));
    const m = d.memos.find((x) => x.id === "cv1");
    m.attachments.push({ id: "kpdf1x", name: "あとから.pdf", type: "application/pdf", size: 10 });
    localStorage.setItem("kininari:data:v2", JSON.stringify(d));
  });
  await page.reload();
  await page.waitForSelector(".nv");
  await selectPage(page, "箱のページ");
  ok(await page.$('.nb[data-bid="a-kpdf1x"]'), "箱の無い添付（以前の版で足したもの）も箱として出る");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 11. 2台の端末で同期 ─────────────────────────────────── */
await section("6 sync: 箱・画像・PDF が別の端末に届いて描ける", async () => {
  const drive = createFakeDrive();
  const ctxA = await device({ drive });
  await preset(ctxA, { ...scopedTokenLS(), "kininari:gd:linked": "1", "kininari:gd:auto": "1", "kininari:note:view": "\"note\"" });
  const { page: a, errors: eA } = await openApp(ctxA);
  await a.click(".npg-add");
  await a.keyboard.type("同期するページ");
  await a.keyboard.press("Enter");
  await a.waitForSelector(".nb-text:focus");
  await a.keyboard.type("端末Aで書いた");
  const cv = await a.locator(".nc-canvas").boundingBox();
  await a.mouse.click(cv.x + 500, cv.y + 80);
  await a.waitForSelector(".nb-text:focus");
  await pastePng(a, 120, 90);
  await a.waitForSelector(".nb-img img[src^='blob:']");
  const pt = await canvasToScreen(a, 64, 300);
  await dropFile(a, pt.x, pt.y, { name: "同期.pdf", type: "application/pdf", b64: PDF_B64 });
  await a.waitForSelector(".nb-pdf canvas[data-done]", { timeout: 20000 });
  const mA = await waitFor(async () => { const m = await memoByTitle(a, "同期するページ"); return m && m.canvas && m.canvas.blocks.length === 3 ? m : null; }, { label: "端末Aの保存", timeout: 8000 });
  const kids = mA.canvas.blocks.filter((b) => b.kid).map((b) => b.kid);
  const att = await waitFor(() => {
    const names = [...drive.files.values()].filter((f) => !f.trashed).map((f) => f.name);
    const f = drive.byName(FILE_NAME)[0];
    const j = f && drive.json(f.id);
    const m = j && j.memos.find((x) => x.id === mA.id);
    return kids.every((k) => names.includes("kn-att-" + k)) && m && m.canvas && m.canvas.blocks.length === 3 ? { names, m } : null;
  }, { label: "Drive への送信", timeout: 25000 }).catch(() => null);
  ok(att, "端末Aの箱（canvas）と画像・PDF が Drive に載る（添付は kn-att- の別ファイル）", att && att.names);
  const syncFile = drive.byName(FILE_NAME)[0];
  ok(syncFile && !/data:image|data:application/.test(drive.text(syncFile.id)), "同期ファイルには画像・PDF の中身を入れない");
  ok(eA.length === 0, "端末Aにエラーが無い", eA);

  const ctxB = await device({ drive });
  await preset(ctxB, { ...scopedTokenLS(), "kininari:gd:linked": "1", "kininari:gd:auto": "1", "kininari:note:view": "\"note\"" });
  const { page: b, errors: eB } = await openApp(ctxB);
  await waitFor(async () => (await b.$$eval(".npg-item .npg-tt", (e) => e.map((x) => x.textContent))).includes("同期するページ"), { label: "端末Bの受け取り", timeout: 20000 });
  await selectPage(b, "同期するページ");
  await b.waitForSelector(".nb-img img[src^='blob:']", { timeout: 15000 }).catch(() => {});
  await b.waitForSelector(".nb-pdf canvas[data-done]", { timeout: 20000 }).catch(() => {});
  const posA = mA.canvas.blocks.map((x) => [x.id, x.x, x.y].join(":")).sort().join(",");
  const mB = await memoByTitle(b, "同期するページ");
  ok(mB && mB.canvas && mB.canvas.blocks.map((x) => [x.id, x.x, x.y].join(":")).sort().join(",") === posA, "端末Bに同じ位置の箱が届く");
  ok(await b.$(".nb-img img[src^='blob:']"), "端末Bで画像が出る（kn-att から受け取る）");
  ok((await pdfInk(b)) > 200, "端末Bで PDF が描ける");
  ok(/端末Aで書いた/.test(await b.$eval(".nb-text", (e) => e.textContent)), "端末Bで文字の箱が出る");
  ok(await b.evaluate((m) => noteSigOf(m.body) === m.canvas.sig, mB), "届いた本文と指紋が合う（作り直さない）");
  ok(eB.length === 0, "端末Bにエラーが無い", eB);
  await Promise.all([ctxA.close(), ctxB.close()]);
});

/* ── 12. 狭い画面 ────────────────────────────────────────── */
await section("7 narrow: 狭い画面は1枚ずつ・ページは読む順に縦に並ぶ", async () => {
  const ctx = await device({ viewport: NARROW });
  await preset(ctx, { [DATA_KEY]: { memos: baseMemos(), notebooks: FOLDERS } });
  const { page, errors } = await openApp(ctx);
  ok(await page.$(".capture-input"), "狭い画面でも、はじめはカード表示");
  // 箱がばらばらの位置にあるページを入れる
  await page.evaluate(() => {
    const blocks = [
      { id: "n3", t: "text", x: 24, y: 400, w: 300, html: "三番目" },
      { id: "n2", t: "text", x: 400, y: 40, w: 300, html: "二番目" },
      { id: "n1", t: "text", x: 24, y: 40, w: 300, html: "一番目" }
    ];
    const m = { id: "nw1", title: "狭い画面のページ", category: "メモ", tags: [], links: [], notebookId: null, date: null, time: null, remind: null, srs: null, attachments: [], done: false, pinned: false, createdAt: Date.now(), updatedAt: Date.now() };
    Object.assign(m, notePatchOf(blocks, m));
    const d = JSON.parse(localStorage.getItem("kininari:data:v2"));
    d.memos.unshift(m);
    localStorage.setItem("kininari:data:v2", JSON.stringify(d));
  });
  await page.reload();
  await page.waitForSelector(".capture-input");
  await toNote(page);
  ok(await page.$(".nv-narrow .npg") && !(await page.$(".nv-narrow .ns")) && !(await page.$(".nv-narrow .np")), "はじめはページの一覧だけ");
  await page.click('.nv-stackbar button:has-text("フォルダ")');
  ok(await page.$(".nv-narrow .ns") && !(await page.$(".nv-narrow .npg")), "戻るでフォルダの一覧");
  await page.click('.ns-row:has(.nm:text-is("すべて")) .ns-name');
  await page.click('.npg-item:has(.npg-tt:text-is("狭い画面のページ"))');
  await page.waitForSelector(".nv-narrow .np .nc-flow");
  const order = await page.$$eval(".nc-flow > .nb", (e) => e.map((x) => x.getAttribute("data-bid")));
  ok(order.join() === "n1,n2,n3", "箱は読む順（上→下、左→右）に縦に並ぶ", order);
  ok(!(await page.$(".nc-flow .nb-bar")) && !(await page.$(".nc-flow .nb-rw")), "狭い画面では位置を動かす帯は出ない");
  const wide = await page.$eval('.nb[data-bid="n2"]', (e) => e.getBoundingClientRect().width);
  ok(wide > 300, "箱は画面の幅いっぱいに並ぶ", wide);
  await page.click('.nb[data-bid="n2"] .nb-text');
  await page.keyboard.press("End");
  await page.keyboard.type("（追記）");
  const m1 = await waitSaved(page, "nw1", (m) => /（追記）/.test(m.body), "狭い画面での書き込み");
  const b2 = m1 && m1.canvas.blocks.find((b) => b.id === "n2");
  ok(b2 && b2.x === 400 && b2.y === 40, "文字は書ける（位置は変わらない）", b2);
  await page.setInputFiles(".nc-tb input[type=file]", { name: "icon.png", mimeType: "image/png", buffer: Buffer.from(ICON_B64, "base64") });
  const m2 = await waitSaved(page, "nw1", (m) => m.canvas.blocks.some((b) => b.t === "img"), "狭い画面での挿入");
  const ib = m2 && m2.canvas.blocks.find((b) => b.t === "img");
  ok(ib && m2.canvas.blocks.every((b) => b === ib || b.y < ib.y), "挿入したものは、いちばん下に足される", ib);
  const last = await page.$$eval(".nc-flow > .nb", (e) => e[e.length - 1].getAttribute("data-bid"));
  ok(ib && last === ib.id, "画面でもいちばん下に出る");
  await page.click(".np-back");
  ok(await page.$(".nv-narrow .npg"), "‹ 一覧 でページの一覧に戻る");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 13. カード表示との行き来 ─────────────────────────────── */
await section("8 card: カード表示は今までどおり・箱のあるメモの編集はノートの全画面で", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: baseMemos(), notebooks: FOLDERS } });
  const { page, errors } = await openApp(ctx);
  await page.evaluate(() => {
    const blocks = [{ id: "k1", t: "text", x: 24, y: 24, w: 400, html: "ノートで書いた<b>本文</b>" }];
    const m = { id: "cvc", title: "ノートのメモ", category: "メモ", tags: [], links: [], notebookId: null, date: null, time: null, remind: null, srs: null, attachments: [], done: false, pinned: false, createdAt: Date.now(), updatedAt: Date.now() };
    Object.assign(m, notePatchOf(blocks, m));
    const d = JSON.parse(localStorage.getItem("kininari:data:v2"));
    d.memos.unshift(m);
    localStorage.setItem("kininari:data:v2", JSON.stringify(d));
  });
  await page.reload();
  await page.waitForSelector(".capture-input");
  const card = page.locator(".card", { has: page.locator('.title:text-is("ノートのメモ")') });
  ok(/ノートで書いた本文/.test(await card.locator(".body.excerpt").textContent()), "カードの抜粋は本文（body）から");
  // ふつうのメモの編集は今までどおり
  const card5 = page.locator(".card", { has: page.locator('.title:text-is("フォルダなしのメモ")') });
  await card5.locator('button.mini:has-text("編集")').click();
  ok(await page.$(".kn-full .card.editing"), "箱の無いメモの「編集」は今までのエディタ");
  await page.click(".kn-full .btn.ghost:has-text(\"キャンセル\")");
  // 箱のあるメモの「編集」はノートの全画面
  await card.locator('button.mini:has-text("編集")').click();
  await page.waitForSelector(".nv-ov .np");
  ok(!(await page.$(".card.editing")) && (await page.inputValue(".nv-ov .np-title")) === "ノートのメモ", "箱のあるメモの「編集」はノートのページで開く");
  await page.click('.nv-ov .nb[data-bid="k1"] .nb-text');
  await page.keyboard.press("End");
  await page.keyboard.type("を直した");
  await page.click('.nv-ov .kn-full-x');
  await page.waitForSelector(".nv-ov", { state: "detached" });
  const m = await memoOf(page, "cvc");
  ok(m && /本文<\/b>を直した|を直した/.test(m.body), "閉じると待たずに保存される", m && m.body);
  ok(/を直した/.test(await card.locator(".body.excerpt").textContent()), "カードの抜粋にもすぐ反映される");
  // 全画面で読む → 編集 → ノートの全画面を重ねる → 閉じても読む画面は残る
  await card.locator(".title").click();
  await page.waitForSelector(".kn-full .card.in-full");
  await page.click('.kn-full .kn-full-b:has-text("編集")');
  await page.waitForSelector(".nv-ov .np");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".nv-ov", { state: "detached" });
  await sleep(500);
  ok(await page.$(".kn-full .card.in-full"), "ノートの全画面を閉じても、下の読む画面は閉じない");
  await page.keyboard.press("Escape");
  await sleep(200);
  ok(!(await page.$(".kn-full")), "もう一度 Escape で読む画面も閉じる");
  // カードのほかの操作（完了・ピン）はそのまま
  await card.locator(".check").click();
  ok((await memoOf(page, "cvc")).done === true, "カードのチェックはそのまま使える");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 14. データの形・掃除・書き出し ────────────────────────── */
await section("9 data: 壊れた canvas・掃除で消さない・書き出しに入る", async () => {
  const ctx = await device();
  const bad = memo("bad1", "壊れた箱", {
    body: "本文",
    canvas: { v: 1, sig: 5, blocks: [null, 7, { t: "evil", x: 1 }, { t: "text", x: "abc", y: -50, w: 1e9, html: { a: 1 } },
      { t: "img", kid: "bad id!", x: 1, y: 1, w: 1 }, { t: "pdf", kid: "okpdf", x: NaN, y: Infinity, w: -3, size: "12" },
      ...Array.from({ length: 700 }, (_, i) => ({ id: "dup", t: "text", x: i, y: i, w: 100, html: "x" + i }))] }
  });
  const notCanvas = memo("bad2", "canvas が配列", { canvas: [1, 2] });
  await preset(ctx, { [DATA_KEY]: { memos: [bad, notCanvas], notebooks: [] }, "kininari:note:view": "\"note\"" });
  const { page, errors } = await openApp(ctx);
  await page.waitForSelector(".npg-item");
  const n = await page.evaluate((m) => normalizeMemo(m).canvas, bad);
  const first = n.blocks[0], pdf = n.blocks.find((b) => b.t === "pdf");
  ok(n.blocks.length === 500 && new Set(n.blocks.map((b) => b.id)).size === 500, "箱は 500 個まで、id は重ならない", n.blocks.length);
  ok(first.t === "text" && first.x === 24 && first.y === 0 && first.w === 4000 && first.html === "" && typeof n.sig === "string", "数は範囲に収め、形の違う値は空にする", first);
  ok(pdf && pdf.kid === "okpdf" && pdf.x === 24 && pdf.y === 24 && pdf.w === 160 && pdf.size === 12, "PDF の箱も数をそろえる", pdf);
  ok(!n.blocks.some((b) => b.t === "evil" || b.kid === "bad id!"), "知らない種類・形の悪い id の箱は捨てる");
  ok(!(await page.evaluate((m) => "canvas" in normalizeMemo(m), notCanvas)), "形の違う canvas は持たない");
  await selectPage(page, "壊れた箱");
  // sig も壊れているので、文字の箱は本文1つに作り直される（PDF の箱は残る）
  ok(/本文/.test(await page.$eval(".nb-text", (e) => e.textContent)) && await page.$('.nb[data-bid] .nb-pdf'), "壊れた canvas でも描ける（文字は本文から作り直す）");
  // 掃除（gcAttachments）は箱の添付を消さない。本文・添付から外れていても
  const gc = await page.evaluate(async () => {
    const old = Date.now() - 30 * 24 * 3600 * 1000;
    await idbPut({ id: "gcKeep", blob: new Blob(["x"]), name: "k.pdf", type: "application/pdf", size: 1, at: old });
    await idbPut({ id: "gcDrop", blob: new Blob(["y"]), name: "d.pdf", type: "application/pdf", size: 1, at: old });
    const ms = [{ id: "g1", title: "", body: "", attachments: [], canvas: { v: 1, sig: "", blocks: [{ id: "b", t: "pdf", x: 0, y: 0, w: 300, kid: "gcKeep" }] } }];
    const ids = memoFileIds(ms[0]);
    await gcAttachments(ms);
    return { keep: !!(await idbGet("gcKeep")), drop: !!(await idbGet("gcDrop")), ids };
  });
  ok(gc.keep && !gc.drop && gc.ids.includes("gcKeep"), "箱が使っているファイルは掃除で消さない（memoFileIds に入る）", gc);
  // 書き出し（バックアップ）には canvas と箱のファイルの中身が入る
  const exp = await page.evaluate(async () => {
    await idbPut({ id: "expPdf", blob: new Blob(["%PDF-1.4"], { type: "application/pdf" }), name: "e.pdf", type: "application/pdf", size: 8, at: Date.now() });
    const m = { id: "e1", title: "書き出し", body: "", attachments: [], canvas: { v: 1, sig: "", blocks: [{ id: "b", t: "pdf", x: 0, y: 0, w: 300, kid: "expPdf", name: "e.pdf", type: "application/pdf" }] } };
    const o = await buildBackupObject([m], []);
    return { canvas: !!o.memos[0].canvas, file: (o.files.find((f) => f.id === "expPdf") || {}).dataUrl || "" };
  });
  ok(exp.canvas && /^data:application\/pdf;base64,/.test(exp.file), "書き出しに canvas と箱のファイルの中身が入る", exp);
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 15. ページの操作（…）・自動保存の待たない保存 ───────────── */
await section("10 page: …の操作・情報の行・ページを替えたときの保存", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: baseMemos(), notebooks: FOLDERS }, "kininari:note:view": "\"note\"" });
  const { page, errors } = await openApp(ctx);
  await page.click('.ns-row:has(.nm:text-is("仕事")) .ns-name');
  await selectPage(page, "会議のメモ");
  await page.click(".np-more");
  await page.click('.np-menu button:has-text("ピン留めする")');
  ok((await waitSaved(page, "m1", (m) => m.pinned, "ピン")), "…から ピン留め");
  await page.click(".np-more");
  await page.click('.np-menu button:has-text("完了にする")');
  ok((await waitSaved(page, "m1", (m) => m.done, "完了")), "…から 完了");
  await page.click(".np-more");
  await page.click('.np-menu button:has-text("復習に入れる")');
  ok((await waitSaved(page, "m1", (m) => m.srs, "復習")) && await page.$(".np-info .srs-chip"), "…から 復習に入れる（情報の行に次回が出る）");
  await page.click(".np-more");
  await page.click('.np-menu button:has-text("フォルダへ移動")');
  await page.click('.kn-dlg .fp-opt:has-text("読書")');
  ok((await waitSaved(page, "m1", (m) => m.notebookId === "fb", "移動")), "…から フォルダへ移動");
  // 情報の行から分類・タグ・日付を直す
  await page.click('.np-chip:has-text("分類・タグ・日付・リンク")');
  await page.click('.np-det .cat-chip:has-text("アイデア")');
  ok((await waitSaved(page, "m1", (m) => m.category === "アイデア", "分類")), "情報の行から分類を変えられる");
  await page.fill(".np-det .tag-input", "大事");
  await page.press(".np-det .tag-input", "Enter");
  ok((await waitSaved(page, "m1", (m) => (m.tags || []).includes("大事"), "タグ")), "タグを足せる（Enter）");
  await page.fill('.np-det input[type="date"]', "2026-12-01");
  ok((await waitSaved(page, "m1", (m) => m.date === "2026-12-01", "日付")) && await page.$('.np-info .when'), "日付を入れられる（情報の行に出る）");
  // 書いてすぐにページを替えても、書いた分は保存される（自動保存を待たない）
  await page.click('.ns-row:has(.nm:text-is("すべて")) .ns-name');
  await selectPage(page, "会議のメモ");
  await page.click(".nb-text");
  await page.keyboard.press("End");
  await page.keyboard.type("すぐ替える");
  await page.click('.npg-item:has(.npg-tt:text-is("読みたい本"))');
  const m1 = await memoOf(page, "m1");
  ok(/すぐ替える/.test(m1.body) && m1.canvas, "ページを替えた瞬間に保存される", m1.body);
  // 新しいページを作った直後に前のページの保存が走っても、新しいページは消えない
  await selectPage(page, "会議のメモ");
  await page.click(".nb-text");
  await page.keyboard.type("A");
  await page.click(".npg-add");
  await sleep(300);
  const d = await lsData(page);
  ok(d.memos.some((m) => m.title === "" && m.id !== "m2") && /A/.test(d.memos.find((m) => m.id === "m1").body), "ページの追加と前のページの保存が重なっても、どちらも残る");
  // 画面が隠れたときも保存
  await selectPage(page, "会議のメモ");
  await page.click(".nb-text");
  await page.keyboard.type("Z");
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  ok(/Z/.test((await memoOf(page, "m1")).body), "画面が隠れたときも待たずに保存する");
  await page.evaluate(() => { delete document.visibilityState; });
  // 削除
  await page.click(".np-more");
  await page.click('.np-menu button:has-text("削除")');
  await sleep(200);
  ok(!(await memoOf(page, "m1")), "…から 削除（確認のあと）");
  // 表示を替えると保存（カード表示へ）
  await selectPage(page, "読みたい本");
  await page.mouse.click((await page.locator(".nc-canvas").boundingBox()).x + 200, (await page.locator(".nc-canvas").boundingBox()).y + 200);
  await page.keyboard.type("表示を替える");
  await page.click('.vs-b:has-text("カード表示")');
  ok(/表示を替える/.test((await memoOf(page, "m4")).body), "カード表示に替えた瞬間にも保存される");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

/* ── 16. 長い PDF・pdf.js が読めないとき・開いてはいけないファイル ─────── */
await section("11 files: 長いPDFは20ページまで・pdf.js が読めないとき・危ない形式は開かずに保存", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: baseMemos(), notebooks: FOLDERS }, "kininari:note:view": "\"note\"" });
  const { page, errors } = await openApp(ctx);
  await selectPage(page, "読みたい本");
  const pt = await canvasToScreen(page, 40, 40);
  await dropFile(page, pt.x, pt.y, { name: "長い.pdf", type: "application/pdf", b64: PDF25_B64 });
  await page.waitForSelector(".nb-pdf canvas[data-done]", { timeout: 20000 });
  await sleep(500);
  const pages = await page.$$eval(".nb-pdfpage", (e) => e.length);
  const drawn = await page.$$eval(".nb-pdf canvas[data-done]", (e) => e.length);
  ok(pages === 20 && await page.$('.nb-pdfmore:has-text("残り5ページを表示")'), "長い PDF は最初の20ページだけ並べ、「残りNページを表示」を出す", pages);
  ok(drawn > 0 && drawn < 20, "見えているページだけを描く（見えないページは後で）", drawn);
  ok((await page.textContent(".nb-pdfbar")).includes("25ページ"), "帯にページ数が出る");
  await page.click(".nb-pdfmore");
  ok((await page.$$eval(".nb-pdfpage", (e) => e.length)) === 25 && !(await page.$(".nb-pdfmore")), "押すと残りのページも並ぶ");
  // 危ない形式（HTML など）は、このアプリのオリジンで開かずに保存させる
  await page.evaluate(() => idbPut({ id: "khtml", blob: new Blob(["<script>alert(1)</script>"], { type: "text/html" }), name: "x.html", type: "text/html", size: 25, at: Date.now() }));
  await page.click(".np-title");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["<b>hi</b><script>parent.__bad=1</script>"], "page.html", { type: "text/html" }));
    const sc = document.querySelector(".nc-scroll"), r = sc.getBoundingClientRect();
    const opt = { bubbles: true, cancelable: true, clientX: r.left + 700, clientY: r.top + 60, dataTransfer: dt };
    const el = document.elementFromPoint(opt.clientX, opt.clientY);
    el.dispatchEvent(new DragEvent("dragover", opt));
    el.dispatchEvent(new DragEvent("drop", opt));
  });
  await page.waitForSelector(".nb .nb-file");
  ok((await page.textContent(".nb .nb-file")).includes("page.html"), "PDF・画像以外はファイルの箱（名前と大きさと「開く」）");
  const popups = [];
  page.on("popup", (p) => popups.push(p));
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }).catch(() => null), page.click('.nb .nb-file button:has-text("開く")')]);
  await sleep(300);
  ok(dl && dl.suggestedFilename() === "page.html" && popups.length === 0, "HTML のファイルは開かずに保存させる（同じオリジンでスクリプトを動かさない）", dl && dl.suggestedFilename());
  ok(!(await page.evaluate(() => window.__bad)), "スクリプトは動かない");
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();

  // pdf.js が読めない（初めて使うのがオフラインのとき）→ 開く・ダウンロードだけの箱になる
  const ctx2 = await device();
  await ctx2.route(/vendor\/pdfjs\//, (r) => r.abort());
  await preset(ctx2, { [DATA_KEY]: { memos: baseMemos(), notebooks: FOLDERS }, "kininari:note:view": "\"note\"" });
  const { page: p2 } = await openApp(ctx2);
  await selectPage(p2, "読みたい本");
  const pt2 = await canvasToScreen(p2, 40, 40);
  await dropFile(p2, pt2.x, pt2.y, { name: "見本.pdf", type: "application/pdf", b64: PDF_B64 });
  await p2.waitForSelector(".nb .nb-file", { timeout: 10000 }).catch(() => {});
  ok(await p2.$('.nb .nb-file button:has-text("開く")') && /表示できませんでした/.test(await p2.textContent(".nb .nb-file")), "pdf.js が読めないときは「開く」のある箱にする");
  const m = await waitSaved(p2, "m4", (mm) => mm.canvas && mm.canvas.blocks.some((b) => b.t === "pdf"), "保存");
  ok(m && m.attachments.length === 1, "PDF 自体はちゃんと保存される（あとで表示できる）");
  await ctx2.unroute(/vendor\/pdfjs\//);
  // 読み込み直さなくても、次にそのページを開いたときに読み直す
  await selectPage(p2, "会議のメモ");
  await selectPage(p2, "読みたい本");
  await p2.waitForSelector(".nb-pdf canvas[data-done]", { timeout: 20000 }).catch(() => {});
  ok((await pdfInk(p2)) > 200, "つながったら、ページを開き直すだけで PDF が描ける（読み込み直さなくてよい）");
  await ctx2.close();
});

/* ── 12. 自動で置く場所 ─────────────────────────────────── */
await section("12 place: 貼り付けた画像がほかの箱を覆わない", async () => {
  const ctx = await device();
  await preset(ctx, { [DATA_KEY]: { memos: baseMemos(), notebooks: FOLDERS }, "kininari:note:view": "\"note\"" });
  const { page, errors } = await openApp(ctx);
  await selectPage(page, "会議のメモ");
  // 最初の箱（本文）のすぐ下に、もう1つ文字の箱を作る
  const first = await page.locator(".nb.nbk-text").first().boundingBox();
  const below = await canvasToScreen(page, 40, 0);
  await page.mouse.click(below.x, first.y + first.height + 30);
  await page.keyboard.type("下の箱");
  // 最初の箱に入って（中身がある）画像を貼る → 以前は最初の箱のすぐ下＝「下の箱」の上に置いていた
  await page.click(".nb.nbk-text >> nth=0");
  await pastePng(page, 200, 120);
  const m = await waitSaved(page, "m1", (mm) => mm.canvas && mm.canvas.blocks.some((b) => b.t === "img") && mm.canvas.blocks.some((b) => b.t === "text" && /下の箱/.test(b.html || "")), "保存");
  const img = m && m.canvas.blocks.find((b) => b.t === "img");
  const txt = m && m.canvas.blocks.find((b) => b.t === "text" && /下の箱/.test(b.html || ""));
  const tb = txt && await blockBox(page, txt.id);
  const ib = img && await blockBox(page, img.id);
  const overlap = tb && ib && ib.x < tb.x + tb.width && tb.x < ib.x + ib.width && ib.y < tb.y + tb.height && tb.y < ib.y + ib.height;
  ok(img && txt && !overlap, "貼った画像は、下にある文字の箱に重ならない位置に置く", { img, txt });
  // 選んだ箱は手前に出る
  await page.click(`.nb[data-bid="${img.id}"] .nb-bar`).catch(() => {});
  const z = await page.evaluate((id) => getComputedStyle(document.querySelector(`.nb[data-bid="${id}"]`)).zIndex, img.id);
  ok(z === "5", "選んだ箱は手前に出す", z);
  ok(errors.length === 0, "エラーが無い", errors);
  await ctx.close();
});

await browser.close();
await server.close();
done();
