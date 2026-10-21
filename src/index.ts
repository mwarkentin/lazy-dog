import * as core from '@actions/core'
import { context } from '@actions/github'
import { createGitHubApi } from './github.js'
import { run } from './main.js'
import { detect } from './pangram.js'

await run({
  getInput: (name) => core.getInput(name),
  eventName: context.eventName,
  payload: context.payload as Record<string, unknown>,
  env: process.env,
  createApi: (token) => createGitHubApi(token, context.repo.owner, context.repo.repo),
  detect,
  log: {
    info: (m) => core.info(m),
    warning: (m) => core.warning(m),
    error: (m) => core.error(m)
  },
  setOutput: (name, value) => core.setOutput(name, value),
  setFailed: (m) => core.setFailed(m),
  setSecret: (s) => core.setSecret(s),
  writeSummary: async (markdown) => {
    if (!process.env.GITHUB_STEP_SUMMARY) return
    await core.summary.addRaw(markdown).write()
  }
})
