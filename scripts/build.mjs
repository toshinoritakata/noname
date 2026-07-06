// Build = tsc only. Zero npm dependencies (ADR-0006: zero-install spirit).
// Usage: node scripts/build.mjs [--watch]
import { spawn } from "node:child_process";

const watch = process.argv.includes("--watch");
const args = ["-p", "tsconfig.json"];
if (watch) args.push("--watch", "--preserveWatchOutput");

const child = spawn("tsc", args, { stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
