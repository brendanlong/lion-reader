# assets

Orphan branch holding binary assets (screenshots, diagrams) referenced from pull
requests and docs, so image blobs never enter `master`'s history.

- One folder per topic, e.g. `epaper-high-contrast-borders/`.
- Reference from a PR body with a raw URL:
  `https://raw.githubusercontent.com/brendanlong/lion-reader/assets/<folder>/<file>.png`
- Add files with git **plumbing** so no working-tree checkout is needed:
  load this branch into a temp index (`GIT_INDEX_FILE=… git read-tree origin/assets`),
  `git hash-object -w` each file + `git update-index --add --cacheinfo`, then
  `git write-tree` → `git commit-tree -p origin/assets` → `git push origin <commit>:refs/heads/assets`.
- **Never** merge this branch into `master`, and never commit screenshots to `master`
  or a feature branch.

See `src/components/CLAUDE.md` on `master` for the frontend-PR screenshot conventions.
