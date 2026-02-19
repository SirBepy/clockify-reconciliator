#!/usr/bin/env node

// ============================================================================
// Section 1 — Shebang, Imports, and Constants
// ============================================================================

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { parse as csvParse } from "csv-parse/sync";

import { parseClockifyDate } from "../shared/date-utils.js";
import { loadConfig } from "../shared/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

const UPLOAD_ERRORS_PATH = path.resolve(projectRoot, "output/upload-errors.txt");
const UPLOAD_SKIPPED_PATH = path.resolve(projectRoot, "output/upload-skipped-days.txt");

const CLOCKIFY_BASE_URL = "https://api.clockify.me/api/v1";
const RATE_LIMIT_DELAY_MS = 125; // 8 req/sec → 1000/8 = 125 ms

// ============================================================================
// Section 2 — Helper Functions
// ============================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hoursToHMM(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours % 1) * 60);
  return `${h}:${m.toString().padStart(2, "0")}`;
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

function parseDurationH(durationStr) {
  if (!durationStr) return 0;
  if (durationStr.includes(":")) {
    const [h, m] = durationStr.split(":").map((s) => parseInt(s, 10) || 0);
    return h + m / 60;
  }
  return parseFloat(durationStr) || 0;
}

function parseEntryDate(row) {
  const date = parseClockifyDate(row["Start Date"], row["Start Time"]);
  return date.toLocaleDateString("en-CA"); // YYYY-MM-DD
}

function entryToIso(dateStr, timeStr) {
  return parseClockifyDate(dateStr, timeStr).toISOString();
}

function isUnchangedDay(beforeRows, afterRows) {
  if (beforeRows.length !== afterRows.length) return false;
  const fields = ["Description", "Start Time", "End Time", "Duration (h)"];
  const toKey = (row) => fields.map((f) => row[f] ?? "").join("|");
  const beforeKeys = beforeRows.map(toKey).sort();
  const afterKeys = afterRows.map(toKey).sort();
  return beforeKeys.every((k, i) => k === afterKeys[i]);
}

function groupByDate(rows) {
  const map = new Map();
  for (const row of rows) {
    const dateStr = parseEntryDate(row);
    if (!map.has(dateStr)) map.set(dateStr, []);
    map.get(dateStr).push(row);
  }
  return map;
}

async function apiCall(url, options, dryRun) {
  await sleep(RATE_LIMIT_DELAY_MS);
  if (dryRun) {
    const method = (options.method || "GET").toUpperCase();
    console.log(`  [DRY-RUN] ${method} ${url}`);
    if (method === "GET" && url.endsWith("/user")) {
      return { id: "DRY_RUN_USER_ID", name: "Dry Run" };
    }
    if (method === "GET") return [];
    if (method === "DELETE") return {};
    if (method === "POST") return { id: `DRY_RUN_ENTRY_${Date.now()}` };
    return {};
  }

  const config = options._config;
  delete options._config;

  const headers = {
    "X-Api-Key": config.apiKey,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

// ============================================================================
// Section 3 — CLI Argument Parsing
// ============================================================================

const cliOptions = {
  "dry-run": { type: "boolean" },
  day: { type: "string" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
};

let parsedArgs;
try {
  parsedArgs = parseArgs({ options: cliOptions, strict: false });
} catch (err) {
  console.error(`Failed to parse CLI arguments: ${err.message}`);
  process.exit(1);
}

if (parsedArgs.values.help) {
  console.log(`
clockify-uploader — Upload enriched Clockify CSV back to Clockify API

Usage:
  node clockify-uploader.js [options]

Options:
  --dry-run         Simulate all API calls without making real requests
  --day <YYYY-MM-DD>  Process only a single day
  --yes, -y         Auto-confirm all day prompts
  --help, -h        Show this help message
`);
  process.exit(0);
}

const dryRun = parsedArgs.values["dry-run"] ?? false;
const dayFilter = parsedArgs.values["day"] ?? null;
const autoYes = parsedArgs.values["yes"] ?? false;

if (dryRun) console.log("[DRY-RUN MODE] No real API calls will be made.\n");

// ============================================================================
// Section 4 — Config Loading
// ============================================================================

let config;
try {
  config = await loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const apiKey = config.clockify?.api_key;
const workspaceId = config.clockify?.workspace_id;
const projectId = config.clockify?.project_id;

if (!apiKey) {
  console.error(
    "Missing config.clockify.api_key. Get it from Clockify → Profile Settings → API.",
  );
  process.exit(1);
}
if (!workspaceId) {
  console.error(
    "Missing config.clockify.workspace_id. Visible in the URL when logged into Clockify.",
  );
  process.exit(1);
}
if (!projectId) {
  console.error(
    "Missing config.clockify.project_id. Set the target project ID in config.json.",
  );
  process.exit(1);
}

const ORIGINAL_CSV_PATH = path.resolve(projectRoot, config.clockify.input_csv);
const ENRICHED_CSV_PATH = path.resolve(
  projectRoot,
  config.clockify.output_standardized,
);

// Shared API call context (avoids threading apiKey through every call)
function makeApiCall(url, options = {}) {
  return apiCall(url, { ...options, _config: { apiKey } }, dryRun);
}

// ============================================================================
// Section 5 — Dependency Checks
// ============================================================================

if (!fs.existsSync(ORIGINAL_CSV_PATH)) {
  console.error(
    `Original CSV not found at ${ORIGINAL_CSV_PATH}. Check config.clockify.input_csv.`,
  );
  process.exit(1);
}
if (!fs.existsSync(ENRICHED_CSV_PATH)) {
  console.error(
    `Enriched CSV not found at ${ENRICHED_CSV_PATH}. Run clockify-enricher.js first.`,
  );
  process.exit(1);
}

// ============================================================================
// Section 6 — Step 0: Fetch User ID
// ============================================================================

let userId;
{
  const data = await makeApiCall(`${CLOCKIFY_BASE_URL}/user`, { method: "GET" });
  userId = data.id;
  console.log(`✓ Authenticated as ${data.name} (userId: ${userId})`);
}

// ============================================================================
// Section 7 — Step 1: Hours Validation
// ============================================================================

const beforeRows = csvParse(fs.readFileSync(ORIGINAL_CSV_PATH, "utf-8"), {
  columns: true,
  skip_empty_lines: true,
});
const afterRows = csvParse(fs.readFileSync(ENRICHED_CSV_PATH, "utf-8"), {
  columns: true,
  skip_empty_lines: true,
});

// Per-day totals
const beforeByDate = new Map();
for (const row of beforeRows) {
  const d = parseEntryDate(row);
  beforeByDate.set(d, (beforeByDate.get(d) ?? 0) + parseDurationH(row["Duration (h)"]));
}
const afterByDate = new Map();
for (const row of afterRows) {
  const d = parseEntryDate(row);
  afterByDate.set(d, (afterByDate.get(d) ?? 0) + parseDurationH(row["Duration (h)"]));
}

const allDates = new Set([...beforeByDate.keys(), ...afterByDate.keys()]);
const dayDiscrepancies = [];
for (const d of allDates) {
  const b = beforeByDate.get(d) ?? 0;
  const a = afterByDate.get(d) ?? 0;
  if (Math.abs(b - a) > 0.25) {
    dayDiscrepancies.push(
      `  ${d}: before=${hoursToHMM(b)}, after=${hoursToHMM(a)}, diff=${hoursToHMM(Math.abs(b - a))}`,
    );
  }
}
if (dayDiscrepancies.length > 0) {
  console.error("Hours validation failed — per-day discrepancies:");
  for (const line of dayDiscrepancies) console.error(line);
  process.exit(1);
}

const beforeGrand = [...beforeByDate.values()].reduce((s, x) => s + x, 0);
const afterGrand = [...afterByDate.values()].reduce((s, x) => s + x, 0);
if (Math.abs(beforeGrand - afterGrand) > 0.5) {
  console.error(
    `Hours validation failed — grand total: before=${hoursToHMM(beforeGrand)}, after=${hoursToHMM(afterGrand)}`,
  );
  process.exit(1);
}

console.log("✓ Hours validation passed");

// ============================================================================
// Section 8 — Step 2: Day-by-Day Diff and Confirmation
// ============================================================================

const beforeGrouped = groupByDate(beforeRows);
const afterGrouped = groupByDate(afterRows);

let sortedDates = Array.from(
  new Set([...beforeGrouped.keys(), ...afterGrouped.keys()]),
).sort();

if (dayFilter) {
  sortedDates = sortedDates.filter((d) => d === dayFilter);
  if (sortedDates.length === 0) {
    console.error(`No entries found for --day ${dayFilter}.`);
    process.exit(1);
  }
}

function fmt24(dateStr, timeStr) {
  const d = parseClockifyDate(dateStr, timeStr);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

const confirmedDays = [];
const skippedDays = [];

for (const date of sortedDates) {
  const bRows = beforeGrouped.get(date) ?? [];
  const aRows = afterGrouped.get(date) ?? [];

  if (isUnchangedDay(bRows, aRows)) continue;

  const bTotal = bRows.reduce((s, r) => s + parseDurationH(r["Duration (h)"]), 0);
  const aTotal = aRows.reduce((s, r) => s + parseDurationH(r["Duration (h)"]), 0);

  console.log(`\n=== ${date} ===`);
  console.log(`BEFORE (${bRows.length} entries, ${hoursToHMM(bTotal)}h):`);
  for (const r of bRows) {
    const start = fmt24(r["Start Date"], r["Start Time"]);
    const end = fmt24(r["End Date"], r["End Time"]);
    console.log(`  ${start}–${end}  ${r["Duration (h)"]}  ${r["Description"]}`);
  }
  console.log(`AFTER (${aRows.length} entries, ${hoursToHMM(aTotal)}h):`);
  for (const r of aRows) {
    const start = fmt24(r["Start Date"], r["Start Time"]);
    const end = fmt24(r["End Date"], r["End Time"]);
    console.log(`  ${start}–${end}  ${r["Duration (h)"]}  ${r["Description"]}`);
  }

  if (autoYes) {
    console.log("Auto-confirming: Y");
    confirmedDays.push({ date, aRows });
    continue;
  }

  const ans = await prompt("Update this day? [Y]es / [S]kip / [E]xit: ");
  const key = ans.trim().toLowerCase();
  if (key === "y") {
    confirmedDays.push({ date, aRows });
  } else if (key === "s") {
    skippedDays.push(date);
  } else if (key === "e") {
    console.log("Exiting.");
    process.exit(0);
  } else {
    console.log("Unrecognised input; skipping day.");
    skippedDays.push(date);
  }
}

if (confirmedDays.length === 0) {
  console.log("\nNo days to update.");
}

// ============================================================================
// Section 9 — Step 3: Apply Changes via Clockify API
// ============================================================================

const errors = [];
let entriesUploaded = 0;

for (const { date, aRows } of confirmedDays) {
  console.log(`\nProcessing ${date}...`);
  try {
    // Fetch existing entries for this day
    const startParam = encodeURIComponent(`${date}T00:00:00Z`);
    const endParam = encodeURIComponent(`${date}T23:59:59Z`);
    const existing = await makeApiCall(
      `${CLOCKIFY_BASE_URL}/workspaces/${workspaceId}/user/${userId}/time-entries?start=${startParam}&end=${endParam}`,
      { method: "GET" },
    );

    // Delete each existing entry
    const toDelete = Array.isArray(existing) ? existing : [];
    for (const entry of toDelete) {
      try {
        await makeApiCall(
          `${CLOCKIFY_BASE_URL}/workspaces/${workspaceId}/time-entries/${entry.id}`,
          { method: "DELETE" },
        );
        console.log(`  Deleted entry ${entry.id}`);
      } catch (err) {
        errors.push({ day: date, operation: "DELETE", entryId: entry.id, error: err.message });
        console.error(`  Failed to delete ${entry.id}: ${err.message}`);
      }
    }

    // POST each enriched entry
    for (const row of aRows) {
      const payload = {
        start: entryToIso(row["Start Date"], row["Start Time"]),
        end: entryToIso(row["End Date"], row["End Time"]),
        description: row["Description"],
        projectId,
        billable: false,
        userId,
      };
      try {
        const created = await makeApiCall(
          `${CLOCKIFY_BASE_URL}/workspaces/${workspaceId}/time-entries`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );
        entriesUploaded++;
        console.log(`  Created entry ${created.id ?? "(dry-run)"}: ${row["Description"].slice(0, 60)}`);
      } catch (err) {
        errors.push({
          day: date,
          operation: "POST",
          description: row["Description"],
          error: err.message,
        });
        console.error(`  Failed to create entry "${row["Description"].slice(0, 60)}": ${err.message}`);
      }
    }
  } catch (err) {
    errors.push({ day: date, operation: "FETCH", error: err.message });
    console.error(`  Failed to fetch entries for ${date}: ${err.message}`);
  }
}

// ============================================================================
// Section 10 — Step 4: Finalization
// ============================================================================

if (skippedDays.length > 0) {
  fs.writeFileSync(UPLOAD_SKIPPED_PATH, skippedDays.join("\n") + "\n", "utf-8");
  console.log(`\nSkipped days written to ${UPLOAD_SKIPPED_PATH}`);
}

if (errors.length > 0) {
  const lines = errors.map((e) => {
    const id = e.entryId ? ` entryId=${e.entryId}` : e.description ? ` desc="${e.description}"` : "";
    return `[${e.day}] ${e.operation}${id}: ${e.error}`;
  });
  fs.writeFileSync(UPLOAD_ERRORS_PATH, lines.join("\n") + "\n", "utf-8");
}

console.log(`
─────────────────────────────────────
Upload complete.
Days processed : ${confirmedDays.length}
Days skipped   : ${skippedDays.length}
Entries uploaded: ${entriesUploaded}
Errors          : ${errors.length}${errors.length > 0 ? " (see output/upload-errors.txt)" : ""}
─────────────────────────────────────`);
