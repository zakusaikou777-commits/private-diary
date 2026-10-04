/* ============================================================
   NKSync — 「音」と「暗室」で共用する Google Drive 同期エンジン

   設計メモ:
   - 認証は 3アプリで共有済みの shared:gd:token に相乗りする。
     クライアントIDも気になり帳の kininari:gd:cid を読み、設定を増やさない。
   - Drive上のファイルは1つ（nikki-apps-data.json）。中で app ごとに
     区画を分ける。書き戻すときは他アプリの区画を壊さない。
   - 気になり帳v5で作った同期の教訓をそのまま入れてある:
       * updatedAt で「新しい方が勝つ」マージ（上書きで編集を消さない）
       * 墓標(tombstone)で削除を端末間に伝える
       * 書き込み前に modifiedTime を確認する compare-and-swap
       * 失敗を握りつぶさず、必ず画面に出す
   - 端末ごとの設定（音量・夜間モード・表示状態）は同期対象に含めない。
     各アプリが getLocal() で「同期したいものだけ」を返す。
   ============================================================ */
(function (global) {
  "use strict";

  var FILE_NAME = "nikki-apps-data.json";
  var TOKEN_KEY = "shared:gd:token";   // 3アプリ共有
  var CID_KEY   = "shared:gd:cid";     // 4アプリ共通の置き場
  var CID_OLD   = "kininari:gd:cid";   // 旧: 気になり帳だけが持っていた
  // 気になり帳に埋め込まれている既定ID。旧版はこれを定数で持っていたため
  // localStorage が空のままでも動いてしまい、他アプリから見つけられなかった。
  var CID_BUILTIN = "312868081144-nsjo9gfkm94ol1pha2nhq913g9p1m4e0.apps.googleusercontent.com";
  var DEV_KEY   = "shared:devid";
  var FILE_KEY  = "shared:nksync:file";
  var SCOPE     = "https://www.googleapis.com/auth/drive.file";

  var URGENT_MS = 3000;    // 追加/削除/★など、意味のある変更
  var LAZY_MS   = 120000;  // 再生回数など、統計だけの変更

  /* ── 保存（プライベートモードでも落ちない）───────────────── */
  var store = (function () {
    var ok = false, mem = {};
    try { var k = "__t" + Math.random(); localStorage.setItem(k, "1"); localStorage.removeItem(k); ok = true; } catch (e) { ok = false; }
    return {
      get: function (k) { try { if (ok) return localStorage.getItem(k); } catch (e) {} return (k in mem) ? mem[k] : null; },
      set: function (k, v) { try { if (ok) { localStorage.setItem(k, v); return; } } catch (e) {} mem[k] = v; },
      del: function (k) { try { if (ok) { localStorage.removeItem(k); return; } } catch (e) {} delete mem[k]; }
    };
  })();

  /* ── 端末ID（再生回数を端末ごとに数えるため）───────────────── */
  function devId() {
    var d = store.get(DEV_KEY);
    if (!d) {
      d = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      store.set(DEV_KEY, d);
    }
    return d;
  }

  function clientId() {
    var v = (store.get(CID_KEY) || "").trim();
    if (v) return v;
    v = (store.get(CID_OLD) || "").trim() || CID_BUILTIN;
    if (v) store.set(CID_KEY, v);   // 一度だけ共通の置き場へ移す
    return v;
  }
  function setClientId(v) {
    v = (v || "").trim();
    if (v) store.set(CID_KEY, v); else store.del(CID_KEY);
    store.del(TOKEN_KEY);           // IDが変わったら古いトークンは捨てる
    store.del(FILE_KEY);
  }

  /* ── 汎用マージ部品（各アプリから使う）───────────────────── */
  function itemTime(o) { return (o && (o.updatedAt || o.createdAt)) || 0; }

  /** id ごとに updatedAt の新しい方を採用し、墓標で削除を反映する。
   *  pick(local, remote) を渡すと、勝った側をベースに個別調整できる
   *  （再生回数の合算など）。
   *
   *  第3引数 lastSync は「Driveに無いローカル項目を残すか」の判定に使っていたが、
   *  Driveのサーバー時刻と端末の時計を比べる形だったため、端末の時計が少しでも
   *  遅れていると、追加したばかりの項目が「古いもの」と誤判定されて消えていた。
   *  いまは各項目の synced 印（一度でも同期に成功したか）で判定する。
   *  印が無いものは無条件で残すので、時計に依存しない。 */
  function mergeById(localList, remoteList, lastSync, tombs, key, pick) {
    key = key || "id";
    var tombAt = {};
    (tombs || []).forEach(function (t) {
      if (t && t.id) tombAt[t.id] = Math.max(tombAt[t.id] || 0, t.at || 0);
    });
    var order = [], map = {};
    function put(o) { var k = o[key]; if (!(k in map)) order.push(k); map[k] = o; }
    (remoteList || []).forEach(put);
    (localList || []).forEach(function (o) {
      var k = o[key], r = map[k];
      if (r === undefined) {
        // ローカルにしか無い場合:
        //  - まだ一度も同期していない(synced無し) → 新規なので必ず残す
        //  - 同期済みなのにDriveから消えている → 他端末で削除された → 消す
        if (!o.synced) put(o);
        return;
      }
      var winner = itemTime(o) > itemTime(r) ? o : r;
      map[k] = pick ? pick(o, r, winner) : winner;
    });
    var out = [];
    order.forEach(function (k) {
      var o = map[k];
      if (!o) return;
      var t = tombAt[k];
      if (t && itemTime(o) <= t) return;  // 削除より後の編集は生き残る
      out.push(o);
    });
    return out;
  }

  /** 墓標のマージ（90日で掃除）*/
  function mergeTombs(a, b) {
    var TTL = 90 * 24 * 3600 * 1000, cut = Date.now() - TTL, m = {};
    [].concat(a || [], b || []).forEach(function (t) {
      if (!t || !t.id) return;
      var at = t.at || 0;
      if (!(t.id in m) || m[t.id] < at) m[t.id] = at;
    });
    var out = [];
    for (var id in m) if (m[id] > cut) out.push({ id: id, at: m[id] });
    return out;
  }

  /* ── Google 認証（気になり帳と同じ流れ）─────────────────── */
  function cachedToken() {
    try {
      var o = JSON.parse(store.get(TOKEN_KEY) || "null");
      if (o && o.token && o.exp && Date.now() < o.exp - 60000) return o.token;
    } catch (e) {}
    return null;
  }
  function cacheToken(tok, sec) {
    try { store.set(TOKEN_KEY, JSON.stringify({ token: tok, exp: Date.now() + (sec || 3600) * 1000 })); } catch (e) {}
  }
  function getToken(interactive) {
    var c = cachedToken();
    if (c) return Promise.resolve(c);
    var cid = clientId();
    if (!cid) return Promise.reject(new Error("NOCID"));
    return new Promise(function (res, rej) {
      if (!(global.google && google.accounts && google.accounts.oauth2)) {
        rej(new Error("Googleの読み込みが未完了です")); return;
      }
      var to = setTimeout(function () { rej(new Error("認証がタイムアウトしました")); }, 90000);
      try {
        var tc = google.accounts.oauth2.initTokenClient({
          client_id: cid, scope: SCOPE,
          callback: function (r) {
            clearTimeout(to);
            if (r && r.access_token) { cacheToken(r.access_token, r.expires_in); res(r.access_token); }
            else rej(new Error("認証に失敗しました"));
          },
          error_callback: function () { clearTimeout(to); rej(new Error("認証がキャンセルされました")); }
        });
        tc.requestAccessToken({ prompt: interactive ? "consent" : "" });
      } catch (e) { clearTimeout(to); rej(e); }
    });
  }

  /* ── Drive ──────────────────────────────────────────────── */
  // 1回の通信の上限。同期は全アプリで1本ずつ（下の withFileLock）なので、
  // 返事の来ない通信を待ち続けると、ほかのアプリの同期まで永久に止まる
  var API_TIMEOUT_MS = 60000;
  function api(url, tok, opt) {
    opt = opt || {};
    opt.headers = opt.headers || {};
    opt.headers.Authorization = "Bearer " + tok;
    var timer = null;
    try {
      if (typeof AbortController === "function") {
        var ctl = new AbortController();
        opt.signal = ctl.signal;
        timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, API_TIMEOUT_MS);
      }
    } catch (e) {}
    var done = function () { if (timer) { clearTimeout(timer); timer = null; } };
    return fetch(url, opt).then(function (r) {
      done();
      if (r.status === 401) { store.del(TOKEN_KEY); throw new Error("401 認証の期限切れ"); }
      if (!r.ok) throw new Error(r.status + " Driveへの通信に失敗");
      return r;
    }, function (e) { done(); throw e; });
  }
  /** 同期ファイルを決める。返り値: { id: 正のファイル（無ければ null）, dups: [ほかの同名ファイル] }
   *  同名のファイルが複数あることがある（旧版で全アプリが同時に初回同期した・2台が同時に作った）。
   *  端末ごとに違うものを選ぶと、同期しているつもりで永久にすれ違ううえ、選び直したときに
   *  「同期済みなのに無い＝削除」と誤解して消す。どの端末でも「いちばん古いもの」を正とする。 */
  function findFiles(tok) {
    var cached = store.get(FILE_KEY);
    var q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    return api("https://www.googleapis.com/drive/v3/files?q=" + q + "&orderBy=createdTime&fields=files(id,createdTime,modifiedTime)&pageSize=50", tok)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var fs = ((j && j.files) || []).filter(function (f) { return f && f.id; });
        var seen = !cached || fs.some(function (f) { return f.id === cached; });
        if (seen) return fs;
        // 作った直後のファイルは一覧（検索）にすぐ出ないことがある。覚えているものは直接確かめる。
        // 確かめずに「無い」と決めると、もう1つ作ってしまう
        return metaFull(tok, cached).then(function (m) {
          if (m && m.id && !m.trashed) fs.push(m);
          return fs;
        }, function () { return fs; });
      }, function (e) {
        // 一覧が取れないとき（通信の偽物・権限など）は、覚えているファイルで続ける
        if (cached) return [{ id: cached }];
        throw e;
      })
      .then(function (fs) {
        fs.sort(function (a, b) {
          var x = String(a.createdTime || ""), y = String(b.createdTime || "");
          if (x !== y) return x < y ? -1 : 1;
          return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });
        if (!fs.length) return { id: null, dups: [] };
        store.set(FILE_KEY, fs[0].id);
        return { id: fs[0].id, dups: fs.slice(1) };
      });
  }
  function meta(tok, id) {
    return api("https://www.googleapis.com/drive/v3/files/" + id + "?fields=id,modifiedTime", tok)
      .then(function (r) { return r.json(); });
  }
  function metaFull(tok, id) {
    return api("https://www.googleapis.com/drive/v3/files/" + id + "?fields=id,createdTime,modifiedTime,trashed", tok)
      .then(function (r) { return r.json(); });
  }
  /** 中身を正のファイルへ寄せ終えた重複ファイルをゴミ箱へ（完全には消さない。30日は戻せる） */
  function trashFile(tok, id) {
    return api("https://www.googleapis.com/drive/v3/files/" + id + "?fields=id", tok,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
  }
  function download(tok, id) {
    return api("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media", tok)
      .then(function (r) { return r.text(); });
  }
  function upload(tok, id, content) {
    if (id) {
      return api("https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media&fields=id,modifiedTime", tok,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: content })
        .then(function (r) { return r.json(); });
    }
    var boundary = "-------nk" + Date.now();
    var body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
      + JSON.stringify({ name: FILE_NAME, mimeType: "application/json" })
      + "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + content
      + "\r\n--" + boundary + "--";
    return api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime", tok,
      { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body: body })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.id) store.set(FILE_KEY, j.id); return j; });
  }

  /* ── 端末内の排他（全アプリ・全iframe・全タブで同期は1本ずつ）──────────
     同期ファイルは4アプリで1つ。同時に走ると、読んでから書くまでの間に別のアプリが書き、
     後から書いた方が先に書いた方の区画を古い内容で戻してしまう。戻された項目には
     もう「同期済み」の印が付いているので、次の同期で「他端末で削除された」と誤解されて消える。
     初回も、全アプリが同時に「ファイルが無い」と見て、1つずつ作ってしまう。
     navigator.locks は iframe や別タブをまたいで効く。無い古いブラウザでは、
     このページの中だけでも順番に流す。 */
  var LOCK_NAME = "nksync-file";
  var localChain = Promise.resolve();
  function withFileLock(fn) {
    var L = null;
    try { L = global.navigator && global.navigator.locks; } catch (e) { L = null; }
    if (L && typeof L.request === "function") {
      return L.request(LOCK_NAME, function () { return fn(); });
    }
    var p = localChain.then(fn, fn);
    localChain = p.then(function () {}, function () {});
    return p;
  }

  /** 「同期済み」の印を外した写し。複数の写し（重複ファイル）を1つにまとめるときに使う。
   *  印が付いたまま混ぜると、片方にしか無い項目が「削除された」扱いで落ちる */
  function unmarkSynced(v) {
    if (Array.isArray(v)) return v.map(unmarkSynced);
    if (v && typeof v === "object") {
      var o = {};
      for (var k in v) if (k !== "synced") o[k] = unmarkSynced(v[k]);
      return o;
    }
    return v;
  }

  function errMsg(e) {
    var m = String((e && e.message) || e);
    if (/REMOTE_CORRUPT/.test(m)) return "Googleドライブの同期ファイル（" + FILE_NAME + "）が読めないため、上書きせずに止めました。ドライブでこのファイルを確認してください。";
    if (/NOCID/.test(m)) return "先に「気になり帳」の同期設定（クライアントID）を済ませてください。";
    if (/401/.test(m)) return "Googleログインの期限が切れました。もう一度つないでください。";
    if (/403/.test(m)) return "Driveの権限が不足しています。設定を確認してください。";
    if (/読み込みが未完了|キャンセル|タイムアウト/.test(m)) return "自動でつなげませんでした。同期ボタンから手動でお試しください。";
    if (/Failed to fetch|NetworkError/i.test(m)) return "ネットワークに接続できませんでした。";
    return "同期に失敗しました: " + m.slice(0, 80);
  }

  /* ── アプリごとのインスタンス ──────────────────────────── */
  /** マージ結果に「同期済み」の印を付ける。次回以降、Driveから消えていたら
   *  それは他端末での削除だと判断できる。
   *
   *  ★これはDriveへ送る中身にだけ使う。ローカルに付けてよいのは
   *   アップロードが成功したあと（= 本当にDriveに載ったあと）だけ。
   *   送信前に付けると、送信が失敗したとき「同期済みなのにDriveに無い」＝
   *   他端末での削除、と誤判定して、まだ一度も送っていないデータを消す。 */
  function markSynced(v) {
    if (Array.isArray(v)) return v.map(markSynced);
    if (v && typeof v === "object") {
      var o = {}, isItem = false;
      for (var k in v) { o[k] = markSynced(v[k]); if (k === "id") isItem = true; }
      if (isItem) o.synced = 1;
      return o;
    }
    return v;
  }

  /** id の集合。プロトタイプ無しにしておく。ふつうのオブジェクトだと
   *  id が "constructor" や "toString" のとき、送っていないのに
   *  「載っている」と判定されてしまう（音のジャンルidは利用者の入力）。 */
  function idSet() { return Object.create(null); }

  /** 送信できた中身に含まれる id を集める。
   *  ★必ずアップロードを始める前に呼ぶこと。各アプリの getLocal() は
   *   内部配列をそのまま返すことがあり、通信の往復中に項目が追加されると、
   *   送っていないものまで拾ってしまう。 */
  function collectIds(v, out) {
    out = out || idSet();
    if (Array.isArray(v)) { v.forEach(function (x) { collectIds(x, out); }); return out; }
    if (v && typeof v === "object") {
      if (typeof v.id === "string" || typeof v.id === "number") out[v.id] = 1;
      for (var k in v) collectIds(v[k], out);
    }
    return out;
  }

  /** ids に載っている項目にだけ印を付ける。
   *  アップロード中に増えた項目には付けない（Driveに載っていないため）。 */
  function markUploaded(v, ids) {
    if (Array.isArray(v)) return v.map(function (x) { return markUploaded(x, ids); });
    if (v && typeof v === "object") {
      var o = {}, isItem = false;
      for (var k in v) {
        o[k] = markUploaded(v[k], ids);
        if (k === "id" && ids[v[k]] === 1) isItem = true;
      }
      if (isItem) o.synced = 1;
      return o;
    }
    return v;
  }

  function create(cfg) {
    // cfg: {app, label, getLocal, setLocal, merge, syncKey}
    var SYNC_KEY = "shared:nksync:sync:" + cfg.app;   // 最終同期時刻(ISO)
    var AUTO_KEY = "shared:nksync:auto";              // 自動同期のON/OFF（共通）
    var lazyT = null, urgT = null, busy = false, again = false;
    var status = { phase: "idle", msg: "", at: 0 };
    var listeners = [];

    function lastSyncISO() { return store.get(SYNC_KEY) || ""; }
    function setLastSync(iso) { if (iso) store.set(SYNC_KEY, iso); }
    function lastSyncMs() { var s = lastSyncISO(); return s ? new Date(s).getTime() : 0; }
    function autoOn() { return store.get(AUTO_KEY) !== "0"; }
    function setAuto(v) { store.set(AUTO_KEY, v ? "1" : "0"); emit(); }

    function emit() { listeners.forEach(function (f) { try { f(status, autoOn()); } catch (e) {} }); }
    function setStatus(p, m) { status = { phase: p, msg: m || "", at: Date.now() }; emit(); }

    function readRemote(tok, id) {
      return download(tok, id).then(function (txt) {
        var o = null;
        try { o = JSON.parse(txt); } catch (e) { o = null; }
        // 読めないファイルを空とみなして「このアプリの区画だけ」を書き戻すと、
        // ほかのアプリの区画がまるごと消える。壊れているときは書かずに止める
        if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("REMOTE_CORRUPT");
        if (o.apps == null) o.apps = {};
        else if (typeof o.apps !== "object" || Array.isArray(o.apps)) throw new Error("REMOTE_CORRUPT");
        return o;
      });
    }
    function blankDoc() { return { app: "nikki-sync", v: 1, apps: {} }; }

    // 重複ファイルは、最後に書かれてからこれだけ経ったらゴミ箱へ移す。
    // すぐには捨てない: 更新前の版を開いたままの端末が、まだそちらへ書いているかもしれない
    // （捨てると、その端末の「同期済み」の項目が正のファイルに無く、削除と誤解される）
    var DUP_STALE_MS = 7 * 24 * 3600 * 1000;
    function isStale(f) {
      var t = Date.parse((f && f.modifiedTime) || "");
      return isFinite(t) && Date.now() - t > DUP_STALE_MS;
    }
    /** 重複ファイルを全部読む。1つでも読めなければ同期を止める
     *  （読めないまま正のファイルとだけ混ぜると、そちらにしか無い「同期済み」の項目を消してしまう） */
    function readDups(tok, dups) {
      var out = [];
      return dups.reduce(function (p, f) {
        return p.then(function () {
          return readRemote(tok, f.id).then(function (d) { out.push({ f: f, doc: d }); });
        });
      }, Promise.resolve()).then(function () { return out; });
    }
    /** 正のファイル(doc)に重複ファイルの中身を寄せる。doc を書き換える。
     *  このアプリの区画は、全部の写しを1つに混ぜて remote として返す。
     *  ほかのアプリの区画は、正のファイルに無ければ移す。両方にあるものは、そのアプリが
     *  自分で同期したときに重複ファイルから混ぜる（混ぜ方はそのアプリにしか分からない）。
     *  ただし今回ゴミ箱へ移す重複ファイルの分は、捨てる前に pending に預けておく。 */
    function assemble(doc, dupDocs) {
      var mine = [];
      if (doc.apps[cfg.app]) mine.push(doc.apps[cfg.app]);
      var pend = (doc.pending && typeof doc.pending === "object" && !Array.isArray(doc.pending)) ? doc.pending : {};
      var own = pend[cfg.app];
      if (own && typeof own === "object") {
        Object.keys(own).forEach(function (k) { if (own[k]) mine.push(own[k]); });
      }
      delete pend[cfg.app];
      dupDocs.forEach(function (d) {
        var stale = isStale(d.f);
        var put = function (a, key, sec) {
          if (!sec) return;
          if (a === cfg.app) { mine.push(sec); return; }
          if (!doc.apps[a]) { doc.apps[a] = sec; return; }
          if (stale) (pend[a] = pend[a] || {})[key] = sec;
        };
        var apps = d.doc.apps || {};
        Object.keys(apps).forEach(function (a) { put(a, d.f.id, apps[a]); });
        // 重複ファイルに預けられていた分も引き継ぐ
        var dp = (d.doc.pending && typeof d.doc.pending === "object") ? d.doc.pending : {};
        Object.keys(dp).forEach(function (a) {
          var m = dp[a]; if (!m || typeof m !== "object") return;
          Object.keys(m).forEach(function (k) { put(a, d.f.id + "/" + k, m[k]); });
        });
      });
      if (Object.keys(pend).length) doc.pending = pend; else delete doc.pending;
      // 複数の写しを1つに。片方にしか無い項目も残すよう、印を外してから混ぜる（和集合）
      var remote = null;
      mine.forEach(function (sec) { remote = remote ? cfg.merge(unmarkSynced(remote), sec, 0) : sec; });
      return remote;
    }

    /** アップロード成功後に呼ぶ。ids（送信前に確定させたもの）に載っている
     *  項目にだけ印を付けて保存し直す。そのときの最新のローカルを読み直すので、
     *  送信中に追加された項目を古いスナップショットで上書きすることもない。
     *  付ける印が1つも無いときは何もしない（各アプリの setLocal は再描画まで
     *  伴うため、毎回の同期で無駄に画面を作り直さない）。 */
    function commitSynced(ids) {
      try {
        var cur = cfg.getLocal();
        var next = markUploaded(cur, ids);
        if (JSON.stringify(next) === JSON.stringify(cur)) return;
        cfg.setLocal(next);
      } catch (e) {}
    }

    /** 実際の同期。pull → merge → 必要なら push を1往復でやる。
     *  ファイルの読み書きは withFileLock の中で行う（全アプリで1本ずつ）。 */
    function syncLocked(tok) {
      return findFiles(tok).then(function (ff) {
        var id = ff.id;
        if (!id) {
          // まだ無い → いまのローカルをそのまま作る
          var snap = cfg.getLocal();
          var doc = blankDoc();
          doc.apps[cfg.app] = markSynced(snap);
          var ids0 = collectIds(snap);   // 送る前に確定させる
          return upload(tok, null, JSON.stringify(doc)).then(function (m2) {
            commitSynced(ids0);   // 載ってから印を付ける
            setLastSync(m2.modifiedTime || new Date().toISOString());
          });
        }
        return readDups(tok, ff.dups).then(function (dupDocs) {
          return meta(tok, id).then(function (m1) {
            return readRemote(tok, id).then(function (doc) {
              var before = doc.apps[cfg.app] || null;
              var shape0 = JSON.stringify({ a: doc.apps, p: doc.pending });
              var remote = assemble(doc, dupDocs);
              // 重複ファイルから移した・預けた・預かり分を引き取った → 書き戻しが要る
              var moved = JSON.stringify({ a: doc.apps, p: doc.pending }) !== shape0;
              // マージ結果はまだ印を付けない。付けるのは送信できたあと。
              // ローカルへ先に反映してから読み直すのは、各アプリの setLocal が
              // normalize で整形するため。整形後を送れば、Driveの中身と
              // この端末の中身が食い違わない。
              cfg.setLocal(cfg.merge(cfg.getLocal(), remote, lastSyncMs()));
              var snap = cfg.getLocal();
              var payload = markSynced(snap);
              var ids = collectIds(snap);   // 送る前に確定させる
              var changed = moved || !before || JSON.stringify(payload) !== JSON.stringify(before);
              // 中身が同じなら、それは全部Driveに載っているということなので印だけ付ける
              if (!changed) { commitSynced(ids); setLastSync(m1.modifiedTime); return; }
              // 書く直前にもう一度確認（compare-and-swap。ほかの端末とは排他できないため）
              return meta(tok, id).then(function (m2) {
                if (m2.modifiedTime !== m1.modifiedTime) {
                  // 間に他端末が書いた → 読み直してマージし直す
                  return readRemote(tok, id).then(function (d2) {
                    var remote2 = assemble(d2, dupDocs);
                    cfg.setLocal(cfg.merge(cfg.getLocal(), remote2, lastSyncMs()));
                    var snap2 = cfg.getLocal();
                    var ids2 = collectIds(snap2);
                    d2.apps[cfg.app] = markSynced(snap2);
                    return upload(tok, id, JSON.stringify(d2)).then(function (m3) {
                      commitSynced(ids2);
                      setLastSync(m3.modifiedTime || new Date().toISOString());
                    });
                  });
                }
                doc.apps[cfg.app] = payload;
                return upload(tok, id, JSON.stringify(doc)).then(function (m3) {
                  commitSynced(ids);
                  setLastSync(m3.modifiedTime || new Date().toISOString());
                });
              });
            });
          }).then(function () {
            // 中身を正のファイルに寄せ終えた古い重複ファイルを片付ける（失敗しても次回またやる）
            return dupDocs.filter(function (d) { return isStale(d.f); }).reduce(function (p, d) {
              return p.then(function () { return trashFile(tok, d.f.id).catch(function () {}); });
            }, Promise.resolve());
          });
        });
      });
    }
    function run(interactive) {
      if (busy) { again = true; return Promise.resolve(); }   // 走行中の変更は、終わってからもう一度送る
      // まだ一度もつないでいない（トークンも同期の記録も無い）なら、自動では何もしない。
      // ログイン画面を出せないまま「失敗」になり、☁に赤い印が出続けてしまう
      if (!interactive && !cachedToken() && !lastSyncISO()) { setStatus("off"); return Promise.resolve(); }
      busy = true;
      setStatus("syncing");
      // 認証（ログイン画面を待つことがある）は排他の外で済ませ、ほかのアプリを待たせない
      return getToken(!!interactive)
        .then(function (tok) { return withFileLock(function () { return syncLocked(tok); }); })
        .then(function () { busy = false; setStatus("ok"); rerun(); })
        .catch(function (e) { busy = false; setStatus("error", errMsg(e)); rerun(); throw e; });
    }
    function rerun() { if (again) { again = false; schedule(true); } }

    function schedule(urgent) {
      if (!autoOn()) return;
      if (!clientId()) return;                 // 未設定なら何もしない（静かに）
      if (urgent) {
        if (urgT) clearTimeout(urgT);
        urgT = setTimeout(function () { urgT = null; run(false).catch(function () {}); }, URGENT_MS);
      } else {
        if (lazyT || urgT) return;             // 既に予約済みなら重ねない
        lazyT = setTimeout(function () { lazyT = null; run(false).catch(function () {}); }, LAZY_MS);
      }
    }

    // タブを離れる/閉じるときに、溜まった統計を吐き出す
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden" && lazyT) {
        clearTimeout(lazyT); lazyT = null;
        run(false).catch(function () {});
      }
    });

    return {
      devId: devId,
      status: function () { return status; },
      autoOn: autoOn,
      setAuto: setAuto,
      hasClientId: function () { return !!clientId(); },
      onChange: function (f) { listeners.push(f); try { f(status, autoOn()); } catch (e) {} },
      /** 変更を通知する。urgent=true は3秒後、false は2分後にまとめて送る */
      touch: function (urgent) { schedule(!!urgent); },
      /** 手動同期（ボタン用）。初回はここでログイン画面が出る */
      syncNow: function () { return run(true); },
      /** 起動時の取り込み */
      start: function () {
        if (!autoOn() || !clientId()) { setStatus("idle"); return Promise.resolve(); }
        return run(false).catch(function () {});
      }
    };
  }

  /* ── シェル(index.html)との橋渡し ──────────────────────────
     iframe の中で開かれているときは、自前の同期UIを隠して
     シェルの☁パネルに状態を送り、命令を受け取る。
     単体で開いたときは従来どおり自分のUIで動く。 */
  function embedded() {
    try { return window.top !== window.self; } catch (e) { return true; }
  }
  function bridge(cfg) {
    // cfg: {app, label, hideSel[], syncNow(), getStatus()}
    if (!embedded()) return false;
    try { document.documentElement.classList.add("nk-embed"); } catch (e) {}
    (cfg.hideSel || []).forEach(function (sel) {
      try {
        var els = document.querySelectorAll(sel);
        for (var i = 0; i < els.length; i++) els[i].style.display = "none";
      } catch (e) {}
    });
    function report() {
      var st = {};
      try { st = cfg.getStatus() || {}; } catch (e) {}
      try { parent.postMessage({ nkSyncStatus: { app: cfg.app, label: cfg.label, phase: st.phase || "idle", at: st.at || 0, msg: st.msg || "" } }, location.origin); } catch (e) {}
    }
    window.addEventListener("message", function (e) {
      // 命令を受け付けるのはシェル（同一オリジン）からだけにする
      if (e.origin !== location.origin) return;
      var d = e.data;
      if (!d || !d.nkSync) return;
      if (d.nkSync === "status") { report(); return; }
      if (d.nkSync === "now") {
        Promise.resolve().then(function () { return cfg.syncNow && cfg.syncNow(); })
          .then(report).catch(report);
        return;
      }
      if (d.nkSync === "cid") { store.del(TOKEN_KEY); store.del(FILE_KEY); report(); return; }
    });
    setTimeout(report, 300);
    return { report: report };
  }

  global.NKSync = {
    create: create,
    bridge: bridge,
    embedded: embedded,
    clientId: clientId,
    setClientId: setClientId,
    mergeById: mergeById,
    mergeTombs: mergeTombs,
    itemTime: itemTime,
    markSynced: markSynced,
    devId: devId,
    hasClientId: function () { return !!clientId(); }
  };
})(window);
