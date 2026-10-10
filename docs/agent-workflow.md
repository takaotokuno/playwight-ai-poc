# エージェントの実行手順

AI が仕様の意味とテストコードを扱い、migration CLI が出典・判断・状態・成果物・実行記録を管理する。共通規則の正本は AGENTS.md。

## 初期化と開始チェック

Node.js 22 以上を用意し、リポジトリのルートで README の npm ci・Chromium インストール・.env 設定を行う。デスクトップでは設定した checkout の **ローカル** セッションを使う。Cloud、別 checkout、WSL を使う場合はその環境で同じ準備が必要。

```sh
npm run agents:init -- --loop=codex --config playwright.config.ts
# Claude: --loop=claude。両方: --loop=all。VS Code は任意で --loop=vscode。
npm run setup:check -- --loop codex
```

初期化はインストールされた Playwright の公式定義を使い、worker の役割に限定したプロジェクト規則を適用する。生成するのは選択したアプリの接続と役割定義だけであり、Copilot workflow は生成しない。

MCP の起動には現在の Node 実行ファイルと scripts/playwright-mcp.mjs の絶対パスを使う。launcher は migration/.agent-config.json に記録した provider ごとの config を読む。接続設定とこの記録はローカル生成物として Git 管理しない。clone・移動後には再初期化する。

同名の設定が過去の公式生成形式なら現在の launcher に更新する。独自引数・環境変数を含むカスタム MCP は保持し、一致未確認と表示する。カスタム接続を保持したまま native の設定一致を自動保証することはできない。設定をレビューしてこの launcher に接続するか、CLI 経路を選ぶ。

### 設定の切替

```sh
npm run agents:init -- --loop=codex --config playwright.demo.config.ts
npm run setup:check -- --loop codex --seed tests/demo/seed.spec.ts
```

切替・config ファイル変更後は初期化を再実行し、アプリの MCP を再接続して新しいセッションを開始する。workflow の config が初期化記録と違う場合や、その内容が変更された場合は開始・再開前に拒否する。アプリが保持している古い MCP プロセスは、ファイルを書き換えるだけでは切り替わらない。

setup:check は別プロセスで MCP 接続、必要なツール、seed の実行を確認する。**アプリ内の接続と委譲の証明ではない**。親は次を実際に確認してからテスト化する。

1. アプリが共通規則を読み、ローカルで Node/npm とファイル編集・実行を使える。
2. アプリ内の Playwright Test MCP で、選択した seed を planner_setup_page に渡し成功する。BASE_URL・認証状態・データ準備が不足すれば環境の阻害理由として返す。
3. 子に必要な MCP ツールが渡る。後述の実際の Planner 委譲で確認し、利用できなければ blocked を返す。ツール名をプロンプトに書いただけでは使用済みにしない。

Codex は信頼済みプロジェクトの .codex/config.toml を読む。[公式 MCP 設定](https://learn.chatgpt.com/docs/extend/mcp?surface=app)
Claude Code Desktop のローカル Code セッションは CLAUDE.md と .mcp.json を使う。同名の user scope / Claude Desktop 設定が優先される場合があるため、アプリ内の接続先も確認する。[公式の共有設定](https://code.claude.com/docs/en/desktop#shared-configuration)

## 仕様取り込みと台帳作成

1. `npm run migration -- ingest requirements/file.xlsx` を実行し、snapshot と revision を使う。records はセル・行の原文であり、期待結果の解釈を含まない。
2. `status` で未使用の機能 ID を確認し、既存テスト・計画・helper・判断履歴を内容まで確認する。
3. examples/proposal.json の形式で proposal を作る。original は snapshot の原文、location は正確なセル・行位置にする。業務条件を補完しない。
4. `npm run migration -- create customer-search examples/work/proposal.json`。既存台帳は上書きしない。
5. 明確な原文から確定する条件には preconditions / inputs / steps / expected と confirmation の source 根拠・note・at を保存する。不明点は GAP にする。

## 対話と仕様確定

`context F-ID` と `questions F-ID` を読み、親が利用者へ質問する。examples/decision.json の形式で必要な質問・回答を保存し、`decide F-ID AC-ID <decision.json>` で採用する。resolves に解決した GAP を指定する。部分回答は未確定のままメモを残し、独立した確定済み条件だけ進める。

## native のテスト化（標準）

provider は役割定義の選択（codex / claude / vscode）、transport は委譲手段（native / cli）。両者を台帳へ別々に保存する。全役割は同じ checkout・依存関係・接続設定を使い、別途 AI CLI のインストール・認証は不要。

1. `npm run migration -- workflow-start F-001 AC-001 --provider codex --transport native --config playwright.config.ts`。初期化した provider と config を指定する。実行中のフローは `workflow-task F-001` で再開する。
2. 既存計画はメモと条件を保持する。台帳との不一致なら migration/.agent-tmp/plan-update-F-ID.json に変更候補を出して停止する。親が採用済み判断と照合し、メモを残して計画を更新してから開始する。期待結果が未確定なら利用者へ戻す。Planner も既存行を保持して追記する。
3. task.prompt 全文を実際の委譲ツールへ渡し、worker の完了を待つ。Planner → Generator の順に進め、同じブラウザーを並行操作しない。
4. worker の最終 JSON を migration/.agent-tmp/worker-result.json に保存する。親がツールの戻り値から taskId・agentId・tool を別の delegation.json に記録する。

```json
{ "taskId": "workflow-task が返した ID", "agentId": "実際の子の ID", "tool": "実際に呼んだツール名" }
```

5. `npm run migration -- workflow-accept F-001 migration/.agent-tmp/worker-result.json migration/.agent-tmp/delegation.json`。台帳・定義・成果物・AC 対応・assertion・既存計画の保持を検証する。receipt は親が記録した証拠（coordinator_reported）であり、MCP 成否を機械的に収集した証拠とは区別する。
6. 次の task があれば同じ手順で委譲する。awaiting_run なら親が `workflow-verify F-001` を実行する。実行失敗で awaiting_healer になった場合だけ Healer に委譲し、受け入れ後に再検証する。Healer は既定1回。
7. 質問・阻害理由は親へ戻し、台帳と対話に残す。受け入れ後、worker JSON と receipt の一時ファイルを削除する。最後に `npm run format` と `npm run check` を行う。

環境ごとの委譲方法だけが異なる。

| 環境 | 方法 |
| --- | --- |
| Codex | 利用可能な spawn ツールで汎用 worker に task.prompt を渡す。task.agent は役割名であり、登録済みの agent_type とは限らない |
| Claude Code | 親の Agent ツールに subagent_type=task.agent と task.prompt を渡す。CLAUDE.md は AGENTS.md を import する |
| VS Code Local | 任意の e2e-migration を選び、agent/runSubagent に agent=task.agent と task.prompt を渡す |

subagent / MCP が不足する場合は native 委譲済みと報告しない。代替経路を使うなら既存フローを workflow-stop で停止し、新しい transport=cli のフローを開始する。未承認の別サービス・認証方式への切替は利用者へ確認する。

## CLI の自動実行・代替経路

```sh
npm run agents:run -- F-001 AC-001 --provider codex
npm run agents:run -- F-001 AC-001 --provider claude
npm run agents:run -- F-001 --resume
```

インストール・認証済みの codex / claude が PATH に必要。CODEX_EXECUTABLE / CLAUDE_EXECUTABLE でも指定できる。Windows の Claude は native の claude.exe を使う。provider 省略時は .env の AGENT_PROVIDER、未設定なら codex。CLI の provider は native の選択に適用しない。

adapter が公式定義・確定済み台帳・seed・計画と役割の MCP 許可リストを subprocess に渡す。MCP は task の config で起動し、グローバル設定・モデル・認証を書き換えない。

Codex は codex exec の --output-schema / --output-last-message / --json と --approve-for-me を使う。このフラグに対応する CLI が必要。Claude は --agents のファイル形式を使うため v2.1.281 以上が必要で、claude -p の stream-json / json-schema から structured_output を取得する。両者とも実際の setup/debug 成功記録なしに completed を受け入れない。

worker は各15分、Healer は --max-heal 1〜3。中断は --resume で保存された対象・provider・transport を使う。経路・対象変更は停止後に新規開始する。生の出力と一時設定は保存しない。失敗・未認証・承認拒否は未完了として保持する。

transport がない旧履歴は legacy として読み、過去の証拠を補完しない。手動実装は plan / link / run / classify で扱えるが、委譲済みとは記録しない。CLI の検証は業務仕様や locator の意味の正しさを証明せず、レビューが必要。

根拠: [Codex の非対話実行](https://learn.chatgpt.com/docs/non-interactive-mode)、[Claude CLI](https://code.claude.com/docs/en/cli-reference)、[Claude のサブエージェント](https://code.claude.com/docs/en/sub-agents)。

## デモ

`npm run demo:check` は独立した一時ディレクトリで取り込み・架空の回答・計画・テスト対応・2 AC の実行を行う。使用可能なポートを選び、既存台帳・設定・計画を変更しない。これは基盤の検証であり、AI の仕様解釈やアプリ内委譲の評価ではない。

AI 委譲をデモで試す場合のみ、`demo:prepare` で作業フォルダーにデモ台帳を作り、agents:init の config を playwright.demo.config.ts、seed を tests/demo/seed.spec.ts にする。既存 F-001 が実機能ならデモを同じ台帳へ作らない。4173 番が使用中なら DEMO_PORT に空きポートを指定し、アプリから起動する MCP にも同じ値を渡す。終了後は本番のテスト設定へ初期化・再接続して戻す。

## PR と仕様改訂

指示された場合だけコミット・push・PR 作成を行う。pr-body F-ID は本文素材、attach-pr F-ID <URL> AC-ID は実在する URL の対応づけを行う。本文には変更後の挙動・根拠・再利用・検証・未解決事項を記載し、PR 作成・成功・マージを別々の事実として扱う。

`revise F-ID SRC-ID requirements/revision.xlsx` は旧 snapshot と判断を保持し、影響する AC を unresolved / blocked に戻す。原文位置と差分を確認し、判断を更新して確定してから計画・テストを更新する。期待値を自動で上書きしない。
