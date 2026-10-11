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
//
// 【1.3.0で直したところ】
// ・同じクリップを送り直すと二重に入ることがあった。ポップアップが1回ごとに番号を
//   振り、URLの ?kn_clip= と中身の k に入れて送る。アプリはこの番号で重複を見分け、
//   結果を window.__kininariClipStatus（saved / dup / quota / parse）で返す。
//   容量不足・形式エラーは待っても変わらないので、20秒待たずにすぐ伝える。
// ・保存先が別のオリジンへ転送されると（GitHub Pages の http→https など）、許可した
//   オリジンと違うので確認できず、毎回「確認できませんでした」で終わっていた。
//   タブが実際にいるオリジンで判断し、許可が無ければ未確認（blind）として扱う。
// ・アプリは #knadd をURLから消すので、復元された裏タブを「まったく同じURL」で探しても
//   見つからなかった（引き継ぎが一度も効いていなかった）。?kn_clip= の番号で見分ける。
// ・シークレットウィンドウから保存すると裏タブもシークレットで開き、ウィンドウを
//   閉じると消える場所に保存されていた（なのに ✓ が出ていた）。通常のウィンドウで開く。
// ・閲覧履歴の権限があれば、クリップの中身が入ったURLを履歴から消す。
// ・どのタブが更新されても Service Worker を起こしていた（tabs.onUpdated）。見張りの
//   ループと alarms だけで足りるので、このリスナーはやめる。

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
//   dup         … アプリ側で「もう保存してあった」と分かった（送り直しなど）
//   quota       … アプリ側で、容量がいっぱいで保存できなかった
//   parse       … アプリ側で、受け取れない形式だった
//   blind       … 保存先へのアクセス許可が無く、確認せずに閉じた
//   unconfirmed … 確認できるはずが、時間内に保存完了を確認できなかった
//   closed      … こちらが閉じる前に裏のタブが消えた（手で閉じた・ウィンドウごと閉じた）
//   failed      … タブを開くこと自体に失敗した
const BADGE = {
  saved:       { text: "✓", color: "#2e7d52", title: "保存しました" },
  dup:         { text: "✓", color: "#2e7d52", title: "もう保存してありました" },
  quota:       { text: "!", color: "#c0463c", title: "保存先の容量がいっぱいで保存できませんでした" },
  parse:       { text: "!", color: "#c0463c", title: "保存先が受け取れない形式でした" },
  blind:       { text: "",  color: "#9a8c72", title: "保存先を開きました（確認はしていません）" },
  unconfirmed: { text: "!", color: "#c0463c", title: "保存を確認できませんでした。保存先URLを確認してください" },
  closed:      { text: "!", color: "#c0463c", title: "裏のタブが閉じられたため、保存できたか分かりません" },
  failed:      { text: "!", color: "#c0463c", title: "保存できませんでした。保存先URLを確認してください" }
};
// アプリが結果を書く window.__kininariClipStatus の値（複数フレームで違えば前のものを優先）
const APP_STATUS = ["saved", "dup", "quota", "parse"];

// 保存先へは許可してあるのに、タブが別のオリジンへ転送されていて確かめられないときの説明
const MOVED_NOTE = "保存先が別のアドレス（https:// など）へ転送されたため、保存を確認できませんでした。⚙の保存先URLを、実際に開くアドレスに直してください。";

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

// ポップアップが振ったクリップの番号（URLの ?kn_clip=）。無ければ ""。
// アプリは #knadd をURLから消すが ?以降は残すので、復元されたタブもこれで見分けられる。
function clipIdOf(url) {
  try { return new URL(url).searchParams.get("kn_clip") || ""; } catch (e) { return ""; }
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

async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch (e) { return null; }
}

async function tabExists(tabId) {
  return !!(await getTab(tabId));
}

// 保存を確かめられるか。設定した保存先URLではなく、タブが実際にいるオリジンで判断する。
// 転送（http→https、独自ドメインへの移動など）で別のオリジンにいると、そこへの許可が
// 無い限り結果を読めないのに、設定のオリジンで判断していたため毎回「確認できません
// でした」で終わっていた。タブのURLは許可のあるオリジンにいるときしか読めないので、
// 読めなければ確かめられない側に倒す。
async function canCheckTab(tab) {
  const cur = (tab && (tab.url || tab.pendingUrl)) || "";
  return canScript(originOf(cur));
}

// アプリの結果はページ本体（MAINワールド）の window.__kininariClipStatus に入る
// （saved / dup / quota / parse）。古い気になり帳は window.__kininariClipSaved（true）
// しか立てないので、そのときは saved とみなす。結合アプリ index.html では iframe の
// 中に立つので、全フレームを調べる。まだ何も無ければ ""。
async function statusInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        try {
          const s = window.__kininariClipStatus;
          if (s === "saved" || s === "dup" || s === "quota" || s === "parse") return s;
          if (window.__kininariClipSaved) return "saved";
        } catch (e) {}
        return "";
      }
    });
    const got = (results || []).map((r) => r && r.result);
    return APP_STATUS.find((s) => got.includes(s)) || "";
  } catch (e) {
    return null; // 実行できない（権限なし・まだ読み込み中など）
  }
}

// 開いたURL（#knadd= にクリップの中身が入っている）を閲覧履歴から消す（許可があるときだけ）。
// 転送やアプリの書き換え（#knadd を消す）で残った別の形のURLも、同じ ?kn_clip= の番号が
// 付いていればまとめて消す。
async function scrubHistory(st) {
  const id = st && clipIdOf(st.url);
  if (!id) return;
  try {
    if (!(await chrome.permissions.contains({ permissions: ["history"] }))) return;
    if (!(chrome.history && chrome.history.deleteUrl)) return;
    const urls = new Set([st.url, st.url.split("#")[0]]);
    const items = await chrome.history.search({ text: "", startTime: (st.startedAt || Date.now()) - 60 * 1000, maxResults: 200 });
    for (const it of items || []) if (it && it.url && clipIdOf(it.url) === id) urls.add(it.url);
    for (const url of urls) await chrome.history.deleteUrl({ url });
  } catch (e) {}
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
      try { send({ ok: status === "saved" || status === "dup", status, err: err || "" }); } catch (e) {}
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
  // 履歴は閉じ終わってから消す（読み込み途中で閉じると、消したあとに記録が足されることがある）
  await new Promise((r) => {
    try { chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; r(); }); } catch (e) { r(); }
  });
  await scrubHistory(st);
}

// こちらが閉じる前に裏タブが消えたとき（手で閉じた・ウィンドウごと閉じた等）の後始末。
// 黙って忘れるとポップアップが「保存中…」のまま固まり、やがて接続が切れて的外れな
// 理由を出してしまうので、起きたことをそのまま結果として返す。
async function abandon(tabId) {
  const st = await forget(tabId);
  if (!st) return;          // finish 経由。結果は伝え済み
  // 確認できない旨（blind）を伝えたあとなら蒸し返さない
  if (!st.reported) await report(tabId, "closed");
  await scrubHistory(st);
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
      const tab = await getTab(tabId);
      if (!tab) { await abandon(tabId); return; }        // 手で閉じられた
      const now = Date.now();
      if (await canCheckTab(tab)) {
        // saved / dup は保存済み、quota / parse は待っても変わらないので、どれもすぐ終える
        const s = await statusInTab(tabId);
        if (s) { await finish(tabId, s); return; }
        if (now - st.startedAt >= POLL_MAX_MS || now >= st.hardAt) { await finish(tabId, "unconfirmed"); return; }
      } else {
        // 確認する権限が無いことはすぐ分かるので、ポップアップを待たせずに伝える。
        // タブ自体は保存が終わる余裕をみて BLIND_WAIT_MS 待ってから閉じる。
        // 印を立てるところまで直列化しないと、同時に2件あると二重に伝えてしまう。
        // 保存先へは許可してあるのに確かめられない＝別のオリジンへ転送されているので、直し方を添える。
        const why = (await canScript(st.origin)) ? MOVED_NOTE : "";
        const first = await editPending((p) => {
          const cur = p[key];
          if (!cur || cur.reported) return false;
          cur.reported = "blind";
          return true;
        });
        if (first) await report(tabId, "blind", why);
        if (now - st.startedAt >= BLIND_WAIT_MS || now >= st.hardAt) { await finish(tabId, "blind", why); return; }
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
// 起動時に「同じクリップ番号（?kn_clip=）のタブ」を探して、いつもの見張りに引き継ぐ。
// （アプリは受け取ると #knadd をURLから消すので、まったく同じURLでは見つからない）
// まだ #knadd が残っているタブはアプリがこれから取り込むので、保存を確認してから閉じる。
// 残っていないタブは前回のうちに取り込み済みで、待っても合図は立たないので、すぐ閉じる
// （起動のたびに「確認できませんでした」と出して驚かせない）。
// ※ タブのURLは保存先サイトへのアクセスを許可しているときだけ読める。許可が無いと
//    見分けられないので、そのときは何もしない（無関係なタブを巻き添えにしない）。
async function adoptRestoredTabs() {
  if (!(await getOpened()).length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (e) { tabs = []; }
  const found = await serial(async () => {
    const want = new Map();
    for (const u of await getOpened()) { const id = clipIdOf(u); if (id) want.set(id, u); }
    const hit = [];
    for (const t of tabs) {
      const cur = t && (t.url || t.pendingUrl);
      const id = t && t.id != null && typeof cur === "string" ? clipIdOf(cur) : "";
      if (id && want.has(id)) hit.push({ id: t.id, cur, url: want.get(id) });
    }
    await setOpened([...new Set(hit.map((h) => h.url))]); // 見つからなかったURLは控えから外す
    return hit;
  });
  if (!found.length) return;
  const now = Date.now();
  const added = await editPending((p) => {
    const out = [];
    for (const h of found) {
      if (p[String(h.id)]) continue; // もう見張っている
      p[String(h.id)] = {
        url: h.url,
        origin: originOf(h.url),
        startedAt: now,
        hardAt: now + HARD_LIMIT_MS,
        reported: ""
      };
      out.push(h);
    }
    return out;
  });
  await ensureAlarm();
  for (const h of added) {
    if (/[#&]knadd=/.test(h.cur)) watch(h.id);
    else finish(h.id, "blind");
  }
}

// 裏タブは必ず通常の（シークレットでない）ウィンドウに開く。ウィンドウを指定しないと
// ポップアップを開いたウィンドウに開くので、シークレットから保存すると、ウィンドウを
// 閉じると消える場所に保存されてしまう（なのに ✓ が出ていた）。通常のウィンドウが
// 1つも無いときは、前に出さずに新しく作る。
async function openClipTab(url) {
  let wins = [];
  try { wins = await chrome.windows.getAll({ windowTypes: ["normal"] }); } catch (e) { wins = []; }
  const normal = (wins || []).filter((w) => w && w.id != null && !w.incognito);
  const w = normal.find((x) => x.focused) || normal[0];
  if (w) return chrome.tabs.create({ windowId: w.id, url, active: false });
  const nw = await chrome.windows.create({ url, incognito: false, focused: false });
  return (nw && nw.tabs && nw.tabs[0]) || null;
}

async function startClip(url, sendResponse) {
  let tab = null;
  let err = "";
  try { tab = await openClipTab(url); }
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

// ※ chrome.tabs.onUpdated は使わない。どのタブが更新されても（関係ないタブの読み込みや
//    タイトルの変化でも）Service Worker が起こされてしまううえ、Chrome では絞り込み
//    （{ properties: [...] } など）が使えない（渡すとここで例外になり、拡張ごと動かなくなる）。
//    見張り中は見張りのループが POLL_MS ごとに確かめており、途中で Service Worker が
//    止められても alarms（SWEEP_MIN ごと）と起き直したときの sweep() が引き継ぐ。

chrome.tabs.onRemoved.addListener((tabId) => { abandon(tabId); });

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) sweep(); });

// ブラウザ起動時と拡張の更新時は、復元された裏タブを引き取ってから点検する。
chrome.runtime.onStartup.addListener(() => { adoptRestoredTabs().then(sweep, sweep); });
chrome.runtime.onInstalled.addListener(() => { adoptRestoredTabs().then(sweep, sweep); });

sweep(); // 起こされたとき（メッセージ・タブ更新・アラームなど）の取り残し点検
