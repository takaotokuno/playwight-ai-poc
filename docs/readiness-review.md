# 開発開始までの整合性レビュー

確認日: 2026-10-10（Asia/Tokyo）

対象は、公開リポジトリのクローン → デスクトップアプリのローカルセッション → README のセットアップ → 仕様取り込み・テスト開発の開始。
2026-10-10 の監査時は機能コードを変更せず、再現操作は必要に応じて配布候補コピーで行った。以下の当初の判定・指摘を履歴として保持し、2026-10-11 の修正状況を追記する。

## 修正状況（2026-10-11）

利用者が採用した設計判断:

- native の config は agents:init --config で明示的に選び、MCP を再接続する。workflow の不一致は開始前に拒否する。
- 既存計画が採用済み条件と不一致なら原本を保持して停止する。親が変更候補を確認し、既存メモを残して更新する。

| 指摘 | 修正・確認 |
| --- | --- |
| OS 固有の MCP 設定 | 選択したアプリだけを現在の Node と共通 launcher に接続。公式の旧生成形式は更新し、独自引数・環境変数の設定は保持。接続設定はローカル生成物として配布対象外 |
| native config の不一致 | provider ごとの config とハッシュを記録。開始・再開・launcher 起動で一致を検査。切替・編集後の再初期化と再接続を文書化 |
| 計画の消失・不一致 | 既存行・メモを再利用し、未作成 AC を追記。不一致では変更候補を出して停止。Planner による既存行の削除も拒否 |
| plan の省略引数 | 空配列と省略を統一。公開 CLI 経由の回帰テストで確認 |
| worker の矛盾 | 親が対話・台帳・実行記録を担当し、worker は質問・成果物を返す。役割定義から別 MCP の再設定を除去 |
| 開始チェック | setup:check で実際の MCP 接続・必要ツール・seed を検査。アプリ内の接続と子への委譲は別の確認として手順を明記 |
| ヘルプ・検証範囲 | provider / transport / receipt を明記。JavaScript 構文検査を追加し、TypeScript の型検査と区別 |
| デモ・余分な生成 | 新規の独立デモで取り込みから実行まで確認。空きポートを使い、既存台帳を変更しない。既定の対象は Codex / Claude と Chromium。VS Code は任意、Copilot workflow は生成しない |
| 未追跡の実装 | 利用者の指示に従い、実装・設定手順と監査記録を適切な単位でコミット。push は今回の指示に含まれない |

修正後の確認:

- 実装コミット `1c4c61f43a7c5a686b1dd07138fa3c283f06cd23` のローカルクローンで、既存台帳・計画・接続設定を持ち込まずに `npm ci --offline`、`agents:init --loop=all --config playwright.config.ts`、`npm run check`、`npm run demo:check` が成功した。依存パッケージは既存キャッシュ、Chromium は既存のインストールを使用したため、未準備マシンでのネットワーク取得はこの確認に含めない。初期化後の追跡ファイルに差分はなかった。
- npm run check: 整形・JavaScript 構文・TypeScript・回帰テスト37件・台帳の整合性が成功。
- npm run demo:check: 独立ディレクトリの取り込み・架空の判断・計画・2 AC の実行が成功。
- agents:init --loop=all --config playwright.demo.config.ts と両 provider の setup:check: MCP 接続・必要ツール・デモ seed の成功を確認。使用中の4173番を変更せず、空きポートで検証した。
- カスタム MCP の保存と旧 Windows 生成形式の移行を回帰テストで確認した。macOS/Linux の実機確認は未実施。
- 現在のチャットに Playwright MCP ツールが読み込まれていないため、デスクトップ内の実際の子への委譲は MCP 再接続後の確認として残る。別プロセスの setup:check 成功をその代わりには扱わない。
- 標準の playwright.config.ts を使う本来の対象環境の BASE_URL・認証・データ準備は利用者のセットアップ対象であり、今回のデモ確認から成功とは判定しない。

既存のデモ台帳・出典スナップショット・観測メモ付き計画はローカルに保持し、配布する実装には含めなかった。今回の2件の設計判断は上記に記録し、デモの業務仕様判断とは混在させていない。ローカルのコミットまでが今回の完了範囲であり、公開リモートへの push は実施していない。

## 当初の判定（2026-10-10）

現時点では、この手順だけで開発を開始できる状態として公開できない。

- 公開 HEAD に実装が入っていない。
- 作業フォルダーの配布候補では依存関係のインストール・初期化・既存テストは成立する。
- ただし、OS 間の MCP 設定、ネイティブ MCP の設定切替、既存計画の保持、公開 CLI の省略引数に問題が残る。
- 両デスクトップアプリの親セッションから実際に Planner → Generator → 検証まで進む確認は未実施。MCP の直接呼び出しや mock dispatcher のテストを、その確認の代わりには扱わない。

## 開始を妨げる問題・データ保持の問題

### 1. 公開 HEAD に実装ファイルがない

`git ls-remote origin HEAD` と `git rev-parse HEAD` はともに `77d01a157455431a8d1c2f98c7e9a7eb2314d18d`。
`git ls-tree -r --name-only HEAD` の結果は `.gitignore` と `LICENSE` のみ。
README、package.json、lockfile、コード、規則、テストは作業ツリーの未追跡ファイルである。現在の公開 HEAD をクローンしても `npm ci` の対象がない。

必要な対応: 今回の実装をレビューしてから、明示的に指示された単位でコミット・push する。ローカルの動作確認と公開済みであることを区別する。

### 2. Claude MCP の Windows 設定を別 OS でも保持する構造

根拠: [.mcp.json](../.mcp.json)、[scripts/init-agents.mjs](../scripts/init-agents.mjs) の `restoreMcpConfiguration`。

配布候補の `.mcp.json` は `command: cmd`、`args: /c npx ...`。
Playwright の公式初期化は OS に応じて設定を生成するが、本プロジェクトは同名サーバーについて常に以前の設定を優先する。
このファイルを配布した場合、macOS/Linux で再初期化しても Windows の `cmd` が残る。
Windows では再現しないため、別 OS での実行成功を確認したとは扱わない。

必要な対応: プロジェクトが生成した設定と利用者のカスタム設定を区別する。生成設定は現在の OS に合わせて更新し、カスタム設定は保持する。配布時に OS 固有の生成物を固定しない。

### 3. native の workflow.config が MCP に反映されない

根拠: [lib/agent-setup.mjs](../lib/agent-setup.mjs)、[lib/agent-workflow.mjs](../lib/agent-workflow.mjs)、CLI adapters。

`workflow-start --config playwright.demo.config.ts` は設定を台帳・task・検証実行に渡す。
一方、native の MCP 接続は初期化時に固定され、`run-test-mcp-server --headless` に `--config` がない。
Playwright の planner_setup_page / generator_setup_page は project と seedFile を受け取り、config を切り替える引数を持たない。

配布候補コピーで MCP を直接呼び出した結果:

- 初期化と同じ既定設定で `planner_setup_page(seedFile=tests/demo/seed.spec.ts)`: `isError=true`、seed test not found。
- MCP 起動引数に `--config playwright.demo.config.ts` を追加して同じ呼び出し: `isError=false`。

標準の playwright.config.ts を使う開発にはこの設定切替は不要。ただし、CLI と native が同じ workflow.config を受け付けて同じ結果になる構成ではない。

必要な対応: native MCP が使う config と workflow.config の一致を確認できるようにする。切替が必要なら再接続方法を実装・文書化するか、非対応の組み合わせを開始前に拒否する。

### 4. workflow-start が既存計画を無条件に書き直す

根拠: [lib/agent-workflow.mjs](../lib/agent-workflow.mjs) の startWorkflow、[lib/migration.mjs](../lib/migration.mjs) の plan。

新規 workflow-start は既存計画の有無にかかわらず plan を実行する。AC の根拠と条件は再生成されるが、既存の実装方針・観測・再利用の記録は消える。
検証コピーの `specs/demo-customer.md` で実行し、`### 実装方針と観測` がなくなることを確認した。
「既存資産を再利用し、生成物を保持する」という規則と整合しない。

必要な対応: 既存計画を読み込んで再利用し、必要な AC 部分だけを追加・更新する。仕様更新時も既存メモを無条件で削除しない。

### 5. AC を省略した plan コマンドが動かない

根拠: [scripts/migration.mjs](../scripts/migration.mjs) と [lib/migration.mjs](../lib/migration.mjs) の plan。

CLI は省略時に空配列を渡す。plan は空配列の場合に確定済み AC を選択するが、続く条件で選択数と空配列の長さを比較する。
`npm run migration -- plan F-001` は、確定済み AC があっても「対象 AC がありません」で終了する。
ヘルプの `plan <F-ID> [AC-ID ...]` と矛盾する。

必要な対応: undefined と空配列の省略時動作を統一し、公開 CLI 経由の回帰テストを追加する。

## 重複・不足・過剰

### 6. worker の指示に役割の矛盾がある

根拠: [scripts/init-agents.mjs](../scripts/init-agents.mjs) の projectRules と resultContract、生成された role 定義。

resultContract は「台帳を変更しない」「質問は親へ返す」とする一方、その後に優先規則として追加する projectRules は「質問と回答を台帳に記録」「利用者へ質問」「migration CLI で実行を記録」とする。
親と worker の責務が混在している。

必要な対応: 共通規則の正本は AGENTS.md に維持しつつ、worker 向け追記は「根拠を守る・成果物を返す・質問を親へ返す」に限定する。台帳・実行・対話の担当は親と明示する。

### 7. デスクトップでの開始判定・実動作確認が不足している

README は MCP と subagent を「使える状態にする」と記載するが、設定ファイルの生成成功と、アプリ内の子から必要なツールが使えることを区別して確認する手順がない。
native の単体テストは mock dispatcher と親 receipt の検証であり、実際のアプリの委譲テストではない。

必要な対応: ローカルセッションの選択、アプリ内の Node/PATH、MCP の接続・必要ツール、BASE_URL と認証、seed 実行、子からのツール利用を確認する開始チェックを設ける。Codex と Claude で実際の委譲結果をそれぞれ確認する。

公式資料で確認できたこと:

- Codex は信頼済みプロジェクトの `.codex/config.toml` を使用できる。[MCP 設定](https://learn.chatgpt.com/docs/extend/mcp?surface=app)
- Claude Code Desktop のローカル Code セッションは `.mcp.json` と CLAUDE.md を共有する。ただし同名の user scope / Claude Desktop 設定が優先される場合がある。[Desktop の共有設定](https://code.claude.com/docs/en/desktop#shared-configuration)
- ローカルで設定した依存関係を前提とするため、Cloud / 別 WSL 環境を選ぶだけでは同じ準備にならない。[Claude の環境設定](https://code.claude.com/docs/en/desktop#environment-configuration)

### 8. 説明・検証範囲の不足

- CLI のヘルプに workflow-start の provider / transport、native の workflow-accept で必要な receipt がない。
- tsconfig.json の対象は TypeScript の設定・tests のみで、主実装の lib / scripts の .mjs は typecheck の対象ではない。
- 既存のデモ台帳を配布すると demo:prepare は何もしない。README の「取り込みから確認」という説明に対し、初回の作成経路を実行したことにならない。
- GitHub CI は単体・デモの確認であり、両アプリの native 経路の開始保証ではない。

必要な対応: ヘルプと文書を実装に一致させ、検証が保証する範囲を明記する。デモの初回作成は独立した新規ワークスペースで確認する。型チェックの拡張は別途検討する。

### 9. 標準セットアップに不要な生成と説明の重複がある

- Codex を選んでも公式定義の生成に VS Code loop を使うため、`.vscode/mcp.json` と Copilot の workflow も生成する。
- README の標準インストールは全ブラウザーだが、現在の projects は Chromium のみ。
- docs の VS Code 手順は共通 native 手順の多くを繰り返す。
- Claude 用 AGENTS import と環境別 role 定義は必要な対応であり、単純に削除すべき重複ではない。

必要な対応: 共通の役割定義生成と各クライアントへの設定反映を分離する。標準は選択したアプリと Chromium に絞り、VS Code/Copilot・追加ブラウザーは任意にする。環境ごとの差分だけを各節で説明する。

## 実行した確認

| 確認 | 結果と限界 |
| --- | --- |
| 公開 HEAD / ローカル HEAD / tracked files | HEAD 一致。実装は未追跡で公開 HEAD に含まれない |
| 作業フォルダーの npm run check | 整形・TypeScript・単体30件・台帳検証が成功 |
| 57ファイルの配布候補コピーで npm ci --offline | 成功。lockfile から独立した node_modules を作成。既存 npm キャッシュを使用し、空キャッシュからの取得は未確認 |
| 配布候補コピーの npm run agents:init | 成功。既存の .env / node_modules / ローカル Codex 設定はコピーしていない |
| 配布候補コピーの npm run check | 整形・TypeScript・単体30件・台帳検証が成功 |
| デモ E2E | 原本では4173番の競合で起動失敗。検証コピーを空きポートへ変更すると顧客検索2件とseedの計3件が成功 |
| MCP の直接呼び出し | 既定設定のデモseedは失敗。明示したデモ設定では成功 |
| plan の省略引数 | エラーを再現 |
| workflow-start の既存計画保持 | 観測メモが失われることを再現 |
| デスクトップ内の実際の Planner / Generator 委譲 | 未実施。mock や直接 MCP 成功から完了とは判定しない |

## 公開前の優先順

1. 設定の OS 対応、native の config 一致、既存計画の保持、plan の省略引数を修正する。
2. worker の責務、ヘルプ、開始チェック、README のローカルセッション条件を揃える。
3. 両デスクトップで設定後の実際の委譲・成果物受け入れ・検証を確認する。
4. 必要なファイルをコミット・push し、その公開内容を新規クローンしてセットアップを再検証する。

公開操作には利用者の明示的な指示が必要。今回のチェックでは実施していない。
