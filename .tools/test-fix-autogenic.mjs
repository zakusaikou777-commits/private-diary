/* くつろぎ（autogenic.html）の修正の検証（配布には不要）
     node .tools/test-fix-autogenic.mjs              … いまのファイルで
     node .tools/test-fix-autogenic.mjs --root=DIR   … 別の場所のファイルで（直す前の版との比べ用）

   読み上げ（speechSynthesis）・画面の見え方（visibilityState）・画面ロック（wakeLock）は偽物に差し替え、
   時計は page.clock で進める。偽の読み上げは、1文字120ミリ秒で読み終わる。
     __tts.setMuted(true)  … 読み上げが止まる（iPhone で画面が消えたときのように、声も合図も出ない）
     __tts.netSilent       … ネットワークの声が、エラーも出さずに黙ったままになる
     __setVis("hidden")    … 画面が見えなくなる（画面ロックは端末が外す）
     page.clock.fastForward … 端末ごと止まっていた（期限の来たタイマーは、戻ったときに1回だけ動く） */
import fs from "node:fs";
import path from "node:path";
import { startServer, launch, newDevice, makeChecker, collectErrors, ROOT } from "./lib/harness.mjs";

const rootArg = process.argv.find((a) => a.startsWith("--root="));
const root = rootArg ? path.resolve(rootArg.slice(7)) : ROOT;
const T0 = new Date("2026-10-10T20:00:00Z");   // 日本時間 2026-10-11 05:00（世界標準時ではまだ10日）

const BASE_CFG = { gateSeen: true, steps: { heavy: true }, hand: "R", pace: 1, bg: "", bgVol: 18, wake: true,
                   advance: "time", stageMin: 0, vPitch: 1, vRate: 0.9 };

/* ページより先に動かす偽物 */
function INIT(arg) {
  if (!sessionStorage.getItem("__seeded")) {
    for (const k in arg.seed) localStorage.setItem(k, arg.seed[k]);
    sessionStorage.setItem("__seeded", "1");
  }
  // ---- 画面の見え方 ----
  let vis = "visible";
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get() { return vis; } });
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get() { return vis !== "visible"; } });
  // ---- 画面ロック ----
  const W = window.__wl = { requests: 0, slow: false, sentinels: [] };
  function sentinel() {
    const ls = [];
    const s = { released: false, type: "screen",
      addEventListener(t, f) { if (t === "release") ls.push(f); },
      release() { if (!s.released) { s.released = true; ls.forEach((f) => window.setTimeout(() => f({}), 0)); } return Promise.resolve(); } };
    W.sentinels.push(s);
    return s;
  }
  const wakeLock = { request() {
    W.requests++;
    const deny = () => new DOMException("not visible", "NotAllowedError");
    if (!W.slow) return vis === "visible" ? Promise.resolve(sentinel()) : Promise.reject(deny());
    // 返事が遅い端末。返す時点で見えていなければ断る（本物と同じ）
    return new Promise((ok, ng) => window.setTimeout(() => (vis === "visible" ? ok(sentinel()) : ng(deny())), 100));
  } };
  Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, get() { return wakeLock; } });
  W.active = () => W.sentinels.filter((s) => !s.released).length;
  W.drop = () => W.sentinels.filter((s) => !s.released).forEach((s) => s.release());   // 端末の都合で外れる
  window.__setVis = (v) => {
    vis = v;
    if (v !== "visible") W.drop();
    document.dispatchEvent(new Event("visibilitychange"));
  };
  // ---- 読み上げ ----
  const T = window.__tts = { log: [], starts: [], muted: false, netSilent: !!arg.netSilent, cancels: 0 };
  const local = { name: "Test Local ja", lang: "ja-JP", voiceURI: "local-ja", localService: true, default: true };
  const net = { name: "Google 日本語", lang: "ja-JP", voiceURI: "net-ja", localService: false, default: false };
  let queue = [], cur = null;
  function Utt(text) { this.text = String(text); this.voice = null; this.lang = ""; this.rate = 1; this.pitch = 1; this.volume = 1;
                       this.onstart = this.onend = this.onerror = null; }
  window.SpeechSynthesisUtterance = Utt;
  function armEnd(u) {
    u.__t0 = Date.now();
    u.__timer = window.setTimeout(() => {
      if (cur !== u) return;
      cur = null;
      if (u.onend) u.onend({});
      startNext();
    }, u.__left);
  }
  function startNext() {
    if (cur || T.muted || !queue.length) return;
    cur = queue.shift();
    if (T.netSilent && cur.voice && cur.voice.localService === false) { cur.__left = Infinity; return; }   // 黙ったまま
    cur.__left = Math.max(300, cur.text.length * 120);
    T.starts.push({ text: cur.text, voice: cur.voice && cur.voice.voiceURI, at: Date.now() });
    if (cur.onstart) cur.onstart({});
    armEnd(cur);
  }
  T.setMuted = (m) => {
    T.muted = !!m;
    if (m) { if (cur && cur.__timer) { window.clearTimeout(cur.__timer); cur.__timer = 0; cur.__left = Math.max(0, cur.__left - (Date.now() - cur.__t0)); } }
    else { if (cur && !cur.__timer && cur.__left !== Infinity && cur.__t0) armEnd(cur); startNext(); }
  };
  const ss = {
    get speaking() { return !!cur; },
    get pending() { return queue.length > 0; },
    paused: false,
    getVoices() { return arg.withNet ? [net, local] : [local]; },
    speak(u) { T.log.push({ text: u.text, voice: u.voice && u.voice.voiceURI, at: Date.now(), vis }); queue.push(u); window.setTimeout(startNext, 0); },
    cancel() {
      T.cancels++;
      const all = (cur ? [cur] : []).concat(queue);
      if (cur && cur.__timer) window.clearTimeout(cur.__timer);
      cur = null; queue = [];
      all.forEach((u) => window.setTimeout(() => { if (u.onerror) u.onerror({ error: "interrupted" }); }, 0));
    },
    pause() {}, resume() {}, onvoiceschanged: null, addEventListener() {}, removeEventListener() {}
  };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: ss });
  // ---- 記録の問いかけ（finish の目印） ----
  window.__prompts = [];
  window.prompt = function () { window.__prompts.push({ at: Date.now(), vis }); return "1"; };
  window.confirm = function () { return false; };
}

const srv = await startServer(root);
const browser = await launch();
const { ok, done } = makeChecker("くつろぎの修正");
console.log("対象: " + path.join(root, "autogenic.html"));

async function openPage(opts = {}) {
  const seed = { "autogenic:cfg": JSON.stringify({ ...BASE_CFG, ...(opts.cfg || {}) }) };
  if (opts.script) seed["autogenic:script"] = JSON.stringify(opts.script);
  const context = await newDevice(browser, { contextOptions: { timezoneId: "Asia/Tokyo", hasTouch: !!opts.touch, acceptDownloads: true } });
  await context.addInitScript(INIT, { seed, withNet: !!opts.withNet, netSilent: !!opts.netSilent });
  const page = await context.newPage();
  const errs = collectErrors(page);
  await page.clock.install({ time: T0 });
  await page.goto(srv.url + "autogenic.html");
  await page.clock.pauseAt(new Date(T0.getTime() + 15000));
  await page.clock.runFor(4000);   // 声の一覧の見直し（0.3/1.2/3秒）まで済ませる
  const P = {
    page, context, errs,
    run: (ms) => page.clock.runFor(ms),
    click: (id) => page.evaluate((id) => document.getElementById(id).click(), id),
    ev: (fn, a) => page.evaluate(fn, a),
    st: () => page.evaluate(() => {
      const g = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
      return { stage: g("stage"), line: g("line"), toast: document.getElementById("toast").style.display === "block" ? g("toast") : "",
               stopBtn: g("stopBtn"), pauseBtn: g("pauseBtn"), wakeNote: g("wakeNote"),
               home: document.getElementById("home").style.display, run: document.getElementById("run").style.display,
               prompts: window.__prompts.slice(), pend: localStorage.getItem("autogenic:inPractice"), now: Date.now() };
    }),
    log: () => page.evaluate(() => window.__tts.log.slice()),
    texts: async () => (await P.log()).map((x) => x.text),
    count: async (sub) => (await P.texts()).filter((t) => t.includes(sub)).length,
    hide: (mute) => page.evaluate((m) => { if (m) window.__tts.setMuted(true); window.__setVis("hidden"); }, !!mute),
    show: () => page.evaluate(() => { window.__tts.setMuted(false); window.__setVis("visible"); }),
    /** sub を読み上げに渡すまで進める */
    until: async (sub, max = 120000) => {
      for (let t = 0; t < max; t += 100) { if ((await P.count(sub)) > 0) return true; await P.run(100); }
      return false;
    },
    close: () => context.close()
  };
  return P;
}
/** 練習を始めて、すぐ「やめる」で消去動作（短縮版：先頭3行＋最後の1行）に入る */
async function startCancel(P) {
  await P.click("startBtn");
  await P.run(1500);
  await P.click("stopBtn");
  await P.run(300);
}
// 短縮版の消去動作（読み上げに渡る字。両腕→りょううで）
const C0 = "それでは、体を戻していきます", C1 = "両手を、ぎゅっと握って、ひらきます", C2 = "しっかり曲げて、伸ばします", C3 = "ゆっくり、目を開けてください";
/** 1つの検証。途中で例外になっても、ほかの検証は続ける */
async function section(title, fn) {
  console.log("\n" + title);
  let P = null;
  try { await fn((p) => (P = p)); }
  catch (e) { ok(false, "検証が途中で止まりました: " + String((e && e.message) || e).split("\n")[0]); }
  finally { if (P) await P.close().catch(() => {}); }
}
function order(texts, subs) {   // subs がこの順に（間に別の行があってもよい）出てくるか
  let i = 0;
  for (const t of texts) if (i < subs.length && t.includes(subs[i])) i++;
  return i === subs.length;
}

try {
  /* ── 0. ふつうの練習が最後まで、抜けも重なりもなく流れる ── */
  await section("[0] ふつうの練習（時間で進む・重感）", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    await P.run(400000);
    const t = await P.texts(), s = await P.st();
    const want = ["楽な姿勢をとってください", "椅子に浅く腰かけるか、あお向けに寝てもかまいません", "手足は、組まずに、軽くひらいておきます",
      "目を、そっと閉じてください", "何度か、ゆっくり息を吐きます", "息は、整えようとしなくて大丈夫です", "体にまかせます",
      "気持ちが、落ち着いている", "気持ちが、落ち着いている", "気持ちが、落ち着いている",
      "みぎうでが、重たい", "みぎうでが、重たい", "ひだりうでが、重たい", "ひだりうでが、重たい", "りょうあしが、重たい", "りょうあしが、重たい", "気持ちが、落ち着いている",
      "それでは、体を戻していきます", "両手を、ぎゅっと握って、ひらきます", "何度か繰り返してください", "りょううでを、しっかり曲げて、伸ばします", "何度か繰り返してください",
      "大きく、伸びをしてください", "深く息を吸って、ゆっくり吐きます", "ゆっくり、目を開けてください", "おつかれさまでした"];
    ok(JSON.stringify(t) === JSON.stringify(want), "台本の全行が、順に1回ずつ読まれる", t);
    ok(s.prompts.length === 1 && s.home === "block", "最後に記録の問いかけが1回出て、ホームに戻る", s);
    ok(!s.pend, "練習中の目印が片付いている");
    ok(P.errs.length === 0, "ページのエラーが無い", P.errs);
  });

  /* ── 1・5. 書き出し → 読み込み ── */
  await section("[1・5] 誘導文の書き出し・読み込み", async (use) => {
    const P = use(await openPage());
    await P.click("edOpen");
    const [dl] = await Promise.all([P.page.waitForEvent("download"), P.click("edExport")]);
    const name = dl.suggestedFilename();
    const body = fs.readFileSync(await dl.path(), "utf8");
    const o = JSON.parse(body);
    ok(name === "autogenic-script-2026-10-11.json", "ファイル名は端末の暦の日付（日本の朝5時でも11日）", name);
    ok(Array.isArray(o.steps) && o.steps.length === 8 && Array.isArray(o.cancel) && o.cancel.length === 6, "既定のままでも、段階と消去動作の中身が書き出される",
       { steps: o.steps && o.steps.length, cancel: o.cancel && o.cancel.length });
    const imp = async (obj, label) => {
      await P.page.setInputFiles("#edFile", { name: label + ".json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(obj)) });
      await P.run(50); await P.page.waitForTimeout(50); await P.run(50);
      return P.ev(() => ({ toast: document.getElementById("toast").textContent, script: JSON.parse(localStorage.getItem("autogenic:script") || "null") }));
    };
    let r = await imp(o, "exported");
    ok(/^読み込みました/.test(r.toast), "書き出したファイルをそのまま読み込める", r.toast);
    ok(!r.script || (r.script.steps === null && r.script.cancel === null), "既定と同じ中身は null のまま保存（既定を直したら届くように）", r.script);
    const edited = JSON.parse(body);
    edited.steps[2].lines[0].say = "%A%腕が、とても重たい。";
    r = await imp(edited, "edited");
    ok(r.script && Array.isArray(r.script.steps) && r.script.steps[2].lines[0].say === "%A%腕が、とても重たい。" && r.script.cancel === null,
       "編集したファイルは段階だけ保存、消去動作は既定（null）のまま", r.script && { s: r.script.steps && r.script.steps[2].lines[0], c: r.script.cancel });
    r = await imp({ app: "autogenic-script", v: 1, steps: null, cancel: null }, "legacy");
    ok(/^読み込みました/.test(r.toast) && r.script && r.script.steps === null && r.script.cancel === null, "以前の版の書き出し（steps:null, cancel:null）も既定として読み込める", r);
    r = await imp({ app: "autogenic-script", v: 1, steps: "x" }, "bad");
    ok(/読み込めませんでした/.test(r.toast), "形の違うファイルは読み込まない", r.toast);
    ok(P.errs.length === 0, "ページのエラーが無い", P.errs);
  });

  /* ── 2a. 消去動作の最中に見えなくなり、声は止まったまま、タイマーだけ動く（Android など） ── */
  await section("[2a] 消去動作中に画面が消える（声は止まり、タイマーは動く）", async (use) => {
    const P = use(await openPage());
    await startCancel(P);
    let s = await P.st();
    ok(s.stage === "消去動作" && s.line === "それでは、体を戻していきます。", "消去動作の1行目に入った", s);
    await P.hide(true);
    await P.run(120000);
    s = await P.st();
    ok(s.line === "それでは、体を戻していきます。", "見えないあいだ、消去動作は次の行へ進まない", s.line);
    ok(s.prompts.length === 0, "見えないあいだに終わらない（記録の問いかけが出ない）", s.prompts);
    ok(!!s.pend, "見えないあいだ、練習中の目印は残る");
    const n0 = (await P.log()).length;
    await P.show();
    await P.run(200);
    const after = (await P.log()).slice(n0).map((x) => x.text);
    ok(after.length >= 1 && after[0].includes(C0), "見えたら、いまの行をはじめから読み直す", after);
    await P.run(90000);
    s = await P.st();
    const rest = (await P.log()).slice(n0).map((x) => x.text);
    ok(order(rest, [C0, C1, C2, C3]), "そのあと消去動作を最後まで順に読む", rest);
    ok(s.prompts.length === 1 && s.prompts[0].vis === "visible", "見えてから終わる（記録の問いかけ）", s.prompts);
    ok(!s.pend, "終わったら目印が片付く");
    ok(P.errs.length === 0, "ページのエラーが無い", P.errs);
  });

  /* ── 2b. 最後の行で見えなくなる（声は出ている）。短く見えなかっただけなら、戻ったら終える ── */
  await section("[2b] 消去動作の最後の行で、短く見えなくなる", async (use) => {
    const P = use(await openPage());
    await startCancel(P);
    ok(await P.until(C3), "消去動作の最後の行まで進んだ");
    await P.hide(false);
    await P.run(8000);
    let s = await P.st();
    ok(s.prompts.length === 0, "見えないあいだは終えない（記録の問いかけを出さない）", s.prompts);
    ok(!!s.pend, "見えないあいだ、練習中の目印を消さない");
    await P.show();
    await P.run(300);
    s = await P.st();
    ok(s.prompts.length === 1 && s.prompts[0].vis === "visible", "見えたら終える", s.prompts);
    ok((await P.count(C3)) === 1, "短く見えなかっただけなら、最後の行は読み直さない", await P.count(C3));
  });

  /* ── 2c. 最後の行で長く見えなくなる。戻ったら最後の行を読み直してから終える ── */
  await section("[2c] 消去動作の最後の行で、長く見えなくなる", async (use) => {
    const P = use(await openPage());
    await startCancel(P);
    await P.until(C3);
    await P.hide(true);
    await P.run(30000);
    let s = await P.st();
    ok(s.prompts.length === 0, "見えないあいだは終えない", s.prompts);
    await P.show();
    await P.run(300);
    s = await P.st();
    ok((await P.count(C3)) === 2 && s.prompts.length === 0, "見えたら、まず最後の行を読み直す", { n: await P.count(C3), p: s.prompts });
    await P.run(15000);
    s = await P.st();
    ok(s.prompts.length === 1 && s.prompts[0].vis === "visible", "読み直してから終える", s.prompts);
  });

  /* ── 2d. 消去動作の最中に端末ごと止まり（スリープ）、予備のタイマーが大きく遅れて動く ── */
  await section("[2d] 消去動作中に端末が止まり、予備のタイマーが遅れて動く", async (use) => {
    const P = use(await openPage());
    await startCancel(P);
    await P.ev(() => window.__tts.setMuted(true));
    await P.page.clock.fastForward(60000);
    await P.run(300);
    let s = await P.st();
    ok(s.line === "それでは、体を戻していきます。" && (await P.count(C1)) === 0, "遅れて動いたタイマーでは次の行へ進まない", { line: s.line, c1: await P.count(C1) });
    ok((await P.count(C0)) === 2, "いまの行をはじめから読み直す", await P.count(C0));
    await P.ev(() => window.__tts.setMuted(false));
    await P.run(90000);
    s = await P.st();
    ok(order(await P.texts(), [C0, C0, C1, C2, C3]) && s.prompts.length === 1, "そのあと消去動作を最後まで読んで終える", { t: await P.texts(), p: s.prompts });
  });

  /* ── 2e. 練習の段階で見えなくなり、端末ごと止まる（iPhone）。戻ったら読んでいた行から ── */
  await section("[2e] 練習中に画面が消えて止まる（40秒）", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    ok(await P.until("目を、そっと閉じてください"), "導入の3行目まで進んだ");
    await P.run(300);
    await P.hide(true);
    await P.page.clock.fastForward(40000);
    await P.run(50);
    const n0 = (await P.log()).length;
    await P.show();
    await P.run(300);
    let s = await P.st();
    const after = (await P.log()).slice(n0).map((x) => x.text);
    ok(s.line === "目を、そっと閉じてください。" && after.length >= 1 && after[0].includes("目を、そっと閉じてください"),
       "戻ったら、聞けていなかった行をはじめから読み直す（次の行へ飛ばない）", { line: s.line, after });
    ok((await P.count("何度か、ゆっくり息を吐きます")) === 0, "見えないあいだに次の行へ進んでいない");
    ok(s.stage !== "消去動作", "90秒未満なら、練習はそのまま続く", s.stage);
    await P.run(20000);
    ok(order(await P.texts(), ["目を、そっと閉じてください", "目を、そっと閉じてください", "何度か、ゆっくり息を吐きます"]), "読み直したあと、次の行へ進む");
    ok(P.errs.length === 0, "ページのエラーが無い", P.errs);
  });

  /* ── 2f. 練習の段階で長く止まる（150秒）。これまでどおり消去動作へ ── */
  await section("[2f] 練習中に画面が消えて長く止まる（150秒）", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    await P.until("目を、そっと閉じてください");
    await P.hide(true);
    await P.page.clock.fastForward(150000);
    await P.show();
    await P.run(300);
    const s = await P.st();
    ok(s.stage === "消去動作" && /練習が止まっていました/.test(s.toast), "消去動作に移って知らせる", s);
    await P.run(90000);
    ok((await P.st()).prompts.length === 1, "消去動作を通って終わる");
  });

  /* ── 2g. 見えたまま端末が長く止まる（ノートPCのスリープ）。予備のタイマーが遅れて動いたら消去動作へ ── */
  await section("[2g] 練習中に、見えたまま端末が止まる（150秒）", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    await P.until("目を、そっと閉じてください");
    await P.ev(() => window.__tts.setMuted(true));
    await P.page.clock.fastForward(150000);
    await P.ev(() => window.__tts.setMuted(false));
    await P.run(300);
    const s = await P.st();
    ok(s.stage === "消去動作" && (await P.count("何度か、ゆっくり息を吐きます")) === 0, "次の行へは進まず、消去動作に移る", { stage: s.stage, line: s.line });
  });

  /* ── 2h. 一時停止中に見えなくなっても、戻ったときに勝手に動き出さない ── */
  await section("[2h] 一時停止中に画面が消える", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    await P.run(3000);
    await P.click("pauseBtn");
    await P.run(500);
    const n0 = (await P.log()).length;
    await P.hide(true);
    await P.run(60000);
    await P.show();
    await P.run(2000);
    let s = await P.st();
    ok((await P.log()).length === n0 && s.pauseBtn === "再開する" && s.stage === "中断中", "中断のまま（読み上げない）", { n: (await P.log()).length - n0, s });
    await P.click("pauseBtn");
    await P.run(300);
    ok((await P.texts()).slice(n0)[0] === "楽な姿勢をとってください", "「再開する」で中断した行から読み直す", (await P.texts()).slice(n0));
  });

  /* ── 2i. 画面の描画が壊れて「読み上げだけの消去動作」になったときも、見えないあいだは終えない ── */
  await section("[2i] 読み上げだけの消去動作（最後の手段）で画面が消える", async (use) => {
    const P = use(await openPage({ cfg: { hand: "L" }, script: { steps: null, cancel: [
      { say: "それでは、体を戻していきます。", hold: 3 }, { say: "%A%手を、ぎゅっと握って、ひらきます。", hold: 5 },
      { say: "%B%手も、同じようにします。", hold: 5 }, { say: "ゆっくり、目を開けてください。", hold: 2 }] } }));
    await P.ev(() => document.getElementById("line").remove());   // 描くたびに例外になる
    await P.click("startBtn");
    let s;
    for (let t = 0; t < 30000; t += 200) { await P.run(200); s = await P.st(); if (/読み上げでお伝えします/.test(s.toast)) break; }
    ok(/読み上げでお伝えします/.test(s.toast), "読み上げだけの消去動作に切り替わった", s.toast);
    await P.run(300);
    await P.hide(true);
    await P.run(120000);
    s = await P.st();
    ok(s.prompts.length === 0 && !!s.pend, "見えないあいだは終えない・目印も残す", s.prompts);
    const n0 = (await P.log()).length;
    await P.show();
    await P.run(200);
    const after = (await P.log()).slice(n0).map((x) => x.text);
    ok(after.length === 1 && after[0].includes("体を戻して"), "見えたら、読んでいた行から読み直す", after);
    await P.run(60000);
    s = await P.st();
    const t = await P.texts();
    ok(order(t.slice(n0), ["体を戻して", "左手を、ぎゅっと握って", "右手も、同じように", "目を開けて"]) && s.prompts.length === 1 && s.prompts[0].vis === "visible",
       "最後まで読み（%A%・%B% も置き換えて）、見えてから終える", { t: t.slice(n0), p: s.prompts });
  });

  /* ── 3・4. 消去動作の %A%/%B%、読み方 ── */
  await section("[3・4] 消去動作の %A%・%B% と、読み方の指定", async (use) => {
    const P = use(await openPage({ cfg: { hand: "L", steps: { c1: true } }, script: {
      steps: [{ id: "c1", name: "テスト", custom: true, lines: [
        { say: "お腹《おなか》が、温かい。", hold: 1 }, { say: "下腹部が、楽になる。", hold: 1 }, { say: "下腹が、温かい。", hold: 1 },
        { say: "額《ひたい》が、涼しい。", hold: 1 }, { say: "｜お腹《おなか》が、温かい。", hold: 1 }] }],
      cancel: [{ say: "%A%手を、ぎゅっと握って、ひらきます。", hold: 1 }, { say: "%B%手も、同じように、握って、ひらきます。", hold: 1 },
               { say: "ゆっくり、目を開けてください。", hold: 1 }] } }));
    await P.click("startBtn");
    await P.run(200);
    ok((await P.st()).line === "お腹が、温かい。", "画面には読みの指定を外した字が出る", (await P.st()).line);
    await P.run(120000);
    let t = await P.texts();
    ok(JSON.stringify(t.slice(0, 5)) === JSON.stringify(["おなかが、温かい", "下腹部が、楽になる", "したはらが、温かい", "ひたいが、涼しい", "おなかが、温かい"]),
       "「お腹《おなか》」→おなか、「下腹部」はそのまま、「額《ひたい》」「｜お腹《おなか》」も従来どおり", t.slice(0, 5));
    ok(t.includes("左手を、ぎゅっと握って、ひらきます") && t.includes("右手も、同じように、握って、ひらきます") && !t.some((x) => x.includes("%")),
       "消去動作の %A%・%B% が利き手で置き換わる（ふつうの終わり方）", t.slice(5));
    ok((await P.st()).prompts.length === 1, "練習を終えた");
    // 「やめる」からの短縮版でも
    const n0 = t.length;
    await startCancel(P);
    const s = await P.st();
    await P.run(200);
    t = await P.texts();
    ok(t.slice(n0).includes("左手を、ぎゅっと握って、ひらきます") || (await P.until("左手を、ぎゅっと握って")), "「やめる」からの消去動作でも置き換わる", t.slice(n0));
    ok(!(await P.texts()).some((x) => x.includes("%")), "%A% のまま読む行が無い");
  });

  /* ── 6. タッチで次の段階へ（pointerup） ── */
  await section("[6] タッチで次の段階へ", async (use) => {
    const P = use(await openPage({ touch: true, cfg: { advance: "tap", steps: { heavy: true, warm: true } } }));
    await P.click("startBtn");
    await P.run(500);
    ok((await P.st()).stage === "導入", "導入から始まる");
    // iPhone の Safari のように、click の来ない pointerup だけ
    await P.ev(() => document.getElementById("glyph").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "touch" })));
    let s = await P.st();
    ok(s.stage === "背景公式", "click の来ないタッチ（pointerup）でも次の段階へ進む", s.stage);
    // 同じタッチの click が、並びの変わったあとの「やめる」に当たっても押されない
    await P.ev(() => document.getElementById("stopBtn").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
    s = await P.st();
    ok(s.stage === "背景公式" && s.stopBtn === "やめる（消去動作をして終わります）", "pointerup で進めた直後の click は捨てる（2段進まず、ボタンも押されない）", s);
    await P.run(1500);
    await P.ev(() => document.getElementById("glyph").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
    s = await P.st();
    ok(s.stage === "第1公式 — 重感", "click だけ（パソコン）でも、これまでどおり進む", s.stage);
    await P.run(1500);
    const box = await P.ev(() => { const r = document.getElementById("glyph").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await P.page.touchscreen.tap(box.x, box.y);
    await P.run(100);
    s = await P.st();
    ok(s.stage === "第2公式 — 温感", "本物のタッチ1回で、ちょうど1段進む", s.stage);
    await P.run(1500);
    await P.page.mouse.click(box.x, box.y);
    await P.run(100);
    s = await P.st();
    ok(s.stage === "消去動作", "マウスのクリック1回で、ちょうど1段進む", s.stage);
    await P.run(1500);
    await P.ev(() => document.getElementById("glyph").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "touch" })));
    await P.run(100);
    ok((await P.count("ぎゅっと握って")) === 0 || (await P.st()).stage === "消去動作", "消去動作の最中は、タッチで飛ばせない");
  });

  /* ── 7. ネットワークの声が、エラーも出さずに黙る ── */
  await section("[7] ネットワークの声が黙ったまま", async (use) => {
    const P = use(await openPage({ withNet: true, netSilent: true }));
    await P.click("startBtn");
    await P.run(3000);
    let l = await P.log();
    ok(l.length >= 1 && l.every((x) => x.voice === "net-ja"), "はじめはネットワークの声で頼む", l);
    await P.run(1500);
    l = await P.log();
    const loc = l.filter((x) => x.voice === "local-ja").map((x) => x.text);
    ok(loc[0] === "楽な姿勢をとってください", "4秒たっても読み始めなければ、端末の中の声で同じ文を頭から読み直す", l);
    await P.run(60000);
    const t = (await P.log()).filter((x) => x.voice === "local-ja").map((x) => x.text);
    const want = ["楽な姿勢をとってください", "椅子に浅く腰かけるか、あお向けに寝てもかまいません", "手足は、組まずに、軽くひらいておきます", "目を、そっと閉じてください"];
    ok(JSON.stringify(t.slice(0, 4)) === JSON.stringify(want), "そのあとは端末の中の声で、行を飛ばさず二重にもならず進む", t.slice(0, 6));
    ok(!(await P.log()).slice(2).some((x) => x.voice === "net-ja"), "以後は黙る声を使わない");
    ok(P.errs.length === 0, "ページのエラーが無い", P.errs);
  });

  /* ── 8. 画面ロック ── */
  await section("[8] 画面ロックの取り直し", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    await P.run(100);
    let w = await P.ev(() => ({ n: window.__wl.requests, a: window.__wl.active() }));
    ok(w.n === 1 && w.a === 1, "始めると画面ロックを取る", w);
    await P.ev(() => window.__wl.drop());   // 見えたまま端末の都合で外れる
    await P.run(1500);
    w = await P.ev(() => ({ n: window.__wl.requests, a: window.__wl.active() }));
    ok(w.n === 2 && w.a === 1, "見えたまま外されたら、取り直す", w);
    ok((await P.st()).wakeNote === "画面を消さないようにしています", "表示も「消さないようにしています」に戻る", (await P.st()).wakeNote);
    await P.hide(false);
    await P.run(3000);
    w = await P.ev(() => ({ n: window.__wl.requests, a: window.__wl.active() }));
    ok(w.n === 2 && w.a === 0, "見えないあいだに外れたぶんは、その場では頼まない", w);
    await P.show();
    await P.run(100);
    w = await P.ev(() => ({ n: window.__wl.requests, a: window.__wl.active() }));
    ok(w.n === 3 && w.a === 1, "見えたら取り直す", w);
  });
  await section("[8b] 画面ロックの返事が来る前に見えなくなる", async (use) => {
    const P = use(await openPage());
    await P.ev(() => { window.__wl.slow = true; });
    await P.click("startBtn");
    await P.hide(false);              // 返事が来る前に見えなくなる → 断られる
    await P.run(500);
    let s = await P.st();
    ok(!/できませんでした/.test(s.toast) && !/⚠/.test(s.wakeNote), "見えないために断られただけなら「この端末ではできない」と知らせない", s);
    await P.show();
    await P.run(500);
    s = await P.st();
    const w = await P.ev(() => ({ n: window.__wl.requests, a: window.__wl.active() }));
    ok(w.a === 1 && s.wakeNote === "画面を消さないようにしています", "見えたら取り直せる", { w, note: s.wakeNote });
  });

  /* ── 9. 合図の番号 ── */
  await section("[9] 合図の番号", async (use) => {
    const src = fs.readFileSync(path.join(root, "autogenic.html"), "utf8");
    ok(!/tok:0\b/.test(src) && !/R\.tok\+\+|\+\+R\.tok/.test(src), "練習ごとに 0 から数え直さない（全体で増やしつづける番号を使う）");
  });

  /* ── 10. 復帰の上限に達した目印 ── */
  await section("[10] 復帰の消去動作を3回やり直しても終わらなかったとき", async (use) => {
    const P = use(await openPage());
    await P.ev(() => { localStorage.setItem("autogenic:inPractice", JSON.stringify({ at: Date.now() - 300000, beat: Date.now() - 30000, tries: 3, steps: ["導入"], id: "pX", dead: true })); });
    await P.page.reload();
    await P.run(500);
    const s = await P.st();
    ok(/手足をぎゅっと握ってひらく/.test(s.toast), "黙って捨てず、自分で手足を動かすよう知らせる", s.toast);
    ok(!s.pend, "目印は片付ける（繰り返しにならないように）");
  });

  /* ── 11. 試聴 ── */
  await section("[11] 試聴の終わり", async (use) => {
    const P = use(await openPage());
    await P.click("tryBtn");
    await P.run(60000);
    const t = await P.texts(), s = await P.st();
    ok(t.length >= 2 && t[t.length - 2] === "みぎうでが、重たい" && t[t.length - 1] === "両手を、ぎゅっと握って、ひらきます", "重さの暗示のあと、消去動作の1行で締める", t);
    ok(s.home === "block" && s.prompts.length === 0, "試聴は記録を残さずに終わる", s);
  });
} catch (e) {
  ok(false, "検証が途中で止まりました: " + (e && e.stack || e));
} finally {
  await browser.close();
  await srv.close();
}
done();
