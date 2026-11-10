# Rose

@AGENTS.md

## Claude Code specifics

- The guard runs automatically after every `Edit`/`Write` (see `.claude/settings.json`).
  If it reports a problem, fix it using the "Fix" guidance before doing anything else.
  It also runs when you finish; you can not stop while it fails.
- Editing a protected path triggers a permission prompt. That prompt is the user's
  review moment: say what you are about to change and why before you make the edit.
- `.dev.vars` and `.env*` are unreadable by design. You never need their contents;
  `pnpm dev` and `pnpm setup` manage them.
- Skills: `add-module` (new feature end to end) and `security-review` (run before you
  report a task as finished).
- For UI work also apply the `dashboard-ui-guidelines` skill if it is installed; the kit's
  components in `packages/ui` already implement it (see `docs/ui.md`).
- To see a change working, run `pnpm dev` and open the URLs it prints. Sign-in codes
  appear on the sign-in screen in development.
