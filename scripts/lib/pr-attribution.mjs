const WRITE_ACCESS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

const isBot = commit =>
  commit.authorType === "Bot" || /\[bot\]/.test(`${commit.authorLogin ?? ""} ${commit.name} ${commit.email}`)

/**
 * A squash names the PR opener as Author. When someone with write access opens
 * a PR that carries another person's commits, squashing it moves that person's
 * work under the opener's name. Returns the people who would lose authorship.
 *
 * The reverse is intended: a contributor's own PR that also holds maintainer
 * fix commits squashes to the contributor.
 */
export function displacedAuthors({ opener, association, commits }) {
  if (!WRITE_ACCESS.has(association)) return []
  const openerEmails = new Set(
    commits.filter(c => c.authorLogin === opener).map(c => c.email.toLowerCase()),
  )
  const displaced = new Map()
  for (const commit of commits) {
    if (isBot(commit) || commit.authorLogin === opener) continue
    const email = commit.email.toLowerCase()
    // An unlinked email the opener also commits with is still the opener.
    if (!commit.authorLogin && openerEmails.has(email)) continue
    const key = commit.authorLogin ?? email
    if (!displaced.has(key)) {
      displaced.set(key, { login: commit.authorLogin ?? null, name: commit.name, email, commits: [] })
    }
    displaced.get(key).commits.push(commit.sha)
  }
  return [...displaced.values()]
}
