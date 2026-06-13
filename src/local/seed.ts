import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LocalTraceStore } from "./store.js";
import { assertValidTrace } from "../schema/validate.js";

const samplePath = fileURLToPath(
  new URL("../../examples/traces/login-flow.vibetrace.json", import.meta.url),
);

export async function seedExampleTrace(store = new LocalTraceStore()): Promise<boolean> {
  await store.ensure();
  const existing = await store.listTraces();

  if (existing.length > 0) {
    return false;
  }

  const raw = JSON.parse(await readFile(samplePath, "utf8")) as unknown;
  const trace = await assertValidTrace(raw);
  await store.saveTrace(trace);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seeded = await seedExampleTrace();
  console.log(seeded ? "Seeded example trace." : "Trace store already has data.");
}
