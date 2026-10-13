#!/usr/bin/env node
// Audits who is recorded as Author for contributor work that reached main.
//
// For every pull request it compares the commits the PR carried with the commit
// that landed, and reports each contribution whose Author on main is not the
// person who wrote it. Nothing here trusts a PR description or a handoff note:
// the classification comes from git objects and GitHub's PR state.
//
//   git fetch origin '+refs/pull/*/head:refs/pull/*/head'
//   node scripts/attribution-audit.mjs --json ledger.json --md ledger.md
//
// Options:
//   --git-dir <path>   repository holding main and refs/pull/*/head (default: .)
//   --repo <o/n>       GitHub repository (default: rynfar/meridian)
//   --cache <file>     reuse/store the GitHub PR snapshot instead of refetching
//   --json <file>      write the full ledger as JSON
//   --md <file>        write the ledger as Markdown
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const gitDir = opt("git-dir", ".");
const repo = opt("repo", "rynfar/meridian");
const [owner, name] = repo.split("/");
const cacheFile = opt("cache");

const git = (...a) =>
  execFileSync("git", ["-C", gitDir, ...a], { encoding: "utf8", maxBuffer: 1 << 30 });
const lines = (s) => s.split("\n").filter(Boolean);

function fetchPullRequests() {
  if (cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));
  const prs = [];
  let cursor = null;
  do {
    const query = `query($cursor: String) { repository(owner: "${owner}", name: "${name}") {
      pullRequests(first: 50, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title state createdAt closedAt mergedAt headRefName headRefOid body
          isCrossRepository maintainerCanModify
          author { login __typename }
          mergeCommit { oid author { email user { login } } }
          headRepository { nameWithOwner }
          comments(first: 100) { nodes { author { login } body createdAt url } }
          timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { login } } } }
        } } } }`;
    const params = ["api", "graphql", "-f", `query=${query}`];
    if (cursor) params.push("-f", `cursor=${cursor}`);
    const page = JSON.parse(execFileSync("gh", params, { encoding: "utf8", maxBuffer: 1 << 30 }))
      .data.repository.pullRequests;
    prs.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify(prs));
  return prs;
}

// Every commit reachable from main or any PR head, keyed by SHA.
const FIELD = "\x1f";
const RECORD = "\x1e";
const commits = new Map();
for (const record of git(
  "log", "main", "--glob=refs/pull/*/head",
  `--format=%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%ct${FIELD}%s${FIELD}%(trailers:key=Co-authored-by,valueonly,separator=%x1d)${RECORD}`,
).split(RECORD)) {
  const [sha, parents, an, ae, ad, ct, subject, trailers] = record.trim().split(FIELD);
  if (!sha) continue;
  commits.set(sha, {
    sha, an, ae: ae.toLowerCase(), ad, ct: Number(ct), subject,
    parents: parents ? parents.split(" ") : [],
    coAuthors: (trailers ?? "").split("\x1d").map((t) => t.trim()).filter(Boolean),
  });
}

const onMain = new Set(lines(git("rev-list", "main")));
const firstParent = lines(git("rev-list", "--first-parent", "main")).map((sha) => commits.get(sha));
const mainBefore = (iso) => {
  const t = Date.parse(iso) / 1000;
  return firstParent.find((c) => c.ct <= t)?.sha;
};

const prs = fetchPullRequests();
const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
const isBot = (c) => /\[bot\]|machine-bot/.test(`${c.an} ${c.ae}`);
const isOwnerPr = (pr) => pr.author?.login === owner;
const isOutsidePr = (pr) => pr.author && !isOwnerPr(pr) && pr.author.__typename === "User";
const hasRef = (pr) => {
  try {
    git("rev-parse", "--verify", "--quiet", `refs/pull/${pr.number}/head`);
    return true;
  } catch {
    return false;
  }
};

// The owner's commit identities are the emails GitHub itself resolves to the
// owner's account, plus the account's noreply address.
const maintainerEmails = new Set();
for (const pr of prs) {
  const author = pr.mergeCommit?.author;
  if (author?.user?.login === owner && author.email) maintainerEmails.add(author.email.toLowerCase());
}
const isMaintainer = (c) =>
  maintainerEmails.has(c.ae) || c.ae.endsWith(`+${owner.toLowerCase()}@users.noreply.github.com`);

// The commits a PR carried: everything on its head that main did not already
// have when the PR was merged or closed.
function carried(pr) {
  if (!hasRef(pr)) return [];
  const landed = pr.mergeCommit && commits.get(pr.mergeCommit.oid);
  const base = landed ? landed.parents[0] : pr.closedAt ? mainBefore(pr.closedAt) : "main";
  if (!base) return [];
  return lines(git("rev-list", `refs/pull/${pr.number}/head`, "--not", base))
    .map((sha) => commits.get(sha))
    .filter(Boolean);
}

// A cherry-pick, rebase or amend keeps the author identity and author date.
const identity = (c) => `${c.ae}|${c.ad}`;
const sourceByIdentity = new Map();
const emailsByLogin = new Map();
const carriedByPr = new Map();
for (const pr of prs) {
  const list = carried(pr);
  carriedByPr.set(pr.number, list);
  if (!isOutsidePr(pr)) continue;
  for (const c of list) {
    if (isMaintainer(c) || isBot(c)) continue;
    if (!sourceByIdentity.has(identity(c))) sourceByIdentity.set(identity(c), []);
    sourceByIdentity.get(identity(c)).push(pr.number);
    if (!emailsByLogin.has(pr.author.login)) emailsByLogin.set(pr.author.login, new Set());
    emailsByLogin.get(pr.author.login).add(c.ae);
  }
}
const mainByIdentity = new Map();
for (const sha of onMain) {
  const c = commits.get(sha);
  if (c) mainByIdentity.set(identity(c), c);
}

const creditedBy = (landed, login) => {
  const emails = emailsByLogin.get(login) ?? new Set();
  return landed.coAuthors.some((t) => {
    const lower = t.toLowerCase();
    return [...emails].some((e) => lower.includes(e)) || lower.includes(login.toLowerCase());
  });
};

const mentions = (text) => [...(text ?? "").matchAll(/#(\d{2,5})\b/g)].map((m) => Number(m[1]));
const ownerCommentsOn = (pr) => pr.comments.nodes.filter((c) => c.author?.login === owner);

// A carried commit whose author date or email was changed on the way in no
// longer matches its source by identity. Fall back to the closed outside PRs the
// delivery PR names, or whose closing comments name the delivery PR.
const linkedSources = new Map();
for (const pr of prs) {
  if (!isOwnerPr(pr)) continue;
  linkedSources.set(pr.number, new Set(mentions(`${pr.title}\n${pr.body}`)));
}
for (const pr of prs) {
  if (!isOutsidePr(pr)) continue;
  for (const n of ownerCommentsOn(pr).flatMap((c) => mentions(c.body))) linkedSources.get(n)?.add(pr.number);
}
function linkedSource(delivery, commit) {
  const candidates = [...(linkedSources.get(delivery.number) ?? [])]
    .map((n) => byNumber.get(n))
    .filter((p) => p && isOutsidePr(p) && p.state === "CLOSED");
  const sameEmail = candidates.filter((p) => emailsByLogin.get(p.author.login)?.has(commit.ae));
  const sameSubject = candidates.filter((p) => carriedByPr.get(p.number).some((c) => c.subject === commit.subject));
  const match = sameEmail.length > 0 ? sameEmail : sameSubject.length > 0 ? sameSubject : candidates.length === 1 ? candidates : [];
  return match.map((p) => p.number);
}

// source PR number -> { via: Set<delivery PR>, landed: Set<sha> }
const relanded = new Map();
const unmapped = [];
for (const pr of prs) {
  if (pr.state !== "MERGED" || !pr.mergeCommit) continue;
  const landed = commits.get(pr.mergeCommit.oid);
  if (!landed || landed.parents.length !== 1 || !isMaintainer(landed)) continue;
  for (const c of carriedByPr.get(pr.number)) {
    if (isMaintainer(c) || isBot(c)) continue;
    if (isOutsidePr(pr)) continue;
    let sources = (sourceByIdentity.get(identity(c)) ?? []).filter((n) => n !== pr.number);
    if (sources.length === 0) sources = linkedSource(pr, c);
    if (sources.length === 0) {
      unmapped.push({ via: pr.number, landed: landed.sha, commit: c.sha, name: c.an });
      continue;
    }
    // A stacked contributor branch repeats its parent's commits; credit the PR
    // that introduced the commit, which is the earliest one carrying it.
    const linked = sources.filter((n) => linkedSources.get(pr.number)?.has(n));
    for (const source of linked.length > 0 ? linked : [Math.min(...sources)]) {
      if (!relanded.has(source)) relanded.set(source, { via: new Set(), landed: new Set() });
      relanded.get(source).via.add(pr.number);
      relanded.get(source).landed.add(landed.sha);
    }
  }
}

const entries = [];
for (const pr of prs) {
  if (!isOutsidePr(pr)) continue;
  const login = pr.author.login;
  const ownerComments = ownerCommentsOn(pr);
  const entry = {
    number: pr.number, author: login, title: pr.title, state: pr.state,
    closedBy: pr.timelineItems.nodes[0]?.actor?.login ?? null,
    forkGone: pr.isCrossRepository && !pr.headRepository,
    ownerComments: ownerComments.length,
  };
  if (pr.state === "MERGED") {
    const landed = commits.get(pr.mergeCommit?.oid);
    entries.push({
      ...entry,
      class: landed && landed.parents.length === 1 && isMaintainer(landed)
        ? "merged-but-maintainer-author" : "merged",
    });
    continue;
  }
  if (pr.state === "OPEN") {
    entries.push({ ...entry, class: "open" });
    continue;
  }
  // Their own commit on main under their own name outranks a later squash that
  // happened to carry a copy of it.
  const own = carriedByPr.get(pr.number).filter((c) => !isMaintainer(c) && !isBot(c));
  const kept = own
    .map((c) => (onMain.has(c.sha) ? c : mainByIdentity.get(identity(c))))
    .filter((c) => c && !isMaintainer(c));
  if (kept.length > 0) {
    entries.push({
      ...entry, class: "landed-as-author-pr-closed",
      landed: [...new Set(kept.map((c) => c.sha.slice(0, 9)))],
      headOnMain: onMain.has(pr.headRefOid),
    });
    continue;
  }
  if (relanded.has(pr.number)) {
    const { via, landed } = relanded.get(pr.number);
    const shas = [...landed];
    entries.push({
      ...entry, class: "relanded-under-maintainer",
      via: [...via], landed: shas.map((s) => s.slice(0, 9)),
      trailer: shas.every((s) => creditedBy(commits.get(s), login)),
    });
    continue;
  }
  // No commit of theirs reached main. The owner pointing at a merged PR of their
  // own can mean adopted, reimplemented or declined; a person has to read it.
  const via = [...new Set(ownerComments.flatMap((c) => mentions(c.body)))]
    .map((n) => byNumber.get(n))
    .filter((p) => p && isOwnerPr(p) && p.state === "MERGED" && p.mergeCommit && commits.has(p.mergeCommit.oid));
  if (via.length > 0) {
    entries.push({
      ...entry, class: "closed-for-maintainer-pr",
      via: via.map((p) => p.number),
      landed: via.map((p) => p.mergeCommit.oid.slice(0, 9)),
      trailer: via.every((p) => creditedBy(commits.get(p.mergeCommit.oid), login)),
    });
    continue;
  }
  entries.push({ ...entry, class: "closed-not-landed" });
}

// Statements the owner made to contributors about authorship, next to who the
// landed commit actually names.
const claims = [];
for (const entry of entries) {
  if (!entry.landed || entry.class === "landed-as-author-pr-closed") continue;
  for (const c of byNumber.get(entry.number).comments.nodes) {
    if (c.author?.login !== owner || !/author/i.test(c.body)) continue;
    const sentence = c.body.split(/(?<=[.!?])\s+|\n+/).find((s) => /author/i.test(s)) ?? "";
    claims.push({
      number: entry.number, author: entry.author, url: c.url, createdAt: c.createdAt,
      statement: sentence.trim().slice(0, 300).replace(/<[^<>\s]+@[^<>\s]+>/g, "<email>"),
      class: entry.class, landed: entry.landed,
    });
  }
}

const mainCommits = [...onMain].map((sha) => commits.get(sha)).filter(Boolean);
const people = new Map();
for (const entry of entries) {
  if (!people.has(entry.author)) people.set(entry.author, { login: entry.author, opened: 0, merged: 0, closed: 0, open: 0 });
  const p = people.get(entry.author);
  p.opened += 1;
  p[entry.state.toLowerCase()] += 1;
}
for (const p of people.values()) {
  const emails = emailsByLogin.get(p.login) ?? new Set();
  p.authorOnMain = mainCommits.filter((c) => emails.has(c.ae)).length;
  p.trailerOnlyOnMain = mainCommits.filter(
    (c) => !emails.has(c.ae) && c.coAuthors.some((t) => [...emails].some((e) => t.toLowerCase().includes(e))),
  ).length;
}

const count = (cls) => entries.filter((e) => e.class === cls).length;
const summary = {
  repo, main: git("rev-parse", "main").trim(), generatedAt: new Date().toISOString(),
  outsidePullRequests: entries.length,
  merged: count("merged"),
  open: count("open"),
  relandedUnderMaintainer: count("relanded-under-maintainer"),
  relandedWithoutTrailer: entries.filter((e) => e.class === "relanded-under-maintainer" && !e.trailer).length,
  closedForMaintainerPr: count("closed-for-maintainer-pr"),
  closedForMaintainerPrWithoutTrailer: entries.filter((e) => e.class === "closed-for-maintainer-pr" && !e.trailer).length,
  landedAsAuthorPrClosed: count("landed-as-author-pr-closed"),
  mergedButMaintainerAuthor: count("merged-but-maintainer-author"),
  closedNotLanded: count("closed-not-landed"),
  closedNotLandedByOwnerWithoutComment: entries.filter((e) => e.class === "closed-not-landed" && e.closedBy === owner && e.ownerComments === 0).length,
  authorshipStatements: claims.length,
  unmappedForeignCommits: unmapped.length,
};
const ledger = { summary, entries, claims, unmapped, people: [...people.values()] };

if (opt("json")) writeFileSync(opt("json"), `${JSON.stringify(ledger, null, 2)}\n`);
if (opt("md")) writeFileSync(opt("md"), renderMarkdown(ledger));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function renderMarkdown({ summary, entries, claims, people, unmapped }) {
  const link = (n) => `[#${n}](https://github.com/${repo}/pull/${n})`;
  const rows = (cls, cells) =>
    entries.filter((e) => e.class === cls).map((e) => `| ${cells(e).join(" | ")} |`).join("\n");
  const delivery = (e) => [
    link(e.number), `@${e.author}`, e.via.map(link).join(", "),
    e.landed.map((s) => `\`${s}\``).join(", "), e.trailer ? "trailer" : "**none**",
  ];
  return `# Contributor attribution ledger

Generated by \`scripts/attribution-audit.mjs\` from \`main\` at \`${summary.main.slice(0, 9)}\` on ${summary.generatedAt.slice(0, 10)}. Do not edit by hand; rerun the script.

| | |
|---|---|
| Outside pull requests | ${summary.outsidePullRequests} |
| Merged as the contributor's own PR | ${summary.merged} |
| Re-landed with the maintainer as Author | ${summary.relandedUnderMaintainer} (${summary.relandedWithoutTrailer} without a trailer) |
| Closed in favor of a maintainer PR | ${summary.closedForMaintainerPr} (${summary.closedForMaintainerPrWithoutTrailer} without a trailer) |
| Landed with the contributor as Author, PR left closed | ${summary.landedAsAuthorPrClosed} |
| Closed, nothing landed | ${summary.closedNotLanded} (${summary.closedNotLandedByOwnerWithoutComment} closed by the maintainer without a comment; the rest were closed by their authors or explained) |
| Open | ${summary.open} |

## Re-landed with the maintainer as Author

The contributor's commits were carried by a maintainer PR and squashed, so the commit on \`main\` names the maintainer as Author.

| Source | Contributor | Delivered by | Commit on main | Credit in commit |
|---|---|---|---|---|
${rows("relanded-under-maintainer", delivery)}

## Closed in favor of a maintainer PR

None of the contributor's commits reached \`main\`, and the maintainer's comments on the closed PR point at a merged PR of their own. This covers work that was adopted or reimplemented and also work that was declined for a different fix, so each row needs a human reading before it is called misattribution.

| Source | Contributor | Delivered by | Commit on main | Credit in commit |
|---|---|---|---|---|
${rows("closed-for-maintainer-pr", delivery)}

${unmapped.length === 0 ? "" : `## Carried commits with no contributor PR

Commits by someone else that a maintainer PR carried and squashed, with no outside PR to trace them to.

| Delivered by | Commit on main | Carried commit | Written by |
|---|---|---|---|
${unmapped.map((u) => `| ${link(u.via)} | \`${u.landed.slice(0, 9)}\` | \`${u.commit.slice(0, 9)}\` | ${u.name} |`).join("\n")}

`}## Landed with the contributor as Author, PR left closed

| Source | Contributor | Commits on main | Head already on main |
|---|---|---|---|
${rows("landed-as-author-pr-closed", (e) => [link(e.number), `@${e.author}`, e.landed.map((s) => `\`${s}\``).join(", "), e.headOnMain ? "yes" : "no"])}

## Authorship statements made to contributors

Maintainer comments mentioning authorship on PRs whose landed commit names the maintainer as Author.

| PR | Contributor | Statement | Commit on main |
|---|---|---|---|
${claims.map((c) => `| [#${c.number}](${c.url}) | @${c.author} | ${c.statement.replace(/\|/g, "\\|")} | ${c.landed.map((s) => `\`${s}\``).join(", ")} |`).join("\n")}

## Per contributor

| Contributor | Opened | Merged | Closed | Open | Author on main | Trailer only |
|---|---|---|---|---|---|---|
${people.sort((a, b) => b.trailerOnlyOnMain - a.trailerOnlyOnMain || b.opened - a.opened).map((p) => `| @${p.login} | ${p.opened} | ${p.merged} | ${p.closed} | ${p.open} | ${p.authorOnMain} | ${p.trailerOnlyOnMain} |`).join("\n")}
`;
}
