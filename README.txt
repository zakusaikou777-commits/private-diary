日記帳 & 気になり帳 一式

【中身】
- index.html ……… 入口（タブで日記帳/気になり帳を切替）
- kininari.html …… 気になり帳本体（クリップ取り込み対応）
- diary.html ……… 日記帳本体
- sw.js …………… タスク通知用
- clipper.html …… Chrome拡張の説明＆ダウンロードページ（ZIP同梱）
- kininari-clipper/ … Chrome拡張のフォルダ（そのまま読み込めます）

━━━━━━━━━━━━━━━━━━
【1. サイトに置く（ホスティング）】
次の5つを「同じフォルダ」に置き、https で公開してください。
  index.html / kininari.html / diary.html / sw.js / clipper.html
- 開くときは index.html。
- file:// では動きません（ログイン・カレンダー・通知のため https 必須）。
- 無料の例: GitHub Pages、Netlify、Cloudflare Pages など。

【2. Chrome拡張（ニュースを気になり帳に保存）】
1) Chromeで chrome://extensions を開く
2) 右上「デベロッパーモード」をオン
3)「パッケージ化されていない拡張機能を読み込む」→ kininari-clipper フォルダを選択
4) ツールバーの「気」アイコン → ⚙ に、自分の kininari.html のURL（https）を入力
   例: https://yourname.github.io/app/kininari.html
5) 以降、ページで「気」アイコン → 保存
※ clipper.html をサイトに置けば、そのページからも拡張をダウンロードできます。

【3. Google連携（ドライブ/カレンダー）の事前設定】
アプリ内の ❓ ヘルプ画面に手順をまとめています（API有効化・スコープ・JavaScript生成元の登録など）。

【データについて】
すべて自分専用です。データは自分の端末に保存され、Google連携も自分のアカウント/自分のクライアントIDのみを使います。
