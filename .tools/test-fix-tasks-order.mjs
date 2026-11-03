/* タスクの並べ替え（v46）の検証
     node .tools/test-fix-tasks-order.mjs
   - 左のつまみをドラッグして、同じまとまりの中で順番を変えられる（読み込み直しても残る）
   - つまみを選んで ↑↓ / Home / End でも動かせる
   - ほかのまとまり（期限の違うもの）へはまたがない
   - 新しく足したタスクは、そのまとまりのいちばん上
   - 並べ替えだけでは Googleタスクへ送り直さない（そろっていた印を崩さない）
   - 並べ替えの途中に同期の描き直しが来ても、つかんだ行が離れない
   - 並びは Drive の同期でほかの端末にも届く */
import { startServer, launch, newDevice, makeChecker, collectErrors, sleep, waitFor } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const ROOT = process.env.TASKS_ROOT || undefined;
const c = makeChecker("タスクの並べ替え");
const srv = await startServer(ROOT);
const br = await launch();
const STD = ["drive.file", "drive.appdata", "calendar.events", "tasks"].map((s) => "https://www.googleapis.com/auth/" + s).join(" ");
const errsAll = [];

const now = Date.now();
const task = (id, title, extra = {}) => ({ id, title, note: "", date: "", time: "", rep: "", done: false, doneAt: 0, gcalEventId: "",
  createdAt: now - Number(id.replace(/\D/g, "")) * 60000, updatedAt: now - 3600e3, ...extra });
const todayStr = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

async function open({ items, drive = null, token = false, ctx = null }) {
  if (!ctx) ctx = await newDevice(br, { drive, contextOptions: { viewport: { width: 1100, height: 900 }, timezoneId: "Asia/Tokyo" } });
  const page = await ctx.newPage();
  errsAll.push(collectErrors(page));
  await page.goto(srv.url + "__blank__");
  await page.evaluate(({ items, token, STD }) => {
    localStorage.setItem("shared:gd:cid", "test-client");
    if (items) localStorage.setItem("tasks:v1", JSON.stringify({ items, deleted: [], gdel: [] }));
    if (token) localStorage.setItem("shared:gd:token", JSON.stringify({ token: "fake." + btoa(STD), exp: Date.now() + 3600e3, scope: STD }));
  }, { items, token, STD });
  await page.goto(srv.url + "tasks.html");
  await page.waitForSelector("#list");
  return { ctx, page };
}
const titles = (page, g) => page.$$eval(g ? `#list .item[data-g="${g}"] .it` : "#list .item .it", (e) => e.map((x) => x.textContent));
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("tasks:v1")).items);
async function dragGrip(page, fromTitle, toTitle, { after = false, steps = 8 } = {}) {
  const g = await page.locator(`.item:has(.it:text-is("${fromTitle}")) .grip`).boundingBox();
  const t = await page.locator(`.item:has(.it:text-is("${toTitle}"))`).boundingBox();
  const sx = g.x + g.width / 2, sy = g.y + g.height / 2;
  const ty = after ? t.y + t.height * 0.8 : t.y + t.height * 0.2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, sy + (ty > sy ? 8 : -8), { steps: 2 });
  await page.mouse.move(sx, ty, { steps });
  await page.mouse.up();
  await sleep(150);
}

// ── 1. ドラッグで並べ替え・読み込み直しても残る ──
{
  console.log("1. ドラッグで並べ替える");
  const items = [task("t1", "オレンジカード"), task("t2", "自律訓練"), task("t3", "記憶方法整理"), task("t4", "イメトレ")];
  const { ctx, page } = await open({ items });
  const before = await titles(page, "期限なし");
  c.ok(before.join() === "オレンジカード,自律訓練,記憶方法整理,イメトレ", "はじめは新しい順", before);
  c.ok((await page.$$("#list .grip")).length === 4, "どのタスクにもつまみが出る");
  await dragGrip(page, "イメトレ", "オレンジカード");
  const after = await titles(page, "期限なし");
  c.ok(after.join() === "イメトレ,オレンジカード,自律訓練,記憶方法整理", "いちばん下をいちばん上へ動かせる", after);
  await dragGrip(page, "オレンジカード", "記憶方法整理", { after: true });
  const after2 = await titles(page, "期限なし");
  c.ok(after2.join() === "イメトレ,自律訓練,記憶方法整理,オレンジカード", "上から下へも動かせる", after2);
  const st = await stored(page);
  c.ok(st.every((x) => typeof x.ord === "number"), "並びを保存する（ord）", st.map((x) => x.ord));
  await page.reload();
  await page.waitForSelector("#list .item");
  c.ok((await titles(page, "期限なし")).join() === after2.join(), "読み込み直しても並びが残る");
  // つまみを押しただけ（動かさない）なら何も変えない
  const u0 = (await stored(page)).map((x) => x.updatedAt).join();
  const gb = await page.locator('.item:has(.it:text-is("自律訓練")) .grip').boundingBox();
  await page.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await sleep(100);
  c.ok((await stored(page)).map((x) => x.updatedAt).join() === u0, "つまみを押しただけでは保存しない");
  await ctx.close();
}

// ── 2. キーボード・新しいタスク・まとまりをまたがない ──
{
  console.log("2. キーボード・新しいタスク・まとまり");
  const td = todayStr();
  const items = [task("t1", "A"), task("t2", "B"), task("t3", "C"), task("t9", "今日のタスク", { date: td })];
  const { ctx, page } = await open({ items });
  await page.focus('.item:has(.it:text-is("C")) .grip');
  await page.keyboard.press("ArrowUp");
  c.ok((await titles(page, "期限なし")).join() === "A,C,B", "↑キーで1つ上へ", await titles(page, "期限なし"));
  c.ok(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("grip") && document.activeElement.closest(".item").querySelector(".it").textContent === "C"), "動かしたあとも、同じタスクのつまみを選んだまま");
  await page.keyboard.press("Home");
  c.ok((await titles(page, "期限なし")).join() === "C,A,B", "Home でまとまりの先頭へ");
  await page.keyboard.press("End");
  c.ok((await titles(page, "期限なし")).join() === "A,B,C", "End でまとまりの最後へ");
  // 期限なしのタスクを、今日のまとまりの上まで運んでも、期限なしのまとまりの中に収まる
  await dragGrip(page, "B", "今日のタスク");
  const st = await stored(page);
  c.ok(st.find((x) => x.title === "B").date === "" && (await titles(page, "今日")).join() === "今日のタスク", "ほかのまとまりへはまたがない（期限は変えない）");
  c.ok((await titles(page, "期限なし"))[0] === "B", "まとまりの端で止まる（いちばん上）", await titles(page, "期限なし"));
  // 新しく足したタスクは、そのまとまりのいちばん上
  await page.fill("#nt", "新しいタスク");
  await page.press("#nt", "Enter");
  c.ok((await titles(page, "期限なし"))[0] === "新しいタスク", "新しく足したタスクは、そのまとまりのいちばん上", await titles(page, "期限なし"));
  // 完了の一覧にはつまみを出さない
  await page.click('#filters .f[data-f="done"]');
  c.ok((await page.$$("#list .grip")).length === 0, "完了の一覧にはつまみを出さない");
  await ctx.close();
}

// ── 3. Googleタスクへ送り直さない ──
{
  console.log("3. Googleタスクとそろっていた印");
  const items = [task("t1", "G1のタスク", { gtaskId: "G1", gtaskUpdated: "2026-11-01T00:00:00.000Z", gtSyncedAt: now - 3600e3 }), task("t2", "G2のタスク", { gtaskId: "G2", gtaskUpdated: "2026-11-01T00:00:00.000Z", gtSyncedAt: now - 3600e3 })];
  const { ctx, page } = await open({ items });
  await dragGrip(page, "G2のタスク", "G1のタスク");
  const st = await stored(page);
  c.ok(st.every((x) => x.updatedAt === x.gtSyncedAt && x.updatedAt > now - 60000), "並べ替えたタスクも「Googleタスクとそろっている」のまま（送り直さない）", st.map((x) => [x.updatedAt, x.gtSyncedAt]));
  await ctx.close();
}

// ── 4. 途中で描き直しが来ても離れない ──
{
  console.log("4. 並べ替えの途中の描き直し");
  const items = [task("t1", "一"), task("t2", "二"), task("t3", "三")];
  const { ctx, page } = await open({ items });
  const g = await page.locator('.item:has(.it:text-is("三")) .grip').boundingBox();
  const t = await page.locator('.item:has(.it:text-is("一"))').boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y - 10, { steps: 3 });
  // 同期がデータを書き換えて描き直したことにする（別のタブでの変更）
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "tasks:v1", newValue: localStorage.getItem("tasks:v1") })));
  await page.mouse.move(g.x + g.width / 2, t.y + 4, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
  c.ok((await titles(page, "期限なし")).join() === "三,一,二", "描き直しが来ても、つかんだ行は離れずに運べる", await titles(page, "期限なし"));
  await ctx.close();
}

// ── 5. ほかの端末へ届く ──
{
  console.log("5. Drive の同期でほかの端末へ");
  const drive = createFakeDrive();
  const items = [task("t1", "あ"), task("t2", "い"), task("t3", "う")];
  const A = await open({ items, drive, token: true });
  await waitFor(() => drive.byName("nikki-apps-data.json").length > 0, { timeout: 15000, label: "Aの最初の同期" });
  await dragGrip(A.page, "う", "あ");
  const want = (await titles(A.page, "期限なし")).join();
  c.ok(want === "う,あ,い", "端末Aで並べ替えた", want);
  await waitFor(() => {
    const f = drive.byName("nikki-apps-data.json")[0];
    const d = f && drive.json(f.id);
    const it = d && d.apps && d.apps.tasks && d.apps.tasks.items;
    return it && it.every((x) => typeof x.ord === "number");
  }, { timeout: 15000, label: "並びがDriveに載る" });
  const B = await open({ items: [], drive, token: true });
  await waitFor(async () => (await titles(B.page, "期限なし")).length === 3, { timeout: 15000, label: "端末Bの取り込み" });
  c.ok((await titles(B.page, "期限なし")).join() === want, "端末Bでも同じ並び", await titles(B.page, "期限なし"));
  await A.ctx.close(); await B.ctx.close();
}

// ── 6. スマホ（指）でドラッグ ──
{
  console.log("6. 指でドラッグ（スマホ）");
  const ctx = await newDevice(br, { contextOptions: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } });
  const items = [task("t1", "一番"), task("t2", "二番"), task("t3", "三番")];
  const { page } = await open({ items, ctx });
  const cdp = await ctx.newCDPSession(page);
  const g = await page.locator('.item:has(.it:text-is("三番")) .grip').boundingBox();
  const t = await page.locator('.item:has(.it:text-is("一番"))').boundingBox();
  const x = g.x + g.width / 2, y0 = g.y + g.height / 2, y1 = t.y + 6;
  const scroll0 = await page.evaluate(() => scrollY);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + (y1 - y0) * i / 8 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(200);
  c.ok((await titles(page, "期限なし")).join() === "三番,一番,二番", "指でつまみをドラッグして並べ替えられる", await titles(page, "期限なし"));
  c.ok((await page.evaluate(() => scrollY)) === scroll0, "つまみをドラッグしている間、ページはスクロールしない");
  await ctx.close();
}

const pageErrs = errsAll.flat().filter((e) => !/Failed to load resource/.test(e));
c.ok(pageErrs.length === 0, "ページの例外・エラーが無い", pageErrs);
await br.close(); await srv.close();
c.done();
