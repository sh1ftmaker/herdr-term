#!/usr/bin/env python3
"""Run a headless Herdr client on a fixed-size pty.

The bridge reads pane content over Herdr's JSON API, but pane geometry is set by
the attached client's terminal. Herdr has no API to reshape the character grid
(pane.resize only moves split ratios), so we pin the grid here and let browsers
fit to it.
"""
import fcntl, os, pty, signal, struct, sys, termios

COLS = int(os.environ.get("HERDR_COLS", "200"))
ROWS = int(os.environ.get("HERDR_ROWS", "50"))

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp("herdr", ["herdr"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
print(f"herdr session pid={pid} grid={COLS}x{ROWS}", flush=True)


def shutdown(*_):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

# Drain the TUI's output; we never render it, but a full pipe would stall Herdr.
while True:
    try:
        if not os.read(fd, 65536):
            break
    except OSError:
        break
