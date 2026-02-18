#!/usr/bin/env node

// ============================================================================
// Section 1 — Shebang, Imports, and Constants
// ============================================================================

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { randomUUID } from "crypto";
import { parse as csvParse } from "csv-parse/sync";
import { stringify as csvStringify } from "csv-stringify/sync";

import { loadConfig } from "./src/shared/config.js";
import {
  initCache,
  appendToCache,
  readCache,
  writeConsolidatedCache,
  clearCache,
} from "./src/shared/cache.js";
import { extractTicketIds } from "./src/shared/ticket-extractor.js";
import {
  parseClockifyDate,
  parseISOToLocal,
  isWithinDayWindow,
  splitTimeWindow,
  formatClockifyDate,
  formatClockifyTime,
} from "./src/shared/date-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

const CLOCKIFY_CLEANED_PATH = path.resolve(
  projectRoot,
  "cache/clockify-cleaned.csv",
);
const GITHUB_SUMMARY_PATH = path.resolve(
  projectRoot,
  "cache/github-summary.json",
);
const JIRA_SUMMARY_PATH = path.resolve(projectRoot, "cache/jira-summary.json");
const PATTERNS_PATH = path.resolve(projectRoot, "cache/patterns.json");
const ENRICHMENT_PROGRESS_PATH = path.resolve(
  projectRoot,
  "cache/enrichment-progress.ndjson",
);
const TOKEN_HISTORY_PATH = path.resolve(
  projectRoot,
  "cache/token-history.json",
);
const OUTPUT_MIRRORED_PATH = path.resolve(
  projectRoot,
  "output/enriched-mirrored.csv",
);
const OUTPUT_STANDARDIZED_PATH = path.resolve(
  projectRoot,
  "output/enriched-standardized.csv",
);
const DIFF_PATH = path.resolve(projectRoot, "output/diff.txt");
const MAX_BATCH_SIZE = 10;

// ============================================================================
// Section 2 — Helper Functions (before IIFE)
// ============================================================================

export function prompt(question) {
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

export function hoursToHMM(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours % 1) * 60);
  return `${h}:${m.toString().padStart(2, "0")}`;
}

export function stripMarkdownFences(str) {
  if (!str || typeof str !== "string") return str;
  return str.replace(/```json\n?/g, "").replace(/```\n?/g, "");
}

export function safeParseJSON(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function applyPatterns(description, patterns) {
  if (!patterns || typeof patterns !== "object") return description;
  const text = (description || "").toLowerCase();
  for (const [groupKey, group] of Object.entries(patterns)) {
    if (!group || !Array.isArray(group.variants)) continue;
    for (const v of group.variants) {
      if (!v) continue;
      const variant = v.toLowerCase();
      if (text.includes(variant)) {
        return group.suggested_standard || description;
      }
    }
  }
  return description;
}

export function distributeSubTasksToEntry(subTasks, entryHours) {
  // Greedy assign subtasks until entryHours filled; adjust last assigned
  const assigned = [];
  let remaining = entryHours;
  for (let i = 0; i < subTasks.length && remaining > 0; i++) {
    const t = { ...subTasks[i] };
    if (t.hours <= remaining) {
      assigned.push(t);
      remaining = +(remaining - t.hours).toFixed(6);
    } else {
      // partially assign
      const part = { ...t, hours: remaining };
      assigned.push(part);
      remaining = 0;
    }
  }

  // If rounding mismatch, adjust last
  const sum = assigned.reduce((s, x) => s + x.hours, 0);
  const diff = +(entryHours - sum).toFixed(6);
  if (Math.abs(diff) > 0 && assigned.length > 0) {
    assigned[assigned.length - 1].hours = +(
      assigned[assigned.length - 1].hours + diff
    ).toFixed(6);
  }

  return assigned;
}

function parseHMM(hmm) {
  if (!hmm) return 0;
  const [h, m] = hmm.split(":").map((s) => parseInt(s, 10) || 0);
  return h + m / 60;
}

// ============================================================================
// Section 3 — CLI Argument Parsing
// ============================================================================

const options = {
  "force-refresh": { type: "boolean", short: "f" },
  help: { type: "boolean", short: "h" },
};

let parsedArgs;
try {
  parsedArgs = parseArgs({ options });
} catch (err) {
  console.error(`Failed to parse CLI arguments: ${err.message}`);
  process.exit(1);
}

if (parsedArgs.values.help) {
  console.log(`
clockify-enricher — Enrich Clockify CSV with GitHub/Jira context

Usage:
  node clockify-enricher.js [options]

Options:
  --force-refresh, -f     Clear caches and regenerate
  --help, -h              Show this help message
`);
  process.exit(0);
}

// ============================================================================
// Section 4 — Config Loading
// ============================================================================

let config;
try {
  config = await loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// ============================================================================
// Section 5 — Dependency Checks
// ============================================================================

if (!fs.existsSync(CLOCKIFY_CLEANED_PATH)) {
  console.error(
    "Run clockify-preprocessor.js first. See README for workflow order.",
  );
  process.exit(1);
}
if (!fs.existsSync(GITHUB_SUMMARY_PATH)) {
  console.error(
    "Run github-summarizer.js first. See README for workflow order.",
  );
  process.exit(1);
}
if (!fs.existsSync(JIRA_SUMMARY_PATH)) {
  console.error("Run jira-summarizer.js first. See README for workflow order.");
  process.exit(1);
}

// ============================================================================
// Section 6 — Load Inputs
// ============================================================================

let clockifyRows;
try {
  const content = fs.readFileSync(CLOCKIFY_CLEANED_PATH, "utf-8");
  clockifyRows = csvParse(content, { columns: true, skip_empty_lines: true });
} catch (err) {
  console.error(
    `Failed to read or parse ${CLOCKIFY_CLEANED_PATH}: ${err.message}`,
  );
  process.exit(1);
}

let githubData;
try {
  githubData = JSON.parse(fs.readFileSync(GITHUB_SUMMARY_PATH, "utf-8"));
} catch (err) {
  console.error(`Failed to read ${GITHUB_SUMMARY_PATH}: ${err.message}`);
  process.exit(1);
}

let jiraData;
try {
  jiraData = JSON.parse(fs.readFileSync(JIRA_SUMMARY_PATH, "utf-8"));
} catch (err) {
  console.error(`Failed to read ${JIRA_SUMMARY_PATH}: ${err.message}`);
  process.exit(1);
}

// ============================================================================
// Section 7 — Date Range Mismatch Detection
// ============================================================================

let minDate = null;
let maxDate = null;
for (const row of clockifyRows) {
  try {
    const d = parseClockifyDate(row["Start Date"], row["Start Time"]);
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  } catch {
    // skip malformed
  }
}

import { format as formatDateFns } from "date-fns";
const clockMin = minDate ? formatDateFns(minDate, "yyyy-MM-dd") : null;
const clockMax = maxDate ? formatDateFns(maxDate, "yyyy-MM-dd") : null;

if (clockMin && clockMax) {
  const mismatch =
    clockMin < config.github.date_from ||
    clockMax > config.github.date_to ||
    clockMin < config.jira.date_from ||
    clockMax > config.jira.date_to;

  if (mismatch) {
    console.log(`Detected Clockify date range ${clockMin} → ${clockMax} outside configured ranges:

GitHub config: ${config.github.date_from} → ${config.github.date_to}
Jira config:   ${config.jira.date_from} → ${config.jira.date_to}

Accept recommended changes and restart the script? (y/n) `);

    const ans = (
      await prompt("Accept recommended changes and restart the script? (y/n) ")
    ).toLowerCase();
    if (ans === "y") {
      // Update config file
      const configPath = path.join(projectRoot, "config.json");
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        cfg.github.date_from = clockMin;
        cfg.github.date_to = clockMax;
        cfg.jira.date_from = clockMin;
        cfg.jira.date_to = clockMax;
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
        console.log("Config updated. Re-run the previous step in workflow.");
        process.exit(0);
      } catch (err) {
        console.error(`Failed to update config.json: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.warn("Proceeding despite date range mismatch.");
    }
  }
}

// ============================================================================
// Section 8 — AI Provider Selection
// ============================================================================

import {
  listProviders,
  promptProviderSelection,
  executeProvider,
} from "./src/shared/cli-provider.js";
const providers = listProviders();
if (providers.length === 0) {
  console.error(
    "No AI providers found in cli-providers/. Add a provider script first.",
  );
  process.exit(1);
}
const selectedProvider = await promptProviderSelection(providers);
// Accumulate tokens used from provider metadata across all calls
let totalActualTokensAccum = 0;

function extractTokensFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return 0;
  // Common locations
  if (typeof metadata.total_tokens === "number") return metadata.total_tokens;
  if (typeof metadata.token_count === "number") return metadata.token_count;
  if (metadata.usage && typeof metadata.usage.total_tokens === "number")
    return metadata.usage.total_tokens;
  if (
    metadata.usage &&
    typeof metadata.usage.prompt_tokens === "number" &&
    typeof metadata.usage.completion_tokens === "number"
  )
    return metadata.usage.prompt_tokens + metadata.usage.completion_tokens;
  return 0;
}

// ============================================================================
// Section 9 — Force Refresh
// ============================================================================

if (parsedArgs.values["force-refresh"]) {
  if (fs.existsSync(PATTERNS_PATH)) fs.unlinkSync(PATTERNS_PATH);
  if (fs.existsSync(ENRICHMENT_PROGRESS_PATH))
    fs.unlinkSync(ENRICHMENT_PROGRESS_PATH);
  const alt = ENRICHMENT_PROGRESS_PATH.replace(".ndjson", ".json");
  if (fs.existsSync(alt)) fs.unlinkSync(alt);
  console.log("Caches cleared.");
}

// ============================================================================
// Section 10 — Pattern Detection
// ============================================================================

let patterns = null;
if (!fs.existsSync(PATTERNS_PATH)) {
  // Collect unique descriptions
  const descSet = new Set();
  for (const r of clockifyRows) {
    if (r.Description) descSet.add(r.Description);
  }
  const descriptions = Array.from(descSet);

  const promptText = `Detect pattern groups from the following Clockify descriptions. Return a JSON object where each key is a group id and value is { variants: [..], suggested_standard: string, count: number }:\n\n${descriptions.join("\n")}`;

  const result = await executeProvider(selectedProvider, promptText);
  const { response: resultResponse, metadata: resultMeta } = result || {};
  totalActualTokensAccum += extractTokensFromMetadata(resultMeta);
  const cleaned = stripMarkdownFences(resultResponse);
  const parsed = safeParseJSON(cleaned, null);
  if (!parsed) {
    console.error("Failed to parse patterns JSON from AI response.");
    process.exit(1);
  }

  fs.writeFileSync(PATTERNS_PATH, JSON.stringify(parsed, null, 2), "utf-8");
  patterns = parsed;

  // Print summary
  for (const [k, g] of Object.entries(patterns)) {
    console.log(
      `  ${k}: ${Array.isArray(g.variants) ? g.variants.length : 0} variants, ${g.count || 0} occurrences`,
    );
  }

  const accept = (await prompt("Accept these patterns? (y/n): ")).toLowerCase();
  if (accept !== "y") {
    console.log("Edit cache/patterns.json and run enricher again.");
    process.exit(0);
  }
} else {
  patterns = JSON.parse(fs.readFileSync(PATTERNS_PATH, "utf-8"));
}

// ============================================================================
// Section 11 — Two-Phase Matching
// ============================================================================

const matchResults = [];
for (let i = 0; i < clockifyRows.length; i++) {
  const row = clockifyRows[i];
  const clockifyTicketIds = extractTicketIds(row.Description || "");
  let clockifyDate = null;
  try {
    clockifyDate = parseClockifyDate(row["Start Date"], row["Start Time"]);
  } catch {
    clockifyDate = null;
  }

  const githubMatches = [];
  const githubMatchesExact = []; // exact ticket overlap
  const githubMatchesNear = []; // exact matches but within ±1 day window

  if (clockifyTicketIds.length > 0) {
    const ticketSet = new Set(clockifyTicketIds);
    for (const item of githubData) {
      const itemTickets = Array.isArray(item.ticket_ids) ? item.ticket_ids : [];
      if (itemTickets.some((t) => ticketSet.has(t))) {
        githubMatchesExact.push(item);
      }
    }
    // From exact matches, extract the subset within ±1 day window (near matches)
    if (clockifyDate) {
      for (const item of githubMatchesExact) {
        try {
          const itemDate = item.type === "pr" ? item.merged_at : item.date;
          const parsed = parseISOToLocal(itemDate);
          if (isWithinDayWindow(clockifyDate, parsed, 1)) {
            githubMatchesNear.push(item);
          }
        } catch {
          // skip
        }
      }
    }
  } else if (clockifyDate) {
    // date-only match as fallback (lower priority)
    for (const item of githubData) {
      try {
        const itemDate = item.type === "pr" ? item.merged_at : item.date;
        const parsed = parseISOToLocal(itemDate);
        if (isWithinDayWindow(clockifyDate, parsed, 1))
          githubMatchesNear.push(item);
      } catch {
        // skip
      }
    }
  }

  // Prioritize near matches first, then other exact matches
  githubMatches.push(
    ...githubMatchesNear,
    ...githubMatchesExact.filter((x) => !githubMatchesNear.includes(x)),
  );

  const jiraMatches = [];
  if (clockifyTicketIds.length > 0) {
    for (const j of jiraData) {
      if (clockifyTicketIds.includes(j.ticket_id)) jiraMatches.push(j);
    }
  }

  const confidence =
    clockifyTicketIds.length > 0 &&
    (githubMatches.length > 0 || jiraMatches.length > 0)
      ? "high"
      : githubMatches.length > 0 || jiraMatches.length > 0
        ? "medium"
        : "low";

  matchResults.push({
    rowIndex: i,
    clockifyEntry: row,
    clockifyDate,
    ticketIds: clockifyTicketIds,
    githubMatches,
    jiraMatches,
    matchPhase: confidence === "low" ? "none" : "exact",
    confidence,
  });
}

// Phase 2 — AI semantic matching for "none"
const unmatched = matchResults.filter((m) => m.matchPhase === "none");
if (unmatched.length > 0) {
  const entriesList = unmatched
    .map(
      (m) =>
        `${m.rowIndex}) ${m.clockifyDate ? formatDateFns(m.clockifyDate, "yyyy-MM-dd") : "?"} | ${m.clockifyEntry.Description || ""}`,
    )
    .join("\n");

  const githubList = githubData
    .map((g) => {
      if (g.type === "pr") {
        return `PR#${g.pr_number}: ${g.merged_at || "?"} | ${g.pr_title || ""} | ${g.ai_description || ""}`;
      } else if (g.type === "commit_group") {
        return `COMMIT_GROUP@${g.date}: ${g.ai_description || ""}`;
      }
      return "";
    })
    .filter((x) => x)
    .join("\n");
  const jiraList = jiraData
    .map((j) => `${j.ticket_id} | ${j.title || ""}`)
    .join("\n");

  const semanticPrompt = `For these unmatched Clockify entries, suggest possible GitHub PR or Jira ticket matches.\n\nEntries:\n${entriesList}\n\nGitHub items:\n${githubList}\n\nJira Tickets:\n${jiraList}\n\nReturn a JSON array where each element is { rowIndex: <number>, github_match: <"PR#<number>"|"COMMIT_GROUP@<date>"|null>, jira_match: <ticket_id|null>, confidence: "high"|"medium"|"low" }`;

  try {
    const resp = await executeProvider(selectedProvider, semanticPrompt);
    const { response: respResponse, metadata: respMeta } = resp || {};
    totalActualTokensAccum += extractTokensFromMetadata(respMeta);
    const cleaned = stripMarkdownFences(respResponse);
    const parsed = safeParseJSON(cleaned, []);
    if (Array.isArray(parsed)) {
      for (const res of parsed) {
        const idx = matchResults.findIndex((m) => m.rowIndex === res.rowIndex);
        if (idx !== -1) {
          matchResults[idx].matchPhase = "semantic";
          matchResults[idx].confidence =
            res.confidence || matchResults[idx].confidence;
          if (res.github_match) {
            // Handle multiple formats: numeric, "pr_<number>", or commit group like "COMMIT_GROUP@<date>"
            let prNum = null;
            if (typeof res.github_match === "number") {
              prNum = res.github_match;
            } else if (typeof res.github_match === "string") {
              if (res.github_match.startsWith("PR#")) {
                prNum = parseInt(res.github_match.substring(3), 10);
              } else if (res.github_match.startsWith("pr_")) {
                prNum = parseInt(res.github_match.substring(3), 10);
              } else if (res.github_match.startsWith("COMMIT_GROUP@")) {
                const commitDate = res.github_match.substring(
                  "COMMIT_GROUP@".length,
                );
                const cg = githubData.find(
                  (x) => x.type === "commit_group" && x.date === commitDate,
                );
                if (cg) matchResults[idx].githubMatches.push(cg);
                // prNum stays null — fall through to jira_match check
              } else {
                prNum = parseInt(res.github_match, 10);
              }
            }
            if (prNum && !isNaN(prNum)) {
              const g = githubData.find((x) => x.pr_number == prNum);
              if (g) matchResults[idx].githubMatches.push(g);
            }
          }
          if (res.jira_match) {
            const j = jiraData.find((x) => x.ticket_id == res.jira_match);
            if (j) matchResults[idx].jiraMatches.push(j);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`Warning: Semantic matching failed: ${err.message}`);
  }
}

// ============================================================================
// Section 12 — Multi-Day Aggregation
// ============================================================================

const groups = new Map();
for (const m of matchResults) {
  const primary =
    (m.ticketIds && m.ticketIds[0]) ||
    m.clockifyEntry.Description ||
    "UNASSIGNED";
  if (!groups.has(primary)) groups.set(primary, []);
  groups.get(primary).push(m);
}

for (const [k, entries] of groups.entries()) {
  if (entries.length > 1) {
    const total = entries.reduce(
      (s, e) => s + (parseHMM(e.clockifyEntry["Duration (h)"]) || 0),
      0,
    );
    for (const e of entries) {
      e.isMultiDayGroup = true;
      e.groupTotalHours = total;
      e.groupGithubMatches = entries.flatMap((x) => x.githubMatches || []);
      e.groupJiraMatches = entries.flatMap((x) => x.jiraMatches || []);
    }
  }
}

// ============================================================================
// Section 13 — Task Decomposition (AI)
// ============================================================================

for (const [key, entries] of groups.entries()) {
  // Determine if decomposition needed
  const shouldDecompose =
    entries.length > 1 ||
    (entries.length === 1 && (entries[0].ticketIds || []).length > 1);
  if (!shouldDecompose) continue;

  // Build decomposition prompt per group
  const totalHours =
    entries[0].groupTotalHours ||
    parseHMM(entries[0].clockifyEntry["Duration (h)"]); // use first for single
  const jiraTickets = Array.from(
    new Set(
      entries.flatMap((e) =>
        e.groupJiraMatches ? e.groupJiraMatches.map((j) => j.ticket_id) : [],
      ),
    ),
  );
  const gh = Array.from(
    new Set(
      entries.flatMap((e) =>
        e.groupGithubMatches
          ? e.groupGithubMatches.map((g) => g.pr_number)
          : [],
      ),
    ),
  );

  // Build a detailed decomposition prompt including required context and rules
  const promptParts = [];
  promptParts.push(
    `Decompose the following work into specific subtasks totaling ${totalHours}h.`,
  );
  promptParts.push(`Context and rules:
  - Provide concise subtask descriptions in past tense, professional and defensible.
  - Hours must sum exactly to ${totalHours}h; adjust the last item to ensure the sum matches.
  - Testing/debugging tasks should not exceed 1h total unless the work is primarily test-related.
  - Be specific about what was done; reference files/modules where applicable.
  - Return ONLY valid JSON (no markdown) as an array of objects: { "description": string, "hours": number, "ticket_id": string|null, "confidence": "high"|"medium"|"low" }.`);

  // Include Clockify descriptions for each entry
  promptParts.push(`Clockify entries (${entries.length}):`);
  for (const e of entries) {
    const desc = e.clockifyEntry.Description || "";
    const ch = e.clockifyEntry["Duration (h)"] || "";
    promptParts.push(`- Entry index ${e.rowIndex}: "${desc}" — ${ch}h`);
  }

  // Include Jira and GitHub context
  if (jiraTickets.length > 0)
    promptParts.push(`Jira tickets and metadata: ${jiraTickets.join(", ")}`);
  if (gh.length > 0) promptParts.push(`GitHub PRs: ${gh.join(", ")}`);

  // Provide per-PR/jira detailed context
  promptParts.push("Detailed GitHub/Jira context:");
  // list GitHub PR details
  for (const prId of gh) {
    const prObj = entries
      .flatMap((e) => e.groupGithubMatches || [])
      .find((p) => p.pr_number == prId);
    if (prObj) {
      const modules = Array.isArray(prObj.modules_touched)
        ? prObj.modules_touched.join(", ")
        : "";
      const commits = Array.isArray(prObj.commit_messages)
        ? prObj.commit_messages.join(" || ")
        : "";
      promptParts.push(
        `- PR ${prId}: pr_title="${prObj.pr_title || ""}", ai_description="${prObj.ai_description || ""}", modules="${modules}", files_changed=${prObj.files_changed || 0}, lines_added=${prObj.lines_added || 0}, lines_removed=${prObj.lines_removed || 0}, commit_messages="${commits}", complexity_signal="${prObj.complexity_signal || ""}"`,
      );
    }
  }

  // list Jira details
  for (const jt of jiraTickets) {
    const jObj = entries
      .flatMap((e) => e.groupJiraMatches || [])
      .find((j) => j.ticket_id == jt);
    if (jObj) {
      const sp =
        jObj.story_points || jObj.storyPoint || jObj.story_points_count || 0;
      const back =
        jObj.back_to_development_count || jObj.back_to_dev_count || 0;
      const summary = jObj.description_summary || "";
      promptParts.push(
        `- Jira ${jt}: title="${jObj.title || ""}", story_points=${sp}, back_to_development_count=${back}, description_summary="${summary}"`,
      );
    }
  }

  promptParts.push(
    "Return a JSON array of subtask objects: { description, hours, ticket_id (optional), confidence }.",
  );

  try {
    const resp = await executeProvider(
      selectedProvider,
      promptParts.join("\n\n"),
    );
    const { response: respResponse, metadata: respMeta } = resp || {};
    totalActualTokensAccum += extractTokensFromMetadata(respMeta);
    const cleaned = stripMarkdownFences(respResponse);
    const parsed = safeParseJSON(cleaned, null);
    if (Array.isArray(parsed)) {
      // validate sum
      let sum = parsed.reduce((s, t) => s + (t.hours || 0), 0);
      if (Math.abs(sum - totalHours) > 0.001) {
        const diff = +(totalHours - sum).toFixed(6);
        parsed[parsed.length - 1].hours = +(
          parsed[parsed.length - 1].hours + diff
        ).toFixed(6);
      }

      // Assign sub-tasks to group entries using shared cursor (each sub-task consumed only once)
      const subTasksCopy = parsed.map((t) => ({ ...t })); // shallow copy for cursor-based allocation
      let cursorIndex = 0;
      for (const e of entries) {
        const entryHours = e.isMultiDayGroup
          ? parseHMM(e.clockifyEntry["Duration (h)"])
          : totalHours;
        e.subTasks = [];
        let remaining = entryHours;

        // Greedily allocate sub-tasks from cursor position
        while (remaining > 0 && cursorIndex < subTasksCopy.length) {
          const t = subTasksCopy[cursorIndex];
          if (t.hours <= remaining) {
            // Entire sub-task fits; consume it and advance cursor
            e.subTasks.push({ ...t });
            remaining = +(remaining - t.hours).toFixed(6);
            cursorIndex++;
          } else {
            // Partial assignment; keep cursor at this sub-task, adjust its hours
            e.subTasks.push({ ...t, hours: remaining });
            subTasksCopy[cursorIndex].hours = +(t.hours - remaining).toFixed(6);
            remaining = 0;
          }
        }

        // Ensure entry's sub-tasks sum exactly to its hours (adjust last if needed)
        const sum = e.subTasks.reduce((s, x) => s + x.hours, 0);
        const diff = +(entryHours - sum).toFixed(6);
        if (Math.abs(diff) > 0 && e.subTasks.length > 0) {
          e.subTasks[e.subTasks.length - 1].hours = +(
            e.subTasks[e.subTasks.length - 1].hours + diff
          ).toFixed(6);
        }
      }
    }
  } catch (err) {
    console.warn(
      `Warning: Decomposition failed for group ${key}: ${err.message}`,
    );
  }
}

// ============================================================================
// Section 13b — Build Work Items Array
// ============================================================================
// Post-decomposition: construct workItems array (one per output row).
// Each work item represents a single row in final output: either a non-split entry or a sub-task from a split.
// This array is the central data structure for token estimation, resumption, batching, and enrichment.

const workItems = [];
for (const m of matchResults) {
  if (m.subTasks && m.subTasks.length > 0) {
    // Split entry: create one work item per sub-task
    const splitGroupId = randomUUID();
    const subTaskCount = m.subTasks.length;
    for (let subIndex = 0; subIndex < subTaskCount; subIndex++) {
      const subTask = m.subTasks[subIndex];
      const workItemKey = `${m.rowIndex}:${subIndex}`;
      workItems.push({
        workItemKey, // "rowIndex:subIndex" for splits
        rowIndex: m.rowIndex,
        subIndex,
        draftDescription: subTask.description || "",
        durationHours: subTask.hours,
        ticketId: subTask.ticket_id || (m.ticketIds && m.ticketIds[0]) || null,
        ticketIds: m.ticketIds || [],
        splitGroupId, // UUID for this group of split rows
        subTaskCount,
        githubMatches: m.groupGithubMatches || m.githubMatches || [],
        jiraMatches: m.groupJiraMatches || m.jiraMatches || [],
        clockifyDate: m.clockifyDate,
        clockifyEntry: m.clockifyEntry,
        confidence: m.confidence || "low",
        matchPhase: m.matchPhase,
        isMultiDayGroup: m.isMultiDayGroup || false,
        groupTotalHours: m.groupTotalHours || 0,
      });
    }
  } else {
    // Non-split entry: single work item
    const workItemKey = `${m.rowIndex}:0`;
    const durationHours = parseHMM(m.clockifyEntry["Duration (h)"] || 0);
    workItems.push({
      workItemKey,
      rowIndex: m.rowIndex,
      subIndex: 0,
      draftDescription: m.clockifyEntry.Description || "",
      durationHours,
      ticketId: (m.ticketIds && m.ticketIds[0]) || null,
      ticketIds: m.ticketIds || [],
      splitGroupId: null, // no split for non-split entries
      subTaskCount: 1,
      githubMatches: m.githubMatches || [],
      jiraMatches: m.jiraMatches || [],
      clockifyDate: m.clockifyDate,
      clockifyEntry: m.clockifyEntry,
      confidence: m.confidence || "low",
      matchPhase: m.matchPhase,
      isMultiDayGroup: m.isMultiDayGroup || false,
      groupTotalHours: m.groupTotalHours || 0,
    });
  }
}

// ============================================================================
// Section 14 — Token Estimation
// ============================================================================

let totalOutputRows = workItems.length;

let tokenHistory = { runs: [] };
if (fs.existsSync(TOKEN_HISTORY_PATH)) {
  try {
    tokenHistory = JSON.parse(fs.readFileSync(TOKEN_HISTORY_PATH, "utf-8"));
  } catch {}
}

const coeffRuns = tokenHistory.runs
  .filter((r) => r.actual && r.estimated)
  .map((r) => r.actual / r.estimated);
const coefficient =
  coeffRuns.length > 0
    ? coeffRuns.reduce((s, x) => s + x, 0) / coeffRuns.length
    : 1.0;
const baseEstimate = totalOutputRows * 800;
const adjustedEstimate = Math.round(baseEstimate * coefficient);

const tokenAns = (
  await prompt(
    `Estimated tokens: ~${adjustedEstimate.toLocaleString()}. Continue? (y/n) `,
  )
).toLowerCase();
if (tokenAns !== "y") process.exit(0);

// ============================================================================
// Section 15 — Resume Detection for Enrichment
// ============================================================================

const progressItems = await initCache(ENRICHMENT_PROGRESS_PATH);
// Track processed work items by workItemKey (new format)
const processedKeys = new Set(
  progressItems
    .filter((i) => typeof i.workItemKey === "string")
    .map((i) => i.workItemKey),
);
// Backward compatibility: if old cache has rowIndex-only entries, synthesize workItemKey "${rowIndex}:0"
for (const item of progressItems) {
  if (typeof item.rowIndex === "number" && !item.workItemKey) {
    // Old format: synthesize the work item key for unsplit rows (they would be rowIndex:0)
    const synthKey = `${item.rowIndex}:0`;
    processedKeys.add(synthKey);
  }
}

// ============================================================================
// Section 16 — Smart Batching
// ============================================================================

// Build batches keyed by primary ticket or date for unassigned (work items grouping)
const batches = [];
const byKey = new Map();
for (const wi of workItems) {
  // Skip if already processed (check workItemKey)
  if (processedKeys.has(wi.workItemKey)) continue;

  const key =
    wi.ticketId ||
    (wi.clockifyDate
      ? formatDateFns(wi.clockifyDate, "yyyy-MM-dd")
      : "UNASSIGNED");
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(wi);
}

for (const [k, arr] of byKey.entries()) {
  if (arr.length <= MAX_BATCH_SIZE) batches.push(arr);
  else {
    for (let i = 0; i < arr.length; i += MAX_BATCH_SIZE)
      batches.push(arr.slice(i, i + MAX_BATCH_SIZE));
  }
}

// ============================================================================
// Section 17 — AI Enrichment Loop
// ============================================================================

let processed = 0;
const total = batches.reduce((s, b) => s + b.length, 0);
for (const batch of batches) {
  const promptLines = [];
  promptLines.push(
    "Enrich the following Clockify entries. For each entry, produce a concise, professional, past-tense, defensible description of work performed, suitable for time-tracking records. Avoid referencing AI. Be specific and reference PRs, files, or Jira tickets when applicable.",
  );
  promptLines.push(
    "Return ONLY valid JSON: an array of objects with { workItemKey: <string>, enriched_description: string, confidence: 'high'|'medium'|'low', notes: string }.",
  );
  promptLines.push("");
  for (const wi of batch) {
    // Build GitHub context with type distinction
    const ghEntries = wi.githubMatches
      .map((g) => {
        if (g.type === "pr") {
          return `PR#${g.pr_number}: title="${(g.pr_title || "").replace(/\n/g, " ")}", ai_description="${(g.ai_description || "").replace(/\n/g, " ")}", modules="${Array.isArray(g.modules_touched) ? g.modules_touched.join(", ") : ""}", files_changed=${g.files_changed || 0}, complexity="${g.complexity_signal || ""}"`;
        } else if (g.type === "commit_group") {
          return `COMMIT_GROUP@${g.date}: ai_description="${(g.ai_description || "").replace(/\n/g, " ")}", modules="${Array.isArray(g.modules_touched) ? g.modules_touched.join(", ") : ""}"`;
        }
        return "";
      })
      .filter((x) => x)
      .join(" || ");

    // Build Jira context with additional fields
    const jiraEntries = wi.jiraMatches
      .map(
        (j) =>
          `${j.ticket_id}: title="${(j.title || "").replace(/\n/g, " ")}", story_points=${j.story_points || j.story_points_count || 0}, back_to_dev=${j.back_to_development_count || 0}, summary="${(j.description_summary || "").replace(/\n/g, " ")}"`,
      )
      .join(" || ");

    promptLines.push(`WORK_ITEM_KEY: ${wi.workItemKey}`);
    promptLines.push(
      `Date: ${wi.clockifyDate ? formatDateFns(wi.clockifyDate, "yyyy-MM-dd") : "?"}`,
    );
    promptLines.push(`Duration: ${hoursToHMM(wi.durationHours)}`);
    promptLines.push(
      `Original Clockify description: "${(wi.clockifyEntry?.Description || "").replace(/\n/g, " ")}"`,
    );
    if (wi.subIndex >= 0 && wi.splitGroupId) {
      // For split rows, include draft from decomposition
      promptLines.push(
        `AI decomposed task: "${(wi.draftDescription || "").replace(/\n/g, " ")}"`,
      );
    }
    promptLines.push(`Matched GitHub: ${ghEntries || "None"}`);
    promptLines.push(`Matched Jira: ${jiraEntries || "None"}`);
    promptLines.push("---");
  }

  try {
    const resp = await executeProvider(
      selectedProvider,
      promptLines.join("\n"),
    );
    const { response: respResponse, metadata: respMeta } = resp || {};
    totalActualTokensAccum += extractTokensFromMetadata(respMeta);
    const cleaned = stripMarkdownFences(respResponse);
    const parsed = safeParseJSON(cleaned, null);
    if (!Array.isArray(parsed)) throw new Error("AI response not an array");

    for (const r of parsed) {
      // Parse uses workItemKey
      const workItemKey = r.workItemKey;
      const target = batch.find((bi) => bi.workItemKey === workItemKey);
      if (!target) continue;
      const record = {
        workItemKey: target.workItemKey,
        rowIndex: target.rowIndex,
        subIndex: target.subIndex,
        enriched_description:
          r.enriched_description ||
          r.description ||
          target.draftDescription ||
          "",
        ai_confidence: r.confidence || "low",
        ai_notes: r.notes || "",
      };
      await appendToCache(ENRICHMENT_PROGRESS_PATH, record);
      processed++;
      process.stdout.write(`\rEnriching entries... ${processed}/${total}`);
    }
  } catch (err) {
    console.error("AI provider failed. Progress saved. Re-run to resume.");
    process.exit(1);
  }
}
console.log("");

// ============================================================================
// Section 18 — Deterministic Timestamp Splitting + Output Assembly
// ============================================================================

// Load enrichment results and index by workItemKey (primary) and rowIndex (fallback for old format)
const enrichmentResults = readCache(ENRICHMENT_PROGRESS_PATH);
const enrichmentByKey = new Map(
  enrichmentResults
    .filter((r) => typeof r.workItemKey === "string")
    .map((r) => [r.workItemKey, r]),
);
// Backward compat: map rowIndex to first result if no workItemKey
const enrichmentByIndex = new Map();
for (const r of enrichmentResults) {
  if (!enrichmentByIndex.has(r.rowIndex)) {
    enrichmentByIndex.set(r.rowIndex, r);
  }
}

const mirroredRows = [];
const standardizedRows = [];
const diffLines = [];

for (const m of matchResults) {
  const matchRowIndex = m.rowIndex;

  // Get work items for this match result
  const wiForThisRow = workItems.filter((wi) => wi.rowIndex === matchRowIndex);

  if (m.subTasks && m.subTasks.length > 0) {
    // Split entry
    const start = parseClockifyDate(
      m.clockifyEntry["Start Date"],
      m.clockifyEntry["Start Time"],
    );
    const end = parseClockifyDate(
      m.clockifyEntry["End Date"],
      m.clockifyEntry["End Time"],
    );
    const durations = m.subTasks.map((t) => t.hours);
    let segments = [];
    try {
      segments = splitTimeWindow(start, end, durations);
    } catch (err) {
      console.error(
        `Failed to deterministically split time window for row ${m.rowIndex}: ${err.message}`,
      );
      process.exit(1);
    }

    const splitGroupId = wiForThisRow[0]?.splitGroupId || randomUUID();
    diffLines.push(
      `[${m.rowIndex}] ${m.clockifyDate ? formatDateFns(m.clockifyDate, "yyyy-MM-dd") : "?"} | ${m.clockifyEntry["Duration (h)"]}`,
    );
    diffLines.push(`ORIGINAL: ${m.clockifyEntry.Description}`);
    diffLines.push("ENRICHED:");

    for (let i = 0; i < m.subTasks.length; i++) {
      const t = m.subTasks[i];
      const seg = segments[i];
      const workItemKey = `${matchRowIndex}:${i}`;
      const enrichment = enrichmentByKey.get(workItemKey) || {};

      // Use AI-enriched description if available, otherwise use draft from decomposition
      const enrichedDescription =
        enrichment.enriched_description || t.description || "";
      const patterned = applyPatterns(enrichedDescription, patterns);

      // Build AI_Notes with deterministic context
      const aiNotes = buildAINotesForSplitRow(
        m,
        i,
        m.subTasks.length,
        enrichment,
      );

      const mirrored = {
        Description: patterned,
        "Start Date": formatClockifyDate(seg.start),
        "Start Time": formatClockifyTime(seg.start),
        "End Date": formatClockifyDate(seg.end),
        "End Time": formatClockifyTime(seg.end),
        "Duration (h)": hoursToHMM(t.hours),
      };
      mirroredRows.push(mirrored);

      const standardized = {
        Description: patterned,
        "Start Date": formatClockifyDate(seg.start),
        "Start Time": formatClockifyTime(seg.start),
        "End Date": formatClockifyDate(seg.end),
        "End Time": formatClockifyTime(seg.end),
        "Duration (h)": hoursToHMM(t.hours),
        AI_Confidence: enrichment.ai_confidence || t.confidence || "low",
        AI_Notes: aiNotes,
        Split_Group_ID: splitGroupId,
      };
      standardizedRows.push(standardized);

      diffLines.push(
        `  → [${i + 1}/${m.subTasks.length}] ${patterned} - ${hoursToHMM(t.hours)}`,
      );
    }
    diffLines.push("---");
  } else {
    // Non-split entry
    const workItemKey = `${matchRowIndex}:0`;
    const enrichment =
      enrichmentByKey.get(workItemKey) ||
      enrichmentByIndex.get(matchRowIndex) ||
      {};
    const enrichedDescription =
      enrichment.enriched_description || m.clockifyEntry.Description;
    const patterned = applyPatterns(enrichedDescription, patterns);

    // Build AI_Notes for non-split row
    const aiNotes = buildAINotesForNonSplitRow(m, enrichment);

    const start = parseClockifyDate(
      m.clockifyEntry["Start Date"],
      m.clockifyEntry["Start Time"],
    );
    const end = parseClockifyDate(
      m.clockifyEntry["End Date"],
      m.clockifyEntry["End Time"],
    );

    const mirrored = {
      Description: patterned,
      "Start Date": formatClockifyDate(start),
      "Start Time": formatClockifyTime(start),
      "End Date": formatClockifyDate(end),
      "End Time": formatClockifyTime(end),
      "Duration (h)": m.clockifyEntry["Duration (h)"],
    };
    mirroredRows.push(mirrored);

    const standardized = {
      Description: patterned,
      "Start Date": formatClockifyDate(start),
      "Start Time": formatClockifyTime(start),
      "End Date": formatClockifyDate(end),
      "End Time": formatClockifyTime(end),
      "Duration (h)": m.clockifyEntry["Duration (h)"],
      AI_Confidence: enrichment.ai_confidence || m.confidence || "low",
      AI_Notes: aiNotes,
      Split_Group_ID: null,
    };
    standardizedRows.push(standardized);

    diffLines.push(
      `[${m.rowIndex}] ${m.clockifyDate ? formatDateFns(m.clockifyDate, "yyyy-MM-dd") : "?"} | ${m.clockifyEntry["Duration (h)"]}`,
    );
    diffLines.push(`ORIGINAL: ${m.clockifyEntry.Description}`);
    diffLines.push(
      `ENRICHED: ${enrichedDescription} - ${m.clockifyEntry["Duration (h)"]}`,
    );
    diffLines.push("---");
  }
}

// Helper functions for AI_Notes population (Step 10)
function buildAINotesForSplitRow(matchResult, subIndex, totalSubs, enrichment) {
  const parts = [];

  // Start with any AI-provided notes
  if (enrichment.ai_notes && enrichment.ai_notes.trim()) {
    parts.push(enrichment.ai_notes);
  }

  // Add deterministic context
  const context = [];

  // Add split position
  context.push(`split ${subIndex + 1}/${totalSubs}`);

  // Add ticket ID if matched
  if (matchResult.ticketIds && matchResult.ticketIds.length > 0) {
    const primaryTicketId = matchResult.ticketIds[0];
    context.push(`matched via exact ticket ${primaryTicketId}`);
  }

  // Add GitHub PRs if matched (with type distinction)
  if (matchResult.githubMatches && matchResult.githubMatches.length > 0) {
    const prRefs = matchResult.githubMatches
      .map((g) => {
        if (g.type === "pr") {
          return `PR#${g.pr_number}`;
        } else if (g.type === "commit_group") {
          return `COMMIT_GROUP@${g.date}`;
        }
        return "";
      })
      .filter((x) => x)
      .join(", ");
    if (prRefs) context.push(`github: ${prRefs}`);
  }

  // Add Jira tickets if matched
  if (matchResult.jiraMatches && matchResult.jiraMatches.length > 0) {
    const jiraRefs = matchResult.jiraMatches.map((j) => j.ticket_id).join(", ");
    context.push(`jira: ${jiraRefs}`);
  }

  // Combine all parts
  if (context.length > 0) {
    parts.push(context.join("; "));
  }

  return parts.join("; ");
}

function buildAINotesForNonSplitRow(matchResult, enrichment) {
  const parts = [];

  // Start with any AI-provided notes
  if (enrichment.ai_notes && enrichment.ai_notes.trim()) {
    parts.push(enrichment.ai_notes);
  }

  // Add deterministic context
  const context = [];

  // Add ticket ID if matched
  if (matchResult.ticketIds && matchResult.ticketIds.length > 0) {
    const primaryTicketId = matchResult.ticketIds[0];
    context.push(`matched via exact ticket ${primaryTicketId}`);
  }

  // Add GitHub PRs if matched (with type distinction)
  if (matchResult.githubMatches && matchResult.githubMatches.length > 0) {
    const prRefs = matchResult.githubMatches
      .map((g) => {
        if (g.type === "pr") {
          return `PR#${g.pr_number}`;
        } else if (g.type === "commit_group") {
          return `COMMIT_GROUP@${g.date}`;
        }
        return "";
      })
      .filter((x) => x)
      .join(", ");
    if (prRefs) context.push(`github: ${prRefs}`);
  }

  // Add Jira tickets if matched
  if (matchResult.jiraMatches && matchResult.jiraMatches.length > 0) {
    const jiraRefs = matchResult.jiraMatches.map((j) => j.ticket_id).join(", ");
    context.push(`jira: ${jiraRefs}`);
  }

  // Combine all parts
  if (context.length > 0) {
    parts.push(context.join("; "));
  }

  return parts.join("; ");
}

if (!fs.existsSync(path.dirname(OUTPUT_MIRRORED_PATH)))
  fs.mkdirSync(path.dirname(OUTPUT_MIRRORED_PATH), { recursive: true });

fs.writeFileSync(
  OUTPUT_MIRRORED_PATH,
  csvStringify(mirroredRows, { header: true }),
  "utf-8",
);
fs.writeFileSync(
  OUTPUT_STANDARDIZED_PATH,
  csvStringify(standardizedRows, { header: true }),
  "utf-8",
);
fs.writeFileSync(DIFF_PATH, diffLines.join("\n"), "utf-8");

// ============================================================================
// Section 20 — Token History Update
// ============================================================================

const actualTokens =
  totalActualTokensAccum > 0 ? totalActualTokensAccum : adjustedEstimate;
if (!fs.existsSync(TOKEN_HISTORY_PATH))
  fs.writeFileSync(
    TOKEN_HISTORY_PATH,
    JSON.stringify({ runs: [] }, null, 2),
    "utf-8",
  );
try {
  const hist = JSON.parse(fs.readFileSync(TOKEN_HISTORY_PATH, "utf-8"));
  hist.runs = hist.runs || [];
  hist.runs.push({
    date: new Date().toISOString(),
    estimated: adjustedEstimate,
    actual: actualTokens,
  });
  fs.writeFileSync(TOKEN_HISTORY_PATH, JSON.stringify(hist, null, 2), "utf-8");
} catch (err) {
  console.warn(`Warning: Failed to update token history: ${err.message}`);
}

// ============================================================================
// Section 21 — Summary Statistics
// ============================================================================

let highCount = 0,
  mediumCount = 0,
  lowCount = 0,
  totalRows = 0;
for (const s of standardizedRows) {
  totalRows++;
  const c = (s.AI_Confidence || "low").toLowerCase();
  if (c === "high") highCount++;
  else if (c === "medium") mediumCount++;
  else lowCount++;
}

if (totalRows === 0) totalRows = 1; // avoid div by zero
console.log(
  `\nSummary:\n  Total rows: ${totalRows}\n  High confidence: ${highCount} (${Math.round((highCount / totalRows) * 100)}%)\n  Medium confidence: ${mediumCount} (${Math.round((mediumCount / totalRows) * 100)}%)\n  Low confidence: ${lowCount} (${Math.round((lowCount / totalRows) * 100)}%)\n`,
);

// ============================================================================
// Section 22 — Outer try/catch
// ============================================================================

// The script is structured sequentially; any unexpected error above will have exited.
