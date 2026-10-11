/* 気になり帳クリッパー（kininari-clipper/ の Chrome拡張）の検証
     node .tools/test-fix-clipper.mjs           … 単体（chrome API の偽物）＋ 実際の Chromium
     node .tools/test-fix-clipper.mjs --unit    … 単体だけ
   単体: background.js / popup.js を vm で読み込み、chrome API と時計を偽物にして確かめる
   - 送り直しても同じ番号（?kn_clip= と中身の k）。元の ?… は残し、古い kn_clip は付け直す
   - アプリの結果（saved / dup / quota / parse / 旧版の __kininariClipSaved）の受け取り方
   - 転送で許可の無いオリジンに移ったら「未確認」（blind）にする（20秒待って「確認できず」にしない）
   - 復元されたタブを kn_clip の番号で見つけて片付ける
   - シークレットから保存しても裏タブは通常のウィンドウに開く
   - 閲覧履歴の権限があれば、kn_clip の付いたURLだけを履歴から消す
   - ページの読み取りが返ってこなくても 1.5 秒でタイトルとURLに切り替える
   - 二度押しで裏タブが2つ開かない
   配布ZIP: clipper.html に埋め込んだZIPがフォルダと同じか（.tools/build-clipper.py --check）
   実ブラウザ: 拡張を読み込んだ Chromium で、偽の気になり帳に保存して結果・転送・履歴を確かめる */
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { ROOT, startServer, makeChecker, sleep, waitFor } from "./lib/harness.mjs";

const c = makeChecker("kininari-clipper");
const EXT = path.join(ROOT, "kininari-clipper");
const BG = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
const POPUP = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
const KN = "https://kn.example/app/kininari.html";

// ── 偽の時計（setTimeout と Date.now を進められる） ──
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
function fakeClock() {
  let now = 1_800_000_000_000, seq = 0;
  const timers = new Map();
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  }
  return {
    Date: FakeDate,
    setTimeout: (fn, ms, ...a) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, a }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    get now() { return now; },
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        timers.delete(next.id);
        now = next.t.at;
        next.t.fn(...next.t.a);
      }
      now = end;
      await flush();
    }
  };
}

// ── 偽の chrome API ──
function originOf(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin + "/*" : null; } catch (e) { return null; }
}
function fakeChrome(clock, opts = {}) {
  const ev = () => { const list = []; return { list, addListener: (fn, filter) => list.push({ fn, filter }), fire: (...a) => list.map((x) => x.fn(...a)) }; };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const area = (init = {}) => {
    const data = clone(init);
    return {
      data,
      get: async (k) => {
        const keys = k == null ? Object.keys(data) : Array.isArray(k) ? k : typeof k === "string" ? [k] : Object.keys(k);
        const o = {};
        for (const key of keys) if (key in data) o[key] = clone(data[key]);
        return o;
      },
      set: async (o) => { for (const [k, v] of Object.entries(o)) data[k] = clone(v); },
      remove: async (k) => { for (const key of [].concat(k)) delete data[key]; }
    };
  };
  const granted = { origins: new Set(opts.origins || []), permissions: new Set(opts.permissions || []) };
  const permitted = (url) => { const o = originOf(url); return !!o && granted.origins.has(o); };
  const tabs = new Map();
  let nextTab = 100;
  const windows = opts.windows || [{ id: 1, incognito: false, focused: true }];
  const history = (opts.history || []).map((h) => ({ ...h }));
  const calls = { create: [], remove: [], winCreate: [], deleteUrl: [], exec: [], request: [], sendMessage: [], badge: [] };
  const view = (t) => {
    const o = { id: t.id, windowId: t.windowId, status: t.status || "complete", active: false, incognito: !!t.incognito };
    if (permitted(t.url)) { o.url = t.url; o.title = t.title || ""; }
    return o;
  };
  const addTab = (t) => { const tab = { id: t.id != null ? t.id : nextTab++, windowId: 1, frames: [{}], ...t }; tabs.set(tab.id, tab); return tab; };
  for (const t of opts.tabs || []) addTab(t);
  const chrome = {
    runtime: { onMessage: ev(), onStartup: ev(), onInstalled: ev(), lastError: undefined,
      sendMessage: (msg, cb) => { calls.sendMessage.push({ msg, cb }); } },
    storage: { session: area(opts.session), local: area(opts.local), sync: area(opts.sync) },
    permissions: {
      contains: async (q) => (q.origins || []).every((o) => granted.origins.has(o)) && (q.permissions || []).every((p) => granted.permissions.has(p)),
      request: (q) => { calls.request.push(q); return Promise.resolve(true); }
    },
    tabs: {
      // 本物の Chrome と同じく、tabs.onUpdated に絞り込みを渡すと例外にする
      // （トップレベルで投げると Service Worker の登録ごと失敗し、メッセージが届かなくなる）
      onUpdated: (() => { const e = ev(); const add = e.addListener; e.addListener = (fn, filter) => { if (filter !== undefined) throw new Error("This event does not support filters"); add(fn); }; return e; })(),
      onRemoved: ev(),
      get: async (id) => { const t = tabs.get(id); if (!t) throw new Error("No tab with id: " + id); return view(t); },
      query: async (q) => (q && q.active ? (opts.activeTab ? [opts.activeTab] : []) : [...tabs.values()].map(view)),
      create: async (p) => {
        calls.create.push(p);
        const w = windows.find((x) => x.id === p.windowId) || windows.find((x) => x.focused) || windows[0];
        const t = addTab({ url: p.url, windowId: w ? w.id : 0, incognito: !!(w && w.incognito), status: "loading" });
        if (opts.onCreate) opts.onCreate(t);
        return view(t);
      },
      remove: (id, cb) => {
        calls.remove.push(id);
        const had = tabs.delete(id);
        chrome.runtime.lastError = had ? undefined : { message: "No tab" };
        clock.setTimeout(() => chrome.tabs.onRemoved.fire(id, {}), 0);
        if (cb) cb();
        chrome.runtime.lastError = undefined;
      }
    },
    windows: {
      getAll: async () => windows.map((w) => ({ ...w })),
      create: async (p) => {
        calls.winCreate.push(p);
        const w = { id: 900 + calls.winCreate.length, incognito: !!p.incognito, focused: !!p.focused };
        windows.push(w);
        const t = addTab({ url: p.url, windowId: w.id, status: "loading" });
        return { ...w, tabs: [view(t)] };
      }
    },
    scripting: {
      executeScript: async (p) => {
        calls.exec.push(p);
        if (opts.exec) return opts.exec(p);
        const t = tabs.get(p.target.tabId);
        if (!t) throw new Error("No tab");
        if (!permitted(t.url)) throw new Error("Cannot access contents of the page");
        if (t.status !== "complete") throw new Error("Frame not ready");
        return t.frames.map((fr) => { sandboxOf.current.window = fr; return { result: p.func(...(p.args || [])) }; });
      }
    },
    alarms: { onAlarm: ev(), get: async () => null, create: () => {}, clear: async () => true },
    action: {
      setBadgeText: async (o) => { calls.badge.push(o.text); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {}
    },
    history: {
      search: async (q) => history.filter((h) => (h.lastVisitTime || 0) >= (q.startTime || 0)).map((h) => ({ ...h })),
      deleteUrl: async ({ url }) => { calls.deleteUrl.push(url); for (let i = history.length - 1; i >= 0; i--) if (history[i].url === url) history.splice(i, 1); }
    }
  };
  return { chrome, tabs, windows, history, calls, granted, addTab };
}
const sandboxOf = { current: null };

function load(code, file, env, extra = {}) {
  const sandbox = { chrome: env.chrome, setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimeout, Date: env.clock.Date,
    URL, URLSearchParams, console, crypto: webcrypto, ...extra };
  sandboxOf.current = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  return { sandbox, get: (expr) => vm.runInContext(expr, sandbox) };
}

function bgEnv(opts = {}) {
  const clock = fakeClock();
  const f = fakeChrome(clock, opts);
  const env = { clock, ...f };
  env.bg = load(BG, "background.js", env);
  env.clip = (url) => new Promise((resolve) => {
    const r = env.chrome.runtime.onMessage.fire({ type: "clip", url }, {}, (resp) => resolve(resp));
    env.async = r[0];
  });
  return env;
}

const clipUrl = (base, id, extra = {}) => base + (base.includes("?") ? "&" : "?") + "kn_clip=" + id + "#knadd=" +
  encodeURIComponent(JSON.stringify({ t: "記事", u: "https://news.example/a", n: "メモ", img: "", c: "調べる", f: "", k: id, ...extra }));

// ── 1. 背景: リスナーはトップレベル。tabs.onUpdated（どのタブの更新でも起こされる）は使わない ──
{
  const env = bgEnv();
  const ch = env.chrome;
  c.ok(ch.runtime.onMessage.list.length === 1 && ch.tabs.onRemoved.list.length === 1 && ch.alarms.onAlarm.list.length === 1 &&
       ch.runtime.onStartup.list.length === 1 && ch.runtime.onInstalled.list.length === 1,
       "リスナーは読み込んだ時点（トップレベル）で全部そろっている");
  c.ok(ch.tabs.onUpdated.list.length === 0, "tabs.onUpdated は登録しない（関係ないタブの更新で Service Worker を起こさない）");
  // Service Worker が止められていた場合も、alarms の点検から見張りに戻る
  const url = clipUrl(KN, "0".repeat(32));
  const env2 = bgEnv({ origins: ["https://kn.example/*"],
    session: { knPending: { 100: { url, origin: "https://kn.example/*", startedAt: 1_800_000_000_000, hardAt: 1_800_000_025_000, reported: "" } } },
    tabs: [{ id: 100, url, status: "complete", frames: [{ __kininariClipStatus: "saved" }] }] });
  await env2.clock.tick(10); // 起き直したときの sweep()
  c.ok(env2.calls.remove.includes(100), "起き直したとき（sweep）に、残っていた裏タブの見張りを引き継いで閉じる");
}

// ── 2. 背景: アプリの結果（saved / dup / quota / parse / 旧版） ──
async function runStatus(setPage, label, want, opts = {}) {
  const env = bgEnv({ origins: ["https://kn.example/*"], ...opts });
  const url = clipUrl(KN, "a".repeat(32));
  const p = env.clip(url);
  await env.clock.tick(600);
  const tab = [...env.tabs.values()][0];
  tab.status = "complete";
  setPage(tab);
  const t0 = env.clock.now;
  await env.clock.tick(1500);
  const resp = await Promise.race([p, sleep(50).then(() => null)]);
  c.ok(resp && resp.status === want.status && resp.ok === want.ok, label + " → " + want.status + "（ok=" + want.ok + "）", resp);
  c.ok(env.calls.remove.includes(tab.id) && env.clock.now - t0 < 5000, label + ": すぐに裏タブを閉じる（20秒待たない）");
  return env;
}
{
  await runStatus((t) => { t.frames[0].__kininariClipStatus = "saved"; t.frames[0].__kininariClipSaved = true; }, "saved", { status: "saved", ok: true });
  const dup = await runStatus((t) => { t.frames[0].__kininariClipStatus = "dup"; t.frames[0].__kininariClipSaved = true; }, "dup", { status: "dup", ok: true });
  c.ok(dup.calls.badge.includes("✓"), "dup のバッジは ✓");
  const q = await runStatus((t) => { t.frames[0].__kininariClipStatus = "quota"; }, "quota", { status: "quota", ok: false });
  c.ok(q.calls.badge.includes("!"), "quota のバッジは !");
  await runStatus((t) => { t.frames[0].__kininariClipStatus = "parse"; }, "parse", { status: "parse", ok: false });
  await runStatus((t) => { t.frames[0].__kininariClipSaved = true; }, "旧版（__kininariClipSaved だけ）", { status: "saved", ok: true });
  // 結合アプリ index.html: 外側のフレームには無く、iframe の中に立つ
  await runStatus((t) => { t.frames = [{}, { __kininariClipStatus: "dup", __kininariClipSaved: true }]; }, "iframe の中の結果", { status: "dup", ok: true });
  // 何も立たなければ従来どおり 20 秒で「確認できず」
  const env = bgEnv({ origins: ["https://kn.example/*"] });
  const p = env.clip(clipUrl(KN, "b".repeat(32)));
  await env.clock.tick(500);
  [...env.tabs.values()][0].status = "complete";
  await env.clock.tick(19000);
  c.ok(!(await Promise.race([p, sleep(20).then(() => null)])), "結果が立たないうちは待ち続ける（19秒時点）");
  await env.clock.tick(2000);
  const r = await Promise.race([p, sleep(50).then(() => null)]);
  c.ok(r && r.status === "unconfirmed", "結果が立たなければ 20 秒で unconfirmed", r);
}

// ── 3. 背景: 転送で別のオリジンに移ったら blind（許可が無いので確認できない） ──
{
  // http で許可 → https へ転送（GitHub Pages）。https 側の許可は無い
  const env = bgEnv({ origins: ["http://kn.example/*"] });
  const httpBase = KN.replace("https:", "http:");
  const p = env.clip(clipUrl(httpBase, "c".repeat(32)));
  await env.clock.tick(300);
  const tab = [...env.tabs.values()][0];
  tab.url = tab.url.replace("http:", "https:"); // 301 で https へ
  tab.status = "complete";
  tab.frames[0].__kininariClipStatus = "saved";   // 保存はされているが、読めない
  await env.clock.tick(1000);
  const r = await Promise.race([p, sleep(50).then(() => null)]);
  c.ok(r && r.status === "blind", "転送先のオリジンに許可が無い → すぐ blind を返す", r);
  c.ok(r && /転送/.test(r.err || ""), "blind に「転送された」直し方を添える", r && r.err);
  c.ok(!env.calls.remove.includes(tab.id), "blind でもタブはすぐには閉じない（保存の時間をみる）");
  await env.clock.tick(8000);
  c.ok(env.calls.remove.includes(tab.id), "blind は 8 秒で閉じる（20秒待って unconfirmed にしない）");
  const last = env.chrome.storage.session.data.knLastResult;
  c.ok(last && last.status === "blind" && /転送/.test(last.err), "直近の結果は blind（直し方つき）", last);
}
{
  // http と https の両方を許可していれば、転送されても確かめられる
  const env = bgEnv({ origins: ["http://kn.example/*", "https://kn.example/*"] });
  const p = env.clip(clipUrl(KN.replace("https:", "http:"), "d".repeat(32)));
  await env.clock.tick(300);
  const tab = [...env.tabs.values()][0];
  tab.url = tab.url.replace("http:", "https:");
  tab.status = "complete";
  tab.frames[0].__kininariClipStatus = "saved";
  await env.clock.tick(1000);
  const r = await Promise.race([p, sleep(50).then(() => null)]);
  c.ok(r && r.status === "saved", "両方許可していれば転送先で saved を確かめられる", r);
}
{
  // 許可がまったく無いときは従来どおり（直し方は添えない）
  const env = bgEnv({ origins: [] });
  const p = env.clip(clipUrl(KN, "e".repeat(32)));
  await env.clock.tick(600);
  const r = await Promise.race([p, sleep(50).then(() => null)]);
  c.ok(r && r.status === "blind" && !r.err, "許可が無いときは blind（説明なし）", r);
}

// ── 4. 背景: 閲覧履歴から kn_clip の付いたURLだけを消す ──
{
  const id = "f".repeat(32);
  const url = clipUrl(KN, id);
  const now = 1_800_000_000_000;
  const env = bgEnv({ origins: ["https://kn.example/*"], permissions: ["history"], history: [
    { url, lastVisitTime: now + 100 },
    { url: url.split("#")[0], lastVisitTime: now + 200 },                         // アプリが #knadd を消したあと
    { url: url.split("#")[0].replace("kn_clip=", "x=1&kn_clip="), lastVisitTime: now + 300 }, // 転送などで形が変わったもの
    { url: "https://news.example/a", lastVisitTime: now + 50 },                   // 関係ない履歴
    { url: KN + "?kn_clip=" + "9".repeat(32), lastVisitTime: now + 60 }            // 別のクリップ
  ] });
  const p = env.clip(url);
  await env.clock.tick(500);
  const tab = [...env.tabs.values()][0];
  tab.status = "complete";
  tab.frames[0].__kininariClipStatus = "saved";
  await env.clock.tick(1000);
  await Promise.race([p, sleep(50)]);
  await flush();
  const left = env.history.map((h) => h.url);
  c.ok(!left.some((u) => u.includes("kn_clip=" + id)), "このクリップの kn_clip が付いたURLは履歴から全部消す", left);
  c.ok(left.includes("https://news.example/a") && left.some((u) => u.includes("9".repeat(32))), "ほかの履歴（別のクリップを含む）は消さない", left);

  const env2 = bgEnv({ origins: ["https://kn.example/*"], history: [{ url, lastVisitTime: now + 100 }] });
  const p2 = env2.clip(url);
  await env2.clock.tick(500);
  const tab2 = [...env2.tabs.values()][0];
  tab2.status = "complete";
  tab2.frames[0].__kininariClipSaved = true;
  await env2.clock.tick(1000);
  await Promise.race([p2, sleep(50)]);
  await flush();
  c.ok(env2.calls.deleteUrl.length === 0, "閲覧履歴の許可が無ければ履歴には触らない");
}

// ── 5. 背景: シークレットから保存しても通常のウィンドウに開く ──
{
  const env = bgEnv({ windows: [{ id: 7, incognito: true, focused: true }, { id: 8, incognito: false, focused: false }] });
  env.clip(clipUrl(KN, "1".repeat(32)));
  await env.clock.tick(10);
  const cr = env.calls.create[0];
  c.ok(cr && cr.windowId === 8 && cr.active === false, "通常のウィンドウ（id 8）に、前に出さずに開く", cr);
  c.ok([...env.tabs.values()].every((t) => !t.incognito), "裏タブはシークレットではない");

  const env2 = bgEnv({ windows: [{ id: 7, incognito: true, focused: true }] });
  const p2 = env2.clip(clipUrl(KN, "2".repeat(32)));
  await env2.clock.tick(10);
  const wc = env2.calls.winCreate[0];
  c.ok(wc && wc.incognito === false && wc.focused === false && env2.calls.create.length === 0, "通常のウィンドウが無ければ、前に出さない新しいウィンドウに開く", wc);
  await env2.clock.tick(9000);
  const r2 = await Promise.race([p2, sleep(50).then(() => null)]);
  c.ok(r2 && r2.status === "blind", "新しいウィンドウのタブもいつもどおり見張って閉じる", r2);
}

// ── 6. 背景: 復元されたタブを kn_clip の番号で見つける ──
{
  const done = clipUrl(KN, "3".repeat(32));     // 前回のうちにアプリが受け取った（#knadd が消えている）
  const yet = clipUrl(KN, "4".repeat(32));      // まだ受け取っていない（#knadd が残っている）
  const other = KN + "?kn_clip=" + "5".repeat(32); // 控えに無い番号（ユーザーが自分で開いたタブなど）
  const env = bgEnv({
    origins: ["https://kn.example/*"],
    local: { knOpened: [done, yet, "https://old.example/kininari.html#knadd=x"] },
    tabs: [
      { id: 11, url: done.split("#")[0], status: "complete" },
      { id: 12, url: yet, status: "complete" },
      { id: 13, url: other, status: "complete" },
      { id: 14, url: "https://news.example/a", status: "complete" }
    ]
  });
  env.chrome.runtime.onStartup.fire();
  await env.clock.tick(100);
  c.ok(env.calls.remove.includes(11), "取り込み済み（#knadd が消えた）のタブは番号で見つけてすぐ閉じる", env.calls.remove);
  c.ok(!env.calls.remove.includes(13) && !env.calls.remove.includes(14), "控えに無い番号のタブ・関係ないタブには触らない");
  c.ok(!env.calls.remove.includes(12), "#knadd が残っているタブは、アプリの取り込みを待つ");
  env.tabs.get(12).frames[0].__kininariClipStatus = "saved";
  await env.clock.tick(1000);
  c.ok(env.calls.remove.includes(12), "#knadd が残っていたタブも、保存を確かめて閉じる");
  await env.clock.tick(100);
  const opened = env.chrome.storage.local.data.knOpened;
  c.ok(Array.isArray(opened) && opened.length === 0, "片付いたら控えから消える", opened);
  const last = env.chrome.storage.session.data.knLastResult;
  c.ok(!last || last.status === "saved" || last.status === "blind", "起動時に「確認できませんでした」を出さない", last);

  // 許可が無いとURLが読めないので、何もしない
  const env2 = bgEnv({ origins: [], local: { knOpened: [done] }, tabs: [{ id: 21, url: done.split("#")[0], status: "complete" }] });
  env2.chrome.runtime.onStartup.fire();
  await env2.clock.tick(100);
  c.ok(env2.calls.remove.length === 0, "許可が無いときは（見分けられないので）何もしない");
}

// ── 7. 背景: 手で閉じられたら closed（これまでどおり） ──
{
  const env = bgEnv({ origins: ["https://kn.example/*"] });
  const p = env.clip(clipUrl(KN, "6".repeat(32)));
  await env.clock.tick(300);
  const tab = [...env.tabs.values()][0];
  env.tabs.delete(tab.id);
  env.chrome.tabs.onRemoved.fire(tab.id, {});
  await env.clock.tick(10);
  const r = await Promise.race([p, sleep(50).then(() => null)]);
  c.ok(r && r.status === "closed", "裏タブを手で閉じたら closed", r);
}

// ── ポップアップ ──
function fakeEl(id) {
  const h = {}, cls = new Set();
  return {
    id, value: "", textContent: "", disabled: false, innerHTML: "", children: [], selected: false,
    classList: { add: (...a) => a.forEach((x) => cls.add(x)), remove: (...a) => a.forEach((x) => cls.delete(x)),
      toggle: (x, on) => { if (on === undefined ? !cls.has(x) : on) cls.add(x); else cls.delete(x); }, contains: (x) => cls.has(x) },
    appendChild(ch) { this.children.push(ch); },
    addEventListener(t, fn) { (h[t] = h[t] || []).push(fn); },
    // 本物のボタンは disabled だとクリックが届かないが、届いてしまった場合（同時に積まれた
    // クリックなど）も確かめたいので、ここでは disabled でもハンドラを呼ぶ
    fire(t) { return (h[t] || []).map((fn) => fn({ preventDefault() {} })); }
  };
}
async function popupEnv(opts = {}) {
  const clock = fakeClock();
  const f = fakeChrome(clock, {
    activeTab: { id: 5, title: "タブのタイトル", url: "https://news.example/a" },
    sync: { kininariUrl: opts.kurl || KN },
    ...opts
  });
  const els = {};
  const ids = ["title", "url", "note", "cat", "folder", "save", "gear", "status", "notice", "settings", "kurl", "perm", "permMsg"];
  for (const id of ids) els[id] = fakeEl(id);
  els.save.disabled = true;
  els.perm.disabled = false;
  let closed = 0;
  const document = { getElementById: (id) => els[id], createElement: () => fakeEl("") };
  const env = { clock, ...f, els, get closed() { return closed; } };
  env.pop = load(POPUP, "popup.js", env, { document, window: { close: () => { closed++; } } });
  await clock.tick(opts.initMs || 0);
  els.cat.value = "調べる";
  return env;
}
const knaddOf = (url) => JSON.parse(decodeURIComponent(url.split("#knadd=")[1]));

// ── 8. ポップアップ: URL の組み立て（元の ?… を残し、kn_clip と #knadd を付ける） ──
{
  const env = await popupEnv({ exec: async () => [{ result: { title: "記事のタイトル", url: "https://news.example/a", selection: "選んだ文", cut: false, img: "", desc: "" } }] });
  const id = env.pop.get("CLIP_ID");
  c.ok(/^[0-9a-f]{32}$/.test(id), "クリップの番号は16進32文字", id);
  const clipBase = env.pop.get("clipBase");
  c.ok(clipBase("https://h.example/app/kininari.html", id) === "https://h.example/app/kininari.html?kn_clip=" + id, "? が無ければ ?kn_clip= を付ける");
  c.ok(clipBase("https://h.example/k.html?a=1&b=%20x#old", id) === "https://h.example/k.html?a=1&b=%20x&kn_clip=" + id, "元の ?… はそのまま残し、# 以降は落とす");
  c.ok(clipBase("https://h.example/k.html?kn_clip=old&a=1", id) === "https://h.example/k.html?a=1&kn_clip=" + id, "古い kn_clip は外して付け直す（二重にしない）");
  c.ok(clipBase("https://h.example/k.html?", id) === "https://h.example/k.html?kn_clip=" + id, "空の ? でも壊れない");

  env.els.kurl.value = "https://kn.example/app/kininari.html?theme=dark#x";
  env.els.note.value = "メモ本文";
  env.els.save.fire("click");
  await env.clock.tick(10);
  const sent = env.calls.sendMessage[0];
  c.ok(sent && sent.msg.url.startsWith("https://kn.example/app/kininari.html?theme=dark&kn_clip=" + id + "#knadd="), "送るURLは <保存先>?theme=dark&kn_clip=<番号>#knadd=…", sent && sent.msg.url.slice(0, 120));
  const clip = sent && knaddOf(sent.msg.url);
  c.ok(clip && clip.k === id && clip.n === "メモ本文" && clip.u === "https://news.example/a" && clip.t === "記事のタイトル", "中身の k に同じ番号、n はメモのまま", clip);
  c.ok(new URL(sent.msg.url).searchParams.get("kn_clip") === id, "URLSearchParams で kn_clip を読める");

  // ── 9. 送り直しても同じ番号 ──
  sent.cb({ ok: false, status: "closed", err: "" });
  await env.clock.tick(10);
  c.ok(env.els.save.disabled === false, "失敗したら保存ボタンは押せる状態に戻る");
  env.els.save.fire("click");
  await env.clock.tick(10);
  const again = env.calls.sendMessage[1];
  c.ok(again && knaddOf(again.msg.url).k === id && new URL(again.msg.url).searchParams.get("kn_clip") === id, "同じポップアップで送り直しても番号は同じ");
  const env2 = await popupEnv({ exec: async () => [{ result: { title: "t", url: "https://news.example/a" } }] });
  c.ok(env2.pop.get("CLIP_ID") !== id, "ポップアップを開き直せば別の番号");
}

// ── 10. ポップアップ: 二度押しでも1回しか送らない ──
{
  const env = await popupEnv({ exec: async () => [{ result: { title: "t", url: "https://news.example/a" } }] });
  env.els.save.fire("click");
  c.ok(env.els.save.disabled === true, "押した直後（最初の await より前）にボタンを止める");
  env.els.save.fire("click");
  await env.clock.tick(10);
  c.ok(env.calls.sendMessage.length === 1, "続けて押しても送るのは1回（裏タブは1つ）", env.calls.sendMessage.length);
}

// ── 11. ポップアップ: ページの読み取りが返ってこないとき ──
{
  const env = await popupEnv({ exec: () => new Promise(() => {}) });
  c.ok(env.els.save.disabled === true, "読み取り中は保存ボタンは押せない");
  await env.clock.tick(1400);
  c.ok(env.els.save.disabled === true, "1.4 秒ではまだ待つ");
  await env.clock.tick(200);
  c.ok(env.els.save.disabled === false, "1.5 秒で見切って保存ボタンを押せるようにする");
  c.ok(env.els.title.value === "タブのタイトル" && env.els.url.textContent === "https://news.example/a", "タブのタイトルとURLで続ける", [env.els.title.value, env.els.url.textContent]);
  c.ok(/間に合わなかった/.test(env.els.notice.textContent), "読み取りが間に合わなかったと伝える", env.els.notice.textContent);
  const env2 = await popupEnv({ exec: async () => { throw new Error("Cannot access"); } });
  c.ok(/PDF/.test(env2.els.notice.textContent) && env2.els.save.disabled === false, "読めないページ（PDFなど）はこれまでどおり");
}

// ── 12. ポップアップ: 結果の出し方 ──
async function popupResult(resp) {
  const env = await popupEnv({ exec: async () => [{ result: { title: "t", url: "https://news.example/a" } }] });
  env.els.save.fire("click");
  await env.clock.tick(10);
  env.calls.sendMessage[0].cb(resp);
  await env.clock.tick(5000);
  return env;
}
{
  let e = await popupResult({ ok: true, status: "saved", err: "" });
  c.ok(/保存しました ✓/.test(e.els.status.textContent) && e.closed === 1, "saved: 保存しました ✓ で閉じる");
  e = await popupResult({ ok: true, status: "dup", err: "" });
  c.ok(/もう保存してありました/.test(e.els.status.textContent) && !e.els.status.classList.contains("err") && e.closed === 1, "dup: 「もう保存してありました」（成功扱い）で閉じる", e.els.status.textContent);
  e = await popupResult({ ok: false, status: "quota", err: "" });
  c.ok(/容量がいっぱい/.test(e.els.status.textContent) && e.els.status.classList.contains("err") && e.closed === 0 && e.els.save.disabled === false, "quota: 容量がいっぱい（エラー・送り直せる）", e.els.status.textContent);
  e = await popupResult({ ok: false, status: "parse", err: "" });
  c.ok(/受け取れない形式/.test(e.els.status.textContent) && e.els.status.classList.contains("err") && e.closed === 0, "parse: 受け取れない形式（エラー）", e.els.status.textContent);
  e = await popupResult({ ok: false, status: "blind", err: "保存先が別のアドレス（https:// など）へ転送されたため、…" });
  c.ok(/転送/.test(e.els.notice.textContent) && e.closed === 0, "blind（転送）: 直し方を出して、読めるよう閉じない", e.els.notice.textContent);
  e = await popupResult({ ok: false, status: "blind", err: "" });
  c.ok(/許可する/.test(e.els.notice.textContent) && e.closed === 1, "blind（許可なし）: これまでどおり案内して閉じる");
}

// ── 13. ポップアップ: 前回の結果 ──
{
  const at = 1_800_000_000_000;
  for (const [status, re] of [["quota", /容量がいっぱい/], ["parse", /受け取れない形式/], ["dup", /^$/], ["saved", /^$/]]) {
    const env = await popupEnv({ session: { knLastResult: { status, err: "", at } }, exec: async () => [{ result: { title: "t", url: "https://news.example/a" } }] });
    c.ok(re.test(env.els.notice.textContent), "前回の結果 " + status + " の出し方", env.els.notice.textContent);
  }
}

// ── 14. ポップアップ: 許可の求め方（http なら https 側も・履歴も一緒に・押した直後に） ──
{
  const env = await popupEnv({ kurl: "http://kn.example/app/kininari.html", exec: async () => [{ result: { title: "t", url: "https://news.example/a" } }] });
  await env.clock.tick(10);
  c.ok(/https:\/\//.test(env.els.permMsg.textContent) && env.els.permMsg.classList.contains("err"), "http の保存先には https を使うよう注意を出す", env.els.permMsg.textContent);
  env.els.perm.fire("click");
  const req = env.calls.request[0]; // await を挟まずに呼んでいること（押した直後の条件）
  c.ok(req && JSON.stringify(req.origins) === JSON.stringify(["http://kn.example/*", "https://kn.example/*"]), "http と https の両方のオリジンを求める", req);
  c.ok(req && JSON.stringify(req.permissions) === '["history"]', "閲覧履歴の権限も同じダイアログで求める", req);

  const local = await popupEnv({ kurl: "http://192.168.1.5:8080/kininari.html", exec: async () => [{ result: { title: "t", url: "https://news.example/a" } }] });
  await local.clock.tick(10);
  local.els.perm.fire("click");
  c.ok(!/https:\/\//.test(local.els.permMsg.textContent) && JSON.stringify(local.calls.request[0].origins) === '["http://192.168.1.5:8080/*"]', "ローカル・社内の http はそのまま（注意も https 側の要求も無し）", local.calls.request[0]);
  const isLocal = local.pop.get("isLocalHost");
  c.ok(["localhost", "127.0.0.1", "10.0.0.2", "172.20.1.1", "nas", "pi.local", "[::1]"].every((h) => isLocal(h)) &&
       ["example.github.io", "172.32.0.1", "8.8.8.8", "my.example.com"].every((h) => !isLocal(h)), "ローカル・社内のホストの見分け");

  // 1.2 で保存の確認だけ許可していた人には、履歴の分を足すボタンにする
  const old = await popupEnv({ origins: ["https://kn.example/*"], exec: async () => [{ result: { title: "t", url: "https://news.example/a" } }] });
  await old.clock.tick(10);
  c.ok(old.els.perm.disabled === false && /履歴/.test(old.els.perm.textContent), "サイトだけ許可済みなら「履歴からの消去も許可する」", old.els.perm.textContent);
  const all = await popupEnv({ origins: ["https://kn.example/*"], permissions: ["history"], exec: async () => [{ result: { title: "t", url: "https://news.example/a" } }] });
  await all.clock.tick(10);
  c.ok(all.els.perm.disabled === true && /許可済み/.test(all.els.perm.textContent), "両方許可済みなら「許可済み」");
}

// ── 15. ポップアップ: URL の上限（日本語2000文字なら削らない・長すぎれば削る） ──
{
  const env = await popupEnv({ exec: async () => [{ result: { title: "t", url: "https://news.example/a" } }] });
  const buildUrl = env.pop.get("buildUrl");
  const ja = "日本語の文章です。".repeat(250).slice(0, 2000);
  const b = buildUrl(KN, ja);
  c.ok(b.url && !b.cutNote && b.url.length <= 32000, "日本語2000文字のメモは削らずに送れる（8000の上限では削れていた）", b.url.length);
  const big = buildUrl(KN, "あ".repeat(6000));
  c.ok(big.url && big.cutNote && big.url.length <= 32000 && knaddOf(big.url).n.length > 2000, "上限を超えるぶんだけ削る", big.url.length);
}

// ── 16. clipper.html に埋め込んだ配布ZIPがフォルダと同じ（作り直し忘れが無い） ──
{
  let out = "", ok = false;
  try { out = execFileSync("python3", [path.join(ROOT, ".tools", "build-clipper.py"), "--check"], { encoding: "utf8" }); ok = true; }
  catch (e) { out = String(e.stdout || e.message); }
  c.ok(ok, "clipper.html の配布ZIPとバージョン表示がフォルダ（manifest.json）と同じ", out.trim());
}

// ── 17. 実際の Chromium に拡張を読み込んで確かめる ──
if (!process.argv.includes("--unit")) {
  try { await e2e(); }
  catch (e) { c.ok(false, "実ブラウザでの検証が途中で止まった", String((e && e.stack) || e).slice(0, 600)); }
}
c.done();

async function e2e() {
  const require = createRequire(import.meta.url);
  const { chromium } = require("playwright");
  // 偽の気になり帳: #knadd を受け取って消し（本物と同じく replaceState）、k の番号で重複を見分け、
  // 結果を __kininariClipStatus / __kininariClipSaved に書く。タイトルに QUOTA / PARSE が入っていれば失敗を返す。
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "kn-clip-site-"));
  fs.writeFileSync(path.join(site, "kininari.html"), `<!doctype html><meta charset="utf-8"><title>kn</title><script>
    (function(){
      var m = (location.hash || "").match(/(?:#|&)knadd=([^&]+)/);
      if (!m) return;
      history.replaceState(null, "", location.pathname + location.search);
      var clip = null;
      try { clip = JSON.parse(decodeURIComponent(m[1])); } catch (e) {}
      setTimeout(function(){
        if (!clip) { window.__kininariClipStatus = "parse"; return; }
        if (/QUOTA/.test(clip.t)) { window.__kininariClipStatus = "quota"; return; }
        if (/PARSE/.test(clip.t)) { window.__kininariClipStatus = "parse"; return; }
        var seen = JSON.parse(localStorage.getItem("seen") || "[]");
        var dup = seen.indexOf(clip.k) >= 0;
        if (!dup) { seen.push(clip.k); localStorage.setItem("seen", JSON.stringify(seen)); }
        localStorage.setItem("got", JSON.stringify((JSON.parse(localStorage.getItem("got") || "[]")).concat([{ k: clip.k, q: new URLSearchParams(location.search).get("kn_clip"), n: clip.n, dup: dup }])));
        window.__kininariClipStatus = dup ? "dup" : "saved";
        window.__kininariClipSaved = true;
      }, 300);
    })();
  </script>`);
  fs.writeFileSync(path.join(site, "article.html"), `<!doctype html><meta charset="utf-8"><title>記事のタイトル</title><meta property="og:description" content="記事の説明"><p>本文`);
  const srv = await startServer(site);
  // 転送（http→https の代わりに、別ホスト名 → 127.0.0.1 へ 301）
  const redir = http.createServer((req, res) => { res.writeHead(301, { Location: srv.url.replace(/\/$/, "") + req.url }); res.end(); });
  await new Promise((r) => redir.listen(0, "127.0.0.1", r));
  const port = srv.port, rport = redir.address().port;

  // 検証用の拡張: 保存先（kn.test）への許可と閲覧履歴を最初から持たせる（本番は任意の権限で、
  // ダイアログでしか許可できないため）。127.0.0.1 には許可を与えない＝転送先は確かめられない。
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "kn-clip-ext-"));
  for (const f of fs.readdirSync(EXT)) fs.copyFileSync(path.join(EXT, f), path.join(ext, f));
  const man = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  man.host_permissions = ["http://kn.test/*"];
  man.permissions = man.permissions.concat("history");
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(man));
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "kn-clip-prof-"));
  const ctx = await chromium.launchPersistentContext(prof, {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-proxy-server",
      "--host-resolver-rules=MAP kn.test 127.0.0.1"]
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    c.ok(true, "Chromium に拡張（" + (await sw.evaluate(() => chrome.runtime.getManifest().version)) + "）を読み込めた");
    const base = `http://kn.test:${port}/kininari.html`;
    const kn = await ctx.newPage();
    await kn.goto(base); // 偽の気になり帳の localStorage を読むためのタブ
    const got = () => kn.evaluate(() => JSON.parse(localStorage.getItem("got") || "[]"));
    // 裏タブ（拡張からは許可の無いオリジンのURLは読めないので、Playwright の側から数える）
    const knTabs = async () => ctx.pages().filter((pg) => pg.url().includes("kn_clip="));

    // ポップアップを普通のタブとして開き、見ているページの情報だけ差し込んで保存ボタンを押す
    const article = `http://127.0.0.1:${port}/article.html`;
    async function openPopup(kurl) {
      const p = await ctx.newPage();
      await p.goto(`chrome-extension://${extId}/popup.html`);
      await p.waitForFunction(() => document.getElementById("status").textContent !== "");
      await p.evaluate(([u, a]) => {
        document.getElementById("kurl").value = u;
        pageInfo = { title: "記事のタイトル", url: a, img: "" }; // eslint-disable-line no-undef
        document.getElementById("title").value = "記事のタイトル";
        ready = true; // eslint-disable-line no-undef
        document.getElementById("save").disabled = false;
        document.getElementById("status").textContent = "";
      }, [kurl, article]);
      return p;
    }
    const statusOf = (p) => p.evaluate(() => document.getElementById("status").textContent);

    // (a) 保存 → saved。二度押ししても裏タブは1つ
    let p = await openPopup(base);
    await p.dblclick("#save");
    await waitFor(async () => /保存しました ✓/.test(await statusOf(p).catch(() => "保存しました ✓")), { timeout: 15000, label: "保存しました ✓" })
      .catch(async (e) => { throw new Error(e.message + " / " + (await statusOf(p).catch(() => "?")) + " / " + JSON.stringify(await sw.evaluate(() => Promise.all([chrome.storage.session.get(null), chrome.tabs.query({})])))); });
    let g = await got();
    c.ok(g.length === 1 && !g[0].dup && /^[0-9a-f]{32}$/.test(g[0].k) && g[0].q === g[0].k, "実ブラウザ: 二度押ししても1件だけ届き、?kn_clip= と k は同じ番号", g);
    await sleep(500);
    c.ok((await knTabs()).length === 0, "実ブラウザ: 保存を確かめて裏タブを閉じた");
    const hist = await sw.evaluate(() => chrome.history.search({ text: "", startTime: 0, maxResults: 1000 }));
    c.ok(hist.some((h) => h.url === base) && !hist.some((h) => h.url.includes("kn_clip=")), "実ブラウザ: kn_clip の付いたURLは閲覧履歴に残らない（ほかの履歴は残る）", hist.map((h) => h.url.slice(0, 80)));

    // (b) 同じ番号で送り直す → dup（気になり帳には二重に入らない）
    const resend = (kurl, k, t) => openPopup(kurl).then((pp) => pp.evaluate(([k, t]) => new Promise((r) => {
      // ポップアップと同じ形のURLを、指定の番号で送る
      const u = clipBase(document.getElementById("kurl").value, k) + "#knadd=" + encodeURIComponent(JSON.stringify({ t, u: "https://x/", n: "", img: "", c: "メモ", f: "", k })); // eslint-disable-line no-undef
      chrome.runtime.sendMessage({ type: "clip", url: u }, r);
    }), [k, t]));
    const resp2 = await resend(base, g[0].k, "記事のタイトル").catch(() => null);
    g = await got();
    c.ok(resp2 && resp2.status === "dup" && resp2.ok === true, "実ブラウザ: 同じ番号の送り直しは dup（成功扱い）", resp2);
    c.ok(g.length === 2 && g[1].dup === true, "実ブラウザ: 気になり帳には二重に入らない（2件目は dup）", g);

    // (c) quota / parse はすぐ（20秒待たずに）エラーで返る
    for (const word of ["QUOTA", "PARSE"]) {
      const t0 = Date.now();
      const r = await resend(base, (word === "QUOTA" ? "a" : "b").repeat(32), word);
      c.ok(r && r.status === word.toLowerCase() && Date.now() - t0 < 8000, "実ブラウザ: " + word.toLowerCase() + " はすぐにエラーで返る（" + (Date.now() - t0) + "ms）", r);
    }

    // (d) 許可の無いオリジンへ転送される → blind（直し方つき）。20秒の「確認できず」にしない
    const t0 = Date.now();
    const movedBase = `http://kn.test:${rport}/kininari.html`; // kn.test には許可があるが、127.0.0.1 へ転送される
    p = await openPopup(movedBase);
    await p.click("#save");
    await waitFor(async () => /未確認/.test(await statusOf(p)), { timeout: 15000, label: "転送で未確認" });
    const notice = await p.evaluate(() => document.getElementById("notice").textContent);
    c.ok(/転送/.test(notice), "実ブラウザ: 転送されたら blind と直し方を出す（" + (Date.now() - t0) + "ms）", notice);
    c.ok((await knTabs()).length === 1, "実ブラウザ: 転送先の裏タブは、保存の時間をみてすぐには閉じない");
    await waitFor(async () => (await knTabs()).length === 0, { timeout: 15000, label: "転送先の裏タブが閉じる" });
    const took = Date.now() - t0;
    c.ok(took >= 7000 && took < 15000, "実ブラウザ: 転送先の裏タブは blind の待ち時間（8秒）で閉じる（" + took + "ms。20秒待たない）");
    const last = await sw.evaluate(() => chrome.storage.session.get("knLastResult"));
    c.ok(last.knLastResult && last.knLastResult.status === "blind", "実ブラウザ: 最後の結果は blind（unconfirmed ではない）", last);
  } finally {
    await ctx.close();
    await srv.close();
    await new Promise((r) => redir.close(r));
    for (const d of [site, ext, prof]) fs.rmSync(d, { recursive: true, force: true });
  }
}
