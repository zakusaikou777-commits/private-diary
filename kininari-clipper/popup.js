const $ = (id) => document.getElementById(id);
const CATS = ["メモ", "アイデア", "調べる", "やること", "行きたい"];
// 選択テキストの上限。共有メニュー経由（index.html）と同じ2000文字にそろえる
// （ブックマークレットは800文字）。日本語は encodeURIComponent で約9倍に膨らむので、
// 上限が無いとURLが数百KB〜数MBになり、途中で切られてクリップが丸ごと消える。
const SEL_MAX = 2000;
// #knadd= まで含めた最終URLの上限。ここを超えそうなら送る前に削る。
// #以降はサーバーへ送られない（ブラウザの中だけで使う）ので大きめにとる。日本語は
// 約9倍に膨らむので、8000では千字足らずでメモが削られていた。
const URL_MAX = 32000;
// ページの読み取りを待つ上限。応答しないページで保存ボタンが押せないままにならないように。
const READ_WAIT_MS = 1500;
const LAST_KEY = "knLastResult";
// このポップアップで送るクリップの番号。送り直しても同じ番号なので、気になり帳の側で
// 「もう保存してある」と分かり、二重に入らない。
const CLIP_ID = newClipId();
let pageInfo = { title: "", url: "", img: "" };
let ready = false; // init() が終わるまで保存させない
let saving = false; // 送信中（二度押しで裏タブが2つ開かないように）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// クリップの番号（16バイトの乱数を16進32文字に）
function newClipId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fillCats(sel) {
  $("cat").innerHTML = "";
  CATS.forEach((c) => {
    const o = document.createElement("option");
    o.value = c; o.textContent = c;
    if (c === sel) o.selected = true;
    $("cat").appendChild(o);
  });
}

function setStatus(text, isErr) {
  $("status").classList.toggle("err", !!isErr);
  $("status").textContent = text;
}

function setNotice(lines, isErr) {
  const list = (lines || []).filter(Boolean);
  $("notice").classList.toggle("err", !!isErr);
  $("notice").textContent = list.join(" ");
}

async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let info = { title: tab ? (tab.title || "") : "", url: tab ? (tab.url || "") : "", selection: "", img: "", desc: "", cut: false, readErr: false, slow: false };
  if (tab && tab.id != null && /^https?:/i.test(info.url)) {
    let late = false;
    try {
      // 応答しないページ（重い処理で固まっている等）では executeScript が返ってこず、
      // 保存ボタンが押せないままになっていた。READ_WAIT_MS で見切って、タイトルとURLで続ける。
      const [res] = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [SEL_MAX],
          func: (max) => {
            const meta = (k) => { const e = document.querySelector(`meta[property="${k}"]`) || document.querySelector(`meta[name="${k}"]`); return e ? (e.getAttribute("content") || "") : ""; };
            let sel = "";
            try { sel = String(window.getSelection ? window.getSelection() : ""); } catch (e) {}
            const cut = sel.length > max;
            return { title: document.title, url: location.href, selection: cut ? sel.slice(0, max) : sel, cut, img: meta("og:image"), desc: meta("og:description") || meta("description") };
          }
        }),
        sleep(READ_WAIT_MS).then(() => { late = true; throw new Error("timeout"); })
      ]);
      if (res && res.result) info = Object.assign(info, res.result);
      else info.readErr = true;
    } catch (e) {
      // PDFビューアなど、拡張が中身を読めないページ。タイトルとURLだけで続ける。
      info.readErr = true;
      info.slow = late;
    }
  }
  return info;
}

// http のままでよい保存先（ローカル・社内）か。それ以外の http は GitHub Pages などで
// https へ転送されることが多く、転送先は別のオリジンなので、そこへの許可が無いと確認できない。
function isLocalHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (!h.includes(".")) return true; // 社内の1語のホスト名（IPv6 の ::1 なども）
  if (/\.(local|lan|internal|home\.arpa)$/.test(h)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

// 保存先URLからホスト権限のパターンを作る（http/https のみ）。
// ローカル・社内以外の http は https へ転送されることが多いので、https 側も一緒に求める。
function permOrigins(base) {
  try {
    const u = new URL(base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const list = [u.origin + "/*"];
    if (u.protocol === "http:" && !isLocalHost(u.hostname)) list.push("https://" + u.hostname + "/*");
    return list;
  } catch (e) { return null; }
}

// ローカル・社内以外の http の保存先への注意書き（問題なければ ""）
function httpNote(base) {
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" || isLocalHost(u.hostname)) return "";
  } catch (e) { return ""; }
  return "※ http:// のURLです。GitHub Pages などは https:// へ転送されるので、保存先URLは https:// で入れてください（http のままだと保存を確認できないことがあります）。";
}

// 権限の要求は保存の途中ではなく、この設定ボタンからだけ行う。
// （保存中に要求するとダイアログでポップアップごと消え、その回の保存が飛ぶ）
// 閲覧履歴の権限も同じボタンで求める（クリップの中身が入ったURLを履歴から消すためだけに使う）。
async function refreshPermUi() {
  const base = ($("kurl").value || "").trim();
  const origins = permOrigins(base);
  const btn = $("perm"), msg = $("permMsg");
  msg.classList.remove("ok", "err");
  if (!origins) {
    btn.disabled = true;
    btn.textContent = "保存の確認を許可する";
    msg.textContent = "先に保存先URLを入れてください。";
    return;
  }
  const warn = httpNote(base);
  let hasSite = false, hasHist = false;
  try { hasSite = await chrome.permissions.contains({ origins }); } catch (e) {}
  try { hasHist = await chrome.permissions.contains({ permissions: ["history"] }); } catch (e) {}
  if (hasSite && hasHist) {
    btn.disabled = true;
    btn.textContent = "保存の確認: 許可済み";
    msg.classList.add(warn ? "err" : "ok");
    msg.textContent = ["保存が終わったのを確かめてから裏のタブを閉じ、そのURLを閲覧履歴から消します。", warn].filter(Boolean).join(" ");
  } else if (hasSite) {
    // 1.2 までに保存の確認だけ許可していた場合。履歴の分だけ足せるようにしておく。
    btn.disabled = false;
    btn.textContent = "履歴からの消去も許可する";
    if (warn) msg.classList.add("err");
    msg.textContent = ["保存の確認は許可済みです。閲覧履歴も許可すると、クリップの中身が入ったURLを履歴から消します。", warn].filter(Boolean).join(" ");
  } else {
    btn.disabled = false;
    btn.textContent = "保存の確認を許可する";
    if (warn) msg.classList.add("err");
    msg.textContent = ["許可すると、裏で開いたタブの保存が終わったのを確かめてから閉じます（あわせて求める閲覧履歴の許可は、クリップの中身が入ったURLを履歴から消すためだけに使います）。許可しなくても保存は動きますが、保存できたかどうかは分かりません。", warn].filter(Boolean).join(" ");
  }
}

// 前回の結果（ポップアップが先に閉じて伝えられなかったぶん）を出す
async function lastResultNote() {
  try {
    const o = await chrome.storage.session.get(LAST_KEY);
    const r = o && o[LAST_KEY];
    await chrome.storage.session.remove(LAST_KEY);
    if (!r || !r.status || r.status === "saved" || r.status === "dup") return "";
    if (r.status === "blind" && !r.err) return ""; // 許可していないだけ。毎回は言わない
    if (Date.now() - (r.at || 0) > 10 * 60 * 1000) return ""; // 古すぎる結果は出さない
    if (r.status === "blind") return "前回: " + r.err; // 転送されていて確認できなかった（直し方つき）
    if (r.status === "closed") return "前回は保存先のタブが閉じられたため、保存できたかどうか分かりません。";
    if (r.status === "unconfirmed") return "前回の保存は確認できませんでした。保存先URLが正しいか確かめてください。";
    if (r.status === "quota") return "前回は保存先（気になり帳）の容量がいっぱいで保存できませんでした。古いメモや画像を減らしてから保存し直してください。";
    if (r.status === "parse") return "前回は保存先（気になり帳）が受け取れない形式でした。気になり帳とこの拡張を最新版にしてください。";
    return "前回は保存できませんでした。保存先URLが正しいか確かめてください。";
  } catch (e) { return ""; }
}

async function init() {
  // 前回の結果のバッジは、ここで文章にして出すので消す
  try {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "気になり帳に保存" });
  } catch (e) {}

  const cfg = await chrome.storage.sync.get(["kininariUrl", "defcat", "deffolder"]);
  fillCats(cfg.defcat || "調べる");
  if (cfg.deffolder) $("folder").value = cfg.deffolder;
  if (cfg.kininariUrl) $("kurl").value = cfg.kininariUrl;
  if (!cfg.kininariUrl) { $("settings").classList.add("open"); setStatus("初回: 下の設定で保存先URLを入れてください。", false); }

  const info = await readActiveTab();
  pageInfo = info;
  $("title").value = info.title || info.url || "";
  $("url").textContent = info.url || "(取得できませんでした)";
  $("note").value = (info.selection || "").trim() || (info.desc || "").trim();

  const notes = [];
  const last = await lastResultNote();
  if (last) notes.push(last);
  if (info.slow) notes.push("ページの読み取りが間に合わなかったので、タイトルとURLだけで保存します。");
  else if (info.readErr) notes.push("このページの中身は読み取れませんでした（PDFなど）。タイトルとURLだけで保存します。");
  if (info.cut) notes.push("選択テキストが長いので、先頭" + SEL_MAX + "文字だけ取り込みました。");
  setNotice(notes, !!last);

  await refreshPermUi();

  if (!/^https?:/i.test(info.url || "")) {
    setStatus("このページは保存できません（通常のWebページで使ってください）。", true);
    return; // 保存ボタンは無効のまま
  }
  ready = true;
  $("save").disabled = false;
}

// 保存先URLに ?kn_clip=<クリップの番号> を付ける（# 以降は付け直すので落とす）。
// アプリは #knadd を受け取るとURLから消すが ?以降は残すので、ブラウザの再起動で
// 復元されたタブもこの番号で見分けられる。元からある ?… はそのまま残し、前の番号
// （開いたタブのURLをそのまま設定に貼った場合など）は外して付け直す。
function clipBase(base, id) {
  const s = base.split("#")[0];
  const q = s.indexOf("?");
  const path = q < 0 ? s : s.slice(0, q);
  const keep = q < 0 ? [] : s.slice(q + 1).split("&").filter((p) => p && !/^kn_clip(=|$)/.test(p));
  return path + "?" + keep.concat("kn_clip=" + id).join("&");
}

// 送る前にURLの長さを見て、はみ出すぶんを削る（切られて丸ごと失うのを防ぐ）
// 番号は中身（k）にも入れる。結合アプリ index.html 経由だと ?kn_clip= は気になり帳まで届かない。
function buildUrl(base, note) {
  const head = clipBase(base, CLIP_ID) + "#knadd=";
  const mk = (n, img) => head + encodeURIComponent(JSON.stringify({
    t: ($("title").value || "").trim(),
    u: pageInfo.url,
    n: n,
    img: img,
    c: $("cat").value,
    f: ($("folder").value || "").trim(),
    k: CLIP_ID
  }));
  let n = note, img = pageInfo.img || "";
  let url = mk(n, img);
  let cutImg = false, cutNote = false;
  if (url.length > URL_MAX && img) { img = ""; cutImg = true; url = mk(n, img); }
  while (url.length > URL_MAX && n.length) {
    n = n.slice(0, Math.max(0, Math.floor(n.length * 0.8) - 1));
    cutNote = true;
    url = mk(n, img);
  }
  if (url.length > URL_MAX) return { url: "", cutImg, cutNote };
  return { url, cutImg, cutNote };
}

$("gear").addEventListener("click", () => $("settings").classList.toggle("open"));
$("kurl").addEventListener("input", () => { refreshPermUi(); });

$("perm").addEventListener("click", () => {
  const base = ($("kurl").value || "").trim();
  const origins = permOrigins(base);
  if (!origins) { $("permMsg").classList.add("err"); $("permMsg").textContent = "保存先URLは https:// または http:// で始めてください。"; return; }
  const fail = (e) => {
    $("permMsg").classList.add("err");
    $("permMsg").textContent = "許可を求められませんでした: " + String((e && e.message) || e);
  };
  // chrome.permissions.request は「ボタンを押した直後」でないと弾かれるので、
  // 手前に await を置かない（待っている間に押した扱いが切れることがある）。
  let req = null;
  try { req = chrome.permissions.request({ permissions: ["history"], origins }); }
  catch (e) { fail(e); return; }
  // 入力された保存先URLは要求のあとで覚える。await していないので「押した直後」の
  // 条件は崩れず、許可ダイアログでポップアップごと閉じてもこの書き込みは残る。
  try { Promise.resolve(chrome.storage.sync.set({ kininariUrl: base })).catch(() => {}); } catch (e) {}
  Promise.resolve(req).then(() => refreshPermUi(), fail);
});

$("save").addEventListener("click", async () => {
  if (!ready || saving) return; // 読み込み中に押されても、URL無しの空メモを作らない
  const base = ($("kurl").value || "").trim();
  if (!base) { $("settings").classList.add("open"); setStatus("保存先のURLを入れてください。", true); return; }
  if (!/^https?:\/\//i.test(base)) { setStatus("URLは https:// または http:// で始めてください。", true); return; }

  const built = buildUrl(base, ($("note").value || "").trim());
  if (!built.url) { setStatus("内容が大きすぎて保存できません。メモかタイトルを短くしてください。", true); return; }
  if (built.cutImg || built.cutNote) {
    setNotice([built.cutImg ? "URLが長すぎるため画像は付けませんでした。" : "", built.cutNote ? "URLが長すぎるためメモを短くしました。" : ""], false);
  }

  // 最初の await より前に止める。設定の書き込みを待っている間にもう一度押されると、
  // 両方がここを通って裏タブが2つ開いていた。
  saving = true;
  $("save").disabled = true;
  setStatus("保存中…（このポップアップは閉じても大丈夫です）", false);
  const again = () => { saving = false; $("save").disabled = false; };
  // 設定を覚えられなくても保存は続ける（ここで止まると、ボタンが押せないまま固まる）
  try { await chrome.storage.sync.set({ kininariUrl: base, defcat: $("cat").value, deffolder: ($("folder").value || "").trim() }); } catch (e) {}

  chrome.runtime.sendMessage({ type: "clip", url: built.url }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      // 返事が来ない＝拡張が休止した等。何が起きたかは分からないので理由を決めつけない。
      // 結果はツールバーのバッジと「前回の結果」に残るので、そちらを見てもらう。
      setStatus("結果を受け取れませんでした。ツールバーのアイコンの表示を確認してください。", true);
      again();
      return;
    }
    if (resp.status === "saved" || resp.status === "dup") {
      // dup＝同じクリップが前に届いていた（送り直しなど）。二重には入れていない。
      setStatus(resp.status === "dup" ? "もう保存してありました ✓" : "気になり帳に保存しました ✓", false);
      setTimeout(() => window.close(), resp.status === "dup" ? 1400 : 800);
      return;
    }
    if (resp.status === "blind") {
      // 保存先を開くところまではできた。確認していないので「保存しました」とは言わない。
      setStatus("保存先を開きました（保存できたかは未確認）", false);
      if (resp.err) {
        // 許可はあるのに転送されていて確かめられなかった。直し方を読めるよう、閉じずに残す。
        setNotice([String(resp.err)], true);
        again();
        return;
      }
      setNotice(["⚙の「保存の確認を許可する」を押すと、保存できたか確かめられます。"], false);
      setTimeout(() => window.close(), 1600);
      return;
    }
    if (resp.status === "closed") {
      // 裏のタブが手で（またはウィンドウごと）閉じられた場合。保存できたかは分からない。
      setStatus("保存先のタブが閉じられたため、保存できたか分かりません。", true);
      setNotice(["もう一度保存すると確実です（保存できていた場合、二重には入りません）。"], false);
    } else if (resp.status === "unconfirmed") {
      setStatus("保存を確認できませんでした。保存先URLを確認してください。", true);
    } else if (resp.status === "quota") {
      setStatus("保存先（気になり帳）の容量がいっぱいで保存できませんでした。", true);
      setNotice(["気になり帳で古いメモや画像を減らしてから、もう一度保存してください。"], false);
    } else if (resp.status === "parse") {
      setStatus("保存先（気になり帳）が受け取れない形式でした。", true);
      setNotice(["気になり帳（kininari.html）とこの拡張を、どちらも最新版にしてください。"], false);
    } else {
      setStatus("保存できませんでした。保存先URLを確認してください。", true);
      if (resp.err) setNotice([String(resp.err)], true);
    }
    again();
  });
});

// 準備中にボタンを押せてしまうと、URL無しの「(無題)」メモができてしまうので、
// init() が終わるまで（失敗したときはずっと）保存ボタンは無効のままにする。
init().catch((e) => {
  setStatus("準備に失敗しました。拡張を読み込み直してください。", true);
  setNotice([String((e && e.message) || e)], true);
});
