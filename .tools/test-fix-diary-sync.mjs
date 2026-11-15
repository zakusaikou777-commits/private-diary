/* ============================================================
   日記帳（diary.html）: 保存したら送る・開いたら取り込む（v49）の確認
     node .tools/test-fix-diary-sync.mjs                    … 全部
     ONLY=s1,s4 node .tools/test-fix-diary-sync.mjs         … 項目を選ぶ（下の記号）
     DIARY_ROOT=/別の場所 node .tools/test-fix-diary-sync.mjs … その場所の diary.html で試す（修正前との比べ用）

   s1 自動同期は入口と同じスイッチ（はじめはON）。一度つなげば、保存しただけで Drive へ送る
   s2 開いたら取り込む: 開き直し・アプリに戻る（visibilitychange）・入口でタブに戻る（nkShown）。間隔は30秒
   s3 ログインが切れているとき: 保存しても送れない印が残り、☁に「未送信あり」。日記を開く・💾保存を押すと
      その場でつなぎ直して送る。押していないとき（開いただけ・戻っただけ・自動保存）はログイン画面を出さない
   s4 つなぎ直しを閉じられたら、このページでは自分からはもう出さない。☁を押せば出す
   s5 一度もつないでいない端末・ほかのアプリでつないだだけの端末・自動同期OFF では何もしない（☁も出さない）。ONに戻したらすぐ同期
   s6 今日を書く: ほかの端末で書いた今日の日記は、取り込んでからそれを開く（2件にしない・区切りを入れない）
   s7 入口（index.html）の中: タブに戻ると取り込む。送れていない日記は入口の☁にも出る
   ============================================================ */
import { startServer, launch, newDevice, collectErrors, makeChecker, sleep, waitFor, ROOT } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const only = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const want = (k) => !only.length || only.includes(String(k));
const srv = await startServer(process.env.DIARY_ROOT || ROOT);
const browser = await launch();
const { ok, done } = makeChecker("test-fix-diary-sync");
const pageErrors = [];
const PC = { viewport: { width: 1400, height: 900 } };

/* ── 道具 ─────────────────────────────────────────── */
async function open(ctx, path = "diary.html") {
  const page = await ctx.newPage();
  page.errs = collectErrors(page);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.setDefaultTimeout(8000);
  await page.goto(srv.url + path);
  if (path === "diary.html") {
    await page.waitForFunction(() => typeof storageReady !== "undefined" && storageReady === true
      && document.getElementById("calendarDays").children.length > 0 && !!(window.google && google.accounts && google.accounts.oauth2));
    await sleep(150);
  }
  return page;
}
async function section(name, fn) {
  try { await fn(); } catch (e) { ok(false, name + ": 例外で止まった", String(e && e.message || e).slice(0, 300)); }
}
function driveDiary(drive) {
  const f = drive.byName("diary.json")[0];
  return f ? drive.json(f.id) : null;
}
const onDrive = (drive, pred) => { const d = driveDiary(drive); return !!(d && Array.isArray(d.entries) && d.entries.some(pred)); };
async function waitDrive(drive, pred, ms = 8000) {
  try { await waitFor(() => onDrive(drive, pred), { timeout: ms }); return true; } catch (e) { return false; }
}
async function waitPage(page, fn, arg, ms = 8000) {
  try { await waitFor(() => page.evaluate(fn, arg), { timeout: ms }); return true; } catch (e) { return false; }
}
/** はじめてつなぐ（設定の「Driveへ保存」と同じ。ログイン画面は偽物がすぐ返す） */
async function connect(page) {
  await page.evaluate(() => drivePushAll(false));
  await page.evaluate(() => { drivePushLastAt = 0; drivePullLastAt = 0; });   // 次の自動の送信・取り込みを待たせない
}
/** 時間が経った（自動の送信のまとめ待ち・開いたときの間隔）ことにする */
const timePassed = (page) => page.evaluate(() => { drivePushLastAt = 0; drivePullLastAt = 0; });
const expireToken = (page) => page.evaluate(() => {
  const o = JSON.parse(localStorage.getItem("shared:gd:token") || "null");
  if (o) { o.exp = Date.now() - 1000; localStorage.setItem("shared:gd:token", JSON.stringify(o)); }
});
const gisCalls = (page) => page.evaluate(() => (window.__fakeGisCalls || []).length);
const chip = (page) => page.evaluate(() => { const c = document.getElementById("driveChip"); return c ? { hidden: c.hidden, text: c.textContent, cls: c.className } : null; });
/** 今日の日記を開いて本文に打つ（自動保存まで待つ） */
async function typeToday(page, text) {
  await page.click("#writeTodayBtn");
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === "contentEditor");
  await page.keyboard.type(text);
  await page.waitForFunction(() => !isDirty, null, { timeout: 5000 });
}
/** 日記を1件足す（画面からではなく） */
async function addEntry(page, date, title, html) {
  return page.evaluate(async ([date, title, html]) => {
    const e = { id: genId(), date, title, content: html, contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    entries.push(e);
    await saveEntriesToStorage();
    loadEntry(e);
    await saveEntry(true);
    return e.id;
  }, [date, title, html]);
}
const hasEntry = (page, title) => page.evaluate((t) => entries.some((e) => e.title === t || String(e.content || "").includes(t)), title);
/** 押していないときの呼び出し（Playwright の evaluate は「押した直後」扱いになるので、その印を消して呼ぶ） */
async function withoutTap(page, fn) {
  await page.evaluate(() => Object.defineProperty(navigator, "userActivation", { configurable: true, get: () => ({ isActive: false, hasBeenActive: true }) }));
  try { return await page.evaluate(fn); } finally { await page.evaluate(() => { delete navigator.userActivation; }); }
}
/** 見えているページ（スマホでアプリに戻った）ことにする */
const comeBack = (page) => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
});

/* ── s1 保存しただけで Drive へ送る ─────────────────── */
if (want("s1")) await section("s1", async () => {
  console.log("s1) 自動同期は入口と同じスイッチ（はじめはON）。保存しただけで送る");
  const drive = createFakeDrive();
  const ctx = await newDevice(browser, { drive, contextOptions: PC });
  const A = await open(ctx);
  ok(await A.evaluate(() => localStorage.getItem("shared:nksync:auto") === null && autoSyncDriveEnabled === true), "s1: 何も設定していなければ自動同期はON（入口の☁と同じ）");
  ok((await chip(A)).hidden, "s1: 一度もつないでいなければ☁は出さない");
  await connect(A);
  const c1 = await chip(A);
  ok(c1 && !c1.hidden && /同期済み/.test(c1.text), "s1: つないだら☁に「同期済み」", c1);
  await typeToday(A, "保存しただけで送る");
  ok(await waitDrive(drive, (e) => /保存しただけで送る/.test(e.content)), "s1: 打って自動保存されたら、ボタンを押さなくても Drive に届く");
  ok(await waitPage(A, () => !localStorage.getItem("diary:gd:pending")), "s1: 送れたら「未送信」の印は消える");
  const c2 = await chip(A);
  ok(c2 && /同期済み/.test(c2.text), "s1: ☁は「同期済み」に戻る", c2);
  // 削除も送る
  await timePassed(A);
  const id = await addEntry(A, "2026-03-03", "消す日記", "<p>x</p>");
  ok(await waitDrive(drive, (e) => e.id === id), "s1: 足した日記も届く");
  await timePassed(A);
  await A.evaluate(() => deleteEntry());
  try { await waitFor(() => { const d = driveDiary(drive); return d && !d.entries.some((e) => e.id === id) && (d.deleted || []).some((t) => t.id === id); }, { timeout: 8000 }); ok(true, "s1: 削除も自動で届く（墓標つき）"); }
  catch (e) { ok(false, "s1: 削除も自動で届く（墓標つき）", driveDiary(drive)); }
  ok(A.errs.length === 0, "s1: エラーなし", A.errs);
  await ctx.close();
});

/* ── s2 開いたら取り込む ─────────────────────────────── */
if (want("s2")) await section("s2", async () => {
  console.log("s2) 開き直し・アプリに戻る・入口でタブに戻ると取り込む");
  const drive = createFakeDrive();
  const ctxA = await newDevice(browser, { drive, contextOptions: PC });
  const ctxB = await newDevice(browser, { drive, contextOptions: PC });
  const A = await open(ctxA);
  await connect(A);
  await addEntry(A, "2026-04-01", "Aの1件目", "<p>one</p>");
  ok(await waitDrive(drive, (e) => e.title === "Aの1件目"), "s2 準備: A の日記が Drive にある");
  let B = await open(ctxB);
  await connect(B);
  ok(await hasEntry(B, "Aの1件目"), "s2 準備: B もつないだ");
  // A がもう1件書く → B を開き直すと、押さなくても入っている
  await timePassed(A);
  await addEntry(A, "2026-04-02", "Aの2件目", "<p>two</p>");
  ok(await waitDrive(drive, (e) => e.title === "Aの2件目"), "s2: A の2件目が Drive に届く");
  await B.close();
  B = await open(ctxB);
  ok(await waitPage(B, () => entries.some((e) => e.title === "Aの2件目")), "s2: B で日記帳を開き直すと、取り込まれている");
  const calls0 = await gisCalls(B);
  // A がさらに書く → B がアプリに戻ると取り込む（30秒以内の繰り返しはしない）
  await timePassed(A);
  await addEntry(A, "2026-04-03", "Aの3件目", "<p>three</p>");
  ok(await waitDrive(drive, (e) => e.title === "Aの3件目"), "s2: A の3件目が Drive に届く");
  const getsBefore = drive.log.length;
  await comeBack(B);
  await sleep(600);
  ok(!(await hasEntry(B, "Aの3件目")) && drive.log.length === getsBefore, "s2: 開いたばかりなら（30秒以内）、戻っただけでは取りに行かない");
  await B.evaluate(() => { drivePullLastAt = Date.now() - 31000; });
  await comeBack(B);
  ok(await waitPage(B, () => entries.some((e) => e.title === "Aの3件目")), "s2: 30秒たって戻ると、取り込む");
  // 入口でタブに戻った知らせ（nkShown）
  await timePassed(A);
  await addEntry(A, "2026-04-04", "Aの4件目", "<p>four</p>");
  ok(await waitDrive(drive, (e) => e.title === "Aの4件目"), "s2: A の4件目が Drive に届く");
  await B.evaluate(() => { drivePullLastAt = 0; window.postMessage({ nkShown: true }, location.origin); });
  ok(await waitPage(B, () => entries.some((e) => e.title === "Aの4件目")), "s2: 入口でタブに戻った知らせで、取り込む");
  // ほかのオリジンからの知らせは受けない
  await timePassed(A);
  await addEntry(A, "2026-04-05", "Aの5件目", "<p>five</p>");
  ok(await waitDrive(drive, (e) => e.title === "Aの5件目"), "s2: A の5件目が Drive に届く");
  await B.evaluate(() => { drivePullLastAt = 0; window.dispatchEvent(new MessageEvent("message", { data: { nkShown: true }, origin: "https://evil.example" })); });
  await sleep(600);
  ok(!(await hasEntry(B, "Aの5件目")), "s2: ほかのオリジンからの知らせでは動かない");
  ok((await gisCalls(B)) === calls0, "s2: 開いた・戻っただけではログイン画面を出さない");
  ok(A.errs.length === 0 && B.errs.length === 0, "s2: エラーなし", [...A.errs, ...B.errs]);
  await ctxA.close(); await ctxB.close();
});

/* ── s3 ログインが切れているとき ─────────────────────── */
if (want("s3")) await section("s3", async () => {
  console.log("s3) ログインが切れていたら、日記を開く・保存を押したときにつなぎ直して送る");
  const drive = createFakeDrive();
  const ctx = await newDevice(browser, { drive, contextOptions: PC });
  let A = await open(ctx);
  await connect(A);
  await addEntry(A, "2026-05-01", "前の日", "<p>old</p>");
  ok(await waitDrive(drive, (e) => e.title === "前の日"), "s3 準備: つながっている");
  await expireToken(A);
  await A.evaluate(() => paintDriveChip());
  const calls0 = await gisCalls(A);
  await timePassed(A);
  // 押さずに今日の日記を開いて打つ（「今日を書く」を押すと、その場でつなぎ直す）
  await withoutTap(A, () => writeToday());
  await A.waitForFunction(() => document.activeElement && document.activeElement.id === "contentEditor");
  await A.keyboard.type("切れている間に書いた");
  await A.waitForFunction(() => !isDirty, null, { timeout: 5000 });
  await sleep(800);
  ok(!onDrive(drive, (e) => /切れている間に書いた/.test(e.content)) && (await gisCalls(A)) === calls0, "s3: ログインが切れていると、自動保存では送れない（ログイン画面も出さない）");
  ok(await A.evaluate(() => !!localStorage.getItem("diary:gd:pending")), "s3: 送れていない印が残る");
  const c1 = await chip(A);
  ok(c1 && /未送信あり/.test(c1.text) && /need/.test(c1.cls), "s3: ☁に「未送信あり（押して同期）」", c1);
  // 開き直しても、押すまではログイン画面を出さない
  await A.close();
  A = await open(ctx);
  await sleep(500);
  ok((await gisCalls(A)) === 0, "s3: 開き直しただけではログイン画面を出さない");
  ok(/未送信あり/.test((await chip(A)).text), "s3: 開き直しても☁は「未送信あり」");
  // 押した直後でないとき（ロック解除の計算を待ったあとなど）は頼まない。頼んで止められて「断られた」扱いにもしない
  await withoutTap(A, () => selectDate("2026-05-01"));
  await sleep(400);
  ok((await gisCalls(A)) === 0 && (await A.evaluate(() => driveAskDeclined === false)), "s3: 押した直後でなければ、日記を開いてもログイン画面を頼まない（断られた扱いにもしない）");
  // 日記を開く（カレンダーで前の日を押す）→ その場でつなぎ直して送る
  await A.evaluate(() => { currentYear = 2026; currentMonth = 4; renderCalendar(); });
  await A.click('#calendarDays button[onclick="selectDate(\'2026-05-01\')"]');
  ok(await waitDrive(drive, (e) => /切れている間に書いた/.test(e.content)), "s3: 日記を開いたら、つなぎ直して送った");
  const calls = await A.evaluate(() => window.__fakeGisCalls || []);
  ok(calls.length === 1 && calls[0].activation, "s3: ログイン画面は押した直後に1回だけ", calls);
  ok(await waitPage(A, () => !localStorage.getItem("diary:gd:pending")), "s3: 送れたら印は消える");
  ok(/同期済み/.test((await chip(A)).text), "s3: ☁は「同期済み」", await chip(A));
  // 💾保存 を押したときも
  await expireToken(A);
  await A.evaluate(() => { document.getElementById("contentEditor").insertAdjacentHTML("beforeend", "<p>保存ボタンで送る</p>"); syncEditorContent(); markDirty(); });
  await A.click('button[onclick="saveEntry()"]');
  ok(await waitDrive(drive, (e) => /保存ボタンで送る/.test(e.content)), "s3: 💾保存を押したら、つなぎ直して送った");
  const calls2 = await A.evaluate(() => window.__fakeGisCalls || []);
  ok(calls2.length === 2 && calls2[1].activation, "s3: 保存のときもログイン画面は押した直後に1回だけ", calls2.length);
  // つながっている間は、日記を開いてもログイン画面を出さない
  await A.click('#calendarDays button[onclick="selectDate(\'2026-05-01\')"]');
  await sleep(400);
  ok((await gisCalls(A)) === 2, "s3: つながっている間は、開いてもログイン画面を出さない");
  ok(A.errs.length === 0, "s3: エラーなし", A.errs);
  await ctx.close();
});

/* ── s4 つなぎ直しを閉じられたら ─────────────────────── */
if (want("s4")) await section("s4", async () => {
  console.log("s4) つなぎ直しを閉じられたら自分からは出さない。☁を押せば出す");
  const drive = createFakeDrive();
  const ctx = await newDevice(browser, { drive, contextOptions: PC });
  const A = await open(ctx);
  await connect(A);
  await addEntry(A, "2026-06-01", "六月", "<p>june</p>");
  await addEntry(A, "2026-06-02", "六月2", "<p>june2</p>");
  ok(await waitDrive(drive, (e) => e.title === "六月2"), "s4 準備: つながっている");
  await expireToken(A);
  const base = await gisCalls(A);
  await A.evaluate(() => { window.__fakeGis = { mode: "cancel" }; currentYear = 2026; currentMonth = 5; renderCalendar(); });
  await A.click('#calendarDays button[onclick="selectDate(\'2026-06-01\')"]');
  await sleep(500);
  ok((await gisCalls(A)) === base + 1, "s4: 1回目は出す");
  await A.click('#calendarDays button[onclick="selectDate(\'2026-06-02\')"]');
  await sleep(500);
  ok((await gisCalls(A)) === base + 1, "s4: 閉じられたら、次に日記を開いても出さない");
  const c = await chip(A);
  ok(c && !c.hidden && /need/.test(c.cls), "s4: ☁は「押して同期」のまま", c);
  await A.evaluate(() => { window.__fakeGis = { mode: "ok" }; document.getElementById("contentEditor").insertAdjacentHTML("beforeend", "<p>☁で送る</p>"); syncEditorContent(); markDirty(); });
  await A.evaluate(() => saveEntry(true));
  await A.click("#driveChip");
  ok(await waitDrive(drive, (e) => /☁で送る/.test(e.content)), "s4: ☁を押すと、つなぎ直して送る");
  ok((await gisCalls(A)) === base + 2, "s4: ☁を押したときはログイン画面を出す");
  ok(await waitPage(A, () => /同期済み/.test(document.getElementById("driveChip").textContent)), "s4: ☁は「同期済み」");
  ok(A.errs.length === 0, "s4: エラーなし", A.errs);
  await ctx.close();
});

/* ── s5 つないでいない・OFF ─────────────────────────── */
if (want("s5")) await section("s5", async () => {
  console.log("s5) 一度もつないでいない端末・自動同期OFF");
  const drive = createFakeDrive();
  const ctx = await newDevice(browser, { drive, contextOptions: PC });
  const A = await open(ctx);
  await typeToday(A, "つないでいない端末");
  await sleep(500);
  ok((await gisCalls(A)) === 0 && !driveDiary(drive), "s5: 一度もつないでいなければ、書いても開いてもログイン画面を出さない・送らない");
  ok((await chip(A)).hidden, "s5: ☁は出さない");
  // ほかのアプリ（タスクなど）のために Google につないだだけでは、日記は送らない（日記帳を一度同期してから）
  await A.evaluate(() => NKSync.drive.getToken({}));
  await A.evaluate(() => { drivePushLastAt = 0; document.getElementById("contentEditor").insertAdjacentHTML("beforeend", "<p>ほかのアプリでつないだ</p>"); syncEditorContent(); markDirty(); return saveEntry(true); });
  await sleep(800);
  ok(!driveDiary(drive) && (await chip(A)).hidden, "s5: ほかのアプリでつないだだけでは、日記を Drive へ送らない（☁も出さない）");
  // 日記帳を一度同期したら（設定の「Driveへ保存」・入口の「今すぐ全部同期」）、そこから自動
  await connect(A);
  ok(await waitDrive(drive, (e) => /つないでいない端末/.test(e.content)), "s5: つないだら送れる");
  const other = await ctx.newPage();
  await other.goto(srv.url + "version.js");
  await other.evaluate(() => localStorage.setItem("shared:nksync:auto", "0"));
  ok(await waitPage(A, () => autoSyncDriveEnabled === false && document.getElementById("driveChip").hidden), "s5: 入口でOFFにしたら、日記帳もOFF（☁を隠す）");
  await timePassed(A);
  await A.evaluate(() => { document.getElementById("contentEditor").insertAdjacentHTML("beforeend", "<p>OFFの間</p>"); syncEditorContent(); markDirty(); });
  await A.evaluate(() => saveEntry(true));
  await sleep(800);
  ok(!onDrive(drive, (e) => /OFFの間/.test(e.content)), "s5: OFFの間は送らない");
  await other.evaluate(() => localStorage.setItem("shared:nksync:auto", "1"));
  ok(await waitDrive(drive, (e) => /OFFの間/.test(e.content)), "s5: ONに戻したら、すぐに送る");
  // 日記帳の設定のスイッチも同じもの
  await A.evaluate(() => { const cb = document.getElementById("autoSyncDrive"); cb.checked = false; toggleAutoSyncDrive(); });
  ok(await A.evaluate(() => localStorage.getItem("shared:nksync:auto") === "0"), "s5: 日記帳の設定でOFFにすると、入口のスイッチもOFF");
  await A.evaluate(() => { const cb = document.getElementById("autoSyncDrive"); cb.checked = true; toggleAutoSyncDrive(); });
  ok(await A.evaluate(() => localStorage.getItem("shared:nksync:auto") === "1"), "s5: ONに戻すと入口もON");
  ok(A.errs.length === 0, "s5: エラーなし", A.errs);
  await ctx.close();
});

/* ── s6 今日を書く: ほかの端末の今日の日記 ──────────────── */
if (want("s6")) await section("s6", async () => {
  console.log("s6) 今日を書く: ほかの端末で書いた今日の日記を開く（2件にしない）");
  const drive = createFakeDrive();
  const ctxA = await newDevice(browser, { drive, contextOptions: PC });
  const ctxB = await newDevice(browser, { drive, contextOptions: PC });
  const A = await open(ctxA);
  await connect(A);
  await addEntry(A, "2026-07-01", "前から", "<p>x</p>");
  const B = await open(ctxB);
  await connect(B);
  const today = await B.evaluate(() => localDateStr());
  await typeToday(B, "Bで書いた今日");
  await B.evaluate(() => { currentEntry.title = "Bの題名"; return saveEntry(true); });
  await timePassed(B);
  await B.evaluate(() => drivePushRun(true));
  ok(await waitDrive(drive, (e) => e.date === today && /Bで書いた今日/.test(e.content)), "s6 準備: B の今日の日記が Drive にある");
  // A はまだ取り込んでいない（30秒以内）。今日を書くを押すと、取り込んでからそれを開く
  await A.evaluate(() => { drivePullLastAt = Date.now() - 31000; });
  await A.click("#writeTodayBtn");
  ok(await waitPage(A, () => currentEntry && /Bで書いた今日/.test(document.getElementById("contentEditor").innerText)), "s6: A で今日を書くと、B で書いた今日の日記が開く");
  const st = await A.evaluate((d) => ({ n: entries.filter((e) => e.date === d).length, title: currentEntry && currentEntry.title, html: currentEntry && currentEntry.content }), today);
  ok(st.n === 1 && st.title === "Bの題名" && !/統合/.test(st.html), "s6: 1件だけ・題名は B のまま・区切りは入らない", st);
  // 先に空の「今日の出来事」を作ってしまっていても、届いた日記と混ぜるときに区切りを入れない
  const merged = await A.evaluate(() => {
    const now = Date.now();
    const blank = { id: "blank1", date: "2026-08-08", title: DEFAULT_ENTRY_TITLE, content: "<p><br></p>", contentFormat: "html", tags: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    const remote = { id: "r1", date: "2026-08-08", title: "向こうの題名", content: "<p>向こうで書いた</p>", contentFormat: "html", tags: ["旅"], createdAt: new Date(now - 60000).toISOString(), updatedAt: new Date(now - 60000).toISOString() };
    const r = dedupeEntriesByDate([blank, remote]).entries;
    return r.map((e) => ({ title: e.title, content: e.content, tags: e.tags }));
  });
  ok(merged.length === 1 && merged[0].content === "<p>向こうで書いた</p>" && merged[0].title === "向こうの題名" && merged[0].tags.includes("旅"), "s6: 空の「今日の出来事」と届いた日記は、区切りなしで1件に（題名も向こうのもの）", merged);
  // 両方に中身があるときは、今までどおり区切って両方残す
  const both = await A.evaluate(() => {
    const now = Date.now();
    const a = { id: "a1", date: "2026-08-09", title: "こちら", content: "<p>こちらの文</p>", contentFormat: "html", tags: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    const b = { id: "b1", date: "2026-08-09", title: "あちら", content: "<p>あちらの文</p>", contentFormat: "html", tags: [], createdAt: new Date(now - 60000).toISOString(), updatedAt: new Date(now - 60000).toISOString() };
    return dedupeEntriesByDate([a, b]).entries.map((e) => e.content);
  });
  ok(both.length === 1 && /こちらの文/.test(both[0]) && /あちらの文/.test(both[0]), "s6: 両方に中身があれば、両方残す（今までどおり）", both);
  ok(A.errs.length === 0 && B.errs.length === 0, "s6: エラーなし", [...A.errs, ...B.errs]);
  await ctxA.close(); await ctxB.close();
});

/* ── s7 入口の中 ─────────────────────────────────────── */
if (want("s7")) await section("s7", async () => {
  console.log("s7) 入口（index.html）の中: タブに戻ると取り込む・送れていない日記は☁にも出る");
  const drive = createFakeDrive();
  const ctxA = await newDevice(browser, { drive, contextOptions: PC });
  const ctxB = await newDevice(browser, { drive, contextOptions: PC });
  const A = await open(ctxA);
  await connect(A);
  await addEntry(A, "2026-09-01", "A九月", "<p>a</p>");
  ok(await waitDrive(drive, (e) => e.title === "A九月"), "s7 準備: A の日記が Drive にある");
  const S = await open(ctxB, "index.html");
  const frame = () => S.frames().find((f) => { try { return new URL(f.url()).pathname.endsWith("/diary.html"); } catch (e) { return false; } });
  await waitFor(() => { const f = frame(); return f && f.evaluate(() => typeof storageReady !== "undefined" && storageReady === true && !!(window.google && google.accounts && google.accounts.oauth2)).catch(() => false); }, { timeout: 15000, label: "日記帳のタブ" });
  const F = frame();
  await F.evaluate(() => drivePushAll(false));
  ok(await F.evaluate(() => entries.some((e) => e.title === "A九月")), "s7 準備: 入口の中の日記帳もつないだ");
  await timePassed(A);
  await addEntry(A, "2026-09-02", "A九月2", "<p>b</p>");
  ok(await waitDrive(drive, (e) => e.title === "A九月2"), "s7: A の2件目が Drive に届く");
  await F.evaluate(() => { drivePullLastAt = 0; });
  await S.click('.apptab[data-app="tasks"]');
  await sleep(300);
  await S.click('.apptab[data-app="diary"]');
  ok(await waitPage(F, () => entries.some((e) => e.title === "A九月2")), "s7: 入口で日記帳のタブに戻ると、取り込む");
  // ログインが切れたまま書いた日記は、入口の☁にも「未送信」と出る
  await expireToken(F);
  await F.evaluate(() => { localStorage.setItem("diary:gd:pending", String(Date.now())); paintDriveChip(); });
  await S.click("#knBackupBtn");
  let st = "";
  try { await waitFor(async () => /未送信/.test(st = await S.textContent("#knStatus")), { timeout: 5000 }); } catch (e) {}
  ok(/未送信/.test(st), "s7: 入口の☁に「未送信の日記があります」", st);
  ok(S.errs.length === 0, "s7: エラーなし", S.errs);
  await ctxA.close(); await ctxB.close();
});

ok(pageErrors.length === 0, "ページの例外なし", pageErrors);
await browser.close();
await srv.close();
done();
