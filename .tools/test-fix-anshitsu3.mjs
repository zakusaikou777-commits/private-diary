/* 暗室（image-streaming.html）v54 の修正の検証（配布には不要。要 playwright）
     node .tools/test-fix-anshitsu3.mjs              … いまのファイルで
     node .tools/test-fix-anshitsu3.mjs --root=DIR   … 別の場所のファイルで（直す前の版との比べ用）

   読み上げ・マイク・録音・再生の偽物は test-fix-anshitsu2.mjs と同じ（INIT）。画面ロック（wakeLock）、
   保存の「消されにくくする」（storage.persist）、オブジェクトURL、容量いっぱい（setItem が投げる）も偽物にする。
   確かめること（v54）
   1. シェルでほかのタブへ移った（{nkHidden:true}）ら、明るい一時停止と同じく止める（声・マイク・録音・画面ロック・暗転）
   2. 小さい画面・横向きでも、はじめた直後と触ったときに時計と「一時停止・終了」が画面に入る。触っているあいだは暗くしない
   3. 長押しで暗いまま止めたあいだは画面ロックを保つ（15分で手放す）
   4. 記録の日付は始めた日（日付をまたいだ練習・落ちた練習の控えも）
   5. 落ちた直後に「はじめる」を押しても、前の練習の「記録しますか」は終わったあとに聞く（別のタブで続いていたら聞かない）
   6. 「履歴を消去」は練習の外でだけ。終了画面の記録が同期で消えたら、そう出して「記録する」で残し直せる
   7. 欄ごとの同期：片方で鮮明さ、もう片方でメモを直しても、両方残る
   8. 記録の無い録音を片付ける（書いたばかりは残す）・storage.persist・200MBの知らせ（1回）・手元の録音は3件まで
   9. 「あと1分」を待っているあいだに一時停止しても、再開したら伝える
  10. 読み上げ（スクリーンリーダー）：スイッチ・選択ボタン・暗い画面の説明・「記録しますか」へのフォーカス
   UX: 長さを覚える・はじめる前の Space で始めない・暗いときの Space は暗いまま止める・分は切り捨て・
       画面ロックが取れないと知らせる・容量いっぱいの知らせを暗い画面の上に出さない */
import path from "node:path";
import { startServer, launch, newDevice, makeChecker, collectErrors, ROOT } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const rootArg = process.argv.find((a) => a.startsWith("--root="));
const root = rootArg ? path.resolve(rootArg.slice(7)) : ROOT;
const T0 = new Date("2026-11-07T01:00:00Z");   // 日本時間 2026-11-07 10:00
const { ok, done } = makeChecker("暗室 v54");
console.log("対象: " + path.join(root, "image-streaming.html"));

/* ---- test-fix-anshitsu2.mjs と同じ偽物（読み上げ・マイク・録音・再生） ---- */
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


/* ---- 画面ロック・storage.persist・オブジェクトURL・容量いっぱい ---- */
function EXTRA(arg) {
  const W = window.__wake = { req: 0, rel: 0, active: 0, mode: arg.wake || "allow" };
  if (W.mode === "none") { try { Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, get() { return undefined; } }); } catch (e) {} }
  else {
    const api = {
      request() {
        W.req++;
        if (W.mode === "deny") return Promise.reject(new DOMException("denied", "NotAllowedError"));
        W.active++;
        const ls = [];
        const s = { released: false, release() { if (!s.released) { s.released = true; W.rel++; W.active--; ls.forEach((f) => f()); } return Promise.resolve(); },
                    addEventListener(t, f) { if (t === "release") ls.push(f); } };
        return Promise.resolve(s);
      }
    };
    Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, get() { return api; } });
  }
  window.__persist = 0;
  try {
    if (navigator.storage) navigator.storage.persist = function () { window.__persist++; return Promise.resolve(true); };
  } catch (e) {}
  const U = window.__urls = { live: 0, made: 0 };
  const mk = URL.createObjectURL.bind(URL), rv = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (b) { U.live++; U.made++; return mk(b); };
  URL.revokeObjectURL = function (u) { U.live--; return rv(u); };
  // 容量いっぱい：window.__full のあいだ、アプリの書き込みは投げる
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (window.__full && !String(k).startsWith("__")) throw new DOMException("full", "QuotaExceededError");
    return set.call(this, k, v);
  };
}

const srv = await startServer(root);
const browser = await launch();

const VOICE = (o = {}) => JSON.stringify({ cues2: 1, speakCues: true, dim: true, free: false, ...o });
const H = (o) => JSON.stringify(o);
function localDay(ms) { const d = new Date(ms + 9 * 3600e3); return d.toISOString().slice(0, 10); }   // 日本時間の日付

/* opts: voice, seed, time, mic, wake, drive, viewport(=mobile), path（親ページ用） */
async function openPage(opts = {}) {
  const seed = { "image-streaming:voice": VOICE(opts.voice), ...(opts.seed || {}) };
  if (opts.drive) seed["shared:gd:cid"] = "test-client";
  const contextOptions = { timezoneId: "Asia/Tokyo" };
  if (opts.viewport) Object.assign(contextOptions, { viewport: opts.viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const context = await newDevice(browser, { drive: opts.drive || null, contextOptions });
  await context.addInitScript(INIT, { seed, mic: opts.mic, noRec: !!opts.noRec, msPerChar: opts.msPerChar });
  await context.addInitScript(EXTRA, { wake: opts.wake });
  if (opts.parent) {
    // シェルの代わりの親ページ（同じオリジン）。暗室を iframe で開き、届いた知らせを控える
    await context.route(srv.url + "__shell.html", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8",
      body: '<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe id="f" src="image-streaming.html" style="width:420px;height:760px;border:0" allow="screen-wake-lock"></iframe>' +
            '<script>window.__msgs=[];addEventListener("message",function(e){__msgs.push(e.data)});</script>' }));
  }
  const page = await context.newPage();
  const errs = collectErrors(page);
  const time = opts.time || T0;
  await page.clock.install({ time });
  await page.goto(srv.url + (opts.parent ? "__shell.html" : "image-streaming.html"));
  await page.clock.pauseAt(new Date(time.getTime() + 10000));
  let F = page.mainFrame();
  if (opts.parent) {
    for (let i = 0; i < 100; i++) {
      await page.clock.runFor(100); await page.waitForTimeout(30);
      F = page.frames().find((f) => /image-streaming\.html$/.test(f.url()));
      if (F && await F.evaluate(() => !!document.getElementById("beginBtn") && document.readyState === "complete").catch(() => false)) break;
    }
  }
  await page.clock.runFor(4000);   // 声の一覧の見直し（0.3/1.2/3秒）まで済ませる
  const ev = (fn, a) => F.evaluate(fn, a);
  const P = {
    page, context, errs, F, ev,
    run: (ms) => page.clock.runFor(ms),
    click: (id) => ev((id) => { const el = document.getElementById(id); if (!el) return false; window.__inClick = true; try { el.click(); } finally { window.__inClick = false; } return true; }, id),
    text: (id) => ev((id) => { const e = document.getElementById(id); return e ? e.textContent : null; }, id),
    hidden: (id) => ev((id) => { const e = document.getElementById(id); return e ? !!e.hidden : null; }, id),
    hist: () => ev(() => JSON.parse(localStorage.getItem("image-streaming:v1") || "[]")),
    texts: () => ev(() => window.__tts.log.map((x) => x.text)),
    wake: () => ev(() => ({ ...window.__wake })),
    mic: () => ev(() => { const M = window.__mic; return { streams: M.streams, stopped: M.stopped, recs: M.recorders.map((r) => r.state) }; }),
    phase: () => ev(() => {
      const h = (id) => { const e = document.getElementById(id); return e ? e.hidden : null; };
      return !h("ctlDone") ? "done" : !h("pausedLbl") && !h("ctlRun") ? "paused" : !h("ctlRun") ? "running" : "idle";
    }),
    dark: () => ev(() => !document.getElementById("darkroom").hidden),
    tap: () => ev(() => document.getElementById("darkroom").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50 }))),
    up: () => ev(() => { const d = document.getElementById("darkroom"); d.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 50, clientY: 50 })); d.click(); }),
    longPress: async () => { await P.tap(); await P.run(900); await P.up(); },
    shortTap: async () => { await P.tap(); await P.run(120); await P.up(); },
    inView: (ids) => ev((ids) => { const vh = innerHeight; return ids.every((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= vh; }); }, ids),
    toast: () => ev(() => { const t = document.getElementById("isToast"); return t && t.style.display !== "none" ? t.textContent : ""; }),
    settle: async (n = 6) => { for (let i = 0; i < n; i++) { await page.clock.runFor(50); await page.waitForTimeout(40); } },
    close: () => context.close()
  };
  return P;
}
async function idbKeys(P) {
  return P.ev(async () => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    if (!dbs.some((d) => d.name === "image-streaming-audio")) return { meta: [], clips: [] };
    return new Promise((res) => {
      const rq = indexedDB.open("image-streaming-audio");
      rq.onsuccess = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains("meta")) { db.close(); res({ meta: [], clips: [] }); return; }
        const tx = db.transaction(["meta", "clips"], "readonly");
        const a = tx.objectStore("meta").getAllKeys(), b = tx.objectStore("clips").getAllKeys();
        tx.oncomplete = () => { db.close(); res({ meta: a.result.map(String).sort(), clips: b.result.map(String).sort() }); };
      };
      rq.onerror = () => res(null);
    });
  });
}
async function syncNow(P) {
  if (!(await P.ev(() => document.getElementById("bSyncNow").offsetParent !== null))) await P.click("bSync");
  await P.click("bSyncNow");
  for (let i = 0; i < 100; i++) { await P.run(100); await P.page.waitForTimeout(20); if (!/同期しています/.test(await P.text("syncMsg"))) break; }
  return P.text("syncMsg");
}
function okErrors(errs, label) {
  const e = errs.filter((x) => !/Failed to load resource/.test(x));
  ok(e.length === 0, label + ": ページのエラーが無い", e);
}
async function section(name, fn) {
  console.log("\n" + name);
  try { await fn(); } catch (e) { ok(false, name + ": 途中で止まらない", String(e && e.stack || e).split("\n").slice(0, 3).join(" / ")); }
}

// ── 1. シェルでほかのタブへ移ったら止める ──
await section("1. シェルでほかのタブへ移った（nkHidden）ら、明るい一時停止と同じく止める", async () => {
  const P = await openPage({ parent: true, voice: { cueSec: 50, rec: true } });
  await P.click("beginBtn");
  await P.run(8000); await P.settle(3);
  const msgs = () => P.page.evaluate(() => window.__msgs.filter((m) => m && typeof m.nkDark === "boolean").map((m) => m.nkDark));
  ok(await P.phase() === "running" && await P.dark() && (await msgs()).slice(-1)[0] === true && (await P.wake()).active === 1 && (await P.mic()).recs[0] === "recording",
    "（前提）練習中・暗い・シェルに暗さを伝えた・画面ロック・録音中", { m: await msgs(), w: await P.wake(), mic: await P.mic() });
  // 親以外（自分自身）からの nkHidden は受け付けない
  await P.ev(() => window.postMessage({ nkHidden: true }, location.origin));
  await P.run(300);
  ok(await P.phase() === "running", "親（シェル）以外からの nkHidden では止めない");
  const n0 = (await P.texts()).length;
  await P.page.evaluate(() => document.getElementById("f").contentWindow.postMessage({ nkHidden: true }, location.origin));
  await P.run(300); await P.settle(3);
  ok(await P.phase() === "paused", "シェルから nkHidden が届いたら一時停止する", await P.phase());
  ok(!(await P.dark()) && (await msgs()).slice(-1)[0] === false, "明るく戻し、シェルのタブ帯も明るく戻す（nkDark:false）", await msgs());
  const mic = await P.mic();
  ok(mic.recs.every((s) => s === "inactive") && mic.stopped >= 1, "録音を止め、マイクを切る", mic);
  ok((await P.wake()).active === 0, "画面ロックを手放す", await P.wake());
  await P.run(120000);
  const t = (await P.texts()).slice(n0);
  ok(t.length === 0, "ほかのタブにいるあいだは、問いかけも呼びかけも声に出さない（「一時停止しました」も言わない）", t);
  ok(await P.phase() === "paused" && (await P.hist()).length === 0, "戻ってきても自動では再開せず、時間いっぱいの練習として記録もしない");
  okErrors(P.errs, "1");
  await P.close();

  // 暗いまま止めていた（長押し）ときも、明るく戻して画面ロックを手放す
  const Q = await openPage({ parent: true, voice: { cueSec: 0 } });
  await Q.click("beginBtn"); await Q.run(8000);
  await Q.longPress(); await Q.settle(2);
  ok(await Q.phase() === "paused" && await Q.dark(), "（前提）長押しで暗いまま止めている");
  await Q.page.evaluate(() => document.getElementById("f").contentWindow.postMessage({ nkHidden: true }, location.origin));
  await Q.run(300); await Q.settle(2);
  ok(!(await Q.dark()) && (await Q.wake()).active === 0, "暗いまま止めていたときも、明るく戻して画面ロックを手放す", await Q.wake());
  await Q.close();
});

// ── 2. 小さい画面・横向き ──
await section("2. 小さい画面・横向きでも、時計と「一時停止・終了」が画面に入る", async () => {
  for (const [w, h] of [[667, 375], [320, 568]]) {
    const P = await openPage({ viewport: { width: w, height: h }, voice: { cueSec: 0 } });
    await P.page.locator("#beginBtn").scrollIntoViewIfNeeded();
    await P.page.locator("#beginBtn").tap();
    await P.run(300);
    ok(await P.inView(["clock", "playPauseBtn", "endBtn"]), `${w}x${h}: はじめた直後、時計と「一時停止・終了」が画面に入っている`,
      await P.ev(() => ({ y: scrollY, clock: document.getElementById("clock").getBoundingClientRect().top, btn: document.getElementById("playPauseBtn").getBoundingClientRect().top })));
    await P.run(20000);
    ok(await P.dark(), `${w}x${h}: （前提）暗くなる`);
    await P.ev(() => window.scrollTo(0, 1e6));   // 何かの拍子にページが下に送られていても
    await P.shortTap(); await P.run(100);
    ok(!(await P.dark()) && await P.inView(["clock", "playPauseBtn", "endBtn"]), `${w}x${h}: 触ると、時計と操作が画面に入る（Ten/Ten だけが見える、にならない）`);
    if (w === 667) {
      // 触っている・送っているあいだは暗くしない（最後に触ってから約6秒）
      await P.run(4000);
      await P.ev(() => document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 30, clientY: 30 })));
      await P.run(4000);
      ok(!(await P.dark()), "操作を見せているあいだに触っていれば、6秒で決め打ちに暗くしない");
      await P.run(3000);
      ok(await P.dark(), "触るのをやめて約6秒たつと、また暗くなる");
    }
    okErrors(P.errs, `2 ${w}x${h}`);
    await P.close();
  }
});

// ── 3. 暗いまま止めたあいだの画面ロック ──
await section("3. 長押しで暗いまま止めたあいだは画面ロックを保ち、15分で手放す", async () => {
  const P = await openPage({ voice: { cueSec: 0 } });
  await P.click("beginBtn"); await P.run(15000); await P.settle(2);
  ok((await P.wake()).active === 1, "（前提）練習中は画面ロック");
  await P.longPress(); await P.settle(2);
  ok(await P.phase() === "paused" && await P.dark() && (await P.wake()).active === 1, "暗いまま止めたあいだは画面を消さない（長押しで再開できるように）", await P.wake());
  await P.run(14 * 60000); await P.settle(2);
  ok((await P.wake()).active === 1, "14分たってもまだ保つ");
  await P.run(61000); await P.settle(2);
  ok((await P.wake()).active === 0 && await P.phase() === "paused" && await P.dark(), "止めたまま15分たったら手放す（暗いまま・止めたまま）", await P.wake());
  await P.longPress(); await P.settle(2);
  ok(await P.phase() === "running" && (await P.wake()).active === 1, "長押しで再開すると、また画面ロックを取る", await P.wake());
  await P.click("playPauseBtn"); await P.settle(2);
  ok(await P.phase() === "paused" && (await P.wake()).active === 0, "ボタンで（明るく）止めたときは、これまでどおりすぐ手放す", await P.wake());
  okErrors(P.errs, "3");
  await P.close();
});

// ── 4. 日付は始めた日 ──
await section("4. 記録の日付は始めた日（日付をまたいだ練習・落ちた練習の控え）", async () => {
  const t = new Date("2026-11-07T14:52:00Z");   // 日本時間 23:52
  const seed = { "image-streaming:v1": H([{ date: "2026-11-07", ts: t.getTime() - 3600e3, sec: 300, scene: "先の5分", note: "", vivid: null }]) };
  const P = await openPage({ time: t, seed, voice: { cueSec: 0 } });
  await P.click("beginBtn"); await P.run(601000); await P.settle(3);
  const h = await P.hist();
  ok(h.length === 2 && h[1].date === "2026-11-07" && h[1].sec === 600, "23時52分から10分の練習は、始めた日（11月7日）の記録になる", h.map((x) => [x.date, x.sec]));
  ok(await P.text("cycleTxt") === "1 / 10", "その日の合計（5分＋10分）で、11月7日のコマが現像される", await P.text("cycleTxt"));
  ok(/11月7日 15分 ✓/.test(await P.text("doneMeta") || ""), "終了画面は、数えた日の合計を出す（「今日」ではなく「11月7日」）", await P.text("doneMeta"));
  okErrors(P.errs, "4");
  await P.close();
  // 落ちた練習の控え：始めたのは11月7日23時55分、最後の鼓動は11月8日0時3分
  const at = Date.parse("2026-11-07T14:55:00Z"), beat = Date.parse("2026-11-07T15:03:00Z");
  const Q = await openPage({ time: new Date("2026-11-07T15:30:00Z"),
    seed: { "image-streaming:running": H({ id: at, at, beat, sec: 480, paused: false, scene: "引き潮の港", dur: 10, dead: true }) } });
  ok(/^11月7日・/.test(await Q.text("recoverSub") || ""), "「記録しますか」にも、始めた日を出す", await Q.text("recoverSub"));
  await Q.click("recoverYes");
  const hq = await Q.hist();
  ok(hq.length === 1 && hq[0].date === "2026-11-07" && hq[0].sec === 480, "落ちた練習も、始めた日の記録になる", hq);
  await Q.close();
});

// ── 5. 落ちた直後の「はじめる」 ──
await section("5. 落ちた直後に「はじめる」を押しても、前の練習の「記録しますか」は消えない", async () => {
  const now = T0.getTime();
  const run = { id: now - 400000, at: now - 400000, beat: now - 3000, sec: 395, paused: false, scene: "引き潮の港", dur: 10 };
  const P = await openPage({ seed: { "image-streaming:running": H(run) }, voice: { cueSec: 0 } });
  ok(await P.hidden("recoverBox") === true, "（前提）落ちた直後（鼓動から20秒以内）は、別のタブかもしれないので、まだ聞かない");
  await P.click("beginBtn"); await P.run(60000);
  await P.click("endBtn"); await P.settle(3);
  ok(await P.hidden("recoverBox") === true, "練習の終了画面のあいだは聞かない");
  await P.click("saveBtn"); await P.settle(2);
  ok(await P.hidden("recoverBox") === false && /6分/.test(await P.text("recoverQ") || ""), "閉じたあとで、前の練習（6分）を記録するか聞く", await P.text("recoverQ"));
  await P.click("recoverYes");
  const h = await P.hist();
  ok(h.length === 2 && h.some((x) => x.sec === 395 && x.scene === "引き潮の港"), "前の練習も記録できる（これまでは黙って消えていた）", h.map((x) => [x.sec, x.scene]));
  okErrors(P.errs, "5");
  await P.close();
  // 別のタブで続いていた（鼓動がまた届いた）なら聞かない
  const Q = await openPage({ seed: { "image-streaming:running": H(run) }, voice: { cueSec: 0 } });
  await Q.click("beginBtn"); await Q.run(7000);
  await Q.ev((r) => localStorage.setItem("image-streaming:running", JSON.stringify({ ...r, beat: Date.now(), sec: r.sec + 10 })), run);   // 別のタブの鼓動
  await Q.run(53000);
  await Q.click("endBtn"); await Q.settle(3); await Q.click("saveBtn"); await Q.settle(2);
  ok(await Q.hidden("recoverBox") === true, "預かった前の練習の鼓動がまた届いた（別のタブで続いている）なら、横から聞かない");
  await Q.close();
});

// ── 6. 履歴の消去と、終了画面の記録が消えたとき ──
await section("6. 「履歴を消去」は練習の外でだけ・終了画面の記録が同期で消えたら知らせて残し直せる", async () => {
  const P = await openPage({ voice: { cueSec: 0 }, seed: { "image-streaming:v1": H([{ date: "2026-11-06", ts: T0.getTime() - 864e5, sec: 300, scene: "前日" }]) } });
  ok(await P.ev(() => !!document.getElementById("clearBtn")), "はじめる前は「履歴を消去」がある");
  await P.click("beginBtn"); await P.run(1000);
  ok(await P.ev(() => !document.getElementById("clearBtn") && !document.getElementById("clearYes")), "練習中は「履歴を消去」を出さない");
  await P.run(60000); await P.click("endBtn"); await P.settle(2);
  ok(await P.ev(() => !document.getElementById("clearBtn")), "終了画面でも出さない（消すと終了画面が「記録しました」のまま食い違う）");
  await P.click("saveBtn");
  ok(await P.ev(() => !!document.getElementById("clearBtn")), "閉じたら、また出る");
  await P.close();

  const drive = createFakeDrive();
  const A = await openPage({ drive, voice: { cueSec: 0 } });
  const B = await openPage({ drive, voice: { cueSec: 0 } });
  await A.click("beginBtn"); await A.run(60000); await A.click("endBtn"); await A.settle(3);
  const key = String((await A.hist())[0].ts);
  await syncNow(A); await syncNow(B);
  ok((await B.hist()).length === 1, "（前提）B にも届く");
  await B.click("journalToggle");
  await B.page.click(`#jlist .jitem[data-k="${key}"] [data-act="del"]`);
  await B.page.click(`#jlist .jitem[data-k="${key}"] [data-act="delyes"]`);
  await B.run(1000); await syncNow(B);
  await syncNow(A);
  ok((await A.hist()).length === 0 && /消され/.test(await A.text("doneStatus") || "") && await A.text("saveBtn") === "記録する",
    "終了画面の記録がほかの端末で消されたら、そう出し、「記録する」に変わる", [await A.text("doneStatus"), await A.text("saveBtn")]);
  await A.page.fill("#noteEl", "残したいメモ");
  await A.click("saveBtn"); await A.settle(2);
  const ha = await A.hist();
  ok(ha.length === 1 && ha[0].note === "残したいメモ" && String(ha[0].ts) !== key, "「記録する」で、書いたメモごと新しい記録として残る（黙って消えない）", ha);
  okErrors(A.errs, "6 A"); okErrors(B.errs, "6 B");
  await A.close(); await B.close();
});

// ── 7. 欄ごとの同期 ──
await section("7. 欄ごとの同期：片方で鮮明さ、もう片方でメモを直しても両方残る", async () => {
  const drive = createFakeDrive();
  const r = { date: "2026-11-06", ts: T0.getTime() - 864e5, sec: 300, scene: "引き潮の港", note: "", vivid: null };
  const A = await openPage({ drive, seed: { "image-streaming:v1": H([r]) } });
  const B = await openPage({ drive, seed: { "image-streaming:v1": H([r]) } });
  await syncNow(A); await syncNow(B);
  // A: 鮮明さ 4 を付けて同期
  await A.click("journalToggle");
  await A.page.click(`#jlist .jitem[data-k="${r.ts}"] [data-act="edit"]`);
  await A.page.click(`#jlist .jitem[data-k="${r.ts}"] [data-act="rate"][data-v="4"]`);
  await A.page.click(`#jlist .jitem[data-k="${r.ts}"] [data-act="save"]`);
  await A.run(1000); await syncNow(A);
  // B: A の変更をまだ受け取らないまま、あとからメモを書く
  await B.run(60000);
  await B.click("journalToggle");
  await B.page.click(`#jlist .jitem[data-k="${r.ts}"] [data-act="edit"]`);
  await B.page.fill(`#jlist .jitem[data-k="${r.ts}"] textarea[data-f="note"]`, "Bで書いたメモ");
  await B.page.click(`#jlist .jitem[data-k="${r.ts}"] [data-act="save"]`);
  await B.run(1000); await syncNow(B); await syncNow(A);
  const ha = (await A.hist())[0], hb = (await B.hist())[0];
  ok(hb && hb.vivid === 4 && hb.note === "Bで書いたメモ", "B：A の鮮明さも、B のメモも残る（以前は記録まるごと新しい方で、鮮明さが消えた）", hb);
  ok(ha && ha.vivid === 4 && ha.note === "Bで書いたメモ", "A にも両方届く", ha);
  ok(ha && ha.fu && typeof ha.fu.vivid === "number" && typeof ha.fu.note === "number" && ha.fu.note > ha.fu.vivid, "欄ごとの直した時刻（fu）を持つ", ha && ha.fu);
  okErrors(A.errs, "7 A"); okErrors(B.errs, "7 B");
  await A.close(); await B.close();
});

// ── 8. 録音の置き場 ──
await section("8. 記録の無い録音を片付ける・storage.persist・200MBの知らせ・手元の録音は3件まで", async () => {
  const P = await openPage({ voice: { cueSec: 0 }, seed: { "image-streaming:v1": H([{ date: "2026-11-06", ts: 333, sec: 300, scene: "録音あり" }]) } });
  await P.ev(async () => {
    const now = Date.now(), MB = 1048576;
    await new Promise((res, rej) => {
      const rq = indexedDB.open("image-streaming-audio", 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore("clips", { keyPath: "key" }); rq.result.createObjectStore("meta", { keyPath: "key" }); };
      rq.onsuccess = () => {
        const db = rq.result, tx = db.transaction(["clips", "meta"], "readwrite");
        const put = (key, size, at) => { tx.objectStore("clips").put({ key, type: "audio/webm", parts: [new ArrayBuffer(16)] }); tx.objectStore("meta").put({ key, size, sec: 60, type: "audio/webm", at }); };
        put("111", 1 * MB, now - 2 * 864e5);   // 記録の無い古い録音
        put("222", 1 * MB, now - 3600e3);      // 記録の無い、書いたばかりの録音（別のタブなど）
        put("333", 210 * MB, now - 864e5);     // 記録のある録音（大きい）
        tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error);
      };
      rq.onerror = () => rej(rq.error);
    });
    localStorage.setItem("image-streaming:audio", "1");
  });
  await P.page.reload(); await P.run(1000); await P.settle(8);
  const k = await idbKeys(P);
  ok(JSON.stringify(k.meta) === JSON.stringify(["222", "333"]) && JSON.stringify(k.clips) === JSON.stringify(["222", "333"]),
    "記録の無い古い録音は片付け、書いたばかりのものと記録のあるものは残す", k);
  ok(/2件/.test(await P.text("recStore") || ""), "「この端末の録音」の件数にも、片付けたものは数えない", await P.text("recStore"));
  const t1 = await P.toast();
  ok(/録音が 2件・2\d\d\.\dMB/.test(t1), "録音の合計が200MBを超えたら知らせる", t1);
  await P.page.reload(); await P.run(1000); await P.settle(8);
  ok(!(await P.toast()), "知らせは一度だけ（開き直しても、また出さない）", await P.toast());
  okErrors(P.errs, "8 片付け");
  await P.close();

  const Q = await openPage({ voice: { cueSec: 0, rec: true } });
  for (let i = 0; i < 5; i++) {
    await Q.click("beginBtn"); await Q.settle(2); await Q.run(35000);
    await Q.click("endBtn"); await Q.settle(8);
    await Q.click("saveBtn"); await Q.settle(2);
  }
  const u = await Q.ev(() => ({ ...window.__urls }));
  const kq = await idbKeys(Q);
  ok(kq.meta.length === 5, "（前提）5回分の録音を置いた", kq);
  ok(await Q.ev(() => window.__persist) >= 1, "録音を置いたら、保存を「消されにくい」扱いにしてもらう（storage.persist）", await Q.ev(() => window.__persist));
  ok(u.made >= 5 && u.live <= 3, "手元に控える録音（オブジェクトURL）は新しい3件まで", u);
  okErrors(Q.errs, "8 録音");
  await Q.close();
});

// ── 9. 「あと1分」を待っているあいだの一時停止 ──
await section("9. 「あと1分」を待っているあいだに一時停止しても、再開したら伝える", async () => {
  const P = await openPage({ voice: { cueSec: 0 } });
  await P.ev(() => document.querySelector('#lengthSeg .seg[data-d="3"]').click());
  await P.click("beginBtn"); await P.run(118000);
  await P.click("testBtn");                      // 案内の声が長く続いている（「あと1分」は読み終わるまで待つ）
  await P.run(3000);
  ok(!(await P.texts()).some((x) => x.startsWith("あと1分")), "（前提）案内の声が続いているので、まだ伝えていない");
  await P.click("playPauseBtn"); await P.run(4000);
  await P.click("playPauseBtn"); await P.run(15000);
  const t = (await P.texts()).filter((x) => x.startsWith("あと"));
  ok(t.length === 1 && /^あと1分/.test(t[0]), "再開したあとで「あと1分です」を伝える（1回だけ）", t);
  okErrors(P.errs, "9");
  await P.close();
});

// ── 10. 読み上げ（スクリーンリーダー） ──
await section("10. スイッチ・選択ボタン・暗い画面の説明・「記録しますか」へのフォーカス", async () => {
  const P = await openPage({ voice: { cueSec: 0 } });
  const a = await P.ev(() => ({
    sw: ["toggleBtn", "dimBtn", "recBtn"].map((id) => { const b = document.getElementById(id); return b.getAttribute("role") + ":" + b.getAttribute("aria-checked"); }),
    len: [...document.querySelectorAll("#lengthSeg .seg")].map((b) => b.getAttribute("aria-pressed")).join(","),
    cue: [...document.querySelectorAll("#cueSeg .seg")].map((b) => b.getAttribute("aria-pressed")).join(","),
    vp: [...document.querySelectorAll(".vp")].map((b) => b.getAttribute("aria-pressed")).join(","),
    dr: document.getElementById("darkroom").getAttribute("role") + ":" + document.getElementById("darkroom").getAttribute("aria-label")
  }));
  ok(JSON.stringify(a.sw) === JSON.stringify(["switch:true", "switch:true", "switch:false"]), "音声ガイド・暗くする・録音は role=switch と aria-checked", a.sw);
  await P.click("dimBtn");
  ok(await P.ev(() => document.getElementById("dimBtn").getAttribute("aria-checked")) === "false", "切り替えると aria-checked も変わる");
  await P.click("dimBtn");
  ok(a.len === "false,false,true" && a.cue === "true,false,false" && a.vp === "false,true,false", "長さ・問いかけの間隔・声の調子のボタンは aria-pressed", a);
  ok(/^button:練習中/.test(a.dr), "暗い画面には役割と説明がある", a.dr);
  await P.click("beginBtn"); await P.run(15000);
  await P.longPress();
  ok(/^一時停止中/.test(await P.ev(() => document.getElementById("darkroom").getAttribute("aria-label")) || ""), "暗い画面の説明は、止めているときは「一時停止中・長押しで再開」", await P.ev(() => document.getElementById("darkroom").getAttribute("aria-label")));
  okErrors(P.errs, "10");
  await P.close();
  const run = { id: 111, at: T0.getTime() - 3600e3, beat: T0.getTime() - 3000e3, sec: 300, paused: true, scene: "引き潮の港", dur: 10, dead: true };
  const Q = await openPage({ seed: { "image-streaming:running": H(run) } });
  ok(await Q.hidden("recoverBox") === false && await Q.ev(() => document.activeElement && document.activeElement.id) === "recoverBox", "「前回の練習を記録しますか」が出たら、そこへフォーカスを移す",
    await Q.ev(() => document.activeElement && document.activeElement.id));
  await Q.close();
});

// ── UX ──
await section("UX a. 練習の長さを覚える", async () => {
  const P = await openPage({ voice: { cueSec: 0 } });
  await P.ev(() => document.querySelector('#lengthSeg .seg[data-d="5"]').click());
  await P.page.reload(); await P.run(4000);
  ok(await P.ev(() => /on/.test(document.querySelector('#lengthSeg .seg[data-d="5"]').className)), "開き直しても「5分」が選ばれている");
  await P.click("beginBtn"); await P.run(1000);
  ok(/^4:5\d$/.test(await P.text("clock") || ""), "その長さで始まる", await P.text("clock"));
  await P.close();
});
await section("UX b. はじめる前の Space で始めない・暗いときの Space は暗いまま止める", async () => {
  const P = await openPage({ voice: { cueSec: 0 } });
  await P.page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await P.page.keyboard.press("Space"); await P.run(500);
  ok(await P.phase() === "idle", "はじめる前に Space を押しても練習は始まらない（ページ送りのため）", await P.phase());
  await P.click("beginBtn"); await P.run(15000); await P.settle(3);
  // 暗くなるのは、読み上げ（偽物）の終わりなどを待ってから。負荷が高いと遅れるので、暗くなるまで少しずつ進める
  for (let i = 0; i < 10 && !(await P.dark()); i++) { await P.run(1000); await P.settle(2); }
  ok(await P.dark(), "（前提）暗い");
  await P.page.keyboard.press("Space"); await P.run(500);
  ok(await P.phase() === "paused" && await P.dark(), "暗いときの Space は、長押しと同じく暗いまま止める", [await P.phase(), await P.dark()]);
  await P.page.keyboard.press("Space"); await P.run(500);
  ok(await P.phase() === "running", "もう一度 Space で再開する");
  okErrors(P.errs, "UX b");
  await P.close();
});
await section("UX c. 分は切り捨て（Ten/Ten と合わせる）", async () => {
  const P = await openPage({ seed: { "image-streaming:v1": H([{ date: "2026-11-06", ts: T0.getTime() - 864e5, sec: 585, scene: "九分四十五秒" }]),
    "image-streaming:running": H({ id: 5, at: T0.getTime() - 3600e3, beat: T0.getTime() - 3000e3, sec: 585, paused: false, scene: "x", dur: 10, dead: true }) } });
  ok(/（9分）/.test(await P.text("recoverQ") || ""), "9分45秒の控えは「9分」（以前は「10分」なのに Ten/Ten では数えなかった）", await P.text("recoverQ"));
  await P.click("journalToggle");
  ok(/· 9分/.test(await P.ev(() => document.querySelector("#jlist .jdate").textContent)), "一覧でも「9分」", await P.ev(() => document.querySelector("#jlist .jdate").textContent));
  await P.close();
});
await section("UX d. 画面ロックが取れないときは知らせる", async () => {
  for (const mode of ["deny", "none"]) {
    const P = await openPage({ voice: { cueSec: 0 }, wake: mode });
    await P.click("beginBtn"); await P.settle(3);
    ok((await P.hidden("wakeNote")) === false && /画面が自動で消える/.test(await P.text("wakeNote") || ""), `画面ロックが${mode === "deny" ? "断られた" : "使えない"}ら、練習中の画面に知らせる`, await P.text("wakeNote"));
    await P.click("endBtn"); await P.settle(2);
    ok(await P.hidden("wakeNote") === true, "終えたら消える");
    await P.close();
  }
  const Q = await openPage({ voice: { cueSec: 0 } });
  await Q.click("beginBtn"); await Q.settle(3);
  ok(await Q.hidden("wakeNote") === true, "取れたときは何も出さない");
  await Q.close();
});
await section("UX e. 容量いっぱいの知らせを、暗い画面の上に出さない", async () => {
  const P = await openPage({ voice: { cueSec: 0 } });
  await P.click("beginBtn"); await P.run(15000); await P.settle(3);
  // 暗くなるのは、読み上げ（偽物）の終わりなどを待ってから。負荷が高いと遅れるので、暗くなるまで少しずつ進める
  for (let i = 0; i < 10 && !(await P.dark()); i++) { await P.run(1000); await P.settle(2); }
  ok(await P.dark(), "（前提）暗い");
  await P.ev(() => { window.__full = true; });
  await P.run(6000); await P.settle(2);
  ok(!(await P.toast()), "暗いあいだは、明るい知らせを出さない（預かる）", await P.toast());
  await P.shortTap(); await P.run(200);
  ok(!(await P.toast()), "数秒だけ操作を見せる（触った）ときも出さない");
  await P.click("playPauseBtn"); await P.run(200);
  ok(/保存容量がいっぱい/.test(await P.toast()), "止めて明るく戻ったら、預かった知らせを出す", await P.toast());
  await P.ev(() => { window.__full = false; });
  okErrors(P.errs, "UX e");
  await P.close();
});

await browser.close();
await srv.close();
done();
