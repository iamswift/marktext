# Fork workflow

This is a personal fork of [marktext/marktext](https://github.com/marktext/marktext). It carries features that are not intended to go upstream, while still being able to take upstream fixes.

Upstream is active, so the value of this layout is that pulling upstream work stays a routine merge instead of an archaeology exercise.

## Remotes

| Remote | Points at |
|---|---|
| `origin` | `iamswift/marktext` — this fork |
| `upstream` | `marktext/marktext` — the original |

## Branches

| Branch | Role |
|---|---|
| `main` | **Primary.** Upstream plus every feature of ours. Default branch. Everything ships from here. |
| `develop` | **Pristine mirror of `upstream/develop`.** Never commit to it. Its only job is to be a clean, known-good reference point. |
| `feat/*`, `fix/*` | Feature work. Branch from `main`, merge back into `main`. |

`main` is safe as a name because upstream's stable branch is `master` — upstream has no `main`, so the two can never collide.

Nothing in this fork targets upstream, so `develop` exists purely as the sync mechanism described below. Keeping it byte-identical to upstream is what lets `git fetch` stay a fast-forward forever; the moment a commit of ours lands on it, that guarantee is gone and future syncs turn into conflict resolution.

## Adding a feature

```sh
git checkout main
git pull
git checkout -b feat/my-thing
# ... work, commit ...
git push -u origin feat/my-thing
gh pr create --base main          # optional; solo work can merge directly
git checkout main && git merge feat/my-thing && git push
```

## Taking upstream fixes

Two steps, deliberately separate: refreshing the mirror is safe and can be done any time, while merging into `main` is a judgement call.

**1. Refresh the mirror.** Always a fast-forward; if it ever isn't, something is wrong and it will fail loudly rather than inventing a merge.

```sh
git sync-upstream
```

**2. Review what arrived, then take it if it's worth having.**

```sh
git log --oneline main..develop        # what upstream added since our last take
git merge develop                      # from main
```

Conflicts here are normal and are the actual cost of the fork — they surface wherever upstream touched the same code our features did. Resolve in favour of keeping our behaviour unless upstream is fixing a real bug in the shared path.

To take a single fix rather than everything:

```sh
git cherry-pick <sha>
```

## Don't

- **Commit to `develop`.** It stops being a mirror the instant you do, and `git sync-upstream` will start failing.
- **Open PRs against upstream.** `gh` defaults to the parent repo on a fork. `gh repo set-default iamswift/marktext` has been run here, which fixes it for this clone, but verify the target on anything consequential.
