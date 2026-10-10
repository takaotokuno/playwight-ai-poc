import { spawn } from 'node:child_process';

function terminateProcess(child) {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  child.kill('SIGTERM');
}

function createEventReader(consumeEvent) {
  let buffer = '';

  function consumeLine(line) {
    try {
      consumeEvent(JSON.parse(line));
    } catch {
      // Unstructured diagnostics are not evidence of a completed tool call.
    }
  }

  return {
    append(chunk) {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer.trim()) {
        consumeLine(buffer);
      }
    },
  };
}

/** Run an agent with stdin prompts and JSON events, without exposing raw output. */
export function runAgentProcess({
  root,
  executable,
  args,
  prompt,
  timeoutMs,
  label,
  consumeEvent,
  flushFinalLine = false,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const reader = createEventReader(consumeEvent);
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      terminateProcess(child);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => reader.append(chunk));
    // stderr can echo prompts or private browser content. Never stream or persist it.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} を起動できません: ${error.code || error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (flushFinalLine) {
        reader.flush();
      }
      if (expired) {
        reject(new Error(`${label} の実行時間上限に到達しました`));
      } else {
        resolve(code);
      }
    });
    child.stdin.end(prompt);
  });
}
