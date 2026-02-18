/**
 * Extract all ticket IDs from text
 * Matches patterns like SD-123, PROJ-456, etc.
 * @param {string} text - Text to extract ticket IDs from
 * @returns {string[]} Array of unique ticket IDs in uppercase
 */
export function extractTicketIds(text, allowedPrefixes = null) {
  if (!text || typeof text !== "string") {
    return [];
  }

  // Regex pattern: 2-10 letters (any case), hyphen, one or more digits
  const pattern = /\b([A-Za-z]{2,10}-\d+)\b/gi;
  const matches = Array.from(text.matchAll(pattern));

  // Extract the matched text, normalize to uppercase and deduplicate using Set
  const uniqueIds = new Set(matches.map((match) => match[1].toUpperCase()));

  const ids = Array.from(uniqueIds);

  if (!allowedPrefixes || allowedPrefixes.length === 0) {
    return ids;
  }

  const prefixSet = new Set(allowedPrefixes.map((p) => p.toUpperCase()));
  return ids.filter((id) => prefixSet.has(id.split("-")[0]));
}
