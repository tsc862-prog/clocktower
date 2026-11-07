// Dev-server settings: the page on port 5173, no build step to play. The .claude folder holds agent worktrees whose edits must not
// reload the watcher's page; logs and dist are not watched either.
export default {
  server: {port: 5173, strictPort: true, watch: {ignored: ['**/.claude/**', '**/dist/**', '**/logs/**', '**/node_modules/**']}},
};
