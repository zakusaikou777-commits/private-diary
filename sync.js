/* ============================================================
   NKSync — 「音」「暗室」「タスク」「くつろぎ」で共用する Google Drive 同期エンジン
            と、全アプリ共通の Google 認証・Drive 通信の土台（NKSync.drive）

   設計メモ:
   - 認証は全アプリ共通の shared:gd:token。許可された権限（scope）も一緒に覚え、
     足りないトークンは使わない（NKSync.drive.getToken）。
     クライアントIDも共通の shared:gd:cid を読み、設定を増やさない。
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
    // プロトタイプ無しにしておく。ふつうの {} だと id が "constructor" などのとき
    // 「もう入っている」と判定され、その項目が同期のたびに消えていた（音のジャンルidは利用者の入力）
    var tombAt = Object.create(null);
    (tombs || []).forEach(function (t) {
      if (t && t.id) tombAt[t.id] = Math.max(tombAt[t.id] || 0, t.at || 0);
    });
    var order = [], map = Object.create(null);
    function put(o) { var k = o[key]; if (!(k in map)) order.push(k); map[k] = o; }
    (remoteList || []).forEach(put);
    (localList || []).forEach(function (o) {
      var k = o[key], r = map[k];
      if (r === undefined) {
        // ローカルにしか無い場合:
        //  - まだ一度も同期していない(synced無し) → 新規なので必ず残す
        //  - 同期済みなのにDriveから消えている → 他端末で削除された → 消す
        //    ただし、その削除（墓標）より後にこの端末で編集していたら残す（編集が削除に勝つ。
        //    下の墓標の扱いと同じ決まり。以前はここだけ墓標を見ずに消していた）
        var tk = tombAt[k];
        if (!o.synced || (tk && itemTime(o) > tk)) put(o);
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
    var TTL = 90 * 24 * 3600 * 1000, cut = Date.now() - TTL, m = Object.create(null);
    [].concat(a || [], b || []).forEach(function (t) {
      if (!t || !t.id) return;
      var at = t.at || 0;
      if (!(t.id in m) || m[t.id] < at) m[t.id] = at;
    });
    var out = [];
    for (var id in m) if (m[id] > cut) out.push({ id: id, at: m[id] });
    return out;
  }

  /* ── Google 認証と Drive の土台（全アプリ共通: NKSync.drive）─────────────
     気になり帳・日記帳・タスク・音・暗室・くつろぎ・入口が、同じトークンと同じ
     通信の作法を使う。アプリごとに書いていたころは、
       - 権限（スコープ）の違うトークンで shared:gd:token を上書きし合い、日記帳が
         「drive.file だけ」のトークンを拾って appDataFolder で 403 になる
       - 返事の本文を待つ間はタイムアウトが効かず、同期の排他を握ったまま止まる
     といった食い違いが起きていた。 */
  var SC = {
    file: "https://www.googleapis.com/auth/drive.file",
    appdata: "https://www.googleapis.com/auth/drive.appdata",
    calendar: "https://www.googleapis.com/auth/calendar.events",
    tasks: "https://www.googleapis.com/auth/tasks"
  };
  // ふだん頼む権限のひとまとまり。どのアプリが取ったトークンでも、ほかのアプリの
  // 同期にそのまま使えるように、全員がこれを含めて頼む（タスクだけは tasks を足す）
  var STD_SCOPE = [SC.file, SC.appdata, SC.calendar].join(" ");

  function scopeList(s) { return String(s || "").split(/\s+/).filter(Boolean); }
  function scopeUnion(a, b) {
    var out = scopeList(a);
    scopeList(b).forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
    return out.join(" ");
  }
  function scopeCovers(have, need) {
    var h = scopeList(have);
    return scopeList(need).every(function (x) { return h.indexOf(x) >= 0; });
  }

  /** 保存してあるトークンのうち、need（空白区切りの権限）を満たすものを返す。
   *  旧版が保存したもの（scope の記録が無い）は中身が分からないので、そのまま使う。
   *  権限が足りなければ 403 が来て、api() がそれを捨てる */
  function tokenRead(need) {
    try {
      var o = JSON.parse(store.get(TOKEN_KEY) || "null");
      if (!o || !o.token || !o.exp || Date.now() >= o.exp - 60000) return null;
      if (o.scope && need && !scopeCovers(o.scope, need)) return null;
      return o.token;
    } catch (e) { return null; }
  }
  function tokenSave(tok, sec, scope) {
    try { store.set(TOKEN_KEY, JSON.stringify({ token: tok, exp: Date.now() + (sec || 3600) * 1000, scope: scope || "" })); } catch (e) {}
  }
  /** tok を渡したときは、保存しているのがそのトークンのときだけ消す
   *  （別のアプリが取り直したばかりの新しいトークンまで消さない） */
  function tokenClear(tok) {
    if (tok) {
      try { var o = JSON.parse(store.get(TOKEN_KEY) || "null"); if (o && o.token && o.token !== tok) return; } catch (e) {}
    }
    store.del(TOKEN_KEY);
  }
  function gisReady() { return !!(global.google && google.accounts && google.accounts.oauth2); }
  function waitGis(ms) {
    return new Promise(function (res) {
      var t0 = Date.now();
      (function tick() {
        if (gisReady()) { res(true); return; }
        if (Date.now() - t0 > ms) { res(false); return; }
        setTimeout(tick, 100);
      })();
    });
  }

  var tokenWait = null;   // このページで取りに行っている最中のもの（ポップアップを重ねて出さない）
  /** トークンを得る。opt:
   *    scope       要る権限（省略時 STD_SCOPE）。頼むときは STD_SCOPE と合わせて頼む
   *    interactive 利用者の操作から呼ぶとき true
   *    prompt      "consent" などを明示したいとき（省略時 ""）
   *  ★ログイン画面（ポップアップ）を出せるのは、クリックの処理の中で同期的に
   *   requestAccessToken を呼んだときだけ。interactive のときは、呼ぶ前に await を挟まないこと。
   *   1回のクリックで開けるポップアップは1つだけなので、全アプリをまとめて同期するときは
   *   入口（index.html）が先にここで1回だけ取り、各アプリは保存されたものを使う。 */
  function getToken(opt) {
    opt = opt || {};
    var need = opt.scope || STD_SCOPE;
    var c = tokenRead(need);
    if (c) return Promise.resolve(c);
    if (tokenWait && scopeCovers(tokenWait.scope, need)) return tokenWait.p;
    var cid = clientId();
    if (!cid) return Promise.reject(new Error("NOCID"));
    if (!gisReady()) {
      // ログイン部品は async で読み込むので、まだのことがある。自動の同期なら少し待つ。
      // 利用者の操作からのときは、待つとポップアップが止められるのですぐに断る
      if (opt.interactive) return Promise.reject(new Error("Googleの読み込みが未完了です"));
      return waitGis(5000).then(function (ok) {
        if (!ok) throw new Error("Googleの読み込みが未完了です");
        return getToken(opt);
      });
    }
    var want = scopeUnion(STD_SCOPE, need);
    var p = new Promise(function (res, rej) {
      var to = setTimeout(function () { rej(new Error("認証がタイムアウトしました")); }, 90000);
      try {
        var tc = google.accounts.oauth2.initTokenClient({
          client_id: cid, scope: want,
          callback: function (r) {
            clearTimeout(to);
            if (!(r && r.access_token)) { rej(new Error("認証に失敗しました")); return; }
            // 実際に許可された権限を覚える（同意画面で一部を外されることがある）
            var granted = r.scope || want;
            tokenSave(r.access_token, r.expires_in, granted);
            if (!scopeCovers(granted, need)) { rej(new Error("403 必要な権限が許可されませんでした")); return; }
            res(r.access_token);
          },
          error_callback: function (e) {
            clearTimeout(to);
            var t = (e && e.type) || "";
            rej(new Error(t === "popup_failed_to_open" ? "ログイン画面を開けませんでした（ポップアップが止められました）" : "認証がキャンセルされました"));
          }
        });
        tc.requestAccessToken({ prompt: opt.prompt != null ? opt.prompt : "" });
      } catch (e) { clearTimeout(to); rej(e); }
    });
    var w = { scope: want, p: p };
    tokenWait = w;
    var clear = function () { if (tokenWait === w) tokenWait = null; };
    p.then(clear, clear);
    return p;
  }

  /* ── Drive ──────────────────────────────────────────────── */
  // 1回の通信の上限。同期は全アプリで1本ずつ（下の withLock）なので、
  // 返事の来ない通信を待ち続けると、ほかのアプリの同期まで永久に止まる
  var API_TIMEOUT_MS = 60000;
  var DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
  var UPLOAD_FILES = "https://www.googleapis.com/upload/drive/v3/files";

  function httpError(status, body, tok) {
    var reason = "";
    try {
      var er = (JSON.parse(body) || {}).error || {};
      reason = (er.errors && er.errors[0] && er.errors[0].reason) || er.status || "";
    } catch (e) {}
    var e = new Error(status + " " + (status === 401 ? "認証の期限切れ" : "Driveへの通信に失敗") + (reason ? "（" + reason + "）" : ""));
    e.status = status;
    e.reason = reason;
    // 期限切れ・権限不足のトークンは捨てて、次は取り直す（混雑による 403 は捨てない）
    if (status === 401 || (status === 403 && !/rateLimit/i.test(reason))) tokenClear(tok);
    return e;
  }
  function retryable(e) {
    var s = e && e.status;
    return s === 429 || s >= 500 || (s === 403 && /rateLimit/i.test(e.reason || ""));
  }

  /** Google の API を呼ぶ。返事の本文まで読み終えてから返す。
   *  opt: {method, headers, body, as: "json"(既定)|"text"|"blob"|"none", timeout}
   *  ★タイムアウトは本文を読み終えるまで効かせる。以前はヘッダが届いた時点で外していたため、
   *   回線が途中で止まると本文を永久に待ち、同期の排他を握ったまま全アプリの同期が止まった。
   *  失敗は Error（.status 付き）。混雑（429/5xx）は、読むだけの通信と PATCH に限り
   *  少し待って2回までやり直す（POST は二重に作ってしまうのでやり直さない）。 */
  function api(url, tok, opt) {
    opt = opt || {};
    var as = opt.as || "json";
    var method = (opt.method || "GET").toUpperCase();
    var left = (method === "GET" || method === "PATCH") ? 2 : 0;
    function once() {
      var init = { method: method, headers: {} };
      if (opt.body !== undefined) init.body = opt.body;
      var h = opt.headers || {};
      for (var k in h) init.headers[k] = h[k];
      init.headers.Authorization = "Bearer " + tok;
      var ctl = null, timer = null;
      try { if (typeof AbortController === "function") { ctl = new AbortController(); init.signal = ctl.signal; } } catch (e) {}
      var limit = new Promise(function (_, rej) {
        timer = setTimeout(function () {
          try { if (ctl) ctl.abort(); } catch (e) {}
          rej(new Error("通信がタイムアウトしました"));
        }, opt.timeout || API_TIMEOUT_MS);
      });
      var work = fetch(url, init).then(function (r) {
        if (!r.ok) {
          return r.text().then(null, function () { return ""; }).then(function (t) { throw httpError(r.status, t, tok); });
        }
        if (as === "text") return r.text();
        if (as === "blob") return r.blob();
        return r.text().then(function (t) {
          if (as === "none" || !t) return null;
          return JSON.parse(t);
        });
      });
      return Promise.race([work, limit]).then(
        function (v) { clearTimeout(timer); return v; },
        function (e) { clearTimeout(timer); throw e; });
    }
    function attempt() {
      return once().then(null, function (e) {
        if (left > 0 && retryable(e)) {
          var wait = left === 2 ? 1000 : 3000;
          left--;
          return new Promise(function (r) { setTimeout(r, wait); }).then(attempt);
        }
        throw e;
      });
    }
    return attempt();
  }

  function qStr(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
  function spaceOf(space) { return space === "appDataFolder" ? "appDataFolder" : "drive"; }

  /** 検索。ページ送りも全部たどる。o: {q, space, fields, orderBy} */
  function list(tok, o) {
    var out = [];
    var fields = "nextPageToken,files(" + (o.fields || "id,name,createdTime,modifiedTime") + ")";
    function page(next) {
      var u = DRIVE_FILES + "?q=" + encodeURIComponent(o.q) + "&spaces=" + spaceOf(o.space)
        + "&fields=" + encodeURIComponent(fields) + "&pageSize=" + (o.pageSize || 1000)
        + (o.orderBy ? "&orderBy=" + encodeURIComponent(o.orderBy) : "")
        + (next ? "&pageToken=" + encodeURIComponent(next) : "");
      return api(u, tok).then(function (j) {
        ((j && j.files) || []).forEach(function (f) { if (f && f.id) out.push(f); });
        if (j && j.nextPageToken && out.length < 50000) return page(j.nextPageToken);
        return out;
      });
    }
    return page(null);
  }
  function meta(tok, id, fields) {
    return api(DRIVE_FILES + "/" + encodeURIComponent(id) + "?fields=" + encodeURIComponent(fields || "id,modifiedTime,trashed"), tok);
  }
  function download(tok, id, as) {
    return api(DRIVE_FILES + "/" + encodeURIComponent(id) + "?alt=media", tok, { as: as || "text" });
  }
  /** 作るか、中身を置き換える。o: {id, name, space, content(文字列かBlob), mime, appProperties}
   *  返り値 {id, modifiedTime} */
  function upload(tok, o) {
    var mime = o.mime || "application/json";
    if (o.id) {
      return api(UPLOAD_FILES + "/" + encodeURIComponent(o.id) + "?uploadType=media&fields=id,modifiedTime", tok,
        { method: "PATCH", headers: { "Content-Type": mime }, body: o.content });
    }
    var boundary = "-------nk" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var md = { name: o.name, mimeType: mime };
    if (spaceOf(o.space) === "appDataFolder") md.parents = ["appDataFolder"];
    if (o.appProperties) md.appProperties = o.appProperties;
    var head = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(md)
      + "\r\n--" + boundary + "\r\nContent-Type: " + mime + "\r\n\r\n";
    var tail = "\r\n--" + boundary + "--";
    var body = typeof o.content === "string" ? head + o.content + tail : new Blob([head, o.content, tail]);
    return api(UPLOAD_FILES + "?uploadType=multipart&fields=id,modifiedTime", tok,
      { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body: body });
  }
  /** ゴミ箱へ（完全には消さない。30日は戻せる） */
  function trash(tok, id) {
    return api(DRIVE_FILES + "/" + encodeURIComponent(id) + "?fields=id", tok,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
  }
  function remove(tok, id) {
    return api(DRIVE_FILES + "/" + encodeURIComponent(id), tok, { method: "DELETE", as: "none" });
  }

  /** 同期ファイルを決める。o: {name, space, cacheKey}
   *  返り値: { id: 正のファイル（無ければ null）, dups: [ほかの同名ファイル], prev: 前回覚えていたid, switched }
   *  同名のファイルが複数あることがある（旧版で全アプリが同時に初回同期した・2台が同時に作った）。
   *  端末ごとに違うものを選ぶと、同期しているつもりで永久にすれ違ううえ、選び直したときに
   *  「同期済みなのに無い＝削除」と誤解して消す。どの端末でも「いちばん古いもの」を正とする。
   *  switched: 覚えていたファイルが無くなり（削除・ゴミ箱・別のアカウント）、別のファイルに
   *  乗り換えたとき true。呼び出し側は、ローカルの「同期済み」の印を外してから混ぜること
   *  （外さずに混ぜると、新しいファイルに無い項目を「他端末で削除された」と誤解して消す）。 */
  function findFiles(tok, o) {
    var cached = o.cacheKey ? store.get(o.cacheKey) : null;
    var q = "name='" + qStr(o.name) + "' and trashed=false";
    return list(tok, { q: q, space: o.space, orderBy: "createdTime", fields: "id,createdTime,modifiedTime" })
      .then(function (fs) {
        var seen = !cached || fs.some(function (f) { return f.id === cached; });
        if (seen) return fs;
        // 作った直後のファイルは一覧（検索）にすぐ出ないことがある。覚えているものは直接確かめる。
        // 確かめずに「無い」と決めると、もう1つ作ってしまう
        return meta(tok, cached, "id,createdTime,modifiedTime,trashed").then(function (m) {
          if (m && m.id && !m.trashed) fs.push(m);
          return fs;
        }, function () { return fs; });
      }, function (e) {
        // 一覧が取れないとき（通信の偽物など）は、覚えているファイルで続ける。
        // ただし認証・権限の失敗はそのまま返す（覚えているファイルにも届かない）
        if (cached && !(e && (e.status === 401 || e.status === 403))) return [{ id: cached }];
        throw e;
      })
      .then(function (fs) {
        fs.sort(function (a, b) {
          var x = String(a.createdTime || ""), y = String(b.createdTime || "");
          if (x !== y) return x < y ? -1 : 1;
          return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });
        if (!fs.length) return { id: null, dups: [], prev: cached, switched: false };
        var id = fs[0].id;
        var switched = !!cached && !fs.some(function (f) { return f.id === cached; });
        if (o.cacheKey) store.set(o.cacheKey, id);
        return { id: id, dups: fs.slice(1), prev: cached, switched: switched };
      });
  }

  /* ── 端末内の排他（全アプリ・全iframe・全タブで同期は1本ずつ）──────────
     同期ファイルは4アプリで1つ。同時に走ると、読んでから書くまでの間に別のアプリが書き、
     後から書いた方が先に書いた方の区画を古い内容で戻してしまう。戻された項目には
     もう「同期済み」の印が付いているので、次の同期で「他端末で削除された」と誤解されて消える。
     初回も、全アプリが同時に「ファイルが無い」と見て、1つずつ作ってしまう。
     navigator.locks は iframe や別タブをまたいで効く。無い古いブラウザでは、
     このページの中だけでも順番に流す。
     気になり帳・日記帳も、自分のファイル用の名前でこれを使う（同じアプリの別タブと重ならないように）。 */
  var localChains = Object.create(null);
  function withLock(name, fn) {
    var L = null;
    try { L = global.navigator && global.navigator.locks; } catch (e) { L = null; }
    if (L && typeof L.request === "function") {
      return L.request(name, function () { return fn(); });
    }
    var p = (localChains[name] || Promise.resolve()).then(fn, fn);
    localChains[name] = p.then(function () {}, function () {});
    return p;
  }
  var LOCK_NAME = "nksync-file";
  function withFileLock(fn) { return withLock(LOCK_NAME, fn); }

  /* ── 「音」「暗室」など（nikki-apps-data.json の区画）用の薄い包み ── */
  var SYNC_SCOPE = SC.file;
  function findSyncFile(tok) { return findFiles(tok, { name: FILE_NAME, space: "drive", cacheKey: FILE_KEY }); }
  function uploadSyncFile(tok, id, content) {
    return upload(tok, { id: id, name: FILE_NAME, space: "drive", content: content })
      .then(function (j) { if (!id && j && j.id) store.set(FILE_KEY, j.id); return j; });
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
    if (/通信がタイムアウト/.test(m)) return "通信がタイムアウトしました。電波の良いところでもう一度お試しください。";
    if (/読み込みが未完了|キャンセル|タイムアウト|ポップアップ/.test(m)) return "自動でつなげませんでした。同期ボタンから手動でお試しください。";
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
    var lazyT = null, urgT = null, busy = false, again = false, inflight = null;
    var status = { phase: "idle", msg: "", at: 0 };
    var listeners = [];

    // 最後に同期したファイルのid。これと違うファイルと混ぜるときは、
    // ローカルの「同期済み」の印を信用しない（syncLocked の foreign 参照）
    var SYNCFILE_KEY = "shared:nksync:syncfile:" + cfg.app;
    function lastSyncISO() { return store.get(SYNC_KEY) || ""; }
    function setLastSync(iso, fileId) {
      if (iso) store.set(SYNC_KEY, iso);
      if (fileId) store.set(SYNCFILE_KEY, fileId);
    }
    function lastSyncMs() { var s = lastSyncISO(); return s ? new Date(s).getTime() : 0; }
    function autoOn() { return store.get(AUTO_KEY) !== "0"; }
    function setAuto(v) { store.set(AUTO_KEY, v ? "1" : "0"); emit(); }

    function emit() { listeners.forEach(function (f) { try { f(status, autoOn()); } catch (e) {} }); }
    function setStatus(p, m) { status = { phase: p, msg: m || "", at: Date.now() }; emit(); }

    function readRemote(tok, id) {
      return download(tok, id, "text").then(function (txt) {
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
      return findSyncFile(tok).then(function (ff) {
        var id = ff.id;
        if (!id) {
          // まだ無い → いまのローカルをそのまま作る
          var snap = cfg.getLocal();
          var doc = blankDoc();
          doc.apps[cfg.app] = markSynced(snap);
          var ids0 = collectIds(snap);   // 送る前に確定させる
          return uploadSyncFile(tok, null, JSON.stringify(doc)).then(function (m2) {
            commitSynced(ids0);   // 載ってから印を付ける
            setLastSync(m2.modifiedTime || new Date().toISOString(), m2.id);
          });
        }
        // 前回と違うファイルと混ぜる（ファイルが消えた・別のGoogleアカウントでつないだ・
        // クライアントIDを変えた）ときは、ローカルの「同期済み」の印を外して混ぜる。
        // 印を信じると、新しいファイルに無い項目を「他端末で削除された」と誤解して消す。
        // 旧版で同期していた端末は SYNCFILE_KEY を持たないので、覚えていたファイル(prev)で代える
        var lastFile = store.get(SYNCFILE_KEY) || (lastSyncISO() ? ff.prev : null);
        var foreign = lastFile !== id;
        return readDups(tok, ff.dups).then(function (dupDocs) {
          return meta(tok, id, "id,modifiedTime").then(function (m1) {
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
              var local0 = foreign ? unmarkSynced(cfg.getLocal()) : cfg.getLocal();
              cfg.setLocal(cfg.merge(local0, remote, lastSyncMs()));
              var snap = cfg.getLocal();
              var payload = markSynced(snap);
              var ids = collectIds(snap);   // 送る前に確定させる
              var changed = moved || !before || JSON.stringify(payload) !== JSON.stringify(before);
              // 中身が同じなら、それは全部Driveに載っているということなので印だけ付ける
              if (!changed) { commitSynced(ids); setLastSync(m1.modifiedTime, id); return; }
              // 書く直前にもう一度確認（compare-and-swap。ほかの端末とは排他できないため）
              return meta(tok, id, "id,modifiedTime").then(function (m2) {
                if (m2.modifiedTime !== m1.modifiedTime) {
                  // 間に他端末が書いた → 読み直してマージし直す
                  return readRemote(tok, id).then(function (d2) {
                    var remote2 = assemble(d2, dupDocs);
                    cfg.setLocal(cfg.merge(cfg.getLocal(), remote2, lastSyncMs()));
                    var snap2 = cfg.getLocal();
                    var ids2 = collectIds(snap2);
                    d2.apps[cfg.app] = markSynced(snap2);
                    return uploadSyncFile(tok, id, JSON.stringify(d2)).then(function (m3) {
                      commitSynced(ids2);
                      setLastSync(m3.modifiedTime || new Date().toISOString(), id);
                    });
                  });
                }
                doc.apps[cfg.app] = payload;
                return uploadSyncFile(tok, id, JSON.stringify(doc)).then(function (m3) {
                  commitSynced(ids);
                  setLastSync(m3.modifiedTime || new Date().toISOString(), id);
                });
              });
            });
          }).then(function () {
            // 中身を正のファイルに寄せ終えた古い重複ファイルを片付ける（失敗しても次回またやる）
            return dupDocs.filter(function (d) { return isStale(d.f); }).reduce(function (p, d) {
              return p.then(function () { return trash(tok, d.f.id).catch(function () {}); });
            }, Promise.resolve());
          });
        });
      });
    }
    function run(interactive) {
      if (busy) { again = true; return Promise.resolve(); }   // 走行中の変更は、終わってからもう一度送る
      // まだ一度もつないでいない（トークンも同期の記録も無い）なら、自動では何もしない。
      // ログイン画面を出せないまま「失敗」になり、☁に赤い印が出続けてしまう
      if (!interactive && !tokenRead(SYNC_SCOPE) && !lastSyncISO()) { setStatus("off"); return Promise.resolve(); }
      busy = true;
      setStatus("syncing");
      // 認証（ログイン画面を待つことがある）は排他の外で済ませ、ほかのアプリを待たせない。
      // ★getToken はこの関数の中で同期的に呼ぶ（ボタンのクリックからポップアップを出せるように）
      var p = getToken({ scope: SYNC_SCOPE, interactive: !!interactive })
        .then(function (tok) { return withFileLock(function () { return syncLocked(tok); }); })
        .then(function () { busy = false; inflight = null; setStatus("ok"); rerun(); })
        .catch(function (e) { busy = false; inflight = null; setStatus("error", errMsg(e)); rerun(); throw e; });
      inflight = p;
      return p;
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
      /** ログイン画面を出さずに同期して、終わるまで待つ（タスクがGoogleタスクと
       *  やりとりする前に、Driveの最新を取り込んでおくためなど）。
       *  走行中ならそれが終わってからもう一度。まだつないでいなければ何もしない */
      syncQuiet: function () {
        if (!clientId()) return Promise.resolve();
        var noop = function () {};
        return (inflight || Promise.resolve()).then(noop, noop).then(function () { return run(false); });
      },
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
    /** Google 認証と Drive の土台。気になり帳・日記帳・タスク・入口からも使う */
    drive: {
      SCOPES: SC,
      STD_SCOPE: STD_SCOPE,
      scopeCovers: scopeCovers,
      getToken: getToken,
      tokenRead: tokenRead,
      tokenSave: tokenSave,
      tokenClear: tokenClear,
      api: api,
      list: list,
      meta: meta,
      download: download,
      upload: upload,
      trash: trash,
      remove: remove,
      findFiles: findFiles,
      withLock: withLock,
      unmarkSynced: unmarkSynced
    },
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
