/* ============================================================
   検証用の共通部品（配布には不要）

   - startServer(): リポジトリ直下を http://127.0.0.1:<port>/ で配る
     （127.0.0.1 は「安全なオリジン」扱いなので crypto.subtle・locks が使える）
   - launch(): 同梱の Chromium を起動（PLAYWRIGHT_BROWSERS_PATH のもの）
   - newDevice(): 端末1台ぶん（= ブラウザのコンテキスト1つ）を作る。
       * accounts.google.com/gsi/client は偽物（gis-stub）に差し替える
       * www.googleapis.com の Drive は fake-drive.mjs に向ける
         （同じ drive を渡せば、2台が同じドライブを見る）
       * それ以外の外部通信（YouTube など）は空で返す
   使い方は .tools/test-*.mjs を参照。
   ============================================================ */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// playwright は全体に入れたもの（NODE_PATH）を使う。import だと全体の場所を探さないので require で読む
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8", ".css": "text/css"
};

export function startServer(root = ROOT) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    const buf = fs.readFileSync(f);
    const type = TYPES[path.extname(f)] || "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      let s = range[1] === "" ? Math.max(0, buf.length - Number(range[2])) : Number(range[1]);
      let e = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${s}-${e}/${buf.length}`, "Content-Length": e - s + 1, "Accept-Ranges": "bytes" });
      res.end(buf.subarray(s, e + 1));
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    res.end(buf);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

export async function launch(opts = {}) {
  return chromium.launch({ headless: true, ...opts });
}

export const GIS_STUB = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "gis-stub.js"), "utf8");

/** 端末1台ぶん。opts.serviceWorkers は既定で "block"（キャッシュが検証の邪魔をしないように）。
 *  opts.onExternal(route) を渡すと、Drive 以外の Google API（カレンダー・タスク）を自分で答えられる。 */
export async function newDevice(browser, { drive = null, serviceWorkers = "block", onExternal = null, contextOptions = {} } = {}) {
  const context = await browser.newContext({ serviceWorkers, ...contextOptions });
  await context.route("https://accounts.google.com/**", (route) => {
    const u = route.request().url();
    if (u.includes("/gsi/client")) return route.fulfill({ status: 200, contentType: "text/javascript", body: GIS_STUB });
    return route.fulfill({ status: 204, body: "" });
  });
  await context.route("https://www.googleapis.com/**", async (route) => {
    const u = new URL(route.request().url());
    if (drive && (u.pathname.startsWith("/drive/") || u.pathname.startsWith("/upload/drive/"))) return drive.handle(route);
    if (onExternal) { const r = await onExternal(route); if (r !== false) return; }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: 404 } }) });
  });
  // そのほかの外部（YouTube の iframe API、oEmbed、フォントなど）は空で返す
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
    const u = route.request().url();
    if (/googleapis\.com|accounts\.google\.com/.test(u)) return route.fallback();
    return route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
  });
  return context;
}

/** ページの console のエラーと未処理の例外を集める（検証の最後に空かどうかを見る） */
export function collectErrors(page) {
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  return errs;
}

/** 小さな検証用アサート。失敗しても続けて、最後に件数を返す */
export function makeChecker(name) {
  let pass = 0, fail = 0;
  const ok = (cond, label, extra) => {
    if (cond) { pass++; console.log("  ✓ " + label); }
    else { fail++; console.log("  ✗ " + label + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 400) : "")); }
    return !!cond;
  };
  const done = () => {
    console.log(`${name}: ${pass} 件成功 / ${fail} 件失敗`);
    if (fail) process.exitCode = 1;
    return fail === 0;
  };
  return { ok, done };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 条件が真になるまで待つ（page.waitForFunction のページ外版） */
export async function waitFor(fn, { timeout = 10000, interval = 50, label = "条件" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(label + " を待ちきれませんでした");
    await sleep(interval);
  }
}
