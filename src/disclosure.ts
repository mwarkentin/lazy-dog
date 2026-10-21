/**
 * Disclosure markers: an author saying AI helped. These are reported, never
 * counted against a PR, and removed from the text Pangram scores.
 */

const TOOLS = String.raw`(?:claude(?: code)?|copilot|chatgpt|gpt-?\d[\w.-]*|openai|codex|cursor|gemini|devin|aider|windsurf|cline)\b`

const PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: 'generated-with footer',
    re: new RegExp(String.raw`\bgenerated (?:with|by|using) \[?` + TOOLS, 'i')
  },
  {
    name: 'AI Co-Authored-By trailer',
    re: new RegExp(
      String.raw`^\s*co-authored-by:.*(?:\b` + TOOLS + String.raw`|noreply@anthropic\.com)`,
      'im'
    )
  },
  {
    name: 'AI-use statement',
    re: /\b(?:written|drafted|generated|created|authored) (?:(?:this|it) )?(?:with|using|by) (?:the help of |help from |assistance from )?(?:an? )?(?:AI|LLM)\b/i
  }
]

/** Names of the disclosure markers found in a PR body. */
export function detectDisclosure(body: string): string[] {
  return PATTERNS.filter(({ re }) => re.test(body)).map(({ name }) => name)
}

/** Whether a single line is a disclosure marker (and so not the author's prose). */
export function isDisclosureLine(line: string): boolean {
  return PATTERNS.some(({ re }) => re.test(line))
}
