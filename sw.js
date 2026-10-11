/* 気になり帳 service worker — notifications */
/* The page may schedule notifications via the Notification Triggers API
   (TimestampTrigger) when available. NOTE: that API only existed as Chrome
   origin trials (M80–83, M86–88) and was never shipped to stable browsers,
   so on current Chrome/Edge/Safari it is NOT available — the app feature-
   detects this and falls back to in-app reminders while a tab is open.
   This worker is kept for: (1) immediate activation, and (2) handling
   clicks on notifications if a supporting browser ever schedules them. */

const CACHE_NAME = "nk-shell-v26";
const SHELL_ASSETS = ["./", "./index.html", "./kininari.html", "./diary.html", "./image-streaming.html", "./bgm.html", "./autogenic.html", "./tasks.html", "./sync.js", "./version.js", "./clipper.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-512-maskable.png",
  // 就寝用の音はオフラインでも鳴らせるようにキャッシュしておく（各625KB）
  "./audio/brown.wav", "./audio/pink.wav", "./audio/rain.wav"];

/* ★ キャッシュの鍵は、URLの ? や # より前だけにする。共有メニュー（share_target）からは
   index.html?title=…&text=…&url=… で開かれるため、URL丸ごとを鍵にすると、共有した文章が
   そのまま Cache Storage に残り、オフライン時には共有した日の古い index.html が出てくることがあった。
   （各タブへ渡す kininari.html#knadd=… の # の後ろも、鍵に入って残っていた）
   置いているのは静的なファイルだけなので、? や # の後ろで中身は変わらない。 */
function cacheKey(url) { return url.origin + url.pathname; }
// 事前キャッシュの対象（鍵の形で）。音の 206 のあとで丸ごと取り直すかの判定に使う
const PRECACHE_KEYS = new Set(SHELL_ASSETS.map((u) => cacheKey(new URL(u, self.location.href))));

self.addEventListener("install", (event) => {
  // ネットワーク優先＋オフライン時フォールバック用に主要ファイルを事前キャッシュ。
  // addAll は1つでも失敗すると全体が失敗するので、1件ずつ入れて取りこぼしを防ぐ。
  // cache:"reload" … ブラウザのHTTPキャッシュに残った前の版を拾わず、必ずサーバーから取る
  // （GitHub Pages は10分キャッシュさせるので、版を上げた直後だと新旧が混ざることがあった）
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => Promise.all(SHELL_ASSETS.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))))
      .catch(() => {}) // 一部が無くてもインストールは続行
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    // 旧版は ? や # 付きのURL（共有で開いた index.html?title=…&text=…、それを気になり帳へ渡す
    // kininari.html#knadd=… など）を丸ごと鍵にして入れていた。共有した文章を残さないよう、
    // いまのキャッシュからもそうした項目は捨てる。
    try {
      const c = await caches.open(CACHE_NAME);
      const reqs = await c.keys();
      await Promise.all(reqs.filter((r) => { const u = new URL(r.url); return u.search || u.hash; }).map((r) => c.delete(r)));
    } catch (e) {}
    await self.clients.claim();
  })());
});

/* <audio> は Range 付き（bytes=0-1 など）で取りに来る。iOS Safari は 206（部分応答）で
   返さないと再生しないため、キャッシュに入れた就寝用の音がオフラインで鳴らなかった。
   キャッシュから返すときは、頼まれた範囲だけを切り出して 206 で返す。
   （ネットワークから返すときはサーバーが 206 を返すので、そのまま渡す） */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;      // 複数範囲などは扱わない（丸ごと返す）
  let start, end;
  if (m[1] === "") {                                         // bytes=-500 … 末尾の500バイト
    const n = parseInt(m[2], 10);
    if (!(n > 0)) return { bad: true };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (!(start >= 0) || start >= size || end < start) return { bad: true };
  return { start, end };
}
async function rangeFromCache(req, res) {
  const header = req.headers.get("range");
  if (!header || !res || res.status !== 200) return res;
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const type = res.headers.get("content-type") || "application/octet-stream";
  const r = parseRange(header, size);
  if (!r) return new Response(buf, { status: 200, headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" } });
  if (r.bad) return new Response(null, { status: 416, statusText: "Range Not Satisfiable", headers: { "Content-Range": "bytes */" + size, "Accept-Ranges": "bytes" } });
  return new Response(buf.slice(r.start, r.end + 1), {
    status: 206, statusText: "Partial Content",
    headers: { "Content-Type": type, "Content-Range": "bytes " + r.start + "-" + r.end + "/" + size,
               "Content-Length": String(r.end - r.start + 1), "Accept-Ranges": "bytes" }
  });
}

/* 就寝用の音は install のときにしか丸ごと取りに行かない。<audio> の再生は 206（部分応答）で
   キャッシュに入らないため、最初の事前キャッシュで音だけ取りこぼすと、オフラインではずっと鳴らなかった。
   206 を渡したついでに、まだキャッシュに無ければ Range を付けずに丸ごと取って入れておく。 */
const filling = new Set();
async function fillWhole(key) {
  if (filling.has(key)) return;   // <audio> は続けて何度も取りに来るので、取り直しは1本だけ
  filling.add(key);
  try {
    const c = await caches.open(CACHE_NAME);
    if (await c.match(key)) return;
    const res = await fetch(key);
    if (res.ok && res.status === 200) await c.put(key, res);
  } catch (e) {} finally { filling.delete(key); }
}

/* オフラインでキャッシュにも無いとき。index.html で代わりに開くのは画面の移動（ナビゲーション）だけ。
   以前は音・画像・JSON の取りこぼしにも index.html を返していたため、<audio> や fetch には
   「HTMLが届いた」ように見えて、取れなかったことが分からなかった。
   iframe の中まで index.html にすると、その中にまたタブ帯とフレームができて入れ子が続くので除く。 */
function offline(req) {
  if (req.mode === "navigate" && req.destination !== "iframe") return caches.match("./index.html").then((r) => r || Response.error());
  return Response.error();
}

/* ネットワーク優先: オンライン時は常に最新を取得して裏でキャッシュ更新、
   オフライン時のみキャッシュから返す（古い版を配り続けない）。
   ただし電波が弱くて NET_WAIT たっても返事が無いときは、キャッシュにあればそれで先に返す
   （無ければそのまま待つ）。遅れて届いた応答は、裏でキャッシュの更新に使う。
   Range 付き（<audio>）も同じ扱い。キャッシュから返すときは rangeFromCache が切り出す。 */
const NET_WAIT = 4000;
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  const key = cacheKey(url);
  // URLそのもので探し、無ければ ? を外した鍵で探す
  const fromCache = () => caches.match(req).then((hit) => hit || caches.match(key));
  let saved = Promise.resolve();
  const net = fetch(req).then((res) => {
    // 部分応答（206）は Cache に入らない（put が必ず失敗する）ので、丸ごとの応答だけ入れる
    if (res && res.ok && res.status !== 206) {
      // 応答の側にも取ったときのURL（? の後ろの共有した文章ごと）が残るので、? 付きならURLを持たない形に作り直す
      const copy = url.search ? new Response(res.clone().body, res) : res.clone();
      saved = caches.open(CACHE_NAME).then((c) => c.put(key, copy)).catch(() => {});
    } else if (res && res.status === 206 && PRECACHE_KEYS.has(key)) {
      saved = fillWhole(key);
    }
    return res;
  });
  // キャッシュで先に返したあとも、裏の更新が終わるまで worker を止めさせない
  event.waitUntil(net.then(() => saved, () => {}));
  event.respondWith(new Promise((resolve) => {
    let done = false;
    const answer = (res) => { if (!done) { done = true; resolve(res); } };
    net.then(answer, async () => {
      const hit = await fromCache().catch(() => null);
      answer(hit ? rangeFromCache(req, hit) : offline(req));
    });
    setTimeout(() => {
      if (done) return;
      fromCache().then((hit) => { if (hit) answer(rangeFromCache(req, hit)); }).catch(() => {});
    }, NET_WAIT);
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = (event.notification.data && event.notification.data.url) || "./";
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) {
      try { await c.focus(); return; } catch (e) {}
    }
    if (self.clients.openWindow) {
      try { return await self.clients.openWindow(url); } catch (e) {}
    }
  })());
});
