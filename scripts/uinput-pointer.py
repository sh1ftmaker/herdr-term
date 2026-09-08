#!/usr/bin/env python3
"""A virtual mouse, for clicking from the Screen view.

Hyprland can warp the cursor on its own (hl.dsp.cursor.move), but it has no
dispatcher that presses a mouse button, and ydotool isn't installed -- and
can't be, since pacman needs a password. systemd-logind does grant the seat
owner an ACL on /dev/uinput though, so this creates its own pointer device
instead. No root, no packages.

The device has to outlive a single click: udev and libinput take a moment to
notice a new input device, so creating one per click would drop the first
event every time. The bridge therefore spawns this once and keeps it, feeding
it one JSON command per line on stdin:

    {"op": "click",  "button": "left", "count": 2}
    {"op": "button", "button": "left", "state": "down"}
    {"op": "scroll", "dy": -3}
    {"op": "move",   "dx": 12, "dy": -4}

and reads one JSON line back per command. Motion is relative because that is
what a mouse reports; absolute positioning is Hyprland's job.
"""

import fcntl
import json
import os
import struct
import sys
import time

# linux/input-event-codes.h
EV_SYN, EV_KEY, EV_REL = 0x00, 0x01, 0x02
SYN_REPORT = 0
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL = 0x00, 0x01, 0x06, 0x08
BUTTONS = {"left": 0x110, "right": 0x111, "middle": 0x112}

# linux/uinput.h: _IOW('U', nr, int) and _IO('U', nr).
def _iow(nr, size):
    return (1 << 30) | (size << 16) | (ord("U") << 8) | nr


def _io(nr):
    return (ord("U") << 8) | nr


UI_SET_EVBIT = _iow(100, 4)
UI_SET_KEYBIT = _iow(101, 4)
UI_SET_RELBIT = _iow(102, 4)
UI_DEV_CREATE = _io(1)
UI_DEV_DESTROY = _io(2)

# struct input_event { struct timeval; __u16 type; __u16 code; __s32 value; }
# The timeval fields are 64-bit here, so "q" -- struct's "=l" is 4 bytes, not
# native long, and a 16-byte event write is rejected with EINVAL.
EVENT = struct.Struct("=qqHHi")


def emit(fd, etype, code, value):
    os.write(fd, EVENT.pack(0, 0, etype, code, value))


def sync(fd):
    emit(fd, EV_SYN, SYN_REPORT, 0)


def create():
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    for ev in (EV_KEY, EV_REL, EV_SYN):
        fcntl.ioctl(fd, UI_SET_EVBIT, ev)
    for code in BUTTONS.values():
        fcntl.ioctl(fd, UI_SET_KEYBIT, code)
    for code in (REL_X, REL_Y, REL_WHEEL, REL_HWHEEL):
        fcntl.ioctl(fd, UI_SET_RELBIT, code)

    # Legacy struct uinput_user_dev: name[80], input_id, ff_effects_max,
    # then absmax/absmin/absfuzz/absflat[ABS_CNT=64]. Writing it is simpler
    # than getting UI_DEV_SETUP's ioctl size right, and is still supported.
    name = b"herdr-term virtual pointer"
    os.write(fd, struct.pack(
        "=80sHHHHi" + "i" * (64 * 4),
        name, 0x03, 0x1d1e, 0x0001, 0x0001, 0, *([0] * 256),
    ))
    fcntl.ioctl(fd, UI_DEV_CREATE)
    # Give udev and libinput time to adopt the device, or the first event of
    # the session lands before anything is listening for it.
    time.sleep(0.35)
    return fd


def handle(fd, cmd):
    op = cmd.get("op")
    if op == "move":
        dx, dy = int(cmd.get("dx", 0)), int(cmd.get("dy", 0))
        if dx:
            emit(fd, EV_REL, REL_X, dx)
        if dy:
            emit(fd, EV_REL, REL_Y, dy)
        sync(fd)
    elif op == "scroll":
        dx, dy = int(cmd.get("dx", 0)), int(cmd.get("dy", 0))
        if dy:
            emit(fd, EV_REL, REL_WHEEL, dy)
        if dx:
            emit(fd, EV_REL, REL_HWHEEL, dx)
        sync(fd)
    elif op in ("click", "button"):
        code = BUTTONS.get(cmd.get("button", "left"))
        if code is None:
            raise ValueError("unknown button")
        if op == "button":
            emit(fd, EV_KEY, code, 1 if cmd.get("state") == "down" else 0)
            sync(fd)
        else:
            for i in range(max(1, min(3, int(cmd.get("count", 1))))):
                if i:
                    time.sleep(0.06)
                emit(fd, EV_KEY, code, 1)
                sync(fd)
                time.sleep(0.02)
                emit(fd, EV_KEY, code, 0)
                sync(fd)
    else:
        raise ValueError(f"unknown op: {op!r}")


def main():
    fd = create()
    print(json.dumps({"ok": True, "ready": True}), flush=True)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                handle(fd, json.loads(line))
                print(json.dumps({"ok": True}), flush=True)
            except Exception as err:  # one bad command must not kill the device
                print(json.dumps({"ok": False, "error": str(err)}), flush=True)
    finally:
        try:
            fcntl.ioctl(fd, UI_DEV_DESTROY)
        finally:
            os.close(fd)


if __name__ == "__main__":
    main()
