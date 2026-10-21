import { templateLines } from './clean.js'
import type { GitHubApi } from './github.js'

interface Logger {
  warning(message: string): void
}

/**
 * Lines of the repo's PR template(s), read from the base branch. GitHub looks
 * in .github/, the root, then docs/, case-insensitively, and allows a
 * PULL_REQUEST_TEMPLATE/ directory of several templates.
 */
export async function loadTemplateLines(
  api: GitHubApi,
  ref: string,
  log: Logger
): Promise<Set<string> | undefined> {
  try {
    for (const dir of ['.github', '', 'docs']) {
      const entries = await api.listDir(dir, ref)
      if (!entries) continue
      const contents: string[] = []
      for (const entry of entries) {
        if (entry.type === 'file' && /^pull_request_template\.md$/i.test(entry.name)) {
          contents.push((await api.getFile(entry.path, ref)) ?? '')
        } else if (entry.type === 'dir' && /^pull_request_template$/i.test(entry.name)) {
          for (const file of (await api.listDir(entry.path, ref)) ?? []) {
            if (file.type === 'file' && /\.md$/i.test(file.name)) {
              contents.push((await api.getFile(file.path, ref)) ?? '')
            }
          }
        }
      }
      if (contents.length) return templateLines(...contents)
    }
  } catch (err) {
    log.warning(`Could not read the PR template, so it won't be stripped: ${message(err)}`)
  }
  return undefined
}

/** Custom failure template from the base branch; never the PR head, which the author controls. */
export async function loadFailureTemplate(
  api: GitHubApi,
  path: string,
  ref: string,
  log: Logger
): Promise<string | null> {
  try {
    const text = await api.getFile(path.replace(/^\.?\//, ''), ref)
    if (text?.trim()) return text
    log.warning(`failure-message-file ${path} was not found on ${ref}; using the default message.`)
  } catch (err) {
    log.warning(`Could not read failure-message-file ${path}: ${message(err)}`)
  }
  return null
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
