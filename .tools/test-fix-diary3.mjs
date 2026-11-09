/* ============================================================
   日記帳（diary.html）: 「今日を書く」・書式のツールバー・ファイル の確認
     node .tools/test-fix-diary3.mjs                    … 全部
     ONLY=w1,t1 node .tools/test-fix-diary3.mjs         … 項目を選ぶ（下の記号）
     DIARY_ROOT=/別の場所 node .tools/test-fix-diary3.mjs … その場所の diary.html で試す（修正前との比べ用）

   w1 今日を書く（PC）: 「今日の出来事」で作って本文にカーソル。もう一度押すと同じ日記。2度押し・保存の失敗・Alt+N
   w2 カレンダー: 日記のある日は開く／無い日は「この日に書く（M月D日）」で作る
   w3 スマホ: 右下の＋（書いている間は隠す・ツールバーや保存ボタンに重ならない）、ツールバーは1行で横に流れる
   w4 日付を変えても1日1件（もう一方の日記も、動かした日記も消えない）
   w5 ロック中は先に解除。解除したら続けて今日を開く（やめたら開かない）
   t1 ツールバーの各書式 → 決まった形の HTML。保存して開き直しても同じ
   t2 色・蛍光ペンのメニューを開いても選択が保たれる（PC とスマホ）
   t3 チェックボックス（押して済み → 開き直しても済み。改行した次の項目は「まだ」）
   t4 元に戻す・やり直し（ボタンとキー）
   t5 ダークモードでも読める色（計算した色で確かめる）
   t6 Markdown の書き出し
   t7 Word・Googleドキュメント・Webページの貼り付けは安全に（style は太字などだけタグに）
   t8 古い日記は今までどおりに出る
   f1 ファイル（xlsx/docx/pdf）→ カード・端末の記録・開く/保存の決まり（HTML は保存だけ）・大きすぎるもの
   f2 暗号化中は暗号化して置く・Drive で2台目へ・暗号化した Drive に平文で置かない・JSON の書き出しと取り込み
   f3 Google のリンクは種類の分かるカード（ふつうの安全なリンクのまま）
   f4 使われなくなったファイルの片付け（端末は猶予つき・Drive は30日）
   ============================================================ */
import { startServer, launch, newDevice, collectErrors, makeChecker, sleep, waitFor, ROOT } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const only = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const want = (k) => !only.length || only.includes(String(k));
const srv = await startServer(process.env.DIARY_ROOT || ROOT);
// C ロケールの Chromium は、日本語の名前の保存（ダウンロード）を "download" に変えてしまう。名前を確かめるため UTF-8 で起動する
const utf8 = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "");
const browser = await launch(process.platform === "linux" && !utf8 ? { env: { ...process.env, LC_ALL: "C.UTF-8" } } : {});
const { ok, done } = makeChecker("test-fix-diary3");
const pageErrors = [];
const PC = { viewport: { width: 1400, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/* ── 道具 ─────────────────────────────────────────── */
async function open(ctx) {
  const page = await ctx.newPage();
  page.errs = collectErrors(page);
  page.answers = [];
  page.dialogs = [];
  page.on("dialog", async (d) => {
    page.dialogs.push({ type: d.type(), msg: d.message() });
    const a = page.answers.length ? page.answers.shift() : (d.type() === "prompt" ? null : true);
    try {
      if (a === null || a === false) await d.dismiss();
      else await d.accept(typeof a === "string" ? a : undefined);
    } catch (e) {}
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.setDefaultTimeout(8000);   // 修正前のページで待ち続けない
  await page.goto(srv.url + "diary.html");
  await page.waitForFunction(() => typeof storageReady !== "undefined" && storageReady === true
    && document.getElementById("calendarDays").children.length > 0 && !!(window.google && google.accounts && google.accounts.oauth2));
  await sleep(150);
  return page;
}
/** 1つの項目を流す。修正前のページで関数が無くても、例外で全体を止めずに「失敗」として数える */
async function section(name, fn) {
  try { await fn(); } catch (e) { ok(false, name + ": 例外で止まった", String(e && e.message || e).slice(0, 300)); }
}
const today = (page) => page.evaluate(() => localDateStr());
const md = (d) => { const p = d.split("-").map(Number); return `${p[1]}月${p[2]}日`; };
const toasts = (page) => page.evaluate(() => Array.from(document.querySelectorAll("#toastRegion .toast")).map((t) => t.textContent));
async function toastSeen(page, re, ms = 3000) {
  try { await waitFor(async () => (await toasts(page)).some((t) => re.test(t)), { timeout: ms }); return true; } catch (e) { return false; }
}
const bodyHtml = (page) => page.evaluate(() => document.getElementById("contentEditor").innerHTML);
const stored = (page) => page.evaluate(() => { const r = JSON.parse(localStorage.getItem("diaryEntries") || "[]"); return Array.isArray(r) ? r : r; });
async function addEntry(page, date, title, html = "") {
  return page.evaluate(async ([date, title, html]) => {
    const e = { id: genId(), date, title, content: html, contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    entries.push(e);
    const r = await saveEntriesToStorage();
    loadEntry(e);
    return r;
  }, [date, title, html]);
}
/** 今日の日記を開く（書式・ファイルの項目の準備。修正前のページでも、その先の確かめが流れるように） */
async function startEntry(page) {
  await page.evaluate(async () => {
    if (typeof writeToday === "function") { await writeToday(); return; }
    const e = { id: genId(), date: localDateStr(), title: "今日の出来事", content: "", contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    entries.push(e); await saveEntriesToStorage(); loadEntry(e);
  });
}
/** 本文の中身を差し替える（打ったのと同じく未保存にする） */
async function setBody(page, html) {
  await page.evaluate((h) => { const ed = document.getElementById("contentEditor"); ed.innerHTML = h; ed.focus(); syncEditorContent(); }, html);
}
/** 本文の中の文字を選ぶ（n 番目に出てくるもの） */
async function selWord(page, w, n = 0) {
  return page.evaluate(([w, n]) => {
    const ed = document.getElementById("contentEditor");
    const t = ed.textContent;
    let i = -1;
    for (let k = 0; k <= n; k++) i = t.indexOf(w, i + 1);
    if (i < 0) return false;
    ed.focus();
    rteSetSelectionByOffsets(ed, i, i + w.length);
    return String(window.getSelection()) === w;
  }, [w, n]);
}
async function caretAt(page, w, atEnd = true) {
  return page.evaluate(([w, atEnd]) => {
    const ed = document.getElementById("contentEditor");
    const i = ed.textContent.indexOf(w);
    if (i < 0) return false;
    ed.focus();
    const o = atEnd ? i + w.length : i;
    rteSetSelectionByOffsets(ed, o, o);
    return true;
  }, [w, atEnd]);
}
async function cmd(page, name, { tap = false } = {}) {
  const sel = `#rteBar [data-cmd="${name}"]`;
  if (tap) await page.tap(sel); else await page.click(sel);
}
/** 開いているメニューから、文字がちょうど label の項目を押す */
async function pick(page, label, { tap = false } = {}) {
  const idx = await page.evaluate((label) => Array.from(document.querySelectorAll(".rte-pop button")).findIndex((b) => b.textContent.trim() === label), label);
  if (idx < 0) throw new Error("メニューに「" + label + "」がありません");
  const loc = page.locator(".rte-pop button").nth(idx);
  if (tap) await loc.tap(); else await loc.click();
}
async function setPass(page, pass) {
  await page.evaluate(async (pass) => {
    document.getElementById("encNewPass").value = pass;
    document.getElementById("encNewPass2").value = pass;
    await applyPassphrase();
  }, pass);
}
async function unlock(page, pass) {
  await page.evaluate(async (pass) => { document.getElementById("unlockPass").value = pass; await submitUnlock(); }, pass);
  return page.evaluate(() => !appLocked);
}
/** ページの中で File を作って insertFiles に渡す。spec: [{ name, type, text | size }] */
async function attach(page, specs) {
  return page.evaluate(async (specs) => {
    const files = specs.map((s) => s.size ? new File([new Uint8Array(s.size)], s.name, { type: s.type }) : new File([s.text], s.name, { type: s.type }));
    return insertFiles(files);
  }, specs);
}
/** 端末の記録（中身は平文に戻して文字で返す） */
async function fileRec(page, fid) {
  return page.evaluate(async (fid) => {
    const rec = await imgGet(fid);
    if (!rec) return null;
    let text = null, err = null;
    try { const b = await imgDecode(rec); text = await b.text(); } catch (e) { err = String(e && e.message); }
    const raw = rec.data instanceof Blob ? await rec.data.text() : new TextDecoder().decode(rec.data);
    return { enc: rec.enc ? 1 : 0, ks: rec.ks || null, type: rec.type, size: rec.size, text, err, raw };
  }, fid);
}
const fids = (page) => page.evaluate(() => Array.from(document.querySelectorAll("#contentEditor .dy-file")).map((c) => c.getAttribute("data-fid")));
const XLSX = { name: "家計簿.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", text: "PK\u0003\u0004 XLSX-SECRET-MARKER 表計算" };
const DOCX = { name: "議事録.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text: "PK\u0003\u0004 DOCX-MARKER 文書" };
const PDF = { name: "案内.pdf", type: "application/pdf", text: "%PDF-1.4\n% PDF-MARKER\n%%EOF" };

/* ── w1. 今日を書く（PC）── */
if (want("w1")) {
  console.log("w1) 今日を書く（PC）");
  await section("w1", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    ok(await p.locator("#writeTodayBtn").isVisible(), "w1: サイドバーのいちばん上に「今日を書く」がある");
    ok(await p.evaluate(() => { const b = document.getElementById("writeTodayBtn"), t = document.querySelector(".view-tabs"); return !!b && b.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING; }), "w1: リスト／カレンダーの切り替えより上");
    ok(await p.evaluate(() => !Array.from(document.querySelectorAll(".header button")).some((b) => /新規作成/.test(b.textContent)) && !document.getElementById("newEntryModal")), "w1: 見出しの「新規作成」と入力画面は無い");
    ok(/今日を書く/.test(await p.evaluate(() => document.querySelector("#editorSection .empty-state").textContent)), "w1: 空の画面の案内が「今日を書く」になっている");
    const t = await today(p);
    await p.click("#writeTodayBtn");
    await waitFor(() => p.evaluate(() => !!currentEntry));
    const st = await p.evaluate(() => ({ n: entries.length, title: currentEntry.title, date: currentEntry.date, act: document.activeElement && document.activeElement.id,
      inBody: (() => { const s = window.getSelection(); return s.rangeCount > 0 && document.getElementById("contentEditor").contains(s.getRangeAt(0).startContainer) || s.anchorNode === document.getElementById("contentEditor"); })(),
      modal: !!document.querySelector(".modal.active") }));
    ok(st.n === 1 && st.title === "今日の出来事" && st.date === t, "w1: 今日の日記を「今日の出来事」で作る", st);
    ok(st.act === "contentEditor" && st.inBody, "w1: カーソルはタイトルではなく本文にある", st);
    ok(!st.modal, "w1: 入力画面（モーダル）は出ない");
    ok((await stored(p)).some((e) => e.date === t && e.title === "今日の出来事"), "w1: 端末に保存されている");
    ok(await toastSeen(p, /日記をはじめました/), "w1: 作ったことを知らせる");
    await p.keyboard.type("朝は晴れ");
    await p.evaluate(() => saveEntry(true));
    ok((await stored(p)).find((e) => e.date === t).content.includes("朝は晴れ"), "w1: そのまま打った文字が本文に入る");
    // もう一度押す → 同じ日記を開き、続きから書ける
    await p.evaluate(() => { document.getElementById("editorTitle").focus(); });
    await p.click("#writeTodayBtn");
    await sleep(200);
    await p.keyboard.type("、昼は雨");
    await p.evaluate(() => saveEntry(true));
    const all = await stored(p);
    ok(all.length === 1 && all[0].content.includes("朝は晴れ、昼は雨"), "w1: 2回目は同じ日記を開き、本文の続きにカーソル", all.map((e) => e.content));
    // 別の日を開いてから Alt+N
    const other = await p.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 3); return localDateStr(d); });
    await addEntry(p, other, "三日前", "<div>前の日</div>");
    await p.keyboard.press("Alt+KeyN");
    await sleep(300);
    ok(await p.evaluate((t) => currentEntry && currentEntry.date === t && document.activeElement.id === "contentEditor", t), "w1: Alt+N でも今日の日記を開く");
    await ctx.close();
  });
  await section("w1b", async () => {
    // 2度押し・保存できないとき
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    await p.evaluate(() => Promise.all([writeToday(), writeToday(), writeToday()]));
    ok(await p.evaluate(() => entries.length === 1 && JSON.parse(localStorage.getItem("diaryEntries")).length === 1), "w1: 続けて押しても1日1件（2件作らない）");
    const ctx2 = await newDevice(browser, { contextOptions: PC });
    const q = await open(ctx2);
    await q.evaluate(() => {
      const o = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { if (k === "diaryEntries") { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; } return o.call(this, k, v); };
    });
    await startEntry(q);
    const r = await q.evaluate(() => ({ n: entries.length, cur: !!currentEntry, ts: Array.from(document.querySelectorAll("#toastRegion .toast")).map((t) => t.textContent) }));
    ok(r.n === 0 && !r.cur, "w1: 保存できなければ日記を作らない（開かない）", r);
    ok(r.ts.some((x) => /保存容量/.test(x)) && !r.ts.some((x) => /はじめました/.test(x)), "w1: 保存できなかったことを伝え、成功とは言わない", r.ts);
    await ctx.close(); await ctx2.close();
  });
}

/* ── w2. カレンダー ── */
if (want("w2")) {
  console.log("w2) カレンダーから書く");
  await section("w2", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    // 今日と同じ月の、今日ではない2日（1日と2日。今日が1日か2日なら27日・28日）
    const [d1, d2] = await p.evaluate(() => {
      const n = new Date(), a = n.getDate() <= 2 ? 27 : 1, b = n.getDate() <= 2 ? 28 : 2;
      return [localDateStr(new Date(n.getFullYear(), n.getMonth(), a)), localDateStr(new Date(n.getFullYear(), n.getMonth(), b))];
    });
    await addEntry(p, d1, "ある日", "<div>ある日の本文</div>");
    await p.evaluate(() => { currentEntry = null; renderEditor(); });
    await p.click(`#calendarDays button[onclick="selectDate('${d1}')"]`);
    await sleep(200);
    ok(await p.evaluate((d) => currentEntry && currentEntry.date === d && document.getElementById("editorTitle").value === "ある日", d1), "w2: 日記のある日を押すと、その日記を開く");
    await p.click(`#calendarDays button[onclick="selectDate('${d2}')"]`);
    await sleep(200);
    const btn = p.locator("#editorSection .empty-write");
    ok(await btn.isVisible() && (await btn.textContent()).includes(`この日に書く（${md(d2)}）`), "w2: 日記の無い日は「この日に書く（M月D日）」を出す", await p.evaluate(() => document.getElementById("editorSection").textContent));
    ok(await p.evaluate(() => entries.length === 1 && !currentEntry), "w2: 押すまでは作らない");
    await btn.click();
    await waitFor(() => p.evaluate(() => !!currentEntry));
    const st = await p.evaluate(() => ({ date: currentEntry.date, title: currentEntry.title, act: document.activeElement.id, n: entries.length }));
    ok(st.date === d2 && st.title === "今日の出来事" && st.act === "contentEditor" && st.n === 2, "w2: その日の日記を「今日の出来事」で作り、本文にカーソル", st);
    // 先の日（来月）も同じように書ける
    await p.evaluate(() => changeMonth(1));
    const fut = await p.evaluate(() => { const n = new Date(); return localDateStr(new Date(n.getFullYear(), n.getMonth() + 1, 15)); });
    await p.click(`#calendarDays button[onclick="selectDate('${fut}')"]`);
    await p.click("#editorSection .empty-write");
    await waitFor(() => p.evaluate(() => !!currentEntry));
    ok(await p.evaluate((d) => currentEntry.date === d, fut), "w2: 先の日付にも書ける");
    await ctx.close();
  });
}

/* ── w3. スマホ ── */
if (want("w3")) {
  console.log("w3) スマホの＋とツールバー");
  await section("w3", async () => {
    const ctx = await newDevice(browser, { contextOptions: PHONE });
    const p = await open(ctx);
    const fab = await p.evaluate(() => { const f = document.getElementById("fabWrite"); if (!f) return null; const r = f.getBoundingClientRect(), cs = getComputedStyle(f); return { disp: cs.display, pos: cs.position, w: r.width, h: r.height, right: innerWidth - r.right, bottom: innerHeight - r.bottom, radius: cs.borderRadius, label: f.getAttribute("aria-label"), side: getComputedStyle(document.getElementById("writeTodayBtn")).display }; });
    ok(fab && fab.disp !== "none" && fab.pos === "fixed" && fab.w >= 56 && Math.abs(fab.w - fab.h) < 1 && fab.right >= 12 && fab.right <= 24 && fab.bottom >= 12 && fab.bottom <= 24, "w3: 右下に丸い＋がある（押しやすい大きさ）", fab);
    ok(fab && fab.label === "今日を書く" && fab.side === "none", "w3: スマホではサイドバーの大きなボタンの代わりに＋（読み上げは「今日を書く」）", fab);
    ok(/右下の「＋」/.test(await p.locator("#editorSection .empty-state").innerText()), "w3: 空の画面の案内も＋のことを言う");
    await p.tap("#fabWrite");
    await waitFor(() => p.evaluate(() => !!currentEntry));
    await sleep(300);
    const st = await p.evaluate(() => ({ title: currentEntry.title, act: document.activeElement.id, fab: getComputedStyle(document.getElementById("fabWrite")).display }));
    ok(st.title === "今日の出来事" && st.act === "contentEditor", "w3: ＋で今日の日記を作り、本文にカーソル", st);
    ok(st.fab === "none", "w3: 書いている間は＋を隠す（キーボードの上で本文に重ねない）", st);
    const bar = await p.evaluate(() => { const b = document.getElementById("rteBar"), cs = getComputedStyle(b); const gs = Array.from(b.querySelectorAll(".tb-group")); const bs = Array.from(b.querySelectorAll(".tb"));
      return { wrap: cs.flexWrap, ox: cs.overflowX, pos: cs.position, rows: new Set(gs.map((g) => g.offsetTop)).size, scrolls: b.scrollWidth > b.clientWidth, minH: Math.min(...bs.map((x) => x.getBoundingClientRect().height)), minW: Math.min(...bs.map((x) => x.getBoundingClientRect().width)) }; });
    ok(bar.wrap === "nowrap" && bar.rows === 1 && bar.scrolls && /auto|scroll/.test(bar.ox), "w3: ツールバーは折り返さず1行で横に流れる", bar);
    ok(bar.minH >= 40 && bar.minW >= 40, "w3: ボタンは指で押せる大きさ（40px 以上）", bar);
    ok(bar.pos === "sticky", "w3: 書いている間もツールバーが上に残る", bar);
    // 今日の日記を開いているあいだは、本文から離れても＋は隠したまま（押しても同じ日記が開くだけ）
    await p.evaluate(() => document.activeElement.blur());
    await sleep(100);
    const onToday = await p.evaluate(() => getComputedStyle(document.getElementById("fabWrite")).display);
    ok(onToday === "none", "w3: 今日の日記を開いているあいだは＋を隠す（タグ欄や保存に重ならない）", onToday);
    // ほかの日の日記を開くと＋が戻る。ツールバー・保存ボタンには重ならない
    await addEntry(p, "2026-10-05", "前の日", "<div>前の日の本文</div>");
    await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await sleep(150);
    const ov = await p.evaluate(() => {
      const f = document.getElementById("fabWrite").getBoundingClientRect();
      const hit = (r) => !(r.right <= f.left || r.left >= f.right || r.bottom <= f.top || r.top >= f.bottom);
      const shown = getComputedStyle(document.getElementById("fabWrite")).display !== "none";
      const tb = hit(document.getElementById("rteBar").getBoundingClientRect());
      window.scrollTo(0, document.documentElement.scrollHeight);
      return new Promise((res) => requestAnimationFrame(() => {
        const f2 = document.getElementById("fabWrite").getBoundingClientRect();
        const save = Array.from(document.querySelectorAll(".footer-actions button")).map((b) => b.getBoundingClientRect());
        const hit2 = (r) => !(r.right <= f2.left || r.left >= f2.right || r.bottom <= f2.top || r.top >= f2.bottom);
        res({ shown, tb, save: save.some(hit2) });
      }));
    });
    ok(ov.shown && !ov.tb, "w3: ほかの日の日記では＋が出て、ツールバーには重ならない", ov);
    ok(!ov.save, "w3: いちばん下までスクロールすると、保存・削除のボタンは＋に隠れない", ov);
    await ctx.close();
  });
}

/* ── w4. 日付の変更でも1日1件 ── */
if (want("w4")) {
  console.log("w4) 日付を変えても1日1件");
  await section("w4", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    await addEntry(p, "2026-10-01", "Aの日", "<div>Aの本文</div>");
    await addEntry(p, "2026-10-02", "Bの日", "<div>Bの本文</div>");
    const setDate = (d) => p.evaluate((d) => { const i = document.getElementById("editorDate"); i.value = d; i.dispatchEvent(new Event("change")); }, d);
    await setDate("2026-10-01");
    await sleep(400);
    const s1 = await stored(p);
    ok(await p.evaluate(() => document.getElementById("editorDate").value === "2026-10-02" && currentEntry.date === "2026-10-02"), "w4: 日記のある日には移さない（日付は元のまま）");
    ok(s1.length === 2 && s1.find((e) => e.title === "Aの日").content === "<div>Aの本文</div>" && s1.find((e) => e.title === "Bの日").content === "<div>Bの本文</div>" && s1.find((e) => e.title === "Bの日").date === "2026-10-02", "w4: どちらの日記も消えない・混ざらない", s1);
    ok(await toastSeen(p, /10月1日には、もう日記があります（1日1件）/), "w4: 理由をはっきり伝える");
    await setDate("2026-10-05");
    await sleep(400);
    const s2 = await stored(p);
    ok(s2.find((e) => e.title === "Bの日").date === "2026-10-05" && s2.length === 2, "w4: 空いている日には移せる", s2.map((e) => e.date));
    await ctx.close();
  });
}

/* ── w5. ロック中 ── */
if (want("w5")) {
  console.log("w5) ロック中の今日を書く");
  await section("w5", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    let p = await open(ctx);
    await addEntry(p, "2026-10-03", "前の日", "<div>前</div>");
    await setPass(p, "w5-pass-1234");
    await p.close();
    p = await open(ctx);
    ok(await p.evaluate(() => appLocked), "準備: ロックされている");
    await p.click("#unlockModal .btn-secondary");   // 開いたときのロック解除は「後で」
    await p.click("#writeTodayBtn");
    await sleep(200);
    ok(await p.evaluate(() => document.getElementById("unlockModal").classList.contains("active") && entries.length === 0 && !currentEntry), "w5: ロック中に押すと、先にロック解除を出す（日記は作らない）");
    await p.click("#unlockModal .btn-secondary");   // 後で
    ok(await p.evaluate(() => typeof pendingWriteDate === "undefined" || pendingWriteDate === null), "w5: 解除をやめたら、続きもやめる");
    await p.evaluate(() => openUnlockModal());
    ok(await unlock(p, "w5-pass-1234"), "w5: 解除できる");
    await sleep(300);
    ok(await p.evaluate(() => !currentEntry), "w5: やめたあとに別の機会で解除しても、勝手に開かない");
    await p.close();
    p = await open(ctx);
    await p.click("#unlockModal .btn-secondary");
    await p.click("#writeTodayBtn");
    await sleep(100);
    ok(await unlock(p, "w5-pass-1234"), "w5: もう一度解除");
    await waitFor(() => p.evaluate(() => !!currentEntry), { timeout: 5000 });
    const st = await p.evaluate(() => ({ date: currentEntry.date, title: currentEntry.title, act: document.activeElement.id, n: entries.length }));
    ok(st.date === (await today(p)) && st.title === "今日の出来事" && st.act === "contentEditor" && st.n === 2, "w5: 解除したら続けて今日の日記を開く（本文にカーソル）", st);
    ok(isEncStored(await p.evaluate(() => localStorage.getItem("diaryEntries"))), "w5: 作った日記も暗号化して保存");
    await ctx.close();
  });
}
function isEncStored(raw) { try { const o = JSON.parse(raw); return o && o.__enc__ === 1 && !!o.ct; } catch (e) { return false; } }

/* ── t1. ツールバーの各書式 ── */
if (want("t1")) {
  console.log("t1) ツールバーの書式");
  await section("t1", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    await startEntry(p);
    const lines = ["見出し大", "見出し中", "見出し小", "太字 斜体 下線 取消", "大きい 特大 小さい", "赤い字 青い字", "黄色 ピンク", "やること一", "やること二", "番号一", "点一", "字下げ行", "引用行", "消す行", "リンク先", "表のあと"];
    await setBody(p, lines.map((l) => `<div>${l}</div>`).join(""));
    const ap = async (word, name, label) => { if (!(await selWord(p, word))) throw new Error("選べない: " + word); await cmd(p, name); if (label) await pick(p, label); };
    await ap("見出し大", "heading", "大見出し");
    await ap("見出し中", "heading", "中見出し");
    await ap("見出し小", "heading", "小見出し");
    await ap("太字", "bold"); await ap("斜体", "italic"); await ap("下線", "underline"); await ap("取消", "strike");
    await ap("大きい", "size", "大"); await ap("特大", "size", "特大"); await ap("小さい", "size", "小");
    await ap("赤い字", "color", "赤"); await ap("青い字", "color", "青");
    await ap("黄色", "highlight", "黄"); await ap("ピンク", "highlight", "ピンク");
    await p.evaluate(() => { const ed = document.getElementById("contentEditor"); const t = ed.textContent; rteSetSelectionByOffsets(ed, t.indexOf("やること一"), t.indexOf("やること二") + 5); });
    await cmd(p, "todo");
    await ap("番号一", "ol"); await ap("点一", "ul");
    await ap("字下げ行", "indent"); await cmd(p, "indent"); await cmd(p, "outdent");
    await ap("引用行", "quote");
    await ap("消す行", "bold"); await cmd(p, "color"); await pick(p, "緑"); await cmd(p, "heading"); await pick(p, "大見出し");
    await selWord(p, "消す行"); await cmd(p, "clear");
    await selWord(p, "リンク先");
    await cmd(p, "link");
    await p.fill("#linkUrl", "example.com/page");
    await p.click("#linkModal .btn-primary");
    p.answers.push("2", "3");
    await caretAt(p, "表のあと");
    await cmd(p, "table");
    const h = await bodyHtml(p);
    const expects = [
      [/<h2>見出し大<\/h2>/, "大見出し → h2"], [/<h3>見出し中<\/h3>/, "中見出し → h3"], [/<h4>見出し小<\/h4>/, "小見出し → h4"],
      [/<strong>太字<\/strong>/, "太字 → strong"], [/<em>斜体<\/em>/, "斜体 → em"], [/<u>下線<\/u>/, "下線 → u"], [/<s>取消<\/s>/, "取消線 → s"],
      [/<span class="fs-l">大きい<\/span>/, "大きさ 大 → span.fs-l"], [/<span class="fs-xl">特大<\/span>/, "特大 → span.fs-xl"], [/<span class="fs-s">小さい<\/span>/, "小 → span.fs-s"],
      [/<span class="fc-red">赤い字<\/span>/, "文字の色 赤 → span.fc-red"], [/<span class="fc-blue">青い字<\/span>/, "青 → span.fc-blue"],
      [/<mark class="hl-yellow">黄色<\/mark>/, "蛍光ペン 黄 → mark.hl-yellow"], [/<mark class="hl-pink">ピンク<\/mark>/, "ピンク → mark.hl-pink"],
      [/<ul class="todo"><li>やること一<\/li><li>やること二<\/li><\/ul>/, "チェックボックス → ul.todo > li（2行とも）"],
      [/<ol><li>番号一<\/li><\/ol>/, "番号付き → ol > li"], [/<ul><li>点一<\/li><\/ul>/, "箇条書き → ul > li"],
      [/<div class="ind-1">字下げ行<\/div>/, "字下げ（2回）→ 解除（1回）→ div.ind-1"],
      [/<blockquote><div>引用行<\/div><\/blockquote>/, "引用 → blockquote（その行だけ）"],
      [/<div>消す行<\/div>/, "書式を消す → 太字・色・見出しが外れる"],
      [/<a href="https:\/\/example\.com\/page" target="_blank" rel="noopener noreferrer">リンク先<\/a>/, "リンク（https を補う・新しいタブ）"],
      [/<table><tbody><tr><td>&nbsp;<\/td><td>&nbsp;<\/td><td>&nbsp;<\/td><\/tr><tr>/, "表（2行3列）"]
    ];
    expects.forEach(([re, label]) => ok(re.test(h), "t1: " + label, h));
    ok(!/style=/.test(h), "t1: style 属性は使っていない");
    // 文字を選ばずに色を選ぶ → 続けて打つ文字にかかる。Ctrl+B も同じ書き方（strong）
    await caretAt(p, "表のあと");
    await cmd(p, "color"); await pick(p, "緑");
    await p.keyboard.type("みどり");
    await p.keyboard.press("Control+b");
    await p.keyboard.type("ふと");
    await p.evaluate(() => saveEntry(true));
    const saved = (await stored(p))[0].content;
    ok(/<span class="fc-green">みどり(<strong>ふと<\/strong>)?<\/span>/.test(saved) && /<strong>ふと<\/strong>/.test(saved), "t1: 選ばずに選んだ色は続けて打つ文字に。Ctrl+B は strong", saved.slice(-200));
    ok(await p.evaluate((c) => sanitizeHtml(c) === c, saved), "t1: 保存した形はサニタイズしても変わらない（書式が消えない）");
    // 開き直しても同じ
    const q = await open(ctx);
    await q.evaluate(() => loadEntry(entries[0]));
    const h2 = await bodyHtml(q);
    const kept = expects.filter(([re]) => re.test(h2)).length;
    ok(kept === expects.length, `t1: 開き直しても書式がそのまま（${kept}/${expects.length}）`, h2);
    await ctx.close();
  });
  await section("t1b", async () => {
    // 箇条書きの字下げ（入れ子）と解除、Tab
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    await startEntry(p);
    await setBody(p, "<ul><li>親</li><li>子</li><li>孫</li></ul>");
    await caretAt(p, "子");
    await cmd(p, "indent");
    ok(/<ul><li>親<ul><li>子<\/li><\/ul><\/li><li>孫<\/li><\/ul>/.test(await bodyHtml(p)), "t1: 箇条書きの字下げは入れ子にする", await bodyHtml(p));
    await caretAt(p, "孫");
    await p.keyboard.press("Tab");
    ok(/<ul><li>親<ul><li>子<\/li><li>孫<\/li><\/ul><\/li><\/ul>/.test(await bodyHtml(p)), "t1: 箇条書きの中の Tab でも字下げ", await bodyHtml(p));
    await caretAt(p, "孫");
    await p.keyboard.press("Shift+Tab");
    ok(/<ul><li>親<ul><li>子<\/li><\/ul><\/li><li>孫<\/li><\/ul>/.test(await bodyHtml(p)), "t1: Shift+Tab で字下げ解除", await bodyHtml(p));
    await caretAt(p, "孫");
    await cmd(p, "outdent");
    ok(/<\/ul><div>孫<\/div>$/.test(await bodyHtml(p)), "t1: いちばん外の項目の字下げ解除は、ふつうの行に戻す", await bodyHtml(p));
    // 種類の切り替え（箇条書き → 番号付き → チェックボックス → 外す）
    await caretAt(p, "親");
    await cmd(p, "ol");
    ok(/^<ol><li>親/.test(await bodyHtml(p)), "t1: 箇条書きの中で番号付きを押すと種類だけ替わる", await bodyHtml(p));
    await cmd(p, "todo");
    ok(/^<ul class="todo"><li>親/.test(await bodyHtml(p)), "t1: チェックボックスにも替えられる");
    ok(await p.evaluate(() => document.querySelector('#rteBar [data-cmd="todo"]').getAttribute("aria-pressed") === "true"), "t1: いまの書式のボタンは押された状態で見える");
    await cmd(p, "todo");
    ok(/^<div>親/.test(await bodyHtml(p)), "t1: 同じ種類をもう一度押すと外す", await bodyHtml(p));
    await ctx.close();
  });
}

/* ── t2. メニューを開いても選択が保たれる ── */
if (want("t2")) {
  console.log("t2) 色・蛍光ペンのメニューと選択");
  await section("t2", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    await startEntry(p);
    await setBody(p, "<div>前の言葉と後ろの言葉</div>");
    await selWord(p, "後ろ");
    await cmd(p, "color");
    ok(await p.locator(".rte-pop").isVisible(), "t2: 色のメニューが開く");
    ok(await p.evaluate(() => String(window.getSelection()) === "後ろ" && document.activeElement.id === "contentEditor"), "t2(PC): メニューを開いても、選んだ文字はそのまま");
    await pick(p, "青");
    ok(/前の言葉と<span class="fc-blue">後ろ<\/span>の言葉/.test(await bodyHtml(p)), "t2(PC): 選んだ文字だけに色が付く", await bodyHtml(p));
    ok(await p.evaluate(() => !document.querySelector(".rte-pop")), "t2: 選んだらメニューは閉じる");
    await cmd(p, "highlight");
    await p.keyboard.press("Escape");
    ok(await p.evaluate(() => !document.querySelector(".rte-pop")), "t2: Esc でメニューを閉じる");
    await ctx.close();

    const ctx2 = await newDevice(browser, { contextOptions: PHONE });
    const q = await open(ctx2);
    await startEntry(q);
    await setBody(q, "<div>朝の散歩と夜の読書</div>");
    await selWord(q, "夜の読書");
    await cmd(q, "highlight", { tap: true });
    // スマホでは、ボタンを押すと本文の選択が外れることがある
    await q.evaluate(() => { window.getSelection().removeAllRanges(); document.activeElement.blur && document.activeElement.blur(); });
    await pick(q, "緑", { tap: true });
    ok(/朝の散歩と<mark class="hl-green">夜の読書<\/mark>/.test(await bodyHtml(q)), "t2(スマホ): 選択が外れても、メニューの前に選んでいた文字に蛍光ペンがかかる", await bodyHtml(q));
    await selWord(q, "朝の散歩");
    await cmd(q, "color", { tap: true });
    await q.evaluate(() => window.getSelection().removeAllRanges());
    await pick(q, "紫", { tap: true });
    ok(/<span class="fc-purple">朝の散歩<\/span>/.test(await bodyHtml(q)), "t2(スマホ): 文字の色も同じ", await bodyHtml(q));
    await ctx2.close();
  });
}

/* ── t3. チェックボックス ── */
if (want("t3")) {
  console.log("t3) チェックボックス");
  await section("t3", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    await startEntry(p);
    await setBody(p, '<ul class="todo"><li>牛乳を買う</li><li>手紙を書く</li></ul>');
    const box = (i) => p.evaluate((i) => { const r = document.querySelectorAll("#contentEditor ul.todo > li")[i].getBoundingClientRect(); return { x: r.left + 8, y: r.top + 10 }; }, i);
    let b = await box(0);
    await p.mouse.click(b.x, b.y);
    ok(await p.evaluate(() => document.querySelectorAll("#contentEditor ul.todo > li")[0].getAttribute("data-done") === "1"), "t3: 四角を押すと済みになる");
    const cs = await p.evaluate(() => { const li = document.querySelectorAll("#contentEditor ul.todo > li")[0]; return { td: getComputedStyle(li).textDecorationLine, before: getComputedStyle(li, "::before").content }; });
    ok(/line-through/.test(cs.td) && /✓/.test(cs.before), "t3: 済みは ✓ と取り消し線で見える", cs);
    // 文字のところを押しても切り替わらない（文を直せる）
    const tx = await p.evaluate(() => { const r = document.querySelectorAll("#contentEditor ul.todo > li")[1].getBoundingClientRect(); return { x: r.left + 60, y: r.top + 10 }; });
    await p.mouse.click(tx.x, tx.y);
    ok(await p.evaluate(() => !document.querySelectorAll("#contentEditor ul.todo > li")[1].hasAttribute("data-done")), "t3: 文字を押しても切り替わらない");
    // Enter でできた次の項目は「まだ」
    await caretAt(p, "牛乳を買う");
    await p.keyboard.press("End");
    await p.keyboard.press("Enter");
    await p.keyboard.type("パンも");
    const lis = await p.evaluate(() => Array.from(document.querySelectorAll("#contentEditor ul.todo > li")).map((l) => [l.textContent, l.getAttribute("data-done")]));
    ok(lis.length === 3 && lis[1][0] === "パンも" && lis[1][1] === null && lis[0][1] === "1", "t3: 済みの項目で改行しても、次の項目は「まだ」", lis);
    await p.evaluate(() => saveEntry(true));
    const q = await open(ctx);
    await q.evaluate(() => loadEntry(entries[0]));
    ok(await q.evaluate(() => { const l = document.querySelectorAll("#contentEditor ul.todo > li"); return l[0].getAttribute("data-done") === "1" && !l[1].hasAttribute("data-done"); }), "t3: 開き直しても済みのまま");
    b = await (async () => q.evaluate(() => { const r = document.querySelectorAll("#contentEditor ul.todo > li")[0].getBoundingClientRect(); return { x: r.left + 8, y: r.top + 10 }; }))();
    await q.mouse.click(b.x, b.y);
    await q.evaluate(() => saveEntry(true));
    ok(!/data-done/.test((await stored(q))[0].content.split("</li>")[0]), "t3: もう一度押すと「まだ」に戻り、保存される");
    // Ctrl+Enter でも切り替わる
    await caretAt(q, "手紙を書く");
    await q.keyboard.press("Control+Enter");
    ok(await q.evaluate(() => Array.from(document.querySelectorAll("#contentEditor ul.todo > li")).find((l) => l.textContent === "手紙を書く").getAttribute("data-done") === "1"), "t3: Ctrl+Enter でも済みにできる");
    // 済みの項目の始めで改行（上に空の項目ができる）しても、空の項目は「まだ」、元の項目は済みのまま
    await caretAt(q, "手紙を書く", false);
    await q.keyboard.press("Enter");
    const li2 = await q.evaluate(() => Array.from(document.querySelectorAll("#contentEditor ul.todo > li")).map((l) => [l.textContent, l.getAttribute("data-done")]));
    const at = li2.findIndex((x) => x[0] === "手紙を書く");
    ok(at > 0 && li2[at][1] === "1" && li2[at - 1][0] === "" && li2[at - 1][1] === null, "t3: 済みの項目の始めで改行しても、できた空の項目は「まだ」", li2);
    await ctx.close();
    // スマホ（指で押す）
    const ctx2 = await newDevice(browser, { contextOptions: PHONE });
    const r = await open(ctx2);
    await startEntry(r);
    await setBody(r, '<ul class="todo"><li>指で押す</li></ul>');
    await sleep(700);   // 開いたときの本文までのスクロールが終わるのを待つ
    await r.evaluate(() => document.querySelector("#contentEditor ul.todo > li").scrollIntoView({ block: "center" }));
    await sleep(200);
    const bb = await r.evaluate(() => { const x = document.querySelector("#contentEditor ul.todo > li").getBoundingClientRect(); return { x: x.left + 9, y: x.top + 11 }; });
    await r.touchscreen.tap(bb.x, bb.y);
    ok(await r.evaluate(() => document.querySelector("#contentEditor ul.todo > li").getAttribute("data-done") === "1"), "t3(スマホ): 指で四角を押しても済みになる");
    await ctx2.close();
  });
}

/* ── t4. 元に戻す・やり直し ── */
if (want("t4")) {
  console.log("t4) 元に戻す・やり直し");
  await section("t4", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    await startEntry(p);
    ok(await p.evaluate(() => document.querySelector('#rteBar [data-cmd="undo"]').disabled), "t4: 何もしていないうちは「元に戻す」は押せない");
    await p.keyboard.type("きょうのこと");
    await sleep(1100);
    await selWord(p, "きょう");
    await cmd(p, "bold");
    ok(/<strong>きょう<\/strong>/.test(await bodyHtml(p)), "準備: 太字にした");
    await cmd(p, "undo");
    ok((await bodyHtml(p)) === "きょうのこと", "t4: ↶ で太字を取り消す", await bodyHtml(p));
    await cmd(p, "redo");
    ok(/<strong>きょう<\/strong>のこと/.test(await bodyHtml(p)), "t4: ↷ でやり直す", await bodyHtml(p));
    await p.keyboard.press("Control+z");
    await p.keyboard.press("Control+z");
    ok((await bodyHtml(p)) === "", "t4: Ctrl+Z で打った文字も戻せる", await bodyHtml(p));
    await p.keyboard.press("Control+y");
    ok((await bodyHtml(p)) === "きょうのこと", "t4: Ctrl+Y でやり直す", await bodyHtml(p));
    await p.evaluate(() => saveEntry(true));
    ok((await stored(p))[0].content === "きょうのこと", "t4: 戻した内容が保存される");
    await ctx.close();
  });
}

/* ── t5. ダークモードの色 ── */
if (want("t5")) {
  console.log("t5) ダークモードでも読める色");
  await section("t5", async () => {
    const ctx = await newDevice(browser, { contextOptions: { ...PC, colorScheme: "dark" } });
    const p = await open(ctx);
    await startEntry(p);
    const cls = ["red", "orange", "green", "blue", "purple", "gray"];
    const hls = ["yellow", "green", "pink", "blue"];
    await setBody(p, cls.map((c) => `<div><span class="fc-${c}">色${c}</span></div>`).join("") + hls.map((c) => `<div><mark class="hl-${c}">蛍光${c}</mark></div>`).join(""));
    const res = await p.evaluate(([cls, hls]) => {
      const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) return c; } return [255, 255, 255]; };
      const ed = document.getElementById("contentEditor");
      const paper = bgOf(ed);
      return {
        dark: matchMedia("(prefers-color-scheme: dark)").matches,
        fc: cls.map((c) => { const el = ed.querySelector(".fc-" + c); return [c, +cr(rgb(getComputedStyle(el).color), bgOf(el)).toFixed(2)]; }),
        hl: hls.map((c) => { const el = ed.querySelector(".hl-" + c); const bg = rgb(getComputedStyle(el).backgroundColor); return [c, +cr(rgb(getComputedStyle(el).color), bg).toFixed(2), +cr(bg, paper).toFixed(2)]; }),
        fcColors: cls.map((c) => getComputedStyle(ed.querySelector(".fc-" + c)).color),
        hlColors: hls.map((c) => getComputedStyle(ed.querySelector(".hl-" + c)).backgroundColor),
        base: getComputedStyle(ed).color,
        text: +cr(rgb(getComputedStyle(ed).color), paper).toFixed(2)
      };
    }, [cls, hls]);
    ok(res.dark, "準備: ダークモードで開いている");
    ok(new Set(res.fcColors).size === cls.length && !res.fcColors.includes(res.base), "t5: 6色とも色が付き、見分けられる", res.fcColors);
    ok(new Set(res.hlColors).size === hls.length, "t5: 蛍光ペンの4色も見分けられる", res.hlColors);
    ok(res.fc.every(([, r]) => r >= 4.5), "t5: 文字の色はどれも紙の上で読める（コントラスト 4.5 以上）", res.fc);
    ok(res.hl.every(([, r]) => r >= 4.5), "t5: 蛍光ペンの上の文字も読める（4.5 以上）", res.hl);
    ok(res.hl.every(([, , v]) => v >= 1.2), "t5: 蛍光ペンの色は紙の色と見分けられる", res.hl);
    ok(res.text >= 4.5, "t5: ふつうの文字も読める", res.text);
    await ctx.close();
  });
}

/* ── t6. Markdown ── */
if (want("t6")) {
  console.log("t6) Markdown の書き出し");
  await section("t6", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    const html = '<h2>大見出し</h2><h3>中見出し</h3><h4>小見出し</h4><div><strong>太</strong>と<span class="fc-red">赤</span>と<mark class="hl-yellow">黄</mark>と<span class="fs-l">大</span>と<u>下</u></div>'
      + '<ul class="todo"><li>まだのこと</li><li data-done="1">済んだこと</li></ul><ol><li>一つ目</li><li>二つ目</li></ol><ul><li>点</li></ul>'
      + '<div><span class="dy-file" data-fid="fabcd12345" data-name="報告.xlsx" data-size="2048">報告.xlsx</span></div>'
      + '<div><a class="gcard gcard-sheet" href="https://docs.google.com/spreadsheets/d/abc/edit" target="_blank" rel="noopener noreferrer">家計簿</a></div>'
      + '<blockquote><div>引用です</div></blockquote><div><a href="https://example.com/" target="_blank" rel="noopener noreferrer">例</a><img data-did="iabcd12345"></div>';
    await addEntry(p, "2026-10-10", "書式の日", html);
    await addEntry(p, "2026-10-11", "古い日", "<p>一行目<br>二行目</p>");
    const out = await p.evaluate(async () => (await buildExportPayload("md")).text);
    const has = (s) => out.split("\n").includes(s);
    ok(has("### 大見出し") && has("#### 中見出し") && has("##### 小見出し"), "t6: 見出しは日記の見出し（##）の下に ### / #### / #####", out);
    ok(has("**太**と赤と黄と大と下"), "t6: 太字は **、色・蛍光ペン・大きさ・下線は文字だけ残す", out);
    ok(has("- [ ] まだのこと") && has("- [x] 済んだこと"), "t6: チェックボックスは - [ ] / - [x]", out);
    ok(has("1. 一つ目") && has("2. 二つ目") && has("- 点"), "t6: 番号付き・箇条書き", out);
    ok(has("📎 報告.xlsx"), "t6: ファイルは「📎 名前」", out);
    ok(has("📊 Googleスプレッドシート: [家計簿](https://docs.google.com/spreadsheets/d/abc/edit)"), "t6: Google のカードは種類つきのリンク", out);
    ok(has("> 引用です") && has("[例](https://example.com/)🖼️ 画像"), "t6: 引用・リンク・画像の印", out);
    ok(has("一行目") && has("二行目"), "t6: 古い日記の改行も残る", out);
    ok(!/<\/?[a-z][^>]*>|class=|fc-red|hl-yellow/.test(out.replace(/^.*生成日時.*$/m, "")), "t6: HTML のタグや class 名は残らない", out);
    await ctx.close();
  });
}

/* ── t7. 貼り付け ── */
if (want("t7")) {
  console.log("t7) Word・Googleドキュメント・Webページの貼り付け");
  await section("t7", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    await startEntry(p);
    const reqs = [];
    p.on("request", (r) => reqs.push(r.url()));
    const paste = (html, plain = "") => p.evaluate(([html, plain]) => {
      const ed = document.getElementById("contentEditor");
      ed.innerHTML = ""; ed.focus();
      const dt = new DataTransfer();
      if (html) dt.setData("text/html", html);
      if (plain) dt.setData("text/plain", plain);
      ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      return ed.innerHTML;
    }, [html, plain]);
    const word = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{color:red}</style></head><body><!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]-->'
      + '<p class="MsoNormal" style="margin:0cm"><b><span style="font-size:14pt;color:red">太字</span></b><span style="font-style:italic">斜体</span><span style="text-decoration:underline">下線</span><o:p></o:p></p>'
      + '<img src="https://evil.example/x.png" onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">悪</a></body></html>';
    const w = await paste(word);
    ok(/<b><span>太字<\/span><\/b>/.test(w) && /<em>斜体<\/em>/.test(w) && /<u>下線<\/u>/.test(w), "t7(Word): 太字・斜体・下線は残す（style はタグに置き換え）", w);
    ok(!/style=|class=|MsoNormal|<o:p|<!--|<script|<img|javascript:|onerror/i.test(w), "t7(Word): style・class・コメント・script・外部の画像・javascript: は残さない", w);
    const gdoc = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234"><p dir="ltr" style="line-height:1.38"><span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:700;">太い</span><span style="font-size:11pt;font-weight:400;">ふつう</span></p></b>';
    const g = await paste(gdoc);
    ok(/<strong>太い<\/strong>/.test(g) && !/<b[\s>]/.test(g) && !/<strong>[^<]*ふつう/.test(g) && !/id=|dir=/.test(g), "t7(Googleドキュメント): 全体が太字にならず、太字の所だけ strong", g);
    const web = '<div class="fc-red todo" style="color:red" onclick="x()"><mark class="hl-pink evil">ピンク</mark><span class="fc-blue" style="font-size:40px">青</span><span class="dy-file" data-fid="../etc" data-name="a">偽</span><ul class="todo"><li data-done="yes">x</li><li data-done="1">y</li></ul><iframe src="https://evil.example/"></iframe></div>';
    const wb = await paste(web);
    ok(/<div><mark class="hl-pink">ピンク<\/mark><span class="fc-blue">青<\/span><span>偽<\/span><ul class="todo"><li>x<\/li><li data-done="1">y<\/li><\/ul><\/div>/.test(wb), "t7(Web): 決まった名前の class だけ残り、形の違うファイルの目印・済みの印は外す", wb);
    ok(!/onclick|iframe|style=|data-fid|data-name/.test(wb), "t7(Web): イベント・iframe・style・偽のファイル id は残らない", wb);
    await sleep(300);
    ok(!reqs.some((u) => /evil\.example/.test(u)), "t7: 貼り付けで外へ通信しない", reqs.filter((u) => /evil/.test(u)));
    await ctx.close();
  });
}

/* ── t8. 古い日記 ── */
if (want("t8")) {
  console.log("t8) 古い日記はそのまま");
  await section("t8", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    // 修正前の sanitizeHtml の結果（同じ入力で修正前のページから取ったもの）
    const corpus = [
      ['<div>ふつうの文<strong>太字</strong>と<em>斜体</em>と<s>取消</s></div>', '<div>ふつうの文<strong>太字</strong>と<em>斜体</em>と<s>取消</s></div>'],
      ['<p>段落</p><ul><li>一</li><li>二</li></ul><blockquote>引用</blockquote>', '<p>段落</p><ul><li>一</li><li>二</li></ul><blockquote>引用</blockquote>'],
      ['<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table><br>', '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table><br>'],
      ['<a href="https://example.com/" target="_blank" rel="noopener noreferrer">リンク</a>', '<a href="https://example.com/" target="_blank" rel="noopener noreferrer">リンク</a>'],
      ['<div>画像<img data-did="iabcd12345" alt="写真"></div>', '<div>画像<img data-did="iabcd12345" alt="写真"></div>'],
      ['<b>B</b><i>I</i><u>U</u><h2>見出し</h2><ol><li>x</li></ol><hr>', '<b>B</b><i>I</i><u>U</u><h2>見出し</h2><ol><li>x</li></ol><hr>'],
      ['<div><span style="font-weight: 700;">x</span><span class="Apple-tab-span" style="white-space:pre">\t</span></div>', '<div><span>x</span><span>\t</span></div>'],
      ['<div onclick="x()">a<script>bad()</script><a href="javascript:alert(1)">j</a></div>', '<div>a<a target="_blank" rel="noopener noreferrer">j</a></div>'],
      ['<font color="red">赤</font><mark>印</mark><span class="foo">s</span>', '<font>赤</font><mark>印</mark><span>s</span>']
    ];
    const got = await p.evaluate((c) => c.map(([h]) => sanitizeHtml(h)), corpus);
    ok(got.every((g, i) => g === corpus[i][1]), "t8: 古い形の本文は、修正前と同じ形で出る", got.map((g, i) => g === corpus[i][1] ? "=" : g));
    await addEntry(p, "2026-09-20", "古い日記", corpus.slice(0, 4).map((c) => c[0]).join(""));
    const view = await p.evaluate(() => {
      const ed = document.getElementById("contentEditor");
      const s = (sel, prop) => getComputedStyle(ed.querySelector(sel))[prop];
      return { html: ed.innerHTML, pMargin: s("p", "marginTop"), ul: s("ul", "listStyleType"), ulPad: s("ul", "paddingLeft"), bq: s("blockquote", "marginLeft"), strong: s("strong", "fontWeight"), a: s("a", "textDecorationLine"), td: s("td", "borderTopStyle") };
    });
    ok(view.html === corpus.slice(0, 4).map((c) => c[1]).join(""), "t8: 古い日記を開いても本文の形は変わらない", view.html);
    ok(view.pMargin === "16px" && view.ul === "disc" && view.ulPad === "40px" && view.bq === "40px" && view.strong === "700" && /underline/.test(view.a) && view.td === "solid", "t8: 段落・箇条書き・引用・太字・リンク・表の見た目も今までどおり", view);
    // 古い <b> の太字もボタンで戻せる
    await setBody(p, "<div><b>古い太字</b></div>");
    await selWord(p, "古い太字");
    await cmd(p, "bold");
    ok((await bodyHtml(p)) === "<div>古い太字</div>", "t8: 古い <b> の太字も太字ボタンで外せる", await bodyHtml(p));
    await ctx.close();
  });
}

/* ── f1. ファイル ── */
if (want("f1")) {
  console.log("f1) ファイルを入れる・開く・保存する");
  await section("f1", async () => {
    const ctx = await newDevice(browser, { contextOptions: { ...PC, acceptDownloads: true } });
    const p = await open(ctx);
    await startEntry(p);
    await p.keyboard.type("資料: ");
    ok(await attach(p, [XLSX, DOCX, PDF]) === 3, "f1: 3つ入る");
    const cards = await p.evaluate(() => Array.from(document.querySelectorAll("#contentEditor .dy-file")).map((c) => ({ fid: c.getAttribute("data-fid"), ic: c.querySelector(".dyf-ic") && c.querySelector(".dyf-ic").textContent, name: c.querySelector(".dyf-name") && c.querySelector(".dyf-name").textContent, size: c.querySelector(".dyf-size") && c.querySelector(".dyf-size").textContent, ce: c.getAttribute("contenteditable") })));
    ok(cards.length === 3 && cards.map((c) => c.ic).join("") === "📊📝📕", "f1: Excel 📊・Word 📝・PDF 📕 のカード", cards);
    ok(cards.every((c) => /^f[a-z0-9]+$/.test(c.fid) && c.name && /B|KB/.test(c.size) && c.ce === "false"), "f1: カードに名前と大きさ（ひとかたまりで動く）", cards);
    const r0 = await fileRec(p, cards[0].fid);
    ok(r0 && r0.text === XLSX.text && r0.type === XLSX.type && r0.size > 0 && r0.enc === 0, "f1: 中身は端末の記録（IndexedDB）に、形式ごと置く", r0);
    await p.evaluate(() => saveEntry(true));
    const c0 = (await stored(p))[0].content;
    ok(new RegExp(`<span class="dy-file" data-fid="${cards[0].fid}" data-name="家計簿.xlsx" data-size="\\d+">家計簿.xlsx</span>`).test(c0) && !/contenteditable|dyf-|role=|tabindex/.test(c0), "f1: 本文に残るのは目印（id・名前・大きさ）だけ", c0);
    ok(!c0.includes("XLSX-SECRET-MARKER"), "f1: 本文（localStorage）に中身は入れない");
    // ツールバーの📎から選ぶ
    const [chooser] = await Promise.all([p.waitForEvent("filechooser"), cmd(p, "file")]);
    await chooser.setFiles([{ name: "メモ.txt", mimeType: "text/plain", buffer: Buffer.from("テキストの中身 TXT-MARKER") }]);
    await waitFor(async () => (await fids(p)).length === 4, { timeout: 5000 });
    ok(true, "f1: ツールバーの📎から選んでも入る");
    // ドロップ（画像でないもの）・貼り付け（ファイルをコピーしたもの）
    await p.evaluate(() => {
      const ed = document.getElementById("contentEditor"), r = ed.getBoundingClientRect();
      const dt = new DataTransfer(); dt.items.add(new File(["a,b\n1,2"], "表.csv", { type: "text/csv" }));
      ed.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }));
    });
    await waitFor(async () => (await fids(p)).length === 5, { timeout: 5000 });
    ok(true, "f1: ドラッグして落としても入る");
    await p.evaluate(() => {
      const ed = document.getElementById("contentEditor");
      const dt = new DataTransfer(); dt.items.add(new File(["PK zip"], "まとめ.zip", { type: "application/zip" }));
      ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await waitFor(async () => (await fids(p)).length === 6, { timeout: 5000 });
    ok(true, "f1: コピーしたファイルを貼り付けても入る");
    ok(await p.evaluate(() => /📎/.test(document.querySelector("#entriesList, #listView") ? (renderEntriesList(), document.getElementById("entriesList").innerHTML) : "")), "f1: 一覧にファイルありの印（📎）");
    // 大きすぎるもの
    const before = (await fids(p)).length;
    ok(await attach(p, [{ name: "大きい.mov", type: "video/quicktime", size: 26 * 1024 * 1024 }]) === 0 && (await fids(p)).length === before, "f1: 25 MB を超えるものは入れない");
    ok(await toastSeen(p, /大きすぎる.*25\.0 MB まで/), "f1: 理由（1つ 25 MB まで）を伝える");
    // 開く／保存の決まり
    await attach(p, [{ name: "危ない.html", type: "text/html", text: "<script>alert(document.cookie)</script>HTML-MARKER" }, { name: "偽物.pdf", type: "text/html", text: "<script>alert(1)</script>" }]);
    const ids = await fids(p);
    const card = (name) => p.locator(`#contentEditor .dy-file[data-name="${name}"]`);
    const menuLabels = async () => p.evaluate(() => Array.from(document.querySelectorAll(".rte-pop button")).map((b) => b.textContent.trim()));
    await card("案内.pdf").click();
    ok((await menuLabels()).some((t) => /開く/.test(t)) && (await menuLabels()).some((t) => /保存/.test(t)), "f1: PDF は「開く」「保存」を選べる", await menuLabels());
    await p.keyboard.press("Escape");
    await card("危ない.html").click();
    const ml = await menuLabels();
    ok(!ml.some((t) => /開く/.test(t)) && ml.some((t) => /保存/.test(t)), "f1: HTML は「開く」を出さない（保存だけ）", ml);
    const [dl] = await Promise.all([p.waitForEvent("download"), pick(p, "⬇ 保存（ダウンロード）")]);
    const fs = await import("node:fs");
    const dlText = fs.readFileSync(await dl.path(), "utf8");
    ok(dl.suggestedFilename() === "危ない.html" && dlText.includes("HTML-MARKER"), "f1: HTML は元の名前で保存（ダウンロード）する", dl.suggestedFilename());
    // テキストは新しいタブで開く（blob: の text/plain）
    await card("メモ.txt").click();
    const [pop] = await Promise.all([ctx.waitForEvent("page"), pick(p, "↗ 開く（新しいタブ）")]);
    await pop.waitForURL(/^blob:/, { timeout: 5000 });
    ok(/TXT-MARKER/.test(await pop.evaluate(() => document.body.innerText)), "f1: テキストは新しいタブで開く");
    ok(await pop.evaluate(() => window.opener === null && document.contentType === "text/plain"), "f1: 開いたタブはこの画面に触れず、形式は text/plain", await pop.evaluate(() => document.contentType));
    await pop.close();
    // 名前は .pdf でも中身が HTML と記録されたものは、開かずに保存する
    await card("偽物.pdf").click();
    const [dl2] = await Promise.all([p.waitForEvent("download"), pick(p, "↗ 開く（新しいタブ）")]);
    await sleep(300);
    ok(dl2.suggestedFilename() === "偽物.pdf" && !ctx.pages().some((pg) => /^blob:/.test(pg.url())), "f1: 形式が HTML のものは、名前が .pdf でも新しいタブで開かない（保存にする）", ctx.pages().map((x) => x.url()));
    ok(await p.evaluate(() => fileOpenType("a.pdf", "application/pdf") === "application/pdf" && fileOpenType("a.svg", "image/svg+xml") === null && fileOpenType("a.htm", "") === null && fileOpenType("a.js", "text/javascript") === null && fileOpenType("a.png", "") === "image/png"), "f1: 開いてよい形式の決まり（PDF・画像は開く、SVG・HTML・JS は開かない）");
    // 本文から外す → 元に戻すで戻る
    await card("議事録.docx").click();
    await pick(p, "✕ 本文から外す");
    ok(!(await fids(p)).includes(cards[1].fid), "f1: 「本文から外す」でカードが消える");
    await cmd(p, "undo");
    ok((await fids(p)).includes(cards[1].fid), "f1: 元に戻すでカードが戻る");
    await ctx.close();
  });
}

/* ── f2. 暗号化・Drive・バックアップ ── */
if (want("f2")) {
  console.log("f2) ファイルの暗号化・Drive 同期・バックアップ");
  await section("f2", async () => {
    const drive = createFakeDrive();
    const dyFiles = () => [...drive.files.values()].filter((f) => f.name.startsWith("dy-file-") && !f.trashed);
    const ctxA = await newDevice(browser, { drive, contextOptions: PC });
    const ctxB = await newDevice(browser, { drive, contextOptions: PC });
    const A = await open(ctxA);
    await startEntry(A);
    await attach(A, [XLSX]);
    const [fid] = await fids(A);
    await A.evaluate(() => saveEntry(true));
    await A.evaluate(() => drivePushAll(false));
    let dy = dyFiles();
    ok(dy.length === 1 && dy[0].name === "dy-file-" + fid && dy[0].parents.includes("appDataFolder") && dy[0].appProperties.ks === "plain", "f2: ファイルは appDataFolder の dy-file-<id> に1つずつ置く（Drive が平文なら ks=plain）", dy.map((f) => [f.name, f.appProperties]));
    const dj = drive.byName("diary.json")[0];
    ok(dj && !drive.text(dj.id).includes("XLSX-SECRET-MARKER"), "f2: diary.json にファイルの中身は入れない");
    const B = await open(ctxB);
    await B.evaluate(() => drivePullAndMerge(false));
    const rb = await fileRec(B, fid);
    ok(rb && rb.text === XLSX.text && rb.type === XLSX.type, "f2: 2台目は Drive から受け取って開ける（形式もそのまま）", rb);
    await B.evaluate(() => loadEntry(entries[0]));
    ok((await fids(B)).includes(fid), "f2: 2台目の本文にもカードが出る");
    // A で暗号化 → 端末の記録も Drive も暗号文。古い平文のファイルは Drive から消す
    const oldId = dy[0].id;
    await setPass(A, "f2-pass-5678");
    const ra = await fileRec(A, fid);
    const salt = await A.evaluate(() => encMeta.salt);
    ok(ra && ra.enc === 1 && ra.ks === salt && !ra.raw.includes("XLSX-SECRET-MARKER") && ra.text === XLSX.text, "f2: 暗号化を有効にすると、ファイルも同じ鍵で暗号化し直す（中身は読める）", { enc: ra && ra.enc, ks: ra && ra.ks });
    await A.evaluate(() => drivePushAll(false));
    dy = dyFiles();
    ok(dy.length === 1 && dy[0].id !== oldId && !drive.files.has(oldId) && dy[0].appProperties.ks === salt && !dy[0].content.includes(Buffer.from("XLSX-SECRET-MARKER")), "f2: Drive のファイルも暗号文で作り直し、平文の古いファイルは消す", dy.map((f) => f.appProperties));
    // B（暗号化していない）が入れたファイルも、暗号化された Drive には暗号文で置く
    B.answers.push("f2-pass-5678");
    await B.evaluate(() => drivePullAndMerge(false));
    await B.evaluate(() => loadEntry(entries[0]));
    await B.evaluate(() => rteFocusBody(true));
    await attach(B, [DOCX]);
    const fidB = (await fids(B)).find((x) => x !== fid);
    await B.evaluate(() => saveEntry(true));
    B.answers.push("f2-pass-5678");
    await B.evaluate(() => drivePushAll(false));
    const fb = dyFiles().find((f) => f.name === "dy-file-" + fidB);
    ok(fb && fb.appProperties.ks === salt && !fb.content.includes(Buffer.from("DOCX-MARKER")), "f2: 暗号化していない端末のファイルも、暗号化された Drive には平文で置かない", fb && fb.appProperties);
    // 新しい端末 C はパスフレーズで両方とも読める
    const ctxC = await newDevice(browser, { drive, contextOptions: PC });
    const C = await open(ctxC);
    C.answers.push("f2-pass-5678");
    await C.evaluate(() => drivePullAndMerge(false));
    const rc1 = await fileRec(C, fid), rc2 = await fileRec(C, fidB);
    ok(rc1 && rc1.text === XLSX.text && rc2 && rc2.text === DOCX.text, "f2: 新しい端末はパスフレーズを入れて、どちらのファイルも開ける");
    // A でパスフレーズを変える → 包み直しにファイルも入る
    await A.evaluate(() => drivePullAndMerge(true));
    await setPass(A, "f2-pass-9999");
    const salt2 = await A.evaluate(() => encMeta.salt);
    const ra2 = await fileRec(A, fidB);
    ok(ra2 && ra2.ks === salt2 && ra2.text === DOCX.text, "f2: パスフレーズを変えると、ファイルも新しい鍵で包み直す", ra2 && { ks: ra2.ks, err: ra2.err });
    // JSON の書き出し（それだけで戻せる）→ 新しい端末に取り込む
    const exp = await A.evaluate(async () => JSON.parse((await buildExportPayload("json")).text));
    const ei = (exp.images || []).find((x) => x.id === fid);
    ok(ei && /^data:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet;base64,/.test(ei.dataUrl) && Buffer.from(ei.dataUrl.split(",")[1], "base64").toString("utf8") === XLSX.text, "f2: JSON の書き出しにファイルの中身が入る", ei && ei.dataUrl.slice(0, 80));
    const ctxD = await newDevice(browser, { contextOptions: PC });
    const D = await open(ctxD);
    await D.setInputFiles("#importFileExport", { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exp)) });
    await D.evaluate(() => importDataFrom("importFileExport", "exportModal"));
    await toastSeen(D, /インポート完了/, 8000);
    const rd = await fileRec(D, fid);
    ok(rd && rd.text === XLSX.text && rd.type === XLSX.type, "f2: その JSON を取り込むと、ファイルも戻る", rd);
    // 細工した書き出し: ファイルの id に data: 以外の URL は読まない
    const reqs = [];
    D.on("request", (r) => reqs.push(r.url()));
    const failed = await D.evaluate(() => restoreImages([{ id: "fevil12345", type: "text/plain", dataUrl: "https://evil.example/steal" }]));
    await sleep(200);
    ok(failed === 0 && !reqs.some((u) => /evil\.example/.test(u)) && !(await fileRec(D, "fevil12345")), "f2: 取り込みでファイルの id に外の URL があっても読みに行かない");
    await ctxA.close(); await ctxB.close(); await ctxC.close(); await ctxD.close();
  });
}

/* ── f3. Google のリンク ── */
if (want("f3")) {
  console.log("f3) Google のリンクをカードに");
  await section("f3", async () => {
    const ctx = await newDevice(browser, { contextOptions: PC });
    const p = await open(ctx);
    await startEntry(p);
    const pasteUrl = (u) => p.evaluate((u) => {
      const ed = document.getElementById("contentEditor");
      ed.focus();
      const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); rteSetSelection(r);
      const dt = new DataTransfer(); dt.setData("text/plain", u);
      ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      const a = ed.querySelectorAll("a"); const x = a[a.length - 1];
      return x ? { cls: x.className, text: x.textContent, href: x.getAttribute("href"), target: x.getAttribute("target"), rel: x.getAttribute("rel"), after: getComputedStyle(x, "::after").content, before: getComputedStyle(x, "::before").content } : null;
    }, u);
    const s = await pasteUrl("https://docs.google.com/spreadsheets/d/abc123/edit#gid=0");
    ok(s && s.cls === "gcard gcard-sheet" && s.text === "Googleスプレッドシート" && /📊/.test(s.before) && s.target === "_blank" && s.rel === "noopener noreferrer", "f3: スプレッドシートの URL を貼ると、📊 Googleスプレッドシート のカード（新しいタブのリンク）", s);
    ok(s && s.after === "none", "f3: 表示名が無いときは種類の名前を2度出さない", s);
    const kinds = [
      ["https://docs.google.com/document/d/xyz/edit", "gcard gcard-doc", "Googleドキュメント", "📝"],
      ["https://docs.google.com/presentation/d/pp/edit", "gcard gcard-slide", "Googleスライド", "📽"],
      ["https://docs.google.com/forms/d/e/ff/viewform", "gcard gcard-form", "Googleフォーム", "📋"],
      ["https://forms.gle/AbCdEf", "gcard gcard-form", "Googleフォーム", "📋"],
      ["https://drive.google.com/file/d/ddd/view?usp=sharing", "gcard gcard-drive", "Googleドライブのファイル", "📁"],
      ["https://docs.google.com/u/1/spreadsheets/d/q/edit", "gcard gcard-sheet", "Googleスプレッドシート", "📊"]
    ];
    for (const [u, cls, label, icon] of kinds) {
      const r = await pasteUrl(u);
      ok(r && r.cls === cls && r.text === label && r.before.includes(icon), `f3: ${label} → ${icon}（${u.slice(8, 40)}…）`, r);
    }
    const plain = await pasteUrl("https://example.com/docs.google.com/document/d/x");
    ok(plain && plain.cls === "", "f3: Google 以外のリンクはふつうのリンクのまま", plain);
    // リンクのダイアログで表示名を付ける（スキームを省いても https を補う）
    await p.evaluate(() => { const ed = document.getElementById("contentEditor"); ed.insertAdjacentHTML("beforeend", "<div>家計簿</div>"); syncEditorContent(); });
    await selWord(p, "家計簿");
    await cmd(p, "link");
    await p.fill("#linkUrl", "docs.google.com/spreadsheets/d/kakeibo/edit");
    await p.click("#linkModal .btn-primary");
    const k = await p.evaluate(() => { const a = Array.from(document.querySelectorAll("#contentEditor a")).find((x) => x.textContent === "家計簿"); return a ? { cls: a.className, href: a.getAttribute("href"), after: getComputedStyle(a, "::after").content } : null; });
    ok(k && k.cls === "gcard gcard-sheet" && k.href === "https://docs.google.com/spreadsheets/d/kakeibo/edit" && /Googleスプレッドシート/.test(k.after), "f3: ダイアログで入れても、表示名＋種類のカード", k);
    // 押すと「開く」で新しいタブ
    await p.locator('#contentEditor a.gcard', { hasText: "家計簿" }).click();
    const labels = await p.evaluate(() => Array.from(document.querySelectorAll(".rte-pop button")).map((b) => b.textContent.trim()));
    ok(labels.includes("↗ 開く（新しいタブ）") && labels.includes("✎ 表示名・リンクを編集"), "f3: カードを押すと「開く」「編集」を選べる", labels);
    const [pop] = await Promise.all([ctx.waitForEvent("page"), pick(p, "↗ 開く（新しいタブ）")]);
    await pop.waitForLoadState("domcontentloaded").catch(() => {});
    ok(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/kakeibo\/edit/.test(pop.url()) && await pop.evaluate(() => window.opener === null), "f3: 新しいタブで開く（この画面には触れない）", pop.url());
    await pop.close();
    // 保存して開き直してもカード。見た目だけ Google を名乗るリンクは、ふつうのリンクに戻す
    await p.evaluate(() => saveEntry(true));
    const q = await open(ctx);
    await q.evaluate(() => loadEntry(entries[0]));
    const nCards = await q.evaluate(() => document.querySelectorAll("#contentEditor a.gcard").length);
    ok(nCards === 8, "f3: 開き直してもカードのまま", { nCards, html: await bodyHtml(q) });
    ok(await q.evaluate(() => sanitizeHtml('<a class="gcard gcard-sheet" href="https://evil.example/">x</a><a class="gcard gcard-doc" href="javascript:alert(1)">y</a>')) === '<a href="https://evil.example/" target="_blank" rel="noopener noreferrer">x</a><a target="_blank" rel="noopener noreferrer">y</a>', "f3: Google 以外の href に付いたカードの印は外す（種類は href から決め直す）");
    await ctx.close();
  });
}

/* ── f4. 使われなくなったファイルの片付け ── */
if (want("f4")) {
  console.log("f4) 使われなくなったファイルの片付け");
  await section("f4", async () => {
    const drive = createFakeDrive();
    const ctx = await newDevice(browser, { drive, contextOptions: PC });
    const p = await open(ctx);
    await startEntry(p);
    await attach(p, [XLSX, DOCX]);
    const [keep, drop] = await fids(p);
    await p.evaluate(() => saveEntry(true));
    await p.evaluate((id) => { document.querySelector(`#contentEditor .dy-file[data-fid="${id}"]`).remove(); syncEditorContent(); return saveEntry(true); }, drop);
    await p.evaluate(() => gcImages());
    ok(!!(await fileRec(p, drop)), "f4: 外したばかりのファイルはすぐには消さない（ほかのタブがまだ保存していないかもしれない）");
    // 古い id（猶予を過ぎた）で、どこからも使われていないものは消す。使っているものは残す
    const oldId = await p.evaluate(async () => {
      const id = "f" + (Date.now() - 3600 * 1000).toString(36) + "zzzzzz";
      await imgPut({ id, enc: 0, type: "text/plain", data: new Blob(["old"], { type: "text/plain" }), size: 3 });
      return id;
    });
    await p.evaluate(() => gcImages());
    ok(!(await fileRec(p, oldId)) && !!(await fileRec(p, keep)), "f4: 猶予を過ぎて使われていないファイルは消し、使っているものは残す");
    // Drive: 使われていないファイルは30日たってから消す
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const o1 = drive.put("dy-file-fold0000001", "x", { parents: ["appDataFolder"], mimeType: "application/octet-stream" }); o1.modifiedTime = daysAgo(40);
    const n1 = drive.put("dy-file-fnew0000001", "x", { parents: ["appDataFolder"], mimeType: "application/octet-stream" }); n1.modifiedTime = daysAgo(5);
    await p.evaluate(() => { localStorage.removeItem("diary:gd:imggc"); return drivePushAll(false); });
    ok(!drive.files.has(o1.id) && drive.files.has(n1.id), "f4: Drive の使われていないファイルは30日たってから片付ける");
    ok([...drive.files.values()].some((f) => f.name === "dy-file-" + keep), "f4: 使っているファイルは Drive に残る");
    await ctx.close();
  });
}

ok(pageErrors.length === 0, "ページの未処理の例外が無い", pageErrors.slice(0, 5));
await browser.close();
await srv.close();
done();
