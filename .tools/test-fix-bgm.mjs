/* 音（bgm.html）と暗室（image-streaming.html）の修正の検証（配布には不要）
     node .tools/test-fix-bgm.mjs
     BGM_ROOT=<ディレクトリ> node .tools/test-fix-bgm.mjs … そのディレクトリを配る（修正前の版で落ちるか確かめる用）
   音
   - 次・前・自動送りが2曲を行ったり来たりしない。絞り込みの変更・追加・削除に追従する
   - 再生できなかった曲は、続けて流している途中なら次へ進む。一巡して鳴らなければ止める。
     削除・非公開の動画（100）には印を付けて、自動送りでは飛ばす（鳴りはじめたら外す）
   - 再生リストは、最後の1本が終わるまで次の登録へ進まない
   - 編集欄の「＋ 新しいジャンル」で updatedAt が進む（同期で外れない）
   - 音源の書き込みが取り消されたら「追加しました」と出さない。保存先を一度開けなくても、開き直さずに追加できる
   - スリープタイマー: フェード中の「+10分」で、止めてあった YouTube を鳴らさない。
     フェードは実時間で20秒。間引かれたタイマーで遅れて気づいたときは、その場で止める
   - 同期で一覧が入れ替わっても、取りに行ったタイトルが消えない
   - 名前を変えたジャンルの元の名前で新しく足しても消えない。同じ名前のジャンルは1つにまとまる
   - URL の開始位置（t= / start=）から鳴らす
   - 💡を頼んでいる間に切ったら、届いた画面ロックをすぐ返す
   - シェルとのやりとりは同じオリジンの親だけ
   暗室
   - 全消去は消した記録だけを消す（時計のずれた端末でも、ほかの端末の新しい記録まで消さない）。旧版の消去時刻も効く
   - 一時停止から再開したとき、止められていた音の出口を起こし直す */
import { startServer, launch, newDevice, makeChecker, collectErrors, sleep, waitFor } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const c = makeChecker("音・暗室");
const srv = await startServer(process.env.BGM_ROOT || undefined);
const br = await launch();
const ORIGIN = srv.url.replace(/\/$/, "");

/* YouTube の iframe API の偽物。window.__yt から状態を変えたり、エラーを起こしたりする。
   呼ばれた操作は window.__ytLog に残る。 */
const FAKE_YT = `(function(){
  var log = window.__ytLog = [];
  var P = window.__yt = { state: -1, playlist: null, index: -1, data: {}, vol: null, ready: false, events: {} };
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
  Player.prototype.setVolume = function(v){ P.vol = v; };
  Player.prototype.getPlayerState = function(){ return P.state; };
  Player.prototype.getVideoData = function(){ return P.data; };
  Player.prototype.getPlaylist = function(){ return P.playlist; };
  Player.prototype.getPlaylistIndex = function(){ return P.index; };
  window.YT = { Player: Player };
  // 本物は読み込み後に onYouTubeIframeAPIReady を呼ぶ
  window.addEventListener("load", function(){ if (typeof window.onYouTubeIframeAPIReady === "function") window.onYouTubeIframeAPIReady(); });
  P.fire = function(s){ P.state = s; if (P.events.onStateChange) P.events.onStateChange({ data: s }); };
  P.error = function(code){ if (P.events.onError) P.events.onError({ data: code }); };
})();`;

const v11 = (ch) => ch.repeat(11);
const yid = (ch) => "y" + v11(ch);
function item(ch, o = {}) {
  return { id: yid(ch), kind: "video", vid: v11(ch), list: "", title: "曲" + ch.toUpperCase(), cats: [], fav: false, plays: {}, lastAt: 0, updatedAt: 1000, ...o };
}
const NOISE = /Failed to load resource|音源DBを開けません/;

/** 音のページを1枚。seed は localStorage の bgm:v1 の中身（読み込み直しても1回だけまく） */
async function bgmPage({ seed = {}, init = [], drive = null, clock = null, cid = false, before = null, path = "bgm.html" } = {}) {
  const ctx = await newDevice(br, { drive });
  const page = await ctx.newPage();
  const errs = collectErrors(page);
  const dialogs = [];   // prompt に順に答える。confirm は常に OK
  page.on("dialog", async (d) => {
    if (d.type() === "prompt") { const a = dialogs.length ? dialogs.shift() : null; if (a === null) await d.dismiss(); else await d.accept(a); }
    else await d.accept();
  });
  await page.addInitScript(FAKE_YT);
  for (const s of init) await page.addInitScript(s);
  await page.addInitScript(({ seed, cid }) => {
    if (sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    localStorage.setItem("bgm:v1", JSON.stringify(seed));
    if (cid) localStorage.setItem("shared:gd:cid", "test-client");
  }, { seed, cid });
  if (clock) await page.clock.install({ time: clock });
  if (before) await before(page);
  await page.goto(srv.url + path);
  if (path === "bgm.html") await page.waitForFunction(() => window.__yt && window.__yt.ready);
  return { ctx, page, errs, dialogs };
}
const loads = (page) => page.evaluate(() => window.__ytLog
  .filter((x) => x.fn === "loadVideoById" || x.fn === "loadPlaylist")
  .map((x) => (x.fn === "loadPlaylist" ? "PL" : x.args[0].charAt(0))));
const logOf = (page, fn) => page.evaluate((fn) => window.__ytLog.filter((x) => x.fn === fn), fn);
const fire = (page, s) => page.evaluate((s) => window.__yt.fire(s), s);
const ytErr = (page, code) => page.evaluate((code) => window.__yt.error(code), code);
const tap = (page, ch) => page.$eval(`#list [data-play="${yid(ch)}"]`, (el) => el.click());   // サムネイルは読めずに隠れるので直接押す
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("bgm:v1")));
const storedItem = async (page, ch) => (await stored(page)).items.find((x) => x.id === yid(ch));
const toastText = (page) => page.evaluate(() => { const t = document.getElementById("toast"); return t.style.display === "none" ? "" : t.textContent; });
async function waitLoads(page, n, timeout = 4000) {
  try { await waitFor(async () => (await loads(page)).length >= n, { timeout, label: "再生" }); return true; } catch (e) { return false; }
}
async function endAndNext(page) { await fire(page, 1); await fire(page, 0); }
function okErrors(errs, label) {
  const e = errs.filter((x) => !NOISE.test(x));
  c.ok(e.length === 0, label + ": ページのエラーが無い", e);
}

// ── 1. 次・前・自動送りの順番 ──
{
  console.log("次・前・自動送りの順番");
  const { page, errs, ctx } = await bgmPage({ seed: { items: [
    item("a", { lastAt: 3000, cats: ["カフェ"] }), item("b", { lastAt: 2000, cats: ["ジャズ"] }), item("c", { lastAt: 1000, cats: ["カフェ"] })
  ] } });
  await tap(page, "a");
  for (let i = 0; i < 3; i++) await endAndNext(page);
  let seq = await loads(page);
  c.ok(seq.join("") === "abca", "自動送りは一覧の順に進み、最後で先頭へ戻る（2曲を行ったり来たりしない）", seq);

  await page.click("#bNext"); await page.click("#bNext"); await page.click("#bPrev");
  seq = (await loads(page)).slice(4);
  c.ok(seq.join("") === "bcb", "「次」「前」も控えた並びをたどる", seq);

  await page.click('#gfilters [data-gf="カフェ"]');
  for (let i = 0; i < 3; i++) await page.click("#bNext");
  seq = (await loads(page)).slice(7);
  c.ok(seq.length === 3 && !seq.includes("b") && seq[0] !== seq[1] && seq[0] === seq[2], "ジャンルで絞ったら、その中を順に回る", seq);

  await page.click('#gfilters [data-gf=""]');
  await page.click("#bNext");
  await page.fill("#addUrl", "https://www.youtube.com/watch?v=" + v11("d"));
  await page.click("#bAdd");
  for (let i = 0; i < 4; i++) await page.click("#bNext");
  seq = (await loads(page)).slice(11);
  c.ok(new Set(seq).size === 4 && seq.includes("d"), "途中で足した曲も、並びの末尾に加わって一巡で回る", seq);

  await page.$eval(`#list [data-del="${yid("c")}"]`, (el) => el.click());
  for (let i = 0; i < 3; i++) await page.click("#bNext");
  seq = (await loads(page)).slice(15);
  c.ok(new Set(seq).size === 3 && !seq.includes("c"), "消した曲は並びから抜ける", seq);

  await page.click('#sfilters [data-f="recent"]');
  for (let i = 0; i < 6; i++) await endAndNext(page);
  seq = (await loads(page)).slice(18);
  c.ok(seq.length === 6 && new Set(seq.slice(0, 3)).size === 3 && seq.slice(0, 3).join("") === seq.slice(3).join(""), "並べ方を「最近聞いた」に変えても、鳴らすたびに並びが揺れない", seq);
  okErrors(errs, "順番");
  await ctx.close();
}

// ── 2. 再生できなかったとき ──
{
  console.log("再生できなかったとき");
  const { page, errs, ctx } = await bgmPage({ seed: { items: [
    item("a", { lastAt: 3000 }), item("b", { lastAt: 2000 }), item("c", { lastAt: 1000 })
  ] } });
  await tap(page, "a");
  await endAndNext(page);                       // → b
  await ytErr(page, 5);
  c.ok(await waitLoads(page, 3), "自動送りの曲が鳴らなければ、少し待って次へ進む", await loads(page));
  c.ok((await loads(page))[2] === "c", "進む先は並びの次の曲", await loads(page));
  await ytErr(page, 100);                       // c は削除・非公開
  const goneMark = await storedItem(page, "c");
  c.ok(goneMark && goneMark.gone === true && goneMark.updatedAt > 1000, "削除・非公開（100）の動画に印を付け、同期に乗せる", goneMark);
  c.ok(await page.evaluate(() => document.getElementById("list").textContent.includes("見つかりません")), "一覧に「見つかりません」と出る");
  await waitLoads(page, 4);
  await endAndNext(page);                       // a → b
  await endAndNext(page);                       // b → （c は飛ばす）a
  let seq = await loads(page);
  c.ok(seq.slice(3).join("") === "aba", "印の付いた動画は自動送りで飛ばす", seq);

  await fire(page, 1);
  await ytErr(page, 5);                         // a も b も鳴らない
  await waitLoads(page, 7);
  await ytErr(page, 5);
  await sleep(2200);
  seq = await loads(page);
  const note = await page.textContent("#pnote");
  c.ok(seq.length === 7 && /見つからなかった/.test(note), "一巡して1曲も鳴らなければ止めて知らせる", { seq, note });

  await tap(page, "b");
  await ytErr(page, 5);
  await sleep(2200);
  c.ok((await loads(page)).length === 8, "一覧から選んだ曲がいきなり鳴らないときは、勝手に次へ進まない", await loads(page));

  await tap(page, "c");
  await fire(page, 1);
  const back = await storedItem(page, "c");
  c.ok(back && !back.gone && back.updatedAt > goneMark.updatedAt - 1, "鳴りはじめたら「見つからない」の印を外す", back);
  okErrors(errs, "エラー");
  await ctx.close();
}

// ── 3. 再生リスト ──
{
  console.log("再生リスト");
  const pl = { id: "y|PLtest", kind: "playlist", vid: "", list: "PLtest", title: "リスト", cats: [], fav: false, plays: {}, lastAt: 2000, updatedAt: 1000 };
  const { page, errs, ctx } = await bgmPage({ seed: { items: [item("a", { lastAt: 3000 }), pl, item("c", { lastAt: 1000 })] } });
  await page.$eval('#list [data-play="y|PLtest"]', (el) => el.click());
  await page.evaluate(() => { window.__yt.playlist = ["x1", "x2", "x3"]; window.__yt.index = 0; });
  await endAndNext(page);
  c.ok((await loads(page)).join("") === "PL", "再生リストの途中の1本が終わっても、次の登録へ進まない", await loads(page));
  await page.evaluate(() => { window.__yt.index = 1; window.__yt.state = -1; });
  await ytErr(page, 5);
  await sleep(1800);
  c.ok((await logOf(page, "nextVideo")).length === 1, "再生リストの中の1本が鳴らなければ、リストの中で先へ進む");
  await page.evaluate(() => { window.__yt.index = 2; });
  await endAndNext(page);
  c.ok((await loads(page)).join("") === "PLc", "最後の1本が終わったら次の登録へ進む", await loads(page));
  okErrors(errs, "再生リスト");
  await ctx.close();
}

// ── 4. 開始位置・編集欄の新しいジャンル・ジャンルのID ──
{
  console.log("開始位置・ジャンル");
  const { page, errs, ctx, dialogs } = await bgmPage({ seed: { items: [item("a", { lastAt: 3000, cats: ["カフェ"] })] } });
  const add = async (u) => { await page.fill("#addUrl", u); await page.click("#bAdd"); };
  await add("https://youtu.be/" + v11("e") + "?t=90");
  await add("https://www.youtube.com/watch?v=" + v11("f") + "&list=RD" + v11("f") + "&t=1m30s");
  await add("https://www.youtube.com/watch?v=" + v11("g") + "&list=RD" + v11("g") + "&start_radio=1");
  for (const ch of ["e", "f", "g", "a"]) await tap(page, ch);
  const args = (await logOf(page, "loadVideoById")).map((x) => [x.args[0].charAt(0), x.args[1] || 0]);
  c.ok(JSON.stringify(args) === JSON.stringify([["e", 90], ["f", 90], ["g", 0], ["a", 0]]), "URLの開始位置（t=90 / t=1m30s）から鳴らし、無いものは頭から", args);
  c.ok((await storedItem(page, "e")).start === 90 && !("start" in (await storedItem(page, "g"))), "開始位置を登録に残す（無いものには付けない）");

  await page.$eval(`#list [data-ed="${yid("a")}"]`, (el) => el.click());
  dialogs.push("焚き火", "");
  await page.$eval("#list [data-ecnew]", (el) => el.click());
  const a = await storedItem(page, "a");
  c.ok(a.cats.includes("焚き火") && a.updatedAt > 1000, "編集欄の「＋ 新しいジャンル」で曲の updatedAt が進む（同期で外れない）", { cats: a.cats, updatedAt: a.updatedAt });

  await page.click("#bGEdit");
  dialogs.push("喫茶", "");
  await page.click('#genreSearch [data-gren="カフェ"]');
  dialogs.push("カフェ", "");
  await page.click("#bGAdd");
  await page.reload();
  await page.waitForFunction(() => window.__yt && window.__yt.ready);
  const g = (await stored(page)).genres;
  const kissa = g.find((x) => x.name === "喫茶"), cafe = g.find((x) => x.name === "カフェ");
  c.ok(kissa && cafe && kissa.id !== cafe.id, "名前を変えたジャンルの元の名前で足しても、開き直したあとに両方残る", g.map((x) => x.id + "=" + x.name));
  c.ok(kissa && kissa.id === "カフェ" && g.some((x) => x.id === "ジャズ" && x.name === "ジャズ"), "これまでのID（＝名前）はそのまま使う");
  c.ok((await storedItem(page, "a")).cats.includes("喫茶"), "曲のジャンルも名前の変更に付いてくる");
  okErrors(errs, "ジャンル");
  await ctx.close();
}
{
  const { page, errs, ctx } = await bgmPage({ seed: {
    items: [item("a", { cats: ["N"] })],
    genres: [{ id: "zz", name: "N", q: "N1", updatedAt: 1 }, { id: "aa", name: "N", q: "N2", updatedAt: 1 }, { id: "カフェ", name: "カフェ", q: "x", updatedAt: 0 }]
  } });
  const g = (await stored(page)).genres;
  c.ok(g.filter((x) => x.name === "N").length === 1 && g.find((x) => x.name === "N").id === "aa" && g.some((x) => x.id === "カフェ"),
    "同じ名前のジャンルは1つにまとめる（どの端末でも同じ方＝IDの小さい方を残す）", g);
  okErrors(errs, "ジャンルの重なり");
  await ctx.close();
}

{
  // 2台が別々に同じ名前のジャンルを足しても、同期のあとは1つにそろう（IDが採番になったため）
  const drive = createFakeDrive();
  const bgmSync = async (page) => {
    if (!(await page.isVisible("#bSyncNow"))) await page.click("#bSync");
    await page.click("#bSyncNow");
    await waitFor(async () => !/同期しています/.test(await page.textContent("#syncMsg")), { label: "同期" });
  };
  const A = await bgmPage({ seed: { items: [item("a")] }, drive, cid: true });
  const B = await bgmPage({ seed: { items: [item("b")] }, drive, cid: true });
  A.dialogs.push("焚き火", ""); await A.page.click("#bGAdd");
  B.dialogs.push("焚き火", ""); await B.page.click("#bGAdd");
  await bgmSync(A.page); await bgmSync(B.page); await bgmSync(A.page);
  const ga = (await stored(A.page)).genres.filter((x) => x.name === "焚き火");
  const gb = (await stored(B.page)).genres.filter((x) => x.name === "焚き火");
  c.ok(ga.length === 1 && gb.length === 1 && ga[0].id === gb[0].id, "2台で同じ名前のジャンルを足しても、同期のあとは同じ1つにそろう", { ga, gb });
  c.ok((await stored(A.page)).items.length === 2, "同期そのものは通る（曲は両方そろう）");
  okErrors(A.errs, "ジャンルの同期A"); okErrors(B.errs, "ジャンルの同期B");
  await A.ctx.close(); await B.ctx.close();
}

// ── 5. 音源の保存 ──
const ABORT_PUT = `(() => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () {
    const r = put.apply(this, arguments);
    if (window.__abortPut) { const tx = this.transaction; r.addEventListener("success", () => { try { tx.abort(); } catch (e) {} }); }
    return r;
  };
})();`;
const FAIL_OPEN_ONCE = `(() => {
  const open = IDBFactory.prototype.open; let n = 0;
  IDBFactory.prototype.open = function (name) {
    if (name === "BgmAudioDB" && n++ < 1) throw new DOMException("検証用の失敗", "UnknownError");
    return open.apply(this, arguments);
  };
})();`;
const AUDIO_FILE = { name: "テスト.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000検証用") };
const auCount = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("BgmAudioDB", 1);
  r.onsuccess = () => { const q = r.result.transaction("tracks", "readonly").objectStore("tracks").count(); q.onsuccess = () => { res(q.result); r.result.close(); }; };
  r.onerror = () => res(-1);
}));
{
  console.log("音源の保存");
  const { page, errs, ctx } = await bgmPage({ seed: { items: [] }, init: [ABORT_PUT] });
  await page.click("#mAu");
  await page.evaluate(() => { window.__abortPut = true; });
  await page.setInputFiles("#auFile", AUDIO_FILE);
  await waitFor(async () => (await toastText(page)) !== "", { label: "案内" }).catch(() => {});
  await sleep(300);
  const t1 = await toastText(page);
  c.ok(/保存できませんでした/.test(t1) && !/追加しました/.test(t1), "書き込みが取り消されたら「追加しました」と出さず、保存できなかったと伝える", t1);
  c.ok(((await stored(page)).tracks || []).length === 0 && (await auCount(page)) === 0, "一覧にも残さない");
  await page.evaluate(() => { window.__abortPut = false; });
  await page.setInputFiles("#auFile", AUDIO_FILE);
  await waitFor(async () => /追加しました/.test(await toastText(page)), { label: "追加" }).catch(() => {});
  c.ok(((await stored(page)).tracks || []).length === 1 && (await auCount(page)) === 1, "書けたときは追加する");
  okErrors(errs, "音源の保存");
  await ctx.close();
}
{
  const { page, errs, ctx } = await bgmPage({ seed: { items: [] }, init: [FAIL_OPEN_ONCE] });
  await page.click("#mAu");
  await page.setInputFiles("#auFile", AUDIO_FILE);
  await waitFor(async () => (await toastText(page)) !== "", { label: "案内" }).catch(() => {});
  await sleep(300);
  const t = await toastText(page);
  c.ok(/追加しました/.test(t) && (await auCount(page)) === 1, "起動時に保存先を開けなくても、開き直さずに追加できる", t);
  okErrors(errs, "保存先の開き直し");
  await ctx.close();
}

// ── 6. スリープタイマー ──
{
  console.log("スリープタイマー");
  const { page, errs, ctx } = await bgmPage({ seed: { items: [item("a", { lastAt: 3000 })] }, clock: Date.now() });
  await tap(page, "a");
  await fire(page, 1);
  await fire(page, 2);                                   // YouTube は利用者が止めてある
  await page.click('#tbar .tb[data-t="15"]');
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 50);
  await page.clock.runFor(15 * 60000 + 3000);            // 予定の時刻を過ぎて、フェードの途中
  c.ok((await page.textContent("#tleft")) === "停止中…", "予定の時刻でフェードを始める", await page.textContent("#tleft"));
  const before = (await logOf(page, "playVideo")).length;
  await page.$eval("#bPlus10", (el) => el.click());
  c.ok((await logOf(page, "playVideo")).length === before, "フェード中の「+10分」で、止めてあった YouTube を鳴らさない");
  c.ok(/残り 9:5\d|残り 10:00/.test(await page.textContent("#tleft")), "10分のタイマーに切り替わる", await page.textContent("#tleft"));

  await fire(page, 1);                                   // こんどは鳴らしている
  await page.clock.runFor(10 * 60000 + 10000);           // フェードの半ば
  const mid = await page.evaluate(() => window.__yt.vol);
  const paused0 = (await logOf(page, "pauseVideo")).length;
  c.ok(mid >= 20 && mid <= 40 && paused0 === 0, "フェードは実時間で20秒（半分で音量も半分ほど）", { mid, paused0 });
  await page.clock.runFor(11000);
  c.ok((await logOf(page, "pauseVideo")).length === 1 && (await page.textContent("#tleft")) === "", "20秒で止める");

  await page.$eval('#tbar .tb[data-t="15"]', (el) => el.click());
  await fire(page, 1);
  await page.clock.fastForward(16 * 60000);              // 画面を消して、タイマーが1分以上間引かれた
  c.ok((await logOf(page, "pauseVideo")).length === 2 && (await page.textContent("#tleft")) === "", "遅れて気づいたときは、絞らずにその場で止める", await page.textContent("#tleft"));
  await page.clock.resume();
  okErrors(errs, "スリープタイマー");
  await ctx.close();
}

// ── 7. 画面ロック（💡）──
const FAKE_WAKE = `(() => {
  const made = window.__wake = [];
  const api = { request() { return new Promise((res) => {
    const s = { released: false, ls: [], release() { this.released = true; this.ls.forEach((f) => f()); return Promise.resolve(); }, addEventListener(t, f) { if (t === "release") this.ls.push(f); } };
    made.push(s); setTimeout(() => res(s), 300);
  }); } };
  Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, get() { return api; } });
})();`;
{
  console.log("画面ロック");
  const { page, errs, ctx } = await bgmPage({ seed: { items: [] }, init: [FAKE_WAKE] });
  await page.click("#bWake"); await page.click("#bWake");          // 届く前に切る
  await sleep(600);
  let r = await page.evaluate(() => ({ n: window.__wake.length, rel: window.__wake.map((s) => s.released), on: document.getElementById("bWake").classList.contains("on") }));
  c.ok(r.n === 1 && r.rel[0] === true && !r.on, "頼んでいる間に切ったら、届いた画面ロックをすぐ返す", r);
  await page.click("#bWake");
  await sleep(600);
  r = await page.evaluate(() => ({ rel: window.__wake.map((s) => s.released), on: document.getElementById("bWake").classList.contains("on") }));
  c.ok(r.rel[1] === false && r.on, "ふつうに入れたときは握ったまま、ボタンもONになる", r);
  await page.click("#bWake");
  r = await page.evaluate(() => window.__wake.map((s) => s.released));
  c.ok(r[1] === true, "切ったら返す", r);
  okErrors(errs, "画面ロック");
  await ctx.close();
}

// ── 8. 同期をはさんだタイトルの取得 ──
{
  console.log("同期をはさんだタイトルの取得");
  const drive = createFakeDrive();
  let release, seen = false;
  const held = new Promise((r) => { release = r; });
  const { page, errs, ctx } = await bgmPage({
    seed: { items: [item("h", { title: "(タイトル未取得)" })] }, drive, cid: true,
    before: (p) => p.route("https://www.youtube.com/oembed**", async (route) => {
      seen = true; await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ title: "取れたタイトル" }) });
    })
  });
  await waitFor(() => seen, { label: "タイトルの取得" });
  await page.click("#bSync"); await page.click("#bSyncNow");
  await waitFor(async () => { const it = await storedItem(page, "h"); return it && it.synced === 1; }, { label: "同期" });
  release();
  let got = null;
  try { await waitFor(async () => { const it = await storedItem(page, "h"); return it && it.title === "取れたタイトル"; }, { timeout: 4000 }); got = true; } catch (e) { got = false; }
  c.ok(got, "同期で一覧が入れ替わっても、取りに行ったタイトルを保存する", await storedItem(page, "h"));
  c.ok(await page.evaluate(() => document.getElementById("list").textContent.includes("取れたタイトル")), "一覧にも出る");
  okErrors(errs, "タイトル");
  await ctx.close();
}

// ── 9. シェルとのやりとり ──
{
  console.log("シェルとのやりとり");
  const SHELL = `<!doctype html><meta charset="utf-8"><body>
<script>window.__posts=[];window.postMessage=function(m,t){window.__posts.push({m:m,t:t});};</script>
<iframe id="f" src="bgm.html" style="width:800px;height:600px"></iframe></body>`;
  const { page, errs, ctx } = await bgmPage({
    seed: { items: [] }, path: "__shell.html",
    before: (p) => p.route(srv.url + "__shell.html", (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: SHELL }))
  });
  await waitFor(() => page.frames().find((f) => /bgm\.html/.test(f.url())), { label: "フレーム" });
  const fr = page.frames().find((f) => /bgm\.html/.test(f.url()));
  await fr.waitForFunction(() => window.__yt && window.__yt.ready);
  await waitFor(() => page.evaluate(() => window.__posts.some((p) => p.m && p.m.nkSound)), { label: "送信" });
  const targets = await page.evaluate(() => window.__posts.filter((p) => p.m && p.m.nkSound).map((p) => p.t));
  c.ok(targets.length > 0 && targets.every((t) => t === ORIGIN), "シェルへは同じオリジンを指定して送る", targets);
  const shown = () => fr.evaluate(() => { const t = document.getElementById("toast"); return t.style.display !== "none" && t.textContent.includes("音源の実体"); });
  await fr.evaluate(() => window.postMessage({ nkSoundState: { id: null, playing: false, err: "missing" } }, "*"));
  await sleep(300);
  c.ok(!(await shown()), "親以外からの知らせは受け取らない");
  await page.evaluate(() => document.getElementById("f").contentWindow.postMessage({ nkSoundState: { id: null, playing: false, err: "missing" } }, location.origin));
  await sleep(300);
  c.ok(await shown(), "親（シェル）からの知らせは受け取る");
  okErrors(errs, "シェル");
  await ctx.close();
}

// ── 10. 暗室: 全消去と同期 ──
function localDay(ms) { const d = new Date(ms); const p = (n) => (n < 10 ? "0" : "") + n; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
function rec(ts, scene) { return { date: localDay(ts), ts, sec: 300, scene, note: "", vivid: null }; }
async function imgPage({ drive, history = [], cleared = null, skewMs = 0, init = [] }) {
  const ctx = await newDevice(br, { drive });
  const page = await ctx.newPage();
  const errs = collectErrors(page);
  if (skewMs) await page.addInitScript((off) => { const n = Date.now; Date.now = () => n() + off; }, skewMs);
  for (const s of init) await page.addInitScript(s);
  await page.addInitScript(({ history, cleared }) => {
    if (sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    localStorage.setItem("image-streaming:v1", JSON.stringify(history));
    if (cleared != null) localStorage.setItem("image-streaming:clearedAt", cleared);
    localStorage.setItem("shared:gd:cid", "test-client");
  }, { history, cleared });
  await page.goto(srv.url + "image-streaming.html");
  return { ctx, page, errs };
}
async function imgSync(page) {
  if (!(await page.isVisible("#bSyncNow"))) await page.click("#bSync");
  await page.click("#bSyncNow");
  await waitFor(async () => !/同期しています/.test(await page.textContent("#syncMsg")), { label: "同期" });
  return page.textContent("#syncMsg");
}
const imgHist = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("image-streaming:v1") || "[]").map((h) => h.scene));
const driveSec = (drive) => { const f = drive.byName("nikki-apps-data.json")[0]; return f ? drive.json(f.id).apps.anshitsu : null; };
{
  console.log("暗室: 全消去と同期");
  const drive = createFakeDrive();
  const T0 = Date.now() - 3 * 864e5;
  const r1 = rec(T0, "一"), r2 = rec(T0 + 864e5, "二");
  // A: 時計が1日進んでいる端末で全消去する
  const A = await imgPage({ drive, history: [r1, r2], skewMs: 864e5 });
  await imgSync(A.page);
  await A.page.click("#clearBtn"); await A.page.click("#clearYes");
  await imgSync(A.page);
  const secA = driveSec(drive);
  c.ok(secA && secA.history.length === 0 && Array.isArray(secA.clearedKeys) && secA.clearedKeys.includes(String(T0)) && !secA.clearedAt,
    "全消去は消した記録の鍵を送り、消した時刻は作らない", secA);
  // B: 正しい時計の端末。A が消したあとで練習を記録した（A の時計の「消去時刻」よりは前になる）
  const r3 = rec(Date.now(), "三");
  const B = await imgPage({ drive, history: [r1, r2, r3] });
  const msgB = await imgSync(B.page);
  c.ok(JSON.stringify(await imgHist(B.page)) === JSON.stringify(["三"]), "時計のずれた端末の全消去で、ほかの端末の新しい記録まで消さない", { hist: await imgHist(B.page), msgB });
  c.ok(JSON.stringify(driveSec(drive).history.map((h) => h.scene)) === JSON.stringify(["三"]), "消した記録はドライブでも復活しない", driveSec(drive));
  await imgSync(A.page);
  c.ok(JSON.stringify(await imgHist(A.page)) === JSON.stringify(["三"]), "消した端末にも、ほかの端末の新しい記録は届く", await imgHist(A.page));
  const kept = await A.page.evaluate(() => JSON.parse(localStorage.getItem("image-streaming:clearedAt")));
  c.ok(kept && Array.isArray(kept.keys) && kept.keys.length === 2, "消した記録の鍵はこの端末にも残す（バックアップにも入る置き場）", kept);
  okErrors(A.errs, "暗室A"); okErrors(B.errs, "暗室B");
  await A.ctx.close(); await B.ctx.close();
}
{
  // 旧版の端末が消した（時刻だけを持つ）データも効く
  const L = Date.now() - 3600e3;
  const r4 = rec(L - 5000, "旧"), r5 = rec(L + 5000, "新");
  const d1 = createFakeDrive();
  d1.put("nikki-apps-data.json", { app: "nikki-sync", v: 1, apps: { anshitsu: { history: [r4], clearedAt: L } } });
  const C = await imgPage({ drive: d1, history: [r4, r5] });
  await imgSync(C.page);
  c.ok(JSON.stringify(await imgHist(C.page)) === JSON.stringify(["新"]), "旧版の端末の全消去（時刻）より前の記録は消す", await imgHist(C.page));
  c.ok(driveSec(d1).clearedAt === L, "旧版の端末のために、受け取った消去時刻は持ち回る", driveSec(d1));
  const d2 = createFakeDrive();
  d2.put("nikki-apps-data.json", { app: "nikki-sync", v: 1, apps: { anshitsu: { history: [] } } });
  const D = await imgPage({ drive: d2, history: [r4, r5], cleared: String(L) });   // この端末に旧版の形（数字だけ）で残っている
  await imgSync(D.page);
  c.ok(JSON.stringify(await imgHist(D.page)) === JSON.stringify(["新"]), "この端末に残る旧版の形の消去時刻も読む", await imgHist(D.page));
  okErrors(C.errs, "暗室C"); okErrors(D.errs, "暗室D");
  await C.ctx.close(); await D.ctx.close();
}

// ── 11. 暗室: 再開で音の出口を起こし直す ──
const AUDIO_SPY = `(() => {
  const A = window.AudioContext; if (!A) return;
  const r = A.prototype.resume; window.__resumes = 0;
  A.prototype.resume = function () { window.__resumes++; return r.apply(this, arguments); };
  const C = function (o) { const c = new A(o); window.__ctx = c; return c; };
  C.prototype = A.prototype;
  window.AudioContext = C; window.webkitAudioContext = C;
})();`;
{
  console.log("暗室: 再開");
  const { page, errs, ctx } = await imgPage({ drive: null, init: [AUDIO_SPY] });
  await page.click("#beginBtn");
  await waitFor(() => page.evaluate(() => !!window.__ctx), { label: "音の出口" });
  await page.evaluate(() => document.getElementById("playPauseBtn").click());       // 一時停止
  await page.evaluate(() => window.__ctx.suspend());                                  // 着信などで止められた
  const n0 = await page.evaluate(() => window.__resumes);
  await page.click("#playPauseBtn");                                                  // 再開（タップ）
  const r = await page.evaluate(() => ({ n: window.__resumes, phase: document.getElementById("ctlRun").hidden }));
  c.ok(r.n > n0, "一時停止からの再開で、止められていた音の出口を起こし直す", { n0, ...r });
  await waitFor(() => page.evaluate(() => window.__ctx.state === "running"), { timeout: 3000, label: "running" }).catch(() => {});
  c.ok(await page.evaluate(() => window.__ctx.state === "running"), "音の出口が動いている");
  okErrors(errs, "暗室の再開");
  await ctx.close();
}

await br.close();
await srv.close();
c.done();
