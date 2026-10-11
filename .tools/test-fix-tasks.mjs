/* tasks.html の検証
     node .tools/test-fix-tasks.mjs
     TASKS_ROOT=<別の置き場> node .tools/test-fix-tasks.mjs … そこの tasks.html を試す（直す前の版で落ちることの確認用）
   - Googleタスクと同期する前にDriveの最新を取り込む（取り込み直しで重複しない・消したタスクが生き返らない）
   - 同じGoogleタスクに紐付いた写しは1つにまとまる
   - Driveが読めなくても、紐付けを外したタスクが墓標に勝って生き返らない
   - Android（new Notification が使えない）では Service Worker から通知を出す。無ければ帯で知らせる
   - Driveから後で届いた過去の時刻のタスクは鳴らさない（前回の見回りより後に時刻を迎えたものだけ鳴らす）
   - Googleタスクの同期は重ならない（同じタスクを2回POSTしない）
   - 気になり帳から #taskadd で受け取ったタスクも自動送信される
   - Googleタスクで日付を変えたら毎月の基準日も合わせる
   - 権限の足りないトークンで403になったら、取り直して一度だけやり直す
   - カレンダー: 終日⇔時刻ありの切り替えでもう片方を null で消す。消された予定は作り直す
   - 1週間より前に完了したGoogleタスクは取り込まない
   - 開いたまま日付が変わったら描き直す
   - ほかのタブの保存を取り込む（上書きし合わない・打ちかけの編集欄は残す） */
import { startServer, launch, newDevice, makeChecker, collectErrors, waitFor, sleep, ROOT } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const c = makeChecker("tasks.html");
const srv = await startServer(process.env.TASKS_ROOT || ROOT);
const br = await launch();
const AU = "https://www.googleapis.com/auth/";
const GD_SCOPE = [AU + "drive.file", AU + "drive.appdata", AU + "calendar.events", AU + "tasks"].join(" ");
const DAY = 86400000;
const tokyoDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const json = (route, status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
const allErrs = [];

/* ── Google Tasks の小さな偽物（メモリ上）──
   トークンは gis-stub と同じ "fake." + base64(scope)。tasks の権限が無ければ 403。
   listDelay: 一覧の返事を遅らせる（先頭から1回ずつ使う）/ postDelay: 作成の返事を遅らせる */
function createFakeTasks() {
  const tasks = new Map();
  const log = [];
  const hooks = { listDelay: [], postDelay: 0 };
  let seq = 0, clock = Date.parse("2026-10-01T00:00:00.000Z");
  const upd = () => new Date((clock += 1000)).toISOString();
  function add(t) {
    const id = t.id || "g" + ++seq;
    const o = { kind: "tasks#task", title: "", notes: "", status: "needsAction", updated: upd(), ...t, id };
    tasks.set(id, o);
    return o;
  }
  function scopesOf(req) {
    const m = /^Bearer fake\.(.*)$/.exec(req.headers()["authorization"] || "");
    if (!m) return null;
    try { return Buffer.from(m[1], "base64").toString("utf8").split(/\s+/); } catch (e) { return null; }
  }
  async function handle(route) {
    const req = route.request(), u = new URL(req.url()), method = req.method();
    log.push({ method, path: u.pathname, body: req.postData() || "" });
    const sc = scopesOf(req);
    if (!sc) return json(route, 401, { error: { code: 401 } });
    if (!sc.includes(AU + "tasks")) return json(route, 403, { error: { code: 403, message: "Request had insufficient authentication scopes." } });
    const p = u.pathname.replace(/^\/tasks\/v1/, "");
    if (method === "GET" && p === "/users/@me/lists") return json(route, 200, { items: [{ id: "L1", title: "マイタスク" }] });
    const m = /^\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(p);
    if (!m || decodeURIComponent(m[1]) !== "L1") return json(route, 404, { error: { code: 404 } });
    const id = m[2] && decodeURIComponent(m[2]);
    if (method === "GET" && !id) {
      const d = hooks.listDelay.shift();
      if (d) await sleep(d);
      return json(route, 200, { items: [...tasks.values()] });
    }
    if (method === "POST" && !id) {
      if (hooks.postDelay) await sleep(hooks.postDelay);
      const b = JSON.parse(req.postData() || "{}");
      const o = add({ title: b.title, notes: b.notes || "", status: b.status || "needsAction", ...(b.due ? { due: b.due } : {}) });
      return json(route, 200, o);
    }
    const cur = id && tasks.get(id);
    if (!cur) return json(route, 404, { error: { code: 404 } });
    if (method === "PATCH") {
      const b = JSON.parse(req.postData() || "{}");
      for (const k of Object.keys(b)) { if (b[k] === null) delete cur[k]; else cur[k] = b[k]; }
      cur.updated = upd();
      return json(route, 200, cur);
    }
    if (method === "DELETE") { tasks.delete(id); return route.fulfill({ status: 204, body: "" }); }
    return json(route, 405, { error: { code: 405 } });
  }
  return { tasks, log, hooks, add, handle, titles: () => [...tasks.values()].map((t) => t.title) };
}

/* ── Googleカレンダーの小さな偽物 ── PATCH は本物と同じく中まで混ぜ合わせ（null は消す）、
   date と dateTime が両方残ったら 400 にする。cancelled の予定は PATCH しても cancelled のまま */
function createFakeCal() {
  const events = new Map();
  const log = [];
  let seq = 0;
  const mergeIn = (dst, src) => {
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (v === null) delete dst[k];
      else if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object") mergeIn(dst[k], v);
      else dst[k] = v;
    }
  };
  const bad = (ev) => ["start", "end"].some((k) => ev[k] && ev[k].date && ev[k].dateTime);
  async function handle(route) {
    const req = route.request(), u = new URL(req.url());
    const m = /^\/calendar\/v3\/calendars\/primary\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return false;
    const method = req.method(), id = m[1] && decodeURIComponent(m[1]);
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    log.push({ method, id, body });
    if (method === "POST" && !id) {
      const ev = { id: "new" + ++seq, status: "confirmed", ...body };
      if (bad(ev)) return json(route, 400, { error: { code: 400 } });
      events.set(ev.id, ev);
      return json(route, 200, ev);
    }
    if (method === "PATCH" && id) {
      const ev = events.get(id);
      if (!ev) return json(route, 404, { error: { code: 404, message: "Not Found" } });
      if (ev.gone) return json(route, 410, { error: { code: 410, message: "Resource has been deleted" } });
      const next = JSON.parse(JSON.stringify(ev));
      mergeIn(next, body);
      if (bad(next)) return json(route, 400, { error: { code: 400, message: "Invalid start time." } });
      events.set(id, next);
      return json(route, 200, next);
    }
    return json(route, 404, { error: { code: 404 } });
  }
  return { events, log, handle };
}

/* ── 通知まわりの偽物（ページより先に入れる）──
   mode "android": new Notification は Illegal constructor で落ちる（Android の Chrome と同じ）
   mode "desktop": new Notification は記録するだけ。window.__noReg=true で SW の登録が無いことにする */
function fakeNotify(mode) {
  window.__notes = [];
  window.__noReg = mode === "desktop";
  const reg = {
    active: {},
    showNotification(title, opt) { window.__notes.push({ via: "sw", title, opt }); return Promise.resolve(); },
    getNotifications() { return Promise.resolve([]); }
  };
  const sw = {
    register() { return Promise.resolve(reg); },
    getRegistration() { return Promise.resolve(window.__noReg ? undefined : reg); },
    get ready() { return Promise.resolve(reg); },
    addEventListener() {}, removeEventListener() {}
  };
  Object.defineProperty(Navigator.prototype, "serviceWorker", { get() { return sw; }, configurable: true });
  function N(title, opt) {
    if (mode === "android") throw new TypeError("Failed to construct 'Notification': Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.");
    window.__notes.push({ via: "page", title, opt });
    this.close = function () {};
  }
  N.permission = "granted";
  N.requestPermission = () => Promise.resolve("granted");
  window.Notification = N;
}

/** 端末1台を開く。ls: 先に入れておく localStorage / token: 入れておくトークンの権限（null で入れない） */
async function openTasks({ drive = null, gtasks = null, cal = null, ls = {}, token = GD_SCOPE, hash = "", clock = undefined, notify = null, ctx = null } = {}) {
  if (!ctx) {
    ctx = await newDevice(br, { drive, onExternal: cal ? cal.handle : null, contextOptions: { timezoneId: "Asia/Tokyo" } });
    if (gtasks) await ctx.route("https://tasks.googleapis.com/**", gtasks.handle);
    if (notify) await ctx.addInitScript(fakeNotify, notify);
  }
  const page = await ctx.newPage();
  const errs = collectErrors(page);
  allErrs.push(errs);
  if (clock !== undefined) await page.clock.install(clock === null ? {} : { time: clock });
  await page.goto(srv.url + "__blank__");
  await page.evaluate(({ ls, token }) => {
    localStorage.setItem("shared:gd:cid", "test-client");
    for (const k of Object.keys(ls)) localStorage.setItem(k, typeof ls[k] === "string" ? ls[k] : JSON.stringify(ls[k]));
    if (token) localStorage.setItem("shared:gd:token", JSON.stringify({ token: "fake." + btoa(token), exp: Date.now() + 3600e3 }));
  }, { ls, token });
  await page.goto(srv.url + "tasks.html" + hash);
  await page.waitForSelector("#list");
  return { ctx, page, errs };
}
const lsTasks = (page) => page.evaluate(() => (JSON.parse(localStorage.getItem("tasks:v1") || "null") || { items: [] }));
const listText = (page) => page.evaluate(() => document.getElementById("list").textContent);
const heads = (page) => page.evaluate(() => [...document.querySelectorAll("#list .gh")].map((e) => e.textContent));
async function gtClickAndWait(page, label) {
  await page.click("#bGt");
  await waitFor(() => page.evaluate(() => { const b = document.getElementById("bGt"); return !b.disabled && b.textContent === "Googleタスクと同期"; }),
    { timeout: 40000, label: label || "Googleタスク同期の終わり" });
}
function driveTasks(drive) {
  const f = drive.byName("nikki-apps-data.json").sort((a, b) => (a.createdTime < b.createdTime ? -1 : 1))[0];
  if (!f) return null;
  const d = drive.json(f.id);
  return (d && d.apps && d.apps.tasks) || null;
}
const lastSync = (page) => page.evaluate(() => localStorage.getItem("shared:nksync:sync:tasks") || "");
const task = (o) => ({ note: "", date: "", time: "", rep: "", done: false, doneAt: 0, gcalEventId: "", createdAt: 1000, updatedAt: 1000, ...o });

// ── 1. 古いタブのGoogleタスク同期で、別の端末が取り込み済みのタスクを取り込み直さない ──
{
  console.log("1. 同期の前にDriveを取り込む（重複の取り込み）");
  const drive = createFakeDrive(), gt = createFakeTasks();
  gt.add({ id: "G1", title: "Googleで作ったタスク" });
  const A = await openTasks({ drive, gtasks: gt });
  await waitFor(async () => (await lastSync(A.page)) && driveTasks(drive), { label: "端末Aの最初の同期" });
  const B = await openTasks({ drive, gtasks: gt });
  await waitFor(() => lastSync(B.page), { label: "端末Bの最初の同期" });
  await gtClickAndWait(A.page, "端末AのGoogleタスク同期");
  await waitFor(() => { const d = driveTasks(drive); return d && d.items.some((x) => x.gtaskId === "G1"); }, { label: "端末Aの取り込みがDriveに載る" });
  const aId = driveTasks(drive).items.find((x) => x.gtaskId === "G1").id;
  // 端末Bはまだ古い中身のまま（Aの取り込みを知らない）
  c.ok(!(await lsTasks(B.page)).items.some((x) => x.gtaskId === "G1"), "（前提）端末Bはまだ取り込みを知らない");
  await gtClickAndWait(B.page, "端末BのGoogleタスク同期");
  await sleep(4500);   // 同期のあとのDrive同期（3秒後）まで待つ
  const bl = (await lsTasks(B.page)).items.filter((x) => x.gtaskId === "G1");
  c.ok(bl.length === 1 && bl[0].id === aId, "端末BはGoogleタスクを別のuidで取り込み直さない（1件・Aと同じid）", bl.map((x) => x.id));
  const dl = driveTasks(drive).items.filter((x) => x.gtaskId === "G1");
  c.ok(dl.length === 1, "Driveにも1件だけ", dl.length);
  await A.ctx.close(); await B.ctx.close();
}

// ── 1b. 自動同期をOFFにしているとき（バックアップの取り込み直後など）は、Driveへ取りに行かない ──
{
  console.log("1b. 自動同期OFFのときはDriveに触れない");
  const drive = createFakeDrive(), gt = createFakeTasks();
  gt.add({ id: "G1b", title: "自動同期OFFのとき" });
  const P = await openTasks({ drive, gtasks: gt, ls: { "shared:nksync:auto": "0" } });
  await sleep(1500);
  const n0 = drive.log.length;
  await gtClickAndWait(P.page);
  c.ok(drive.log.length === n0, "Googleタスクの同期でDriveに触れない", drive.log.slice(n0));
  c.ok((await lsTasks(P.page)).items.some((x) => x.gtaskId === "G1b"), "Googleタスクとの同期そのものはする");
  await P.ctx.close();
}

// ── 2. 同じGoogleタスクに紐付いた写しは1つにまとまる ──
{
  console.log("2. normalize で gtaskId の重複をまとめる");
  const P = await openTasks({ token: null, ls: { "tasks:v1": { items: [
    task({ id: "tA", title: "古い写し", gtaskId: "GX", updatedAt: 1000 }),
    task({ id: "tB", title: "新しい写し", gtaskId: "GX", updatedAt: 2000 }),
    task({ id: "tD", title: "同時刻D", gtaskId: "GY", updatedAt: 500 }),
    task({ id: "tC", title: "同時刻C", gtaskId: "GY", updatedAt: 500 }),
    task({ id: "tE", title: "紐付けなし1" }), task({ id: "tF", title: "紐付けなし2" })
  ], deleted: [], gdel: [] } } });
  const tx = await listText(P.page);
  c.ok(tx.includes("新しい写し") && !tx.includes("古い写し"), "新しい方が残る", tx);
  c.ok(tx.includes("同時刻C") && !tx.includes("同時刻D"), "同じ時刻なら id の小さい方が残る（どの端末でも同じ）", tx);
  c.ok(tx.includes("紐付けなし1") && tx.includes("紐付けなし2"), "紐付けの無いタスクはそのまま");
  await P.ctx.close();
}

// ── 3. ほかの端末で消したタスクが、Googleタスク同期の紐付け外しで生き返らない ──
async function resurrection(pullFails) {
  const drive = createFakeDrive(), gt = createFakeTasks();
  const g2 = gt.add({ id: "G2", title: "消したはずのタスク" });
  const B = await openTasks({ drive, gtasks: gt, ls: { "tasks:v1": { items: [
    task({ id: "tx1", title: "消したはずのタスク", gtaskId: "G2", gtaskUpdated: g2.updated, gtSyncedAt: 5000, updatedAt: 5000, createdAt: 5000 })
  ], deleted: [], gdel: [] } } });
  await waitFor(() => { const d = driveTasks(drive); return d && d.items.some((x) => x.id === "tx1" && x.synced); }, { label: "最初の同期" });
  await sleep(300);
  // 端末Aで消した（Driveに墓標・Googleからも削除）ことにする
  const f = drive.byName("nikki-apps-data.json")[0];
  const doc = drive.json(f.id), now = Date.now();
  doc.apps.tasks = { items: doc.apps.tasks.items.filter((x) => x.id !== "tx1"), deleted: [{ id: "tx1", at: now }], gdel: [{ id: "G2", at: now }] };
  drive.write(f.id, doc);
  gt.tasks.delete("G2");
  if (pullFails) drive.expireAll();
  await gtClickAndWait(B.page);
  if (pullFails) drive.renew();
  if (!pullFails) c.ok(!(await lsTasks(B.page)).items.some((x) => x.id === "tx1"), "同期の前に取り込んだ墓標で、消したタスクはもう無い");
  await sleep(4500);   // 後のDrive同期
  await waitFor(() => B.page.evaluate(() => !/同期しています/.test(document.getElementById("syncMsg").textContent)), { label: "Drive同期の終わり" });
  const local = (await lsTasks(B.page)).items.some((x) => x.id === "tx1");
  const remote = driveTasks(drive).items.some((x) => x.id === "tx1");
  c.ok(!local && !remote, (pullFails ? "Driveが読めなかったときも" : "") + "消したタスクが生き返らない（端末・Driveとも無い）", { local, remote });
  c.ok(!gt.titles().includes("消したはずのタスク"), "Googleタスクにも送り直さない");
  await B.ctx.close();
}
console.log("3. 消したタスクが生き返らない");
await resurrection(false);
console.log("3b. Driveが読めないときの紐付け外し");
await resurrection(true);

// ── 4. Android: new Notification が使えないので SW から出す。登録が無ければ帯で知らせる ──
{
  console.log("4. Android の通知");
  const T0 = new Date("2026-10-12T10:00:10+09:00");
  const P = await openTasks({ token: null, notify: "android", clock: T0, ls: { "tasks:notify": "1", "tasks:v1": { items: [
    task({ id: "tn1", title: "鳴らすタスク", date: "2026-10-12", time: "10:01", note: "メモの1行目" }),
    task({ id: "tn2", title: "二つめ", date: "2026-10-12", time: "10:02" })
  ], deleted: [], gdel: [] } } });
  await P.page.clock.fastForward(70000);
  await sleep(300);
  let notes = await P.page.evaluate(() => window.__notes);
  const n1 = notes.find((n) => n.title === "⏰ 鳴らすタスク");
  c.ok(n1 && n1.via === "sw", "Service Worker の showNotification で出す", notes);
  c.ok(n1 && n1.opt.tag === "tasks-tn1" && /tasks\.html/.test((n1.opt.data || {}).url || "") && /今日 10:01/.test(n1.opt.body) && /メモの1行目/.test(n1.opt.body),
    "tag・本文・data.url（押したときに開く先）が付く", n1);
  await P.page.evaluate(() => { window.__noReg = true; });
  await P.page.clock.fastForward(60000);
  await sleep(300);
  notes = await P.page.evaluate(() => window.__notes);
  const toast = await P.page.textContent("#toast");
  c.ok(!notes.some((n) => n.title === "⏰ 二つめ") && /⏰ 二つめ/.test(toast), "SW の登録が無く new Notification も使えなければ、画面の帯で知らせる", { notes, toast });
  await P.ctx.close();
}

// ── 5. Drive同期で後から届いた、過去の時刻のタスクは鳴らさない ──
{
  console.log("5. 同期で届いた過去の予定をまとめて鳴らさない");
  const drive = createFakeDrive();
  drive.put("nikki-apps-data.json", { app: "nikki-sync", v: 1, apps: { tasks: { items: [
    task({ id: "told", title: "昔の予定", date: "2026-10-12", time: "08:00", synced: 1 })
  ], deleted: [], gdel: [] } } });
  const P = await openTasks({ drive, notify: "desktop", clock: new Date("2026-10-12T10:00:10+09:00"), ls: { "tasks:notify": "1", "tasks:v1": { items: [
    task({ id: "tsoon", title: "まもなく", date: "2026-10-12", time: "10:01" })
  ], deleted: [], gdel: [] } } });
  await waitFor(async () => (await listText(P.page)).includes("昔の予定"), { label: "Driveから届く" });
  await P.page.clock.fastForward(31000);
  await sleep(300);
  let notes = await P.page.evaluate(() => window.__notes);
  c.ok(!notes.some((n) => n.title === "⏰ 昔の予定"), "後から届いた2時間前の予定は鳴らさない", notes);
  await P.page.clock.fastForward(30000);
  await sleep(300);
  notes = await P.page.evaluate(() => window.__notes);
  const n = notes.find((x) => x.title === "⏰ まもなく");
  c.ok(n && n.via === "page", "時刻を迎えたものは鳴る（SW の登録が無ければ new Notification で）", notes);
  c.ok(notes.filter((x) => x.title === "⏰ まもなく").length === 1, "同じお知らせを二度鳴らさない");
  await P.ctx.close();
}

// ── 6. Googleタスクの同期が重ならない（同じタスクを2回POSTしない）──
{
  console.log("6. 同期の重なり");
  const drive = createFakeDrive(), gt = createFakeTasks();
  // 1本目の一覧が返る前に2本目のPOSTが出て、その返事より先に1本目の一覧が返るように遅らせる
  gt.hooks.listDelay = [2000];   // 1回目の一覧だけ遅い
  gt.hooks.postDelay = 3000;
  const P = await openTasks({ drive, gtasks: gt, clock: null, ls: { "tasks:gtaskAuto": "1" } });
  await waitFor(() => lastSync(P.page), { label: "最初のDrive同期" });
  await P.page.click("#bGt");                 // 1本目（一覧で待たされる）
  await P.page.fill("#nt", "重ねて送らないで");
  await P.page.press("#nt", "Enter");          // 保存 → 10秒後に自動送信
  await sleep(300);
  await P.page.clock.fastForward(10500);       // 1本目の最中に自動送信の時刻が来る
  await sleep(9000);
  await waitFor(() => P.page.evaluate(() => !document.getElementById("bGt").disabled), { timeout: 30000, label: "同期の終わり" });
  const n = gt.titles().filter((t) => t === "重ねて送らないで").length;
  c.ok(n === 1, "Googleタスクに1件だけ作られる", gt.titles());
  const it = (await lsTasks(P.page)).items.find((x) => x.title === "重ねて送らないで");
  c.ok(it && it.gtaskId && gt.tasks.has(it.gtaskId), "こちらのタスクはその1件に紐付く", it);
  const lists = gt.log.filter((l) => l.method === "GET" && /\/lists\/L1\/tasks$/.test(l.path)).length;
  c.ok(lists >= 2, "走行中に頼まれたぶんは、終わってからもう一度回る", lists);
  await P.ctx.close();
}

// ── 7. 気になり帳から #taskadd で受け取ったタスクも自動送信される ──
{
  console.log("7. #taskadd の自動送信");
  const drive = createFakeDrive(), gt = createFakeTasks();
  const hash = "#taskadd=" + encodeURIComponent(JSON.stringify({ title: "気になり帳から来たタスク", note: "メモ" }));
  const P = await openTasks({ drive, gtasks: gt, clock: null, hash, ls: { "tasks:gtaskAuto": "1" } });
  c.ok((await listText(P.page)).includes("気になり帳から来たタスク"), "受け取ったタスクが一覧に出る");
  await sleep(500);
  await P.page.clock.fastForward(10500);
  let sent = false;
  try { await waitFor(() => gt.titles().includes("気になり帳から来たタスク"), { timeout: 8000 }); sent = true; } catch (e) {}
  c.ok(sent, "10秒後にGoogleタスクへ送られる", gt.titles());
  c.ok(!(await P.page.evaluate(() => location.hash)), "#taskadd はURLから消える");
  await P.ctx.close();
}

// ── 8. Googleタスクで日付を変えたら、毎月の基準日も合わせる ──
{
  console.log("8. 毎月の基準日");
  const gt = createFakeTasks();
  gt.add({ id: "GM", title: "毎月の支払い", due: "2026-11-15T00:00:00.000Z", updated: "2026-10-05T00:00:00.000Z" });
  gt.add({ id: "GS", title: "日付そのまま", due: "2027-02-28T00:00:00.000Z", updated: "2026-10-05T00:00:00.000Z" });
  const P = await openTasks({ gtasks: gt, ls: { "tasks:v1": { items: [
    task({ id: "tm", title: "毎月の支払い", date: "2026-10-31", rep: "monthly", repDay: 31, gtaskId: "GM", gtaskUpdated: "2026-10-01T00:00:00.000Z", gtSyncedAt: 1000 }),
    task({ id: "ts", title: "日付そのまま", date: "2027-02-28", rep: "monthly", repDay: 31, gtaskId: "GS", gtaskUpdated: "2026-10-01T00:00:00.000Z", gtSyncedAt: 1000 })
  ], deleted: [], gdel: [] } } });
  await gtClickAndWait(P.page);
  const items = (await lsTasks(P.page)).items;
  const tm = items.find((x) => x.id === "tm"), ts = items.find((x) => x.id === "ts");
  c.ok(tm && tm.date === "2026-11-15" && tm.repDay === 15, "日付が変わったら基準日も 15 に", tm);
  c.ok(ts && ts.date === "2027-02-28" && ts.repDay === 31, "日付が同じなら基準日は変えない（31日→28日に丸めた月でも 31 のまま）", ts);
  await P.ctx.close();
}

// ── 9. 権限の足りないトークンで 403 → 取り直して一度だけやり直す ──
{
  console.log("9. 403 のやり直し");
  const gt = createFakeTasks();
  gt.add({ id: "G9", title: "権限のテスト" });
  const P = await openTasks({ gtasks: gt, token: AU + "drive.file" });   // Drive同期が取った狭いトークンが置いてある
  await gtClickAndWait(P.page);
  const toast = await P.page.textContent("#toast");
  c.ok(/Googleタスクと同期しました/.test(toast) && !/Cloud Console/.test(toast), "同期できる（Cloud Console の案内は出ない）", toast);
  const calls = await P.page.evaluate(() => (window.__fakeGisCalls || []).map((x) => ({ scope: x.scope, prompt: x.prompt })));
  c.ok(calls.some((x) => /\/auth\/tasks/.test(x.scope)), "タスクの権限を含めて取り直す", calls);
  c.ok((await lsTasks(P.page)).items.some((x) => x.gtaskId === "G9"), "取り込みまで済む");
  // 取り直しても 403（本当に設定が足りない）なら、Cloud Console の案内を出す
  const P2 = await openTasks({ gtasks: { handle: (r) => json(r, 403, { error: { code: 403 } }) }, token: GD_SCOPE });
  await gtClickAndWait(P2.page);
  const t2 = await P2.page.textContent("#toast");
  const n403 = (await P2.page.evaluate(() => (window.__fakeGisCalls || []).length));
  c.ok(/Cloud Console/.test(t2) && n403 === 1, "やり直しても403なら設定の案内（やり直しは一度だけ）", { t2, n403 });
  await P.ctx.close(); await P2.ctx.close();
}

// ── 10. カレンダー: 終日⇔時刻ありの切り替え・消された予定の作り直し ──
{
  console.log("10. カレンダーの更新");
  const cal = createFakeCal();
  cal.events.set("ev1", { id: "ev1", status: "confirmed", summary: "会議", start: { dateTime: "2026-10-20T10:00:00", timeZone: "Asia/Tokyo" }, end: { dateTime: "2026-10-20T11:00:00", timeZone: "Asia/Tokyo" } });
  cal.events.set("ev4", { id: "ev4", status: "confirmed", summary: "通院", description: "古い説明", start: { date: "2026-10-21" }, end: { date: "2026-10-22" } });
  cal.events.set("evC", { id: "evC", status: "cancelled", summary: "消した予定", start: { date: "2026-10-23" }, end: { date: "2026-10-24" } });
  cal.events.set("ev410", { id: "ev410", gone: true });
  const P = await openTasks({ cal, ls: { "tasks:v1": { items: [
    task({ id: "tc1", title: "会議", date: "2026-10-20", gcalEventId: "ev1" }),                  // 時刻あり → 終日
    task({ id: "tc4", title: "通院", date: "2026-10-21", time: "09:30", gcalEventId: "ev4" }),   // 終日 → 時刻あり（メモは消した）
    task({ id: "tcG", title: "消えた予定", date: "2026-10-22", gcalEventId: "evGone" }),          // 404
    task({ id: "tcC", title: "取り消した予定", date: "2026-10-23", gcalEventId: "evC" }),         // cancelled
    task({ id: "tc410", title: "410の予定", date: "2026-10-25", gcalEventId: "ev410" })           // 410
  ], deleted: [], gdel: [] } } });
  async function push(id) {
    const n0 = cal.log.length;
    await P.page.click(`[data-cal="${id}"]`);
    await waitFor(() => P.page.evaluate(() => /Googleカレンダーに登録しました|できませんでした|権限/.test(document.getElementById("toast").textContent)), { label: "カレンダー登録 " + id });
    await sleep(200);
    return { toast: await P.page.textContent("#toast"), reqs: cal.log.slice(n0) };
  }
  let r = await push("tc1");
  const p1 = r.reqs[0] && r.reqs[0].body;
  c.ok(p1 && p1.start.dateTime === null && p1.start.timeZone === null && p1.start.date === "2026-10-20", "終日にしたら dateTime・timeZone を null で送る", p1 && p1.start);
  const e1 = cal.events.get("ev1");
  c.ok(/登録しました/.test(r.toast) && e1.start.date === "2026-10-20" && !("dateTime" in e1.start), "カレンダー側が終日になる", { toast: r.toast, start: e1.start });
  r = await push("tc4");
  const e4 = cal.events.get("ev4");
  c.ok(/登録しました/.test(r.toast) && e4.start.dateTime === "2026-10-21T09:30:00" && !("date" in e4.start), "時刻ありに戻したら date を null で消す", { toast: r.toast, start: e4.start });
  c.ok(e4.description === "", "メモを消したら説明も消える", e4.description);
  for (const [id, label] of [["tcG", "404"], ["tcC", "cancelled"], ["tc410", "410"]]) {
    r = await push(id);
    const it = (await lsTasks(P.page)).items.find((x) => x.id === id);
    const ev = it && cal.events.get(it.gcalEventId);
    c.ok(/登録しました/.test(r.toast) && r.reqs.some((q) => q.method === "POST") && ev && ev.status === "confirmed" && /^new/.test(it.gcalEventId),
      `カレンダーで消されていた（${label}）予定は作り直して新しいidを覚える`, { toast: r.toast, id: it && it.gcalEventId });
  }
  await P.ctx.close();
}

// ── 11. 1週間より前に完了したGoogleタスクは取り込まない ──
{
  console.log("11. 古い完了の取り込み");
  const gt = createFakeTasks(), now = Date.now();
  gt.add({ id: "Gold", title: "昔の完了", status: "completed", completed: new Date(now - 10 * DAY).toISOString() });
  gt.add({ id: "Grec", title: "最近の完了", status: "completed", completed: new Date(now - 2 * DAY).toISOString() });
  gt.add({ id: "Gopen", title: "まだのタスク" });
  const P = await openTasks({ gtasks: gt });
  await gtClickAndWait(P.page);
  const titles = (await lsTasks(P.page)).items.map((x) => x.title);
  c.ok(!titles.includes("昔の完了"), "10日前の完了は取り込まない", titles);
  c.ok(titles.includes("最近の完了") && titles.includes("まだのタスク"), "2日前の完了と未完了は取り込む", titles);
  await P.ctx.close();
}

// ── 12. 開いたまま日付が変わったら描き直す ──
{
  console.log("12. 日付をまたぐ");
  const P = await openTasks({ token: null, clock: new Date("2026-10-11T23:59:00+09:00"), ls: { "tasks:v1": { items: [
    task({ id: "tt1", title: "明日の用事", date: "2026-10-12" })
  ], deleted: [], gdel: [] } } });
  c.ok((await heads(P.page)).includes("明日"), "（前提）23:59 には「明日」", await heads(P.page));
  await P.page.clock.fastForward(90000);
  await sleep(200);
  const h = await heads(P.page);
  c.ok(h.includes("今日") && !h.includes("明日"), "0時を過ぎたら30秒ごとの見回りで「今日」に描き直す", h);
  c.ok((await P.page.textContent("#cToday")) === "1", "「今日まで」の件数も描き直す", await P.page.textContent("#cToday"));
  // 寝ていた端末が翌々日に戻ってきた（タイマーは動かず、画面に戻ったときだけ）
  await P.page.clock.setSystemTime(new Date("2026-10-13T00:01:00+09:00"));
  await P.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await sleep(200);
  const h2 = await heads(P.page);
  c.ok(h2.includes("期限切れ"), "画面に戻ったときにも確かめる（期限切れになる）", h2);
  await P.ctx.close();
}

// ── 13. ほかのタブの保存を取り込む ──
{
  console.log("13. 2つのタブ");
  const T1 = await openTasks({ token: null, ls: { "tasks:v1": { items: [task({ id: "te1", title: "直しているタスク" })], deleted: [], gdel: [] } } });
  const T2 = await openTasks({ ctx: T1.ctx, token: null });
  await T2.page.click('[data-ed="te1"]');
  await T2.page.fill("#eTitle", "打ちかけの名前");
  await T1.page.fill("#nt", "タブ1で追加");
  await T1.page.press("#nt", "Enter");
  let seen = false;
  try { await waitFor(async () => (await listText(T2.page)).includes("タブ1で追加"), { timeout: 3000 }); seen = true; } catch (e) {}
  c.ok(seen, "ほかのタブで足したタスクが、こちらの一覧にも出る");
  c.ok((await T2.page.inputValue("#eTitle")) === "打ちかけの名前", "打ちかけの編集欄は消えない", await T2.page.inputValue("#eTitle").catch(() => null));
  await T2.page.fill("#nt", "タブ2で追加");
  await T2.page.press("#nt", "Enter");
  const titles = (await lsTasks(T1.page)).items.map((x) => x.title);
  c.ok(titles.includes("タブ1で追加") && titles.includes("タブ2で追加") && titles.includes("直しているタスク"), "あとから保存したタブが、相手の追加を消さない", titles);
  await sleep(300);
  c.ok((await listText(T1.page)).includes("タブ2で追加"), "逆向きにも届く");
  // 消したタスクは相手のタブからも消え、開いていた編集欄は閉じる
  T1.page.once("dialog", (d) => d.accept());
  await T1.page.click('[data-del="te1"]');
  await sleep(300);
  c.ok(!(await listText(T2.page)).includes("直しているタスク") && !(await T2.page.$("#eTitle")), "相手のタブで消したタスクの編集欄は閉じる");
  await T1.ctx.close();
}

// ── 12. 共通トークンに Googleタスクの権限が無ければ、権限つきで取り直す ──
{
  console.log("12. 権限の足りない共通トークンを使わない");
  const gt = createFakeTasks();
  gt.add({ id: "G9", title: "権限の検証" });
  // 音・暗室の同期で取った（tasks を含まない）トークンが、権限の記録つきで入っている
  const STD = [AU + "drive.file", AU + "drive.appdata", AU + "calendar.events"].join(" ");
  const P = await openTasks({ gtasks: gt, token: null, ls: { "shared:gd:token": { token: "fake." + Buffer.from(STD).toString("base64"), exp: Date.now() + 3600e3, scope: STD } } });
  await gtClickAndWait(P.page);
  const calls = await P.page.evaluate(() => window.__fakeGisCalls || []);
  const gotTasks = gt.log.some((x) => x.path.endsWith("/tasks"));
  c.ok(calls.length === 1 && calls[0].scope.includes(AU + "tasks"), "tasks の権限つきで1回だけ取り直す", calls.map((x) => x.scope));
  c.ok(gotTasks && (await listText(P.page)).includes("権限の検証"), "取り直したトークンで Googleタスクとやりとりできる");
  await P.ctx.close();
}

const pageErrs = allErrs.flat().filter((e) => !/Failed to load resource/.test(e));
c.ok(pageErrs.length === 0, "ページの例外・エラーが無い", pageErrs);
await br.close();
await srv.close();
c.done();
