# 対話で進める Playwright E2E テスト移行

既存の仕様書と AI との対話を使って、レガシー Web システムの機能を少しずつ Playwright の E2E テストに移行するための専用 AI エージェントです。

仕様書からテスト移行台帳を作成し、曖昧な仕様を質問で明確にし、確定した条件からテストを生成します。仕様の根拠、判断履歴、テスト、実行結果を対応づけ、1 機能単位でレビュー可能な PR にまとめます。

このリポジトリは、対話する AI 開発環境に作業規則を与え、台帳 CLI と Playwright を使って移行を進める構成です。独自の LLM サービスは不要です。業務仕様の解釈とコード生成は AI が担当し、出典・状態・参照の整合性を CLI が検証します。

日常の依頼は、対象と目的だけで構いません。出典の保存、既存テスト・helper の検索、ギャップ分析、判断履歴の記録、実行結果の分類、PR の整理は [AGENTS.md](AGENTS.md) の共通規則としてエージェントが補います。業務仕様が不明な場合は質問します。

## 用意するもの

- 対象システムの Excel またはテキストの仕様書
- アクセス可能なテスト環境とテスト用アカウント
- テストデータの準備方法と、更新したデータの後片付け方法
- 業務仕様の質問に回答できる担当者
- このリポジトリのエージェント設定を読み込み、ファイル編集・ブラウザー操作・テスト実行ができる AI 開発環境
- Node.js 22 以上と npm

認証情報はローカルの環境変数などで設定します。仕様書、台帳、対話の記録、PR にパスワードやトークンを含めないでください。

## 初回セットアップ

```sh
npm ci
npx playwright install chromium
npm run agents:init -- --loop=codex --config playwright.config.ts
# Claude Code を使う場合は --loop=claude。両方を用意する場合は --loop=all。
```

`.env.example` を `.env` にコピーし、`BASE_URL` を設定してください。認証済みブラウザー状態が必要なら `STORAGE_STATE` にローカルの状態ファイルを指定します。対象システム固有の認証・データ準備は AI と確認し、fixture に追加します。

`agents:init` はインストールされた Playwright の公式役割定義を使い、worker の規則と選択したアプリの MCP 接続を準備します。標準の `all` は Codex と Claude のみで、VS Code は任意の `--loop=vscode` です。接続設定には現在の Node と checkout のパスを使うためローカル生成物として Git 管理せず、clone・移動後に再生成します。グローバル設定・モデル・認証は変更しません。

`.env` の設定後、選択したアプリに合わせて接続を確認してください。

```sh
npm run setup:check -- --loop codex
# Claude Code: --loop claude
npm run check
```

独自の MCP 設定は保持しますが、その場合は設定一致が未確認となり native を開始できません。プロジェクトの launcher に接続するか CLI 経路を選びます。別のテスト設定を使う場合は `agents:init --config <file>` で切り替え、アプリの MCP を再接続してください。workflow 側が別の config を指定した場合は開始前に拒否します。

セットアップ後は Codex または Claude Code のデスクトップアプリでこの checkout の**ローカルセッション**を開きます。初回のプロジェクト信頼・MCP 許可を確認し、MCP を再接続してください。アプリ内の seed 実行と子からのツール利用は [開始チェック](docs/agent-workflow.md#初期化と開始チェック) に従って確認します。`setup:check` の成功だけでアプリ内の委譲成功とは扱いません。Cloud・別 checkout・WSL には別途その環境の準備が必要です。Claude の CLI 対話で専用 agent を選ぶ場合は次を使えます。

```sh
claude --agent e2e-migration
```

Codex は AGENTS.md、Claude は CLAUDE.md の `@AGENTS.md` import から共通規則を読みます。規則全文をアプリごとに複製しません。[公式の import 説明](https://code.claude.com/docs/en/memory#share-one-file-with-other-coding-tools)

通常はアプリ内のサブエージェントに Planner → Generator → 必要時 Healer を委譲します。全役割が同じリポジトリ・依存関係・接続設定を共有し、別途 Codex / Claude CLI のインストール・認証は不要です。サブエージェントや必要な MCP ツールが利用できない環境では不足を報告し、利用可能な CLI を代替経路として選べます。詳細は [エージェント実行手順](docs/agent-workflow.md) を参照してください。

### デモで一連の動作を確認する

```sh
npm run demo:check
npm run check
```

デモは独立した一時ディレクトリと空きポートを使い、顧客検索の取り込み・架空の回答・計画・テスト対応・2 条件の実行を初回から確認します。既存台帳・計画・設定は変更しません。AI の自然言語解釈やデスクトップ内の委譲の評価とは区別します。AI 委譲のデモは [実行手順](docs/agent-workflow.md#デモ) を参照してください。

プロジェクトで用意された環境変数のサンプルと `playwright.config.ts` に従い、接続先や認証方法を設定します。その後、AI に次のように依頼してください。

```text
テスト環境への接続を確認してください。
```

seed test は、対象システムを探索・操作するための共通の起点です。環境準備が完了してから、仕様書の取り込みとテスト生成に進みます。

## 基本の使い方

### 1. 仕様書を取り込み、移行台帳を作る

仕様書を `requirements/` に配置し、対象範囲を指定します。

```text
test.xlsx を読み、顧客検索機能のテスト移行台帳を作ってください。
```

AI は `migration/features/` に機能ごとの Markdown 台帳を作成します。台帳には構造化メタデータと、原文、検証条件、未解決の質問、既存テストとの対応が含まれます。

「検索結果が正しく表示される」のような仕様は、表示項目、照合方法、並び順、該当なしの表示など、期待結果を決めるための質問に分解されます。仕様書に書かれていない回答は補いません。

### 2. 対話で仕様を確定する

```text
F-001 をテスト化するために必要な質問をしてください。
```

質問には、判断できる範囲で具体的に回答します。

```text
顧客名は部分一致です。結果は顧客番号の昇順で表示します。
表示項目は顧客番号、顧客名、契約状態です。
該当なしの場合は「該当する顧客はありません」と表示します。
```

AI は質問と回答、採用した仕様、日付、対象の検証条件を台帳に保存します。回答者の氏名・役割が不明な場合は未確認として記録し、その権限の確認が仕様確定に必要な場合に質問します。

回答できない項目は未確定のまま残せます。独立した確定済みの検証条件から作業を進められるため、機能全体を一度に明確にする必要はありません。

画面を探索して得た挙動は「観測結果」として保存します。現状の挙動を回帰テストの基準にしたい場合は、その判断を明示してください。

```text
現在の表示順を回帰テストの基準として採用してください。
```

### 3. 確定した条件からテストを生成する

```text
F-001 の確定済みの AC-001 と AC-002 を Playwright テストにしてください。
```

AI は、前提条件、入力データ、操作、期待結果が具体的な検証条件から `specs/` にテスト計画を作り、`tests/` にコードを生成します。計画とテストには対象の AC ID を残します。

専用エージェントは公式 Planner → Generator を順番に呼び出します。実際のテスト実行が失敗した場合だけ Healer を呼び出し、結果を再検証します。戻り値と成果物を検証して台帳に保存し、未確定の仕様や修復できない問題は対話へ戻します。

自動実行または代替経路として、インストール・認証済みの Codex CLI または Claude Code CLI から直接実行することもできます（選択したサービスの利用枠を消費します）。Claude の adapter は v2.1.281 以上が必要です。

```sh
npm run agents:run -- F-001 AC-001 AC-002 --provider codex
npm run agents:run -- F-001 AC-001 AC-002 --provider claude
```

この CLI 経路に限り、provider を省くと `.env` の `AGENT_PROVIDER`、未設定なら codex を使います。途中で subprocess が終了した場合は `--resume` で再開できます。対象・設定・provider・transport（native / cli）と呼び出し履歴を台帳の `agentWorkflows` に保存し、途中の経路切替を防ぎます。Healer は既定1回までです。

既存テストで十分に検証されている場合は、重複するテストを増やさず、台帳に対応先を記録します。既存テストの拡張で対応できる場合は、そのテストを変更します。

### 4. 実行結果を確認する

```text
今回変更した顧客検索テストを実行して結果を報告してください。
```

手元で直接実行することもできます。

```sh
npx playwright test tests/customer-search.spec.ts
npx playwright show-report
```

AI は同じ検証意味を維持できる locator や同期処理の問題を修正し、再実行します。期待値の変更、assertion の削除、`skip` や `fixme` による除外が必要な場合は、仕様判断を求めます。

テストが通ったことだけでは、業務仕様が確定した扱いにはなりません。実行できなかった場合も、その理由と必要な対応を記録します。

### 5. 機能単位で PR を作る

```text
テスト単位でコミットし、PR を作成してください。
```

PR のレビューでは次を確認します。

- 期待結果に仕様書または採用済みの判断の根拠があるか
- テストが対象 AC を実際に検証しているか
- 既存テストや helper と重複していないか
- テストデータと後片付けが適切か
- 実行結果と未解決事項が正確に記載されているか

テスト・計画・台帳・判断履歴を同じ PR でレビューします。PR の作成やテスト成功を、マージ済みの状態として記録することはありません。

## 続きから再開する

会話をまたいでも、機能 ID を指定して台帳から再開できます。

```text
F-001 の移行を再開してください。
```

仕様書が改訂された場合は、変更された出典と、それに依存する AC・テストを確認します。以前の判断を履歴から削除せず、新しい判断で更新します。

```text
requirements/test-v2.xlsx と以前の仕様を比較してください。
変更の影響を受ける AC とテストを列挙し、再確認が必要な条件を台帳に記録してください。
```

## 保存されるファイル

```text
requirements/                     元の仕様書
migration/features/
  customer-search.md              移行台帳・ギャップ・判断履歴
specs/
  customer-search.md              確定済み条件のテスト計画
tests/
  seed.spec.ts                   環境準備と探索の起点
  customer-search.spec.ts        E2E テスト
  helpers/                       共通処理
  fixtures/                      認証・データなどの共通準備
AGENTS.md                        エージェントの作業規則
playwright.config.ts             実行環境の設定
```

`migration/sources/` に版のハッシュと原文位置を含む取り込み結果を保存します。`examples/` は台帳・判断の入力例、`docs/agent-workflow.md` は AI が短い依頼から実行する具体的な手順です。

手元で進捗や整合性を確認する場合は、次を使えます。

```sh
npm run migration -- status
npm run migration -- context F-001
npm run migration -- validate
```

PR の作成には GitHub の連携ツール、または認証済みの `gh` と Git remote が必要です。CLI は PR 本文の素材と台帳への URL 対応づけを提供し、AI が指示に従ってコミット・PR 作成を行います。

台帳を仕様と移行状況の正本として扱い、計画とコードを対応づけます。仕様書の原文は保持し、解釈や判断は別に記録します。

### 台帳の ID と状態

| 項目 | 用途 |
| --- | --- |
| `F-001` | 機能の識別子 |
| `AC-001` | 個別の検証条件の識別子 |
| `GAP-001` | 曖昧さや不足情報の識別子 |
| `DEC-001` | 採用した仕様判断の識別子 |
| `SRC-001` | 元仕様書と位置を示す出典の識別子 |

ID は台帳内の機能と組み合わせて参照します。例えば `F-001/AC-001` で対象を特定します。

個別の AC ごとに、仕様の状態と自動化の状態を別々に管理します。

| 軸 | 状態 |
| --- | --- |
| 仕様 | `unresolved`：未確定、`confirmed`：確定済み |
| 自動化 | `not_started`：未着手、`implemented`：実装済み、`blocked`：実装・実行を妨げる条件あり |

実行結果は、実行日時、コマンド、対象環境、対象コミット、成功・失敗・未実行、レポート参照を別に残します。AC ごとに計画、テスト、関連 PR も対応づけます。

## 開発とコードの構成

コードを変更するときは `npm run format` で整形し、`npm run check` で整形・JavaScript 構文・TypeScript・単体テスト・台帳の整合性を確認します。`.mjs` の全体型チェックは含みません。整形ルールは `.prettierrc.json` に保存しています。

主な実装は、次の責務に分けています。

| ファイル | 責務 |
| --- | --- |
| `lib/agent-workflow.mjs` | 委譲フローの開始・結果受け入れ・検証・再開 |
| `lib/agent-contract.mjs` | worker の結果形式と委譲証拠の検証 |
| `lib/agent-prompt.mjs` | worker に渡す指示とコンテキストの組み立て |
| `lib/native-settings.mjs` / `scripts/playwright-mcp.mjs` | native の初期化設定の一致確認と MCP 起動 |
| `lib/test-plan.mjs` | 既存計画・メモの保持と条件差分の検出 |
| `lib/test-guards.mjs` | assertion・期待値・テスト実行制御の保護 |
| `lib/agent-process.mjs` | CLI subprocess の起動・JSON イベント読み取り・タイムアウト |
| `lib/codex-agent-runner.mjs` / `lib/claude-agent-runner.mjs` | 各 CLI の引数・出力形式への対応 |
| `lib/migration.mjs` | 仕様取り込み・台帳保存・計画・テスト実行記録 |
| `lib/ledger-validation.mjs` | 出典・GAP・判断・AC・履歴の参照整合性の検証 |
| `scripts/init-agents.mjs` | 公式定義の生成・設定の保持・プロジェクト規則の適用 |

## エージェントの役割

| 処理 | 役割 |
| --- | --- |
| 仕様取り込み・台帳管理 | 原文と出典を保存し、条件・ギャップ・既存テストを整理する |
| 仕様確認 | 必要な質問を行い、回答と採用した判断を保存する |
| Planner | 確定した条件と環境情報から Markdown のテスト計画を作る |
| Generator | 計画と既存資産から Playwright テストを生成する |
| Healer | 検証意味を維持して実装上の失敗を調査・修正する |
| PR 整理 | 台帳・判断・計画・コード・検証結果を機能単位にまとめる |

Planner・Generator・Healer は [Playwright Test Agents](https://playwright.dev/docs/test-agents) を活用します。本プロジェクトでは、仕様確定の判定と、期待結果を守る修復ルールを追加します。
