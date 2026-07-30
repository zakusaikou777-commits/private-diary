// クリップ要求を受けて、気になり帳のディープリンクをバックグラウンドタブで開き、
// 保存が終わったらそのタブを閉じる。
//
// 旧版は「読み込み完了から5秒」の固定タイマーで閉じていたため、回線が遅い/
// バックグラウンドタブがスロットルされると、保存前に閉じてクリップを失う
// ことがあった。いまはアプリ側が立てる window.__kininariClipSaved を
// ポーリングして、保存を確認してから閉じる（権限が無い場合は従来どおり待つ）。

const POLL_MS = 400;
const POLL_MAX_MS = 20000;   // ここまでは保存完了を待つ
const BLIND_WAIT_MS = 8000;  // 権限が無くて確認できないときの待ち時間
const HARD_LIMIT_MS = 25000; // 何があってもここで閉じる

function originOf(url) {
  try { return new URL(url).origin + "/*"; } catch (e) { return null; }
}

async function canScript(origin) {
  if (!origin) return false;
  try { return await chrome.permissions.contains({ origins: [origin] }); }
  catch (e) { return false; }
}

async function savedInTab(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__kininariClipSaved === true
    });
    return !!(res && res.result);
  } catch (e) {
    return null; // 実行できない（権限なし・まだ読み込み中など）
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!(msg && msg.type === "clip" && msg.url)) return;

  chrome.tabs.create({ url: msg.url, active: false }, async (tab) => {
    if (chrome.runtime.lastError || !tab) {
      sendResponse({ ok: false, err: String(chrome.runtime.lastError || "no tab") });
      return;
    }
    const tabId = tab.id;
    let done = false;

    const closeTab = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
      chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
    };

    const onUpd = async (id, info) => {
      if (id !== tabId || info.status !== "complete") return;
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}

      const origin = originOf(msg.url);
      if (!(await canScript(origin))) {
        // 保存を確認する権限が無いので、余裕をもって待つだけにする
        setTimeout(closeTab, BLIND_WAIT_MS);
        return;
      }
      const started = Date.now();
      const poll = async () => {
        if (done) return;
        const ok = await savedInTab(tabId);
        if (ok === true) { closeTab(); return; }
        if (Date.now() - started > POLL_MAX_MS) { closeTab(); return; }
        setTimeout(poll, POLL_MS);
      };
      poll();
    };

    chrome.tabs.onUpdated.addListener(onUpd);
    setTimeout(closeTab, HARD_LIMIT_MS); // 最後の安全網
    sendResponse({ ok: true });
  });

  return true; // 非同期で応答する
});
