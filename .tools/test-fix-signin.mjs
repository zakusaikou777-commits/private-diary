/* 入口（index.html）の「今すぐ全部同期」で、Googleのログインが1回で済むかの検証
     node .tools/test-fix-signin.mjs
   本物のブラウザは、1回のクリックで開けるログイン画面（ポップアップ）が1つだけ。
   偽のログイン（gis-stub.js）の popupBlocked でそれを真似て、
   - 入口がクリックの中で1回だけトークンを取る
   - 各タブはそのトークンを使い、ポップアップを出さずに同期できる
   を確かめる。 */
import { startServer, launch, newDevice, makeChecker, collectErrors, waitFor } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const root = process.argv[2];
const c = makeChecker("今すぐ全部同期のログイン");
const srv = await startServer(root);
const br = await launch();
const drive = createFakeDrive();
const ctx = await newDevice(br, { drive });
await ctx.addInitScript(() => {
  if (window.top === window) {
    window.__fakeGis = { mode: "popupBlocked", delay: 50 };
    try { localStorage.setItem("shared:gd:cid", "test-client"); } catch (e) {}
  }
});
const page = await ctx.newPage();
const errs = collectErrors(page);
await page.goto(srv.url + "index.html");
await page.waitForFunction(() => window.google && google.accounts && google.accounts.oauth2, null, { timeout: 10000 });

await page.click("#knBackupBtn");
await page.click("#knSyncAll");
// 音・暗室・タスク・くつろぎは sync.js で同期する。どれかが終わるまで待つ
await waitFor(async () => drive.byName("nikki-apps-data.json").length > 0, { timeout: 30000, label: "共通ファイルの作成" });
await waitFor(async () => {
  const t = await page.textContent("#knStatus");
  return !/同期中/.test(t);
}, { timeout: 40000, label: "全タブの同期の終わり" });

const calls = await page.evaluate(() => window.__fakeGisCalls || []);
const status = await page.textContent("#knStatus");
const tok = await page.evaluate(() => JSON.parse(localStorage.getItem("shared:gd:token") || "null"));
c.ok(calls.length >= 1 && calls[0].frame.endsWith("index.html") && calls[0].activation, "入口がクリックの中でログインを頼む", calls[0]);
c.ok(calls.filter((x) => !x.frame.endsWith("index.html")).length === 0, "各タブはログイン画面を出さない", calls.map((x) => x.frame));
c.ok(tok && tok.scope && tok.scope.includes("drive.appdata"), "取れたトークンは権限つきで共有される", tok && tok.scope);
c.ok(!/ポップアップ|キャンセル|つなげません/.test(status), "どのタブもログインの失敗にならない", status);
c.ok(errs.filter((e) => !/Failed to load resource/.test(e)).length === 0, "入口にエラーが無い", errs);

await br.close(); await srv.close();
c.done();
