import { describe, expect, it } from "bun:test"
import { displacedAuthors } from "../../scripts/lib/pr-attribution.mjs"

const commit = (sha: string, authorLogin: string | null, email: string, authorType = "User") => ({
  sha,
  authorLogin,
  authorType,
  name: authorLogin ?? email,
  email,
})

describe("displacedAuthors", () => {
  it("flags a maintainer PR that carries a contributor's cherry-picked commit", () => {
    const displaced = displacedAuthors({
      opener: "maintainer",
      association: "OWNER",
      commits: [
        commit("aaa", "contributor", "c@example.com"),
        commit("bbb", "maintainer", "m@example.com"),
      ],
    })
    expect(displaced).toEqual([
      { login: "contributor", name: "contributor", email: "c@example.com", commits: ["aaa"] },
    ])
  })

  it("flags a carried commit whose email is not linked to any account", () => {
    const displaced = displacedAuthors({
      opener: "maintainer",
      association: "COLLABORATOR",
      commits: [
        commit("aaa", null, "someone@laptop.local"),
        commit("bbb", "maintainer", "m@example.com"),
      ],
    })
    expect(displaced.map(d => d.email)).toEqual(["someone@laptop.local"])
  })

  it("allows a contributor's own PR that holds maintainer fix commits", () => {
    expect(
      displacedAuthors({
        opener: "contributor",
        association: "CONTRIBUTOR",
        commits: [
          commit("aaa", "contributor", "c@example.com"),
          commit("bbb", "maintainer", "m@example.com"),
        ],
      }),
    ).toEqual([])
  })

  it("allows a maintainer PR made only of the maintainer's and bots' commits", () => {
    expect(
      displacedAuthors({
        opener: "maintainer",
        association: "OWNER",
        commits: [
          commit("aaa", "maintainer", "m@example.com"),
          commit("bbb", null, "m@example.com"),
          commit("ccc", "github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com", "Bot"),
        ],
      }),
    ).toEqual([])
  })

  it("groups several carried commits under one person", () => {
    const displaced = displacedAuthors({
      opener: "maintainer",
      association: "OWNER",
      commits: [
        commit("aaa", "contributor", "c@example.com"),
        commit("bbb", "contributor", "c@example.com"),
      ],
    })
    expect(displaced).toHaveLength(1)
    expect(displaced[0]?.commits).toEqual(["aaa", "bbb"])
  })
})
