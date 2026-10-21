import { getOctokit } from '@actions/github'
import { toPullRequestInfo, type PullRequestInfo } from './skip.js'

export interface IssueComment {
  id: number
  body: string
  userLogin: string
  userType: string
  htmlUrl: string
}

/** The GitHub calls this action makes, behind an interface so tests can fake them. */
export interface GitHubApi {
  getPullRequest(number: number): Promise<PullRequestInfo | null>
  /** File contents at a ref, or null if it doesn't exist. */
  getFile(path: string, ref: string): Promise<string | null>
  /** Directory listing at a ref, or null if it doesn't exist. */
  listDir(path: string, ref: string): Promise<{ name: string; path: string; type: string }[] | null>
  listComments(issueNumber: number): Promise<IssueComment[]>
  createComment(issueNumber: number, body: string): Promise<IssueComment>
  updateComment(commentId: number, body: string): Promise<IssueComment>
  /** Login of whoever most recently added `label`, if the timeline says. */
  findLabelActor(issueNumber: number, label: string): Promise<string | null>
}

export function createGitHubApi(token: string, owner: string, repo: string): GitHubApi {
  const octokit = getOctokit(token)

  const notFound = (err: unknown): boolean => (err as { status?: number })?.status === 404
  const toComment = (c: {
    id: number
    body?: string | null
    html_url: string
    user?: { login: string; type: string } | null
  }): IssueComment => ({
    id: c.id,
    body: c.body ?? '',
    userLogin: c.user?.login ?? '',
    userType: c.user?.type ?? '',
    htmlUrl: c.html_url
  })

  return {
    async getPullRequest(number) {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
      return toPullRequestInfo(data)
    },

    async getFile(path, ref) {
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref })
        if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null
        return Buffer.from(data.content, 'base64').toString('utf8')
      } catch (err) {
        if (notFound(err)) return null
        throw err
      }
    },

    async listDir(path, ref) {
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref })
        if (!Array.isArray(data)) return null
        return data.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type }))
      } catch (err) {
        if (notFound(err)) return null
        throw err
      }
    },

    async listComments(issueNumber) {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100
      })
      return comments.map(toComment)
    },

    async createComment(issueNumber, body) {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body
      })
      return toComment(data)
    },

    async updateComment(commentId, body) {
      const { data } = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body
      })
      return toComment(data)
    },

    async findLabelActor(issueNumber, label) {
      const events = await octokit.paginate(octokit.rest.issues.listEvents, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100
      })
      const wanted = label.toLowerCase()
      let actor: string | null = null
      for (const event of events) {
        const name = (event as { label?: { name?: string } }).label?.name
        if (event.event === 'labeled' && name?.toLowerCase() === wanted) {
          actor = event.actor?.login ?? actor
        }
      }
      return actor
    }
  }
}
