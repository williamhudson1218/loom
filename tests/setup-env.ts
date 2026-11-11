// Runs before every test file (vitest.config.ts setupFiles). Inside tmux, $TMUX
// names the developer's real server, and a bare `tmux` command would use it
// whatever TMUX_TMPDIR says. Child processes inherit process.env, so drop it here.
delete process.env.TMUX;
delete process.env.TMUX_PANE;
