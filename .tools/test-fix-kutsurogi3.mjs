/* くつろぎ（autogenic.html）v54 の見直しの検証（配布には不要。要 playwright）
     node .tools/test-fix-kutsurogi3.mjs              … いまのファイルで
     node .tools/test-fix-kutsurogi3.mjs --root=DIR   … 別の場所のファイルで（直す前の版との比べ用）

   見ること（どれも、直す前の版では失敗する）:
     [1]  誘導文の編集：書き出したあとに打った文字が、別の行に入らない・消えない
     [2]  タッチで進む：一時停止を音と声で知らせ、画面に触れると再開。「やめる」は2回押し
     [3]  背景の音：入口へは mix で頼む（iPhone でも音量が効く）。音タブの音楽は差し替えない。
          単体で開いて音量を変えられない端末では、そう伝える
     [4]  「はじめる」のダブルタップで導入を飛ばさない
     [5]  2つ開いていても、片方の記録をもう片方が古い一覧で消さない
     [6]  横向き・背の低い画面で、練習中の操作ボタンが画面に収まる
     [7]  姿勢：導入の1行目が既定のままなら、ほかの行の沈黙を変えていても置き換える
     [8]  みじかく：公式は1回りだけ。触るまでの時間は残さない。ボタンの分数
     [9]  記録の長さに、端末が止まっていた時間を入れない。沈黙のあいだに止まっていても気づく
     [10] 読み上げ機能のための印（aria-pressed・role=status）と、小さなボタンの高さ
     [Ua] 「記録しない」は2回押し
     [Ub] 3分以上の練習・止まっていたあと・落ちたあとの復帰（3分以上）は、消去動作を全部
     [Uc] 消去動作の始まりで画面が見えていなければ、一度だけ声で知らせる
     [Ue] 中断が10分で音と声でも知らせ、30分で画面ロックを外す

   読み上げ・画面の見え方・画面ロックは test-fix-kutsurogi2.mjs と同じ偽物。時計は page.clock で進める。 */
import fs from "node:fs";
import path from "node:path";
import { startServer, launch, newDevice, makeChecker, collectErrors, ROOT } from "./lib/harness.mjs";

const rootArg = process.argv.find((a) => a.startsWith("--root="));
const root = rootArg ? path.resolve(rootArg.slice(7)) : ROOT;
const T0 = new Date("2026-10-10T20:00:00Z");   // 日本時間 2026-10-11 05:00
const DAY = 864e5;
const BASE_CFG = { gateSeen: true, steps: { heavy: true }, hand: "R", pace: 1, bg: "", bgVol: 18, wake: true,
                   advance: "time", stageMin: 0, vPitch: 1, vRate: 0.9 };
const CX = { c0: "それでは、体を戻していきます", c1: "両手を、ぎゅっと握って、ひらきます", c2: "しっかり曲げて、伸ばします",
             c3: "大きく、伸びをしてください", c4: "深く息を吸って、ゆっくり吐きます", c5: "ゆっくり、目を開けてください" };
const BASE_INTRO = [
  { say: "楽な姿勢をとってください。椅子に浅く腰かけるか、あお向けに寝てもかまいません。", hold: 6 },
  { say: "手足は、組まずに、軽くひらいておきます。", hold: 5 },
  { say: "目を、そっと閉じてください。", hold: 6, g: "🌙" },
  { say: "何度か、ゆっくり息を吐きます。", hold: 10, g: "🌬" },
  { say: "息は、整えようとしなくて大丈夫です。体にまかせます。", hold: 6 }
];

/* ページより先に動かす偽物（test-fix-kutsurogi2.mjs と同じもの＋合図音の数・音量の効かない端末） */
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
  W.active = () => W.sentinels.filter((s) => !s.released).length;
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
  window.prompt = function () { return null; };
  window.confirm = function () { return true; };
  // 合図音（オシレーター）を鳴らした回数
  window.__tones = 0;
  try {
    const A = window.AudioContext || window.webkitAudioContext;
    const oc = A.prototype.createOscillator;
    A.prototype.createOscillator = function () { window.__tones++; return oc.apply(this, arguments); };
  } catch (e) {}
  // iPhone のように <audio> の音量をアプリから変えられない端末
  if (arg.noVol) Object.defineProperty(HTMLMediaElement.prototype, "volume", { configurable: true, get() { return 1; }, set(v) {} });
  // 記録カードが新しい記録のために開いたとき、そのときの様子を残す
  window.__cards = [];
  new MutationObserver((ms) => {
    const m = ms.find((x) => x.target.id === "recCard" && x.target.getAttribute("data-ts"));
    if (!m) return;
    const run = document.getElementById("run");
    window.__cards.push({ at: Date.now(), vis, ts: m.target.getAttribute("data-ts"), run: run ? run.style.display : "", texts: T.log.map((x) => x.text) });
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-ts"] });
}

/* くつろぎを入口の代わりに埋め込む小さなページ（入口の音の命令を記録して、状態を返す） */
const WRAP = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="f" src="autogenic.html" style="width:390px;height:760px;border:0"></iframe>
<script>
window.__msgs=[]; window.__state={id:null,playing:false};
function send(){ document.getElementById("f").contentWindow.postMessage({nkSoundState:window.__state},location.origin); }
addEventListener("message",function(e){
  if(!e.data||!e.data.nkSound)return;
  var c=e.data.nkSound; window.__msgs.push(c);
  if(c.cmd==="mix")window.__state={id:c.parts&&c.parts.length===1?c.parts[0].id:"mix",playing:true};
  if(c.cmd==="play")window.__state={id:c.id,playing:true};
  if(c.cmd==="stop")window.__state={id:null,playing:false};
  send();
});
window.__setState=function(s){ window.__state=s; send(); };
</script>`;

const srv = await startServer(root);
const browser = await launch();
const { ok, done } = makeChecker("くつろぎ v54 の見直し");
console.log("対象: " + path.join(root, "autogenic.html"));

async function openPage(opts = {}) {
  const seed = { "autogenic:cfg": JSON.stringify({ ...BASE_CFG, ...(opts.cfg || {}) }) };
  if (opts.script) seed["autogenic:script"] = JSON.stringify(opts.script);
  if (opts.hist) seed["autogenic:v1"] = JSON.stringify(opts.hist);
  const context = await newDevice(browser, { contextOptions: { timezoneId: "Asia/Tokyo", hasTouch: !!opts.touch, acceptDownloads: true,
                                                               viewport: opts.viewport || { width: 390, height: 844 } } });
  await context.addInitScript(INIT, { seed, noVol: !!opts.noVol });
  await context.route("**/__wrap.html", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: WRAP }));
  const page = await context.newPage();
  const errs = collectErrors(page);
  await page.clock.install({ time: T0 });
  await page.goto(srv.url + (opts.wrap ? "__wrap.html" : "autogenic.html"));
  await page.clock.pauseAt(new Date(T0.getTime() + 15000));
  await page.clock.runFor(4000);
  const F = opts.wrap ? page.frames().find((f) => /autogenic\.html/.test(f.url())) : page.mainFrame();
  const P = {
    page, context, errs, F,
    run: (ms) => page.clock.runFor(ms),
    click: (id) => F.evaluate((id) => document.getElementById(id).click(), id),
    q: (sel) => F.evaluate((sel) => { const e = document.querySelector(sel); if (!e) throw new Error("見つかりません: " + sel); e.click(); }, sel),
    text: (sel) => F.evaluate((sel) => { const e = document.querySelector(sel); return e ? e.textContent : null; }, sel),
    ev: (fn, a) => F.evaluate(fn, a),
    texts: () => F.evaluate(() => window.__tts.log.map((x) => x.text)),
    count: async (sub) => (await P.texts()).filter((t) => t.includes(sub)).length,
    hist: () => F.evaluate(() => JSON.parse(localStorage.getItem("autogenic:v1") || "[]")),
    st: () => F.evaluate(() => {
      const g = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
      const c = document.getElementById("recCard");
      return { stage: g("stage"), line: g("line"), toast: document.getElementById("toast").style.display === "block" ? g("toast") : "",
               stopBtn: g("stopBtn"), home: document.getElementById("home").style.display, run: document.getElementById("run").style.display,
               resume: document.getElementById("resume").style.display, card: c && c.style.display === "block" ? c.getAttribute("data-ts") : "",
               draft: localStorage.getItem("autogenic:recDraft"), wake: window.__wl.active(), tones: window.__tones };
    }),
    hide: (mute) => F.evaluate((m) => { if (m) window.__tts.setMuted(true); window.__setVis("hidden"); }, !!mute),
    show: () => F.evaluate(() => { window.__tts.setMuted(false); window.__setVis("visible"); }),
    center: (id) => F.evaluate((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id),
    touch: async (id) => { const b = await P.center(id); await page.touchscreen.tap(b.x, b.y); },
    until: async (sub, max = 240000, stepMs = 200) => {
      for (let t = 0; t < max; t += stepMs) { if ((await P.count(sub)) > 0) return true; await P.run(stepMs); }
      return false;
    },
    untilCard: async (max = 900000, stepMs = 500) => {
      for (let t = 0; t < max; t += stepMs) {
        const s = await P.st();
        if (s.card && s.run !== "block") return { ok: true, s };
        await P.run(stepMs);
      }
      return { ok: false, s: await P.st() };
    },
    draft: () => F.evaluate(() => JSON.parse(localStorage.getItem("autogenic:recDraft") || "null")),
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
const quickEst = async (P) => { const m = /およそ (\d+):(\d\d)/.exec(await P.text("#quickNote")); return m ? (+m[1]) * 60 + (+m[2]) : NaN; };

try {
  /* ── 1. 誘導文の編集：書き出しのあとに打った文字 ── */
  await section("[1] 書き出したあとに打った文字が、狙った行に入る", async (use) => {
    const P = use(await openPage());
    await P.click("edOpen");
    // 消去動作の2行目を打ち直すつもりで空にしてから、書き出す
    await P.page.fill('#edBody input.say[data-cs="1"][data-li="1"]', "");
    await P.run(800);
    const [dl] = await Promise.all([P.page.waitForEvent("download"), P.click("edExport")]);
    const o = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
    ok(o.cancel.length === 5 && o.cancel.every((l) => l.say), "書き出したファイルには空行を入れない", o.cancel.map((l) => l.say));
    await P.run(200);
    await P.page.fill('#edBody input.say[data-cs="1"][data-li="1"]', "両手を、ぎゅっと握ります。");
    await P.run(800);
    await P.click("edClose");
    await P.run(200);
    const sc = await P.ev(() => JSON.parse(localStorage.getItem("autogenic:script") || "null"));
    const c = (sc && sc.cancel || []).map((l) => l.say);
    ok(c.length === 6 && c[1] === "両手を、ぎゅっと握ります。" && /両腕を、しっかり曲げて/.test(c[2]),
       "打ち直した文は2行目に入り、3行目（腕を曲げて伸ばす）は消えない（以前は3行目が上書きされて消えた）", c);
    // 行を足してから書き出し、その行に打つ
    await P.click("edOpen");
    await P.ev(() => document.querySelector('#edBody [data-add="2"]').click());
    await P.run(100);
    const n = await P.ev(() => document.querySelectorAll('#edBody input.say[data-si="2"]').length);
    const [dl2] = await Promise.all([P.page.waitForEvent("download"), P.click("edExport")]);
    await dl2.path();
    await P.run(200);
    await P.page.fill(`#edBody input.say[data-si="2"][data-li="${n - 1}"]`, "両肩が、重たい。");
    await P.run(800);
    await P.click("edClose"); await P.run(200);
    const sc2 = await P.ev(() => JSON.parse(localStorage.getItem("autogenic:script") || "null"));
    const heavy = sc2 && Array.isArray(sc2.steps) ? sc2.steps.find((s) => s.id === "heavy") : null;
    ok(heavy && heavy.lines[heavy.lines.length - 1].say === "両肩が、重たい。", "足した行に打った文が残る（以前は黙って捨てられた）", heavy && heavy.lines.map((l) => l.say));
    ok(P.errs.length === 0, "ページのエラーが無い", P.errs);
  });

  /* ── 2. タッチで進む：一時停止・やめる ── */
  await section("[2a] タッチで進む：指が「一時停止」に当たったら、音と声で知らせ、画面に触れると再開する", async (use) => {
    const P = use(await openPage({ touch: true, cfg: { advance: "tap" } }));
    await P.click("startBtn"); await P.run(3000);
    const s0 = await P.st(), n0 = (await P.texts()).length;
    await P.touch("pauseBtn"); await P.run(500);
    let s = await P.st();
    const said = (await P.texts()).slice(n0);
    ok(s.stage === "中断中" && said.some((t) => /中断しました/.test(t)) && said.some((t) => /画面に触れると続けます/.test(t)),
       "「中断しました。画面に触れると続けます」と言う", said);
    ok(s.tones > s0.tones, "合図の音も鳴らす", { before: s0.tones, after: s.tones });
    ok(/画面のどこかに触れる/.test(await P.text("#pauseNote")), "画面の説明にも、触れると再開できることを書く", await P.text("#pauseNote"));
    await P.run(1500);
    const n1 = (await P.texts()).length;
    await P.touch("line"); await P.run(500);
    s = await P.st();
    const after = (await P.texts()).slice(n1);
    ok(s.stage === "導入" && after[0] === "楽な姿勢をとってください", "画面（ボタン以外）に触れると、中断した行から再開する（以前は何も起きなかった）", { stage: s.stage, after });
    ok(P.errs.length === 0, "ページのエラーが無い", P.errs);
  });
  await section("[2b] タッチで進む：「やめる」は2回押し（1回目は声で確かめ、押さなければ続ける）", async (use) => {
    const P = use(await openPage({ touch: true, cfg: { advance: "tap" } }));
    await P.click("startBtn"); await P.run(3000);
    const n0 = (await P.texts()).length;
    await P.touch("stopBtn"); await P.run(300);
    let s = await P.st();
    ok(s.stage === "導入" && /もう一度押すと、消去動作をして終わります/.test(s.stopBtn), "1回目では終わらず、ボタンの字が変わる（以前は1回で消去動作へ）", s);
    ok((await P.texts()).slice(n0).some((t) => /もう一度押すと、消去動作をして終わります/.test(t)), "声でも知らせる");
    await P.run(5000);
    s = await P.st();
    ok(s.stage === "導入" && /^やめる/.test(s.stopBtn) && (await P.count("楽な姿勢をとってください")) === 2, "2回目が無ければ、その行をはじめから読み直して続ける", { s, n: await P.count("楽な姿勢をとってください") });
    await P.touch("stopBtn"); await P.run(1000); await P.touch("stopBtn"); await P.run(300);
    s = await P.st();
    ok(s.stage === "消去動作", "間をおいた2回目で、消去動作へ", s.stage);
  });
  await section("[2c] 時間で進むときの「やめる」は、これまでどおり1回", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn"); await P.run(3000);
    await P.click("stopBtn"); await P.run(300);
    ok((await P.st()).stage === "消去動作", "1回で消去動作へ");
  });

  /* ── 3. 背景の音 ── */
  await section("[3a] 入口の中では、背景の音を mix で頼む（入口が音量を焼き込む）", async (use) => {
    const P = use(await openPage({ wrap: true, cfg: { bg: "rain", bgVol: 18 } }));
    await P.click("startBtn"); await P.run(1000);
    let msgs = await P.page.evaluate(() => window.__msgs.slice());
    const m = msgs.find((x) => x.cmd === "mix" || x.cmd === "play");
    ok(m && m.cmd === "mix" && Array.isArray(m.parts) && m.parts.length === 1 && m.parts[0].id === "rain" && Math.abs(m.vol - 0.18) < 1e-9,
       "{cmd:mix, parts:[{id:rain}], vol:0.18}（以前は play で、iPhone では音量が効かなかった）", m);
    await P.click("stopBtn"); await P.untilCard();
    msgs = await P.page.evaluate(() => window.__msgs.slice());
    ok(msgs[msgs.length - 1].cmd === "stop", "終わったら止める", msgs.map((x) => x.cmd));
  });
  await section("[3b] 音タブで別の音楽が鳴っていたら、差し替えずにそのまま", async (use) => {
    const P = use(await openPage({ wrap: true, cfg: { bg: "rain" } }));
    await P.page.evaluate(() => window.__setState({ id: "track-1", playing: true }));
    await P.run(200);
    await P.click("startBtn"); await P.run(500);
    let msgs = await P.page.evaluate(() => window.__msgs.filter((x) => x.cmd !== "state"));
    const s = await P.st();
    ok(msgs.length === 0, "背景の音を頼まない（音楽を止めない）", msgs);
    ok(/音タブで流している音を、そのまま流します/.test(s.toast), "そう知らせる", s.toast);
    await P.click("stopBtn"); await P.untilCard();
    msgs = await P.page.evaluate(() => window.__msgs.filter((x) => x.cmd !== "state"));
    ok(msgs.length === 0, "終わっても、音楽を止めない", msgs);
  });
  await section("[3c] 単体で開いていて音量を変えられない端末では、音量の説明を変える", async (use) => {
    const P = use(await openPage({ noVol: true }));
    ok(/大きさを変えられません/.test(await P.text("#bgNote")), "「大きさを変えられません（大きめに鳴ります）」", await P.text("#bgNote"));
    const Q = await openPage();
    ok(/控えめにしてあります/.test(await Q.text("#bgNote")), "変えられる端末では、これまでどおり");
    await Q.close();
  });

  /* ── 4. ダブルタップ ── */
  await section("[4] 「はじめる」のダブルタップで、導入を飛ばさない", async (use) => {
    const P = use(await openPage({ touch: true, cfg: { advance: "tap" } }));
    const b = await P.center("startBtn");
    await P.page.touchscreen.tap(b.x, b.y); await P.run(150);
    await P.page.touchscreen.tap(b.x, b.y); await P.run(1500);
    ok((await P.st()).stage === "導入", "導入のまま（以前は2回目のタッチで背景公式へ飛んだ）", (await P.st()).stage);
    await P.run(1000);
    await P.touch("line"); await P.run(300);
    ok((await P.st()).stage === "背景公式", "少しあとのタッチは、これまでどおり次の段階へ");
  });

  /* ── 5. 2つ開いている ── */
  await section("[5] 2つ開いていても、片方の記録を消さない", async (use) => {
    const R1 = { ts: T0.getTime() - DAY, date: "2026-10-10", sec: 300, steps: ["導入", "背景公式", "第1公式 — 重感"], stepIds: ["intro", "calm", "heavy"], level: 1, odd: false, feel: { heavy: 1 } };
    const A = use(await openPage({ hist: [R1] }));
    const B = await A.context.newPage();
    await B.goto(srv.url + "autogenic.html");
    await A.run(3000);
    await A.click("quickBtn");
    await A.untilCard();
    await A.q("#rcSave"); await A.run(300);
    ok((await A.hist()).length === 2, "A で記録した（2件）");
    const bRows = await B.evaluate(() => document.querySelectorAll("#recs .rec").length);
    ok(bRows === 2, "B の一覧にも、A の記録が出る（storage で読み直す）", bRows);
    await B.evaluate((ts) => document.querySelector('#recs [data-edit="' + ts + '"]').click(), R1.ts);
    await B.fill("#rcNote", "B で直した");
    await B.evaluate(() => document.getElementById("rcSave").click());
    await A.run(300);
    let h = await A.hist();
    ok(h.length === 2 && h.find((x) => x.ts === R1.ts).note === "B で直した", "B が古い記録を直しても、A の記録は消えない（以前は1件に戻った）", h.map((x) => [x.ts, x.note]));
    // A で消した記録を、B が書き戻さない
    await A.q(`#recs [data-edit="${R1.ts}"]`); await A.q("#rcDel"); await A.run(1000); await A.q("#rcDel"); await A.run(300);
    const newTs = (await A.hist())[0].ts;
    await B.evaluate((ts) => document.querySelector('#recs [data-edit="' + ts + '"]').click(), newTs);
    await B.fill("#rcNote", "メモ");
    await B.evaluate(() => document.getElementById("rcSave").click());
    await A.run(300);
    h = await A.hist();
    ok(h.length === 1 && h[0].ts === newTs && h[0].note === "メモ", "A で消した記録は、B が書いても戻らない", h.map((x) => x.ts));
  });

  /* ── 6. 背の低い画面 ── */
  await section("[6] 横向き（568×320）で、練習中の操作ボタンが画面に収まる", async (use) => {
    const P = use(await openPage({ viewport: { width: 568, height: 320 } }));
    await P.click("startBtn"); await P.run(2000);
    let g = await P.ev(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return { head: getComputedStyle(document.querySelector("header")).display, vh: innerHeight, pause: r("pauseBtn"), stop: r("stopBtn") };
    });
    ok(g.head === "none", "練習中は見出しを隠す", g.head);
    ok(g.pause.top >= 0 && g.pause.bottom <= g.vh && g.stop.bottom <= g.vh, "「一時停止」「やめる」が画面の中にある（以前は「やめる」が画面の外だった）", g);
    await P.click("stopBtn"); await P.run(9000);   // いちばん長い消去動作の行
    g = await P.ev(() => ({ vh: innerHeight, stop: document.getElementById("stopBtn").getBoundingClientRect(), line: document.getElementById("line").textContent }));
    ok(g.stop.bottom <= g.vh && g.stop.top >= 0, "長い行（3行）のときも「やめる」が画面の中", g);
    await P.untilCard();
    ok((await P.ev(() => getComputedStyle(document.querySelector("header")).display)) !== "none", "終わったら見出しを戻す");
  });

  /* ── 7. 姿勢 ── */
  await section("[7] 導入の1行目が既定のままなら、ほかの行を直していても1行目を置き換える", async (use) => {
    const intro = BASE_INTRO.map((l, i) => (i === 3 ? { ...l, hold: 15 } : l));
    const steps = [{ id: "intro", name: "導入", always: true, lines: intro },
                   { id: "calm", name: "背景公式", always: true, lines: [{ say: "気持ちが、落ち着いている。", hold: 3 }] },
                   { id: "heavy", name: "第1公式 — 重感", def: true, hand: true, lines: [{ say: "%A%腕が、重たい。", hold: 3 }] }];
    const P = use(await openPage({ cfg: { posture: "supine" }, script: { steps, cancel: null, updatedAt: 1 } }));
    await P.click("startBtn");
    await P.until("目を、そっと閉じてください");
    const t = await P.texts();
    ok(t[0] === "あお向けに寝て、楽な姿勢をとってください" && t[2] === "手足は、組まずに、軽くひらいておきます" && !t.some((x) => /椅子に浅く腰かけるか/.test(x)),
       "姿勢の案内のあとに「椅子に浅く腰かけるか、あお向けに寝ても…」を読まない（以前は沈黙を変えただけで両方読んだ）", t.slice(0, 5));
  });

  /* ── 8. みじかく ── */
  await section("[8a] みじかく：「間＝短め」でも公式は1回りだけ", async (use) => {
    const P = use(await openPage({ cfg: { pace: 0.7 } }));
    const q07 = await quickEst(P);
    await P.q('#paceSeg [data-p="1"]');
    const q10 = await quickEst(P);
    ok(q07 < q10, "短めの方が短い（以前は短めの方が長かった）", { q07, q10 });
    await P.q('#paceSeg [data-p="0.7"]');
    await P.click("quickBtn");
    await P.untilCard();
    ok((await P.count("重たい")) === 6, "重感は台本の1回り（6行）だけ（以前は2回り12行）", await P.count("重たい"));
  });
  await section("[8b] みじかく＋タッチ：触るまでの時間を残さない", async (use) => {
    const P = use(await openPage({ cfg: { advance: "tap" } }));
    await P.click("quickBtn");
    await P.untilCard();
    await P.q("#rcSave");
    const x = (await P.hist())[0];
    ok(x && !x.tap && !/タッチまで/.test(await P.text("#recs .rec")), "記録に tap が無く、一覧に「タッチまで（上限）」が出ない", x);
  });
  await section("[8c] みじかくのボタンの分数", async (use) => {
    const P = use(await openPage());
    ok(/約2〜3分/.test(await P.text("#quickBtn")), "重感だけなら「約2〜3分」", await P.text("#quickBtn"));
    const Q = await openPage({ cfg: { steps: { heavy: true, warm: true, breath: true }, pace: 1.4 } });
    const lbl = await Q.text("#quickBtn"), est = await quickEst(Q);
    ok(!/2〜3分/.test(lbl) && new RegExp("約" + Math.round(est / 60) + "分").test(lbl), "公式が多いときは見積りの分数を出す", { lbl, est });
    await Q.close();
  });

  /* ── 9. 記録の長さ・沈黙のあいだに止まる ── */
  await section("[9a] 端末が20分止まっていた時間は、記録の長さに入れない", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn"); await P.run(30000);
    await P.hide(true);
    await P.page.clock.fastForward(20 * 60000);
    await P.show();
    const r = await P.untilCard();
    const d = await P.draft();
    ok(r.ok && d && d.sec < 300, "記録は数分（以前は23分以上）", d && d.sec);
  });
  await section("[9b] 沈黙のあいだに端末が止まっても、気づいて消去動作へ", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn");
    await P.until("目を、そっと閉じてください");
    await P.run(2500);                         // 読み終わって、沈黙の中
    await P.hide(false);
    await P.page.clock.fastForward(150000);
    await P.show(); await P.run(300);
    const s = await P.st();
    ok(s.stage === "消去動作" && /止まっていました/.test(s.toast) && (await P.count("何度か、ゆっくり息を吐きます")) === 0,
       "次の行へは進まず、消去動作に移って知らせる（以前は何事もなく次の行へ進んだ）", { stage: s.stage, toast: s.toast });
    await P.untilCard(); await P.q("#rcSave");
    const x = (await P.hist())[0];
    ok(x.cancelWhy === "stall" && x.cancelEnd === "full" && x.sec < 200, "印：最後まで（止まっていた）。止まっていた時間は数えない", x);
  });

  /* ── 10. 読み上げ機能のための印 ── */
  await section("[10] aria-pressed・role=status・小さなボタンの高さ", async (use) => {
    const P = use(await openPage({ hist: [{ ts: T0.getTime() - DAY, sec: 300, steps: ["導入"], stepIds: ["intro", "calm", "heavy"], level: null, odd: false }] }));
    let a = await P.ev(() => [...document.querySelectorAll("#postSeg button")].map((b) => b.getAttribute("aria-pressed")));
    ok(JSON.stringify(a) === '["true","false","false","false"]', "姿勢の選んでいる項目に aria-pressed=true", a);
    await P.q('#postSeg [data-po="chair"]');
    a = await P.ev(() => [...document.querySelectorAll("#postSeg button")].map((b) => b.getAttribute("aria-pressed")));
    ok(JSON.stringify(a) === '["false","false","true","false"]', "選び直すと付け替える", a);
    const other = await P.ev(() => ["handSeg", "paceSeg", "advSeg", "stageMinSeg", "bgSeg"].every((id) => [...document.getElementById(id).children].some((b) => b.getAttribute("aria-pressed") === "true")));
    ok(other, "利き手・間・進み方・段階の長さ・背景の音にも付く");
    const t = await P.ev(() => { const e = document.getElementById("toast"); return [e.getAttribute("role"), e.getAttribute("aria-live")]; });
    ok(t[0] === "status" && t[1] === "polite", "知らせ（toast）は role=status・aria-live=polite", t);
    const h = await P.ev(() => document.querySelector('#recs [data-edit]').getBoundingClientRect().height);
    ok(h >= 36, "「直す」などの小さなボタンも36px 以上", h);
  });

  /* ── U. 気になった点 ── */
  await section("[Ua] 「記録しない」は2回押し", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn"); await P.untilCard();
    await P.q("#rcSkip"); await P.run(100);
    let s = await P.st();
    ok(s.card && /もう一度押すと記録しません/.test(await P.text("#rcSkip")), "1回目では消さず、ボタンの字が変わる（以前は1回で消えた）", s);
    await P.q("#rcSkip"); await P.run(100);
    ok((await P.st()).card, "すぐの2回目（ダブルタップ）では消さない");
    await P.run(5000);
    ok(/^記録しない$/.test(await P.text("#rcSkip")), "4秒たつと元に戻る");
    await P.q("#rcSkip"); await P.run(1000); await P.q("#rcSkip"); await P.run(100);
    s = await P.st();
    ok(!s.card && !s.draft && (await P.hist()).length === 0, "間をおいた2回目で、記録せずに閉じる", s);
  });
  await section("[Ub1] 3分以上練習してから「やめる」→ 消去動作は全部", async (use) => {
    const P = use(await openPage({ cfg: { stageMin: 3 } }));
    await P.click("startBtn"); await P.run(200000);
    ok((await P.st()).stage !== "消去動作", "まだ練習の段階");
    const n0 = (await P.texts()).length;
    await P.click("stopBtn");
    await P.untilCard();
    const t = (await P.texts()).slice(n0);
    ok(t.some((x) => x.includes(CX.c3)) && t.some((x) => x.includes(CX.c4)), "伸び・深呼吸も読む（以前は短縮版）", t);
    await P.q("#rcSave");
    const x = (await P.hist())[0];
    ok(x.cancelEnd === "full" && x.cancelWhy === "stop", "印：最後まで（途中でやめた）", x);
  });
  await section("[Ub2] 始めてすぐの「やめる」は、これまでどおり短縮版", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn"); await P.run(1500); await P.click("stopBtn");
    await P.untilCard();
    ok((await P.count(CX.c3)) === 0, "伸びは読まない");
  });
  await section("[Ub3] 3分以上の練習から落ちたあとの復帰 → 全部", async (use) => {
    const P = use(await openPage({ cfg: { stageMin: 3 } }));
    await P.click("startBtn"); await P.run(200000);
    await P.page.reload(); await P.run(4000);
    ok((await P.st()).resume === "block", "復帰の案内を出す");
    const n0 = (await P.texts()).length;
    await P.click("resumeBtn");
    await P.untilCard();
    ok((await P.texts()).slice(n0).some((x) => x.includes(CX.c3)), "伸びも読む（以前は短縮版）");
    await P.q("#rcSave");
    const x = (await P.hist())[0];
    ok(x.cancelEnd === "full" && x.cancelWhy === "resume" && !x.quick, "印：最後まで（復帰）。「みじかく」にはならない", x);
  });
  await section("[Uc] 消去動作の始まりで画面が見えていなければ、一度だけ声で知らせる", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn"); await P.run(2000);
    await P.hide(false);                       // 画面は消えたが、タイマーと声は動く端末
    await P.run(400000);
    let s = await P.st();
    ok(s.stage === "消去動作" && (await P.count("画面をつけると、消去動作を始めます")) === 1 && (await P.count(CX.c0)) === 0 && !s.card,
       "「画面をつけると、消去動作を始めます」と1回だけ言い、消去動作は見えるまで待つ", { stage: s.stage, n: await P.count("画面をつけると"), tail: (await P.texts()).slice(-3) });
    await P.show();
    const r = await P.untilCard();
    ok(r.ok && (await P.count(CX.c0)) === 1 && (await P.count(CX.c5)) === 1, "見えたら消去動作を最後まで読んで終える");
    const d = await P.draft();
    ok(d && d.sec < 330, "見えるのを待っていた時間は、記録の長さに入れない", d && d.sec);
  });
  await section("[Ue] 中断が長いとき：10分で音と声、30分で画面ロックを外す", async (use) => {
    const P = use(await openPage());
    await P.click("startBtn"); await P.run(3000);
    await P.click("pauseBtn"); await P.run(500);
    const s0 = await P.st();
    ok(s0.wake === 1, "中断しても、はじめは画面ロックを外さない");
    await P.run(600000);
    const s1 = await P.st();
    ok((await P.count("中断してから10分たちました")) === 1 && s1.tones > s0.tones && /10分たちました/.test(s1.toast), "10分で、画面の知らせに加えて音と声でも知らせる", { tones: [s0.tones, s1.tones], toast: s1.toast });
    await P.run(1200000);
    ok((await P.st()).wake === 0, "30分で画面ロックを外す", (await P.st()).wake);
    ok(!!(await P.ev(() => localStorage.getItem("autogenic:inPractice"))), "練習中の目印は残す（落ちても消去動作を案内できる）");
    await P.click("pauseBtn"); await P.run(300);
    ok((await P.st()).wake === 1 && (await P.st()).stage === "導入", "再開すると、また画面を消さないようにする");
  });
} catch (e) {
  ok(false, "検証が途中で止まりました: " + (e && e.stack || e));
}
await browser.close();
await srv.close();
done();
