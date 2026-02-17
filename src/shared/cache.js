import fs from "fs";
import path from "path";
import readline from "readline";

/**
 * Initialize cache file
 * @param {string} cachePath - Path to cache file
 * @param {object} options - Options for cache initialization
 * @param {boolean} options.autoResume - If true, automatically resume existing cache
 * @returns {Array} Array of existing cache items, or empty array if starting fresh
 */
export async function initCache(cachePath, options = {}) {
  const { autoResume = false } = options;

  const cacheDir = path.dirname(cachePath);

  // Create cache directory if needed
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // Check if cache file exists
  if (fs.existsSync(cachePath)) {
    if (autoResume) {
      console.log("Found existing cache. Resuming...");
      return readCache(cachePath);
    }

    // Interactive prompt for user
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(
        "Found existing cache. Resume or start fresh? (r/s): ",
        (answer) => {
          rl.close();

          if (answer.toLowerCase() === "r") {
            console.log("Resuming from cache...");
            resolve(readCache(cachePath));
          } else {
            console.log("Starting fresh...");
            fs.writeFileSync(cachePath, "");
            resolve([]);
          }
        },
      );
    });
  }

  return [];
}

/**
 * Append item to NDJSON cache
 * @param {string} cachePath - Path to cache file
 * @param {object} item - Item to append
 */
export function appendToCache(cachePath, item) {
  const jsonLine = JSON.stringify(item) + "\n";

  try {
    fs.appendFileSync(cachePath, jsonLine);
  } catch (error) {
    throw new Error(`Failed to write to cache: ${error.message}`);
  }
}

/**
 * Read all items from NDJSON cache
 * @param {string} cachePath - Path to cache file
 * @returns {Array} Array of parsed items
 */
export function readCache(cachePath) {
  if (!fs.existsSync(cachePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(cachePath, "utf-8");
    if (!content.trim()) {
      return [];
    }

    const lines = content.split("\n").filter((line) => line.trim());
    return lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          console.warn(`Warning: Failed to parse cache line: ${line}`);
          return null;
        }
      })
      .filter((item) => item !== null);
  } catch (error) {
    throw new Error(`Failed to read cache: ${error.message}`);
  }
}

/**
 * Write consolidated JSON file (pretty-printed)
 * @param {string} cachePath - Path to NDJSON cache file
 * @param {Array} items - Items to write
 */
export function writeConsolidatedCache(cachePath, items) {
  // Replace .ndjson extension with .json
  const jsonPath = cachePath.replace(/\.ndjson$/, ".json");

  const prettyJson = JSON.stringify(items, null, 2);

  try {
    fs.writeFileSync(jsonPath, prettyJson, "utf-8");
  } catch (error) {
    throw new Error(`Failed to write consolidated cache: ${error.message}`);
  }
}

/**
 * Clear cache files
 * @param {string} cachePath - Path to NDJSON cache file
 */
export function clearCache(cachePath) {
  try {
    // Remove NDJSON file
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }

    // Remove consolidated JSON file if exists
    const jsonPath = cachePath.replace(/\.ndjson$/, ".json");
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }
  } catch (error) {
    throw new Error(`Failed to clear cache: ${error.message}`);
  }
}
