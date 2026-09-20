import { resolve } from "node:path";
import { createRuntime, resetState, rootDir } from "./runtime.js";
import { ResponsesAgent } from "./responses-agent.js";

function flag(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function demo() {
  const statePath = resolve(rootDir, "work/demo-state.json");
  await resetState(statePath);
  const { service, baseline } = await createRuntime({ statePath });
  const credential = "cred-acme-operator";

  const diagnosis = await baseline.diagnose(credential, "ACME-1001がERPに反映されない。調べて");
  const approval = await service.approveRetry(credential, "ACME-1001");
  const execution = await service.retryOrder(credential, {
    orderId: "ACME-1001",
    approvalId: approval.approvalId,
    expectedVersion: approval.expectedVersion
  });
  const duplicate = await service.retryOrder(credential, {
    orderId: "ACME-1001",
    approvalId: approval.approvalId,
    expectedVersion: approval.expectedVersion
  });

  const timeoutApproval = await service.approveRetry(credential, "ACME-1003");
  const unknown = await service.retryOrder(credential, {
    orderId: "ACME-1003",
    approvalId: timeoutApproval.approvalId,
    expectedVersion: timeoutApproval.expectedVersion
  });
  const reconciled = await service.getActionReceipt(credential, { receiptId: null, operationKey: unknown.operationKey });

  print({
    demo: "synthetic CRM-to-ERP exception handling",
    steps: { diagnosis, approval, execution, duplicate, unknown, reconciled },
    statePath
  });
}

async function main() {
  const command = process.argv[2] ?? "help";
  const statePath = flag("state", undefined);
  if (command === "reset") {
    await resetState(statePath);
    print({ ok: true, statePath: statePath ?? "work/runtime-state.json" });
    return;
  }
  if (command === "demo") return demo();
  const { service, baseline } = await createRuntime({ statePath });
  const credential = flag("credential", "cred-acme-operator");
  if (command === "diagnose") {
    print(await baseline.diagnose(credential, process.argv[3] ?? ""));
    return;
  }
  if (command === "approve") {
    print(await service.approveRetry(credential, process.argv[3]));
    return;
  }
  if (command === "retry") {
    print(await service.retryOrder(credential, {
      orderId: process.argv[3],
      approvalId: process.argv[4],
      expectedVersion: Number(process.argv[5])
    }));
    return;
  }
  if (command === "agent") {
    const tracePath = resolve(rootDir, "outputs/traces", `${Date.now()}.json`);
    const agent = new ResponsesAgent(service, { tracePath });
    print(await agent.run({ credential, input: process.argv[3] ?? "" }));
    return;
  }
  console.log(`Commands:
  npm run demo
  node src/cli.js reset
  node src/cli.js diagnose "ACME-1001を調べて" --credential=cred-acme-operator
  node src/cli.js approve ACME-1001 --credential=cred-acme-operator
  node src/cli.js retry ACME-1001 APPROVAL_ID 3 --credential=cred-acme-operator
  PORTFOLIO_ALLOW_API=true node src/cli.js agent "ACME-1001を調べて"  # set OPENAI_API_KEY in the process environment; see README`);
}

await main();
