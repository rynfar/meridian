#!/usr/bin/env node
// Fails when squashing a pull request would record its opener as Author of
// commits someone else wrote. See .agents/references/contributing.md.
//
//   node scripts/check-pr-attribution.mjs <pr-number> [--repo owner/name]
import { execFileSync } from "node:child_process"
import { displacedAuthors } from "./lib/pr-attribution.mjs"

const args = process.argv.slice(2)
const number = args.find(a => /^\d+$/.test(a))
const repoFlag = args.indexOf("--repo")
const repo = repoFlag === -1 ? process.env.GITHUB_REPOSITORY : args[repoFlag + 1]
if (!number || !repo) {
  console.error("usage: check-pr-attribution.mjs <pr-number> [--repo owner/name]")
  process.exit(2)
}

const api = (...params) =>
  JSON.parse(execFileSync("gh", ["api", ...params], { encoding: "utf8", maxBuffer: 1 << 28 }))

const pr = api(`repos/${repo}/pulls/${number}`)
const commits = api("--paginate", "--slurp", `repos/${repo}/pulls/${number}/commits?per_page=100`)
  .flat()
  .map(c => ({
    sha: c.sha,
    authorLogin: c.author?.login ?? null,
    authorType: c.author?.type ?? null,
    name: c.commit.author.name,
    email: c.commit.author.email,
  }))

const displaced = displacedAuthors({
  opener: pr.user.login,
  association: pr.author_association,
  commits,
})

if (displaced.length === 0) {
  console.log(`#${number}: squashing keeps every commit author's work under the right name.`)
  process.exit(0)
}

console.error(`#${number} was opened by @${pr.user.login} but carries commits written by:`)
for (const person of displaced) {
  const who = person.login ? `@${person.login}` : `${person.name} <${person.email}>`
  console.error(`  ${who}: ${person.commits.map(sha => sha.slice(0, 9)).join(", ")}`)
}
console.error(`
Squashing this PR would name @${pr.user.login} as Author of that work and leave
its author as a trailer. Merge the contributor's own pull request instead, and
push any maintainer fixes to their branch as separate signed commits.
See .agents/references/contributing.md, "Contributor pull requests".`)
process.exit(1)
