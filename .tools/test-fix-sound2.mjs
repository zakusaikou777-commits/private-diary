/* 音タブ（bgm.html）と入口（index.html）の音まわりの追加の確認（配布には不要）
     node .tools/test-fix-sound2.mjs            … いまの版
     node .tools/test-fix-sound2.mjs <フォルダ> … 別のフォルダの版で（直す前の版で落ちるかの確認用）

   入口（index.html）を開いて音のタブを読み込み、入口の <audio id="nkSound"> を見て確かめる。
   YouTube は偽物（window.__yt）、ロック画面の操作は setActionHandler を横取りして直接呼ぶ、
   チャイムは AudioContext の発振器を数える、iPhone は「audio.volume が効かない」ことで真似る。
   重ねた音・作る音は、入口の blob: を読み出して WAV の頭と中身（サンプル）を調べる。
   1. 音源: 1曲だけならくり返す・「前」・音源だけのシャッフル・自動送り・ロック画面の次/前と表示（YouTube も）
   2. いつもの就寝: 音・重ねた大きさ・音量・タイマー・フェード・夜間モードを覚え、ひと押しでそろえる
   3. 重ねる: それぞれの大きさで足した1本の WAV。つまみは離したときだけ作り直す。iPhone でも音量が効く
   4. 端末で作る音: 60秒・16kHz・継ぎ目なし・大きさがそろう・決まった音・使わなくなった blob は捨てる
   5. 集中タイマー: 区切りで音を下げてチャイム、戻す。YouTube も下げる。長さを選べる
   6. スリープタイマー（入口が持つ）: 音タブを空にしても止まる・読み込み直しても続く・ロック画面に残り時間・
      フェードの長さ・「+10分」・遅れて気づいたらその場で止める・YouTube は音タブが絞る・iPhone は段階で
   7. 曲ごとの音量（YouTube・音源）。端末ごとの設定は同期に載らない
   8. くつろぎの背景音（state / play / vol / stop）がこれまでどおり */
import path from "node:path";
import { startServer, launch, newDevice, makeChecker, sleep, waitFor, ROOT } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const root = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
const c = makeChecker("音の追加（sound2）");
const srv = await startServer(root);
const br = await launch();

/* ── ページより先に動かす偽物・道具 ── */
const FAKE_YT = `(function(){
  var log = window.__ytLog = [];
  var P = window.__yt = { state: -1, playlist: null, index: -1, data: {}, vol: null, ready: false, events: {}, vols: [] };
  function Player(el, opts){
    var self = this; P.events = (opts && opts.events) || {};
    setTimeout(function(){ if (P.events.onReady) P.events.onReady({ target: self }); P.ready = true; }, 0);
  }
  function rec(fn, st){ return function(){ log.push({ fn: fn, args: [].slice.call(arguments) }); if (st != null) P.state = st; }; }
  Player.prototype.loadVideoById = rec("loadVideoById", 3);
  Player.prototype.cueVideoById = rec("cueVideoById", 5);
  Player.prototype.loadPlaylist = rec("loadPlaylist", 3);
  Player.prototype.cuePlaylist = rec("cuePlaylist", 5);
  Player.prototype.playVideo = rec("playVideo");
  Player.prototype.pauseVideo = rec("pauseVideo", 2);
  Player.prototype.stopVideo = rec("stopVideo");
  Player.prototype.nextVideo = rec("nextVideo");
  Player.prototype.setVolume = function(v){ P.vol = v; P.vols.push(v); };
  Player.prototype.getPlayerState = function(){ return P.state; };
  Player.prototype.getVideoData = function(){ return P.data; };
  Player.prototype.getPlaylist = function(){ return P.playlist; };
  Player.prototype.getPlaylistIndex = function(){ return P.index; };
  window.YT = { Player: Player };
  window.addEventListener("load", function(){ if (typeof window.onYouTubeIframeAPIReady === "function") window.onYouTubeIframeAPIReady(); });
  P.fire = function(s){ P.state = s; if (P.events.onStateChange) P.events.onStateChange({ data: s }); };
})();`;
/* ロック画面の操作を横取りする（入口だけ） */
const MS_SPY = `(() => {
  if (window.top !== window || !navigator.mediaSession) return;
  const h = window.__msh = {};
  const orig = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
  navigator.mediaSession.setActionHandler = function (a, f) { h[a] = f; try { return orig(a, f); } catch (e) {} };
})();`;
/* 発振器を数える（チャイム） */
const OSC_SPY = `(() => {
  if (window.top !== window) return;
  const A = window.AudioContext; if (!A) return;
  window.__osc = [];
  const co = A.prototype.createOscillator;
  A.prototype.createOscillator = function () {
    const o = co.call(this), st = o.start.bind(o);
    o.start = function (t) { window.__osc.push(Math.round(o.frequency.value * 100) / 100); return st(t); };
    return o;
  };
})();`;
/* iPhone の真似: audio.volume が効かない（読むと常に 1） */
const IOS_VOL = `(() => { Object.defineProperty(HTMLMediaElement.prototype, "volume", { configurable: true, get() { return 1; }, set(v) {} }); })();`;
/* WAV を読んで調べる（入口で動かす。大きな配列はページの外へ出さない） */
const ANALYZE = `(() => {
  if (window.top !== window) return;
  async function read(url) {
    const b = await (await fetch(url)).arrayBuffer(), dv = new DataView(b);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    return { hdr: { riff: tag(0), wave: tag(8), fmt: dv.getUint16(20, true), ch: dv.getUint16(22, true), sr: dv.getUint32(24, true),
                    bits: dv.getUint16(34, true), data: tag(36), len: dv.getUint32(40, true) / 2, bytes: b.byteLength },
             pcm: new Int16Array(b.slice(44)) };
  }
  function stats(x, sr) {
    const N = x.length; let e = 0, pk = 0, near = 0, z = 0, d = 0;
    for (let i = 0; i < N; i++) { const v = x[i], a = Math.abs(v); e += v * v; if (a > pk) pk = a; if (a >= 32000) near++;
      if (i) { if ((v >= 0) !== (x[i - 1] >= 0)) z++; d += Math.abs(v - x[i - 1]); } }
    const rms = Math.sqrt(e / N), W = Math.round(sr * 0.25); let wmin = Infinity, wmax = 0;
    for (let s = 0; s + W <= N; s += W) { let we = 0; for (let i = s; i < s + W; i++) we += x[i] * x[i]; const r = Math.sqrt(we / W); if (r < wmin) wmin = r; if (r > wmax) wmax = r; }
    const H = Math.round(sr * 0.5); let e1 = 0, e2 = 0;
    for (let i = 0; i < H; i++) { e1 += x[i] * x[i]; e2 += x[N - 1 - i] * x[N - 1 - i]; }
    return { N, rms: Math.round(rms), peak: pk, near, zcr: z / N, wmin: wmin / rms, wmax: wmax / rms,
             seam: Math.abs(x[0] - x[N - 1]) / (d / (N - 1)), head: Math.sqrt(e1 / H) / rms, tail: Math.sqrt(e2 / H) / rms };
  }
  /* y ≈ Σ c_k·ref_k（ref は繰り返して長さを合わせる）。丸めの手前（ひざより小さい所）だけで解く */
  function fit(y, refs) {
    const K = refs.length, A = [], B = new Array(K).fill(0);
    for (let p = 0; p < K; p++) A.push(new Array(K).fill(0));
    for (let i = 0; i < y.length; i += 3) {
      if (Math.abs(y[i]) > 0.65 * 32768) continue;
      const r = refs.map((a) => a[i % a.length]);
      for (let p = 0; p < K; p++) { B[p] += r[p] * y[i]; for (let q = 0; q < K; q++) A[p][q] += r[p] * r[q]; }
    }
    for (let p = 0; p < K; p++) {           // ガウスの消去法
      for (let q = p + 1; q < K; q++) { const f = A[q][p] / A[p][p]; for (let k = p; k < K; k++) A[q][k] -= f * A[p][k]; B[q] -= f * B[p]; }
    }
    const x = new Array(K).fill(0);
    for (let p = K - 1; p >= 0; p--) { let s = B[p]; for (let k = p + 1; k < K; k++) s -= A[p][k] * x[k]; x[p] = s / A[p][p]; }
    let er = 0, ey = 0;
    for (let i = 0; i < y.length; i += 3) { if (Math.abs(y[i]) > 0.65 * 32768) continue; let m = 0; for (let k = 0; k < K; k++) m += x[k] * refs[k][i % refs[k].length]; er += (y[i] - m) ** 2; ey += y[i] * y[i]; }
    return { c: x.map((v) => Math.round(v * 1000) / 1000), resid: Math.sqrt(er / (ey || 1)) };
  }
  window.__refs = {};
  window.__an = async (refs) => {
    const a = document.getElementById("nkSound"), w = await read(a.src), R = [];
    for (const r of refs || []) R.push(r.charAt(0) === "@" ? window.__refs[r.slice(1)] : (await read(r)).pcm);
    return { hdr: w.hdr, st: stats(w.pcm, w.hdr.sr), fit: R.length ? fit(w.pcm, R) : null, src: a.getAttribute("src") };
  };
  window.__keep = async (name) => { const a = document.getElementById("nkSound"); window.__refs[name] = (await read(a.src)).pcm; return window.__refs[name].length; };
  window.__same = async (name) => { const a = document.getElementById("nkSound"), p = (await read(a.src)).pcm, q = window.__refs[name]; let n = 0; for (let i = 0; i < 50000; i++) if (p[i] === q[i]) n++; return n / 50000; };
  window.__fileStats = async (url) => { const w = await read(url); return stats(w.pcm, w.hdr.sr); };
  window.__gone = async (url) => { try { await (await fetch(url)).arrayBuffer(); return false; } catch (e) { return true; } };
})();`;

/* ── 道具 ── */
const v11 = (ch) => ch.repeat(11);
const yid = (ch) => "y" + v11(ch);
const item = (ch, o = {}) => ({ id: yid(ch), kind: "video", vid: v11(ch), list: "", title: "曲" + ch.toUpperCase(), cats: [], fav: false, plays: {}, lastAt: 0, updatedAt: 1000, ...o });
/* 音源ファイル（8kHz・25秒のかすかな音。テストのあいだに自然には終わらない長さ） */
function toneWav(freq, sec = 25) {
  const sr = 8000, n = sr * sec, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(300 * Math.sin(2 * Math.PI * freq * i / sr)), 44 + i * 2);
  return b;
}
const near = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;

async function shellPage({ seed = {}, ios = false, clock = false, drive = null } = {}) {
  const ctx = await newDevice(br, { drive });
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);    // 無い要素を30秒待たない（直す前の版で確かめるとき）
  const errs = [];
  page.on("pageerror", (e) => errs.push(String((e && (e.stack || e.message)) || e)));
  page.on("dialog", (d) => d.accept().catch(() => {}));
  if (ios) await page.addInitScript(IOS_VOL);
  for (const s of [FAKE_YT, MS_SPY, OSC_SPY, ANALYZE]) await page.addInitScript(s);
  await page.addInitScript((seed) => {
    if (window.top !== window || sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    localStorage.setItem("bgm:v1", JSON.stringify(seed));
  }, seed);
  if (clock) await page.clock.install({ time: Date.now() });
  await page.goto(srv.url + "index.html");
  const fr = await openBgm(page);
  return { ctx, page, fr, errs };
}
const bgmFrame = (page) => page.frames().find((f) => /\/bgm\.html/.test(f.url()));
async function openBgm(page) {
  await page.click('.apptab[data-app="bgm"]');
  const fr = await waitFor(() => bgmFrame(page), { label: "音のフレーム" });
  await fr.waitForFunction(() => window.__yt && window.__yt.ready);
  // 入口が v2 だと分かると 🍅 が出る（古い入口では出ない。そのときも先へ進め、確かめる項目ごとに落とす）
  await fr.waitForFunction(() => { const b = document.getElementById("bFocusOpen"); return !!b && !b.hidden; }, null, { timeout: 3000 }).catch(() => {});
  return fr;
}
async function reloadBgm(page) {
  await page.evaluate(() => { document.getElementById("frame-bgm").src = "bgm.html"; });
  await sleep(300);
  return openBgm2(page);
}
async function openBgm2(page) {
  const fr = await waitFor(() => bgmFrame(page), { label: "音のフレーム" });
  await fr.waitForFunction(() => window.__yt && window.__yt.ready, null, { timeout: 8000 });
  await fr.waitForFunction(() => { const b = document.getElementById("bFocusOpen"); return !!b && !b.hidden; }, null, { timeout: 3000 }).catch(() => {});
  return fr;
}
const snd = (page) => page.evaluate(() => { const a = document.getElementById("nkSound"); return { src: a.getAttribute("src") || "", paused: a.paused, loop: a.loop, vol: Math.round(a.volume * 1000) / 1000, ct: a.currentTime }; });
const meta = (page) => page.evaluate(() => { const m = navigator.mediaSession.metadata; return m ? { title: m.title, artist: m.artist, album: m.album, art: (m.artwork || []).map((a) => a.src) } : null; });
const msh = (page, a) => page.evaluate((a) => { const f = window.__msh && window.__msh[a]; if (!f) return false; f({ action: a }); return true; }, a);
const an = (page, refs = []) => page.evaluate((refs) => window.__an(refs), refs);
const stored = (fr) => fr.evaluate(() => JSON.parse(localStorage.getItem("bgm:v1") || "{}"));
const ytLog = (fr, fn) => fr.evaluate((fn) => window.__ytLog.filter((x) => x.fn === fn).map((x) => x.args), fn);
const ytLoads = (fr) => fr.evaluate(() => window.__ytLog.filter((x) => x.fn === "loadVideoById").map((x) => x.args[0].charAt(0)).join(""));
const tleft = (fr) => fr.textContent("#tleft");
const setRange = (fr, sel, v, change = true) => fr.evaluate(([sel, v, change]) => {
  const el = document.querySelector(sel); el.value = String(v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  if (change) el.dispatchEvent(new Event("change", { bubbles: true }));
}, [sel, v, change]);
async function waitSnd(page, pred, timeout = 6000) {
  try { return await waitFor(async () => { const s = await snd(page); return pred(s) ? s : null; }, { timeout, label: "入口の音" }); }
  catch (e) { return null; }
}
const isBlob = (s) => !!s && /^blob:/.test(s.src) && !s.paused;
async function newBlob(page, prev) { return waitSnd(page, (s) => isBlob(s) && s.src !== prev); }
async function section(name, fn) {
  console.log(name);
  try { await fn(); }
  catch (e) { c.ok(false, name + ": 最後まで確かめられない（例外）", String((e && e.message) || e).split("\n")[0].slice(0, 300)); }
}
function okErrors(errs, label) {
  const e = errs.filter((x) => /index\.html|bgm\.html/.test(x));
  c.ok(e.length === 0, label + ": 入口・音タブにエラーが無い", e);
}
const RAIN = "audio/rain.wav", BROWN = "audio/brown.wav", PINK = "audio/pink.wav";

// ── 3. 重ねる ──
await section("重ねる（足した1本の WAV）", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [], scVol: 50, mode: "sc" } });
  c.ok(await fr.isVisible('[data-sc="white"]') && await fr.isVisible('[data-scadd="brown"]'), "作る音のカードと「＋ 重ねる」が出る");
  await fr.click('[data-sc="rain"]');
  let s = await newBlob(page, "");
  c.ok(!!s && s.loop, "就寝用の音は入口で作った WAV（blob:）を loop で鳴らす", s);
  let a = await an(page, [RAIN]);
  c.ok(a.hdr.riff === "RIFF" && a.hdr.wave === "WAVE" && a.hdr.fmt === 1 && a.hdr.ch === 1 && a.hdr.sr === 16000 && a.hdr.bits === 16 && a.hdr.len === 320000,
    "WAV の頭: PCM・16kHz・モノラル・16bit・20秒", a.hdr);
  c.ok(near(a.fit.c[0], 1, 0.01) && a.fit.resid < 0.01, "1つだけのときは元の音そのまま（大きさは<audio>の音量で）", a.fit);
  c.ok(near(s.vol, 0.5, 0.01), "全体の音量は<audio>の音量（50）", s.vol);
  const meta1 = await waitFor(async () => { const x = await meta(page); return x && x.title ? x : null; }, { label: "ロック画面" }).catch(() => null);
  c.ok(meta1 && meta1.title === "雨・シャワー" && /気になり帳 — 音/.test(meta1.artist) && meta1.art.some((u) => /icon-192\.png$/.test(u)),
    "ロック画面: 名前・「気になり帳 — 音」・アプリのアイコン", meta1);

  await sleep(1300);
  const ct0 = (await snd(page)).ct;
  await fr.click('[data-scadd="brown"]');
  s = await newBlob(page, a.src);
  a = await an(page, [RAIN, BROWN]);
  c.ok(!!s && a.hdr.len === 320000 && near(a.fit.c[0], 0.707, 0.02) && near(a.fit.c[1], 0.707, 0.02) && a.fit.resid < 0.02,
    "雨＋ブラウン: 2つをそのまま足し、合わせて1つぶんの大きさに下げる（0.707ずつ）", a.fit);
  c.ok(s && s.ct >= Math.min(ct0, 19) - 0.3, "重ねても頭に戻らず、続きから鳴らす", { ct0, ct: s && s.ct });
  const firstUrl = s.src;
  c.ok(await fr.isVisible("#scMix") && (await fr.$$("#scMix [data-mixvol]")).length === 2, "重ねているときは、それぞれの大きさのつまみが出る");
  c.ok(await fr.evaluate(() => document.querySelector('[data-sc="rain"]').classList.contains("on") && document.querySelector('[data-sc="brown"]').classList.contains("on")), "重ねた2つのカードが点く");

  // つまみは離したときだけ作り直す
  await setRange(fr, '#scMix [data-mixvol="brown"]', 30, false);
  await sleep(700);
  c.ok((await snd(page)).src === firstUrl, "つまみを動かしているあいだ（input）は作り直さない");
  await setRange(fr, '#scMix [data-mixvol="brown"]', 50, true);
  s = await newBlob(page, firstUrl);
  a = await an(page, [RAIN, BROWN]);
  c.ok(!!s && near(a.fit.c[1] / a.fit.c[0], 0.5, 0.02) && near(a.fit.c[0], 0.894, 0.02), "離したら作り直す（ブラウン50: 雨0.894・ブラウン0.447）", a.fit);
  c.ok(await page.evaluate((u) => window.__gone(u), firstUrl), "作り直したら、前の blob: URL は捨てる");
  c.ok((await stored(fr)).mixVol.brown === 50, "それぞれの大きさは端末に覚える", (await stored(fr)).mixVol);

  await setRange(fr, '#scMix [data-mixvol="brown"]', 100, true);
  await newBlob(page, s.src);
  const s2 = await snd(page);
  await fr.click('[data-scadd="pink"]');
  await newBlob(page, s2.src);
  a = await an(page, [RAIN, BROWN, PINK]);
  c.ok(near(a.fit.c[0], 0.577, 0.02) && near(a.fit.c[2], 0.577, 0.02) && a.st.peak < 32767 && a.st.near < 50,
    "3つ重ねても割れない（なめらかに丸める。上限に張り付かない）", { fit: a.fit, peak: a.st.peak, near: a.st.near });
  await fr.click('[data-scadd="white"]'); await sleep(300);
  await fr.click('[data-scadd="fan"]'); await sleep(300);
  const t5 = await fr.textContent("#toast");
  c.ok(/4つまで/.test(t5) && (await fr.$$("#scMix [data-mixvol]")).length === 4, "重ねられるのは4つまで", t5);
  // − 外す
  await fr.click('[data-scadd="white"]');
  await sleep(600);
  c.ok((await fr.$$("#scMix [data-mixvol]")).length === 3, "「− 外す」で外せる");
  await fr.click('[data-sc="rain"]');
  s = await waitSnd(page, (x) => isBlob(x));
  await sleep(500);
  a = await an(page, [RAIN]);
  c.ok(near(a.fit.c[0], 1, 0.01) && !(await fr.isVisible("#scMix")), "重ねているときにカードを押すと、その音だけに切り替える", a.fit);
  await fr.click('[data-sc="rain"]');
  s = await waitSnd(page, (x) => x.paused && !x.src);
  c.ok(!!s, "その音だけが鳴っているときに押すと止める");
  c.ok((await fr.textContent("#scVolNote")) === "", "音量を変えられる端末では、iPhone の注意書きは出さない");
  okErrors(errs, "重ねる");
  await ctx.close();
});

await section("重ねる（iPhone: 音量を焼き込む）", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [], scVol: 50, mode: "sc" }, ios: true });
  await fr.click('[data-sc="rain"]');
  let s = await newBlob(page, "");
  let a = await an(page, [RAIN]);
  c.ok(!!s && near(a.fit.c[0], 0.5, 0.01), "iPhone では全体の音量（50）も WAV に焼き込む", a.fit);
  await setRange(fr, "#scVol", 30, false);
  await sleep(150);
  await setRange(fr, "#scVol", 30, true);
  s = await newBlob(page, s.src, 4000);
  a = await an(page, [RAIN]);
  c.ok(!!s && near(a.fit.c[0], 0.3, 0.01), "音量を変えたら作り直して反映する（30）", a.fit);
  await fr.click('[data-scadd="brown"]');
  s = await newBlob(page, s.src);
  a = await an(page, [RAIN, BROWN]);
  c.ok(near(a.fit.c[0], 0.212, 0.01) && near(a.fit.c[1], 0.212, 0.01), "重ねた音にも全体の音量を焼き込む（0.707×0.3）", a.fit);
  const note = await fr.textContent("#scVolNote");
  c.ok(/つまみを離したとき/.test(note) && !/本体のボタン/.test(note), "iPhone の注意書きを「つまみが効く」に直す", note);
  okErrors(errs, "iPhone の重ねる");
  await ctx.close();
});

// ── 4. 端末で作る音 ──
await section("端末で作る音", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [], scVol: 60, mode: "sc" } });
  const fileRms = (await page.evaluate((u) => window.__fileStats(u), BROWN)).rms;
  const res = {};
  let prev = "";
  for (const id of ["white", "deep", "fan", "waves"]) {
    await fr.click(`[data-sc="${id}"]`);
    const s = await newBlob(page, prev);
    const a = await an(page);
    res[id] = { ...a.st, hdr: a.hdr };
    if (prev) c.ok(await page.evaluate((u) => window.__gone(u), prev), id + ": 前の音の blob: URL は捨てる");
    prev = s ? s.src : prev;
    if (id === "waves") await page.evaluate(() => window.__keep("waves"));
  }
  for (const id of Object.keys(res)) {
    const r = res[id];
    c.ok(r.hdr.sr === 16000 && r.hdr.ch === 1 && r.hdr.bits === 16 && r.hdr.len === 960000, id + ": 16kHz・モノラル・16bit・60秒", r.hdr);
    // 波はもともと寄せ引きがあるので、継ぎ目の前後どうしが同じくらいかだけを見る
    const ok = r.head / r.tail > 0.7 && r.head / r.tail < 1.4 && (id === "waves" || (r.head > 0.7 && r.head < 1.4 && r.tail > 0.7 && r.tail < 1.4));
    c.ok(ok, id + ": 継ぎ目の前後で音が痩せない・跳ねない（頭と終わりの0.5秒）", { head: r.head, tail: r.tail });
    c.ok(r.peak < 32767 && r.near < 200, id + ": 割れていない", { peak: r.peak, near: r.near });
  }
  for (const id of ["deep", "fan"]) c.ok(res[id].seam < 6, id + ": ループの継ぎ目で跳ばない（|最後−最初| がふだんの差分並み）", res[id].seam);
  c.ok(res.white.wmin > 0.8 && res.deep.wmin > 0.4 && res.fan.wmin > 0.5, "途切れて静かになる所が無い", { w: res.white.wmin, d: res.deep.wmin, f: res.fan.wmin });
  const db = (x) => 20 * Math.log10(x / fileRms);
  c.ok(Math.abs(db(res.deep.rms)) < 1.5 && Math.abs(db(res.fan.rms)) < 1.5 && Math.abs(db(res.waves.rms)) < 1.5 && db(res.white.rms) < -3 && db(res.white.rms) > -6,
    "大きさは就寝用のファイルにそろえる（ホワイトだけ3〜6dB小さめ）", { file: fileRms, white: res.white.rms, deep: res.deep.rms, fan: res.fan.rms, waves: res.waves.rms });
  c.ok(res.white.zcr > 0.3 && res.deep.zcr < 0.03 && res.fan.zcr < res.white.zcr, "音の性格: ホワイトは明るく、深いブラウンは低い", { white: res.white.zcr, deep: res.deep.zcr, fan: res.fan.zcr });
  c.ok(res.waves.wmax / res.waves.wmin > 3, "波は寄せては返す（大きい所と小さい所がある）", { min: res.waves.wmin, max: res.waves.wmax });
  // 作る音とファイルを重ねる
  await fr.click('[data-scadd="rain"]');
  const s = await newBlob(page, prev);
  const a = await an(page, [RAIN, "@waves"]);
  c.ok(!!s && a.hdr.len === 960000 && near(a.fit.c[0], 0.707, 0.02) && near(a.fit.c[1], 0.707, 0.02) && a.fit.resid < 0.03,
    "作る音（60秒）と雨（20秒を3回）を重ねられる", { len: a.hdr.len, fit: a.fit });
  // 外して作り直しても同じ音（保存はせず、毎回同じ種から作る）
  await fr.click('[data-sc="fan"]'); await newBlob(page, s.src);
  const s3 = await snd(page);
  await fr.click('[data-sc="waves"]'); await newBlob(page, s3.src);
  c.ok((await page.evaluate(() => window.__same("waves"))) === 1, "作り直しても同じ音になる（保存はしない）");
  const ls = await page.evaluate(() => { let n = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += k.length + (localStorage.getItem(k) || "").length; } return n; });
  c.ok(ls < 50000, "作った音は端末に保存しない（保存領域が増えない）", ls);
  okErrors(errs, "作る音");
  await ctx.close();
});

// ── 1. 音源 ──
await section("音源: くり返し・前・シャッフル・ロック画面", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [item("a", { lastAt: 3000 }), item("b", { lastAt: 2000 }), item("c", { lastAt: 1000 })], mode: "au", auVol: 70, shuffle: false } });
  const add = async (name, f) => {
    const n0 = ((await stored(fr)).tracks || []).length;
    await fr.setInputFiles("#auFile", { name, mimeType: "audio/wav", buffer: toneWav(f) });
    await waitFor(async () => ((await stored(fr)).tracks || []).length > n0, { label: "音源の追加" });
  };
  await add("一曲目.wav", 300);
  let T = (await stored(fr)).tracks;
  await fr.click(`[data-au="${T[0].id}"]`);
  let s = await waitSnd(page, (x) => isBlob(x));
  c.ok(!!s && s.loop === true, "ファイルが1つだけのときは、その曲をくり返す（<audio>の loop）", s);
  let m = await waitFor(async () => { const x = await meta(page); return x && x.title === "一曲目" ? x : null; }, { label: "ロック画面" }).catch(() => null);
  c.ok(m && m.title === "一曲目" && /気になり帳 — 音/.test(m.artist) && m.art.length >= 1, "ロック画面に曲名・「気になり帳 — 音」・アイコン", m);
  await add("二曲目.wav", 400);
  await sleep(400);
  c.ok((await snd(page)).loop === false, "2曲目を足したら、くり返しをやめて次へ進めるようにする");
  await add("三曲目.wav", 500);
  T = (await stored(fr)).tracks;                     // 新しい順: 三・二・一
  const nm = T.map((t) => t.name);
  const title = async () => { await sleep(350); const x = await meta(page); return x && x.title; };
  await fr.click(`[data-au="${T[1].id}"]`);
  c.ok(await title() === nm[1], "カードで選んだ曲を鳴らす", nm);
  await fr.click("#auPrevB");
  c.ok(await title() === nm[0], "「前」で一覧の1つ前へ");
  await fr.click("#auNextB");
  c.ok(await title() === nm[1], "「次」で一覧の次へ");
  c.ok(await msh(page, "nexttrack") && await title() === nm[2], "ロック画面の「次」で、音源の次の曲へ");
  c.ok(await msh(page, "previoustrack") && await title() === nm[1], "ロック画面の「前」で、音源の前の曲へ");
  // 曲が終わったら次へ（自動送り）
  await page.evaluate(() => document.getElementById("nkSound").dispatchEvent(new Event("ended")));
  c.ok(await title() === nm[2], "曲が終わったら、次の曲へ進む");
  // シャッフルは音源だけの設定
  await fr.click("#auShuf");
  let st = await stored(fr);
  c.ok(st.auShuffle === true && st.shuffle === false, "音源のシャッフルは YouTube のシャッフルと別", { au: st.auShuffle, yt: st.shuffle });
  const seen = [await title()];
  for (let i = 0; i < 6; i++) { await fr.click("#auNextB"); seen.push(await title()); }
  c.ok(seen.every((t, i) => !i || t !== seen[i - 1]) && new Set(seen).size >= 2, "シャッフルの「次」は、同じ曲を続けない", seen);
  await fr.click("#auPrevB");
  c.ok(await title() === seen[seen.length - 2], "シャッフル中の「前」は、さっき鳴らした曲へ戻る", seen);
  await fr.click("#mYt"); await fr.click("#bShuffle");
  st = await stored(fr);
  c.ok(st.shuffle === true && st.auShuffle === true, "YouTube のシャッフルを切り替えても、音源のシャッフルは変わらない");
  await fr.click("#bShuffle");

  // YouTube のロック画面（入口の<audio>が空のとき）
  await fr.evaluate(() => parent.postMessage({ nkSound: { cmd: "stop" } }, location.origin));
  await waitSnd(page, (x) => x.paused && !x.src);
  await fr.$eval(`#list [data-play="${yid("a")}"]`, (el) => el.click());
  await fr.evaluate(() => window.__yt.fire(1));
  await sleep(300);
  m = await meta(page);
  c.ok(m && m.title === "曲A" && m.album === "YouTube" && /気になり帳 — 音/.test(m.artist), "YouTube を鳴らしているときは、その曲名をロック画面に出す", m);
  await msh(page, "nexttrack"); await sleep(300);
  await msh(page, "previoustrack"); await sleep(300);
  c.ok((await ytLoads(fr)) === "aba", "ロック画面の「次・前」で YouTube の並びをたどる", await ytLoads(fr));
  await msh(page, "pause"); await sleep(200);
  c.ok((await ytLog(fr, "pauseVideo")).length >= 1, "ロック画面の一時停止を YouTube に回す");
  // 音タブを空にしたら、YouTube の曲名はロック画面に残さない
  await page.evaluate(() => { document.getElementById("frame-bgm").src = "about:blank"; });
  await sleep(500);
  c.ok((await meta(page)) === null, "音タブを空にしたら、YouTube の曲名をロック画面に残さない", await meta(page));
  const fr2 = await reloadBgm(page);
  await fr2.click("#mAu"); await fr2.click("#auShuf");      // シャッフルを切る
  await fr2.click(`[data-au="${T[0].id}"]`);
  c.ok(await title() === nm[0], "（前提）1曲目を鳴らす");
  await reloadBgm(page);
  await sleep(300);
  c.ok(await msh(page, "nexttrack") && await title() === nm[1], "音タブを読み込み直しても、ロック画面の「次」は鳴っている曲の次へ進む");
  okErrors(errs, "音源");
  await ctx.close();
});

// ── 7. 曲ごとの音量・同期に載らない ──
await section("曲ごとの音量", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [item("a", { lastAt: 3000 }), item("b", { lastAt: 2000 })], vol: 60, auVol: 70, mode: "yt" } });
  const tap = (ch) => fr.$eval(`#list [data-play="${yid(ch)}"]`, (el) => el.click());
  await tap("a"); await setRange(fr, "#vol", 35);
  await tap("b");
  c.ok((await fr.inputValue("#vol")) === "35", "覚えていない曲は、いまの音量のまま");
  await setRange(fr, "#vol", 70);
  await tap("a");
  c.ok((await fr.evaluate(() => window.__yt.vol)) === 35 && (await fr.inputValue("#vol")) === "35", "前に合わせた曲は、その音量で鳴らす（YouTube）", await fr.evaluate(() => window.__yt.vol));
  await tap("b");
  c.ok((await fr.evaluate(() => window.__yt.vol)) === 70, "もう1曲もその曲の音量に戻る");
  const st = await stored(fr);
  c.ok(st.tvol && st.tvol[yid("a")] === 35 && st.tvol[yid("b")] === 70 && !("tvol" in st.items[0]) && !("vol" in st.items[0]), "曲ごとの音量は端末の設定に置く（登録そのものには載せない）", st.tvol);
  // 音源
  await fr.click("#mAu");
  for (const [n, f] of [["甲.wav", 300], ["乙.wav", 400]]) {
    const n0 = ((await stored(fr)).tracks || []).length;
    await fr.setInputFiles("#auFile", { name: n, mimeType: "audio/wav", buffer: toneWav(f) });
    await waitFor(async () => ((await stored(fr)).tracks || []).length > n0, { label: "音源の追加" });
  }
  const T = (await stored(fr)).tracks;
  await fr.click(`[data-au="${T[0].id}"]`); await waitSnd(page, isBlob); await setRange(fr, "#auVol", 30);
  await fr.click(`[data-au="${T[1].id}"]`); await sleep(400); await setRange(fr, "#auVol", 80);
  await fr.click(`[data-au="${T[0].id}"]`);
  let s = await waitSnd(page, (x) => isBlob(x) && near(x.vol, 0.3, 0.01));
  c.ok(!!s, "音源も、前に合わせた音量で鳴らす（30）", await snd(page));
  await fr.click(`[data-au="${T[1].id}"]`);
  s = await waitSnd(page, (x) => isBlob(x) && near(x.vol, 0.8, 0.01));
  c.ok(!!s && (await fr.inputValue("#auVol")) === "80", "もう1曲は80", await snd(page));
  okErrors(errs, "曲ごとの音量");
  await ctx.close();
});
await section("端末ごとの設定は同期に載らない", async () => {
  const drive = createFakeDrive();
  const ctx = await newDevice(br, { drive });
  const page = await ctx.newPage();
  await page.addInitScript(FAKE_YT);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("__seeded")) return; sessionStorage.setItem("__seeded", "1");
    localStorage.setItem("shared:gd:cid", "test-client");
    localStorage.setItem("bgm:v1", JSON.stringify({ items: [{ id: "yaaaaaaaaaaa", kind: "video", vid: "aaaaaaaaaaa", list: "", title: "曲A", cats: [], fav: false, plays: {}, lastAt: 0, updatedAt: 1000 }],
      tvol: { yaaaaaaaaaaa: 35 }, mixVol: { brown: 40 }, fade: 300, auShuffle: true, focus: { work: 50, brk: 10 },
      sleep: { ids: ["rain", "brown"], vol: 45, timer: 30, fade: 300, night: true, mv: { rain: 100, brown: 40 } } }));
  });
  await page.goto(srv.url + "bgm.html");
  await page.waitForFunction(() => window.__yt && window.__yt.ready);
  if (!(await page.isVisible("#bSyncNow"))) await page.click("#bSync");
  await page.click("#bSyncNow");
  await waitFor(async () => /同期しました/.test(await page.textContent("#syncMsg")), { label: "同期" });
  const f = drive.byName("nikki-apps-data.json")[0];
  const sec = f ? drive.json(f.id).apps.bgm : null;
  const txt = JSON.stringify(sec || {});
  c.ok(sec && sec.items && sec.items.length === 1 && !/tvol|mixVol|"sleep"|auShuffle|"fade"|"focus"/.test(txt), "曲ごとの音量・重ねた大きさ・いつもの就寝・フェード・シャッフルは送らない", Object.keys(sec || {}));
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("bgm:v1")));
  c.ok(kept.tvol && kept.tvol.yaaaaaaaaaaa === 35 && kept.sleep && kept.sleep.timer === 30 && kept.fade === 300, "同期のあとも、この端末の設定は残る", { tvol: kept.tvol, sleep: kept.sleep, fade: kept.fade });
  await ctx.close();
});

// ── 2. いつもの就寝 ──
await section("いつもの就寝", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [], scVol: 70, mode: "sc", night: false } });
  c.ok(!(await fr.isVisible("#bUsual")), "まだ何も使っていなければ「いつもの就寝」は出ない");
  await fr.click('[data-sc="rain"]'); let s = await newBlob(page, "");
  await fr.click('[data-scadd="brown"]'); s = await newBlob(page, s.src);
  await setRange(fr, '#scMix [data-mixvol="brown"]', 40); s = await newBlob(page, s.src);
  await setRange(fr, "#scVol", 45);
  await fr.click('#tbar .tb[data-t="30"]');
  await fr.selectOption("#tFade", "300");
  await fr.click("#bNight");
  await sleep(300);
  const u = (await stored(fr)).sleep;
  c.ok(u && u.ids.join("+") === "rain+brown" && u.vol === 45 && u.timer === 30 && u.fade === 300 && u.night === true && u.mv.brown === 40,
    "最後に使った音・重ねた大きさ・音量・タイマー・フェード・夜間モードを覚える", u);
  // 全部やめて、夜間モードも戻す（鳴っていないときの切り替えは覚え直さない）
  await fr.evaluate(() => { parent.postMessage({ nkSound: { cmd: "stop" } }, location.origin); parent.postMessage({ nkSound: { cmd: "sleep", min: 0 } }, location.origin); });
  await waitSnd(page, (x) => x.paused && !x.src);
  await sleep(300);
  await fr.click("#bNight");
  await page.reload();
  const fr2 = await openBgm(page);
  c.ok(await fr2.isVisible("#bUsual"), "開き直しても「いつもの就寝」が出る");
  const d = await fr2.textContent("#usualDesc");
  c.ok(/雨・シャワー＋ブラウンノイズ/.test(d) && /音量45/.test(d) && /30分/.test(d) && /フェード5分/.test(d) && /夜間モード/.test(d), "中身が分かる説明を添える", d);
  const t0 = await page.evaluate(() => Date.now());
  await fr2.click("#bUsual");
  s = await newBlob(page, "");
  const a = await an(page, [RAIN, BROWN]);
  c.ok(!!s && near(s.vol, 0.45, 0.01) && near(a.fit.c[1] / a.fit.c[0], 0.4, 0.02), "ひと押しで、同じ重ね方・大きさ・音量で鳴らす", { vol: s && s.vol, fit: a.fit });
  await sleep(300);
  const tm = await page.evaluate(() => JSON.parse(localStorage.getItem("nk:sleepTimer") || "null"));
  c.ok(tm && near(tm.end - t0, 30 * 60000, 5000) && tm.fade === 300, "タイマー（30分・フェード5分）も入口で始まる", tm);
  c.ok(await fr2.evaluate(() => document.documentElement.classList.contains("night")) && (await fr2.inputValue("#tFade")) === "300", "夜間モードとフェードの長さもそろう");
  c.ok(/残り (29|30):/.test(await tleft(fr2)), "残り時間が出る", await tleft(fr2));
  okErrors(errs, "いつもの就寝");
  await ctx.close();
});

// ── 6. スリープタイマー（入口が持つ） ──
await section("スリープタイマー: 音タブを空にしても止まる・ロック画面の残り時間", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [], scVol: 60, mode: "sc" }, clock: true });
  await fr.click('[data-sc="rain"]');
  let s = await newBlob(page, "");
  await fr.click('#tbar .tb[data-t="15"]');
  await sleep(300);
  const now = await page.evaluate(() => Date.now());
  const tm = await page.evaluate(() => JSON.parse(localStorage.getItem("nk:sleepTimer") || "null"));
  c.ok(tm && near(tm.end - now, 15 * 60000, 3000), "止める時刻を入口が持ち、端末にも書いておく", tm);
  c.ok(/残り 1[45]:/.test(await tleft(fr)), "音タブに残り時間が出る", await tleft(fr));
  let m = await meta(page);
  c.ok(m && /あと15分で停止/.test(m.artist), "ロック画面に「あと15分」", m && m.artist);
  await page.clock.pauseAt(now + 100);
  await page.clock.runFor(61000);
  await sleep(150);
  m = await meta(page);
  c.ok(m && /あと14分で停止/.test(m.artist), "1分たつと「あと14分」に書き直す", m && m.artist);
  // 音タブを空にする（取り込みのときなど）
  await page.evaluate(() => { document.getElementById("frame-bgm").src = "about:blank"; });
  await page.clock.runFor(14 * 60000);
  await sleep(150);
  await page.clock.runFor(10000);       // フェードの半ば（k=0.5 → 二乗で 0.25）
  s = await snd(page);
  c.ok(!s.paused && near(s.vol, 0.15, 0.04), "音タブが空でも、入口がフェードする（半ばで 0.6×0.25）", s);
  await page.clock.runFor(11000);
  s = await snd(page);
  c.ok(s.paused && !s.src, "音タブが空でも、入口がタイマーで止める", s);
  c.ok(await page.evaluate(() => localStorage.getItem("nk:sleepTimer") === null), "止めたら、端末に書いた時刻も消す");
  c.ok((await meta(page)) === null, "止めたらロック画面の表示も消す");
  await page.clock.resume();
  const fr2 = await reloadBgm(page);
  c.ok((await tleft(fr2)) === "" && !(await fr2.evaluate(() => document.querySelector('[data-sc="rain"]').classList.contains("on"))), "開き直した音タブは、止まった状態を出す");
  okErrors(errs, "スリープタイマー（空）");
  await ctx.close();
});

await section("スリープタイマー: 読み込み直し・フェードの長さ・+10分・遅れて気づく", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [], scVol: 60, mode: "sc" }, clock: true });
  await fr.click('[data-sc="rain"]');
  await newBlob(page, "");
  await fr.click('#tbar .tb[data-t="30"]');
  await sleep(300);
  let fr2 = await reloadBgm(page);
  await sleep(300);
  c.ok(/残り (29|30):/.test(await tleft(fr2)) && await fr2.evaluate(() => document.querySelector('#tbar .tb[data-t="30"]').classList.contains("on")),
    "音タブを読み込み直しても、残り時間と選んだボタンが出る", await tleft(fr2));
  // フェード5分
  await fr2.selectOption("#tFade", "300");
  await fr2.click('#tbar .tb[data-t="15"]');
  await sleep(300);
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 100);
  await page.clock.runFor(15 * 60000 + 150000);   // フェード5分の半ば
  await sleep(200);
  let s = await snd(page);
  c.ok(!s.paused && near(s.vol, 0.15, 0.04), "フェード5分: 半ばで 0.6×0.25", s);
  c.ok(/停止中… 2:[23]\d/.test(await tleft(fr2)), "長いフェードは、止まるまでの時間も出す", await tleft(fr2));
  const mf = await meta(page);
  c.ok(mf && /音を小さくしています/.test(mf.artist), "ロック画面に「音を小さくしています」", mf && mf.artist);
  // +10分: 音量を戻して数え直す
  await fr2.click("#bPlus10");
  await sleep(300);
  s = await snd(page);
  c.ok(!s.paused && near(s.vol, 0.6, 0.01), "フェード中の「+10分」で音量を戻して鳴らし続ける", s);
  c.ok(/残り (9:5\d|10:00)/.test(await tleft(fr2)), "10分のタイマーに切り替わる", await tleft(fr2));
  await fr2.click("#bPlus10");
  await sleep(300);
  c.ok(/残り (19:5\d|20:00)/.test(await tleft(fr2)) && await fr2.evaluate(() => document.getElementById("bPlus10").classList.contains("on")), "動いているあいだの「+10分」は延長", await tleft(fr2));
  // 遅れて気づいた（画面を消して時計が止まっていた）
  await page.clock.fastForward(20 * 60000 + 6 * 60000);
  await sleep(300);
  s = await snd(page);
  c.ok(s.paused && !s.src, "予定の時刻をフェードの長さより過ぎてから気づいたら、絞らずにその場で止める", s);
  c.ok(/おやすみなさい/.test(await fr2.textContent("#toast")), "止めたら音タブが「おやすみなさい」と出す");
  await page.clock.resume();
  okErrors(errs, "スリープタイマー（読み込み直し）");
  await ctx.close();
});

await section("スリープタイマー: YouTube は音タブが絞る", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [item("a", { lastAt: 3000 })], vol: 60, mode: "yt" }, clock: true });
  await fr.$eval(`#list [data-play="${yid("a")}"]`, (el) => el.click());
  await fr.evaluate(() => window.__yt.fire(1));
  await fr.click('#tbar .tb[data-t="15"]');
  await sleep(300);
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 100);
  await page.clock.runFor(15 * 60000 + 10000);
  await sleep(200);
  await page.clock.runFor(600);
  await sleep(100);
  const mid = await fr.evaluate(() => window.__yt.vol);
  c.ok(mid >= 22 && mid <= 38 && (await ytLog(fr, "pauseVideo")).length === 0, "入口がフェードを知らせると、YouTube を実時間で絞る（20秒の半ばで半分ほど）", mid);
  await page.clock.runFor(11000);
  await sleep(200);
  c.ok((await ytLog(fr, "pauseVideo")).length === 1 && (await tleft(fr)) === "", "20秒で YouTube を止める", { p: (await ytLog(fr, "pauseVideo")).length, t: await tleft(fr) });
  c.ok((await fr.evaluate(() => window.__yt.vol)) === 60, "止めたら YouTube の音量を元に戻しておく（次に鳴らすとき無音にならない）");
  // 止めてあった YouTube は「+10分」で鳴らさない
  await fr.click('#tbar .tb[data-t="15"]');
  await fr.evaluate(() => window.__yt.fire(2));
  await sleep(200);
  await page.clock.runFor(15 * 60000 + 3000);
  await sleep(200);
  const pv = (await ytLog(fr, "playVideo")).length;
  await fr.click("#bPlus10");
  await sleep(300);
  c.ok((await ytLog(fr, "playVideo")).length === pv && /残り (9:5\d|10:00)/.test(await tleft(fr)), "フェード中の「+10分」で、止めてあった YouTube を鳴らさない", await tleft(fr));
  await page.clock.resume();
  okErrors(errs, "スリープタイマー（YouTube）");
  await ctx.close();
});

await section("スリープタイマー: iPhone（音量を変えられない）", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [], scVol: 60, mode: "sc" }, ios: true, clock: true });
  await fr.click('[data-sc="rain"]');
  let s = await newBlob(page, "");
  await fr.click('#tbar .tb[data-t="15"]');
  await sleep(300);
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 100);
  await page.clock.runFor(15 * 60000 + 2000);
  await sleep(300);
  let a = await an(page, [RAIN]);
  c.ok(near(a.fit.c[0], 0.6, 0.01), "（前提）はじめは音量60を焼き込んだ音", a.fit);
  await page.clock.runFor(9000);                  // 20秒のフェードの半ばを過ぎた（2段目）
  s = await newBlob(page, s.src);
  a = await an(page, [RAIN]);
  c.ok(!!s && near(a.fit.c[0], 0.15, 0.01), "iPhone では、作り直した小さい音へ段階的に下げる（0.6×0.25）", a.fit);
  await page.clock.runFor(11000);
  await sleep(300);
  s = await snd(page);
  c.ok(s.paused && !s.src, "フェードの終わりで止める", s);
  // 音源（作り直せない音）は、時間が来たらそのまま止める
  await fr.click("#mAu");
  await fr.setInputFiles("#auFile", { name: "曲.wav", mimeType: "audio/wav", buffer: toneWav(300) });
  await waitFor(async () => ((await stored(fr)).tracks || []).length === 1, { label: "音源の追加" });
  await page.clock.resume();
  const T = (await stored(fr)).tracks;
  await fr.click(`[data-au="${T[0].id}"]`);
  await waitSnd(page, isBlob);
  await fr.click('#tbar .tb[data-t="15"]');
  await sleep(300);
  const t2 = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(t2 + 100);
  await page.clock.runFor(15 * 60000 + 1500);
  await sleep(300);
  s = await snd(page);
  c.ok(s.paused && !s.src, "iPhone の音源は絞れないので、時間が来たらそのまま止める", s);
  c.ok(/段階的に小さく/.test(await fr.textContent("#scVolNote")), "iPhone の注意書きで、タイマーの止まり方を伝える", await fr.textContent("#scVolNote"));
  await page.clock.resume();
  okErrors(errs, "スリープタイマー（iPhone）");
  await ctx.close();
});

// ── 5. 集中タイマー ──
await section("集中タイマー", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [item("a", { lastAt: 3000 })], scVol: 60, vol: 50, mode: "sc" }, clock: true });
  await fr.click('[data-sc="rain"]');
  await newBlob(page, "");
  await fr.click("#bFocusOpen");
  c.ok(await fr.isVisible("#focusBox") && /25分集中・5分休憩/.test(await fr.textContent("#fState")), "🍅 で集中タイマーを開く（はじめは25分・5分）", await fr.textContent("#fState"));
  c.ok(/YouTube[^。]*画面がついている間/.test(await fr.textContent("#focusBox")), "YouTube は画面がついている間だけ、と書いておく");
  await fr.click("#bFocus");
  await sleep(300);
  c.ok(/集中 (24:5\d|25:00)（1回目）/.test(await fr.textContent("#fState")), "集中の残り時間と回数が出る", await fr.textContent("#fState"));
  c.ok(/集中 あと25分/.test((await meta(page)).artist), "ロック画面にも出す", (await meta(page)).artist);
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 100);
  const osc0 = (await page.evaluate(() => window.__osc.slice())).length;
  await page.clock.runFor(25 * 60000 + 500);
  await page.clock.runFor(1000);
  await sleep(200);
  let s = await snd(page);
  const osc = await page.evaluate(() => window.__osc.slice());
  c.ok(near(s.vol, 0.18, 0.03), "区切りで音楽を下げる（0.6→0.18）", s.vol);
  c.ok(osc.length > osc0 && osc.includes(659.25) && osc.includes(523.25), "小さなチャイムを鳴らす（休憩へは下がる2音）", osc);
  c.ok(/休憩 4:5\d/.test(await fr.textContent("#fState")), "休憩に切り替わる", await fr.textContent("#fState"));
  await page.clock.runFor(5000);
  s = await snd(page);
  c.ok(near(s.vol, 0.6, 0.01) && !s.paused, "チャイムのあと、元の音量に戻す", s);
  await page.clock.runFor(5 * 60000);
  await sleep(200);
  const osc2 = await page.evaluate(() => window.__osc.slice());
  c.ok(/集中 \d+:\d\d（2回目）/.test(await fr.textContent("#fState")) && osc2.includes(783.99), "休憩が終わると2回目の集中（上がる3音）", { st: await fr.textContent("#fState"), osc: osc2 });
  // 音タブを読み込み直しても続く
  await page.clock.resume();
  let fr2 = await reloadBgm(page);
  await sleep(300);
  c.ok(await fr2.isVisible("#focusBox") && /集中 \d+:\d\d（2回目）/.test(await fr2.textContent("#fState")), "音タブを読み込み直しても、集中タイマーは続いている", await fr2.textContent("#fState"));
  // やめて、50分・10分で始め直す
  await fr2.click("#bFocus"); await sleep(200);
  await fr2.click('[data-fw="50"]'); await fr2.click('[data-fb="10"]');
  await fr2.click("#bFocus"); await sleep(300);
  c.ok(/集中 (49:5\d|50:00)（1回目）/.test(await fr2.textContent("#fState")), "長さを選べる（50分）", await fr2.textContent("#fState"));
  // YouTube も区切りで下げる
  await fr2.click("#mYt");
  await fr2.evaluate(() => parent.postMessage({ nkSound: { cmd: "stop" } }, location.origin));
  await fr2.$eval(`#list [data-play="${yid("a")}"]`, (el) => el.click());
  await fr2.evaluate(() => window.__yt.fire(1));
  const t1 = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(t1 + 100);
  await fr2.evaluate(() => { window.__yt.vols.length = 0; });
  await page.clock.runFor(50 * 60000 + 1500);
  await sleep(200);
  await page.clock.runFor(800);
  await sleep(100);
  const low = await fr2.evaluate(() => Math.min.apply(null, window.__yt.vols));   // 区切りのあいだに付けた音量のいちばん小さいところ
  c.ok(low >= 13 && low <= 17, "YouTube も区切りで下げる（50→15）", low);
  await page.clock.runFor(5000);
  await sleep(100);
  c.ok((await fr2.evaluate(() => window.__yt.vol)) === 50 && /休憩 9:5\d/.test(await fr2.textContent("#fState")), "YouTube の音量も戻す。休憩は10分", { v: await fr2.evaluate(() => window.__yt.vol), st: await fr2.textContent("#fState") });
  await fr2.click("#bFocus");
  await sleep(200);
  c.ok(/50分集中・10分休憩/.test(await fr2.textContent("#fState")) && (await stored(fr2)).focus.work === 50, "やめると止まる。選んだ長さは端末に覚える");
  await page.clock.resume();
  okErrors(errs, "集中タイマー");
  await ctx.close();
});

// ── 8. くつろぎの背景音 ──
await section("くつろぎの背景音（これまでの命令）", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [], scVol: 60, mode: "sc" } });
  await page.click('.apptab[data-app="autogenic"]');
  const af = await waitFor(() => page.frames().find((f) => /\/autogenic\.html/.test(f.url())), { label: "くつろぎ" });
  await af.waitForLoadState("domcontentloaded");
  await af.evaluate(() => { window.__st = []; window.addEventListener("message", (e) => { if (e.data && e.data.nkSoundState) window.__st.push(e.data.nkSoundState); }); });
  const post = (m) => af.evaluate((m) => parent.postMessage({ nkSound: m }, "*"), m);   // くつろぎの bgPost と同じ送り方
  const last = () => af.evaluate(() => window.__st[window.__st.length - 1] || null);
  await post({ cmd: "state" }); await sleep(200);
  c.ok(!!(await last()), "state に答える");
  await post({ cmd: "play", id: "rain", file: "audio/rain.wav", name: "雨・シャワー", vol: 0.18 });
  let s = await waitSnd(page, (x) => !x.paused && /audio\/rain\.wav$/.test(x.src));
  c.ok(!!s && s.loop && near(s.vol, 0.18, 0.005), "play: ファイルをそのまま loop で、頼まれた音量で鳴らす", s);
  await sleep(200);
  let l = await last();
  c.ok(l && l.id === "rain" && l.playing === true, "鳴っている音を id で知らせる（くつろぎは id で自分の音か見分ける）", l);
  await post({ cmd: "vol", vol: 0.3 }); await sleep(200);
  c.ok(near((await snd(page)).vol, 0.3, 0.005), "vol で音量を変える");
  await post({ cmd: "stop" });
  s = await waitSnd(page, (x) => x.paused && !x.src);
  await sleep(200);
  l = await last();
  c.ok(!!s && l && l.playing === false && l.id === null, "stop で止める", l);
  okErrors(errs, "くつろぎ");
  await ctx.close();
});
await section("くつろぎの背景音と、音タブの重ねた音", async () => {
  const { ctx, page, fr, errs } = await shellPage({ seed: { items: [], scVol: 60, mode: "sc" } });
  await page.click('.apptab[data-app="autogenic"]');
  const af = await waitFor(() => page.frames().find((f) => /\/autogenic\.html/.test(f.url())), { label: "くつろぎ" });
  await af.waitForLoadState("domcontentloaded");
  await af.evaluate(() => { window.__st = []; window.addEventListener("message", (e) => { if (e.data && e.data.nkSoundState) window.__st.push(e.data.nkSoundState); }); });
  const post = (m) => af.evaluate((m) => parent.postMessage({ nkSound: m }, "*"), m);
  const last = () => af.evaluate(() => window.__st[window.__st.length - 1] || null);
  let s, l;
  // 音タブが鳴らした「雨だけ」は、くつろぎから見ても id=rain（借りられる）
  await page.click('.apptab[data-app="bgm"]');
  await fr.click('[data-sc="rain"]');
  await newBlob(page, "");
  await sleep(300);
  l = await last();
  c.ok(l && l.id === "rain" && l.playing, "音タブの「雨」1つは id=rain のまま（くつろぎが同じ音だと分かる）", l);
  await fr.click('[data-scadd="brown"]');
  await sleep(800);
  l = await last();
  c.ok(l && l.id === "mix:rain+brown", "重ねた音は別の id（くつろぎが自分の音と取り違えない）", l);
  // くつろぎが同じ id で play しても、鳴っている音を差し替えない
  await fr.click('[data-sc="rain"]');
  s = await waitSnd(page, (x) => isBlob(x));
  await sleep(500);
  const src0 = (await snd(page)).src;
  await post({ cmd: "play", id: "rain", file: "audio/rain.wav", name: "雨・シャワー", vol: 0.25 });
  await sleep(400);
  s = await snd(page);
  c.ok(s.src === src0 && !s.paused && near(s.vol, 0.25, 0.005), "同じ音が鳴っていれば play は音量だけ合わせる（これまでどおり）", s);
  okErrors(errs, "くつろぎと重ねた音");
  await ctx.close();
});

await br.close();
await srv.close();
c.done();
