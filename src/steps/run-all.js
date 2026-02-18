#!/usr/bin/env node

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const STATE_FILE = path.join(projectRoot, "cache", "run-state.json");

const STEPS = [
  { name: "clockify-preprocessor.js", label: "Clean Clockify CSV" },
  { name: "collect-direct-commits.js", label: "Fetch GitHub commits" },
  { name: "github-summarizer.js", label: "Fetch PRs + AI summaries" },
  { name: "jira-summarizer.js", label: "Fetch Jira tickets + AI summaries" },
  { name: "clockify-enricher.js", label: "Detect patterns + enrich entries" },
];

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // already gone
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function runStep(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      stdio: "inherit",
      cwd: __dirname,
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const state = readState();
  let startFrom = 0;

  if (state && !state.completed && state.failedStep !== undefined) {
    const step = STEPS[state.failedStep];
    const answer = await ask(
      `\nLast run failed at step ${state.failedStep + 1} (${step.label}).\nResume from step ${state.failedStep + 1}? [y/n] `
    );
    if (answer === "y" || answer === "yes") {
      startFrom = state.failedStep;
    } else {
      clearState();
    }
  } else if (state?.completed) {
    clearState();
  }

  console.log(`\nStarting from step ${startFrom + 1} of ${STEPS.length}.\n`);

  for (let i = startFrom; i < STEPS.length; i++) {
    const step = STEPS[i];
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Step ${i + 1}/${STEPS.length}: ${step.label}`);
    console.log(`${"─".repeat(60)}\n`);

    const code = await runStep(step.name);

    if (code !== 0) {
      writeState({ completed: false, failedStep: i });
      console.error(`\n[run-all] Step ${i + 1} (${step.label}) failed with exit code ${code}.`);
      console.error(`[run-all] Re-run this script to resume from step ${i + 1}.\n`);
      process.exit(1);
    }
  }

  clearState();
  console.log(`\n${"═".repeat(60)}`);
  console.log("All steps completed successfully.");
  console.log(`${"═".repeat(60)}\n`);
}

main();
