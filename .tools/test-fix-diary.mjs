/* ============================================================
   日記帳（diary.html）の修正の確認（パス1・パス2）
     node .tools/test-fix-diary.mjs                    … 全部
     ONLY=1,2 node .tools/test-fix-diary.mjs           … 項目を選ぶ（下の番号）
     DIARY_ROOT=/別の場所 node .tools/test-fix-diary.mjs … その場所の diary.html で試す（修正前との比べ用）

   1  暗号化していない端末が、暗号化された Drive を平文で上書きしない
   2  パスフレーズ変更・有効化・解除の途中で落ちても、画像を失わない（続きから直る）
   3  画像の貼り付けの途中で本文が描き直されても、写真が消えない・別の日記に入らない
   4  同じパスフレーズの2台（salt 違い）で、毎回パスフレーズを聞かれずに同期できる
   5  同期のたびに写真を全部書き直さない
   6  別のタブで暗号化の設定が変わった古いタブは同期しない
   7  保存中に打った文字・画面を離れる直前の文字が保存される
   8  削除の記録（墓標）は日記を保存してから書き、書けなければ知らせる
   9  ありえない反復回数の暗号文は、計算する前に断る
   10 同期データの画像は data:image だけを読む
   11 復号した中身が配列でなければ、ロックしたままにする
   12 本文の書き出しで <img> を読み込まない
   p2 パス2: NKSync.drive への移行（findFiles・排他・入口のトークン）と、写真を1枚ずつ別のファイルにする
   ============================================================ */
import { startServer, launch, newDevice, collectErrors, makeChecker, sleep, waitFor, ROOT } from "./lib/harness.mjs";
import { createFakeDrive } from "./lib/fake-drive.mjs";

const only = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const want = (k) => !only.length || only.includes(String(k));
const srv = await startServer(process.env.DIARY_ROOT || ROOT);
const browser = await launch();
const { ok, done } = makeChecker("test-fix-diary");
const pageErrors = [];

/* ── 道具 ─────────────────────────────────────────── */
/** 日記帳を開く。dialog は page.answers の順に答える（無ければ confirm は OK、prompt は取り消し） */
async function open(ctx) {
  const page = await ctx.newPage();
  const errs = collectErrors(page);
  page.answers = [];
  page.dialogs = [];
  page.on("dialog", async (d) => {
    page.dialogs.push({ type: d.type(), msg: d.message() });
    const a = page.answers.length ? page.answers.shift() : (d.type() === "prompt" ? null : true);
    try {
      if (a === null || a === false) await d.dismiss();
      else await d.accept(typeof a === "string" ? a : undefined);
    } catch (e) {}
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(srv.url + "diary.html");
  // Google のログイン部品（偽物）は async で後から読まれる。読まれる前に同期すると「未読込」で失敗する
  await page.waitForFunction(() => typeof storageReady !== "undefined" && storageReady === true
    && document.getElementById("calendarDays").children.length > 0 && !!(window.google && google.accounts && google.accounts.oauth2));
  await sleep(150);
  page.errs = errs;
  return page;
}
/** 期限つきの evaluate（修正前のコードが固まっても検証自体は止めない） */
async function evalT(page, fn, arg, ms = 15000) {
  return Promise.race([page.evaluate(fn, arg), sleep(ms).then(() => { throw new Error("TIMEOUT"); })]);
}
async function addEntry(page, date, title, html = "") {
  return page.evaluate(async ([date, title, html]) => {
    const e = { id: genId(), date, title, content: html, contentFormat: "html", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    entries.push(e);
    const r = await saveEntriesToStorage();
    loadEntry(e);
    return r;
  }, [date, title, html]);
}
/** 色違いの小さな PNG を n 枚作って、開いている日記に貼る */
async function pasteImages(page, n, { wait = true } = {}) {
  return page.evaluate(async ([n, wait]) => {
    const files = [];
    for (let i = 0; i < n; i++) {
      const c = document.createElement("canvas"); c.width = 40; c.height = 30;
      const x = c.getContext("2d"); x.fillStyle = `hsl(${(i * 47 + Math.random() * 40) % 360},70%,50%)`; x.fillRect(0, 0, 40, 30);
      const b = await new Promise((r) => c.toBlob(r, "image/png"));
      files.push(new File([b], `p${i}.png`, { type: "image/png" }));
    }
    const p = insertImageFiles(files);
    if (wait) return await p;
    window.__pasting = p;
    return -1;
  }, [n, wait]);
}
/** 端末の画像の一覧。readable は「いまの鍵（cryptoKey）だけで」読めるか（平文はそのまま読める） */
async function imgState(page) {
  return evalT(page, async () => {
    const out = [];
    for (const k of await imgKeys()) {
      const rec = await imgGet(k);
      if (!rec) continue;
      let readable = !rec.enc;
      if (rec.enc && cryptoKey) {
        try { await crypto.subtle.decrypt({ name: "AES-GCM", iv: ENC.unb64(rec.iv) }, cryptoKey, rec.data); readable = true; } catch (e) {}
      }
      out.push({ id: k, enc: rec.enc ? 1 : 0, ks: rec.ks || null, readable });
    }
    return out;
  });
}
async function setPass(page, pass, { wait = true } = {}) {
  return page.evaluate(async ([pass, wait]) => {
    document.getElementById("encNewPass").value = pass;
    document.getElementById("encNewPass2").value = pass;
    const p = applyPassphrase();
    if (wait) await p; else window.__applying = p;
  }, [pass, wait]);
}
async function unlock(page, pass) {
  await evalT(page, async (pass) => { document.getElementById("unlockPass").value = pass; await submitUnlock(); }, pass);
  return page.evaluate(() => !appLocked);
}
/** imgPut を k 回だけ通し、それ以降は返事をしない（書き直しの途中で止める） */
async function hangImgPutAfter(page, k) {
  await page.evaluate((k) => {
    const orig = window.imgPut; let n = 0;
    window.__imgPuts = 0;
    window.imgPut = (rec) => { n++; window.__imgPuts = n; if (n > k) return new Promise(() => {}); return orig(rec); };
  }, k);
}
async function countImgPut(page) {
  await page.evaluate(() => {
    if (!window.__origImgPut) window.__origImgPut = window.imgPut;
    window.__imgPuts = 0;
    window.imgPut = (rec) => { window.__imgPuts++; return window.__origImgPut(rec); };
  });
}
const toasts = (page) => page.evaluate(() => Array.from(document.querySelectorAll("#toastRegion .toast")).map((t) => t.textContent));
async function toastSeen(page, re, ms = 3000) {
  try { await waitFor(async () => (await toasts(page)).some((t) => re.test(t)), { timeout: ms }); return true; } catch (e) { return false; }
}
const allReadable = (st) => st.length > 0 && st.every((r) => r.readable);
async function waitImgs(page, pred, ms = 15000) {
  try { return await waitFor(async () => { const st = await imgState(page); return pred(st) ? st : null; }, { timeout: ms, interval: 200 }); }
  catch (e) { return null; }
}
function driveDiary(drive) {
  const f = drive.byName("diary.json")[0];
  return f ? { id: f.id, text: drive.text(f.id), json: drive.json(f.id) } : null;
}
const isEnc = (o) => !!(o && o.__enc__ === 1 && o.ct && o.salt);
async function token(page) { await page.evaluate(() => NKSync.drive.getToken({})); }

/* ── 1. 暗号化していない端末が、暗号化された Drive を平文で上書きしない ── */
if (want(1)) {
  console.log("1) 暗号化されたDriveを平文で上書きしない");
  const drive = createFakeDrive();
  const ctxA = await newDevice(browser, { drive });
  const ctxB = await newDevice(browser, { drive });
  const A = await open(ctxA);
  await addEntry(A, "2026-09-01", "A日記", "<p>from A</p>");
  await setPass(A, "shared-pass-1");
  await A.evaluate(() => drivePushAll(false));
  let d = driveDiary(drive);
  ok(d && isEnc(d.json), "A: Driveの日記は暗号化されている");

  let B = await open(ctxB);
  await addEntry(B, "2026-09-02", "B日記", "<p>from B</p>");
  B.answers.push("shared-pass-1");
  await B.evaluate(() => drivePullAndMerge(false));
  ok(await B.evaluate(() => entries.some((e) => e.title === "A日記")), "B（暗号化なし）: パスフレーズを入れてAの日記を取り込めた");
  await addEntry(B, "2026-09-03", "B2", "<p>more from B</p>");
  await B.evaluate(() => drivePushAll(false));
  d = driveDiary(drive);
  ok(d && isEnc(d.json), "B: 書き戻してもDriveは暗号文のまま（平文で上書きしない）", d && d.text.slice(0, 80));
  await A.evaluate(() => drivePullAndMerge(true));
  ok(await A.evaluate(() => entries.some((e) => e.title === "B2")), "A: Bが書き足した日記を自分の鍵で読めた");
  ok(await B.evaluate(() => !!localStorage.getItem("diaryDriveEnc")), "B: Driveが暗号化されていることを端末に控えた");

  // 読み込み直すと鍵は無い → 静かな同期は止まり、Driveはそのまま、理由をバナーで出す
  await B.close();
  B = await open(ctxB);
  const before = driveDiary(drive).text;
  await B.evaluate(() => drivePushRun(true));
  ok(driveDiary(drive).text === before, "B 再読込後: 鍵が無い静かな同期はDriveに書かない");
  const banner = await B.evaluate(() => document.getElementById("backupReminder").style.display !== "none" ? document.getElementById("backupReminderText").textContent : "");
  ok(/パスフレーズ|暗号/.test(banner), "B: 止めた理由（パスフレーズが要る）をバナーで知らせる", banner);
  // 手動の保存ではパスフレーズを聞いて、暗号化したまま書く
  await addEntry(B, "2026-09-04", "B3", "<p>third</p>");
  B.answers.push("shared-pass-1");
  await B.evaluate(() => drivePushAll(false));
  d = driveDiary(drive);
  ok(B.dialogs.some((x) => x.type === "prompt"), "B: 手動の保存ではパスフレーズを聞く");
  ok(d && isEnc(d.json), "B: パスフレーズを入れた手動保存でも暗号文のまま");
  await A.evaluate(() => drivePullAndMerge(true));
  ok(await A.evaluate(() => entries.some((e) => e.title === "B3")), "A: B3 も読めた");

  // Drive のファイルが消えていても、控えがあれば平文では作らない
  await B.close();
  B = await open(ctxB);
  drive.files.delete(d.id);
  await B.evaluate(() => drivePushRun(true));
  d = driveDiary(drive);
  ok(!d || isEnc(d.json), "B: Driveのファイルが消えていても、暗号化されていた控えがあれば平文で作らない", d && d.text.slice(0, 60));

  // 暗号化した端末（A）が書き直せば、また暗号文で作られる
  await A.evaluate(() => drivePushAll(false));
  d = driveDiary(drive);
  ok(d && isEnc(d.json), "A: Driveを暗号文で作り直した");
  // A で暗号化を解除（Driveも平文になることを確かめてから）→ Drive は平文になってよい
  await A.evaluate(() => { autoSyncDriveEnabled = true; });
  await A.evaluate(() => disableEncryption());
  const conf = A.dialogs.filter((x) => x.type === "confirm").map((x) => x.msg).pop() || "";
  ok(/Drive/.test(conf), "A: 解除の確認で、Driveも平文になることを伝える", conf);
  await waitFor(() => { const x = driveDiary(drive); return x && !isEnc(x.json); }, { timeout: 8000 }).catch(() => {});
  d = driveDiary(drive);
  ok(d && !isEnc(d.json) && Array.isArray(d.json.entries), "A: 自分で解除したので、Driveを平文で作り直せた");
  await B.evaluate(() => drivePullAndMerge(true));
  ok(await B.evaluate(() => !localStorage.getItem("diaryDriveEnc")), "B: Driveが平文に戻ったら控えも消える");
  await addEntry(B, "2026-09-05", "B4", "<p>plain now</p>");
  await B.evaluate(() => drivePushAll(false));
  d = driveDiary(drive);
  ok(d && !isEnc(d.json) && d.json.entries.some((e) => e.title === "B4"), "B: Driveが平文なら平文のまま同期できる");
  await ctxA.close(); await ctxB.close();
}

/* ── 2. パスフレーズ変更・有効化・解除の途中で落ちても画像を失わない ── */
if (want(2)) {
  console.log("2) 暗号化の変更の途中で落ちても画像を失わない");
  // 2a 変更の途中（画像2枚目の書き直しのあと）で落ちる
  {
    const ctx = await newDevice(browser);
    let p = await open(ctx);
    await addEntry(p, "2026-10-01", "写真の日", "");
    await pasteImages(p, 6);
    await p.evaluate(() => saveEntry(true));
    await setPass(p, "pass-one-1");
    let st = await imgState(p);
    ok(st.length === 6 && st.every((r) => r.enc && r.readable), "2a 準備: 6枚とも暗号化済み", st);
    await hangImgPutAfter(p, 2);
    await setPass(p, "pass-two-2", { wait: false });
    await waitFor(() => p.evaluate(() => window.__imgPuts > 2), { timeout: 10000 }).catch(() => {});
    ok(await p.evaluate(() => window.__imgPuts > 2), "2a: 画像の書き直しの途中で止まった");
    const job = await p.evaluate(() => localStorage.getItem("diaryImgRekey"));
    ok(!!job, "2a: 書き直しの控えが残っている");
    ok(await p.evaluate(() => document.getElementById("encNewPass").value === "pass-two-2"), "2a: 終わるまでパスフレーズ欄は空にしない");
    ok(await p.evaluate(() => Array.from(document.querySelectorAll("#toastRegion .toast")).some((t) => /画像/.test(t.textContent) && /…/.test(t.textContent))), "2a: 書き直し中の表示が出ている");
    // 途中でも、元の鍵のままの画像を表示できる
    ok(await evalT(p, async () => { let n = 0; for (const k of await imgKeys()) { try { if (await imgDecode(await imgGet(k))) n++; } catch (e) {} } return n; }) === 6, "2a: 途中でも6枚とも表示できる");
    await p.close();
    p = await open(ctx);
    ok(await p.evaluate(() => appLocked), "2a 再起動: ロックされている");
    ok(await unlock(p, "pass-two-2"), "2a: 新しいパスフレーズで開ける");
    st = await waitImgs(p, (s) => s.length === 6 && allReadable(s));
    ok(!!st, "2a: 再起動後に続きを行い、6枚とも新しい鍵で読める", st || await imgState(p));
    ok(await p.evaluate(() => !localStorage.getItem("diaryImgRekey")), "2a: 全部済んだら控えを消す");
    const salt = await p.evaluate(() => encMeta.salt);
    ok(st && st.every((r) => r.ks === salt), "2a: 書き直した画像には新しい鍵の印（ks）が付く", st);
    // 本文の画像がちゃんと出る
    await p.evaluate(() => loadEntry(entries.find((e) => e.date === "2026-10-01")));
    await sleep(400);
    ok(await p.evaluate(() => document.querySelectorAll("#contentEditor img.diary-img").length === 6 && !document.querySelector("#contentEditor [data-imgnote]")), "2a: 本文の画像が6枚とも表示される");

    // 2e 消し損ねた控え（全部済んだあと）が残っていても、次に開いたときに片付くだけ
    if (job) {
      await p.evaluate((j) => localStorage.setItem("diaryImgRekey", j), job);
      await p.close();
      p = await open(ctx);
      ok(await unlock(p, "pass-two-2"), "2e: もう一度開ける");
      await waitFor(() => p.evaluate(() => !localStorage.getItem("diaryImgRekey")), { timeout: 8000 }).catch(() => {});
      ok(await p.evaluate(() => !localStorage.getItem("diaryImgRekey")), "2e: 残っていた控えは片付く");
      st = await imgState(p);
      ok(st.length === 6 && allReadable(st), "2e: 画像は6枚とも読めるまま", st);
    }

    // 2b 本文を新しい鍵で保存する前に落ちる → 元のパスフレーズのまま。画像も元の鍵で読める
    await p.evaluate(() => { window.saveEntriesToStorage = () => { window.__saveHung = true; return new Promise(() => {}); }; });
    await setPass(p, "pass-three-3", { wait: false });
    await waitFor(() => p.evaluate(() => window.__saveHung === true), { timeout: 10000 }).catch(() => {});
    await p.close();
    p = await open(ctx);
    ok(await unlock(p, "pass-two-2"), "2b: 本文の保存前に落ちたら、元のパスフレーズで開ける");
    await sleep(500);
    st = await imgState(p);
    ok(st.length === 6 && allReadable(st), "2b: 画像は元の鍵のまま読める", st);
    ok(await p.evaluate(() => !localStorage.getItem("diaryImgRekey")), "2b: 使われなかった控えは片付く");
    await ctx.close();
  }
  // 2c 有効化の途中で落ちる → 残りが平文のまま残らない
  {
    const ctx = await newDevice(browser);
    let p = await open(ctx);
    await addEntry(p, "2026-10-02", "有効化", "");
    await pasteImages(p, 5);
    await p.evaluate(() => saveEntry(true));
    let st = await imgState(p);
    ok(st.length === 5 && st.every((r) => !r.enc), "2c 準備: 5枚とも平文");
    await hangImgPutAfter(p, 2);
    await setPass(p, "enable-pass-1", { wait: false });
    await waitFor(() => p.evaluate(() => window.__imgPuts > 2), { timeout: 10000 }).catch(() => {});
    await p.close();
    p = await open(ctx);
    ok(await unlock(p, "enable-pass-1"), "2c: 新しいパスフレーズで開ける");
    st = await waitImgs(p, (s) => s.length === 5 && s.every((r) => r.enc && r.readable));
    ok(!!st, "2c: 再起動後に続きを行い、5枚とも暗号化される（平文のまま残らない）", st || await imgState(p));
    await ctx.close();
  }
  // 2d 解除の途中で落ちる → 残りが「もう無い鍵」で残らない
  {
    const ctx = await newDevice(browser);
    let p = await open(ctx);
    await addEntry(p, "2026-10-03", "解除", "");
    await setPass(p, "disable-pass-1");
    await pasteImages(p, 5);
    await p.evaluate(() => saveEntry(true));
    let st = await imgState(p);
    ok(st.length === 5 && st.every((r) => r.enc && r.readable), "2d 準備: 5枚とも暗号化済み");
    await hangImgPutAfter(p, 2);
    await p.evaluate(() => { window.__disabling = disableEncryption(); });
    await waitFor(() => p.evaluate(() => window.__imgPuts > 2), { timeout: 10000 }).catch(() => {});
    await p.close();
    p = await open(ctx);
    ok(await p.evaluate(() => !appLocked && !encEnabled), "2d 再起動: 平文で開く（パスフレーズ不要）");
    st = await waitImgs(p, (s) => s.length === 5 && s.every((r) => !r.enc));
    ok(!!st, "2d: 起動時に続きを行い、5枚とも平文に戻る", st || await imgState(p));
    ok(await p.evaluate(() => !localStorage.getItem("diaryImgRekey")), "2d: 全部済んだら（平文の鍵を含む）控えを消す");
    await ctx.close();
  }
  // 2f 本文を平文に戻す前に落ちた解除の控え（鍵が平文）は、ロック中でも起動時に消す
  {
    const ctx = await newDevice(browser);
    let p = await open(ctx);
    await addEntry(p, "2026-10-04", "解除前", "");
    await setPass(p, "disable-pass-2");
    await pasteImages(p, 2);
    await p.evaluate(() => saveEntry(true));
    await p.evaluate(() => { window.saveEntriesToStorage = () => { window.__saveHung = true; return new Promise(() => {}); }; window.__disabling = disableEncryption(); });
    await waitFor(() => p.evaluate(() => window.__saveHung === true), { timeout: 10000 }).catch(() => {});
    await p.close();
    p = await open(ctx);
    ok(await p.evaluate(() => appLocked), "2f: 解除する前のまま（ロックされている）");
    await sleep(300);
    ok(await p.evaluate(() => !localStorage.getItem("diaryImgRekey")), "2f: 平文の鍵を含む使われなかった控えは、ロック解除を待たずに消す");
    ok(await unlock(p, "disable-pass-2"), "2f: 元のパスフレーズで開ける");
    const st = await imgState(p);
    ok(st.length === 2 && allReadable(st), "2f: 画像も読める", st);
    await ctx.close();
  }
}

/* ── 3. 貼り付けの途中で本文が描き直されても写真が消えない ── */
if (want(3)) {
  console.log("3) 画像の貼り付けの途中で写真が消えない");
  {
    const ctx = await newDevice(browser);
    const p = await open(ctx);
    await addEntry(p, "2026-08-02", "二日目", "");
    await addEntry(p, "2026-08-01", "一日目", "");
    await p.evaluate(() => { const o = window.imgPut; window.imgPut = (r) => new Promise((res) => setTimeout(res, 350)).then(() => o(r)); });
    await pasteImages(p, 4, { wait: false });
    await waitFor(() => p.evaluate(() => document.querySelectorAll("#contentEditor img[data-did]").length >= 1), { timeout: 8000 });
    ok(await p.evaluate(() => isDirty === true && /data-did/.test(currentEntry.content)), "3a: 1枚目を入れた時点で本文に反映され「未保存」になる");
    await p.evaluate(() => selectDate("2026-08-02"));
    await evalT(p, () => window.__pasting);
    await sleep(1200);
    const stored = await p.evaluate(() => JSON.parse(localStorage.getItem("diaryEntries")));
    const one = stored.find((e) => e.date === "2026-08-01"), two = stored.find((e) => e.date === "2026-08-02");
    const n1 = (one.content.match(/data-did=/g) || []).length, n2 = (two.content.match(/data-did=/g) || []).length;
    ok(n1 >= 1, "3a: 日付を移る前に入れた写真は元の日記に保存されている", one.content);
    ok(n2 === 0, "3a: 残りの写真が移った先の日記に入らない", two.content);
    ok(await toastSeen(p, /取り込みませんでした/), "3a: 取り込まなかった枚数を知らせる");
    await ctx.close();
  }
  {
    const ctx = await newDevice(browser);
    const p = await open(ctx);
    await addEntry(p, "2026-08-02", "二日目", "");
    await addEntry(p, "2026-08-01", "一日目", "");
    const p2 = await open(ctx);
    await p.bringToFront();
    await p.evaluate(() => { const o = window.imgPut; window.imgPut = (r) => new Promise((res) => setTimeout(res, 350)).then(() => o(r)); });
    await pasteImages(p, 3, { wait: false });
    await waitFor(() => p.evaluate(() => document.querySelectorAll("#contentEditor img[data-did]").length >= 1), { timeout: 8000 });
    // 別のタブが別の日記を保存する → こちらは storage イベントで取り込む（打っている最中は描き直さない）
    await p2.evaluate(async () => { const e = entries.find((x) => x.date === "2026-08-02"); e.title = "二日目（別タブ）"; e.updatedAt = new Date().toISOString(); await saveEntriesToStorage(); });
    await evalT(p, () => window.__pasting);
    await sleep(1500);
    const stored = await p.evaluate(() => JSON.parse(localStorage.getItem("diaryEntries")));
    const one = stored.find((e) => e.date === "2026-08-01");
    ok((one.content.match(/data-did=/g) || []).length === 3, "3b: 別のタブの保存があっても3枚とも本文に残る", one.content);
    ok(stored.some((e) => e.title === "二日目（別タブ）"), "3b: 別のタブの変更も残る");
    await ctx.close();
  }
}

/* ── 4. 同じパスフレーズの2台で、毎回聞かれずに同期できる ── */
if (want(4)) {
  console.log("4) 同じパスフレーズの2台（salt違い）の同期");
  const drive = createFakeDrive();
  const ctxC = await newDevice(browser, { drive });
  const ctxD = await newDevice(browser, { drive });
  const C = await open(ctxC);
  await addEntry(C, "2026-07-01", "C日記", "<p>C</p>");
  await setPass(C, "same-pass-9");
  await C.evaluate(() => drivePushAll(false));
  const saltC = await C.evaluate(() => encMeta.salt);
  let D = await open(ctxD);
  await addEntry(D, "2026-07-02", "D日記", "<p>D</p>");
  await setPass(D, "same-pass-9");
  ok(await D.evaluate(() => encMeta.salt) !== saltC, "準備: 2台の salt は別");
  await token(D);
  await D.evaluate(() => drivePullAndMerge(true));   // 初回は鍵が無い（控えだけ残る）
  await D.close();
  D = await open(ctxD);
  ok(await unlock(D, "same-pass-9"), "D: 開ける");
  await D.evaluate(() => drivePullAndMerge(true));
  ok(await D.evaluate(() => entries.some((e) => e.title === "C日記")), "D: 次に開いたときは、パスフレーズを聞かずにCの日記を取り込める");
  ok(D.dialogs.length === 0, "D: 入力を求める画面は出ていない", D.dialogs);
  await D.evaluate(() => drivePushRun(true));
  let d = driveDiary(drive);
  ok(d && isEnc(d.json) && d.json.salt === saltC, "D: Driveは C の salt のまま（Cが聞き直さずに読める）", d && d.json.salt);
  await C.evaluate(() => drivePullAndMerge(true));
  ok(await C.evaluate(() => entries.some((e) => e.title === "D日記") && !driveSyncProblem), "C: Dの日記をそのまま読めた（同期は止まっていない）");
  // E: 平文のまま Drive を見たあとで、同じパスフレーズで暗号化を有効にする
  const ctxE = await newDevice(browser, { drive });
  const E = await open(ctxE);
  await addEntry(E, "2026-07-03", "E日記", "<p>E</p>");
  await token(E);
  await E.evaluate(() => drivePullAndMerge(true));
  await setPass(E, "same-pass-9");
  await E.evaluate(() => drivePushRun(true));
  d = driveDiary(drive);
  ok(d && isEnc(d.json) && d.json.salt === saltC && d.json && E.dialogs.length === 0, "E: 同じパスフレーズなら Drive の salt のまま書く（聞き直さない）", d && d.json.salt);
  await C.evaluate(() => drivePullAndMerge(true));
  ok(await C.evaluate(() => entries.some((e) => e.title === "E日記") && !driveSyncProblem), "C: Eの日記も読めた");
  // パスフレーズを変えた端末は、Drive も新しい鍵で書き直す
  await setPass(C, "new-pass-10");
  await C.evaluate(() => drivePushAll(false));
  d = driveDiary(drive);
  const saltC2 = await C.evaluate(() => encMeta.salt);
  ok(d && isEnc(d.json) && d.json.salt === saltC2, "C: パスフレーズを変えたら Drive も新しい鍵になる");
  await ctxC.close(); await ctxD.close(); await ctxE.close();
}

/* ── 5. 同期のたびに写真を全部書き直さない ── */
if (want(5)) {
  console.log("5) 同期で写真を書き直さない");
  const drive = createFakeDrive();
  const ctx = await newDevice(browser, { drive });
  const p = await open(ctx);
  await addEntry(p, "2026-06-01", "写真", "");
  await pasteImages(p, 3);
  await p.evaluate(() => saveEntry(true));
  await p.evaluate(() => drivePushAll(false));
  await countImgPut(p);
  await p.evaluate(() => drivePullAndMerge(false));
  await p.evaluate(() => drivePushAll(false));
  ok(await p.evaluate(() => window.__imgPuts) === 0, "5: 端末にある画像は、取り込み・書き戻しで書き直さない", await p.evaluate(() => window.__imgPuts));
  const gone = await p.evaluate(async () => { const k = (await imgKeys())[0]; await imgDelete(k); return k; });
  await countImgPut(p);
  await p.evaluate(() => drivePullAndMerge(false));
  ok(await p.evaluate(() => window.__imgPuts) === 1, "5: 端末に無い画像だけ受け取る");
  ok(await p.evaluate(async (k) => !!(await imgDecode(await imgGet(k))), gone), "5: 受け取った画像は読める");
  await setPass(p, "five-pass-5");
  await p.evaluate(() => drivePushAll(false));
  await countImgPut(p);
  await p.evaluate(() => drivePullAndMerge(false));
  ok(await p.evaluate(() => window.__imgPuts) === 0, "5: 暗号化していても書き直さない");
  await ctx.close();
}

/* ── 6. 別のタブで暗号化の設定が変わった古いタブは同期しない ── */
if (want(6)) {
  console.log("6) 古いタブは同期しない");
  const drive = createFakeDrive();
  const ctx = await newDevice(browser, { drive });
  const t1 = await open(ctx);
  await addEntry(t1, "2026-05-01", "タブ", "<p>tab</p>");
  await token(t1);
  const t2 = await open(ctx);
  await setPass(t1, "tab-pass-1");
  await waitFor(() => t2.evaluate(() => !!storageConflict), { timeout: 5000 }).catch(() => {});
  ok(await t2.evaluate(() => !!storageConflict), "6: 古いタブは設定の食い違いに気づく");
  ok(await t2.evaluate(() => !!syncBlockedReason()), "6: 古いタブでは同期を止める理由が返る");
  const n0 = drive.log.length;
  await t2.evaluate(() => drivePushRun(true));
  await t2.evaluate(() => drivePullAndMerge(true));
  ok(drive.log.length === n0, "6: 古いタブからは Drive に触らない（シェルの「今すぐ同期」も含む）", drive.log.slice(n0));
  ok(await t2.evaluate(async () => (await insertImageFiles([new File([new Uint8Array([1])], "x.png", { type: "image/png" })])) === 0), "6: 古いタブでは画像も書かない");
  await ctx.close();
}

/* ── 7. 保存中・画面を離れる直前に打った文字 ── */
if (want(7)) {
  console.log("7) 保存中に打った文字・離れる直前の文字");
  const ctx = await newDevice(browser);
  const p = await open(ctx);
  await addEntry(p, "2026-04-01", "打鍵", "");
  const type = (text) => p.evaluate((t) => { const ed = document.getElementById("contentEditor"); ed.innerHTML = t; ed.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  const stored = () => p.evaluate(() => (JSON.parse(localStorage.getItem("diaryEntries")).find((e) => e.date === "2026-04-01") || {}).content || "");
  await type("first");
  await p.evaluate(() => { const o = window.saveEntriesToStorage; window.__origSave = o; window.saveEntriesToStorage = (...a) => o(...a).then((r) => new Promise((res) => setTimeout(() => res(r), 400))); window.__s = saveEntry(true); });
  await sleep(100);   // 書き込みは済んだが、保存の await はまだ終わっていない間に打つ
  await type("first second");
  await evalT(p, () => window.__s);
  ok(await p.evaluate(() => isDirty), "7: 保存の途中で打った分は「未保存」のまま残る");
  await p.evaluate(() => { window.saveEntriesToStorage = window.__origSave; });
  await sleep(1500);
  ok((await stored()).includes("second"), "7: 保存の途中で打った分も、あとで保存される", await stored());
  await type("third");
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await sleep(250);
  ok((await stored()).includes("third"), "7: 画面が隠れたらすぐ保存する");
  await p.evaluate(() => { delete document.visibilityState; });
  await type("fourth");
  await p.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await sleep(250);
  ok((await stored()).includes("fourth"), "7: ページを離れるときもすぐ保存する");
  await ctx.close();
}

/* ── 8. 削除の記録 ── */
if (want(8)) {
  console.log("8) 削除の記録（墓標）");
  const ctx = await newDevice(browser);
  const p = await open(ctx);
  await addEntry(p, "2026-03-01", "消す1", "<p>x</p>");
  const id1 = await p.evaluate(() => currentEntry.id);
  await p.evaluate(() => {
    window.__order = [];
    const o = Storage.prototype.setItem;
    window.__origSetItem = o;
    Storage.prototype.setItem = function (k, v) { window.__order.push(k); return o.call(this, k, v); };
  });
  await p.evaluate(() => deleteEntry());
  const order = await p.evaluate(() => window.__order.filter((k) => k === "diaryEntries" || k === "diaryDeleted"));
  ok(order.indexOf("diaryEntries") >= 0 && order.indexOf("diaryEntries") < order.indexOf("diaryDeleted"), "8: 日記を保存してから墓標を書く", order);
  ok(await p.evaluate((id) => JSON.parse(localStorage.getItem("diaryDeleted")).some((t) => t.id === id), id1), "8: 墓標が保存される");
  // 墓標が書けない（容量不足）
  await addEntry(p, "2026-03-02", "消す2", "<p>y</p>");
  const id2 = await p.evaluate(() => currentEntry.id);
  await p.evaluate(() => {
    const o = window.__origSetItem;
    Storage.prototype.setItem = function (k, v) { if (k === "diaryDeleted") { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; } return o.call(this, k, v); };
  });
  await p.evaluate(() => deleteEntry());
  ok(await toastSeen(p, /削除の記録/), "8: 墓標を書けなかったことを知らせる");
  ok(await p.evaluate((id) => !JSON.parse(localStorage.getItem("diaryEntries")).some((e) => e.id === id), id2), "8: 日記自体は消えている");
  ok(await p.evaluate((id) => loadTombstones().some((t) => t.id === id), id2), "8: 書けなかった墓標も、このあとの同期には載る");
  await p.evaluate(() => { Storage.prototype.setItem = window.__origSetItem; });
  // 日記の保存に失敗したら、消さずに戻す
  await addEntry(p, "2026-03-03", "消す3", "<p>z</p>");
  const id3 = await p.evaluate(() => currentEntry.id);
  await p.evaluate(() => {
    const o = window.__origSetItem;
    Storage.prototype.setItem = function (k, v) { if (k === "diaryEntries") { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; } return o.call(this, k, v); };
  });
  await p.evaluate(() => deleteEntry());
  await p.evaluate(() => { Storage.prototype.setItem = window.__origSetItem; });
  ok(await p.evaluate((id) => entries.some((e) => e.id === id) && !loadTombstones().some((t) => t.id === id), id3), "8: 保存できなければ削除を取り消し、墓標も残さない");
  await ctx.close();
}

/* ── 9〜12 ── */
if (want(9)) {
  console.log("9) ありえない反復回数");
  const ctx = await newDevice(browser);
  let p = await open(ctx);
  await p.evaluate(() => {
    const b = (n) => ENC.b64(crypto.getRandomValues(new Uint8Array(n)));
    localStorage.setItem("diaryEntries", JSON.stringify({ __enc__: 1, v: 1, kdf: "PBKDF2-SHA256", iter: 2000000000, salt: b(16), iv: b(12), ct: b(48) }));
  });
  await p.close();
  p = await open(ctx);
  const t0 = Date.now();
  let timedOut = false;
  try { await unlock(p, "whatever-1"); } catch (e) { timedOut = true; }
  ok(!timedOut && Date.now() - t0 < 5000, "9: 鍵の計算を始めずにすぐ断る（タブが固まらない）", Date.now() - t0);
  ok(await toastSeen(p, /反復回数/), "9: 理由を伝える");
  const r = await evalT(p, () => decryptIncomingBlob({ __enc__: 1, iter: 5, salt: "AAAA", iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }).then(() => "ok", (e) => e.message), null, 5000).catch(() => "TIMEOUT");
  ok(r === "BAD_ITER" && !p.dialogs.some((x) => x.type === "prompt"), "9: 取り込み・Driveの暗号文も、パスフレーズを聞く前に断る", r);
  await ctx.close();
}
if (want(10)) {
  console.log("10) 画像は data:image だけ");
  const ctx = await newDevice(browser);
  const p = await open(ctx);
  const reqs = [];
  p.on("request", (r) => reqs.push(r.url()));
  await p.evaluate((u) => restoreImages([{ id: "iabcdef12", dataUrl: u + "probe-restore.png" }, { id: "iabcdef13", dataUrl: "blob:" + u + "x" }]), srv.url);
  await sleep(300);
  ok(!reqs.some((u) => /probe-restore/.test(u)), "10: data:image 以外の URL は読まない", reqs);
  ok(await p.evaluate(async () => !(await imgGet("iabcdef12")) && !(await imgGet("iabcdef13"))), "10: 画像として保存もしない");
  await ctx.close();
}
if (want(11)) {
  console.log("11) 配列でない中身");
  const ctx = await newDevice(browser);
  let p = await open(ctx);
  const raw = await p.evaluate(async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await ENC.deriveKey("pw-eleven-1", salt, 250000);
    const blob = await ENC.encryptString(JSON.stringify({ not: "array" }), key, salt, 250000);
    localStorage.setItem("diaryEntries", JSON.stringify(blob));
    return localStorage.getItem("diaryEntries");
  });
  await p.close();
  p = await open(ctx);
  await unlock(p, "pw-eleven-1");
  ok(await p.evaluate(() => appLocked), "11: 中身の形が違えばロックしたまま");
  ok(await p.evaluate(() => localStorage.getItem("diaryEntries")) === raw, "11: 元のデータには手を付けない");
  ok(await toastSeen(p, /形/), "11: 理由を伝える");
  await ctx.close();
}
if (want(12)) {
  console.log("12) 書き出しで <img> を読み込まない");
  const ctx = await newDevice(browser);
  const p = await open(ctx);
  const reqs = [];
  p.on("request", (r) => reqs.push(r.url()));
  const out = await p.evaluate(() => serializeEditor({ innerHTML: '<p>a</p><img data-did="iabcd1234" src="/probe-ser.png" alt="x"><img src="/probe-ser2.png"><span data-imgnote="1">札</span>' }));
  await sleep(400);
  ok(out === '<p>a</p><img data-did="iabcd1234" alt="x">', "12: 保存する形は変わらない", out);
  ok(!reqs.some((u) => /probe-ser/.test(u)), "12: 書き出しのときに画像を読みに行かない", reqs.filter((u) => /probe/.test(u)));
  await ctx.close();
}

/* ── パス2: NKSync.drive への移行と、写真ごとのファイル ── */
if (want("p2")) {
  console.log("p2) Drive の写真を1枚ずつ別のファイルに・NKSync.drive");
  const STD = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.events";
  const dyFiles = (drive) => [...drive.files.values()].filter((f) => f.name.startsWith("dy-img-") && !f.trashed);
  const posts = (drive) => drive.log.filter((x) => x.method === "POST" && x.path === "/upload/drive/v3/files").length;
  const hasMagic = (buf) => buf.includes(Buffer.from([0xff, 0xd8, 0xff])) || buf.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    || buf.includes(Buffer.from("/9j/")) || buf.includes(Buffer.from("iVBORw0KGgo"));
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const imgIdsOf = (page) => page.evaluate(() => [...new Set(entries.flatMap((e) => contentImageIds(e.content)))]);
  const PNG1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const legacyEntry = (id, date, title, html) => ({ id, date, title, content: html, contentFormat: "html", tags: [], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });

  // a) A が写真つきの日記を書く → 写真は別ファイル、diary.json には入らない → B が受け取れる
  {
    const drive = createFakeDrive();
    const ctxA = await newDevice(browser, { drive });
    const ctxB = await newDevice(browser, { drive });
    const A = await open(ctxA);
    await addEntry(A, "2026-09-10", "写真の日", "<p>photo</p>");
    await pasteImages(A, 1);
    await A.evaluate(() => saveEntry(true));
    const [pid] = await imgIdsOf(A);
    await A.evaluate(() => drivePushAll(false));
    let dy = dyFiles(drive);
    ok(dy.length === 1 && dy[0].name === "dy-img-" + pid && dy[0].parents.includes("appDataFolder"), "a: 写真は appDataFolder の dy-img-<画像id> に1枚ずつ置く", dy.map((f) => f.name));
    ok(dy[0] && dy[0].appProperties && dy[0].appProperties.ks === "plain", "a: Drive が平文なら写真も平文（ks=plain）", dy[0] && dy[0].appProperties);
    ok(dy[0] && hasMagic(dy[0].content), "a: （確かめ方の確認）平文の写真には画像の印がある");
    let d = driveDiary(drive);
    ok(d && d.json.imgExternal === 1 && Array.isArray(d.json.images) && d.json.images.length === 0 && !/data:image/.test(d.text), "a: diary.json に写真の中身は入らない（imgExternal: 1）", d && d.text.slice(0, 200));
    const B = await open(ctxB);
    await B.evaluate(() => drivePullAndMerge(false));
    const stB = await imgState(B);
    ok(await B.evaluate(() => entries.some((e) => e.title === "写真の日")) && stB.some((r) => r.id === pid && r.readable), "a: B は写真をファイルから受け取って読める", stB);
    // 2回目の保存では写真を送り直さない
    const n0 = posts(drive);
    await addEntry(A, "2026-09-11", "文字だけ", "<p>text</p>");
    await A.evaluate(() => drivePushAll(false));
    ok(posts(drive) === n0, "a: 2回目の保存で写真を送り直さない（新しく作るファイルが無い）", drive.log.slice(-6));
    // B の再取り込みも写真を書き直さない
    await countImgPut(B);
    await B.evaluate(() => drivePullAndMerge(false));
    ok(await B.evaluate(() => window.__imgPuts) === 0, "a: B の2回目の取り込みでも写真を書き直さない");

    // b) A で暗号化 → 写真も diary.json も作り直し（古いファイルは消える）、中身に画像の印が無い
    const oldPhoto = dy[0].id, oldJson = d.id;
    await setPass(A, "p2-pass-1");
    await A.evaluate(() => drivePushAll(false));
    const salt = await A.evaluate(() => encMeta.salt);
    dy = dyFiles(drive);
    ok(!drive.files.has(oldPhoto) && dy.length === 1 && dy[0].id !== oldPhoto, "b: 平文→暗号化で写真ファイルを作り直し、古いファイルは消す", dy.map((f) => f.id));
    ok(dy[0] && dy[0].appProperties && dy[0].appProperties.ks === salt, "b: 写真ファイルの ks は鍵の salt", dy[0] && dy[0].appProperties);
    ok(dy[0] && !hasMagic(dy[0].content), "b: 暗号化した写真ファイルに画像の印（JPEG/PNG）が無い");
    d = driveDiary(drive);
    ok(d && isEnc(d.json) && d.id !== oldJson && !drive.files.has(oldJson), "b: diary.json も作り直し、平文の古いファイルは消す", d && d.id);
    // B（暗号化なし）は、作り直された diary.json に乗り換えて読める（覚えていたidが消えていても）
    B.answers.push("p2-pass-1");
    await B.evaluate(() => drivePullAndMerge(false));
    ok(await B.evaluate(() => entries.some((e) => e.title === "文字だけ")), "b: B は作り直された diary.json を見つけて読める");
    // 新しい端末 C は暗号化された写真ファイルを受け取って読める
    const ctxC = await newDevice(browser, { drive });
    const C = await open(ctxC);
    C.answers.push("p2-pass-1");
    await C.evaluate(() => drivePullAndMerge(false));
    const stC = await imgState(C);
    ok(stC.some((r) => r.id === pid && r.readable), "b: 新しい端末は暗号化された写真を受け取って読める", stC);
    // B が書き足しても、写真ファイルは平文に戻らない（Drive の鍵で暗号化する）
    await addEntry(B, "2026-09-12", "Bの写真", "");
    await pasteImages(B, 1);
    await B.evaluate(() => saveEntry(true));
    B.answers.push("p2-pass-1");
    await B.evaluate(() => drivePushAll(false));
    dy = dyFiles(drive);
    ok(dy.length === 2 && dy.every((f) => f.appProperties.ks === salt && !hasMagic(f.content)), "b: 暗号化していない端末の写真も Drive の鍵で暗号化して送る", dy.map((f) => f.appProperties));

    // c) パスフレーズ変更の途中で写真の送り直しが失敗しても、写真は Drive から消えない
    await A.evaluate(() => drivePullAndMerge(true));
    await setPass(A, "p2-pass-2");
    const orig = drive.handle;
    let nth = 0;
    drive.handle = async (route) => {
      const req = route.request();
      if (req.method() === "POST" && /upload\/drive\/v3\/files$/.test(new URL(req.url()).pathname) && String(req.postDataBuffer() || "").includes("dy-img-") && nth++ >= 1) {
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":500}}' });
      }
      return orig(route);
    };
    await A.evaluate(() => drivePushAll(false));
    drive.handle = orig;
    const ids = await imgIdsOf(A);
    const byId = (id) => dyFiles(drive).filter((f) => f.name === "dy-img-" + id);
    ok(ids.length === 2 && ids.every((id) => byId(id).length >= 1), "c: 送り直しが途中で失敗しても、どの写真も Drive に残っている", ids.map((id) => byId(id).length));
    d = driveDiary(drive);
    ok(d && d.json.salt === salt, "c: 写真を送り終えるまで diary.json は古い鍵のまま（先に進めない）");
    await A.evaluate(() => drivePushAll(false));
    const salt2 = await A.evaluate(() => encMeta.salt);
    d = driveDiary(drive);
    dy = dyFiles(drive);
    ok(d && d.json.salt === salt2 && dy.length === 2 && dy.every((f) => f.appProperties.ks === salt2), "c: 次の保存で、写真も diary.json も新しい鍵にそろう", dy.map((f) => f.appProperties.ks === salt2));
    const ctxE = await newDevice(browser, { drive });
    const E = await open(ctxE);
    E.answers.push("p2-pass-2");
    await E.evaluate(() => drivePullAndMerge(false));
    const stE = await imgState(E);
    ok(stE.length === 2 && allReadable(stE), "c: 新しいパスフレーズの端末は写真を全部読める", stE);

    // d) 利用者の JSON 書き出しは、写真を中に入れたまま（それだけで戻せる）
    const exp = await A.evaluate(async () => JSON.parse((await buildExportPayload("json")).text));
    ok(exp.images.length === 2 && exp.images.every((x) => /^data:image\//.test(x.dataUrl)), "d: JSON の書き出しには写真が入っている", exp.images.map((x) => String(x.dataUrl).slice(0, 20)));
    const share = await A.evaluate(async () => { const o = await buildSyncObject(); return JSON.parse(await ENC.decryptToString(o, cryptoKey)); });
    ok(share.images.length === 2 && !share.imgExternal, "d: 共有のバックアップにも写真が入っている");
    await ctxA.close(); await ctxB.close(); await ctxC.close(); await ctxE.close();
  }

  // e) 写真を中に入れていた旧版の diary.json も読める → 次の保存で写真ファイルへ移る
  {
    const drive = createFakeDrive();
    drive.put("diary.json", { exportDate: "2026-09-01T00:00:00.000Z", entries: [legacyEntry("legacy-1", "2026-08-20", "旧版", '<p>old</p><img data-did="ilegacy1234">')], deleted: [], images: [{ id: "ilegacy1234", type: "image/png", dataUrl: PNG1 }] }, { parents: ["appDataFolder"] });
    const ctx = await newDevice(browser, { drive });
    const p = await open(ctx);
    await p.evaluate(() => drivePullAndMerge(false));
    const st = await imgState(p);
    ok(st.some((r) => r.id === "ilegacy1234" && r.readable), "e: 旧版の diary.json の中の写真を受け取れる", st);
    await p.evaluate(() => drivePushAll(false));
    const d = driveDiary(drive);
    ok(dyFiles(drive).some((f) => f.name === "dy-img-ilegacy1234") && d.json.imgExternal === 1 && d.json.images.length === 0, "e: 次の保存で写真ファイルへ移る（diary.json からは外す）");
    await ctx.close();
  }

  // f) 重複した diary.json は中身を寄せ、しばらく書かれていないものだけゴミ箱へ。開けないものは残す
  {
    const drive = createFakeDrive();
    const ctx = await newDevice(browser, { drive });
    const p = await open(ctx);
    await addEntry(p, "2026-09-01", "本体", "<p>main</p>");
    await p.evaluate(() => drivePushAll(false));
    const main = driveDiary(drive);
    const stale = drive.put("diary.json", { entries: [legacyEntry("dup-old", "2026-08-01", "古い重複にだけある", "<p>x</p>")], deleted: [], images: [] }, { parents: ["appDataFolder"] });
    stale.modifiedTime = daysAgo(10);
    const fresh = drive.put("diary.json", { entries: [legacyEntry("dup-new", "2026-08-02", "新しい重複にだけある", "<p>y</p>")], deleted: [], images: [] }, { parents: ["appDataFolder"] });
    fresh.modifiedTime = daysAgo(1);
    const locked = drive.put("diary.json", { __enc__: 1, v: 1, kdf: "PBKDF2-SHA256", iter: 250000, salt: "c2FsdHNhbHRzYWx0c2FsdA==", iv: "aXZpdml2aXZpdml2", ct: "AAAAAAAAAAAAAAAAAAAAAAAA" }, { parents: ["appDataFolder"] });
    locked.modifiedTime = daysAgo(30);
    await p.evaluate(() => drivePushAll(false));
    const titles = await p.evaluate(() => entries.map((e) => e.title));
    ok(titles.includes("古い重複にだけある") && titles.includes("新しい重複にだけある") && titles.includes("本体"), "f: 重複ファイルの日記も取り込む", titles);
    const m = drive.json(main.id);
    ok(m.entries.length === 3, "f: 寄せた結果を正（いちばん古いもの）に書く", m.entries.map((e) => e.title));
    ok(!!stale.trashed || !drive.files.has(stale.id), "f: 7日以上書かれていない重複はゴミ箱へ");
    ok(!fresh.trashed && drive.files.has(fresh.id), "f: 最近書かれた重複は残す（更新前の端末がまだ書いているかもしれない）");
    ok(!locked.trashed && drive.files.has(locked.id), "f: 開けない重複は捨てない");
    await ctx.close();
  }

  // g) 覚えていたファイルが無くなり別の diary.json に乗り換えても、この端末の日記は消えない
  {
    const drive = createFakeDrive();
    const ctx = await newDevice(browser, { drive });
    const p = await open(ctx);
    await addEntry(p, "2026-09-01", "S1", "<p>1</p>");
    await addEntry(p, "2026-09-02", "S2", "<p>2</p>");
    await p.evaluate(() => drivePushAll(false));
    const f1 = driveDiary(drive);
    drive.files.delete(f1.id);
    drive.put("diary.json", { entries: [legacyEntry("t-1", "2026-08-05", "T1", "<p>t</p>")], deleted: [], images: [] }, { parents: ["appDataFolder"] });
    await p.evaluate(() => drivePushAll(false));
    const d = driveDiary(drive);
    const titles = await p.evaluate(() => entries.map((e) => e.title).sort());
    ok(JSON.stringify(titles) === JSON.stringify(["S1", "S2", "T1"]), "g: 乗り換えても手元の日記は残り、相手の日記も入る", titles);
    ok(d && d.json.entries.length === 3, "g: 乗り換え先にも全部書く", d && d.json.entries.map((e) => e.title));
    ok(await p.evaluate((id) => localStorage.getItem("diary:gd:syncfile") === id, d.id), "g: 最後に同期したファイルを覚える");
    await ctx.close();
  }

  // h) 同じ端末の2つのタブが同時に保存しても、diary.json も写真も1つずつ・日記は両方残る
  {
    const drive = createFakeDrive();
    const ctx = await newDevice(browser, { drive });
    const t1 = await open(ctx);
    await addEntry(t1, "2026-09-01", "タブ1", "");
    await pasteImages(t1, 1);
    await t1.evaluate(() => saveEntry(true));
    await token(t1);
    const t2 = await open(ctx);
    await addEntry(t2, "2026-09-02", "タブ2", "<p>2</p>");
    await Promise.all([t1.evaluate(() => drivePushAll(false)), t2.evaluate(() => drivePushAll(false))]);
    const files = drive.byName("diary.json");
    const d = driveDiary(drive);
    ok(files.length === 1, "h: diary.json は1つだけ（同時に作らない）", files.length);
    ok(d && ["タブ1", "タブ2"].every((t) => d.json.entries.some((e) => e.title === t)), "h: 両方のタブの日記が Drive に載る", d && d.json.entries.map((e) => e.title));
    ok(dyFiles(drive).length === 1, "h: 写真も1つだけ", dyFiles(drive).length);
    await ctx.close();
  }

  // i) Drive の写真の掃除: 使われていない＆30日以上書かれていないものだけ。1日1回
  {
    const drive = createFakeDrive();
    const ctx = await newDevice(browser, { drive });
    const p = await open(ctx);
    await addEntry(p, "2026-09-01", "写真", "");
    await pasteImages(p, 1);
    await p.evaluate(() => saveEntry(true));
    await p.evaluate(() => drivePushAll(false));
    const used = dyFiles(drive)[0];
    used.modifiedTime = daysAgo(40);
    const old1 = drive.put("dy-img-iold000001", "x", { parents: ["appDataFolder"], mimeType: "image/jpeg" }); old1.modifiedTime = daysAgo(40);
    const new1 = drive.put("dy-img-inew000001", "x", { parents: ["appDataFolder"], mimeType: "image/jpeg" }); new1.modifiedTime = daysAgo(5);
    await p.evaluate(() => localStorage.removeItem("diary:gd:imggc"));
    await p.evaluate(() => drivePushAll(false));
    ok(!drive.files.has(old1.id), "i: 使われていない30日以上前の写真は消す");
    ok(drive.files.has(new1.id), "i: 使われていなくても新しい写真は残す（まだ diary.json に載せていない端末があるかもしれない）");
    ok(drive.files.has(used.id), "i: 使っている写真は古くても残す");
    const old2 = drive.put("dy-img-iold000002", "x", { parents: ["appDataFolder"], mimeType: "image/jpeg" }); old2.modifiedTime = daysAgo(40);
    await addEntry(p, "2026-09-02", "次", "<p>n</p>");
    await p.evaluate(() => drivePushAll(false));
    ok(drive.files.has(old2.id), "i: 掃除は1日1回まで");
    // 日記を読めないときは掃除しない
    await p.evaluate(() => localStorage.removeItem("diary:gd:imggc"));
    const d = driveDiary(drive);
    drive.write(d.id, "{ broken");
    await p.evaluate(() => drivePushAll(false));
    ok(drive.files.has(old2.id), "i: diary.json を読めなかったときは掃除しない");
    await ctx.close();
  }

  // j) 入口が取った（権限の記録つきの）トークンを、ログイン画面を出さずに使う
  {
    const drive = createFakeDrive();
    const ctx = await newDevice(browser, { drive });
    const p = await open(ctx);
    await addEntry(p, "2026-09-01", "入口から", "<p>s</p>");
    await p.evaluate((STD) => localStorage.setItem("shared:gd:token", JSON.stringify({ token: "fake." + btoa(STD), exp: Date.now() + 3600000, scope: STD })), STD);
    await p.evaluate(() => drivePushRun(true));   // 入口の「今すぐ全部同期」と同じ呼び方
    ok(!!driveDiary(drive), "j: 入口のトークンで同期できた");
    ok((await p.evaluate(() => window.__fakeGisCalls || [])).length === 0, "j: ログイン画面（トークンの要求）を出していない");
    // 権限の足りないトークン（drive.file だけ）は使わない
    await p.evaluate(() => localStorage.setItem("shared:gd:token", JSON.stringify({ token: "fake." + btoa("https://www.googleapis.com/auth/drive.file"), exp: Date.now() + 3600000, scope: "https://www.googleapis.com/auth/drive.file" })));
    const n0 = drive.log.length;
    await p.evaluate(() => drivePushRun(true));
    ok(drive.log.length === n0, "j: 権限の足りないトークンでは自動同期しない（403 を起こさない）");
    await ctx.close();
  }

  // l) 正のファイルが平文でも、開ける重複が暗号文なら、暗号文の中身を平文で書き写さない
  {
    const drive = createFakeDrive();
    const ctx = await newDevice(browser, { drive });
    const p = await open(ctx);
    drive.put("diary.json", { entries: [legacyEntry("plain-1", "2026-08-01", "平文の正", "<p>p</p>")], deleted: [], images: [] }, { parents: ["appDataFolder"] });
    const encDup = await p.evaluate(async () => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await ENC.deriveKey("dup-pass-1", salt, 250000);
      const body = { entries: [{ id: "enc-1", date: "2026-08-02", title: "暗号の重複", content: "<p>secret</p>", contentFormat: "html", tags: [], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }], deleted: [], images: [] };
      return await ENC.encryptString(JSON.stringify(body), key, salt, 250000);
    });
    const dupF = drive.put("diary.json", encDup, { parents: ["appDataFolder"] });
    dupF.modifiedTime = daysAgo(1);
    // この端末（暗号化なし）は重複の鍵を知っている（手動の取り込みでパスフレーズを入れた）
    p.answers.push("dup-pass-1");
    await p.evaluate((b) => decryptIncomingBlob(b), encDup);
    await p.evaluate(() => drivePushAll(false));
    const all = drive.byName("diary.json");
    ok(all.length >= 1 && all.every((f) => isEnc(JSON.parse(f.content.toString("utf8")))), "l: 暗号文の重複の中身を、平文の diary.json に書き写さない", all.map((f) => f.content.toString("utf8").slice(0, 40)));
    ok(!JSON.stringify(all.map((f) => f.content.toString("utf8"))).includes("secret"), "l: Drive のどこにも平文の本文が無い");
    ok(await p.evaluate(() => ["平文の正", "暗号の重複"].every((t) => entries.some((e) => e.title === t))), "l: 両方の日記は手元に入る");
    await ctx.close();
  }

  // k) sync.js が古いまま（NKSync.drive が無い）なら、同期せずに再読み込みを頼む
  {
    const drive = createFakeDrive();
    const ctx = await newDevice(browser, { drive });
    await ctx.route(/\/sync\.js$/, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "window.NKSync = { create: function(){} };" }));
    const p = await open(ctx);
    await addEntry(p, "2026-09-01", "古い部品", "<p>s</p>");
    await p.evaluate(() => drivePushAll(false));
    ok(drive.log.length === 0, "k: Drive に触らない");
    ok(await toastSeen(p, /再読み込み/), "k: 再読み込みを頼む");
    await ctx.close();
  }
}

ok(pageErrors.length === 0, "ページの未処理の例外が無い", pageErrors);
await browser.close();
await srv.close();
done();
