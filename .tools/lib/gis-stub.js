/* 検証用: Google Identity Services（accounts.google.com/gsi/client）の偽物。
   requestAccessToken を呼ぶと、少し後に callback へトークンを返す。
   トークンは "fake." + base64(scope) なので、fake-drive.mjs がそこから権限を読む。

   ページ側（またはテスト側）から window.__fakeGis を書き換えると振る舞いを変えられる:
     mode: "ok"（既定） | "cancel"（キャンセル扱い） | "popupBlocked"（ポップアップを1つしか開けない本物の挙動を真似る）
     delay: 応答までのミリ秒（既定 10）
   呼ばれた記録は top の window.__fakeGisCalls に残る（iframe からの呼び出しも集まる）。 */
(function () {
  function topWin() { try { return window.top.document ? window.top : window; } catch (e) { return window; } }
  function cfgOf() { var t = topWin(); return t.__fakeGis || window.__fakeGis || {}; }
  function log(rec) { var t = topWin(); (t.__fakeGisCalls = t.__fakeGisCalls || []).push(rec); }
  window.google = window.google || {};
  window.google.accounts = window.google.accounts || {};
  window.google.accounts.oauth2 = {
    initTokenClient: function (cfg) {
      // 本物と同じく、作ったあとで client.callback / error_callback を差し替えても効くようにする
      var client = {
        callback: cfg.callback,
        error_callback: cfg.error_callback,
        requestAccessToken: function (o) {
          var c = cfgOf(), mode = c.mode || "ok", t = topWin();
          var hasAct = false;
          try { hasAct = !!(navigator.userActivation && navigator.userActivation.isActive); } catch (e) {}
          log({ scope: cfg.scope, prompt: o && o.prompt, frame: location.pathname, activation: hasAct, at: Date.now() });
          var fail = mode === "cancel";
          if (mode === "popupBlocked") {
            // 本物は1回のクリックで開けるポップアップが1つだけ。2つ目以降は popup_failed_to_open になる
            if (t.__fakeGisPopupUsed || !hasAct) fail = true;
            else t.__fakeGisPopupUsed = true;
          }
          setTimeout(function () {
            if (fail) { if (client.error_callback) client.error_callback({ type: "popup_failed_to_open" }); return; }
            client.callback({ access_token: "fake." + btoa(cfg.scope || ""), expires_in: 3599, scope: cfg.scope || "", token_type: "Bearer" });
          }, c.delay == null ? 10 : c.delay);
        }
      };
      return client;
    },
    revoke: function (tok, cb) { if (cb) setTimeout(cb, 0); },
    hasGrantedAllScopes: function (resp) {
      var have = String((resp && resp.scope) || "").split(/\s+/);
      for (var i = 1; i < arguments.length; i++) if (have.indexOf(arguments[i]) < 0) return false;
      return true;
    }
  };
  window.google.accounts.id = window.google.accounts.id || { initialize: function () {}, prompt: function () {}, renderButton: function () {} };
})();
