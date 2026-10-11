/* 入口（index.html）と service worker（sw.js）の修正の確認（配布には不要）
     node .tools/test-fix-shell.mjs            … いまの版
     node .tools/test-fix-shell.mjs <フォルダ> … 別のフォルダの版で（直す前の版で落ちるかの確認用）

   sw.js
   - 共有メニューで開いたURL（index.html?title=…&text=…）を Cache Storage に残さない
   - 新しい worker に入れ替わるとき、? 付きの古い項目を捨てる
   - キャッシュに無い就寝用の音は、206 を返したあとで丸ごと取ってキャッシュに入れる
   - 応答が4秒来ないときは、キャッシュにあるものを先に返す（無ければ待つ・裏で更新）
   - オフライン: 画面移動はキャッシュ（無ければ index.html）、それ以外の取りこぼしに index.html を返さない、
     iframe の中を index.html にしない、音の Range は 206
   index.html
   - 日記帳への命令（Markdownで書き出す・暗号化の設定）を、日記帳が名乗り出るまで待たせる
   - タスクの待ち行列を、ほかのタブの状態報告で（読み込み中のタスクタブへ）流さない
   - 取り込みの間はほかのウィンドウも止め、終わったら読み込み直させる */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startServer, launch, newDevice, makeChecker, sleep, waitFor, ROOT } from "./lib/harness.mjs";

const root = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;

/* 前に挟む中継。遅らせる・応答を書き足す・止める（オフライン扱い）・sw.js を変えて更新させる、を切り替える。
   context.setOffline は service worker の fetch には効かないので、ここで接続を切る。 */
function startProxy(target) {
  const ctl = { delay: {}, tail: {}, down: false, swTail: "" };
  const server = http.createServer((req, res) => {
    if (ctl.down) { req.socket.destroy(); return; }
    const p = new URL(req.url, "http://x").pathname.replace(/^\//, "");
    if (p === "sw.js" && ctl.swTail) {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(path.join(root, "sw.js"), "utf8") + "\n// " + ctl.swTail + "\n");
      return;
    }
    const go = () => {
      if (ctl.down) { req.socket.destroy(); return; }
      const up = http.request(new URL(req.url, target), { method: req.method, headers: req.headers }, (ur) => {
        const tail = ctl.tail[p];
        if (!tail || ur.statusCode !== 200) { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); return; }
        const bufs = [];
        ur.on("data", (b) => bufs.push(b));
        ur.on("end", () => {
          const body = Buffer.concat([...bufs, Buffer.from(tail)]);
          res.writeHead(200, { ...ur.headers, "content-length": body.length });
          res.end(body);
        });
      });
      up.on("error", () => res.destroy());
      req.pipe(up);
    };
    if (ctl.delay[p]) setTimeout(go, ctl.delay[p]); else go();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}/`, ctl,
      close: () => new Promise((r) => { try { server.closeAllConnections(); } catch (e) {} server.close(() => r()); }) });
  }));
}

const { ok, done } = makeChecker("test-fix-shell");
const srv = await startServer(root);
const px = await startProxy(srv.url);
const base = px.url;
const browser = await launch();
const SECRET = "himitsu-" + Date.now();
const frameOf = (page, file) => page.frames().find((f) => { try { return new URL(f.url()).pathname.endsWith("/" + file); } catch (e) { return false; } });
const tryWait = async (fn, opts) => { try { return await waitFor(fn, opts); } catch (e) { return null; } };

try {
  console.log("■ service worker");
  {
    const ctx = await newDevice(browser, { serviceWorkers: "allow" });
    const page = await ctx.newPage();
    await page.goto(base + "index.html");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const dump = () => page.evaluate(async () => {
      const out = [];
      for (const n of await caches.keys()) {
        const c = await caches.open(n);
        for (const r of await c.keys()) { const m = await c.match(r); out.push({ key: r.url, url: m ? m.url : "" }); }
      }
      return out;
    });
    ok((await dump()).some((e) => e.key === base + "icon-512-maskable.png"), "icon-512-maskable.png も事前キャッシュに入る");

    // 共有メニューから開いたURL
    await page.goto(base + "index.html?title=t&text=" + SECRET + "&url=");
    await page.waitForSelector("#tabbar");
    await sleep(1500);   // 裏のキャッシュ更新を待つ
    const leak = (await dump()).filter((e) => e.key.includes("?") || e.key.includes(SECRET) || e.url.includes(SECRET));
    ok(!leak.length, "共有で開いたURL（?title=…&text=…、気になり帳へ渡す #knadd=…）が Cache Storage に残らない（鍵にも応答のURLにも）", leak);

    // 旧版が残した ? 付きの項目は、入れ替わりのときに捨てる
    await page.evaluate(async () => {
      const c = await caches.open((await caches.keys())[0]);
      await c.put("./index.html?title=old&text=old-share", new Response("old"));
      await c.put("./kininari.html#knadd=old-share", new Response("old"));
    });
    px.ctl.swTail = "update " + Date.now();   // 以降は戻さない（戻すと、また入れ替わりが起きる）
    const swapped = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      // controllerchange は activate の処理（waitUntil）が終わる前に来るので、activated まで待つ
      const changed = new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", () => {
        const w = navigator.serviceWorker.controller;
        if (w.state === "activated") return r(true);
        w.addEventListener("statechange", () => { if (w.state === "activated") r(true); });
      }, { once: true }));
      await reg.update();
      return Promise.race([changed, new Promise((r) => setTimeout(() => r(false), 15000))]);
    });
    ok(swapped, "（前提）sw.js が変わると新しい worker に入れ替わる");
    const left = (await dump()).filter((e) => e.key.includes("?") || e.key.includes("#"));
    ok(!left.length, "入れ替わったとき、キャッシュに残っていた ? や # 付きの項目を捨てる", left);

    // 206 のあとで、キャッシュに無い音を丸ごと入れる
    await page.evaluate(async () => { const c = await caches.open((await caches.keys())[0]); await c.delete("./audio/brown.wav"); });
    const st206 = await page.evaluate(async () => (await fetch("./audio/brown.wav", { headers: { Range: "bytes=0-1" } })).status);
    ok(st206 === 206, "（前提）オンラインの音の Range はネットワークの 206", st206);
    const filled = await tryWait(() => page.evaluate(async () => {
      const m = await caches.match("./audio/brown.wav");
      return !!m && m.status === 200 && (await m.arrayBuffer()).byteLength > 100000;
    }), { timeout: 8000 });
    ok(!!filled, "キャッシュに無い就寝用の音は、206 を返したあとで丸ごと取ってキャッシュに入れる");

    // 応答が遅いとき
    px.ctl.delay["tasks.html"] = 9000; px.ctl.tail["tasks.html"] = "\n<!-- late-net -->\n";
    px.ctl.delay["kininari-clipper/manifest.json"] = 6000;
    const [hit, miss] = await Promise.all([
      page.evaluate(async () => {
        const t0 = performance.now(); const r = await fetch("./tasks.html"); const tx = await r.text();
        return { ms: Math.round(performance.now() - t0), status: r.status, late: tx.includes("late-net") };
      }),
      page.evaluate(async () => {
        const t0 = performance.now();
        try { const r = await fetch("./kininari-clipper/manifest.json"); const tx = await r.text();
              return { ms: Math.round(performance.now() - t0), status: r.status, json: tx.includes("manifest_version") }; }
        catch (e) { return { ms: Math.round(performance.now() - t0), err: String(e) }; }
      })
    ]);
    ok(hit.status === 200 && !hit.late && hit.ms >= 3500 && hit.ms < 7000, "応答が4秒来ないときは、キャッシュにあるものを先に返す", hit);
    ok(miss.status === 200 && miss.json && miss.ms >= 5500, "キャッシュに無いものは、そのままネットワークを待つ", miss);
    const updated = await tryWait(() => page.evaluate(async () => {
      const m = await caches.match("./tasks.html"); return !!m && (await m.text()).includes("late-net");
    }), { timeout: 10000 });
    ok(!!updated, "遅れて届いた応答で、裏でキャッシュを更新する");
    px.ctl.delay = {}; px.ctl.tail = {};

    // オフライン
    px.ctl.down = true;
    await page.goto(base + "index.html?title=off&text=offline-share&url=");
    ok(!!(await page.$("#tabbar")), "オフラインでも共有URL（? 付き）で入口が開く（? を外した鍵で見つかる）");
    await page.goto(base + "no-such-page.html");
    ok(!!(await page.$("#tabbar")), "オフラインでキャッシュに無いページへの画面移動は、index.html で開く");
    const fmiss = await page.evaluate(async () => {
      try { const r = await fetch("./README.txt"); const t = await r.text(); return { status: r.status, html: /<!doctype html/i.test(t) }; }
      catch (e) { return { err: String(e) }; }
    });
    ok(!!fmiss.err || (fmiss.status !== 200 && !fmiss.html), "オフラインで画面移動以外（fetch）の取りこぼしに index.html を返さない", fmiss);
    const imiss = await page.evaluate(() => new Promise((resolve) => {
      const f = document.createElement("iframe");
      f.onload = () => { let tab = false; try { tab = !!(f.contentDocument && f.contentDocument.getElementById("tabbar")); } catch (e) {} resolve(tab); };
      f.src = "./README.txt";
      document.body.appendChild(f);
      setTimeout(() => resolve("timeout"), 8000);
    }));
    ok(imiss === false, "オフラインで iframe の中は index.html にしない（タブ帯が入れ子にならない）", imiss);
    const ar = await page.evaluate(async () => {
      const r = await fetch("./audio/rain.wav", { headers: { Range: "bytes=0-1" } }); const b = await r.arrayBuffer();
      return { status: r.status, cr: r.headers.get("content-range"), len: b.byteLength };
    });
    ok(ar.status === 206 && ar.len === 2 && /^bytes 0-1\/\d+$/.test(ar.cr || ""), "オフラインの音の Range はキャッシュから 206 で返す", ar);
    const br = await page.evaluate(async () => {
      try { const r = await fetch("./audio/brown.wav", { headers: { Range: "bytes=100-199" } }); const b = await r.arrayBuffer(); return { status: r.status, len: b.byteLength }; }
      catch (e) { return { err: String(e) }; }
    });
    ok(br.status === 206 && br.len === 100, "あとから丸ごと入れた音も、オフラインで 206 で返せる", br);
    const au = await page.evaluate(() => new Promise((resolve) => {
      const a = new Audio(); a.preload = "auto";
      a.onloadedmetadata = () => resolve({ ok: true, dur: a.duration });
      a.onerror = () => resolve({ ok: false, code: a.error && a.error.code });
      a.src = "./audio/pink.wav"; a.load();
      setTimeout(() => resolve({ ok: false, timeout: true }), 8000);
    }));
    ok(au.ok && au.dur > 0, "オフラインでも <audio> で就寝用の音を読み込める", au);
    px.ctl.down = false;
    await ctx.close();
  }

  console.log("■ 入口（index.html）");
  {
    // 日記帳が受け取った命令を数える（日記帳自身のリスナーより先に登録される）
    const ctx = await newDevice(browser);
    await ctx.addInitScript(() => {
      if (!/\/diary\.html$/.test(location.pathname)) return;
      window.__nkSeen = [];
      addEventListener("message", (e) => { if (e.data && e.data.nkSync) window.__nkSeen.push(e.data.nkSync); });
    });
    const page = await ctx.newPage();
    px.ctl.delay["diary.html"] = 2500;   // 日記帳の読み込みが遅い（重い端末・回線）
    const dl = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
    await page.goto(base + "index.html", { waitUntil: "domcontentloaded" });
    await page.click("#knBackupBtn");
    await page.click("#knMd");
    await page.click("#knMd");
    const seen = await tryWait(async () => {
      const f = frameOf(page, "diary.html"); if (!f) return null;
      return f.evaluate(() => (window.__nkSeen && window.__nkSeen.includes("markdown")) ? window.__nkSeen.slice() : null).catch(() => null);
    }, { timeout: 10000 });
    ok(!!seen, "読み込み中の日記帳にも「Markdownで書き出す」の命令が届く", seen);
    ok(!!seen && seen.filter((x) => x === "markdown").length === 1, "待つあいだに2回押しても、送る命令は1回", seen);
    const d = await dl;
    ok(!!d && /\.md$/.test(d.suggestedFilename()), "日記帳が Markdown を書き出す", d && d.suggestedFilename());
    px.ctl.delay = {};
    // 名乗り出たあとは、すぐ届く（☁の画面は開いたまま）
    await page.click("#knSecurity");
    const sec = await tryWait(() => frameOf(page, "diary.html").evaluate(() => {
      const m = document.getElementById("securityModal"); return !!m && m.classList.contains("active");
    }).catch(() => false), { timeout: 3000 });
    ok(!!sec, "「暗号化の設定を開く」で日記帳のセキュリティ設定が開く");
    await ctx.close();
  }
  {
    const ctx = await newDevice(browser);
    const page = await ctx.newPage();
    await page.goto(base + "index.html");
    await sleep(1200);   // 日記帳が名乗り出るのを待つ
    px.ctl.delay["tasks.html"] = 2500;
    await frameOf(page, "diary.html").evaluate(() => {
      parent.postMessage({ nkToTask: { title: "一件目のタスク" } }, location.origin);   // URLのハッシュで渡る
      parent.postMessage({ nkToTask: { title: "二件目のタスク" } }, location.origin);   // 待ち行列に入る
      // ほかのタブ（日記帳）の状態報告。以前はこれを合図に、まだ読み込み中のタスクタブへ流して捨てていた
      parent.postMessage({ nkSyncStatus: { app: "diary", label: "日記帳", phase: "ok", at: Date.now(), msg: "" } }, location.origin);
    });
    const both = await tryWait(() => page.evaluate(() => {
      const s = localStorage.getItem("tasks:v1") || ""; return s.includes("一件目のタスク") && s.includes("二件目のタスク");
    }), { timeout: 10000 });
    ok(!!both, "タスクタブが名乗り出る前に、ほかのタブの報告で待ち行列を流して失わない",
       await page.evaluate(() => localStorage.getItem("tasks:v1")));
    px.ctl.delay = {};
    await ctx.close();
  }
  {
    // 2つのウィンドウ（同じ端末の別タブ）。B で音タブを開いたまま、A で取り込む
    const ctx = await newDevice(browser);
    const B = await ctx.newPage();
    await B.goto(base + "index.html");
    await B.click('.apptab[data-app="bgm"]');
    // 音タブの保存（save）は閉じた関数の中にあるので、保存が走る操作（🌙 夜間の切り替え）を押す。
    // 手元に残った内容をそのまま書くので、古い内容の音タブが残っていれば取り込んだデータを上書きする
    const pokeBgm = async (page) => {
      const f = frameOf(page, "bgm.html"); if (!f) return false;
      return f.evaluate(() => {
        // ボタンは処理（下の <script>）より先にできるので、読み込みが終わってから押す
        const b = document.getElementById("bNight"); if (!b || document.readyState !== "complete") return false;
        b.click(); return true;
      }).catch(() => false);
    };
    const bgmReady = await tryWait(() => pokeBgm(B), { timeout: 10000 });
    ok(!!bgmReady && await B.evaluate(() => !!localStorage.getItem("bgm:v1")), "（前提）B で音タブが開いていて、保存できる");
    await B.evaluate(() => { window.__before = 1; });
    const A = await ctx.newPage();
    await A.goto(base + "index.html");
    const backup = {
      app: "nikki-kininari", v: 3, exportedAt: new Date().toISOString(),
      bgm: JSON.stringify({ items: [{ vid: "dQw4w9WgXcQ", title: "IMPORTED-MARK", cats: [] }] })
    };
    await A.setInputFiles("#knImport", { name: "nikki-kininari-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
    const imported = await tryWait(() => A.evaluate(() => (document.getElementById("knMsg").textContent || "").includes("取り込みました")).catch(() => false), { timeout: 10000 });
    ok(!!imported, "（前提）A で取り込みが終わる");
    const reloaded = await tryWait(() => B.evaluate(() => !window.__before).catch(() => false), { timeout: 8000 });
    ok(!!reloaded, "取り込みが終わると、ほかのウィンドウ（B）も読み込み直す");
    await pokeBgm(B);
    const kept1 = await A.evaluate(() => (localStorage.getItem("bgm:v1") || "").includes("IMPORTED-MARK")).catch(() => false);
    ok(kept1, "B に古い内容の音タブが残っておらず、その保存で取り込んだデータが戻されない");
    await B.click('.apptab[data-app="bgm"]').catch(() => {});
    await tryWait(() => pokeBgm(B), { timeout: 8000 });
    const kept2 = await A.evaluate(() => (localStorage.getItem("bgm:v1") || "").includes("IMPORTED-MARK")).catch(() => false);
    ok(kept2, "B で開き直した音タブは取り込んだ内容を持っていて、保存しても消えない");
    await ctx.close();
  }
} catch (e) {
  ok(false, "検証が途中で止まりました", String(e && e.stack || e));
} finally {
  await browser.close();
  await px.close();
  await srv.close();
}
done();
