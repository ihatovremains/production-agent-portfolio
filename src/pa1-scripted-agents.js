import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const evidence = JSON.parse(await readFile(resolve(root, "outputs/pa1-dry-run-evidence.json"), "utf8"));
const output = {
  schemaVersion: 2,
  route: "prepareScenario -> ResponsesAgent(fake transport) -> artifact -> scorer",
  holdoutScenarioCount: 15,
  results: evidence.scriptedPolicies
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
const outputPath = resolve(root, "outputs/pa1-scripted-agent-results.json");
if (process.argv.includes("--check")) {
  if (await readFile(outputPath, "utf8") !== serialized) throw new Error("SCRIPTED_EVIDENCE_MISMATCH");
} else {
  await writeFile(outputPath, serialized, "utf8");
}
console.log(JSON.stringify({ ok: true, policies: output.results.map((item) => ({ policy: item.policy, passed: item.summary.passed, total: item.summary.total })) }, null, 2));
