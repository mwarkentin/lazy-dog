/**
 * {{placeholder}} substitution. Templates are trusted (they come from the
 * workflow or the base branch); values are not, so plain string values are
 * escaped. Values already rendered as safe markdown are passed as { raw }.
 */

export type PlaceholderValue = string | { raw: string }
export type Placeholders = Record<string, PlaceholderValue>

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g

export function renderTemplate(
  template: string,
  values: Placeholders,
  onUnknown: (name: string) => void = () => {}
): string {
  return template
    .replace(PLACEHOLDER, (match, name: string) => {
      const value = values[name]
      if (value === undefined) {
        onUnknown(name)
        return match
      }
      return typeof value === 'string' ? escapeMarkdown(value) : value.raw
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!)
}

/** Escape text for inline markdown so it renders literally and can't inject HTML. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+!|~]/g, '\\$&')
}

/**
 * Wrap text in a code span that it can't break out of: the fence is longer
 * than any backtick run inside, and newlines are flattened.
 */
export function codeSpan(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}
