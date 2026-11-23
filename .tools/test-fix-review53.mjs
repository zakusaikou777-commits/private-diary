/* ============================================================
   全体の見直し（v53）で直したところの確認
     node .tools/test-fix-review53.mjs              … 全部
     node .tools/test-fix-review53.mjs r1 r5        … 名前に含む節だけ
     REVIEW_ROOT=/別の場所 node .tools/test-fix-review53.mjs … その場所の版で試す（修正前との比べ用）

   r1 タスク: 並べ替えても、ほかの端末での完了・削除を上書きしない（並びは並べた時刻で別にマージ）
   r2 気になり帳: 並べ替えても、ほかの端末での編集・削除を上書きしない
   r3 タスク・暗室・音・くつろぎ: ログインが切れていても、開いただけではログイン画面を頼まない。押すとつなぎ直す
   r4 タスク: Googleタスクへの自動送信も、ログインが切れていたら頼まずに待つ
   r5 日記帳: 新しい添付が送れなくても、本文は送る（☁「添付の送信待ち」・次に送り直す）
   r6 日記帳: 入口の中で、暗号化された Drive を「日記: Driveから読み込み」で読める（行き止まりにしない）。失敗は入口の☁にも出る
   r7 日記帳: 暗号化を解除したとき、Drive をこの端末の分だけで作り直さない（ほかの端末の日記が残る）
   r8 日記帳: Drive の日記がこの版より新しい形なら、読み込みも送信もしない
   r9 日記帳: 共有の画面を出せなかったときは「共有する」で出し直し、それまで「バックアップ済み」にしない
   r10 気になり帳: バックアップから戻したメモが、次の同期で消えない
   r11 気になり帳: 消えたフォルダを指すメモは「フォルダなし」に出る
   r12 気になり帳: リンクから足したメモは「取り消す」で消せる（番号つきのクリップは今までどおり）
   r13 気になり帳: 本文の消毒を覚えておく（読み直しが速い）。ノート表示で書きはじめたページは入れ替わらない
   r14 タスク: 完了から半年たったタスクを片付ける（削除の記録・Googleタスクの消去予約つき）
   r15 くつろぎ: 保存できなかったら知らせる
   r16 音: ラジオの追加をすぐ同期する。入口: 集中タイマーを読み込み直しても続ける
   ============================================================ */
import path from "node:path";
import { ROOT, startServer, launch, newDevice, collectErrors, makeChecker, sleep, waitFor } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const SERVE_ROOT = process.env.REVIEW_ROOT ? path.resolve(process.env.REVIEW_ROOT) : ROOT;
const ONLY = process.argv.slice(2);
const { ok, done } = makeChecker("test-fix-review53");
const server = await startServer(SERVE_ROOT);
const BASE = server.url;
const browser = await launch();
const PC = { viewport: { width: 1400, height: 900 } };
const GD_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.events";
const TASKS_SCOPE = GD_SCOPE + " https://www.googleapis.com/auth/tasks";
const tokenLS = (scope = GD_SCOPE, ms = 3600e3) => JSON.stringify({ token: "fake." + Buffer.from(scope).toString("base64"), exp: Date.now() + ms, scope });
const allErrs = [];

/* ── 道具 ─────────────────────────────────────────── */
async function device(opts = {}) {
  const ctx = await newDevice(browser, { drive: opts.drive || null, contextOptions: opts.contextOptions || PC });
  await ctx.route(/\/__blank\.html$/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
  return ctx;
}
async function preset(ctx, values) {
  const p = await ctx.newPage();
  await p.goto(BASE + "__blank.html");
  await p.evaluate((o) => { for (const k in o) { if (o[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, typeof o[k] === "string" ? o[k] : JSON.stringify(o[k])); } }, values);
  await p.close();
}
async function openPage(ctx, file, waitSel) {
  const page = await ctx.newPage();
  page.errs = collectErrors(page);
  allErrs.push(page.errs);
  page.dialogs = [];
  page.answers = [];
  page.on("dialog", async (d) => {
    page.dialogs.push({ type: d.type(), msg: d.message() });
    const a = page.answers.length ? page.answers.shift() : (d.type() === "prompt" ? null : true);
    try { if (a === null || a === false) await d.dismiss(); else await d.accept(typeof a === "string" ? a : undefined); } catch (e) {}
  });
  await page.goto(BASE + file);
  if (waitSel) await page.waitForSelector(waitSel, { timeout: 15000 });
  return page;
}
async function openDiary(ctx) {
  const page = await openPage(ctx, "diary.html");
  await page.waitForFunction(() => typeof storageReady !== "undefined" && storageReady === true
    && document.getElementById("calendarDays").children.length > 0 && !!(window.google && google.accounts && google.accounts.oauth2));
  await sleep(150);
  return page;
}
async function section(name, fn) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
  console.log("\n■ " + name);
  try { await fn(); } catch (e) { ok(false, name + " が途中で止まった", String(e && e.stack || e).split("\n").slice(0, 3).join(" | ")); }
}
async function until(fn, ms = 10000) { try { await waitFor(fn, { timeout: ms }); return true; } catch (e) { return false; } }
const gisCalls = (page) => page.evaluate(() => (window.__fakeGisCalls || []).map((c) => ({ act: c.activation, frame: c.frame })));
const appsDoc = (drive) => { const f = drive.byName("nikki-apps-data.json")[0]; return f ? drive.json(f.id) : null; };
const task = (o) => ({ note: "", date: "", time: "", rep: "", done: false, doneAt: 0, gcalEventId: "", createdAt: 1000, updatedAt: 1000, ...o });
const lsJSON = (page, k) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), k);

/* ── r1 タスクの並べ替え ───────────────────────────── */
await section("r1 タスク: 並べ替えがほかの端末の完了・削除を上書きしない", async () => {
  const drive = createFakeDrive();
  const ctx = await device({ drive });
  await preset(ctx, { "shared:gd:cid": "test-client", "shared:gd:token": tokenLS(TASKS_SCOPE),
    "tasks:v1": { items: [task({ id: "t1", title: "払う" }), task({ id: "t2", title: "買う" }), task({ id: "t3", title: "読む" })], deleted: [], gdel: [] } });
  const A = await openPage(ctx, "tasks.html", "#list");
  ok(await until(() => { const d = appsDoc(drive); return d && d.apps.tasks && d.apps.tasks.items.length === 3 && d.apps.tasks.items.every((x) => x.synced); }), "準備: 3件を Drive に載せた");
  await sleep(500);
  // ほかの端末（スマホ）が、t1 を完了・t2 を削除して Drive へ送った（この端末はまだ取り込んでいない）
  const f = drive.byName("nikki-apps-data.json")[0], doc = drive.json(f.id), now = Date.now();
  doc.apps.tasks.items = doc.apps.tasks.items.filter((x) => x.id !== "t2").map((x) => x.id === "t1" ? { ...x, done: true, doneAt: now, updatedAt: now } : x);
  doc.apps.tasks.deleted = [{ id: "t2", at: now }];
  drive.write(f.id, doc);
  // この端末で並べ替える（読むを上へ）
  await A.focus('#list .grip[data-grip="t3"]');
  await A.keyboard.press("ArrowUp");
  await A.keyboard.press("ArrowUp");
  ok(await until(() => { const d = appsDoc(drive); const it = d && d.apps.tasks.items; return it && it.some((x) => x.id === "t3" && typeof x.ordAt === "number"); }, 10000), "並べ替えが Drive に届く");
  const items = appsDoc(drive).apps.tasks.items;
  const t1 = items.find((x) => x.id === "t1");
  ok(t1 && t1.done === true, "ほかの端末での完了が戻らない（Drive）", t1);
  ok(!items.some((x) => x.id === "t2"), "ほかの端末で消したタスクが生き返らない（Drive）", items.map((x) => x.id));
  const local = (await lsJSON(A, "tasks:v1")).items;
  ok(local.find((x) => x.id === "t1").done === true && !local.some((x) => x.id === "t2"), "この端末にも完了・削除が入る", local.map((x) => [x.id, x.done]));
  const t3 = items.find((x) => x.id === "t3");
  ok(t3 && t3.updatedAt === 1000 && typeof t3.ord === "number", "並べ替えでは中身の更新時刻を変えない（並びだけを ord / ordAt で送る）", t3);
  ok(A.errs.length === 0, "r1: エラーなし", A.errs);
  await ctx.close();
});

/* ── r2 気になり帳の並べ替え ───────────────────────── */
await section("r2 気になり帳: 並べ替えがほかの端末の編集・削除を上書きしない", async () => {
  const DATA_KEY = "kininari:data:v2", FILE = "kininari-data.json";
  const T0 = Date.now() - 24 * 3600e3;
  const memo = (i, title) => ({ id: "m" + i, title, body: "", category: "メモ", tags: [], links: [], notebookId: null, date: null, time: null, remind: null, srs: null, attachments: [], done: false, pinned: false, createdAt: T0 + i * 60000, updatedAt: T0 + i * 60000, synced: 1 });
  const drive = createFakeDrive();
  drive.put(FILE, { app: "kininari", memos: [memo(1, "A"), memo(2, "B"), memo(3, "C"), memo(4, "D"), memo(5, "E")], notebooks: [], files: [], deleted: [] });
  const fileId = drive.byName(FILE)[0].id;
  const ctx = await device({ drive });
  await preset(ctx, { [DATA_KEY]: { memos: [], notebooks: [] }, "kininari:note:view": "\"card\"", "kininari:note:viewV45": "1",
    "shared:gd:token": tokenLS(), "kininari:gd:linked": "1", "kininari:sort": "manual" });
  const A = await openPage(ctx, "kininari.html", ".capture-input");
  const titles = () => A.$$eval("section.list .card .title", (els) => els.map((e) => e.textContent.trim()));
  ok(await until(async () => (await titles()).length === 5), "準備: 5件を取り込んだ");
  await sleep(4000);
  // スマホで C を直し、D を消した（この端末はまだ取り込んでいない）
  const cur = drive.json(fileId), now = Date.now();
  cur.memos = cur.memos.map((m) => m.id === "m3" ? { ...m, title: "C（スマホで直した）", updatedAt: now } : m).filter((m) => m.id !== "m4");
  cur.deleted = [...(cur.deleted || []), { id: "m4", at: now }];
  drive.write(fileId, cur);
  await sleep(300);
  await A.click('section.list .card:has(.title:text-is("A")) .ro-num');
  await A.fill(".ro-num-in", "1");
  await A.press(".ro-num-in", "Enter");
  ok(await until(() => (drive.json(fileId).memos || []).some((m) => m.id === "m1" && typeof m.ordAt === "number"), 12000), "並べ替えが Drive に届く");
  const fin = drive.json(fileId).memos;
  ok(fin.some((m) => m.id === "m3" && m.title === "C（スマホで直した）"), "スマホでの編集が戻らない（Drive）", fin.map((m) => m.title));
  ok(!fin.some((m) => m.id === "m4"), "スマホで消したメモが生き返らない（Drive）", fin.map((m) => m.title));
  ok(await until(async () => { const t = await titles(); return t[0] === "A" && t.includes("C（スマホで直した）") && !t.includes("D"); }, 8000), "この端末の一覧も、並べた順のまま編集・削除が入る", await titles());
  const m1 = fin.find((m) => m.id === "m1");
  ok(m1 && m1.updatedAt === T0 + 60000, "並べ替えでは中身の更新時刻を変えない", m1 && [m1.updatedAt, m1.ordAt]);
  ok(A.errs.length === 0, "r2: エラーなし", A.errs);
  await ctx.close();
});

/* ── r3 ログインが切れているとき（NKSync.create のアプリ） ── */
await section("r3 タスク・暗室・音・くつろぎ: ログインが切れていたら、押すまでログイン画面を頼まない", async () => {
  const drive = createFakeDrive();
  for (const [file, app, sel] of [["tasks.html", "tasks", "#list"], ["bgm.html", "bgm", "body"], ["autogenic.html", "autogenic", "body"], ["image-streaming.html", "anshitsu", "body"]]) {
    const ctx = await device({ drive });
    await ctx.addInitScript(() => { window.__fakeGis = { mode: "popupBlocked" }; });
    await preset(ctx, { "shared:gd:cid": "test-client", ["shared:nksync:sync:" + app]: new Date(Date.now() - 7200e3).toISOString(),
      "shared:gd:token": tokenLS(GD_SCOPE, -1000) });
    const p = await openPage(ctx, file, sel);
    await sleep(3000);
    ok((await gisCalls(p)).length === 0, `${app}: 開いただけではログイン画面を頼まない（ブラウザに止められる画面を出さない）`, await gisCalls(p));
    if (app === "tasks") {
      const msg = await p.textContent("#syncMsg").catch(() => "");
      ok(/ログインが切れています/.test(msg), "tasks: 「ログインが切れています」と出る", msg);
      await p.click("h1");
      ok(await until(async () => (await gisCalls(p)).length === 1), "tasks: 画面を押すと、その場でつなぎ直す");
      const c = await gisCalls(p);
      ok(c.length === 1 && c[0].act, "tasks: ログイン画面は押した直後に1回だけ", c);
      ok(await until(() => { const d = appsDoc(drive); return !!(d && d.apps && d.apps.tasks); }, 10000), "tasks: つなぎ直したら同期する");
    }
    ok(p.errs.length === 0, `${app}: エラーなし`, p.errs);
    await ctx.close();
  }
});

/* ── r4 Googleタスクへの自動送信 ───────────────────── */
await section("r4 タスク: Googleタスクへの自動送信も、ログインが切れていたら頼まずに待つ", async () => {
  const ctx = await device();
  await ctx.addInitScript(() => { window.__fakeGis = { mode: "popupBlocked" }; });
  await preset(ctx, { "shared:gd:cid": "test-client", "shared:gd:token": tokenLS(TASKS_SCOPE, -1000), "tasks:gtaskAuto": "1", "shared:nksync:auto": "0",
    "tasks:v1": { items: [task({ id: "t1", title: "払う" })], deleted: [], gdel: [] } });
  const p = await openPage(ctx, "tasks.html", "#list");
  await p.fill("#nt", "新しいタスク");
  await p.press("#nt", "Enter");
  await sleep(11500);
  ok((await gisCalls(p)).length === 0, "変えてから10秒たっても、ログイン画面を頼まない（以前は2回頼んで止められていた）", await gisCalls(p));
  const toast = await p.textContent("#toast").catch(() => "");
  ok(!/Googleタスクと同期できませんでした/.test(toast), "「Googleタスクと同期できませんでした」を出さない", toast);
  await p.click("h1");
  ok(await until(async () => (await gisCalls(p)).some((c) => c.act)), "画面を押すと、その場でつなぎ直す", await gisCalls(p));
  await ctx.close();
});

/* ── r5 日記帳: 添付が送れなくても本文は送る ──────────── */
await section("r5 日記帳: 新しい添付が送れなくても、本文は送る", async () => {
  const drive = createFakeDrive();
  const ctx = await device({ drive });
  const D = await openDiary(ctx);
  await D.evaluate(async () => {
    const e = { id: genId(), date: "2026-11-01", title: "添付の日", content: "<p>本文A</p>", contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    entries.push(e); await saveEntriesToStorage(); loadEntry(e);
  });
  await D.evaluate(() => drivePushAll(false));
  await D.evaluate(() => { drivePushLastAt = 0; drivePullLastAt = 0; });
  // 大きなファイルを足したことにして、その送信だけ失敗させる
  const orig = drive.handle;
  drive.handle = async (route) => {
    const req = route.request();
    if (req.method() === "POST" && /upload\/drive\/v3\/files$/.test(new URL(req.url()).pathname) && String(req.postDataBuffer() || "").includes("dy-file-")) {
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":500}}' });
    }
    return orig(route);
  };
  const fid = await D.evaluate(async () => {
    rteFocusBody(true);
    await insertFiles([new File(["DOCX-MARKER-r5"], "報告.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]);
    document.getElementById("contentEditor").insertAdjacentHTML("beforeend", "<p>添付のあとに書いた本文</p>");
    syncEditorContent(); markDirty();
    await saveEntry(true);
    const c = document.querySelector("#contentEditor .dy-file");
    return c && c.getAttribute("data-fid");
  });
  ok(!!fid, "準備: ファイルを添付した");
  const dj = () => { const f = drive.byName("diary.json")[0]; return f ? drive.json(f.id) : null; };
  ok(await until(() => { const d = dj(); return d && d.entries.some((e) => /添付のあとに書いた本文/.test(e.content)); }, 10000), "ファイルが送れなくても、日記の本文は Drive に届く");
  ok(await D.evaluate(() => driveAttFailed === 1 && /添付の送信待ち/.test(document.getElementById("driveChip").textContent)), "☁ に「添付の送信待ち」と出る", await D.evaluate(() => document.getElementById("driveChip").textContent));
  ok(await D.evaluate(() => !!localStorage.getItem("diary:gd:pending")), "送れていない印を残す（次の同期で送り直す）");
  drive.handle = orig;
  await D.click("#driveChip");
  ok(await until(() => drive.byName("dy-file-" + fid).length === 1, 10000), "次の同期で、ファイルも送れる");
  ok(await until(() => D.evaluate(() => driveAttFailed === 0 && !localStorage.getItem("diary:gd:pending"))), "送れたら印を消す");
  // わざと失敗させた送信（500）の記録は数えない
  const e5 = D.errs.filter((e) => !/status of 500/.test(e));
  ok(e5.length === 0, "r5: エラーなし", e5);
  await ctx.close();
});

/* ── r6 日記帳: 入口の中で、暗号化された Drive を読む ─── */
await section("r6 日記帳: 入口の「日記: Driveから読み込み」で、暗号化された日記を読める", async () => {
  const drive = createFakeDrive();
  // 端末A: 暗号化して Drive へ
  const ctxA = await device({ drive });
  const A = await openDiary(ctxA);
  await A.evaluate(async () => {
    const e = { id: genId(), date: "2026-11-02", title: "暗号の日", content: "<p>ひみつ</p>", contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    entries.push(e); await saveEntriesToStorage();
    document.getElementById("encNewPass").value = "r6-pass-1234"; document.getElementById("encNewPass2").value = "r6-pass-1234";
    await applyPassphrase();
  });
  await A.evaluate(() => drivePushAll(false));
  ok(!!drive.byName("diary.json")[0], "準備: 暗号化した日記が Drive にある");
  // 端末B: 入口の中。新しい端末で、鍵が無い
  const ctxB = await device({ drive });
  await ctxB.addInitScript(() => { if (window.top === window) window.__fakeGis = { mode: "popupBlocked", delay: 30 }; });
  await preset(ctxB, { "shared:gd:cid": "test-client" });
  const S = await openPage(ctxB, "index.html");
  const frame = () => S.frames().find((f) => { try { return new URL(f.url()).pathname.endsWith("/diary.html"); } catch (e) { return false; } });
  ok(await until(() => { const f = frame(); return f && f.evaluate(() => typeof storageReady !== "undefined" && storageReady === true).catch(() => false); }, 15000), "準備: 日記帳のタブ");
  // 「今すぐ全部同期」: 鍵が無いので止まる → 入口の☁に出る
  await S.click("#knBackupBtn");
  await S.click("#knSyncAll");
  let st = "";
  await until(async () => /日記帳[^\n]*⚠/.test(st = (await S.textContent("#knStatus")).replace(/\s+/g, " ")) || /暗号/.test(st), 20000);
  st = await S.textContent("#knStatus");
  ok(/暗号化|鍵/.test(st), "日記の同期が止まったことが、入口の☁にも出る（以前は ✅ のままだった）", st.slice(0, 200));
  // 入口の「日記: Driveから読み込み」→ 日記帳がパスフレーズを聞く
  S.answers.push("r6-pass-1234");
  await S.click("#knDiaryPull");
  ok(await until(() => frame().evaluate(() => entries.some((e) => e.title === "暗号の日")), 15000), "入口の「日記: Driveから読み込み」でパスフレーズを入れると、暗号化された日記を読める");
  ok(S.dialogs.some((d) => d.type === "prompt"), "パスフレーズは日記帳が聞く", S.dialogs);
  const calls = await S.evaluate(() => (window.__fakeGisCalls || []).map((c) => ({ act: c.activation, frame: c.frame })));
  ok(calls.every((c) => c.act), "ログイン画面は押した直後にだけ頼む", calls);
  // 鍵が無くて止まったことの記録（REMOTE_LOCKED）は、想定どおりのものなので数えない
  const e6 = [...A.errs, ...S.errs].filter((e) => !/REMOTE_LOCKED|REMOTE_ENC_NOKEY/.test(e));
  ok(e6.length === 0, "r6: エラーなし", e6);
  await ctxA.close(); await ctxB.close();
});

/* ── r7 日記帳: 暗号化の解除で Drive を作り直さない ────── */
await section("r7 日記帳: 暗号化を解除しても、ほかの端末の日記が Drive から消えない", async () => {
  const drive = createFakeDrive();
  const ctxA = await device({ drive }), ctxB = await device({ drive });
  const A = await openDiary(ctxA);
  await A.evaluate(async () => {
    const e = { id: genId(), date: "2026-10-01", title: "Aの日記", content: "<p>a</p>", contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    entries.push(e); await saveEntriesToStorage();
    document.getElementById("encNewPass").value = "r7-pass-1234"; document.getElementById("encNewPass2").value = "r7-pass-1234";
    await applyPassphrase();
  });
  await A.evaluate(() => drivePushAll(false));
  const B = await openDiary(ctxB);
  await B.evaluate(async () => {
    document.getElementById("encNewPass").value = "r7-pass-1234"; document.getElementById("encNewPass2").value = "r7-pass-1234";
    await applyPassphrase();
  });
  B.answers.push("r7-pass-1234");
  await B.evaluate(() => drivePullAndMerge(false));
  await B.evaluate(async () => {
    const e = { id: genId(), date: "2026-10-02", title: "Bで書いた日記", content: "<p>b</p>", contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    entries.push(e); await saveEntriesToStorage();
  });
  await B.evaluate(() => drivePushAll(false));
  // A はまだ B の日記を取り込んでいない。ここで暗号化を解除する
  await A.evaluate(() => { drivePushLastAt = 0; disableEncryption(); });
  const dj = () => { const f = drive.byName("diary.json")[0]; return f ? drive.json(f.id) : null; };
  ok(await until(() => { const d = dj(); return d && !d.__enc__ && Array.isArray(d.entries); }, 15000), "解除したら Drive も平文になる");
  const d = dj();
  ok(d && d.entries.some((e) => e.title === "Bで書いた日記") && d.entries.some((e) => e.title === "Aの日記"), "B で書いた（A がまだ取り込んでいない）日記も Drive に残る", d && d.entries.map((e) => e.title));
  ok(A.errs.length === 0 && B.errs.length === 0, "r7: エラーなし", [...A.errs, ...B.errs]);
  await ctxA.close(); await ctxB.close();
});

/* ── r8 日記帳: 新しい形の日記 ─────────────────────── */
await section("r8 日記帳: Drive の日記がこの版より新しい形なら、読み込みも送信もしない", async () => {
  const drive = createFakeDrive();
  const f = drive.put("diary.json", { fmt: 99, exportDate: new Date().toISOString(), entries: [{ id: "x1", date: "2026-09-09", title: "未来の日記", content: "<p class=\"future-mark\">新しい書式</p>", contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], deleted: [], images: [] }, { parents: ["appDataFolder"] });
  const before = drive.text(f.id);
  const ctx = await device({ drive });
  const D = await openDiary(ctx);
  await D.evaluate(async () => {
    const e = { id: genId(), date: "2026-09-10", title: "この端末", content: "<p>x</p>", contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    entries.push(e); await saveEntriesToStorage();
  });
  await D.evaluate(() => drivePushAll(false));
  ok(drive.text(f.id) === before, "古い版の端末からは送らない（新しい書式を消さない）");
  ok(await D.evaluate(() => !entries.some((e) => e.title === "未来の日記")), "読み込みもしない");
  ok(await D.evaluate(() => /新しい版のアプリ/.test(driveSyncProblem || "")), "「アプリを更新してください」と知らせる", await D.evaluate(() => driveSyncProblem));
  const obj = await D.evaluate(() => buildSyncObject(undefined, undefined, null, true));
  ok(obj && obj.fmt === 2, "送る日記には形の版（fmt）を書く", obj && obj.fmt);
  await ctx.close();
});

/* ── r9 日記帳: 共有の出し直し ─────────────────────── */
await section("r9 日記帳: 共有の画面を出せなかったら「共有する」で出し直す", async () => {
  const ctx = await device();
  await ctx.addInitScript(() => {
    window.__shareCalls = 0;
    navigator.canShare = () => true;
    navigator.share = () => { window.__shareCalls++; if (window.__shareCalls === 1) { const e = new Error("no activation"); e.name = "NotAllowedError"; return Promise.reject(e); } return Promise.resolve(); };
  });
  const D = await openDiary(ctx);
  await D.evaluate(async () => {
    const e = { id: genId(), date: "2026-11-03", title: "共有の日", content: "<p>x</p>", contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    entries.push(e); await saveEntriesToStorage();
    localStorage.removeItem("diaryLastBackup");
  });
  await D.evaluate(() => shareBackup());
  ok(await D.evaluate(() => !localStorage.getItem("diaryLastBackup")), "共有できなかったのに「バックアップ済み」にしない");
  const btn = D.locator("#toastRegion .toast-act", { hasText: "共有する" });
  ok((await btn.count()) === 1, "「共有する」ボタンが出る");
  await btn.click();
  ok(await until(() => D.evaluate(() => window.__shareCalls === 2 && !!localStorage.getItem("diaryLastBackup"))), "押すと共有の画面を出し、共有できたら「バックアップ済み」にする");
  await ctx.close();
});

/* ── r10〜r13 気になり帳 ───────────────────────────── */
const KDATA = "kininari:data:v2";
const kmemo = (id, title, extra = {}) => ({ id, title, body: "", category: "メモ", tags: [], links: [], notebookId: null, date: null, time: null, remind: null, srs: null, attachments: [], done: false, pinned: false, createdAt: Date.now() - 86400e3, updatedAt: Date.now() - 86400e3, ...extra });
await section("r10 気になり帳: バックアップから戻したメモが次の同期で消えない", async () => {
  const drive = createFakeDrive();
  const old = Date.now() - 86400e3;
  // ほかの端末で消した記録が Drive にある
  const fid = drive.put("kininari-data.json", { app: "kininari", memos: [kmemo("k1", "残るメモ", { synced: 1 })], notebooks: [], files: [], deleted: [{ id: "k2", at: Date.now() - 3600e3 }] }).id;
  const ctx = await device({ drive });
  await preset(ctx, { [KDATA]: { memos: [kmemo("k1", "残るメモ", { synced: 1 })], notebooks: [] }, "kininari:note:view": "\"card\"", "kininari:note:viewV45": "1",
    "shared:gd:token": tokenLS(), "kininari:gd:linked": "1", "kininari:deleted:v1": [{ id: "k2", at: Date.now() - 3600e3 }] });
  const K = await openPage(ctx, "kininari.html", ".capture-input");
  await sleep(2500);
  // 間違って消したメモ（k2）を、バックアップから戻す
  await K.click('button[aria-label="端末間でデータを引き継ぐ"]');
  await K.click('.data-tab:has-text("読み込む")');
  const backup = { app: "kininari", memos: [kmemo("k1", "残るメモ", { updatedAt: old }), kmemo("k2", "戻したいメモ", { updatedAt: old, synced: 1 })], notebooks: [], files: [] };
  await K.fill(".data-pane textarea", JSON.stringify(backup));
  await K.click('.data-pane button:has-text("読み込")');
  await sleep(6000);   // 自動同期（3秒）を待つ
  const local = ((await lsJSON(K, KDATA)) || {}).memos || [];
  ok(local.some((m) => m.id === "k2"), "戻したメモが、次の同期のあとも残る（以前は数秒で消えた）", local.map((m) => m.title));
  ok((drive.json(fid).memos || []).some((m) => m.id === "k2"), "Drive にも戻る");
  ok(K.errs.length === 0, "r10: エラーなし", K.errs);
  await ctx.close();
});
await section("r11 気になり帳: 消えたフォルダを指すメモは「フォルダなし」に出る", async () => {
  const ctx = await device();
  await preset(ctx, { [KDATA]: { memos: [kmemo("o1", "迷子のメモ", { notebookId: "gone-folder" }), kmemo("o2", "ふつうのメモ")], notebooks: [] }, "kininari:note:view": "\"card\"", "kininari:note:viewV45": "1" });
  const K = await openPage(ctx, "kininari.html", ".capture-input");
  const t = await K.$$eval("section.list .card .title", (els) => els.map((e) => e.textContent.trim()));
  ok(t.includes("迷子のメモ"), "カード表示のいちばん上（フォルダなし）に出る（以前は検索でしか見つからなかった）", t);
  await K.click(".view-switch button:has-text('ノート表示'), button:has-text('ノート表示')");
  await K.waitForSelector(".npg-list");
  const noneCount = await K.evaluate(() => { const el = Array.from(document.querySelectorAll("*")).find((x) => x.children.length === 0 && /^フォルダなし$/.test(x.textContent.trim())); const row = el && el.closest("button, li, div"); return row ? row.textContent : ""; });
  ok(/2/.test(noneCount), "ノート表示の「フォルダなし」にも数える", noneCount);
  ok(K.errs.length === 0, "r11: エラーなし", K.errs);
  await ctx.close();
});
await section("r12 気になり帳: リンクから足したメモは取り消せる", async () => {
  const ctx = await device();
  await preset(ctx, { [KDATA]: { memos: [], notebooks: [] }, "kininari:note:view": "\"card\"", "kininari:note:viewV45": "1" });
  const clip = encodeURIComponent(JSON.stringify({ t: "知らないメモ", u: "https://example.com/x", n: "", img: "", c: "メモ", f: "知らないフォルダ" }));
  const K = await openPage(ctx, "kininari.html#knadd=" + clip, ".capture-input");
  ok(await until(async () => ((await lsJSON(K, KDATA)) || { memos: [] }).memos.some((m) => m.title === "知らないメモ")), "番号の無いクリップも、これまでどおり受け取る（ブックマークレット）");
  const act = K.locator(".toast .toast-act", { hasText: "取り消す" });
  ok((await act.count()) === 1, "「リンクからメモを追加しました」に「取り消す」が付く");
  await act.click();
  const d = await lsJSON(K, KDATA);
  ok(!d.memos.some((m) => m.title === "知らないメモ") && !d.notebooks.some((f) => f.name === "知らないフォルダ"), "取り消すと、メモも、そのとき作ったフォルダも消える", d);
  const tomb = await lsJSON(K, "kininari:deleted:v1");
  ok(Array.isArray(tomb) && tomb.length >= 1, "削除の記録も残す（ほかの端末で戻らない）", tomb);
  // 番号つき（拡張の裏タブ）は今までどおり
  const clip2 = encodeURIComponent(JSON.stringify({ t: "拡張のメモ", u: "https://example.com/y", n: "", img: "", c: "メモ", f: "", k: "abcdef0123456789" }));
  const K2 = await openPage(ctx, "kininari.html#knadd=" + clip2, ".capture-input");
  await until(async () => ((await lsJSON(K2, KDATA)) || { memos: [] }).memos.some((m) => m.title === "拡張のメモ"));
  ok((await K2.locator(".toast .toast-act").count()) === 0, "番号つきのクリップ（拡張）には「取り消す」を付けない");
  ok(K.errs.length === 0 && K2.errs.length === 0, "r12: エラーなし", [...K.errs, ...K2.errs]);
  await ctx.close();
});
await section("r13 気になり帳: 読み直しが速い・書きはじめたページが入れ替わらない", async () => {
  const ctx = await device();
  await preset(ctx, { [KDATA]: { memos: [kmemo("p1", "一枚目"), kmemo("p2", "二枚目")], notebooks: [] }, "kininari:note:view": "\"note\"", "kininari:note:viewV45": "1" });
  const K = await openPage(ctx, "kininari.html", ".npg-list");
  const t = await K.evaluate(() => {
    const body = "<div>" + "これはテストの本文です。<b>太字</b> <a href=\"https://example.com\">link</a><br>".repeat(25) + "</div>";
    const json = JSON.stringify({ memos: Array.from({ length: 2000 }, (_, i) => ({ id: "m" + i, title: "t" + i, body, createdAt: i, updatedAt: i })), notebooks: [] });
    JSON.parse(json).memos.map(normalizeMemo);   // 1回目（覚える）
    const t0 = performance.now();
    JSON.parse(json).memos.map(normalizeMemo);   // 2回目
    return performance.now() - t0;
  });
  ok(t < 200, "2000件・3.4MB の読み直しが 0.2秒未満（以前は約0.5秒）", Math.round(t) + "ms");
  // ページを選ばずに（先頭のページが出ているまま）書きはじめる
  const first = await K.$eval(".np[data-mid]", (e) => e.getAttribute("data-mid"));
  await K.click(".np .np-title");
  ok(await until(() => K.evaluate((id) => { try { return JSON.parse(localStorage.getItem("kininari:note:sel") || "{}").p === id; } catch (e) { return false; } }, first)), "書きはじめたページを選んだことにする（新しいメモが届いても入れ替わらない）");
  ok(K.errs.length === 0, "r13: エラーなし", K.errs);
  await ctx.close();
});

/* ── r14 タスクの片付け ────────────────────────────── */
await section("r14 タスク: 完了から半年たったタスクを片付ける", async () => {
  const ctx = await device();
  const old = Date.now() - 200 * 86400e3, recent = Date.now() - 10 * 86400e3;
  await preset(ctx, { "tasks:v1": { items: [task({ id: "o1", title: "昔の完了", done: true, doneAt: old, gtaskId: "G-old" }), task({ id: "o2", title: "最近の完了", done: true, doneAt: recent }), task({ id: "o3", title: "まだ", done: false })], deleted: [], gdel: [] }, "shared:nksync:auto": "0" });
  const p = await openPage(ctx, "tasks.html", "#list");
  const d = await lsJSON(p, "tasks:v1");
  ok(!d.items.some((x) => x.id === "o1") && d.items.some((x) => x.id === "o2") && d.items.some((x) => x.id === "o3"), "半年より前に完了したものだけを片付ける", d.items.map((x) => x.id));
  ok(d.deleted.some((x) => x.id === "o1"), "削除の記録を残す（ほかの端末で戻らない）");
  ok((d.gdel || []).some((x) => x.id === "G-old"), "Googleタスクからも消す予約をする（残すと取り込み直してしまう）", d.gdel);
  ok(/片付けました/.test(await p.textContent("#toast")), "片付けたことを知らせる");
  ok(p.errs.length === 0, "r14: エラーなし", p.errs);
  await ctx.close();
});

/* ── r15 くつろぎの保存失敗 ─────────────────────────── */
await section("r15 くつろぎ: 保存できなかったら知らせる", async () => {
  const ctx = await device();
  const p = await openPage(ctx, "autogenic.html", "body");
  await sleep(500);
  await p.evaluate(() => {
    // 端末の保存容量がいっぱい（書くと失敗する）ことにして、設定を1つ変える（保存が走る）
    Storage.prototype.setItem = function () { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; };
    const el = document.getElementById("optWake");
    el.checked = !el.checked;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  ok(await until(() => p.evaluate(() => /保存容量がいっぱい/.test(document.getElementById("toast").textContent) && document.getElementById("toast").style.display !== "none")), "「保存容量がいっぱいで、記録を保存できませんでした」と出る");
  await ctx.close();
});

/* ── r16 音のラジオ・集中タイマー ───────────────────── */
await section("r16 音: ラジオの追加をすぐ同期・入口: 集中タイマーを続ける", async () => {
  const drive = createFakeDrive();
  const ctx = await device({ drive });
  await preset(ctx, { "shared:gd:cid": "test-client", "shared:gd:token": tokenLS(), "shared:nksync:sync:bgm": new Date(Date.now() - 60e3).toISOString() });
  const p = await openPage(ctx, "bgm.html", "body");
  await sleep(4500);   // 開いたときの同期
  const n0 = drive.log.filter((r) => r.method !== "GET").length;
  await p.evaluate(() => {
    document.getElementById("auUrl").value = "https://radio.example.com/stream";
    document.getElementById("auName").value = "テストのラジオ";
    document.getElementById("auSave").click();
  });
  ok(await until(() => { const d = appsDoc(drive); return d && JSON.stringify(d.apps.bgm || {}).includes("radio.example.com"); }, 8000), "ラジオを足したら、すぐ Drive に送る（以前は次に何か変えるまで送らなかった）", drive.log.filter((r) => r.method !== "GET").length - n0);
  await ctx.close();
  // 集中タイマー: 入口を読み込み直しても、いまの区切りが続いていれば続ける
  const ctx2 = await device();
  const end = Date.now() + 10 * 60e3;
  await preset(ctx2, { "nk:focusTimer": { on: true, phase: "work", end, work: 25, brk: 5, round: 2 } });
  const S = await openPage(ctx2, "index.html");
  await sleep(1500);
  const kept = await lsJSON(S, "nk:focusTimer");
  ok(kept && kept.on && kept.end === end && kept.round === 2, "読み込み直しても、集中タイマーの区切りを覚えている", kept);
  await ctx2.close();
  const ctx3 = await device();
  await preset(ctx3, { "nk:focusTimer": { on: true, phase: "work", end: Date.now() - 3600e3, work: 25, brk: 5, round: 1 } });
  const S3 = await openPage(ctx3, "index.html");
  await sleep(1200);
  ok((await lsJSON(S3, "nk:focusTimer")) === null, "とうに過ぎていた（閉じていた）ものは続けない");
  await ctx3.close();
});

const errs = allErrs.flat().filter((e) => !/favicon|Failed to load resource|REMOTE_LOCKED|REMOTE_ENC_NOKEY|REMOTE_NEWER/.test(e));
ok(errs.length === 0, "ページの例外なし", errs.slice(0, 5));
await browser.close();
await server.close();
done();
