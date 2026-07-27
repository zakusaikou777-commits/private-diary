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
  var CID_KEY   = "kininari:gd:cid";   // 気になり帳で設定済みのものを借りる
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

  function clientId() { return (store.get(CID_KEY) || "").trim(); }

  /* ── 汎用マージ部品（各アプリから使う）───────────────────── */
  function itemTime(o) { return (o && (o.updatedAt || o.createdAt)) || 0; }

  /** id ごとに updatedAt の新しい方を採用し、墓標で削除を反映する。
   *  pick(local, remote) を渡すと、勝った側をベースに個別調整できる
   *  （再生回数の合算など）。 */
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
        // ローカルにしか無い = 最終同期より後に作られた/直されたものだけ残す
        if (itemTime(o) > lastSync) put(o);
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
  function api(url, tok, opt) {
    opt = opt || {};
    opt.headers = opt.headers || {};
    opt.headers.Authorization = "Bearer " + tok;
    return fetch(url, opt).then(function (r) {
      if (r.status === 401) { store.del(TOKEN_KEY); throw new Error("401 認証の期限切れ"); }
      if (!r.ok) throw new Error(r.status + " Driveへの通信に失敗");
      return r;
    });
  }
  function findFile(tok) {
    var cached = store.get(FILE_KEY);
    if (cached) return Promise.resolve(cached);
    var q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    return api("https://www.googleapis.com/drive/v3/files?q=" + q + "&fields=files(id,modifiedTime)&pageSize=10", tok)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var f = (j.files || [])[0];
        if (f) { store.set(FILE_KEY, f.id); return f.id; }
        return null;
      });
  }
  function meta(tok, id) {
    return api("https://www.googleapis.com/drive/v3/files/" + id + "?fields=id,modifiedTime", tok)
      .then(function (r) { return r.json(); });
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

  function errMsg(e) {
    var m = String((e && e.message) || e);
    if (/NOCID/.test(m)) return "先に「気になり帳」の同期設定（クライアントID）を済ませてください。";
    if (/401/.test(m)) return "Googleログインの期限が切れました。もう一度つないでください。";
    if (/403/.test(m)) return "Driveの権限が不足しています。設定を確認してください。";
    if (/読み込みが未完了|キャンセル|タイムアウト/.test(m)) return "自動でつなげませんでした。同期ボタンから手動でお試しください。";
    if (/Failed to fetch|NetworkError/i.test(m)) return "ネットワークに接続できませんでした。";
    return "同期に失敗しました: " + m.slice(0, 80);
  }

  /* ── アプリごとのインスタンス ──────────────────────────── */
  function create(cfg) {
    // cfg: {app, label, getLocal, setLocal, merge, syncKey}
    var SYNC_KEY = "shared:nksync:sync:" + cfg.app;   // 最終同期時刻(ISO)
    var AUTO_KEY = "shared:nksync:auto";              // 自動同期のON/OFF（共通）
    var lazyT = null, urgT = null, busy = false;
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
        var o = {};
        try { o = JSON.parse(txt) || {}; } catch (e) { o = {}; }
        if (!o.apps) o.apps = {};
        return o;
      });
    }
    function blankDoc() { return { app: "nikki-sync", v: 1, apps: {} }; }

    /** 実際の同期。pull → merge → 必要なら push を1往復でやる */
    function run(interactive) {
      if (busy) return Promise.resolve();
      busy = true;
      setStatus("syncing");
      var tok;
      return getToken(!!interactive)
        .then(function (t) { tok = t; return findFile(tok); })
        .then(function (id) {
          if (!id) {
            // まだ無い → いまのローカルをそのまま作る
            var doc = blankDoc();
            doc.apps[cfg.app] = cfg.getLocal();
            return upload(tok, null, JSON.stringify(doc)).then(function (m2) {
              setLastSync(m2.modifiedTime || new Date().toISOString());
            });
          }
          return meta(tok, id).then(function (m1) {
            return readRemote(tok, id).then(function (doc) {
              var remote = doc.apps[cfg.app] || null;
              var merged = cfg.merge(cfg.getLocal(), remote, lastSyncMs());
              var changed = !remote || JSON.stringify(merged) !== JSON.stringify(remote);
              // マージ結果をローカルへ（他アプリの区画には触らない）
              cfg.setLocal(merged);
              if (!changed) { setLastSync(m1.modifiedTime); return; }
              // 書く直前にもう一度確認（compare-and-swap）
              return meta(tok, id).then(function (m2) {
                if (m2.modifiedTime !== m1.modifiedTime) {
                  // 間に他端末が書いた → 読み直してマージし直す
                  return readRemote(tok, id).then(function (d2) {
                    var again = cfg.merge(cfg.getLocal(), d2.apps[cfg.app] || null, lastSyncMs());
                    cfg.setLocal(again);
                    d2.apps[cfg.app] = again;
                    return upload(tok, id, JSON.stringify(d2)).then(function (m3) {
                      setLastSync(m3.modifiedTime || new Date().toISOString());
                    });
                  });
                }
                doc.apps[cfg.app] = merged;
                return upload(tok, id, JSON.stringify(doc)).then(function (m3) {
                  setLastSync(m3.modifiedTime || new Date().toISOString());
                });
              });
            });
          });
        })
        .then(function () { busy = false; setStatus("ok"); })
        .catch(function (e) { busy = false; setStatus("error", errMsg(e)); throw e; });
    }

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

  global.NKSync = {
    create: create,
    mergeById: mergeById,
    mergeTombs: mergeTombs,
    itemTime: itemTime,
    devId: devId,
    hasClientId: function () { return !!clientId(); }
  };
})(window);
