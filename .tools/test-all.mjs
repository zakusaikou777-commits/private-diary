/* この版の検証をまとめて流す（配布には不要。要 playwright）
     node .tools/test-all.mjs            … 構文チェック＋全部
     node .tools/test-all.mjs tasks bgm  … 名前に含む検証だけ（test-fix-<名前>.mjs）
   1本ずつ順に流し、最後に成功/失敗の一覧を出す。どれかが失敗すると終了コードは 1。 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/harness.mjs";

const want = process.argv.slice(2);
const dir = path.join(ROOT, ".tools");
const tests = fs.readdirSync(dir)
  .filter((f) => /^test-fix-.*\.mjs$/.test(f))
  .filter((f) => !want.length || want.some((w) => f.includes(w)))
  .sort();
const runs = [["check-all.mjs", []], ...tests.map((f) => [f, []])];
const out = [];
for (const [f, args] of runs) {
  const t0 = Date.now();
  console.log(`\n━━ ${f} ━━`);
  const r = spawnSync(process.execPath, [path.join(dir, f), ...args], { cwd: ROOT, encoding: "utf8", timeout: 20 * 60 * 1000 });
  const text = (r.stdout || "") + (r.stderr || "");
  const fails = text.split("\n").filter((l) => /^\s*✗/.test(l));
  const last = text.trim().split("\n").slice(-1)[0] || "";
  fails.forEach((l) => console.log(l));
  console.log(last);
  out.push({ f, ok: r.status === 0, sec: Math.round((Date.now() - t0) / 1000), last });
}
console.log("\n━━ まとめ ━━");
out.forEach((o) => console.log(`${o.ok ? "✓" : "✗"} ${o.f.padEnd(28)} ${String(o.sec).padStart(4)}秒  ${o.last}`));
process.exitCode = out.every((o) => o.ok) ? 0 : 1;
