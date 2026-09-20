import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rescoreRun } from "./pa1-runner.js";

const target = process.argv[2];
if (!target) throw new Error("Usage: node src/pa1-rescore.js <run-directory> [--check]");
const runDir = resolve(target);
const runRecord = JSON.parse(await readFile(resolve(runDir, "run.json"), "utf8"));
const rescored = `${JSON.stringify(await rescoreRun(runRecord), null, 2)}\n`;
if (process.argv.includes("--check")) {
  const saved = await readFile(resolve(runDir, "scores.json"), "utf8");
  if (saved !== rescored) throw new Error("PA1_RESCORE_MISMATCH");
}
process.stdout.write(rescored);
