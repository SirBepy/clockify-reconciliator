import path from "path";

/**
 * Extract module name from file path
 * Strategy: Find segment after `src/` or `lib/`, otherwise use first segment
 * @param {string} filePath - File path to extract module from
 * @returns {string} Module name
 */
export function extractModule(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("filePath must be a non-empty string");
  }

  // Normalize path to use forward slashes for consistent handling
  const normalizedPath = filePath.replace(/\\/g, "/");

  // Check for src/ or lib/ directories (match with or without leading slash)
  const srcMatch = normalizedPath.match(/(?:^|\/)src\/([^/]+)/);
  if (srcMatch) {
    const segment = srcMatch[1];
    // If captured segment contains a dot, it's a filename (e.g., index.js) -> treat as root
    if (segment.includes(".")) return "src/root";
    return `src/${segment}`;
  }

  const libMatch = normalizedPath.match(/(?:^|\/)lib\/([^/]+)/);
  if (libMatch) {
    const segment = libMatch[1];
    if (segment.includes(".")) return "lib/root";
    return `lib/${segment}`;
  }

  // Handle test files
  if (
    normalizedPath.includes("/tests/") ||
    normalizedPath.match(/\.test\.(js|ts)$/)
  ) {
    return "tests";
  }

  // Extract first path segment
  const segments = normalizedPath
    .split("/")
    .filter((s) => s && !s.includes("."));
  if (segments.length > 0) {
    return segments[0];
  }

  // Fallback: extract filename without extension
  const baseName = path.basename(filePath);
  return baseName.replace(/\.[^.]+$/, "");
}

/**
 * Extract unique modules from array of file paths
 * @param {string[]} filePaths - Array of file paths
 * @returns {string[]} Array of unique module names
 */
export function extractModules(filePaths) {
  if (!Array.isArray(filePaths)) {
    throw new Error("filePaths must be an array");
  }

  const modules = new Set();
  for (const filePath of filePaths) {
    try {
      modules.add(extractModule(filePath));
    } catch {
      // Skip invalid paths
    }
  }

  return Array.from(modules);
}
