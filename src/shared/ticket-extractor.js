/**
 * Extract all ticket IDs from text
 * Matches patterns like SD-123, PROJ-456, etc.
 * @param {string} text - Text to extract ticket IDs from
 * @returns {string[]} Array of unique ticket IDs in uppercase
 */
export function extractTicketIds(text) {
  if (!text || typeof text !== "string") {
    return [];
  }

  // Regex pattern: 2-10 uppercase letters, hyphen, one or more digits
  const pattern = /\b([A-Z]{2,10}-\d+)\b/g;
  const matches = Array.from(text.matchAll(pattern));

  // Extract the matched text and deduplicate using Set
  const uniqueIds = new Set(matches.map((match) => match[1]));

  return Array.from(uniqueIds);
}
