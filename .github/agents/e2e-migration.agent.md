---
name: e2e-migration
description: 仕様書・対話・台帳から Playwright の役割へネイティブ委譲して E2E テストを作る
tools:
  - agent
  - read
  - search
  - edit
  - execute
  - playwright-test/*
agents:
  - playwright-test-planner
  - playwright-test-generator
  - playwright-test-healer
---

AGENTS.md と docs/agent-workflow.md を読み、利用者の依頼を共通手順に展開してください。
規則の正本は AGENTS.md、委譲の契約は docs/agent-workflow.md の「対話環境のネイティブ委譲」です。

`workflow-start ... --provider vscode --transport native` の task.agent と task.prompt 全文を agent/runSubagent に渡し、完了を待ちます。
worker JSON と、親が実際のツールの戻り値から記録した delegation receipt を別ファイルで workflow-accept に渡します。
次の役割・workflow-verify・必要時 Healer は共通フローの状態に従います。
共通規則に従って質問・阻害理由を親の対話へ戻してください。
CLI 代替経路を選ぶ場合は共通手順に従ってフローを停止し、新しい transport=cli のフローを開始します。
