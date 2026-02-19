#!/usr/bin/env node

// ============================================================================
// Section 1 — Shebang, Imports, and Constants
// ============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import readline from "readline";
import { loadConfig } from "../shared/config.js";
import {
  listProviders,
  promptProviderSelection,
  executeProvider,
} from "../shared/cli-provider.js";
import {
  initCache,
  appendToCache,
  writeConsolidatedCache,
  clearCache,
  readCache,
} from "../shared/cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

const CACHE_PATH = path.resolve(projectRoot, "cache", "jira-summary.ndjson");
const JIRA_PAGE_SIZE = 50;

// ============================================================================
// Section 2 — CLI Argument Parsing
// ============================================================================

const options = {
  "force-refresh": {
    type: "boolean",
    short: "f",
  },
  help: {
    type: "boolean",
    short: "h",
  },
};

let parsedArgs;
try {
  parsedArgs = parseArgs({ options });
} catch (error) {
  console.error(`Failed to parse CLI arguments: ${error.message}`);
  process.exit(1);
}

if (parsedArgs.values.help) {
  console.log(`
jira-summarizer — Fetch Jira tickets and summarize with AI

Usage:
  node jira-summarizer.js [options]

Options:
  --force-refresh, -f     Clear cache and fetch fresh data
  --help, -h              Show this help message
`);
  process.exit(0);
}

// ============================================================================
// Section 3 — Config Loading
// ============================================================================

let config;
try {
  config = await loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const jiraConfig = config.jira;

// ============================================================================
// Section 4 — Force Refresh
// ============================================================================

if (parsedArgs.values["force-refresh"]) {
  clearCache(CACHE_PATH);
  console.log("Cache cleared.");
}

// ============================================================================
// Section 5 — AI Provider Selection
// ============================================================================

const providers = listProviders();
if (providers.length === 0) {
  console.error(
    "No AI providers found in cli-providers/. Add a provider script first.",
  );
  process.exit(1);
}

const selectedProvider = await promptProviderSelection(providers);

// ============================================================================
// Section 6 — Cache Initialization (Resume Support)
// ============================================================================

const cachedItems = await initCache(CACHE_PATH);
const processedIds = new Set(cachedItems.map((item) => item.ticket_id));

if (processedIds.size > 0) {
  console.log(
    `Resuming from cache: ${processedIds.size} tickets already processed.`,
  );
}

// ============================================================================
// Section 7 — Jira API Helper (Script Phase)
// ============================================================================

async function fetchJira(path, config, { method = "GET", body } = {}) {
  const url = config.jira.base_url + path;
  const credentials = Buffer.from(
    `${config.jira.user_email}:${config.jira.api_token}`,
  ).toString("base64");

  const headers = {
    Authorization: `Basic ${credentials}`,
    Accept: "application/json",
  };

  const options = { method, headers };

  if (body) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(
      `Jira API error: ${response.status} ${response.statusText} - ${url}`,
    );
  }

  return response.json();
}

// ============================================================================
// Section 8 — Ticket Fetching (Script Phase)
// ============================================================================

async function fetchAllTickets(config) {
  const projectKeys = config.jira.project_keys.join(", ");
  const jql = `project in (${projectKeys}) AND assignee = currentUser() AND updated >= "${config.jira.date_from}" AND updated <= "${config.jira.date_to}" ORDER BY created ASC`;

  let allIssues = [];
  let nextPageToken = undefined;

  console.log(`JQL: ${jql}`);
  console.log("Fetching tickets...");

  while (true) {
    const body = {
      jql,
      maxResults: JIRA_PAGE_SIZE,
      fields: [
        "summary",
        "issuetype",
        "status",
        "description",
        "timetracking",
        "customfield_10016",
        "customfield_10028",
      ],
    };

    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const response = await fetchJira("/rest/api/3/search/jql", config, {
      method: "POST",
      body,
    });

    const page = response.issues ?? [];
    allIssues = allIssues.concat(page);
    process.stdout.write(`\rFetching tickets... ${allIssues.length}`);

    if (response.isLast || page.length === 0) {
      break;
    }

    nextPageToken = response.nextPageToken;
  }

  console.log("");
  return allIssues;
}

// ============================================================================
// Section 8a — Full Changelog Fetching (Script Phase)
// ============================================================================

async function fetchFullChangelog(issueKey, config) {
  const histories = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const queryParams = new URLSearchParams({
      startAt,
      maxResults,
    });

    const response = await fetchJira(
      `/rest/api/3/issue/${issueKey}/changelog?${queryParams}`,
      config,
    );

    if (response.values && response.values.length > 0) {
      histories.push(...response.values);
    }

    if (!response.isLast) {
      startAt += maxResults;
    } else {
      break;
    }
  }

  return histories;
}

// ============================================================================
// Section 9 — Status History Analysis (Script Phase)
// ============================================================================

function analyzeStatusHistory(histories) {
  const statusHistory = [];
  let backToDevCount = 0;

  if (Array.isArray(histories)) {
    for (const history of histories) {
      if (history.items) {
        for (const item of history.items) {
          if (item.field === "status") {
            statusHistory.push({
              status: item.toString,
              date: history.created.slice(0, 10),
            });

            const fromStateLower = (item.fromString || "").toLowerCase();
            const toStateLower = (item.toString || "").toLowerCase();

            const doneQaStates = [
              "done",
              "qa",
              "in review",
              "testing",
              "resolved",
              "closed",
            ];
            const devStates = [
              "in progress",
              "to do",
              "open",
              "reopened",
              "in development",
            ];

            if (
              doneQaStates.some((state) => fromStateLower.includes(state)) &&
              devStates.some((state) => toStateLower.includes(state))
            ) {
              backToDevCount++;
            }
          }
        }
      }
    }
  }

  return { statusHistory, backToDevCount };
}

// ============================================================================
// Section 10 — Conditional Comment Fetching (Script Phase)
// ============================================================================

function extractAdfText(adfNode) {
  if (!adfNode) return "";
  if (typeof adfNode === "string") return adfNode;

  let text = "";

  if (adfNode.text) {
    text += adfNode.text;
  }

  if (Array.isArray(adfNode.content)) {
    const blockTypes = [
      "paragraph",
      "heading",
      "listItem",
      "codeBlock",
      "blockquote",
    ];
    for (let i = 0; i < adfNode.content.length; i++) {
      const child = adfNode.content[i];
      text += extractAdfText(child);
      // Add newline after block-level elements (but not the last one)
      if (
        i < adfNode.content.length - 1 &&
        child.type &&
        blockTypes.includes(child.type)
      ) {
        text += "\n";
      }
    }
  }

  return text;
}

async function fetchCommentsIfNeeded(
  issueKey,
  backToDevCount,
  timeSpentHours,
  config,
) {
  const shouldFetch = backToDevCount >= 1 || timeSpentHours > 10;

  if (!shouldFetch) {
    return null;
  }

  const response = await fetchJira(
    `/rest/api/3/issue/${issueKey}/comment?maxResults=100`,
    config,
  );

  const comments = [];
  if (response.comments) {
    for (const comment of response.comments) {
      const commentText = extractAdfText(comment.body);
      comments.push(commentText);
    }
  }

  return comments.length > 0 ? comments : null;
}

// ============================================================================
// Section 11 — AI Summarization (AI Phase)
// ============================================================================

async function summarizeTicket(ticket, comments, selectedProvider) {
  const descriptionText =
    extractAdfText(ticket.fields.description) || "No description provided.";

  let prompt = `Summarize the following Jira ticket for time-tracking enrichment.

Ticket: ${ticket.key} - ${ticket.fields.summary}
Type: ${ticket.fields.issuetype?.name || "Unknown"}
Story Points: ${ticket.fields.story_points ?? ticket.fields.customfield_10016 ?? ticket.fields.customfield_10028 ?? "N/A"}

Description:
${descriptionText}`;

  if (comments && comments.length > 0) {
    prompt += `\n\nComments:\n`;
    prompt += comments.join("\n---\n");
  }

  prompt += `\n\nProvide a JSON response with:
- "description_summary": ~150 word summary of the technical work`;

  if (comments && comments.length > 0) {
    prompt += `\n- "comments_summary": ~100 word summary of key decisions, blockers, and QA feedback`;
  }

  prompt += `\n\nRespond ONLY with valid JSON, no markdown fences.`;

  const result = await executeProvider(selectedProvider, prompt);
  let jsonResponse = result.response;

  // Strip markdown fences if present
  jsonResponse = jsonResponse.replace(/```json\n?/g, "").replace(/```\n?/g, "");

  const parsed = JSON.parse(jsonResponse);

  return {
    description_summary: parsed.description_summary,
    comments_summary: parsed.comments_summary || null,
  };
}

// ============================================================================
// Section 12 — Main Orchestration Loop
// ============================================================================

(async () => {
  try {
    const allTickets = await fetchAllTickets(config);

    if (allTickets.length === 0) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise((resolve) => {
        rl.question(
          "No Jira tickets found in date range. Continue anyway? (y/n) ",
          (answer) => {
            rl.close();
            resolve(answer);
          },
        );
      });

      if (answer.toLowerCase() !== "y") {
        console.log("Check config.json jira settings.");
        process.exit(1);
      }

      await writeConsolidatedCache(CACHE_PATH, []);
      console.log("Processed 0 tickets. Output: cache/jira-summary.json");
      process.exit(0);
    }

    const newTickets = allTickets.filter(
      (ticket) => !processedIds.has(ticket.key),
    );

    for (let i = 0; i < newTickets.length; i++) {
      const issue = newTickets[i];

      try {
        const ticketId = issue.key;
        const title = issue.fields.summary;
        const type = issue.fields.issuetype?.name || "Unknown";
        const storyPoints =
          issue.fields.story_points ??
          issue.fields.customfield_10016 ??
          issue.fields.customfield_10028 ??
          null;
        const finalStatus = issue.fields.status?.name || "Unknown";

        const timeTrackingSeconds =
          issue.fields.timetracking?.timeSpentSeconds || 0;
        const timeSpentHours = timeTrackingSeconds / 3600;

        const fullHistories = await fetchFullChangelog(ticketId, config);
        const { statusHistory, backToDevCount } =
          analyzeStatusHistory(fullHistories);

        const comments = await fetchCommentsIfNeeded(
          ticketId,
          backToDevCount,
          timeSpentHours,
          config,
        );

        const { description_summary, comments_summary } = await summarizeTicket(
          issue,
          comments,
          selectedProvider,
        );

        const record = {
          ticket_id: ticketId,
          title,
          type,
          story_points: storyPoints,
          final_status: finalStatus,
          description_summary,
          back_to_development_count: backToDevCount,
          status_history: statusHistory,
        };

        if (comments_summary !== null) {
          record.comments_summary = comments_summary;
        }

        await appendToCache(CACHE_PATH, record);

        process.stdout.write(
          `\rSummarizing tickets... ${i + 1}/${newTickets.length}`,
        );
      } catch (error) {
        console.warn(
          `\nWarning: Failed to process ticket ${issue.key}: ${error.message}`,
        );
        continue;
      }
    }

    console.log("");

    const allItems = await readCache(CACHE_PATH);
    await writeConsolidatedCache(CACHE_PATH, allItems);

    console.log(
      `Processed ${allItems.length} tickets. Output: cache/jira-summary.json`,
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();
