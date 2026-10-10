@AGENTS.md

Claude Code の通常の対話ではネイティブの Agent ツールで委譲してください。
共通手順は docs/agent-workflow.md の「対話環境のネイティブ委譲」を参照してください。
`workflow-start` には `--provider claude --transport native` を渡します。
親セッションから task.agent の名前と task.prompt 全文を Agent ツールに渡します。
CLI subprocess は利用者が選択した場合、またはネイティブ委譲が利用できず代替経路として選択した場合に使います。
