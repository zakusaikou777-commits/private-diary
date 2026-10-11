#!/usr/bin/env python3
"""配布用ZIPの作り直し（配布には不要）

kininari-clipper/ フォルダを ZIP にまとめ、clipper.html のダウンロードボタン
（<a id="dl" href="data:application/zip;base64,...">）に埋め込み直す。
あわせて clipper.html に表示するバージョン（<b id="ver">）を manifest.json に合わせる。

  python3 .tools/build-clipper.py           … 作り直して clipper.html を書き換える
  python3 .tools/build-clipper.py --check   … 埋め込みがフォルダと同じか確かめるだけ（違えば終了コード1）

・ZIPの中は kininari-clipper/ フォルダ1つにまとめる（clipper.html の手順1で
  「解凍すると kininari-clipper フォルダができる」と案内しているため）。
・何度作っても同じバイト列になるように、日時は固定・並びは名前順にする
  （中身が変わっていないのに clipper.html の差分が出ないように）。
"""
import base64
import io
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "kininari-clipper"
HTML = ROOT / "clipper.html"
TOP = "kininari-clipper/"
STAMP = (1980, 1, 1, 0, 0, 0)  # ZIPで表せるいちばん古い日時（作るたびに変わらないように）

DATA_RE = re.compile(r'(href="data:application/zip;base64,)([A-Za-z0-9+/=]*)(")')
VER_RE = re.compile(r'(<b id="ver">)([^<]*)(</b>)')


def source_files():
    # 隠しファイル（.DS_Store など）は入れない
    return sorted(p for p in SRC.rglob("*") if p.is_file() and not any(part.startswith(".") for part in p.relative_to(SRC).parts))


def build_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        d = zipfile.ZipInfo(TOP, date_time=STAMP)
        d.create_system = 3                      # Unix（解凍したときの権限を普通にする）
        d.external_attr = (0o40755 << 16) | 0x10  # ディレクトリ
        z.writestr(d, b"")
        for p in source_files():
            info = zipfile.ZipInfo(TOP + p.relative_to(SRC).as_posix(), date_time=STAMP)
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, p.read_bytes(), compresslevel=9)
    return buf.getvalue()


def embedded(html):
    m = DATA_RE.findall(html)
    if len(m) != 1:
        sys.exit("clipper.html の埋め込みZIP（data:application/zip;base64,…）が %d か所見つかりました（1か所のはず）" % len(m))
    return base64.b64decode(m[0][1])


def same_as_folder(data):
    """埋め込みZIPの中身がフォルダと同じか（違う所の一覧を返す。空なら同じ）"""
    diffs = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = {n for n in z.namelist() if not n.endswith("/")}
        want = {TOP + p.relative_to(SRC).as_posix(): p for p in source_files()}
        for n in sorted(names - set(want)):
            diffs.append("ZIPにだけある: " + n)
        for n in sorted(set(want) - names):
            diffs.append("ZIPに無い: " + n)
        for n in sorted(names & set(want)):
            if z.read(n) != want[n].read_bytes():
                diffs.append("中身が違う: " + n)
    return diffs


def main():
    version = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))["version"]
    html = HTML.read_bytes().decode("utf-8")  # 改行コードを変えないよう、そのまま読む
    if "--check" in sys.argv[1:]:
        diffs = same_as_folder(embedded(html))
        vm = VER_RE.search(html)
        if not vm or vm.group(2) != version:
            diffs.append("表示しているバージョンが違う: %s（manifest.json は %s）" % (vm.group(2) if vm else "なし", version))
        for d in diffs:
            print("✗ " + d)
        print("埋め込みZIPはフォルダと同じです" if not diffs else "埋め込みZIPを作り直してください: python3 .tools/build-clipper.py")
        sys.exit(1 if diffs else 0)

    data = build_zip()
    b64 = base64.b64encode(data).decode("ascii")
    embedded(html)  # ちょうど1か所あることを先に確かめる
    out = DATA_RE.sub(lambda m: m.group(1) + b64 + m.group(3), html, count=1)
    if not VER_RE.search(out):
        sys.exit('clipper.html にバージョン表示（<b id="ver">）が見つかりません')
    out = VER_RE.sub(lambda m: m.group(1) + version + m.group(3), out, count=1)
    if out != html:
        HTML.write_bytes(out.encode("utf-8"))
    print("clipper.html: version %s / ZIP %d バイト（%d ファイル）%s" % (
        version, len(data), len(source_files()), "" if out != html else "（変更なし）"))
    diffs = same_as_folder(embedded(out))
    if diffs:
        sys.exit("\n".join(diffs))


if __name__ == "__main__":
    main()
