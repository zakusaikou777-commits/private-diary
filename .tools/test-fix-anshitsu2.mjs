/* 暗室（image-streaming.html）の改善の検証（配布には不要。要 playwright）
     node .tools/test-fix-anshitsu2.mjs              … いまのファイルで
     node .tools/test-fix-anshitsu2.mjs --root=DIR   … 別の場所のファイルで（直す前の版との比べ用）

   読み上げ（speechSynthesis）・マイク（getUserMedia / MediaRecorder / AnalyserNode）・再生（play）は
   偽物に差し替え、時計は page.clock で進める。偽の読み上げは1文字120ミリ秒で読み終わる。
     __mic.mode = "deny"  … マイクの許可が断られる
     __mic.level          … マイクの音の大きさ（RMS）。__mic.levelFn があればそちらを使う
   確かめること
   1. 終わったらその場で記録する（30秒未満は記録しない）。終了画面で直せる。消すときは確かめる。
      練習中の控えを残し、落ちた・閉じたあと開き直すと「前回の練習（7分）を記録しますか」と聞く
   2. 一時停止・再開を声で伝える。残り時間（あと1分・半分）を伝える。暗い画面の長押しで一時停止・再開。
      案内の声にかぶせない（後ろに並べる）
   3. 感覚の切り替えのあいだに、像を深める問いを入れる。「問いかけの間隔」なし／50秒／90秒（この端末だけ）
   4. 終わりの声で「いちばん印象に残ったもの」を聞く。「印象に残った像」「気づき・意味」の欄。
      一覧で1件ずつ直す・消す（消したものは同期で戻らない）・検索。新しい項目も cleanRec と同期を通る
   5. Ten/Ten：その日の合計が10分に届いた日だけ1コマ。届かない日は半分だけ。「今日 7/10分」
   6. 録音（この端末だけ）：はじめるを押した流れでマイクを求め、IndexedDB に記録の鍵で置く。
      一時停止・終了でマイクを切る。再生・削除・全部消す。断られたら録音せずに続ける
   7. 黙っているとき（マイクを使うときだけ）：12秒黙ると短く呼びかける（30秒に1回まで）。
      話しているあいだは問いかけを待ち、話しつづけたら見送る。案内の声は本人の声と数えない */
import fs from "node:fs";
import path from "node:path";
import { startServer, launch, newDevice, makeChecker, collectErrors, ROOT } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const rootArg = process.argv.find((a) => a.startsWith("--root="));
const root = rootArg ? path.resolve(rootArg.slice(7)) : ROOT;
const T0 = new Date("2026-11-07T01:00:00Z");   // 日本時間 2026-11-07 10:00
const { ok, done } = makeChecker("暗室の改善");
console.log("対象: " + path.join(root, "image-streaming.html"));

const QUESTIONS = ["もっと近づくと", "その向こうには", "そこにいて", "いちばん細かいところは", "少し離れて", "それにさわってみると",
  "光は", "次の瞬間", "その奥に", "いま、いちばん目を引くもの"];
const NUDGES = ["いま、何が見えていますか", "小さなことでも", "どんな色や", "浮かんでいるものを", "何も浮かばなければ"];
const isQ = (t) => QUESTIONS.some((q) => t.startsWith(q));
const isNudge = (t) => NUDGES.some((q) => t.startsWith(q));

/* ページより先に動かす偽物 */
function INIT(arg) {
  if (!localStorage.getItem("__seeded")) {
    for (const k in arg.seed) localStorage.setItem(k, arg.seed[k]);
    localStorage.setItem("__seeded", "1");
  }
  // ---- 読み上げ ----
  const T = window.__tts = { log: [], starts: [], ends: [], cancels: 0, msPerChar: arg.msPerChar || 120 };
  const local = { name: "Test Local ja", lang: "ja-JP", voiceURI: "local-ja", localService: true, default: true };
  let queue = [], cur = null;
  function Utt(text) { this.text = String(text); this.voice = null; this.lang = ""; this.rate = 1; this.pitch = 1; this.volume = 1;
                       this.onstart = this.onend = this.onerror = null; }
  window.SpeechSynthesisUtterance = Utt;
  function startNext() {
    if (cur || !queue.length) return;
    cur = queue.shift();
    const u = cur;
    T.starts.push({ text: u.text, at: Date.now() });
    if (u.onstart) u.onstart({});
    u.__timer = window.setTimeout(() => {
      if (cur !== u) return;
      cur = null;
      T.ends.push({ text: u.text, at: Date.now() });
      if (u.onend) u.onend({});
      startNext();
    }, Math.max(300, u.text.length * T.msPerChar));
  }
  const ss = {
    get speaking() { return !!cur; },
    get pending() { return queue.length > 0; },
    paused: false,
    getVoices() { return [local]; },
    speak(u) { T.log.push({ text: u.text, at: Date.now(), busy: !!cur }); queue.push(u); window.setTimeout(startNext, 0); },
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
  // ---- マイク ----
  const M = window.__mic = { mode: arg.mic || "allow", level: 0, levelFn: null, requests: 0, inClick: [], streams: 0, stopped: 0,
                             recorders: [], sources: 0, disconnects: 0, played: [] };
  if (arg.noRec) { try { delete window.MediaRecorder; } catch (e) {} window.MediaRecorder = undefined; }
  else {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = function () {
        M.requests++; M.inClick.push(!!window.__inClick);
        if (M.mode === "deny") return Promise.reject(new DOMException("denied", "NotAllowedError"));
        const tr = { kind: "audio", readyState: "live", stop() { if (this.readyState !== "ended") { this.readyState = "ended"; M.stopped++; } } };
        M.streams++;
        return Promise.resolve({ __fake: true, getTracks() { return [tr]; }, getAudioTracks() { return [tr]; } });
      };
    }
    class FakeMR {
      constructor(stream, opt) { this.stream = stream; this.mimeType = (opt && opt.mimeType) || "audio/webm"; this.state = "inactive"; this.ondataavailable = null; this.onstop = null; M.recorders.push(this); }
      static isTypeSupported(t) { return /webm/.test(t); }
      start() { this.state = "recording"; this.t0 = Date.now(); }
      pause() { this.state = "paused"; }
      resume() { this.state = "recording"; }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        const bytes = Math.max(16, Math.round((Date.now() - this.t0) / 1000 * 4000));   // 32kbps ぶん
        window.setTimeout(() => {
          if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
          if (this.onstop) this.onstop({});
        }, 0);
      }
    }
    window.MediaRecorder = FakeMR;
    const AC = window.AudioContext;
    if (AC) {
      AC.prototype.createMediaStreamSource = function () { M.sources++; return { connect() {}, disconnect() { M.disconnects++; } }; };
      AC.prototype.createAnalyser = function () {
        return { fftSize: 1024, connect() {}, disconnect() {},
          getFloatTimeDomainData(buf) { const L = M.levelFn ? M.levelFn() : M.level; for (let i = 0; i < buf.length; i++) buf[i] = (i % 2 ? L : -L); } };
      };
    }
  }
  // ---- 再生（中身は鳴らさず、何を鳴らそうとしたかだけ残す） ----
  HTMLMediaElement.prototype.play = function () { M.played.push(this.src); return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function () {};
}

const srv = await startServer(root);
const browser = await launch();

const VOICE = (o = {}) => JSON.stringify({ cues2: 1, speakCues: true, dim: true, free: false, ...o });
const H = (o) => JSON.stringify(o);
function localDay(ms) { const d = new Date(ms + 9 * 3600e3); return d.toISOString().slice(0, 10); }   // 日本時間の日付
const TODAY = localDay(T0.getTime());
const dayOff = (n) => localDay(T0.getTime() + n * 864e5);

async function openPage(opts = {}) {
  const seed = { "image-streaming:voice": VOICE(opts.voice), ...(opts.seed || {}) };
  if (opts.drive) seed["shared:gd:cid"] = "test-client";
  const context = opts.context || await newDevice(browser, { drive: opts.drive || null, contextOptions: { timezoneId: "Asia/Tokyo" } });
  if (!opts.context) await context.addInitScript(INIT, { seed, mic: opts.mic, noRec: !!opts.noRec, msPerChar: opts.msPerChar });
  const page = await context.newPage();
  const errs = collectErrors(page);
  if (opts.context) {
    // 同じ端末の2枚目のタブ。時計は端末（コンテキスト）で1つなので、入れ直さない
    await page.goto(srv.url + "image-streaming.html");
    await page.clock.runFor(4000);
  } else {
    await page.clock.install({ time: opts.time || T0 });
    await page.goto(srv.url + "image-streaming.html");
    await page.clock.pauseAt(new Date((opts.time || T0).getTime() + 10000));
    await page.clock.runFor(4000);   // 声の一覧の見直し（0.3/1.2/3秒）まで済ませる
  }
  const P = {
    page, context, errs,
    run: (ms) => page.clock.runFor(ms),
    // 押した操作の中かどうかを偽のマイクに伝えて押す（許可の画面が操作への返事として出るか）
    click: (id) => page.evaluate((id) => { const el = document.getElementById(id); if (!el) return false; window.__inClick = true; try { el.click(); } finally { window.__inClick = false; } return true; }, id),
    ev: (fn, a) => page.evaluate(fn, a),
    text: (id) => page.evaluate((id) => { const e = document.getElementById(id); return e ? e.textContent : null; }, id),
    hidden: (id) => page.evaluate((id) => { const e = document.getElementById(id); return e ? !!e.hidden : null; }, id),
    hist: () => page.evaluate(() => JSON.parse(localStorage.getItem("image-streaming:v1") || "[]")),
    cleared: () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem("image-streaming:clearedAt") || "null"); } catch (e) { return null; } }),
    log: () => page.evaluate(() => window.__tts.log.slice()),
    texts: async () => (await P.log()).map((x) => x.text),
    mic: () => page.evaluate(() => { const M = window.__mic; return { requests: M.requests, inClick: M.inClick.slice(), streams: M.streams, stopped: M.stopped,
      recs: M.recorders.map((r) => r.state), sources: M.sources, disconnects: M.disconnects, played: M.played.slice() }; }),
    phase: () => page.evaluate(() => {
      const h = (id) => { const e = document.getElementById(id); return e ? e.hidden : null; };
      return !h("ctlDone") ? "done" : !h("pausedLbl") && !h("ctlRun") ? "paused" : !h("ctlRun") ? "running" : "idle";
    }),
    dark: () => page.evaluate(() => !document.getElementById("darkroom").hidden),
    // 実時間も少し待つ（IndexedDB・Blob の読み書きは本物なので）
    settle: async (n = 6) => { for (let i = 0; i < n; i++) { await page.clock.runFor(50); await page.waitForTimeout(40); } },
    close: () => (opts.context ? page.close() : context.close())
  };
  return P;
}
/* 録音の置き場（IndexedDB）を外から見る。まだ無ければ作らない */
async function idb(page) {
  return page.evaluate(async () => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    if (!dbs.some((d) => d.name === "image-streaming-audio")) return { meta: [], clips: [] };
    return new Promise((res) => {
      const rq = indexedDB.open("image-streaming-audio");
      rq.onsuccess = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains("meta")) { db.close(); res({ meta: [], clips: [] }); return; }
        const tx = db.transaction(["meta", "clips"], "readonly");
        const a = tx.objectStore("meta").getAll(), b = tx.objectStore("clips").getAll();
        tx.oncomplete = () => { db.close(); res({ meta: a.result, clips: b.result.map((c) => ({ key: c.key, n: c.parts.length, bytes: c.parts.reduce((s, p) => s + p.byteLength, 0) })) }); };
      };
      rq.onerror = () => res(null);
    });
  });
}
function okErrors(errs, label) {
  const e = errs.filter((x) => !/Failed to load resource/.test(x));
  ok(e.length === 0, label + ": ページのエラーが無い", e);
}
async function section(name, fn) {
  console.log("\n" + name);
  try { await fn(); } catch (e) { ok(false, name + ": 途中で止まらない", String(e && e.stack || e).split("\n").slice(0, 3).join(" / ")); }
}

// ── 1. 終わったら自動で記録する・消すときは確かめる ──
await section("1. 自動で記録・終了画面で直す・確かめて消す", async () => {
  const P = await openPage({ voice: { cueSec: 50 } });
  await P.click("beginBtn");
  await P.run(65000);
  await P.click("endBtn");
  let h = await P.hist();
  ok(h.length === 1 && h[0].sec >= 64 && h[0].sec <= 66, "「終了」を押した時点で記録される（記録するを押さなくても）", h);
  ok(/記録しました/.test(await P.text("doneStatus") || ""), "終了画面に「記録しました」と出る", await P.text("doneStatus"));
  ok(await P.text("saveBtn") === "閉じる" && /消す/.test(await P.text("discardBtn") || ""), "ボタンは「閉じる」と「この記録を消す」", [await P.text("saveBtn"), await P.text("discardBtn")]);
  // 終了画面で直す
  await P.page.fill("#imgEl", "濡れた石の光");
  await P.page.fill("#meanEl", "静けさが要る");
  await P.page.fill("#noteEl", "途中で音が遠のいた");
  await P.ev(() => document.querySelector('#ratingRow .vbtn[data-v="4"]').click());
  await P.run(800);
  h = await P.hist();
  ok(h[0] && h[0].image === "濡れた石の光" && h[0].meaning === "静けさが要る" && h[0].note === "途中で音が遠のいた" && h[0].vivid === 4 && typeof h[0].upd === "number",
    "終了画面の鮮明さ・印象に残った像・気づき・メモは、記録にそのまま入る（直した時刻も）", h[0]);
  // 消す（確かめてから）
  await P.click("discardBtn");
  ok((await P.hist()).length === 1 && (await P.hidden("discardAsk")) === false, "「この記録を消す」は、まず確かめる（まだ消えない）");
  await P.click("discardNo");
  ok((await P.hist()).length === 1 && await P.phase() === "done", "「やめる」で消さずに戻る");
  await P.click("discardBtn"); await P.click("discardYes");
  const cl = await P.cleared();
  ok((await P.hist()).length === 0 && await P.phase() === "idle" && cl && Array.isArray(cl.keys) && cl.keys.includes(String(h[0].ts)),
    "「消す」で記録が消え、消した鍵が残る（同期で戻らない）", cl);
  // 30秒未満は自動では記録しない
  await P.click("beginBtn"); await P.run(10000); await P.click("endBtn");
  ok((await P.hist()).length === 0 && /30秒/.test(await P.text("doneStatus") || ""), "30秒に満たない練習は自動では記録しない", await P.text("doneStatus"));
  ok(await P.text("saveBtn") === "記録する", "そのときは「記録する」で残せる", await P.text("saveBtn"));
  await P.page.fill("#imgEl", "白い光");
  await P.click("saveBtn");
  h = await P.hist();
  ok(h.length === 1 && h[0].sec >= 9 && h[0].sec <= 11 && h[0].image === "白い光" && await P.phase() === "idle", "「記録する」で短い練習も記録される（欄の中身も）", h);
  // 最後まで練習したとき
  await P.ev(() => document.querySelector('#lengthSeg .seg[data-d="3"]').click());
  await P.click("beginBtn"); await P.run(181000);
  h = await P.hist();
  ok(h.length === 2 && h[1].sec === 180 && await P.phase() === "done", "時間いっぱい練習すると、その場で記録される", h.map((x) => x.sec));
  ok(await P.ev(() => !localStorage.getItem("image-streaming:running")), "終わったら練習中の控えは消える");
  await P.click("saveBtn");
  okErrors(P.errs, "1");
  await P.close();
});

await section("1. 落ちた・閉じたあとの「前回の練習を記録しますか」", async () => {
  const P = await openPage({});
  await P.click("beginBtn");
  await P.run(7 * 60000 + 2000);
  const snap = await P.ev(() => JSON.parse(localStorage.getItem("image-streaming:running") || "null"));
  ok(snap && snap.sec >= 415 && snap.sec <= 425 && typeof snap.scene === "string" && snap.scene && snap.paused === false,
    "練習中は控え（始めた時刻・お題・練習した秒数・一時停止中か）を書いておく", snap);
  await P.page.reload();
  await P.run(1000);
  ok((await P.hidden("recoverBox")) === false && await P.text("recoverQ") === "前回の練習（7分）を記録しますか",
    "読み込み直すと「前回の練習（7分）を記録しますか」と聞く", await P.text("recoverQ"));
  ok((await P.hist()).length === 0, "聞くまでは記録しない");
  await P.click("recoverYes");
  const h = await P.hist();
  ok(h.length === 1 && h[0].sec >= 415 && h[0].sec <= 425 && h[0].scene === snap.scene && h[0].date === TODAY, "「記録する」で、その練習が記録される", h);
  ok(await P.ev(() => !localStorage.getItem("image-streaming:running")) && (await P.hidden("recoverBox")) === true, "答えたら控えは消え、もう聞かない");
  okErrors(P.errs, "1 控え");
  await P.close();

  // 一時停止したまま閉じた・古い控え・短い控え・「記録しない」
  const mk = (o) => H({ id: 111, at: T0.getTime() - 3600e3, beat: T0.getTime() - 3000e3, sec: 300, paused: true, scene: "引き潮の港", dur: 10, ...o });
  const A = await openPage({ seed: { "image-streaming:running": mk({}) } });
  ok((await A.hidden("recoverBox")) === false && /5分/.test(await A.text("recoverQ") || ""), "別のときに落ちた練習（一時停止中だったもの）も聞く", await A.text("recoverQ"));
  await A.click("recoverNo");
  ok((await A.hist()).length === 0 && await A.ev(() => !localStorage.getItem("image-streaming:running")), "「記録しない」で記録せず、控えも消す");
  await A.close();
  const B = await openPage({ seed: { "image-streaming:running": mk({ beat: T0.getTime() - 13 * 3600e3 }) } });
  ok((await B.hidden("recoverBox")) === true && await B.ev(() => !localStorage.getItem("image-streaming:running")), "12時間より古い控えは聞かずに捨てる");
  await B.close();
  const C = await openPage({ seed: { "image-streaming:running": mk({ sec: 20 }) } });
  ok((await C.hidden("recoverBox")) === true, "30秒に満たない控えは聞かない");
  await C.close();
  // 同じ端末の別のタブでいま練習中（鼓動が新しい）なら、横から聞かない。止まったら聞く
  const D = await openPage({});
  await D.click("beginBtn"); await D.run(60000);
  await D.click("playPauseBtn");   // 一時停止したまま置いてある
  await D.run(30000);
  const D2 = await openPage({ context: D.context });
  // 偽の時計はタブごとに進むので、1秒ずつ進めて2枚のタブの時刻をそろえる（本物のタブは同時に進む）
  for (let i = 0; i < 25; i++) await D2.run(1000);
  ok((await D2.hidden("recoverBox")) === true, "別のタブでいま練習中（一時停止中も）の控えは、横から聞かない");
  await D.page.close();            // 1枚目を閉じた（離れた印が付く）
  for (let i = 0; i < 21; i++) await D2.run(1000);
  ok((await D2.hidden("recoverBox")) === false, "そのタブが閉じたら、聞く", await D2.text("recoverQ"));
  okErrors(D2.errs, "1 別のタブ");
  await D.context.close();
});

// ── 2. 目を閉じたままの操作 ──
await section("2. 一時停止・再開を声で・残り時間・長押し", async () => {
  const P = await openPage({ voice: { cueSec: 0 } });
  await P.click("beginBtn");
  await P.run(15000);
  ok(await P.dark(), "練習中は暗くなる（前提）");
  // 短く触る → 操作が見える（これまでどおり）
  const tap = () => P.ev(() => {
    document.getElementById("darkroom").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50 }));
  });
  const up = () => P.ev(() => { const d = document.getElementById("darkroom"); d.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 50, clientY: 50 })); d.click(); });
  await tap(); await P.run(150); await up();
  ok(!(await P.dark()) && await P.phase() === "running", "短く触ると、これまでどおり操作が見える（止まらない）");
  await P.run(7000);
  ok(await P.dark(), "しばらくするとまた暗くなる");
  // 長押し → 一時停止（暗いまま・声で伝える）
  let n0 = (await P.log()).length;
  await tap(); await P.run(900); await up();
  let t = (await P.texts()).slice(n0);
  ok(await P.phase() === "paused", "暗い画面を長押し（0.8秒）すると一時停止する");
  ok(t.some((x) => x.includes("一時停止しました")), "「一時停止しました」と声で伝える", t);
  ok(await P.dark(), "長押しで止めたときは暗いまま（目を閉じたまま、また長押しで再開できるように）");
  ok(/長押しで再開/.test(await P.text("drHint") || ""), "暗い画面の案内も「長押しで再開」になる", await P.text("drHint"));
  await P.run(10000);
  ok(await P.phase() === "paused" && await P.dark(), "止めているあいだも暗いまま");
  n0 = (await P.log()).length;
  await tap(); await P.run(900); await up();
  t = (await P.texts()).slice(n0);
  ok(await P.phase() === "running" && t.some((x) => x.includes("再開します")) && await P.dark(), "もう一度長押しすると再開し、「再開します」と伝える", t);
  // ボタンでの一時停止・再開も声で
  n0 = (await P.log()).length;
  await P.click("playPauseBtn");
  ok(await P.phase() === "paused" && !(await P.dark()), "ボタンで止めたときは、これまでどおり明るく戻る");
  await P.click("playPauseBtn");
  t = (await P.texts()).slice(n0);
  ok(t.some((x) => x.includes("一時停止しました")) && t.some((x) => x.includes("再開します")), "ボタンでの一時停止・再開も声で伝える", t);
  okErrors(P.errs, "2 長押し");
  await P.close();

  // 残り時間（3分：あと1分。5分：半分とあと1分）
  const Q = await openPage({ voice: { cueSec: 0 } });
  await Q.ev(() => document.querySelector('#lengthSeg .seg[data-d="3"]').click());
  await Q.click("beginBtn");
  await Q.run(119000);
  ok(!(await Q.texts()).some((x) => x.includes("あと1分")), "まだ「あと1分」は言わない");
  await Q.run(3000);
  ok((await Q.texts()).some((x) => x === "あと1分です"), "残り1分で「あと1分です」と伝える", (await Q.texts()).slice(-3));
  ok(!(await Q.texts()).some((x) => x.includes("半分")), "3分の練習では「半分」は言わない（あと1分と重なるため）");
  await Q.click("endBtn"); await Q.click("saveBtn");
  await Q.ev(() => document.querySelector('#lengthSeg .seg[data-d="5"]').click());
  await Q.click("beginBtn");
  await Q.run(152000);
  ok((await Q.texts()).some((x) => x === "半分が過ぎました"), "5分以上なら、半分で「半分が過ぎました」", (await Q.texts()).slice(-3));
  ok((await Q.texts()).some((x) => x === "あと2分半です"), "続けて残りを「あと2分半です」と伝える", (await Q.texts()).slice(-3));
  okErrors(Q.errs, "2 残り時間");
  await Q.close();

  // 案内の声にかぶせない：読み上げが遅く、はじめの案内が50秒を過ぎても続いているとき
  const R = await openPage({ msPerChar: 1500 });
  await R.click("beginBtn");
  await R.run(52000);
  const c0 = await R.ev(() => window.__tts.cancels);
  ok(await R.ev(() => window.speechSynthesis.speaking), "（前提）50秒を過ぎても、はじめの案内がまだ続いている");
  ok(!(await R.log()).some((x) => isQ(x.text)), "案内の声が続いているあいだは、問いかけを始めない", (await R.texts()).slice(-2));
  await R.run(90000);
  const L = await R.log(), st = await R.ev(() => window.__tts.starts.slice()), ends = await R.ev(() => window.__tts.ends.slice());
  const q = L.find((x) => isQ(x.text)), qs = st.find((x) => isQ(x.text));
  const before = L.filter((x) => q && x.at <= q.at && !isQ(x.text)).map((x) => x.text);
  const introEnd = Math.max(...ends.filter((e) => before.includes(e.text)).map((e) => e.at));
  ok(!!q, "待ったあとで問いかける", L.map((x) => x.text));
  ok(q && (await R.ev(() => window.__tts.cancels)) === c0, "案内を止めて割り込まない（読み上げを取り消さない）");
  ok(qs && qs.at >= introEnd, "問いかけは、前の案内を読み終えてから読まれる（後ろに並べる）", { qs, introEnd });
  okErrors(R.errs, "2 かぶせない");
  await R.close();
});

// ── 3. 像を深める問いかけと間隔 ──
await section("3. 問いかけ（ベルクロ）と「問いかけの間隔」", async () => {
  const P = await openPage({});
  ok(await P.ev(() => !!document.getElementById("cueSeg") && [...document.querySelectorAll("#cueSeg .seg")].map((b) => b.textContent.replace(/既定/, "")).join("/") === "なし/50秒/90秒"),
    "「問いかけの間隔」に なし／50秒／90秒 がある");
  ok(await P.ev(() => /on/.test(document.querySelector('#cueSeg .seg[data-c="50"]').className)), "既定は50秒");
  await P.click("beginBtn");
  await P.run(49000);
  let L = await P.log();
  ok(!L.some((x) => isQ(x.text)), "50秒まではまだ問いかけない");
  await P.run(3000);
  L = await P.log();
  const q1 = L.filter((x) => isQ(x.text));
  ok(q1.length === 1, "50秒で、像を深める問いを1つ伝える", L.map((x) => x.text));
  ok(/変わりますか|ありますか|気持ちですか|なっていますか|見えますか|手ざわりですか|来ていますか|起こりますか|ありませんか|何ですか/.test(await P.text("senseLive") || ""), "画面にもその問いが出る", await P.text("senseLive"));
  await P.run(50000);
  L = await P.log();
  ok(L.some((x) => x.text.startsWith("何が聞こえますか")), "次の50秒で、次の感覚（聴覚）へ切り替える", L.map((x) => x.text).slice(-3));
  await P.run(50000);
  const qs = (await P.log()).filter((x) => isQ(x.text)).map((x) => x.text);
  ok(qs.length === 2 && qs[0] !== qs[1], "問いと感覚の切り替えを交互に。同じ問いは続けない", qs);
  await P.click("endBtn"); await P.click("saveBtn");
  // なし
  await P.ev(() => document.querySelector('#cueSeg .seg[data-c="0"]').click());
  ok(await P.ev(() => JSON.parse(localStorage.getItem("image-streaming:voice")).cueSec === 0), "選んだ間隔はこの端末の設定に残る（同期しない）");
  let n0 = (await P.log()).length;
  await P.click("beginBtn"); await P.run(130000);
  let t = (await P.texts()).slice(n0);
  ok(!t.some((x) => isQ(x) || x.startsWith("何が聞こえますか")), "「なし」なら、練習中は問いかけない", t);
  await P.click("endBtn"); await P.click("saveBtn");
  // 90秒
  await P.ev(() => document.querySelector('#cueSeg .seg[data-c="90"]').click());
  n0 = (await P.log()).length;
  await P.click("beginBtn"); await P.run(60000);
  t = (await P.texts()).slice(n0);
  ok(!t.some(isQ), "90秒なら、50秒では問いかけない");
  await P.run(32000);
  t = (await P.texts()).slice(n0);
  ok(t.some(isQ), "90秒で問いかける", t);
  await P.click("endBtn"); await P.click("saveBtn");
  await P.page.reload(); await P.run(500);
  ok(await P.ev(() => /on/.test(document.querySelector('#cueSeg .seg[data-c="90"]').className)), "開き直しても間隔は残る");
  okErrors(P.errs, "3");
  await P.close();
});

// ── 4. ふり返り・一覧で直す・消す・検索 ──
await section("4. ふり返りの問いと欄・一覧で直す・消す・さがす", async () => {
  const old = [
    { date: dayOff(-3), ts: T0.getTime() - 3 * 864e5, sec: 600, scene: "まな板の上の、切ったばかりのレモン", note: "酸っぱい匂い", vivid: 3 },
    { date: dayOff(-2), ts: T0.getTime() - 2 * 864e5, sec: 300, scene: "朝いちばんのパン屋", note: "", vivid: null, image: 123, meaning: null, extra: "残す" },
    { date: dayOff(-1), ts: T0.getTime() - 864e5, sec: 600, scene: "引き潮の港", note: "", vivid: 5, image: "錆びた鎖", meaning: "時間" }
  ];
  const P = await openPage({ seed: { "image-streaming:v1": H(old) }, voice: { cueSec: 0 } });
  await P.ev(() => document.querySelector('#lengthSeg .seg[data-d="3"]').click());
  await P.click("beginBtn"); await P.run(185000);
  const t = await P.texts();
  ok(t.some((x) => x.startsWith("いちばん印象に残ったものは")), "終わりの声で「いちばん印象に残ったものは何でしたか」と聞く", t.slice(-4));
  ok(t.indexOf("時間です") >= 0, "「時間です」も、これまでどおり伝える");
  ok(await P.ev(() => !!document.getElementById("imgEl") && !!document.getElementById("meanEl")) &&
     /印象に残った像/.test(await P.ev(() => document.getElementById("ctlDone").textContent)) && /気づき・意味/.test(await P.ev(() => document.getElementById("ctlDone").textContent)),
     "終了画面に「印象に残った像」「気づき・意味」の欄がある");
  await P.click("saveBtn");
  // 古い記録も読める・形の違う値はそろえる
  let h = await P.hist();
  const bread = h.find((x) => x.scene === "朝いちばんのパン屋");
  ok(bread && bread.image === "123" && bread.meaning === "" && bread.extra === "残す", "新しい項目も形をそろえて受け入れる（知らない項目は残す）", bread);
  await P.click("journalToggle");
  let items = await P.ev(() => [...document.querySelectorAll("#jlist .jitem")].map((x) => x.textContent));
  ok(items.length === 4 && items.some((x) => x.includes("酸っぱい匂い")) && items.some((x) => x.includes("錆びた鎖") && x.includes("時間")), "一覧に古い記録も新しい欄も出る", items);
  // さがす
  await P.page.fill("#jsearch", "レモン");
  items = await P.ev(() => [...document.querySelectorAll("#jlist .jitem")].map((x) => x.textContent));
  ok(items.length === 1 && items[0].includes("レモン"), "お題でさがせる", items);
  await P.page.fill("#jsearch", "錆びた");
  items = await P.ev(() => [...document.querySelectorAll("#jlist .jitem")].map((x) => x.textContent));
  ok(items.length === 1 && items[0].includes("引き潮"), "印象に残った像でもさがせる", items);
  await P.page.fill("#jsearch", "酸っぱい");
  items = await P.ev(() => [...document.querySelectorAll("#jlist .jitem")].map((x) => x.textContent));
  ok(items.length === 1, "メモでもさがせる", items);
  await P.page.fill("#jsearch", "");
  // 直す
  const kLemon = String(old[0].ts);
  const sel = (k, s) => `#jlist .jitem[data-k="${k}"] ${s}`;
  await P.page.click(sel(kLemon, '[data-act="edit"]'));
  ok(await P.ev((k) => !!document.querySelector(`#jlist .jitem[data-k="${k}"] textarea[data-f="image"]`), kLemon), "「直す」で欄が出る");
  await P.page.fill(sel(kLemon, 'textarea[data-f="image"]'), "黄色い断面");
  await P.page.fill(sel(kLemon, 'textarea[data-f="meaning"]'), "はっきり見えるのは近くのもの");
  await P.page.fill(sel(kLemon, 'textarea[data-f="note"]'), "酸っぱい匂いが強い");
  await P.page.click(sel(kLemon, '[data-act="rate"][data-v="5"]'));
  await P.page.click(sel(kLemon, '[data-act="save"]'));
  h = await P.hist();
  const lem = h.find((x) => String(x.ts) === kLemon);
  ok(lem && lem.image === "黄色い断面" && lem.meaning === "はっきり見えるのは近くのもの" && lem.note === "酸っぱい匂いが強い" && lem.vivid === 5 && lem.upd > 0,
    "一覧で直した中身が記録に入る（直した時刻も）", lem);
  // 消す
  const kBread = String(old[1].ts);
  await P.page.click(sel(kBread, '[data-act="del"]'));
  ok((await P.hist()).length === 4, "一覧の「消す」も、まず確かめる");
  await P.page.click(sel(kBread, '[data-act="delyes"]'));
  h = await P.hist();
  const cl = await P.cleared();
  ok(h.length === 3 && !h.some((x) => String(x.ts) === kBread) && cl && cl.keys.includes(kBread), "1件だけ消え、消した鍵が残る", { n: h.length, cl });
  okErrors(P.errs, "4");
  await P.close();
});

await section("4. 1件の削除と直したものは、同期でほかの端末にも届く（戻ってこない）", async () => {
  const drive = createFakeDrive();
  const r1 = { date: dayOff(-2), ts: T0.getTime() - 2 * 864e5, sec: 300, scene: "一", note: "", vivid: null };
  const r2 = { date: dayOff(-1), ts: T0.getTime() - 864e5, sec: 300, scene: "二", note: "", vivid: null };
  const sync = async (P) => {
    if (!(await P.ev(() => document.getElementById("bSyncNow").offsetParent !== null))) await P.click("bSync");
    await P.click("bSyncNow");
    for (let i = 0; i < 100; i++) { await P.run(100); await P.page.waitForTimeout(20); if (!/同期しています/.test(await P.text("syncMsg"))) break; }
    return P.text("syncMsg");
  };
  const A = await openPage({ drive, seed: { "image-streaming:v1": H([r1, r2]) } });
  const B = await openPage({ drive, seed: { "image-streaming:v1": H([r1, r2]) } });
  await sync(A); await sync(B);
  // A で r1 を消し、r2 の気づきを直す
  await A.click("journalToggle");
  await A.page.click(`#jlist .jitem[data-k="${r1.ts}"] [data-act="del"]`);
  await A.page.click(`#jlist .jitem[data-k="${r1.ts}"] [data-act="delyes"]`);
  await A.run(1000);
  await A.page.click(`#jlist .jitem[data-k="${r2.ts}"] [data-act="edit"]`);
  await A.page.fill(`#jlist .jitem[data-k="${r2.ts}"] textarea[data-f="meaning"]`, "Aで書いた気づき");
  await A.page.click(`#jlist .jitem[data-k="${r2.ts}"] [data-act="save"]`);
  await A.run(1000);
  const msgA = await sync(A);
  await B.run(1000);
  const msgB = await sync(B);
  let hb = await B.hist();
  ok(hb.length === 1 && hb[0].scene === "二", "A で消した記録は、B からも消える（B に残っていた写しで戻らない）", { hb, msgA, msgB });
  ok(hb[0] && hb[0].meaning === "Aで書いた気づき", "A で直した中身が B に届く", hb[0]);
  // B があとから直したら、A にも届く（古い写しで戻さない）。端末ごとの偽の時計を、B の方を先へ進めておく
  await B.run(60000);
  await B.click("journalToggle");
  await B.page.click(`#jlist .jitem[data-k="${r2.ts}"] [data-act="edit"]`);
  await B.page.fill(`#jlist .jitem[data-k="${r2.ts}"] textarea[data-f="image"]`, "Bの像");
  await B.page.click(`#jlist .jitem[data-k="${r2.ts}"] [data-act="save"]`);
  await B.run(1000);
  await sync(B); await sync(A);
  const ha = await A.hist();
  ok(ha.length === 1 && ha[0].image === "Bの像" && ha[0].meaning === "Aで書いた気づき", "あとから直した方が、どちらの端末にも残る", ha);
  const f = drive.byName("nikki-apps-data.json")[0];
  const sec = f ? drive.json(f.id).apps.anshitsu : null;
  ok(sec && sec.clearedKeys.includes(String(r1.ts)) && sec.history.length === 1, "ドライブにも消した鍵が載る", sec);
  okErrors(A.errs, "4 同期A"); okErrors(B.errs, "4 同期B");
  await A.close(); await B.close();
});

// ── 5. Ten/Ten は「その日の合計10分」 ──
await section("5. Ten/Ten：10分に届いた日だけ1コマ", async () => {
  const day = (n, sec, i = 0) => ({ date: dayOff(n), ts: T0.getTime() + n * 864e5 - 3600e3 + i * 60e3, sec, scene: "s", note: "", vivid: null });
  const seed = [day(-4, 600), day(-3, 300), day(-2, 360), day(-2, 300, 1), { ...day(0, 420), ts: T0.getTime() - 600e3 }];
  const P = await openPage({ seed: { "image-streaming:v1": H(seed) }, voice: { cueSec: 0 } });
  const strip = () => P.ev(() => [...document.querySelectorAll("#strip .frame")].map((f) => (f.classList.contains("dev") ? "D" : f.classList.contains("half") ? "h" : "-")).join(""));
  ok(await P.text("cycleTxt") === "2 / 10", "10分に届いた日だけを数える（5分の日・今日の7分は数えない。2回に分けて11分の日は数える）", await P.text("cycleTxt"));
  ok(await strip() === "Dh" + "D" + "h" + "--------", "届かない日は半分だけ現像したコマで見せる", await strip());
  ok((await P.hidden("todayTxt")) === false && await P.text("todayTxt") === "今日 7/10分", "「今日 7/10分」と出る", await P.text("todayTxt"));
  ok(await P.text("statDays") === "4", "「練習した日」は、これまでどおり練習した日すべて", await P.text("statDays"));
  await P.ev(() => document.querySelector('#lengthSeg .seg[data-d="3"]').click());
  await P.click("beginBtn"); await P.run(182000);
  ok(/今日 10\/10分|今日 10分/.test(await P.text("doneMeta") || ""), "終了画面にも今日の合計が出る", await P.text("doneMeta"));
  await P.click("saveBtn");
  ok(await P.text("cycleTxt") === "3 / 10" && await strip() === "DhDD-------", "今日の合計が10分に届くと、1コマ現像される", [await P.text("cycleTxt"), await strip()]);
  ok(/今日 10分/.test(await P.text("todayTxt") || ""), "届いたら「今日 10分 ✓」", await P.text("todayTxt"));
  okErrors(P.errs, "5");
  await P.close();
  // 10コマそろったあと、今日まだ10分に届いていない → 新しい巻の半分のコマ
  const ten = []; for (let i = 1; i <= 10; i++) ten.push(day(-i - 1, 600));
  ten.push({ ...day(0, 120), ts: T0.getTime() - 600e3 });
  const Q = await openPage({ seed: { "image-streaming:v1": H(ten) } });
  const s2 = await Q.ev(() => [...document.querySelectorAll("#strip .frame")].map((f) => (f.classList.contains("dev") ? "D" : f.classList.contains("half") ? "h" : "-")).join(""));
  ok(await Q.text("cycleTxt") === "2周目 · 0 / 10" && s2 === "h----------", "10コマそろった次の日からは新しい巻（今日はまだ半分）", [await Q.text("cycleTxt"), s2]);
  okErrors(Q.errs, "5 2周目");
  await Q.close();
});

// ── 6. 録音（この端末だけ） ──
await section("6. 録音：許可・区切り・置き場・再生・削除", async () => {
  const drive = createFakeDrive();
  const P = await openPage({ drive, voice: { cueSec: 0 } });
  ok((await P.hidden("recBtn")) === false && /録音/.test(await P.text("recBtn") || ""), "設定に「描写を録音する（この端末だけ）」がある");
  ok(!(await P.ev(() => /on/.test(document.getElementById("recSwitch").className))), "既定はOFF");
  const help = await P.text("recHelp");
  ok(/同期/.test(help) && /MB/.test(help) && /iPhone/.test(help) && /受話口|小さく/.test(help), "説明に、同期しないこと・大きさ・iPhoneで声が小さくなることを書く", help);
  await P.click("beginBtn"); await P.run(2000);
  ok((await P.mic()).requests === 0, "OFFのときはマイクを求めない");
  await P.click("endBtn"); await P.click("discardBtn");   // 30秒未満なので「記録しないで閉じる」
  ok((await P.hist()).length === 0 && await P.phase() === "idle", "短い回は「記録しないで閉じる」で何も残さない");
  await P.click("recBtn");
  ok(await P.ev(() => JSON.parse(localStorage.getItem("image-streaming:voice")).rec === true), "ONはこの端末の設定に残る");
  await P.click("beginBtn");
  let m = await P.mic();
  ok(m.requests === 1 && m.inClick[0] === true, "「はじめる」を押した流れの中でマイクを求める（許可の画面が操作への返事として出る）", m);
  await P.settle();
  m = await P.mic();
  ok(m.recs.length === 1 && m.recs[0] === "recording", "録音が始まる", m);
  ok(/録音中/.test(await P.text("recLive") || ""), "練習中の画面に「録音中」と出る", await P.text("recLive"));
  await P.run(40000);
  await P.click("playPauseBtn");
  await P.settle();
  m = await P.mic();
  ok(m.recs[0] === "inactive" && m.stopped >= 1 && m.disconnects >= 1, "一時停止で録音を区切り、マイクを切る（音の大きさを見るのも止める）", m);
  await P.run(20000);
  await P.click("playPauseBtn");
  await P.settle();
  m = await P.mic();
  ok(m.requests === 2 && m.recs.length === 2 && m.recs[1] === "recording", "再開でまたマイクを使い、録音を続ける", m);
  await P.run(30000);
  await P.click("endBtn");
  await P.settle(10);
  const h = await P.hist();
  const key = h.length ? String(h[h.length - 1].ts) : "";
  m = await P.mic();
  ok(m.recs.every((s) => s === "inactive") && m.stopped >= 2, "終了で録音を止め、マイクを切る", m);
  let db = await idb(P.page);
  const meta = db.meta.find((x) => x.key === key), clip = db.clips.find((x) => x.key === key);
  ok(meta && clip && clip.n === 2 && clip.bytes > 200000 && meta.size === clip.bytes, "録音は記録の鍵で IndexedDB に置く（一時停止で2つに区切られる）", { key, db });
  ok((await P.hidden("donePlay")) === false && /録音を聞く（\d+KB）/.test(await P.text("donePlay") || ""), "終了画面に「録音を聞く（大きさ）」が出る", await P.text("donePlay"));
  await P.click("donePlay");
  await P.settle();
  m = await P.mic();
  ok(m.played.length === 1 && /^blob:/.test(m.played[0]) && /止める/.test(await P.text("donePlay") || ""), "押すと再生する（もう一度で止める）", { played: m.played, label: await P.text("donePlay") });
  await P.click("donePlay");
  await P.click("saveBtn");
  // 同期しない
  if (!(await P.ev(() => document.getElementById("bSyncNow").offsetParent !== null))) await P.click("bSync");
  await P.click("bSyncNow");
  for (let i = 0; i < 100; i++) { await P.run(100); await P.page.waitForTimeout(20); if (!/同期しています/.test(await P.text("syncMsg"))) break; }
  const f = drive.byName("nikki-apps-data.json")[0];
  const raw = f ? JSON.stringify(drive.json(f.id)) : "";
  ok(raw.includes(key) && raw.length < 3000 && !/parts|blob|audio/i.test(raw), "録音は同期しない（ドライブには記録だけ）", raw.slice(0, 300));
  // 一覧の再生ボタン・設定の合計
  await P.click("journalToggle");
  ok(await P.ev((k) => !!document.querySelector(`#jlist .jitem[data-k="${k}"] [data-act="play"]`), key), "一覧のその記録にも再生ボタンが出る");
  ok((await P.hidden("recStore")) === false && /1件・\d+KB/.test(await P.text("recStore") || ""), "設定に、この端末の録音の件数と大きさが出る", await P.text("recStore"));
  // 2件目を録って、1件だけ消す
  await P.click("beginBtn"); await P.settle(); await P.run(35000); await P.click("endBtn"); await P.settle(10);
  const h2 = await P.hist(), key2 = String(h2[h2.length - 1].ts);
  await P.click("saveBtn");
  db = await idb(P.page);
  ok(db.meta.length === 2, "2件目の録音も置く", db.meta.map((x) => x.key));
  await P.page.click(`#jlist .jitem[data-k="${key}"] [data-act="del"]`);
  ok(/録音も消えます/.test(await P.ev((k) => document.querySelector(`#jlist .jitem[data-k="${k}"]`).textContent, key)), "消す確認で、録音も消えると伝える");
  await P.page.click(`#jlist .jitem[data-k="${key}"] [data-act="delyes"]`);
  await P.settle();
  db = await idb(P.page);
  ok(db.meta.length === 1 && db.meta[0].key === key2 && db.clips.length === 1, "記録を消すと、その録音も消える", db);
  // 全部消す
  await P.click("recClear");
  ok((await idb(P.page)).meta.length === 1 && /すべて消しますか/.test(await P.text("recStore") || ""), "「録音を全部消す」も、まず確かめる", await P.text("recStore"));
  await P.click("recClearYes");
  await P.settle();
  db = await idb(P.page);
  ok(db.meta.length === 0 && db.clips.length === 0 && (await P.hidden("recStore")) === true, "「録音を全部消す」で録音だけが消える", db);
  ok((await P.hist()).length === 1, "記録は残る（消したのは録音だけ）");
  okErrors(P.errs, "6");
  await P.close();
});

await section("6. 録音：断られた・使えない・短い回", async () => {
  const P = await openPage({ mic: "deny", voice: { rec: true, cueSec: 50 } });
  await P.click("beginBtn");
  await P.run(14000);
  let t = await P.texts();
  ok(t.some((x) => x.startsWith("マイクが使えないため、録音せずに続けます")), "許可されなかったら、録音せずに続けると声で伝える", t);
  ok(/マイクが使えない/.test(await P.text("recLive") || ""), "画面にも出る", await P.text("recLive"));
  await P.run(40000);
  t = await P.texts();
  ok(await P.phase() === "running" && t.some(isQ), "練習はそのまま続く（問いかけも）", t.slice(-3));
  await P.click("playPauseBtn"); await P.click("playPauseBtn");
  ok((await P.mic()).requests === 1, "その回は、再開しても許可を求め直さない");
  await P.click("endBtn"); await P.settle();
  ok((await P.hist()).length === 1 && (await P.hidden("donePlay")) === true, "記録は残り、録音は無い");
  okErrors(P.errs, "6 断られた");
  await P.close();

  const N = await openPage({ noRec: true, voice: { rec: true } });
  ok(/録音できません/.test(await N.text("recHelp") || ""), "録音できない環境では、そう伝える", await N.text("recHelp"));
  await N.click("beginBtn"); await N.run(40000); await N.click("endBtn");
  ok((await N.hist()).length === 1, "録音できなくても練習と記録はふつうにできる");
  okErrors(N.errs, "6 使えない");
  await N.close();

  // 30秒に満たない回：自動では残さず、「記録する」を押したら録音も置く
  const S = await openPage({ voice: { rec: true, cueSec: 0 } });
  await S.click("beginBtn"); await S.settle(); await S.run(15000); await S.click("endBtn"); await S.settle(10);
  ok((await idb(S.page)).meta.length === 0, "記録しなかった回の録音は置かない");
  await S.click("saveBtn"); await S.settle(10);
  const h = await S.hist(), db = await idb(S.page);
  ok(h.length === 1 && db.meta.length === 1 && db.meta[0].key === String(h[0].ts), "「記録する」を押したら、その録音も置く", { h, db });
  okErrors(S.errs, "6 短い回");
  await S.close();
});

// ── 7. 黙っているとき・話しているとき ──
await section("7. 黙りが続くと短く呼びかけ、話している途中は問いかけを待つ", async () => {
  // 案内の声はマイクに入る（読み上げ中だけ大きい）。本人は黙っている。間隔は長め（90秒）にして、呼びかけだけを見る
  const P = await openPage({ voice: { rec: true, cueSec: 90 } });
  await P.ev(() => { window.__mic.levelFn = () => (window.speechSynthesis.speaking ? 0.3 : 0); });
  await P.click("beginBtn");
  await P.settle();
  for (let i = 0; i < 60; i++) { await P.run(500); if (!(await P.ev(() => window.speechSynthesis.speaking))) break; }
  const introEnd = await P.ev(() => Date.now());
  await P.run(11000);
  ok(!(await P.texts()).some(isNudge), "黙って12秒たつまでは呼びかけない（案内の声は本人の声と数えない）");
  await P.run(3000);
  let L = await P.log();
  const n1 = L.filter((x) => isNudge(x.text));
  ok(n1.length === 1 && n1[0].at - introEnd >= 11000 && n1[0].at - introEnd <= 14000, "黙って12秒たつと、短く呼びかける", { n1, introEnd, t: L.map((x) => x.text).slice(-2) });
  await P.run(20000);
  ok((await P.log()).filter((x) => isNudge(x.text)).length === 1, "呼びかけは30秒に1回まで");
  await P.run(15000);
  ok((await P.log()).filter((x) => isNudge(x.text)).length === 2, "黙ったままなら、30秒ほどおいてまた呼びかける");
  // 話しはじめたら呼びかけない
  await P.ev(() => { window.__mic.levelFn = null; window.__mic.level = 0.2; });
  const c = (await P.log()).filter((x) => isNudge(x.text)).length;
  await P.run(60000);
  ok((await P.log()).filter((x) => isNudge(x.text)).length === c, "話しているあいだは呼びかけない");
  await P.click("playPauseBtn");
  const m = await P.mic();
  ok(m.disconnects >= 1, "一時停止で、音の大きさを見るのをやめる", m);
  await P.click("playPauseBtn"); await P.settle();
  await P.click("endBtn");
  okErrors(P.errs, "7 呼びかけ");
  await P.close();

  // 問いかけの時刻に話していたら、話し終えるまで待つ
  const Q = await openPage({ voice: { rec: true, cueSec: 50 } });
  await Q.click("beginBtn"); await Q.settle();
  const t0 = await Q.ev(() => JSON.parse(localStorage.getItem("image-streaming:running")).at);   // 始めた時刻
  await Q.run(t0 + 44000 - await Q.ev(() => Date.now()));
  await Q.ev(() => { window.__mic.level = 0.2; });     // 44秒から話しはじめる
  await Q.run(14000);                                   // 58秒まで話す
  ok(!(await Q.log()).some((x) => isQ(x.text)), "話しているあいだは、50秒の問いかけを待つ", (await Q.texts()).slice(-2));
  await Q.ev(() => { window.__mic.level = 0; });
  await Q.run(4000);
  const q = (await Q.log()).find((x) => isQ(x.text));
  ok(q && q.at - t0 >= 58500 && q.at - t0 <= 61000, "話し終えて少ししてから問いかける", q && (q.at - t0));
  // 話しつづけていたら、その問いかけは見送る（次は約50秒後の、感覚の切り替え）
  await Q.ev(() => { window.__mic.level = 0.2; });     // ここからずっと話している
  const before = (await Q.log()).length;
  await Q.run(80000);
  let t = (await Q.texts()).slice(before);
  ok(!t.some((x) => x.startsWith("何が聞こえますか")), "話しつづけているあいだは、問いかけを見送る（流れを止めない）", t);
  ok(!t.some(isNudge), "話しているあいだは呼びかけもしない", t);
  okErrors(Q.errs, "7 待つ");
  await Q.close();

  // マイクを使わないときは呼びかけない
  const R = await openPage({ voice: { rec: false, cueSec: 50 } });
  await R.click("beginBtn"); await R.run(90000);
  ok(!(await R.texts()).some(isNudge) && (await R.texts()).some(isQ), "マイクを使わないときは、黙っていても呼びかけない（問いかけはふつうに出る）");
  okErrors(R.errs, "7 マイクなし");
  await R.close();
  // 「問いかけの間隔：なし」なら、マイクを使っていても呼びかけない
  const R2 = await openPage({ voice: { rec: true, cueSec: 0 } });
  await R2.click("beginBtn"); await R2.settle(); await R2.run(60000);
  ok(!(await R2.texts()).some(isNudge), "「なし」なら、マイクを使っていても呼びかけない");
  okErrors(R2.errs, "7 なし");
  await R2.close();
});

await browser.close();
await srv.close();
done();
