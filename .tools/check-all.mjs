/* 全ファイルの構文チェック（配布には不要）
   各 HTML の中の <script>（src の無いもの）と、単体の .js を node --check に通す。
     node .tools/check-all.mjs            … 全部
     node .tools/check-all.mjs tasks.html … 指定したものだけ */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { ROOT } from "./lib/harness.mjs";

const args = process.argv.slice(2);
const targets = args.length ? args : [
  ...fs.readdirSync(ROOT).filter((f) => /\.(html|js)$/.test(f)),
  ...fs.readdirSync(path.join(ROOT, "kininari-clipper")).filter((f) => f.endsWith(".js")).map((f) => "kininari-clipper/" + f)
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nkcheck-"));
let bad = 0, n = 0;
function check(file, code, label) {
  const p = path.join(tmp, label.replace(/[^\w.-]/g, "_") + ".js");
  fs.writeFileSync(p, code);
  n++;
  try { execFileSync(process.execPath, ["--check", p], { stdio: "pipe" }); }
  catch (e) { bad++; console.log("✗ " + label + "\n" + String(e.stderr || e.message).split("\n").slice(0, 6).join("\n")); }
}
for (const t of targets) {
  const f = path.join(ROOT, t);
  const s = fs.readFileSync(f, "utf8");
  if (t.endsWith(".js")) { check(f, s, t); continue; }
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(s))) {
    if (/type=/.test(m[1]) && !/javascript|module/.test(m[1])) continue;
    const line = s.slice(0, m.index).split("\n").length;
    // 行番号を合わせるため、前に空行を詰める
    check(f, "\n".repeat(line - 1) + m[2], `${t}:${line}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `構文エラー ${bad} 件（${n} ブロック中）` : `構文OK（${n} ブロック）`);
process.exitCode = bad ? 1 : 0;
