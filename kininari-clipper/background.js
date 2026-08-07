// クリップ要求を受けて、気になり帳のディープリンクをバックグラウンドタブで開き、
// 保存が終わったらそのタブを閉じる。
//
// 旧版は「読み込み完了から5秒」の固定タイマーで閉じていたため、回線が遅い/
// バックグラウンドタブがスロットルされると、保存前に閉じてクリップを失う
// ことがあった。いまはアプリ側が立てる window.__kininariClipSaved を
// ポーリングして、保存を確認してから閉じる（権限が無い場合は従来どおり待つ）。
//
// 【1.2.0で直したところ】
// ・確認用の executeScript が既定の「隔離ワールド」で走っていたため、ページ本体が
//   立てるフラグを見られず、確認が必ず失敗していた（＝毎回タイムアウトし、裏タブが
//   25秒残っていた）。world:"MAIN" で実行する。結合アプリ index.html は
//   kininari.html を iframe で読み込むので allFrames:true で全フレームを見て、
//   どれか1つでも立っていれば保存済みとみなす。
// ・タブを作れただけで「保存しました」と返していた。実際の結果を返し、ポップアップが
//   先に閉じても分かるようにツールバーのバッジにも残す。
// ・リスナー登録と待ち時間の setTimeout をメッセージ処理の中で作っていたため、
//   Service Worker が止められると裏のタブが開きっぱなしになった。リスナーは
//   トップレベルに置き、取り残しは chrome.alarms と起動時の点検で必ず片付ける。
// ・裏タブを手で（またはウィンドウごと）閉じられたときに何も返していなかったため、
//   ポップアップが「保存中…」のまま固まり、やがて Service Worker の停止で接続が
//   切れて、無関係な理由（URL設定の誤り）を表示していた。閉じられたことを結果
//   （closed）として返し、バッジと直近結果にも残す。
// ・処理中のタブの記録を「読んで書き戻す」間に別のクリップが割り込むと、片方の
//   書き込みがまるごと消えて、二重報告や取り残しの原因になっていた。記録の
//   書き換えはすべて直列化する。
// ・chrome.storage.session はブラウザを閉じると消えるため、セッション復元で戻って
//   きた裏タブを見つけられず、開きっぱなしになっていた。開いたURLは
//   chrome.storage.local にも控えておき、起動時に同じURLのタブを見張りへ引き継ぐ。

const POLL_MS = 500;          // 保存フラグを見に行く間隔
const POLL_MAX_MS = 20000;    // ここまでは保存完了を待つ
const BLIND_WAIT_MS = 8000;   // 権限が無くて確認できないときの待ち時間
const HARD_LIMIT_MS = 25000;  // 何があってもここで閉じる
const SWEEP_MIN = 1;          // 取り残し点検の間隔（分。chrome.alarmsの下限）
const PENDING_KEY = "knPending";     // 処理中のタブ番号（Service Workerが止まっても残る）
const OPENED_KEY = "knOpened";       // 処理中のURL（ブラウザを閉じても残る）
const OPENED_MAX = 20;               // URLの控えが際限なく増えないようにする上限
const LAST_KEY = "knLastResult";     // 直近の結果（次にポップアップを開いたとき伝える）
const ALARM = "kn-clip-sweep";

// 結果の種類:
//   saved       … アプリ側の保存完了フラグを確認できた
//   blind       … 保存先へのアクセス許可が無く、確認せずに閉じた
//   unconfirmed … 確認できるはずが、時間内に保存完了を確認できなかった
//   closed      … こちらが閉じる前に裏のタブが消えた（手で閉じた・ウィンドウごと閉じた）
//   failed      … タブを開くこと自体に失敗した
const BADGE = {
  saved:       { text: "✓", color: "#2e7d52", title: "保存しました" },
  blind:       { text: "",  color: "#9a8c72", title: "保存先を開きました（確認はしていません）" },
  unconfirmed: { text: "!", color: "#c0463c", title: "保存を確認できませんでした。保存先URLを確認してください" },
  closed:      { text: "!", color: "#c0463c", title: "裏のタブが閉じられたため、保存できたか分かりません" },
  failed:      { text: "!", color: "#c0463c", title: "保存できませんでした。保存先URLを確認してください" }
};

// ポップアップへの応答先。Service Workerが生きている間だけ有効なので、
// 消えても困らないようにバッジと直近結果の記録を必ず併用する。
const responders = new Map();
const watching = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin + "/*";
  } catch (e) { return null; }
}

async function canScript(origin) {
  if (!origin) return false;
  try { return await chrome.permissions.contains({ origins: [origin] }); }
  catch (e) { return false; }
}

// --- 記録の読み書き -------------------------------------------------------
// 「読んで → 書き戻す」の途中に別のクリップの書き込みが割り込むと、片方の変更が
// まるごと消える（同時に2件クリップすると、報告済みの印が消えて二重に報告したり、
// 処理中のタブが記録から抜け落ちて取り残しになる）。書き換えは必ずこの列に並べる。
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(() => fn(), () => fn());
  queue = run.then(() => {}, () => {});
  return run;
}

async function getPending() {
  try {
    const o = await chrome.storage.session.get(PENDING_KEY);
    return (o && o[PENDING_KEY]) || {};
  } catch (e) { return {}; }
}

async function setPending(p) {
  try { await chrome.storage.session.set({ [PENDING_KEY]: p }); } catch (e) {}
}

// 処理中のタブの記録を安全に書き換える。fn には最新の記録を渡すので直接書き換えてよい。
// 中身が変わったときだけ書き戻す（タブが閉じられるたびに無駄な書き込みをしない）。
function editPending(fn) {
  return serial(async () => {
    const p = await getPending();
    const before = JSON.stringify(p);
    const out = await fn(p);
    if (JSON.stringify(p) !== before) await setPending(p);
    return out;
  });
}

async function getOpened() {
  try {
    const o = await chrome.storage.local.get(OPENED_KEY);
    const v = o && o[OPENED_KEY];
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

async function setOpened(list) {
  try { await chrome.storage.local.set({ [OPENED_KEY]: list }); } catch (e) {}
}

function rememberOpened(url) {
  if (!url) return Promise.resolve();
  return serial(async () => {
    const list = await getOpened();
    if (list.includes(url)) return;
    list.push(url);
    await setOpened(list.slice(-OPENED_MAX));
  });
}

function dropOpened(url) {
  if (!url) return Promise.resolve();
  return serial(async () => {
    const list = await getOpened();
    const next = list.filter((u) => u !== url);
    if (next.length !== list.length) await setOpened(next);
  });
}

async function tabExists(tabId) {
  try { await chrome.tabs.get(tabId); return true; } catch (e) { return false; }
}

// 保存完了フラグはページ本体（MAINワールド）の window.__kininariClipSaved に立つ。
// 結合アプリ index.html では iframe の中に立つので、全フレームを調べてどれか1つでも
// 立っていれば保存済みとする。
async function savedInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        try { if (window.__kininariClipSaved) return true; } catch (e) {}
        return false;
      }
    });
    return (results || []).some((r) => r && r.result === true);
  } catch (e) {
    return null; // 実行できない（権限なし・まだ読み込み中など）
  }
}

// 結果をバッジ・記録・ポップアップの3か所に伝える。
async function report(tabId, status, err) {
  const b = BADGE[status] || BADGE.failed;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: b.color });
    await chrome.action.setBadgeText({ text: b.text });
    await chrome.action.setTitle({ title: "気になり帳に保存 — " + b.title });
  } catch (e) {}
  try {
    await chrome.storage.session.set({ [LAST_KEY]: { status, err: err || "", at: Date.now() } });
  } catch (e) {}
  if (tabId != null) {
    const send = responders.get(tabId);
    if (send) {
      responders.delete(tabId);
      try { send({ ok: status === "saved", status, err: err || "" }); } catch (e) {}
    }
  }
}

// 処理中の記録から外して、外した記録（もう無ければ null）を返す。
async function forget(tabId) {
  const key = String(tabId);
  const st = await editPending((p) => {
    const cur = p[key];
    if (!cur) return null;
    delete p[key];
    return cur;
  });
  if (!st) return null;
  await dropOpened(st.url);
  if (!Object.keys(await getPending()).length) {
    try { await chrome.alarms.clear(ALARM); } catch (e) {}
  }
  return st;
}

// 状態を先に消してからタブを閉じる（onRemovedと二重に走らせない）。
// 記録がもう無い＝別の経路が片付けたあとなので、そのときは何も言わない。
async function finish(tabId, status, err) {
  const st = await forget(tabId);
  if (!st) return;
  await report(tabId, status, err);
  try { chrome.tabs.remove(tabId, () => void chrome.runtime.lastError); } catch (e) {}
}

// こちらが閉じる前に裏タブが消えたとき（手で閉じた・ウィンドウごと閉じた等）の後始末。
// 黙って忘れるとポップアップが「保存中…」のまま固まり、やがて接続が切れて的外れな
// 理由を出してしまうので、起きたことをそのまま結果として返す。
async function abandon(tabId) {
  const st = await forget(tabId);
  if (!st) return;          // finish 経由。結果は伝え済み
  if (st.reported) return;  // 確認できない旨（blind）を伝えたあとなので蒸し返さない
  await report(tabId, "closed");
}

async function ensureAlarm() {
  try {
    const a = await chrome.alarms.get(ALARM);
    if (!a) chrome.alarms.create(ALARM, { delayInMinutes: SWEEP_MIN, periodInMinutes: SWEEP_MIN });
  } catch (e) {}
}

// 1つの裏タブを見張る。Service Workerが生きている間はここが仕事をし、
// 途中で止められた場合は alarms / 起動時の点検から呼び直される。
async function watch(tabId) {
  const key = String(tabId);
  if (watching.has(key)) return;
  watching.add(key);
  try {
    for (;;) {
      const st = (await getPending())[key];
      if (!st) return;                                   // もう片付いている
      if (!(await tabExists(tabId))) { await abandon(tabId); return; } // 手で閉じられた
      const now = Date.now();
      if (await canScript(st.origin)) {
        if ((await savedInTab(tabId)) === true) { await finish(tabId, "saved"); return; }
        if (now - st.startedAt >= POLL_MAX_MS || now >= st.hardAt) { await finish(tabId, "unconfirmed"); return; }
      } else {
        // 確認する権限が無いことはすぐ分かるので、ポップアップを待たせずに伝える。
        // タブ自体は保存が終わる余裕をみて BLIND_WAIT_MS 待ってから閉じる。
        // 印を立てるところまで直列化しないと、同時に2件あると二重に伝えてしまう。
        const first = await editPending((p) => {
          const cur = p[key];
          if (!cur || cur.reported) return false;
          cur.reported = "blind";
          return true;
        });
        if (first) await report(tabId, "blind");
        if (now - st.startedAt >= BLIND_WAIT_MS || now >= st.hardAt) { await finish(tabId, "blind"); return; }
      }
      await sleep(POLL_MS);
    }
  } finally {
    watching.delete(key);
  }
}

// 取り残しがないか点検する。Service Workerが起き直すたびに必ず1回走る。
async function sweep() {
  const pending = await getPending();
  const keys = Object.keys(pending);
  if (!keys.length) { try { await chrome.alarms.clear(ALARM); } catch (e) {} return; }
  await ensureAlarm();
  for (const key of keys) {
    const tabId = Number(key);
    if (!(await tabExists(tabId))) { await abandon(tabId); continue; }
    watch(tabId); // 期限切れなら watch の中ですぐ閉じられる
  }
}

// ブラウザを閉じるとタブ番号の控え（chrome.storage.session）は消えるうえ、タブ番号自体が
// 付け直されるので当てにできない。セッション復元で裏タブが戻ってくると閉じ手がいなくなり、
// 開きっぱなしになってしまう。そこで開いたURLは chrome.storage.local にも控えておき、
// 起動時に「まったく同じURLのタブ」を探して、いつもの見張りに引き継ぐ。読み込みが済んで
// いれば保存を確認してすぐ閉じ、そうでなくても時間切れで必ず閉じる。
// ※ タブのURLは保存先サイトへのアクセスを許可しているときだけ読める。許可が無いと
//    見分けられないので、そのときは何もしない（無関係なタブを巻き添えにしない）。
async function adoptRestoredTabs() {
  if (!(await getOpened()).length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (e) { tabs = []; }
  const found = await serial(async () => {
    const want = new Set(await getOpened());
    const hit = tabs.filter((t) => t && t.id != null && typeof t.url === "string" && want.has(t.url));
    await setOpened([...new Set(hit.map((t) => t.url))]); // 見つからなかったURLは控えから外す
    return hit;
  });
  if (!found.length) return;
  const now = Date.now();
  await editPending((p) => {
    for (const t of found) {
      if (p[String(t.id)]) continue;
      p[String(t.id)] = {
        url: t.url,
        origin: originOf(t.url),
        startedAt: now,
        hardAt: now + HARD_LIMIT_MS,
        reported: ""
      };
    }
  });
  await ensureAlarm();
  for (const t of found) watch(t.id);
}

async function startClip(url, sendResponse) {
  let tab = null;
  let err = "";
  try { tab = await chrome.tabs.create({ url, active: false }); }
  catch (e) { err = String((e && e.message) || e); }

  if (!tab || tab.id == null) {
    await report(null, "failed", err || "タブを開けませんでした");
    try { sendResponse({ ok: false, status: "failed", err }); } catch (e) {}
    return;
  }

  const tabId = tab.id;
  responders.set(tabId, sendResponse);
  const now = Date.now();
  await editPending((p) => {
    p[String(tabId)] = {
      url,
      origin: originOf(url),
      startedAt: now,
      hardAt: now + HARD_LIMIT_MS,
      reported: ""
    };
  });
  await rememberOpened(url);
  await ensureAlarm();
  watch(tabId);
}

// --- リスナーはすべてトップレベルに置く（Service Workerが起き直しても復活する） ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!(msg && msg.type === "clip" && typeof msg.url === "string" && msg.url)) return;
  startClip(msg.url, sendResponse);
  return true; // 非同期で応答する
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  getPending().then((p) => { if (p[String(tabId)]) watch(tabId); });
});

chrome.tabs.onRemoved.addListener((tabId) => { abandon(tabId); });

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) sweep(); });

// ブラウザ起動時と拡張の更新時は、復元された裏タブを引き取ってから点検する。
chrome.runtime.onStartup.addListener(() => { adoptRestoredTabs().then(sweep, sweep); });
chrome.runtime.onInstalled.addListener(() => { adoptRestoredTabs().then(sweep, sweep); });

sweep(); // 起こされたとき（メッセージ・タブ更新・アラームなど）の取り残し点検
