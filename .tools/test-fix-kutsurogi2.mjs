/* くつろぎ（autogenic.html）v47 の改善の検証（配布には不要。要 playwright）
     node .tools/test-fix-kutsurogi2.mjs              … いまのファイルで
     node .tools/test-fix-kutsurogi2.mjs --root=DIR   … 別の場所のファイルで（直す前の版との比べ用）

   見ること:
     [A〜C] 練習のあとの記録カード（公式ごとの感じ方・出たこと・メモ・記録しない・開き直し）
     [D]    記録を1件ずつ直す・消す
     [E]    消去動作の終わり方の印（最後まで・短縮・飛ばした・自分で行った）
     [F]    公式の進め方の目安（心臓・お腹は勧めない、反応があるときは勧めない）
     [G]    タッチで進むときの「触るまでの時間」と、その移り変わり
     [H]    1日の回数（点の濃さ・きょう◯回目）と、公式ごとの4週間の小さなグラフ
     [I]    「みじかく（約2〜3分）」（消去動作はいつも全部。やめる・やり直し・復帰・一時停止でも）
     [J]    姿勢（あお向け・椅子・安楽椅子）と導入
     [K]    2台の同期（新しい項目・直した記録・1件ずつの削除・以前の全消去・以前の版の端末）
   どの練習でも、記録カードは消去動作が最後まで済んでから出ることを確かめる。

   読み上げ・画面の見え方・画面ロックは test-fix-autogenic.mjs と同じ偽物。時計は page.clock で進める。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, launch, newDevice, makeChecker, collectErrors, waitFor, sleep, ROOT } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const rootArg = process.argv.find((a) => a.startsWith("--root="));
const root = rootArg ? path.resolve(rootArg.slice(7)) : ROOT;
const T0 = new Date("2026-10-10T20:00:00Z");   // 日本時間 2026-10-11 05:00
const DAY = 864e5;
const BASE_CFG = { gateSeen: true, steps: { heavy: true }, hand: "R", pace: 1, bg: "", bgVol: 18, wake: true,
                   advance: "time", stageMin: 0, vPitch: 1, vRate: 0.9 };
const N = { intro: "導入", calm: "背景公式", heavy: "第1公式 — 重感", warm: "第2公式 — 温感", heart: "第3公式 — 心臓",
            breath: "第4公式 — 呼吸", belly: "第5公式 — 腹部", brow: "第6公式 — 額" };
// 消去動作（読み上げに渡る字）。短縮版は先頭3行＋最後の1行なので、「伸び」「深く息を吸って」は全部のときだけ読まれる
const CX = { c0: "それでは、体を戻していきます", c1: "両手を、ぎゅっと握って、ひらきます", c2: "しっかり曲げて、伸ばします",
             c3: "大きく、伸びをしてください", c4: "深く息を吸って、ゆっくり吐きます", c5: "ゆっくり、目を開けてください", c6: "おつかれさまでした" };
const FULL = [CX.c0, CX.c1, CX.c2, CX.c3, CX.c4, CX.c5, CX.c6];

function jstDay(ms) { return new Date(ms + 9 * 3600e3).toISOString().slice(0, 10); }
/** 記録1件（ids の段階で練習した） */
function rec(ts, ids, o = {}) {
  return { ts, date: jstDay(ts), sec: 300, steps: ids.map((i) => N[i]), stepIds: ids, level: null, odd: false, ...o };
}

/* ページより先に動かす偽物（test-fix-autogenic.mjs と同じもの＋記録カードの見張り） */
function INIT(arg) {
  if (!sessionStorage.getItem("__seeded")) {
    for (const k in arg.seed) localStorage.setItem(k, arg.seed[k]);
    sessionStorage.setItem("__seeded", "1");
  }
  let vis = "visible";
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get() { return vis; } });
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get() { return vis !== "visible"; } });
  const W = window.__wl = { requests: 0, sentinels: [] };
  function sentinel() {
    const ls = [];
    const s = { released: false, type: "screen",
      addEventListener(t, f) { if (t === "release") ls.push(f); },
      release() { if (!s.released) { s.released = true; ls.forEach((f) => window.setTimeout(() => f({}), 0)); } return Promise.resolve(); } };
    W.sentinels.push(s);
    return s;
  }
  const wakeLock = { request() { W.requests++; return vis === "visible" ? Promise.resolve(sentinel()) : Promise.reject(new DOMException("not visible", "NotAllowedError")); } };
  Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, get() { return wakeLock; } });
  W.drop = () => W.sentinels.filter((s) => !s.released).forEach((s) => s.release());
  window.__setVis = (v) => { vis = v; if (v !== "visible") W.drop(); document.dispatchEvent(new Event("visibilitychange")); };
  const T = window.__tts = { log: [], muted: false };
  const local = { name: "Test Local ja", lang: "ja-JP", voiceURI: "local-ja", localService: true, default: true };
  let queue = [], cur = null;
  function Utt(text) { this.text = String(text); this.voice = null; this.lang = ""; this.rate = 1; this.pitch = 1; this.volume = 1;
                       this.onstart = this.onend = this.onerror = null; }
  window.SpeechSynthesisUtterance = Utt;
  function armEnd(u) {
    u.__t0 = Date.now();
    u.__timer = window.setTimeout(() => { if (cur !== u) return; cur = null; if (u.onend) u.onend({}); startNext(); }, u.__left);
  }
  function startNext() {
    if (cur || T.muted || !queue.length) return;
    cur = queue.shift();
    cur.__left = Math.max(300, cur.text.length * 120);
    if (cur.onstart) cur.onstart({});
    armEnd(cur);
  }
  T.setMuted = (m) => {
    T.muted = !!m;
    if (m) { if (cur && cur.__timer) { window.clearTimeout(cur.__timer); cur.__timer = 0; cur.__left = Math.max(0, cur.__left - (Date.now() - cur.__t0)); } }
    else { if (cur && !cur.__timer && cur.__t0) armEnd(cur); startNext(); }
  };
  const ss = {
    get speaking() { return !!cur; }, get pending() { return queue.length > 0; }, paused: false,
    getVoices() { return [local]; },
    speak(u) { T.log.push({ text: u.text, at: Date.now(), vis }); queue.push(u); window.setTimeout(startNext, 0); },
    cancel() {
      const all = (cur ? [cur] : []).concat(queue);
      if (cur && cur.__timer) window.clearTimeout(cur.__timer);
      cur = null; queue = [];
      all.forEach((u) => window.setTimeout(() => { if (u.onerror) u.onerror({ error: "interrupted" }); }, 0));
    },
    pause() {}, resume() {}, onvoiceschanged: null, addEventListener() {}, removeEventListener() {}
  };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: ss });
  // 記録の問いかけに window.prompt / confirm を使っていないか（使ったら数える）
  window.__dialogs = 0;
  window.prompt = function () { window.__dialogs++; return "1"; };
  window.confirm = function () { window.__dialogs++; return false; };
  // 記録カードが新しい記録のために開いたとき、そのときの様子を残す
  window.__cards = [];
  new MutationObserver((ms) => {
    const m = ms.find((x) => x.target.id === "recCard" && x.target.getAttribute("data-ts"));
    if (!m) return;
    const run = document.getElementById("run");
    window.__cards.push({ at: Date.now(), vis, ts: m.target.getAttribute("data-ts"), run: run ? run.style.display : "",
                          texts: T.log.map((x) => x.text) });
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-ts"] });
}

const srv = await startServer(root);
const browser = await launch();
const { ok, done } = makeChecker("くつろぎ v47 の改善");
console.log("対象: " + path.join(root, "autogenic.html"));

async function openPage(opts = {}) {
  const seed = { "autogenic:cfg": JSON.stringify({ ...BASE_CFG, ...(opts.cfg || {}) }) };
  if (opts.script) seed["autogenic:script"] = JSON.stringify(opts.script);
  if (opts.hist) seed["autogenic:v1"] = JSON.stringify(opts.hist);
  Object.assign(seed, opts.seed || {});
  const context = await newDevice(browser, { contextOptions: { timezoneId: "Asia/Tokyo", hasTouch: !!opts.touch } });
  await context.addInitScript(INIT, { seed });
  const page = await context.newPage();
  const errs = collectErrors(page);
  await page.clock.install({ time: T0 });
  await page.goto(srv.url + "autogenic.html");
  await page.clock.pauseAt(new Date(T0.getTime() + 15000));
  await page.clock.runFor(4000);
  const P = {
    page, context, errs,
    run: (ms) => page.clock.runFor(ms),
    click: (id) => page.evaluate((id) => document.getElementById(id).click(), id),
    q: (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) throw new Error("見つかりません: " + sel); e.click(); }, sel),
    has: (sel) => page.evaluate((sel) => !!document.querySelector(sel), sel),
    text: (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); return e ? e.textContent : null; }, sel),
    ev: (fn, a) => page.evaluate(fn, a),
    texts: () => page.evaluate(() => window.__tts.log.map((x) => x.text)),
    count: async (sub) => (await P.texts()).filter((t) => t.includes(sub)).length,
    hist: () => page.evaluate(() => JSON.parse(localStorage.getItem("autogenic:v1") || "[]")),
    cfg: () => page.evaluate(() => localStorage.getItem("autogenic:cfg")),
    st: () => page.evaluate(() => {
      const g = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
      const c = document.getElementById("recCard");
      return { stage: g("stage"), line: g("line"), toast: document.getElementById("toast").style.display === "block" ? g("toast") : "",
               home: document.getElementById("home").style.display, run: document.getElementById("run").style.display,
               resume: document.getElementById("resume").style.display,
               card: c ? (c.style.display === "block" ? c.getAttribute("data-ts") : "") : null,
               cards: window.__cards.slice(), dialogs: window.__dialogs, pend: localStorage.getItem("autogenic:inPractice"),
               draft: localStorage.getItem("autogenic:recDraft"), now: Date.now() };
    }),
    hide: (mute) => page.evaluate((m) => { if (m) window.__tts.setMuted(true); window.__setVis("hidden"); }, !!mute),
    show: () => page.evaluate(() => { window.__tts.setMuted(false); window.__setVis("visible"); }),
    tap: () => page.evaluate(() => document.getElementById("glyph").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "touch" }))),
    until: async (sub, max = 240000, stepMs = 200) => {
      for (let t = 0; t < max; t += stepMs) { if ((await P.count(sub)) > 0) return true; await P.run(stepMs); }
      return false;
    },
    /** 練習が終わって記録カードが出るまで進める。途中で「練習中なのにカードが出ている」ことが無いかも見る */
    untilCard: async (max = 600000, stepMs = 500) => {
      let early = false;
      for (let t = 0; t < max; t += stepMs) {
        const s = await P.st();
        if (s.card && s.run === "block") early = true;
        if (s.card && s.run !== "block") return { ok: true, early, s };
        await P.run(stepMs);
      }
      return { ok: false, early, s: await P.st() };
    },
    close: () => context.close()
  };
  return P;
}
async function section(title, fn) {
  console.log("\n" + title);
  let P = null;
  try { await fn((p) => (P = p)); }
  catch (e) { ok(false, "検証が途中で止まりました: " + String((e && e.message) || e).split("\n")[0]); }
  finally { if (P) await P.close().catch(() => {}); }
}
function order(texts, subs) {
  let i = 0;
  for (const t of texts) if (i < subs.length && t.includes(subs[i])) i++;
  return i === subs.length;
}
/** 記録カードが開いたのは、消去動作の最後の行（subs の最後）を読み終えてから、練習の画面を閉じたあとか */
function cardAfter(card, subs) {
  if (!card) return false;
  const t = card.texts, last = subs[subs.length - 1];
  return card.run === "none" && order(t, subs) && t.length > 0 && t[t.length - 1].includes(last) && card.vis === "visible";
}
const lastRec = async (P) => { const h = await P.hist(); return h[h.length - 1]; };

try {
  /* ── A. 記録カード：公式ごとの感じ方・出たこと・メモ ── */
  await section("[A] 練習のあとの記録カード（公式が2つ）", async (use) => {
    const P = use(await openPage({ cfg: { steps: { heavy: true, warm: true } } }));
    await P.click("startBtn");
    const r = await P.untilCard();
    ok(r.ok && !r.early, "練習のあいだはカードを出さず、終わってから出す", r);
    let s = await P.st();
    ok(s.cards.length === 1 && cardAfter(s.cards[0], FULL), "カードは消去動作を最後の行まで読んだあとに開く", s.cards[0] && s.cards[0].texts.slice(-8));
    ok(s.dialogs === 0, "window.prompt / confirm は使わない", s.dialogs);
    const card = await P.ev(() => {
      const c = document.getElementById("recCard");
      return { rows: [...c.querySelectorAll(".lvrow")].map((r) => ({ sid: r.getAttribute("data-sid"), b: [...r.querySelectorAll("button")].map((b) => b.textContent), on: r.querySelectorAll(".on").length })),
               names: [...c.querySelectorAll(".rfn")].map((x) => x.textContent), chips: [...c.querySelectorAll(".chip")].map((x) => x.textContent),
               note: !!c.querySelector("#rcNote"), save: (c.querySelector("#rcSave") || {}).textContent, skip: (c.querySelector("#rcSkip") || {}).textContent,
               meta: (c.querySelector(".rcm") || {}).textContent };
    });
    ok(card.rows.length === 2 && card.rows[0].sid === "heavy" && card.rows[1].sid === "warm", "使った公式ごとに感じ方の欄がある（重感・温感）", card.rows);
    ok(card.rows.every((x) => JSON.stringify(x.b) === JSON.stringify(["感じなかった", "すこし", "はっきり", "とてもはっきり"]) && x.on === 0),
       "4つの大きなボタン（これまでの言い方）。はじめは何も選んでいない（OK だけで「すこし」にならない）", card.rows);
    ok(card.names[0] === "重感の感じ方" && card.names[1] === "温感の感じ方", "欄の名前は公式の短い名前", card.names);
    ok(["ピクつき", "涙", "あくび", "だるさが残る", "ぼんやりが残る", "その他…"].every((x) => card.chips.includes(x)), "出たことを選べる", card.chips);
    ok(card.note && card.save === "記録する" && card.skip === "記録しない", "ひとことメモと「記録する／記録しない」", card);
    ok(/きょう1回目/.test(card.meta), "きょう◯回目を出す", card.meta);
    await P.q('#recCard .lvrow[data-sid="heavy"] [data-lv="2"]');
    await P.q('#recCard .lvrow[data-sid="warm"] [data-lv="0"]');
    await P.q('#recCard .lvrow[data-sid="warm"] [data-lv="0"]');   // もう一度押すと外れる
    const off = await P.ev(() => document.querySelectorAll('#recCard .lvrow[data-sid="warm"] .on').length);
    ok(off === 0, "同じボタンをもう一度押すと、選んでいない状態に戻る", off);
    await P.q('#recCard .lvrow[data-sid="warm"] [data-lv="1"]');
    await P.q('#recCard [data-rc="twitch"]');
    await P.q('#recCard [data-rc="yawn"]');
    await P.page.fill("#rcNote", "肩が軽くなった");
    await P.q("#rcSave");
    await P.run(100);
    const h = await P.hist(); s = await P.st();
    const x = h[0] || {};
    ok(h.length === 1 && JSON.stringify(x.feel) === JSON.stringify({ heavy: 2, warm: 1 }), "公式ごとの感じ方を残す", x);
    ok(x.level === 2, "level は 0〜3 のまま（感じ方の平均。古い版の端末の表示用）", x.level);
    ok(JSON.stringify(x.react) === JSON.stringify(["twitch", "yawn"]) && x.odd === true, "出たことを残す（あくび以外があれば「反応あり」）", x);
    ok(x.note === "肩が軽くなった", "メモを残す", x.note);
    ok(JSON.stringify(x.stepIds) === JSON.stringify(["intro", "calm", "heavy", "warm"]) && JSON.stringify(x.steps) === JSON.stringify([N.intro, N.calm, N.heavy, N.warm]),
       "段階の id も残す（表示名はこれまでどおり）", x);
    ok(x.cancelEnd === "full" && !x.cancelWhy, "消去動作の終わり方：最後まで", x);
    ok(!s.card && !s.draft, "記録したらカードを閉じ、答える前の控えも片付ける", s);
    const row = await P.text("#recs .rec");
    ok(/重感 はっきり・温感 すこし/.test(row) && /ピクつき・あくび/.test(row) && /肩が軽くなった/.test(row) && /消去動作 最後まで/.test(row),
       "一覧に、公式ごとの感じ方・出たこと・メモ・消去動作の終わり方が出る", row);
    ok(P.errs.length === 0, "ページのエラーが無い", P.errs);
  });

  /* ── B. 記録しない ── */
  await section("[B] 記録しない", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    await P.untilCard();
    await P.q('#recCard .lvrow[data-sid="heavy"] [data-lv="3"]');
    await P.q("#rcSkip");
    await P.run(100);
    const s = await P.st();
    ok((await P.hist()).length === 0 && !s.card && !s.draft && /記録しませんでした/.test(s.toast), "記録せずにカードを閉じる", s);
  });

  /* ── C. 答えないまま開き直す・次の練習を始める ── */
  await section("[C] 答えていないカードは消えない", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    await P.untilCard();
    const ts0 = (await P.st()).card;
    await P.q('#recCard .lvrow[data-sid="heavy"] [data-lv="3"]');
    await P.page.reload();
    await P.run(4000);
    let s = await P.st();
    const on = await P.ev(() => [...document.querySelectorAll('#recCard .lvrow[data-sid="heavy"] .on')].map((b) => b.getAttribute("data-lv")));
    ok(s.card === ts0 && JSON.stringify(on) === '["3"]', "開き直すと、同じ練習のカードが選んだところまで戻ってくる", { s, on });
    ok((await P.hist()).length === 0, "まだ記録はしていない");
    await P.click("startBtn");
    await P.run(500);
    let h = await P.hist();
    ok(h.length === 1 && String(h[0].ts) === ts0 && h[0].feel.heavy === 3 && h[0].level === 3, "次の練習を始めたら、そのときの中身で記録しておく（記録は失われない）", h);
    const r = await P.untilCard();
    s = await P.st();
    ok(r.ok && !r.early && s.card !== ts0, "次の練習のカードは、その練習が終わってから出る", r);
    await P.q("#rcSave");
    h = await P.hist();
    ok(h.length === 2 && h[1].level === null && JSON.stringify(h[1].feel) === "{}", "何も選ばずに記録すると、感じ方なし（level は空）で残る", h[1]);
  });

  /* ── D. 1件ずつ直す・消す ── */
  await section("[D] 記録を直す・消す", async (use) => {
    const old = { ts: T0.getTime() - 3 * DAY, date: jstDay(T0.getTime() - 3 * DAY), sec: 420, steps: [N.intro, N.calm, N.heavy], level: 2, odd: true };
    const neu = rec(T0.getTime() - DAY, ["intro", "calm", "heavy"], { feel: { heavy: 1 }, level: 1, react: [], cancelEnd: "full" });
    const P = use(await openPage({ hist: [old, neu] }));
    const rows = await P.ev(() => [...document.querySelectorAll("#recs [data-edit]")].map((b) => b.getAttribute("data-edit")));
    ok(rows.length === 2, "どの記録にも「直す」がある", rows);
    await P.q(`#recs [data-edit="${old.ts}"]`);
    let pre = await P.ev(() => ({ on: [...document.querySelectorAll('#recCard .lvrow[data-sid="heavy"] .on')].map((b) => b.getAttribute("data-lv")),
                                   chips: [...document.querySelectorAll("#recCard .chip.on")].map((b) => b.getAttribute("data-rc")),
                                   ttl: document.querySelector("#recCard .ttl").textContent }));
    ok(pre.ttl === "記録を直す" && JSON.stringify(pre.on) === '["2"]' && JSON.stringify(pre.chips) === '["other"]',
       "以前の版の記録も直せる（感じ方は level から、反応ありは「その他」として出す）", pre);
    await P.q("#rcNote");
    await P.page.fill("#rcNote", "前の記録にメモ");
    await P.q("#rcSave");
    let h = await P.hist(); let x = h.find((r) => r.ts === old.ts);
    ok(x && x.level === 2 && x.odd === true && !x.feel && x.note === "前の記録にメモ" && x.ed > 0, "触らなかったところは元のまま（level・反応あり）、直した時刻を残す", x);
    await P.q(`#recs [data-edit="${old.ts}"]`);
    await P.q('#recCard .lvrow[data-sid="heavy"] [data-lv="3"]');
    await P.q("#rcSave");
    h = await P.hist(); x = h.find((r) => r.ts === old.ts);
    ok(x && x.level === 3 && x.feel && x.feel.heavy === 3, "感じ方を直すと、公式ごとの感じ方と level が変わる", x);
    // 消す（少し間をおいた2回押し）
    await P.q(`#recs [data-edit="${neu.ts}"]`);
    await P.q("#rcDel");
    ok((await P.hist()).length === 2 && /もう一度押すと消します/.test(await P.text("#rcDel")), "1回目では消さない");
    await P.q("#rcDel");
    ok((await P.hist()).length === 2, "すぐの2回目（ダブルタップ）では消さない");
    await P.run(1000);
    await P.q("#rcDel");
    h = await P.hist();
    const clr = await P.ev(() => JSON.parse(localStorage.getItem("autogenic:clearedAt") || "null"));
    ok(h.length === 1 && h[0].ts === old.ts, "間をおいた2回目で、その1件だけ消える", h.map((r) => r.ts));
    ok(clr && Array.isArray(clr.keys) && clr.keys.includes(String(neu.ts)) && clr.at === 0, "消した記録の鍵を残す（同期で戻らないように。以前の全消去の時刻はそのまま）", clr);
    ok(P.errs.length === 0, "ページのエラーが無い", P.errs);
  });

  /* ── E. 消去動作の終わり方 ── */
  await section("[E1] やめる → 短縮版", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn"); await P.run(1500); await P.click("stopBtn");
    const r = await P.untilCard();
    const s = await P.st();
    ok(r.ok && !r.early && cardAfter(s.cards[0], [CX.c0, CX.c1, CX.c2, CX.c5, CX.c6]), "短縮版の消去動作を読み切ってからカードを出す", s.cards[0] && s.cards[0].texts.slice(-6));
    await P.q("#rcSave");
    const x = await lastRec(P);
    ok(x.cancelEnd === "short" && x.cancelWhy === "stop", "印：短縮（途中でやめた）", x);
    ok(/消去動作 短縮（途中でやめた）/.test(await P.text("#recs .rec .ce")), "一覧に小さく出る", await P.text("#recs .rec .ce"));
  });
  await section("[E2] 画面が消えて止まっていた → 短縮版", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    await P.until("目を、そっと閉じてください");
    await P.hide(true);
    await P.page.clock.fastForward(150000);
    await P.show();
    const r = await P.untilCard();
    await P.q("#rcSave");
    const x = await lastRec(P);
    ok(r.ok && !r.early && x.cancelEnd === "short" && x.cancelWhy === "stall", "印：短縮（止まっていた）", x);
  });
  await section("[E3] 消去動作の最中に「やめる」を2回 → 飛ばした", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn"); await P.run(1500); await P.click("stopBtn");
    await P.run(1000); await P.click("stopBtn");
    await P.run(1000); await P.click("stopBtn");
    const r = await P.untilCard();
    const s = await P.st();
    ok(r.ok && !r.early && s.cards[0].texts.some((t) => t.includes(CX.c5)), "飛ばしても最後の1行は読み、そのあとでカードを出す", s.cards[0] && s.cards[0].texts.slice(-4));
    ok(/消去動作が短めでした/.test(await P.text("#recCard")), "カードで、手足をもう一度動かすよう伝える");
    await P.q("#rcSave");
    const x = await lastRec(P);
    ok(x.cancelEnd === "skip", "印：飛ばした", x);
    ok(/消去動作 飛ばした/.test(await P.text("#recs .rec .ce")), "一覧に小さく出る");
  });
  await section("[E4] 落ちたあとの復帰 → 短縮版", async (use) => {
    const P = use(await openPage({ cfg: { posture: "chair" } }));
    await P.click("startBtn"); await P.run(5000);
    await P.page.reload(); await P.run(4000);
    let s = await P.st();
    ok(s.resume === "block" && !s.card, "復帰の案内を出す（カードは出さない）", s);
    await P.click("resumeBtn");
    const r = await P.untilCard();
    s = await P.st();
    ok(r.ok && !r.early && cardAfter(s.cards[s.cards.length - 1], [CX.c0, CX.c1, CX.c2, CX.c5, CX.c6]), "復帰の消去動作を読み切ってからカードを出す", s.cards);
    await P.q("#rcSave");
    const x = await lastRec(P);
    ok(x.cancelEnd === "short" && x.cancelWhy === "resume" && JSON.stringify(x.stepIds) === '["intro","calm","heavy"]' && x.posture === "chair",
       "印：短縮（復帰）。段階の id と姿勢も目印から引き継ぐ", x);
  });
  await section("[E5] 復帰で「いまはしない」", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn"); await P.run(5000);
    await P.page.reload(); await P.run(4000);
    await P.click("resumeSkip"); await P.run(100);
    const s = await P.st(), h = await P.hist();
    ok(h.length === 1 && h[0].cancelEnd === "self" && h[0].sec >= 4 && JSON.stringify(h[0].stepIds) === '["intro","calm","heavy"]',
       "練習したことを短く残す（印：自分で行った）", h);
    ok(!s.card && /手足をぎゅっと握ってひらく/.test(s.toast), "カードは出さず、手足を動かす案内を出す", s);
    ok(/消去動作 自分で行った/.test(await P.text("#recs .rec .ce")), "一覧に小さく出る");
  });
  await section("[E6] 復帰を3回やり直しても終わらなかった", async (use) => {
    const P = use(await openPage());
    await P.ev((t) => localStorage.setItem("autogenic:inPractice", JSON.stringify({ at: t - 300000, beat: t - 30000, tries: 3, steps: ["導入", "背景公式", "第1公式 — 重感"], id: "pX", dead: true })), T0.getTime() + 19000);
    await P.page.reload(); await P.run(500);
    const s = await P.st(), h = await P.hist();
    ok(h.length === 1 && h[0].cancelEnd === "self" && JSON.stringify(h[0].stepIds) === '["intro","calm","heavy"]', "短い記録を残す（以前の版の目印でも段階を引ける）", h);
    ok(/手足をぎゅっと握ってひらく/.test(s.toast) && !s.pend, "これまでどおり手足を動かすよう知らせ、目印を片付ける", s);
  });
  await section("[E7] 画面が描けず、読み上げだけの消去動作になった", async (use) => {
    const P = use(await openPage());
    await P.ev(() => document.getElementById("line").remove());
    await P.click("startBtn");
    const r = await P.untilCard();
    await P.q("#rcSave");
    const x = await lastRec(P);
    ok(r.ok && x.cancelEnd === "short" && x.cancelWhy === "error", "印：短縮（うまく進まなかった）", x);
    ok(order(await P.texts(), [CX.c0, CX.c1, CX.c2, CX.c5]), "消去動作は最後まで読む");
  });

  /* ── F. 公式の進め方の目安 ── */
  const days = (n, ids, feelsFrom, extra = {}) => Array.from({ length: n }, (_, i) => {
    const ts = T0.getTime() - (n - i) * DAY + 3600e3;
    const id = ids[ids.length - 1];
    const fv = feelsFrom[Math.min(feelsFrom.length - 1, i)];
    return rec(ts, ids, { feel: { [id]: fv }, level: fv, react: [], ...extra });
  });
  await section("[F1] 重感を14日・最近は毎回感じる → 温感を勧める（押すまで足さない）", async (use) => {
    // 半分は以前の版の形（表示名と level だけ）
    const hist = days(14, ["intro", "calm", "heavy"], [0, 0, 1, 1, 1, 1, 1, 2, 1, 2, 2, 1, 2, 2]).map((r, i) => {
      if (i % 2) return r;
      const { stepIds, feel, react, ...legacy } = r; return legacy;
    });
    const P = use(await openPage({ hist }));
    const g = await P.text("#guide");
    ok(/いまの公式：重感/.test(g) && /練習した日 14／目安14日/.test(g) && /最近の感じ方 すこし・はっきり・はっきり/.test(g), "いまの公式・練習した日・最近の感じ方を出す", g);
    ok(/温感を足してみますか/.test(g) && (await P.has("#guideAdd")), "温感を足すかどうかを、ボタン付きで聞く", g);
    ok(/目安/.test(g), "目安であることを伝える");
    ok(!JSON.parse(await P.cfg()).steps.warm, "勝手には足さない");
    await P.click("guideAdd");
    const c = JSON.parse(await P.cfg());
    ok(c.steps.warm === true && c.steps.heavy === true && !c.steps.heart, "押すと温感だけを足す", c.steps);
    ok(/温感/.test(await P.text("#planNote")) && /いまの公式：温感/.test(await P.text("#guide")), "使う段階と目安が新しくなる", await P.text("#guide"));
  });
  await section("[F2] 13日ではまだ勧めない", async (use) => {
    const P = use(await openPage({ hist: days(13, ["intro", "calm", "heavy"], [2]) }));
    const g = await P.text("#guide");
    ok(/練習した日 13／目安14日/.test(g) && !/足してみますか/.test(g) && !(await P.has("#guideAdd")), "目安に届くまでは勧めない", g);
  });
  await section("[F3] 最近の記録に反応がある → 勧めず、減らす・間を長めに", async (use) => {
    const hist = days(15, ["intro", "calm", "heavy"], [2]);
    hist[hist.length - 1].react = ["twitch", "foggy"]; hist[hist.length - 1].odd = true;
    const P = use(await openPage({ hist }));
    const g = await P.text("#guide");
    ok(!/足してみますか/.test(g) && /段階を減らすか、間を長めに/.test(g) && /消去動作の手足の動き/.test(g), "足すことは勧めず、これまでの言い方で伝える", g);
  });
  await section("[F4] あくびだけなら反応とはみなさない", async (use) => {
    const hist = days(15, ["intro", "calm", "heavy"], [2]);
    hist[hist.length - 1].react = ["yawn"];
    const P = use(await openPage({ hist }));
    ok(/温感を足してみますか/.test(await P.text("#guide")), "あくびは自律性発散の一つとして、勧めを止めない", await P.text("#guide"));
  });
  await section("[F5] 温感のあとは呼吸（心臓は勧めない）、呼吸のあとは額（お腹は勧めない）", async (use) => {
    const P = use(await openPage({ cfg: { steps: { heavy: true, warm: true } }, hist: days(14, ["intro", "calm", "heavy", "warm"], [2]) }));
    let g = await P.text("#guide");
    ok(/いまの公式：温感/.test(g) && /呼吸を足してみますか/.test(g) && !/心臓|お腹|腹部/.test(g), "心臓（第3）を飛ばして呼吸を勧める", g);
    await P.ev(() => { const c = JSON.parse(localStorage.getItem("autogenic:cfg")); c.steps.breath = true; localStorage.setItem("autogenic:cfg", JSON.stringify(c)); });
    await P.ev((h) => localStorage.setItem("autogenic:v1", JSON.stringify(h)), days(14, ["intro", "calm", "heavy", "warm", "breath"], [2]));
    await P.page.reload(); await P.run(500);
    g = await P.text("#guide");
    ok(/いまの公式：呼吸/.test(g) && /額を足してみますか/.test(g) && !/心臓|お腹|腹部/.test(g), "お腹（第5）を飛ばして額を勧める", g);
  });
  await section("[F6] 自分で心臓を有効にしていれば、その先へ進む", async (use) => {
    const P = use(await openPage({ cfg: { steps: { heavy: true, warm: true, heart: true } }, hist: days(14, ["intro", "calm", "heavy", "warm", "heart"], [2]) }));
    const g = await P.text("#guide");
    ok(/いまの公式：心臓/.test(g) && /呼吸を足してみますか/.test(g), "有効にした心臓を「いまの公式」として数える", g);
  });
  await section("[F7] 感じ方がそろわないうちは勧めない", async (use) => {
    const P = use(await openPage({ hist: days(16, ["intro", "calm", "heavy"], [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 0, 1]) }));
    const g = await P.text("#guide");
    ok(!/足してみますか/.test(g) && /目安の日数になりました/.test(g), "日数に届いても、最近「感じなかった」があれば勧めない", g);
  });

  /* ── G. タッチまでの時間 ── */
  await section("[G1] タッチで進むとき、段階ごとに触るまでの秒数を残す", async (use) => {
    const P = use(await openPage({ touch: true, cfg: { advance: "tap", stageMin: 3, steps: { heavy: true, warm: true } } }));
    await P.click("startBtn");
    await P.run(2000); await P.tap();          // 導入 → 背景公式
    await P.run(2000); await P.tap();          // 背景公式 → 重感
    ok((await P.st()).stage.startsWith(N.heavy), "重感に入った", (await P.st()).stage);
    await P.run(30000);
    await P.click("pauseBtn"); await P.run(20000); await P.click("pauseBtn");   // 中断していた20秒は数えない
    await P.run(35000);
    await P.tap();                              // 重感で65秒（中断を除く）たって触る
    ok((await P.st()).stage.startsWith(N.warm), "温感に入った");
    const r = await P.untilCard();              // 温感は触らずに上限で進む
    await P.q("#rcSave");
    const x = await lastRec(P);
    ok(r.ok && !r.early, "消去動作のあとでカードを出す");
    ok(x.tap && x.tap.heavy && Math.abs(x.tap.heavy.s - 65) <= 1 && !x.tap.heavy.cap, "重感：始まりから触るまで 65秒（中断した時間は除く）", x.tap);
    ok(x.tap && x.tap.warm && x.tap.warm.cap === true && x.tap.warm.s > 150 && x.tap.warm.s <= 230, "温感：触らずに上限（3分）で進んだ印", x.tap);
    ok(!x.tap.intro && !x.tap.calm, "準備の段階（導入・背景公式）は残さない", x.tap);
    const row = await P.text("#recs .rec");
    ok(/タッチまで 重感 1:05・温感 \d:\d\d（上限）/.test(row), "一覧に小さく出す", row);
  });
  await section("[G2] 時間で進むときは残さない", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    await P.untilCard();
    await P.q("#rcSave");
    ok(!(await lastRec(P)).tap, "tap の項目が無い");
  });
  await section("[G3] 触るまでの時間の移り変わり（はじめのころと最近の、まんなかの値）", async (use) => {
    const s = [160, 170, 150, 160, 200, 90, 65, 60, 65, 70];
    const hist = s.map((v, i) => rec(T0.getTime() - (40 - i) * DAY, ["intro", "calm", "heavy"], { feel: { heavy: 1 }, level: 1, react: [], tap: { heavy: { s: v } } }));
    hist.push(rec(T0.getTime() - 20 * DAY, ["intro", "calm", "heavy"], { feel: {}, react: [], tap: { heavy: { s: 300, cap: true } } }));   // 上限で進んだ回は数えない
    const P = use(await openPage({ hist }));
    const t = await P.text("#fstats");
    ok(/重感が出るまで 2:40 → 1:05/.test(t), "「重感が出るまで 2:40 → 1:05」", t);
    ok(/目安/.test(t) && !/点数|スコア/.test(t.replace("点数ではなく", "")), "点数ではなく目安として出す", t);
  });

  /* ── H. 1日の回数と小さなグラフ ── */
  await section("[H] 1日の回数・きょう◯回目・4週間のグラフ", async (use) => {
    const t = T0.getTime();
    const hist = [rec(t - 2 * DAY, ["intro", "calm", "heavy"], { feel: { heavy: 1 }, level: 1, react: [] }),
                  rec(t - 3 * 3600e3, ["intro", "calm", "heavy"], { feel: { heavy: 1 }, level: 1, react: [] }),
                  rec(t - 2 * 3600e3, ["intro", "calm", "heavy"], { feel: { heavy: 2 }, level: 2, react: [] }),
                  rec(t - 1 * 3600e3, ["intro", "calm", "heavy"], { feel: { heavy: 3 }, level: 3, react: [] })];
    hist[0].date = jstDay(hist[0].ts);
    const P = use(await openPage({ hist }));
    const d = await P.ev(() => [...document.querySelectorAll("#dots .dot")].map((x) => x.className));
    ok(d.length === 30 && /c3/.test(d[29]) && /c1/.test(d[27]) && !/c\d/.test(d[28]), "30日の点を回数で濃くする（きょう3回=いちばん濃い、おととい1回=薄い）", d.slice(-4));
    ok(/きょう 3回/.test(await P.text("#dleg")) && /3回以上/.test(await P.text("#dleg")), "きょうの回数と濃さの見方を出す", await P.text("#dleg"));
    const svg = await P.ev(() => { const s = document.querySelector("#fstats svg"); return s ? { pts: s.querySelectorAll(".pt").length, titles: [...s.querySelectorAll("title")].map((x) => x.textContent), label: s.getAttribute("aria-label") } : null; });
    ok(svg && svg.pts === 2 && svg.titles.some((x) => /はっきり感じた（3回の平均）/.test(x)), "重感の4週間のグラフ（練習した日に点。触れると中身が出る）", svg);
    ok(/重感の感じ方（4週間）/.test(await P.text("#fstats")), "グラフの名前");
    const all = (await P.text("#home")) || "";
    ok(!/連続|日連続|途切れ/.test(all), "続けた日数で追い立てる言い方をしない");
    await P.click("startBtn");
    await P.untilCard();
    ok(/きょう4回目/.test(await P.text("#recCard .rcm")), "カードに「きょう4回目」", await P.text("#recCard .rcm"));
  });

  /* ── I. みじかく ── */
  await section("[I1] みじかく：短い導入・1分の公式・消去動作は全部", async (use) => {
    const P = use(await openPage({ cfg: { stageMin: 3 } }));
    const cfg0 = await P.cfg();
    ok(/みじかく（約2〜3分）/.test(await P.text("#quickBtn")) && /消去動作は省かずに/.test(await P.text("#quickNote")), "ボタンと説明がある", await P.text("#quickNote"));
    await P.click("quickBtn");
    await P.run(500);
    const pend = JSON.parse((await P.st()).pend || "null");
    ok(pend && pend.quick === true, "練習中の目印に「みじかく」を書く（復帰でも消去動作を全部流すため）", pend);
    const r = await P.untilCard();
    const s = await P.st(), t = await P.texts();
    const sec = (s.cards[0].at - (T0.getTime() + 19000)) / 1000;
    ok(r.ok && !r.early && cardAfter(s.cards[0], FULL), "消去動作を全部（6行）読み切ってからカードを出す", t.slice(-8));
    ok(t[0] === "楽な姿勢をとって、目を、そっと閉じてください" && t[1] === "何度か、ゆっくり息を吐きます" && t[2] === "気持ちが、落ち着いている",
       "導入は短く、背景公式は1回だけ", t.slice(0, 4));
    ok(t.filter((x) => x.includes("重たい")).length === 6, "公式は1分（台本の1回りを読み切る）", t.filter((x) => x.includes("重たい")).length);
    ok(order(t, FULL) && t.filter((x) => x.includes(CX.c3)).length === 1, "消去動作は短縮版ではなく全部", t.slice(-8));
    ok(sec >= 120 && sec <= 200, "全体でおよそ2〜3分", sec);
    ok((await P.cfg()) === cfg0, "保存してある設定は変えない（段階の長さ3分のまま）", await P.cfg());
    await P.q("#rcSave");
    const x = await lastRec(P);
    ok(x.quick === true && x.cancelEnd === "full", "記録に「みじかく」と、消去動作は最後まで", x);
    ok(/みじかく/.test(await P.text("#recs .rec")), "一覧にも出る");
    await P.click("startBtn"); await P.run(2000);
    ok((await P.texts()).slice(t.length)[0] === "楽な姿勢をとってください", "次にふつうに始めると、ふつうの導入に戻っている", (await P.texts()).slice(t.length, t.length + 2));
  });
  await section("[I2] みじかくで「やめる」→ 消去動作は全部", async (use) => {
    const P = use(await openPage());
    await P.click("quickBtn"); await P.run(1500); await P.click("stopBtn");
    const r = await P.untilCard();
    const s = await P.st();
    ok(r.ok && !r.early && cardAfter(s.cards[0], FULL), "やめても、消去動作を全部読み切ってからカードを出す", s.cards[0] && s.cards[0].texts.slice(-8));
    await P.q("#rcSave");
    const x = await lastRec(P);
    ok(x.quick === true && x.cancelEnd === "full" && x.cancelWhy === "stop", "印：最後まで（途中でやめた）", x);
  });
  await section("[I3] みじかくで「最初からやり直す」→ みじかくのまま", async (use) => {
    const P = use(await openPage());
    await P.click("quickBtn"); await P.run(3000);
    const n0 = (await P.texts()).length;
    await P.click("restartBtn"); await P.run(1000); await P.click("restartBtn"); await P.run(300);
    const t1 = (await P.texts()).slice(n0);
    ok(t1[0] === "楽な姿勢をとって、目を、そっと閉じてください", "やり直しても短い導入から", t1.slice(0, 2));
    const r = await P.untilCard();
    const s = await P.st();
    ok(r.ok && !r.early && cardAfter(s.cards[0], FULL), "消去動作を全部読み切ってからカードを出す");
    await P.q("#rcSave");
    ok((await lastRec(P)).quick === true, "記録は「みじかく」");
  });
  await section("[I4] みじかくの途中で落ちる → 復帰でも消去動作は全部", async (use) => {
    const P = use(await openPage());
    await P.click("quickBtn"); await P.run(5000);
    await P.page.reload(); await P.run(4000);
    ok((await P.st()).resume === "block", "復帰の案内を出す");
    await P.click("resumeBtn");
    const r = await P.untilCard();
    const s = await P.st(), c = s.cards[s.cards.length - 1];
    ok(r.ok && !r.early && cardAfter(c, FULL), "復帰でも消去動作を全部（伸び・深呼吸も）読み切ってからカードを出す", c && c.texts.slice(-8));
    await P.q("#rcSave");
    const x = await lastRec(P);
    ok(x.quick === true && x.cancelEnd === "full" && x.cancelWhy === "resume", "印：最後まで（復帰）", x);
  });
  await section("[I5] みじかくで一時停止・再開", async (use) => {
    const P = use(await openPage());
    await P.click("quickBtn"); await P.run(3000);
    await P.click("pauseBtn"); await P.run(8000);
    const n0 = (await P.texts()).length;
    ok((await P.st()).stage === "中断中" && !(await P.st()).card, "中断中（カードは出ない）");
    await P.click("pauseBtn"); await P.run(300);
    ok((await P.texts()).slice(n0)[0] === "楽な姿勢をとって、目を、そっと閉じてください", "中断した行から読み直す", (await P.texts()).slice(n0));
    const r = await P.untilCard();
    ok(r.ok && !r.early && cardAfter((await P.st()).cards[0], FULL), "消去動作を全部読み切ってからカードを出す");
  });
  await section("[I6] みじかく＋タッチで進む：準備の段階は待たず、触らなくても2〜3分で終わる", async (use) => {
    const P = use(await openPage({ cfg: { advance: "tap", stageMin: 3 } }));
    await P.click("quickBtn");
    const stages = new Set();
    let r = null;
    for (let i = 0; i < 400; i++) {
      const s = await P.st();
      stages.add(s.stage);
      if (s.card && s.run !== "block") { r = s; break; }
      await P.run(500);
    }
    ok(r && cardAfter(r.cards[0], FULL), "触らなくても、消去動作を全部読み切って終わる", r && r.cards);
    ok(![...stages].some((x) => /導入 · タッチで次へ|背景公式 · タッチで次へ/.test(x)), "導入・背景公式では待たない", [...stages]);
    ok(r && (r.cards[0].at - (T0.getTime() + 19000)) / 1000 <= 200, "およそ2〜3分", r && (r.cards[0].at - T0.getTime()) / 1000);
  });

  /* ── J. 姿勢 ── */
  await section("[J1] あお向けを選ぶと、導入の1行目がその姿勢の案内になる", async (use) => {
    const P = use(await openPage({ cfg: { posture: "supine" } }));
    await P.click("startBtn");
    await P.until("手足は、組まずに");
    const t = await P.texts();
    ok(t[0] === "あお向けに寝て、楽な姿勢をとってください" && t[1] === "腕は体の横に、少し離して置きます" && t[2] === "手足は、組まずに、軽くひらいておきます",
       "1行目を置き換え、2行目からは既定のまま", t.slice(0, 3));
    ok(!t.some((x) => /椅子に浅く腰かけるか/.test(x)), "椅子とあお向けを両方言う行は読まない");
    await P.untilCard();
    await P.q("#rcSave");
    ok((await lastRec(P)).posture === "supine" && /あお向け/.test(await P.text("#recs .rec")), "記録に姿勢を残し、一覧にも出す");
  });
  await section("[J2] 導入を書き換えているときは、前に1行足す（書き換えた文は残す）", async (use) => {
    const steps = [{ id: "intro", name: "導入", always: true, lines: [{ say: "ふとんの上で、楽にしてください。", hold: 3 }, { say: "目を閉じます。", hold: 3 }] },
                   { id: "calm", name: "背景公式", always: true, lines: [{ say: "気持ちが、落ち着いている。", hold: 3 }] },
                   { id: "heavy", name: "第1公式 — 重感", def: true, hand: true, lines: [{ say: "%A%腕が、重たい。", hold: 3 }] }];
    const P = use(await openPage({ cfg: { posture: "chair" }, script: { steps, cancel: null, updatedAt: 1 } }));
    await P.click("startBtn");
    await P.until("目を閉じます");
    const t = await P.texts();
    ok(t[0] === "椅子に浅く腰かけて、楽な姿勢をとってください" && t.includes("ふとんの上で、楽にしてください") && t.indexOf("ふとんの上で、楽にしてください") === 2 && t[1] === "足を軽くひらき、手は太ももの上に置いて、頭を少し前に傾けます",
       "姿勢の案内を前に足し、書き換えた導入はそのまま読む", t.slice(0, 5));
    const sc = await P.ev(() => JSON.parse(localStorage.getItem("autogenic:script")));
    ok(sc.steps[0].lines.length === 2 && sc.steps[0].lines[0].say === "ふとんの上で、楽にしてください。", "保存してある誘導文は書き換えない", sc.steps[0]);
  });
  await section("[J3] 姿勢の選び方（端末の設定）", async (use) => {
    const P = use(await openPage());
    await P.q('#postSeg [data-po="armchair"]');
    ok(JSON.parse(await P.cfg()).posture === "armchair" && (await P.ev(() => document.querySelector('#postSeg [data-po="armchair"]').classList.contains("on"))), "安楽椅子を選ぶと保存される");
    await P.page.reload(); await P.run(500);
    ok(await P.ev(() => document.querySelector('#postSeg [data-po="armchair"]').classList.contains("on")), "開き直しても残る");
    await P.click("startBtn"); await P.run(400);
    ok((await P.texts())[0] === "背もたれのある椅子に深く腰かけて、楽な姿勢をとってください", "安楽椅子の案内で始まる", (await P.texts())[0]);
    await P.click("stopBtn"); await P.untilCard(); await P.q("#rcSkip");
    await P.q('#postSeg [data-po=""]');
    ok(JSON.parse(await P.cfg()).posture === "", "「指定しない」に戻せる");
  });
} catch (e) {
  ok(false, "検証が途中で止まりました: " + (e && e.stack || e));
}

/* ── K. 2台の同期（偽のGoogleドライブ。時計は本物） ── */
const SYNC_CFG = JSON.stringify(BASE_CFG);
async function syncPage(drive, { hist = null, base = srv.url } = {}) {
  const ctx = await newDevice(browser, { drive, contextOptions: { timezoneId: "Asia/Tokyo" } });
  await ctx.addInitScript(({ hist, cfg }) => {
    if (sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    localStorage.setItem("autogenic:cfg", cfg);
    if (hist) localStorage.setItem("autogenic:v1", JSON.stringify(hist));
    localStorage.setItem("shared:gd:cid", "test-client");
    localStorage.setItem("shared:nksync:auto", "0");   // 自動同期は止め、ボタンで同期する（順番を決めるため）
  }, { hist, cfg: SYNC_CFG });
  const page = await ctx.newPage();
  const errs = collectErrors(page);
  await page.goto(base + "autogenic.html");
  await page.waitForTimeout(300);
  return { ctx, page, errs };
}
async function doSync(page) {
  await page.evaluate(() => { const p = document.getElementById("syncPanel"); if (p.style.display === "none") document.getElementById("bSync").click(); });
  await page.click("#bSyncNow");
  await waitFor(async () => !/同期しています/.test(await page.textContent("#syncMsg")), { label: "同期", timeout: 15000 });
  return page.textContent("#syncMsg");
}
const H_ = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("autogenic:v1") || "[]"));
const sec = (drive) => { const f = drive.byName("nikki-apps-data.json")[0]; return f ? drive.json(f.id).apps.autogenic : null; };
async function clickSel(page, sel) { await page.evaluate((s) => document.querySelector(s).click(), sel); }

console.log("\n[K1] 2台の同期：新しい項目・直した記録・1件ずつの削除");
try {
  const drive = createFakeDrive();
  const now = Date.now();
  const r1 = rec(now - 2 * DAY, ["intro", "calm", "heavy", "warm"], { feel: { heavy: 2, warm: 1 }, level: 2, react: ["twitch", "yawn"], odd: true, note: "メモ一",
                                                                   cancelEnd: "short", cancelWhy: "stop", tap: { heavy: { s: 65 }, warm: { s: 180, cap: true } }, posture: "supine", quick: true });
  const r2 = rec(now - DAY, ["intro", "calm", "heavy"], { feel: { heavy: 1 }, level: 1, react: [], cancelEnd: "full" });
  const A = await syncPage(drive, { hist: [r1, r2] });
  let m = await doSync(A.page);
  const s1 = sec(drive);
  const d1 = s1 && s1.history.find((x) => x.ts === r1.ts);
  ok(/同期しました/.test(m) && d1 && JSON.stringify(d1.feel) === JSON.stringify(r1.feel) && JSON.stringify(d1.tap) === JSON.stringify(r1.tap) && d1.note === "メモ一"
     && d1.cancelEnd === "short" && d1.cancelWhy === "stop" && d1.posture === "supine" && d1.quick === true && JSON.stringify(d1.stepIds) === JSON.stringify(r1.stepIds),
     "新しい項目がそのままドライブに載る", { m, d1 });
  const B = await syncPage(drive);
  m = await doSync(B.page);
  let hb = await H_(B.page);
  const b1 = hb.find((x) => x.ts === r1.ts);
  ok(hb.length === 2 && b1 && JSON.stringify(b1.feel) === JSON.stringify(r1.feel) && JSON.stringify(b1.react) === JSON.stringify(r1.react) && b1.note === "メモ一" && b1.tap.warm.cap === true,
     "もう1台に、新しい項目ごと届く", { m, b1 });
  ok(/重感 はっきり・温感 すこし/.test(await B.page.textContent("#recs")), "もう1台の一覧にも、公式ごとの感じ方が出る");
  // B で r1 を直す
  await clickSel(B.page, `#recs [data-edit="${r1.ts}"]`);
  await clickSel(B.page, '#recCard .lvrow[data-sid="heavy"] [data-lv="3"]');
  await clickSel(B.page, "#rcSave");
  await doSync(B.page);
  await doSync(A.page);
  let ha = await H_(A.page);
  const a1 = ha.find((x) => x.ts === r1.ts);
  ok(a1 && a1.feel.heavy === 3 && a1.feel.warm === 1 && a1.ed > 0 && a1.level === 2, "ほかの端末で直した記録が、直した方で届く（同じ記録が両方にあっても、あとで直した方を残す）", a1);
  // A で r2 を消す
  await clickSel(A.page, `#recs [data-edit="${r2.ts}"]`);
  await clickSel(A.page, "#rcDel"); await sleep(900); await clickSel(A.page, "#rcDel");
  ha = await H_(A.page);
  ok(ha.length === 1 && ha[0].ts === r1.ts, "A で1件消した");
  await doSync(A.page);
  const s2 = sec(drive);
  ok(s2 && s2.history.length === 1 && Array.isArray(s2.clearedKeys) && s2.clearedKeys.includes(String(r2.ts)), "ドライブからも消え、消した記録の鍵が載る", s2 && { h: s2.history.map((x) => x.ts), k: s2.clearedKeys });
  await doSync(B.page);
  hb = await H_(B.page);
  ok(hb.length === 1 && hb[0].ts === r1.ts && hb[0].feel.heavy === 3, "もう1台でも、その1件だけ消える（直した記録は残る）", hb.map((x) => x.ts));
  const kb = await B.page.evaluate(() => JSON.parse(localStorage.getItem("autogenic:clearedAt") || "null"));
  ok(kb && kb.keys.includes(String(r2.ts)), "もう1台にも消した記録の鍵が残る（バックアップにも入る置き場）", kb);
  // 以前の版の端末が、鍵を知らずに消した記録ごと書き戻した
  const f = drive.byName("nikki-apps-data.json")[0];
  const doc = drive.json(f.id);
  doc.apps.autogenic.history.push(r2); delete doc.apps.autogenic.clearedKeys;
  drive.write(f.id, doc);
  await doSync(B.page);
  hb = await H_(B.page);
  const s3 = sec(drive);
  ok(hb.length === 1 && !s3.history.some((x) => x.ts === r2.ts) && s3.clearedKeys.includes(String(r2.ts)), "以前の版の端末が書き戻しても、消した記録は戻らず、鍵もドライブに戻る", { hb: hb.map((x) => x.ts), s3: s3.history.map((x) => x.ts) });
  ok(A.errs.length === 0 && B.errs.length === 0, "ページのエラーが無い", A.errs.concat(B.errs));
  await A.ctx.close(); await B.ctx.close();
} catch (e) { ok(false, "検証が途中で止まりました: " + String((e && e.message) || e).split("\n")[0]); }

console.log("\n[K2] 以前からの全消去（clearedAt）も効く");
try {
  const drive = createFakeDrive();
  const L = Date.now() - 3600e3;
  const rOld = rec(L - 5000, ["intro", "calm", "heavy"], { level: 1 }), rNew = rec(L + 5000, ["intro", "calm", "heavy"], { feel: { heavy: 2 }, level: 2, react: [] });
  drive.put("nikki-apps-data.json", { app: "nikki-sync", v: 1, apps: { autogenic: { history: [rOld], clearedAt: L } } });
  const C = await syncPage(drive, { hist: [rOld, rNew] });
  await doSync(C.page);
  const hc = await H_(C.page), s = sec(drive);
  ok(hc.length === 1 && hc[0].ts === rNew.ts && s.clearedAt === L, "全消去の時刻より前の記録は戻さず、時刻も持ち回る", { hc: hc.map((x) => x.ts), s });
  const clr = await C.page.evaluate(() => JSON.parse(localStorage.getItem("autogenic:clearedAt")));
  ok(clr && clr.at === L, "この端末にも全消去の時刻を残す", clr);
  await C.ctx.close();
  // この端末に以前の形（数字だけ）で残っている全消去の時刻も読む
  const d2 = createFakeDrive();
  d2.put("nikki-apps-data.json", { app: "nikki-sync", v: 1, apps: { autogenic: { history: [] } } });
  const ctx = await newDevice(browser, { drive: d2, contextOptions: { timezoneId: "Asia/Tokyo" } });
  await ctx.addInitScript(({ h, L, cfg }) => {
    if (sessionStorage.getItem("__seeded")) return; sessionStorage.setItem("__seeded", "1");
    localStorage.setItem("autogenic:cfg", cfg); localStorage.setItem("autogenic:v1", JSON.stringify(h));
    localStorage.setItem("autogenic:clearedAt", String(L)); localStorage.setItem("shared:gd:cid", "test-client"); localStorage.setItem("shared:nksync:auto", "0");
  }, { h: [rOld, rNew], L, cfg: SYNC_CFG });
  const pg = await ctx.newPage(); await pg.goto(srv.url + "autogenic.html"); await pg.waitForTimeout(300);
  await doSync(pg);
  const hd = await H_(pg);
  ok(hd.length === 1 && hd[0].ts === rNew.ts, "以前の形（数字だけ）の全消去の時刻も効く", hd.map((x) => x.ts));
  await ctx.close();
} catch (e) { ok(false, "検証が途中で止まりました: " + String((e && e.message) || e).split("\n")[0]); }

/* ── K3. 以前の版の端末（v46 の autogenic.html）を通っても、新しい項目が消えない ── */
console.log("\n[K3] 以前の版の端末と同期しても、新しい項目は残る");
{
  let oldDir = null, oldSrv = null;
  try {
    const html = execFileSync("git", ["-C", ROOT, "show", "9cbffe1:autogenic.html"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "kutsurogi-old-"));
    fs.writeFileSync(path.join(oldDir, "autogenic.html"), html);
    fs.copyFileSync(path.join(ROOT, "sync.js"), path.join(oldDir, "sync.js"));
    oldSrv = await startServer(oldDir);
  } catch (e) { console.log("  （以前の版を git から取り出せないため、この検証は飛ばします）"); }
  if (oldSrv) {
    try {
      const drive = createFakeDrive();
      const now = Date.now();
      const r1 = rec(now - DAY, ["intro", "calm", "heavy", "warm"], { feel: { heavy: 3, warm: 2 }, level: 3, react: ["tears"], odd: true, note: "旧版テスト",
                                                                   cancelEnd: "skip", tap: { heavy: { s: 42 } }, posture: "armchair", ed: now - 1000 });
      const A = await syncPage(drive, { hist: [r1] });
      await doSync(A.page);
      const O = await syncPage(drive, { base: oldSrv.url, hist: [rec(now - 3 * 3600e3, ["intro", "calm", "heavy"], { level: 2 })] });
      await doSync(O.page);
      const s = sec(drive), d = s && s.history.find((x) => x.ts === r1.ts);
      ok(d && JSON.stringify(d.feel) === JSON.stringify(r1.feel) && d.note === "旧版テスト" && d.cancelEnd === "skip" && d.tap.heavy.s === 42 && d.posture === "armchair" && d.ed === r1.ed && d.level === 3,
         "以前の版の端末が書き戻しても、知らない項目は残っている（level も 0〜3 のまま）", d);
      const oh = await H_(O.page);
      ok(oh.length === 2 && /とてもはっきり/.test(await O.page.textContent("#recs")), "以前の版の端末では、level で「とてもはっきり」と出る", oh.length);
      await doSync(A.page);
      const ha = await H_(A.page), a = ha.find((x) => x.ts === r1.ts);
      ok(ha.length === 2 && a && a.feel.warm === 2 && a.note === "旧版テスト", "新しい版の端末に戻っても、そのまま", a);
      ok(A.errs.length === 0, "ページのエラーが無い", A.errs);
      await A.ctx.close(); await O.ctx.close();
    } catch (e) { ok(false, "検証が途中で止まりました: " + String((e && e.message) || e).split("\n")[0]); }
    await oldSrv.close();
    try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (e) {}
  }
}

await browser.close();
await srv.close();
done();
