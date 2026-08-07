const $ = (id) => document.getElementById(id);
const CATS = ["メモ", "アイデア", "調べる", "やること", "行きたい"];
// 選択テキストの上限。共有メニュー経由（index.html）と同じ2000文字にそろえる
// （ブックマークレットは800文字）。日本語は encodeURIComponent で約9倍に膨らむので、
// 上限が無いとURLが数百KB〜数MBになり、途中で切られてクリップが丸ごと消える。
const SEL_MAX = 2000;
// #knadd= まで含めた最終URLの上限。ここを超えそうなら送る前に削る。
const URL_MAX = 8000;
const LAST_KEY = "knLastResult";
let pageInfo = { title: "", url: "", img: "" };
let ready = false; // init() が終わるまで保存させない

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
  let info = { title: tab ? (tab.title || "") : "", url: tab ? (tab.url || "") : "", selection: "", img: "", desc: "", cut: false, readErr: false };
  if (tab && tab.id != null && /^https?:/i.test(info.url)) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [SEL_MAX],
        func: (max) => {
          const meta = (k) => { const e = document.querySelector(`meta[property="${k}"]`) || document.querySelector(`meta[name="${k}"]`); return e ? (e.getAttribute("content") || "") : ""; };
          let sel = "";
          try { sel = String(window.getSelection ? window.getSelection() : ""); } catch (e) {}
          const cut = sel.length > max;
          return { title: document.title, url: location.href, selection: cut ? sel.slice(0, max) : sel, cut, img: meta("og:image"), desc: meta("og:description") || meta("description") };
        }
      });
      if (res && res.result) info = Object.assign(info, res.result);
      else info.readErr = true;
    } catch (e) {
      // PDFビューアなど、拡張が中身を読めないページ。タイトルとURLだけで続ける。
      info.readErr = true;
    }
  }
  return info;
}

// 保存先URLからホスト権限のパターンを作る（http/https のみ）
function originPattern(base) {
  try {
    const u = new URL(base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin + "/*";
  } catch (e) { return null; }
}

// 権限の要求は保存の途中ではなく、この設定ボタンからだけ行う。
// （保存中に要求するとダイアログでポップアップごと消え、その回の保存が飛ぶ）
async function refreshPermUi() {
  const origin = originPattern(($("kurl").value || "").trim());
  const btn = $("perm"), msg = $("permMsg");
  msg.classList.remove("ok", "err");
  if (!origin) {
    btn.disabled = true;
    btn.textContent = "保存の確認を許可する";
    msg.textContent = "先に保存先URLを入れてください。";
    return;
  }
  let has = false;
  try { has = await chrome.permissions.contains({ origins: [origin] }); } catch (e) {}
  if (has) {
    btn.disabled = true;
    btn.textContent = "保存の確認: 許可済み";
    msg.classList.add("ok");
    msg.textContent = "保存が終わったのを確かめてから、裏のタブを閉じます。";
  } else {
    btn.disabled = false;
    btn.textContent = "保存の確認を許可する";
    msg.textContent = "許可すると、裏で開いたタブの保存が終わったのを確かめてから閉じます。許可しなくても保存は動きますが、保存できたかどうかは分かりません。";
  }
}

// 前回の結果（ポップアップが先に閉じて伝えられなかったぶん）を出す
async function lastResultNote() {
  try {
    const o = await chrome.storage.session.get(LAST_KEY);
    const r = o && o[LAST_KEY];
    await chrome.storage.session.remove(LAST_KEY);
    if (!r || !r.status || r.status === "saved" || r.status === "blind") return "";
    if (Date.now() - (r.at || 0) > 10 * 60 * 1000) return ""; // 古すぎる結果は出さない
    if (r.status === "closed") return "前回は保存先のタブが閉じられたため、保存できたかどうか分かりません。";
    if (r.status === "unconfirmed") return "前回の保存は確認できませんでした。保存先URLが正しいか確かめてください。";
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
  if (info.readErr) notes.push("このページの中身は読み取れませんでした（PDFなど）。タイトルとURLだけで保存します。");
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

// 送る前にURLの長さを見て、はみ出すぶんを削る（切られて丸ごと失うのを防ぐ）
function buildUrl(base, note) {
  const head = base.split("#")[0] + "#knadd=";
  const mk = (n, img) => head + encodeURIComponent(JSON.stringify({
    t: ($("title").value || "").trim(),
    u: pageInfo.url,
    n: n,
    img: img,
    c: $("cat").value,
    f: ($("folder").value || "").trim()
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
  const origin = originPattern(base);
  if (!origin) { $("permMsg").classList.add("err"); $("permMsg").textContent = "保存先URLは https:// または http:// で始めてください。"; return; }
  const fail = (e) => {
    $("permMsg").classList.add("err");
    $("permMsg").textContent = "許可を求められませんでした: " + String((e && e.message) || e);
  };
  // chrome.permissions.request は「ボタンを押した直後」でないと弾かれるので、
  // 手前に await を置かない（待っている間に押した扱いが切れることがある）。
  let req = null;
  try { req = chrome.permissions.request({ origins: [origin] }); }
  catch (e) { fail(e); return; }
  // 入力された保存先URLは要求のあとで覚える。await していないので「押した直後」の
  // 条件は崩れず、許可ダイアログでポップアップごと閉じてもこの書き込みは残る。
  try { Promise.resolve(chrome.storage.sync.set({ kininariUrl: base })).catch(() => {}); } catch (e) {}
  Promise.resolve(req).then(() => refreshPermUi(), fail);
});

$("save").addEventListener("click", async () => {
  if (!ready) return; // 読み込み中に押されても、URL無しの空メモを作らない
  const base = ($("kurl").value || "").trim();
  if (!base) { $("settings").classList.add("open"); setStatus("保存先のURLを入れてください。", true); return; }
  if (!/^https?:\/\//i.test(base)) { setStatus("URLは https:// または http:// で始めてください。", true); return; }
  await chrome.storage.sync.set({ kininariUrl: base, defcat: $("cat").value, deffolder: ($("folder").value || "").trim() });

  const built = buildUrl(base, ($("note").value || "").trim());
  if (!built.url) { setStatus("内容が大きすぎて保存できません。メモかタイトルを短くしてください。", true); return; }
  if (built.cutImg || built.cutNote) {
    setNotice([built.cutImg ? "URLが長すぎるため画像は付けませんでした。" : "", built.cutNote ? "URLが長すぎるためメモを短くしました。" : ""], false);
  }

  $("save").disabled = true;
  setStatus("保存中…（このポップアップは閉じても大丈夫です）", false);

  chrome.runtime.sendMessage({ type: "clip", url: built.url }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      // 返事が来ない＝拡張が休止した等。何が起きたかは分からないので理由を決めつけない。
      // 結果はツールバーのバッジと「前回の結果」に残るので、そちらを見てもらう。
      setStatus("結果を受け取れませんでした。ツールバーのアイコンの表示を確認してください。", true);
      $("save").disabled = false;
      return;
    }
    if (resp.status === "saved") {
      setStatus("気になり帳に保存しました ✓", false);
      setTimeout(() => window.close(), 800);
      return;
    }
    if (resp.status === "blind") {
      // 保存先を開くところまではできた。確認していないので「保存しました」とは言わない。
      setStatus("保存先を開きました（保存できたかは未確認）", false);
      setNotice(["⚙の「保存の確認を許可する」を押すと、保存できたか確かめられます。"], false);
      setTimeout(() => window.close(), 1600);
      return;
    }
    if (resp.status === "closed") {
      // 裏のタブが手で（またはウィンドウごと）閉じられた場合。保存できたかは分からない。
      setStatus("保存先のタブが閉じられたため、保存できたか分かりません。", true);
      setNotice(["もう一度保存すると確実です（同じ内容が二重に入ることがあります）。"], false);
    } else if (resp.status === "unconfirmed") {
      setStatus("保存を確認できませんでした。保存先URLを確認してください。", true);
    } else {
      setStatus("保存できませんでした。保存先URLを確認してください。", true);
      if (resp.err) setNotice([String(resp.err)], true);
    }
    $("save").disabled = false;
  });
});

// 準備中にボタンを押せてしまうと、URL無しの「(無題)」メモができてしまうので、
// init() が終わるまで（失敗したときはずっと）保存ボタンは無効のままにする。
init().catch((e) => {
  setStatus("準備に失敗しました。拡張を読み込み直してください。", true);
  setNotice([String((e && e.message) || e)], true);
});
