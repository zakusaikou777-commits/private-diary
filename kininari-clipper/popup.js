const $ = (id) => document.getElementById(id);
const CATS = ["メモ", "アイデア", "調べる", "やること", "行きたい"];
let pageInfo = { title: "", url: "", img: "" };

function fillCats(sel) {
  $("cat").innerHTML = "";
  CATS.forEach((c) => {
    const o = document.createElement("option");
    o.value = c; o.textContent = c;
    if (c === sel) o.selected = true;
    $("cat").appendChild(o);
  });
}

async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let info = { title: tab ? (tab.title || "") : "", url: tab ? (tab.url || "") : "", selection: "", img: "", desc: "" };
  if (tab && tab.id != null && /^https?:/i.test(info.url)) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const meta = (k) => { const e = document.querySelector(`meta[property="${k}"]`) || document.querySelector(`meta[name="${k}"]`); return e ? (e.getAttribute("content") || "") : ""; };
          return { title: document.title, url: location.href, selection: String(window.getSelection ? window.getSelection() : ""), img: meta("og:image"), desc: meta("og:description") || meta("description") };
        }
      });
      if (res && res.result) info = Object.assign(info, res.result);
    } catch (e) { /* some pages block scripting; fall back to tab.title/url */ }
  }
  return info;
}

async function init() {
  const cfg = await chrome.storage.sync.get(["kininariUrl", "defcat", "deffolder"]);
  fillCats(cfg.defcat || "調べる");
  if (cfg.deffolder) $("folder").value = cfg.deffolder;
  if (cfg.kininariUrl) $("kurl").value = cfg.kininariUrl;
  if (!cfg.kininariUrl) { $("settings").classList.add("open"); $("status").textContent = "初回: 下の設定で保存先URLを入れてください。"; }

  const info = await readActiveTab();
  pageInfo = info;
  $("title").value = info.title || info.url || "";
  $("url").textContent = info.url || "(取得できませんでした)";
  $("note").value = (info.selection || "").trim() || (info.desc || "").trim();
  if (!/^https?:/i.test(info.url || "")) {
    $("status").classList.add("err");
    $("status").textContent = "このページは保存できません（通常のWebページで使ってください）。";
    $("save").disabled = true;
  }
}

$("gear").addEventListener("click", () => $("settings").classList.toggle("open"));

$("save").addEventListener("click", async () => {
  const base = ($("kurl").value || "").trim();
  if (!base) { $("settings").classList.add("open"); $("status").classList.add("err"); $("status").textContent = "保存先のURLを入れてください。"; return; }
  if (!/^https?:\/\//i.test(base)) { $("status").classList.add("err"); $("status").textContent = "URLは https:// で始めてください。"; return; }
  await chrome.storage.sync.set({ kininariUrl: base, defcat: $("cat").value, deffolder: ($("folder").value || "").trim() });

  // 保存先のオリジンにアクセスできると、「保存が終わったか」を確認してから
  // タブを閉じられる（固定時間で閉じてクリップを失う事故を防げる）。
  // 断られても従来どおり時間待ちで動くので、そのまま続行する。
  try {
    const origin = new URL(base).origin + "/*";
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      await chrome.permissions.request({ origins: [origin] });
    }
  } catch (e) { /* 権限なしでも保存自体は動く */ }

  const payload = { t: ($("title").value || "").trim(), u: pageInfo.url, n: ($("note").value || "").trim(), img: pageInfo.img || "", c: $("cat").value, f: ($("folder").value || "").trim() };
  const url = base.split("#")[0] + "#knadd=" + encodeURIComponent(JSON.stringify(payload));

  $("save").disabled = true;
  chrome.runtime.sendMessage({ type: "clip", url }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      $("status").classList.add("err");
      $("status").textContent = "保存に失敗しました。URL設定を確認してください。";
      $("save").disabled = false;
      return;
    }
    $("status").classList.remove("err");
    $("status").textContent = "気になり帳に保存しました ✓";
    setTimeout(() => window.close(), 800);
  });
});

init();
