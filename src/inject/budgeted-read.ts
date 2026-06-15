/**
 * Token-budgeted Markdown section reader.
 *
 * Parses a Markdown file into sections (split on `## ` headings),
 * sorts them by a priority list, and accumulates them until the
 * token budget is exhausted. The overflowing section is truncated.
 */

import fs from "node:fs";
import { estimateTokens, truncateToTokenBudget } from "../shared/tokens.js";
import { createLogger } from "../shared/log.js";

interface Section {
  heading: string; // includes the `## ` prefix and trailing newline
  body: string;    // content after heading until next section
}

/**
 * Parse a Markdown file into sections. Each section is a `## ` heading
 * followed by its body (up to the next `## ` heading or EOF).
 * Content before the first `## ` heading is treated as a section with
 * an empty heading string.
 */
function parseMarkdownSections(content: string): Section[] {
  if (!content) return [];

  const sections: Section[] = [];
  const lines = content.split("\n");
  let currentHeading = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // Flush previous section
      if (currentHeading || currentBody.length > 0) {
        sections.push({
          heading: currentHeading,
          body: currentBody.join("\n"),
        });
      }
      currentHeading = line;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  // Flush last section
  if (currentHeading || currentBody.length > 0) {
    sections.push({
      heading: currentHeading,
      body: currentBody.join("\n"),
    });
  }

  return sections;
}

/**
 * Sort sections by priority. Sections whose heading (case-insensitive)
 * contains a priority keyword come first, in priority order.
 * Sections that match no priority keyword go last (in original order).
 */
function sortByPriority(sections: Section[], priority: string[]): Section[] {
  const priorityLower = priority.map((p) => p.toLowerCase());

  function priorityIndex(section: Section): number {
    const headingLower = section.heading.toLowerCase();
    for (let i = 0; i < priorityLower.length; i++) {
      if (headingLower.includes(priorityLower[i])) {
        return i;
      }
    }
    return priorityLower.length; // unmatched → last
  }

  // Stable sort: preserve original order within same priority bucket
  return [...sections].sort((a, b) => {
    const ai = priorityIndex(a);
    const bi = priorityIndex(b);
    if (ai !== bi) return ai - bi;
    // preserve original insertion order for same-priority items
    return 0;
  });
}

/**
 * Read a Markdown file and return a budget-constrained excerpt.
 *
 * Sections are sorted by priority and accumulated until the token budget
 * is exhausted. The section that would overflow is truncated with a
 * `[truncated]` marker.
 *
 * @param filePath - Absolute path to the Markdown file
 * @param budgetTokens - Maximum tokens to include
 * @param sectionPriority - Priority-ordered keywords for section headings
 * @returns The budgeted content, or "" if file not found or empty
 */
export function budgetedRead(
  filePath: string,
  budgetTokens: number,
  sectionPriority: string[],
): string {
  if (budgetTokens <= 0) return "";

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    // File not found or unreadable — log warning, return empty
    const logger = createLogger();
    logger.debug(`budgetedRead: file not found or unreadable: ${filePath}`);
    return "";
  }

  if (!content.trim()) return "";

  const sections = parseMarkdownSections(content);
  if (sections.length === 0) return "";

  const sorted = sortByPriority(sections, sectionPriority);
  let output = "";
  let remaining = budgetTokens;

  for (const section of sorted) {
    const sectionText =
      (section.heading ? section.heading + "\n" : "") + section.body + "\n";
    const sectionTokens = estimateTokens(sectionText);

    if (sectionTokens <= remaining) {
      output += sectionText + "\n";
      remaining -= sectionTokens;
    } else {
      // This section would overflow — truncate its body to fit
      const headingPart = section.heading ? section.heading + "\n" : "";
      const availableForBody = remaining - estimateTokens(headingPart);
      if (availableForBody > 0) {
        const truncatedBody = truncateToTokenBudget(section.body, availableForBody);
        output += headingPart + truncatedBody + "\n\n";
      }
      break;
    }
  }

  return output.trimEnd();
}
