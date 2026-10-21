import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Whether the PR head commit has been checked out or fetched into the
 * workspace. This action never needs a checkout; under pull_request_target,
 * PR code in the workspace sits next to secrets.
 */
export function workspaceHasHead(workspace: string | undefined, headSha: string): boolean {
  if (!workspace || !/^[0-9a-f]{40}$/i.test(headSha)) return false
  const git = join(workspace, '.git')
  if (!existsSync(git)) return false
  const sha = headSha.toLowerCase()
  return ['HEAD', 'FETCH_HEAD', 'ORIG_HEAD'].some((name) => {
    try {
      return readFileSync(join(git, name), 'utf8').toLowerCase().includes(sha)
    } catch {
      return false
    }
  })
}
