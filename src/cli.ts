#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { inspectCompatibility, validateRequest, type DecisionRequest, type ProviderCapabilities } from "./index.js";

const [command, requestPath, manifestPath] = process.argv.slice(2);
function usage(): never {
  console.error("Usage: open-decision validate <request.json> | inspect <request.json> <capabilities.json>");
  process.exit(1);
}
if (!command || !requestPath) usage();
try {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as DecisionRequest;
  validateRequest(request);
  if (command === "validate") console.log(JSON.stringify({ valid: true }, null, 2));
  else if (command === "inspect" && manifestPath) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProviderCapabilities;
    const report = inspectCompatibility(manifest, request);
    console.log(JSON.stringify(report, null, 2));
    if (!report.compatible) process.exitCode = 2;
  } else usage();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
