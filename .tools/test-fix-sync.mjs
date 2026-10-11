/* sync.js（NKSync と NKSync.drive）の検証
     node .tools/test-fix-sync.mjs
   - id が "constructor" などでも同期で消えない
   - 削除より後の編集は、ローカルにしか無くても残る
   - トークンに許可された権限を覚え、足りないときは使わない（旧版の記録は使う）
   - 401・権限不足の 403 で保存したトークンを捨てる。混雑(503)は GET をやり直す
   - 本文の途中で止まった通信もタイムアウトする
   - 別のファイルに乗り換えたとき（別アカウント・削除）、同期済みの項目を消さない
   - syncQuiet が走行中の同期を待ってからもう一度同期する */
import http from "node:http";
import { startServer, launch, newDevice, makeChecker, collectErrors } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const c = makeChecker("sync.js");
const srv = await startServer();
const br = await launch();

// 本文の途中で止まるサーバー（タイムアウトの検証用）
const stall = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, PATCH, POST, DELETE" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  res.writeHead(200, { ...cors, "Content-Type": "application/json", "Content-Length": "100000" });
  res.write('{"a":"'); // ここで止める
});
await new Promise((r) => stall.listen(0, "127.0.0.1", r));
const stallUrl = `http://127.0.0.1:${stall.address().port}/x`;

async function devicePage(drive) {
  const ctx = await newDevice(br, { drive });
  const page = await ctx.newPage();
  const errs = collectErrors(page);
  await page.goto(srv.url + "__blank__");
  await page.addScriptTag({ url: srv.url + "sync.js" });
  await page.addScriptTag({ url: "https://accounts.google.com/gsi/client" });
  await page.evaluate(() => localStorage.setItem("shared:gd:cid", "test-client"));
  return { ctx, page, errs };
}

// ── 1. 純粋なマージ ──
{
  const drive = createFakeDrive();
  const { page } = await devicePage(drive);
  const r = await page.evaluate(() => {
    const M = NKSync.mergeById;
    const a = M([{ id: "constructor", updatedAt: 5 }, { id: "toString", updatedAt: 6 }], [], 0, []);
    const b = M([{ id: "x", updatedAt: 200, synced: 1 }], [], 0, [{ id: "x", at: 100 }]);   // 削除(100)より後に編集(200)
    const d = M([{ id: "y", updatedAt: 50, synced: 1 }], [], 0, [{ id: "y", at: 100 }]);    // 削除の方が後
    const e = M([{ id: "z", updatedAt: 50, synced: 1 }], [], 0, []);                         // 墓標なしで消えている
    const t = NKSync.mergeTombs([{ id: "constructor", at: Date.now() }], []);
    return { a: a.map((x) => x.id), b: b.map((x) => x.id), d: d.length, e: e.length, t: t.map((x) => x.id) };
  });
  c.ok(r.a.join() === "constructor,toString", "id が constructor/toString でも残る", r.a);
  c.ok(r.b.join() === "x", "削除より後の編集はローカルにしか無くても残る", r.b);
  c.ok(r.d === 0, "編集より後の削除は消す", r.d);
  c.ok(r.e === 0, "墓標なしでDriveから消えた同期済み項目は消す（従来どおり）", r.e);
  c.ok(r.t.join() === "constructor", "墓標の id が constructor でも残る", r.t);
}

// ── 2. トークンと通信 ──
{
  const drive = createFakeDrive();
  const { page } = await devicePage(drive);
  const D = "https://www.googleapis.com/auth/";
  const r = await page.evaluate(async ({ D, stallUrl }) => {
    const d = NKSync.drive, out = {};
    // 旧版の記録（scope 無し）は使う
    localStorage.setItem("shared:gd:token", JSON.stringify({ token: "fake." + btoa(D + "drive.file"), exp: Date.now() + 3600e3 }));
    out.legacy = !!d.tokenRead(d.STD_SCOPE);
    // drive.file だけと分かっているものは、appdata が要るときには使わない
    d.tokenSave("fake." + btoa(D + "drive.file"), 3600, D + "drive.file");
    out.narrowFile = !!d.tokenRead(D + "drive.file");
    out.narrowApp = !!d.tokenRead(D + "drive.appdata");
    // 取り直すと STD_SCOPE で頼み、許可された権限を覚える
    const tok = await d.getToken({ scope: D + "drive.appdata" });
    out.calls = (window.__fakeGisCalls || []).map((x) => x.scope);
    out.saved = JSON.parse(localStorage.getItem("shared:gd:token")).scope;
    out.tokOk = !!tok;
    // 503 は GET をやり直して通る
    return out;
  }, { D, stallUrl });
  c.ok(r.legacy, "scope の記録が無い旧版のトークンは使う");
  c.ok(r.narrowFile && !r.narrowApp, "drive.file だけのトークンを appdata が要るときに使わない", r);
  c.ok(r.calls.length === 1 && r.calls[0].includes("drive.appdata") && r.calls[0].includes("drive.file") && r.calls[0].includes("calendar.events"), "取り直すときは共通の権限をまとめて頼む", r.calls);
  c.ok(r.saved && r.saved.includes("drive.appdata"), "許可された権限を保存する", r.saved);

  drive.failNext(1, 503);
  const r2 = await page.evaluate(async () => {
    const d = NKSync.drive;
    const tok = await d.getToken({});
    const t0 = Date.now();
    const j = await d.api("https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent("name='a'") + "&fields=files(id)", tok);
    return { ok: Array.isArray(j.files), waited: Date.now() - t0 };
  });
  c.ok(r2.ok && r2.waited >= 900, "503 は少し待ってやり直す", r2);

  drive.failNext(1, 503);
  const r3 = await page.evaluate(async () => {
    const d = NKSync.drive;
    const tok = await d.getToken({});
    try { await d.upload(tok, { name: "p.json", content: "{}" }); return "通った"; } catch (e) { return e.status; }
  });
  c.ok(r3 === 503, "作成（POST）はやり直さない（二重に作らない）", r3);

  drive.expireAll();
  const r4 = await page.evaluate(async () => {
    const d = NKSync.drive;
    const tok = d.tokenRead(d.STD_SCOPE);
    let st = null;
    try { await d.meta(tok, "nothing"); } catch (e) { st = e.status; }
    return { st, left: localStorage.getItem("shared:gd:token") };
  });
  drive.renew();
  c.ok(r4.st === 401 && r4.left === null, "401 で保存したトークンを捨てる", r4);

  const r5 = await page.evaluate(async (stallUrl) => {
    const d = NKSync.drive;
    const t0 = Date.now();
    try { await d.api(stallUrl, "x", { timeout: 800 }); return "返ってきた"; }
    catch (e) { return { msg: e.message, ms: Date.now() - t0 }; }
  }, stallUrl);
  c.ok(r5 && /タイムアウト/.test(r5.msg) && r5.ms < 3000, "本文の途中で止まった通信もタイムアウトする", r5);
}

// ── 3. 別のファイルへの乗り換えで消さない／syncQuiet ──
{
  const drive = createFakeDrive();
  const { page, errs } = await devicePage(drive);
  await page.evaluate(() => {
    window.KEY = "test:items";
    localStorage.setItem(KEY, JSON.stringify([{ id: "a1", updatedAt: 1 }, { id: "a2", updatedAt: 2 }]));
    window.app = NKSync.create({
      app: "test", label: "テスト",
      getLocal: () => ({ items: JSON.parse(localStorage.getItem(KEY) || "[]") }),
      setLocal: (v) => localStorage.setItem(KEY, JSON.stringify(v.items || [])),
      merge: (l, r) => ({ items: NKSync.mergeById((l && l.items) || [], (r && r.items) || [], 0, []) })
    });
  });
  await page.evaluate(() => app.syncNow());
  const f1 = drive.byName("nikki-apps-data.json");
  const synced = await page.evaluate(() => JSON.parse(localStorage.getItem(KEY)).every((x) => x.synced));
  c.ok(f1.length === 1 && synced, "初回同期でファイルを作り、印を付ける", { n: f1.length, synced });

  // 別アカウントに切り替えた想定: 元のファイルは見えなくなり、別の中身のファイルがある
  drive.files.delete(f1[0].id);
  drive.put("nikki-apps-data.json", { app: "nikki-sync", v: 1, apps: { test: { items: [{ id: "b1", updatedAt: 3, synced: 1 }] } } });
  await page.evaluate(() => app.syncNow());
  const ids = await page.evaluate(() => JSON.parse(localStorage.getItem(KEY)).map((x) => x.id).sort().join());
  c.ok(ids === "a1,a2,b1", "別のファイルに乗り換えても、同期済みの項目を消さずに合わせる", ids);

  // 同じファイルとの同期では、従来どおり他端末の削除が反映される
  const f2 = drive.byName("nikki-apps-data.json")[0];
  const doc = drive.json(f2.id);
  doc.apps.test.items = doc.apps.test.items.filter((x) => x.id !== "a1");
  drive.write(f2.id, doc);
  await page.evaluate(() => app.syncNow());
  const ids2 = await page.evaluate(() => JSON.parse(localStorage.getItem(KEY)).map((x) => x.id).sort().join());
  c.ok(ids2 === "a2,b1", "同じファイルでは他端末の削除が反映される", ids2);

  // syncQuiet: 走行中ならそれを待ってからもう一度
  const r = await page.evaluate(async () => {
    window.__fakeGis = { delay: 300 };
    localStorage.removeItem("shared:gd:token");
    const p1 = app.syncNow();
    const n0 = performance.now();
    await app.syncQuiet();
    const done1 = await Promise.race([p1.then(() => true), new Promise((r) => setTimeout(() => r(false), 0))]);
    return { done1, ms: performance.now() - n0, st: app.status().phase };
  });
  c.ok(r.done1 && r.st === "ok", "syncQuiet は走行中の同期が終わるのを待つ", r);
  // 404 は検証用の空ページ（__blank__）自体のもの
  const real = errs.filter((e) => !/Failed to load resource/.test(e));
  c.ok(real.length === 0, "ページのエラーが無い", real);
}

await br.close(); await srv.close(); stall.close();
c.done();
