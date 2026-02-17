import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "../../");

/**
 * Validate configuration structure
 * @param {object} config - Configuration object to validate
 * @throws {Error} If validation fails
 */
export function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Configuration must be an object");
  }

  const requiredFields = {
    github: [
      "personal_access_token",
      "repo_owner",
      "repo_name",
      "date_from",
      "date_to",
    ],
    jira: [
      "base_url",
      "api_token",
      "user_email",
      "project_keys",
      "date_from",
      "date_to",
    ],
    clockify: ["input_csv", "output_mirrored", "output_standardized"],
  };

  for (const [section, fields] of Object.entries(requiredFields)) {
    if (!config[section]) {
      throw new Error(`Missing required section: ${section}`);
    }

    for (const field of fields) {
      if (!(field in config[section])) {
        throw new Error(`Missing required field: ${section}.${field}`);
      }
    }
  }

  // Validate date formats (ISO 8601: YYYY-MM-DD)
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(config.github.date_from)) {
    throw new Error(
      "Invalid date format for github.date_from. Use ISO 8601 (YYYY-MM-DD)",
    );
  }
  if (!datePattern.test(config.github.date_to)) {
    throw new Error(
      "Invalid date format for github.date_to. Use ISO 8601 (YYYY-MM-DD)",
    );
  }
  if (!datePattern.test(config.jira.date_from)) {
    throw new Error(
      "Invalid date format for jira.date_from. Use ISO 8601 (YYYY-MM-DD)",
    );
  }
  if (!datePattern.test(config.jira.date_to)) {
    throw new Error(
      "Invalid date format for jira.date_to. Use ISO 8601 (YYYY-MM-DD)",
    );
  }

  // Validate project_keys is an array
  if (!Array.isArray(config.jira.project_keys)) {
    throw new Error("jira.project_keys must be an array");
  }

  if (config.jira.project_keys.length === 0) {
    throw new Error("jira.project_keys must not be empty");
  }

  // Validate developer_emails if present
  if (config.github.developer_emails !== undefined) {
    if (!Array.isArray(config.github.developer_emails)) {
      throw new Error("github.developer_emails must be an array");
    }
  }
}

/**
 * Load and validate configuration
 * @param {object} cliArgs - CLI arguments to override config
 * @returns {object} Validated configuration object
 * @throws {Error} If config file not found or validation fails
 */
export function loadConfig(cliArgs = {}) {
  let config;

  const configPath = path.join(projectRoot, "config.json");

  try {
    const configContent = fs.readFileSync(configPath, "utf-8");
    config = JSON.parse(configContent);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "Config file not found. Copy config.example.json to config.json and fill in your credentials.",
      );
    }
    throw new Error(`Failed to read config.json: ${error.message}`);
  }

  // Apply defaults
  if (!config.github.main_branch) {
    config.github.main_branch = "develop";
  }

  // Deep merge CLI args for known nested sections, shallow merge the rest
  const nestedSections = ["github", "jira", "clockify"];
  for (const key of Object.keys(cliArgs)) {
    if (nestedSections.includes(key) && typeof cliArgs[key] === "object" && cliArgs[key] !== null) {
      config[key] = { ...config[key], ...cliArgs[key] };
    } else {
      config[key] = cliArgs[key];
    }
  }

  // Validate configuration
  validateConfig(config);

  return config;
}
