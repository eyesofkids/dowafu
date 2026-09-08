import readline from "node:readline";
import { defaultDbPath } from "../db.js";
import type { Lang } from "../types.js";
import { createDefaultProtocol } from "./protocol.js";

type StdioOptions = {
  dbPath?: string;
  lang?: Lang;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => void;
};

// stdout is reserved exclusively for one-line JSON-RPC responses. Diagnostics,
// including client capability observations, are deliberately routed to stderr.
export function startStdioServer(options: StdioOptions = {}): void {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const protocol = createDefaultProtocol(options.dbPath ?? defaultDbPath(), options.lang ?? "en");
  const log = (line: string) => stderr.write(`${line}\n`);
  const reader = readline.createInterface({ input, crlfDelay: Infinity });

  reader.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      log("invalid JSON-RPC input");
      return;
    }
    const outcome = protocol.handleRpc(message, log);
    if ("none" in outcome) return;
    // JSON.stringify escapes embedded string newlines, so each write is exactly
    // one legal newline-delimited MCP message.
    output.write(`${JSON.stringify(outcome.response)}\n`);
  });

  input.once("end", () => {
    log("stdin closed; exiting");
    exit(0);
  });
}
