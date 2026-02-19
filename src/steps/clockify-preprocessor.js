#!/usr/bin/env node

// ============================================================================
// 2a. Imports and constants
// ============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

const REQUIRED_COLUMNS = [
  "Description",
  "Start Date",
  "Start Time",
  "End Date",
  "End Time",
  "Duration (h)",
];

const COLUMNS_TO_REMOVE = [
  "Project",
  "Client",
  "Task",
  "Kiosk",
  "User",
  "Group",
  "Email",
  "Tags",
  "Billable",
  "Date of creation",
  "Duration (decimal)",
];

const OUTPUT_PATH = path.resolve(projectRoot, "cache", "clockify-cleaned.csv");

// ============================================================================
// 2b. CLI argument parsing
// ============================================================================

const options = {
  input: {
    type: "string",
    short: "i",
  },
  "force-refresh": {
    type: "boolean",
    short: "f",
  },
  help: {
    type: "boolean",
    short: "h",
  },
};

if (process.argv.includes("--default-params")) {
  const idx = process.argv.indexOf("--default-params");
  process.argv.splice(idx, 1, "--ai", "1", "--use-cache", "--yes");
}

let parsedArgs;
try {
  parsedArgs = parseArgs({ options, strict: false });
} catch (error) {
  console.error(`Failed to parse CLI arguments: ${error.message}`);
  process.exit(1);
}

if (parsedArgs.values.help) {
  console.log(`
clockify-preprocessor — Validate and filter Clockify CSV exports

Usage:
  node clockify-preprocessor.js [options]

Options:
  --input, -i <path>      Path to input CSV file
  --force-refresh, -f     Clear cache before processing
  --help, -h              Show this help message
`);
  process.exit(0);
}

// ============================================================================
// 2c. Config loading
// ============================================================================

let configInputPath;
const configPath = path.resolve(projectRoot, "config.json");

try {
  if (fs.existsSync(configPath)) {
    const configContent = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent);
    configInputPath = config?.clockify?.input_csv;
  }
} catch (error) {
  console.error(
    `Failed to load or parse config.json at ${configPath}: ${error.message}`,
  );
  process.exit(1);
}

// ============================================================================
// 2d. Resolve input path
// ============================================================================

const cliInputPath = parsedArgs.values.input;
const inputPath = cliInputPath || configInputPath;

if (!inputPath) {
  console.error(
    "Input CSV path not specified. Use --input <path> or set clockify.input_csv in config.json.",
  );
  process.exit(1);
}

const resolvedInputPath = path.resolve(projectRoot, inputPath);

// ============================================================================
// 2e. Handle --force-refresh
// ============================================================================

if (parsedArgs.values["force-refresh"] && fs.existsSync(OUTPUT_PATH)) {
  fs.unlinkSync(OUTPUT_PATH);
  console.log("Cache cleared.");
}

// ============================================================================
// 2f. Ensure cache directory exists
// ============================================================================

const cacheDir = path.dirname(OUTPUT_PATH);
fs.mkdirSync(cacheDir, { recursive: true });

// ============================================================================
// 2g. Read and parse the input CSV
// ============================================================================

if (!fs.existsSync(resolvedInputPath)) {
  console.error(
    `Input CSV not found: ${resolvedInputPath}. Check config or --input flag.`,
  );
  process.exit(1);
}

let csvContent;
try {
  csvContent = fs.readFileSync(resolvedInputPath, "utf-8");
} catch (error) {
  console.error(`Failed to read input CSV: ${error.message}`);
  process.exit(1);
}

let records;
try {
  records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
} catch (error) {
  console.error(`Failed to parse CSV: ${error.message}`);
  process.exit(1);
}

// ============================================================================
// 2h. Validate required columns
// ============================================================================

if (records.length === 0) {
  console.error("CSV is empty or contains no data rows.");
  process.exit(1);
}

const columnNames = Object.keys(records[0]);
const missingColumns = REQUIRED_COLUMNS.filter(
  (col) => !columnNames.includes(col),
);

if (missingColumns.length > 0) {
  console.error(
    `CSV missing required columns: ${missingColumns.join(", ")}. Export detailed report from Clockify.`,
  );
  process.exit(1);
}

// ============================================================================
// 2i. Filter columns
// ============================================================================

const filteredRecords = records.map((record) =>
  Object.fromEntries(REQUIRED_COLUMNS.map((col) => [col, record[col]])),
);

// ============================================================================
// 2j. Write cleaned CSV to cache
// ============================================================================

let csvOutput;
try {
  csvOutput = stringify(filteredRecords, {
    header: true,
    columns: REQUIRED_COLUMNS,
  });
} catch (error) {
  console.error(`Failed to stringify CSV: ${error.message}`);
  process.exit(1);
}

try {
  fs.writeFileSync(OUTPUT_PATH, csvOutput, "utf-8");
} catch (error) {
  console.error(`Failed to write output: ${error.message}`);
  process.exit(1);
}

// ============================================================================
// 2k. Show summary
// ============================================================================

console.log(
  `Processed ${filteredRecords.length} entries. Output: cache/clockify-cleaned.csv`,
);
