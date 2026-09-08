# herdr-term

A small browser front-end for [Herdr](https://github.com/herdrdev/herdr) and the Omarchy/Hyprland
machine around it, served from your own hostname over a Cloudflare Tunnel.

Inspired by [kcosr/herdr-web](https://github.com/kcosr/herdr-web), but built against Herdr's
**JSON API only** — no Rust, no bincode, and no Herdr upgrade required.

## Why not herdr-web directly

herdr-web's bridge attaches over Herdr's *client* socket, a bincode-framed binary protocol. Every
prebuilt herdr-web release needs Herdr `v0.9.0` / terminal protocol `22`, while Omarchy's packaged
Herdr is `0.8.2` / protocol `20`. The only matching branch ships no binary, so it would need a Rust
toolchain to build.

Herdr's *API* socket is much friendlier: newline-delimited JSON over a unix socket, stable across
both protocol versions. It exposes everything an interactive web terminal needs, so this project
talks to that instead.

## Pages

| Route | Purpose |
|---|---|
| `/` | session manager — start, monitor, and close agent sessions |
| `/terminal.html?pane=<id>` | the terminal itself, attached to one pane |
| `/files.html?path=<rel>` | read-only file browser: view text and images, download anything |
| `/desktop.html` | the Hyprland desktop: video stream, screen grabs, and shortcut buttons |

Everything lives on one origin, so the single Cloudflare Access policy covers all of it.

## Architecture

```text
browser
  ├── /               session manager  ─┐
  ├── /terminal.html  xterm.js          │  WebSocket /ws — one channel, both pages
  ├── /files.html     file browser      │  plain HTTP /api/fs/*
  └── /desktop.html   stream + pad      │  /api/desktop/* and /moonlight/* (proxied)
                                        ▼
server/index.mjs          Node bridge: static files, auth gate, WS relay, REST, proxy
  ├── server/sessions.mjs   session lifecycle over Herdr's agent API
  ├── server/files.mjs      read-only filesystem, confined to one root
  ├── server/desktop.mjs    hyprctl / wtype / grim
  └── server/proxy.mjs      reverse proxy to moonlight-web
  │  unix socket, newline-delimited JSON
  ▼
~/.config/herdr/herdr.sock          Herdr daemon
  ▲
  └── scripts/herdr-session.py      headless Herdr client on a fixed-size pty
```

Herdr API calls used:

| Call | Purpose |
|---|---|
| `pane.list` / `session.snapshot` | pane inventory and exact layout geometry |
| `pane.read` (`source: visible`, `format: ansi`) | screen contents, ANSI colour preserved |
| `pane.send_text` / `pane.send_keys` | keyboard input |
| `events.subscribe` | live push on `pane.updated`, so redraws aren't purely polled |
| `server.agent_manifests` | which agent kinds this Herdr can launch |
| `workspace.create` + `agent.start` | create a session and adopt an agent into its pane |
| `agent.list` | per-agent status for the dashboard |
| `agent.prompt` | send a prompt without opening the terminal |
| `workspace.close` | end a session and whatever agent is in it |

### Sessions

A session is one workspace holding one pane. Starting an agent is two calls — `workspace.create`,
then `agent.start` adopting that pane — so if the agent fails to launch the workspace is rolled back
rather than left stranded and empty.

Status comes from Herdr's own vocabulary: `working`, `blocked`, `idle`, `done`, `unknown`, plus a
local `starting` while `launch_pending` is set and the agent hasn't been detected yet. `blocked` is
the interesting one — it means the agent is waiting on you.

> **Don't add `pane.agent_status_changed` to the global event subscription.** It is a *per-pane*
> subscription and requires a `pane_id`; without one Herdr rejects the subscription and closes the
> connection, which shows up as the event stream reconnecting in a loop. `pane.updated` already
> carries `agent_status` for every pane.

### Files

`/api/fs/*` is **read-only** and rooted at `HERDR_TERM_FS_ROOT` (default `$HOME`). Paths from the
browser are always relative to that root: they are resolved, then `realpath`'d, and the result must
still be inside the root — so neither `../..` nor a symlink pointing outside can escape.

| Endpoint | Purpose |
|---|---|
| `GET /api/fs/list?path=` | directory listing, directories first |
| `GET /api/fs/text?path=` | up to 512 KB of UTF-8; refuses anything with a NUL byte |
| `GET /api/fs/raw?path=&download=1` | the bytes, for image previews and downloads |

`raw` only serves a real `content-type` for known raster images. Everything else — **SVG included,
because it can carry script that would then run on this origin** — is sent as
`application/octet-stream` with `nosniff` and a restrictive CSP, so it downloads rather than renders.

### Desktop

Three separate mechanisms, because they fail independently:

**Shortcut buttons.** Hyprland 0.56 evaluates `hyprctl dispatch <arg>` as Lua (`hl.dispatch(<arg>)`),
so a shortcut is a snippet like `hl.dsp.window.close()` or `hl.dsp.exec_cmd("omarchy-menu toggle")`.
The browser sends only an **id**; every snippet is a server-side constant in `server/desktop.mjs`.
Entries whose helper binary is missing are dropped from the list rather than offered as dead
buttons. They are grouped Menus / Apps / Window / Workspace / System — the Omarchy defaults worth
having on a phone. There are deliberately no shutdown or reboot buttons.

**Keyboard.** `wtype` types into whatever currently has focus — `/api/desktop/type` for text and
`/api/desktop/key` for a keysym plus modifiers, both against allowlists.

**Pointer.** `/api/desktop/pointer` takes a position as a *fraction* of the captured screen
(`{nx, ny}`), so the browser never has to know the real geometry, and the server maps it onto the
monitor layout. Positioning is `hl.dsp.cursor.move`; the buttons are not, because Hyprland has no
dispatcher that presses one. `scripts/uinput-pointer.py` creates a virtual mouse instead —
systemd-logind grants the seat owner an ACL on `/dev/uinput`, so this needs neither root nor
`ydotool`, which couldn't be installed anyway without a password. The helper is spawned once and
kept alive: udev and libinput take a moment to adopt a new input device, so a process per click
would lose its own first event.

**Picture.** Two options, and the page falls back to the second when the first isn't available:

- *Stream* — [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream), which
  needs a **Sunshine** host. Full video, audio, mouse and keyboard.
- *Screen* — `grim` JPEGs polled once a second. Tap the picture to move the pointer there and
  click, hold for a right-click, drag to scroll. Needs nothing installed.

#### moonlight-web

Installed unpacked in `~/.local/share/moonlight-web` (prebuilt release, no toolchain needed) and run
by `herdr-term-stream.service`. Its config sets three things that matter:

- `bind_address: 127.0.0.1:8791` — loopback only. The bridge is the sole way in.
- `url_path_prefix: /moonlight` — so `server/proxy.mjs` can reverse proxy it under one origin
  instead of it needing a second hostname and a second Access policy.
- `forwarded_header.username_header: X-Forwarded-User` — Cloudflare Access has already
  authenticated the visitor, so the proxy maps `Cf-Access-Authenticated-User-Email` onto that header
  and there is no second login. **The proxy strips any client-supplied `X-Forwarded-User` first**;
  without that, anyone reaching the origin could name themselves.

> **The stream must use the WebSocket transport to work off the LAN.** WebRTC media is UDP, and a
> Cloudflare Tunnel only carries HTTP and WebSocket, so ICE has nothing to negotiate through. The
> config presets `dataTransport: "websocket"`; if moonlight-web ignores that (it warns that
> `default_settings` is deprecated in favour of per-role settings), set **Data Transport → Web
> Sockets** in the stream settings, or in the role defaults in its Admin UI. HTTPS via the tunnel
> gives the secure context that the WebSocket transport's `VideoDecoder` needs.

The Stream view needs a Sunshine host on port 47989. Until one is running, the Desktop tab says so
and opens in Screen mode instead:

```bash
yay -S sunshine-bin && sudo systemctl enable --now sunshine
```

Then in the Desktop tab's Stream view: add a host at `localhost` with an empty port, click it to
pair, and enter the PIN in Sunshine's own UI on `https://localhost:47990`.

## Known limitations

- **The browser cannot resize the terminal.** Herdr's `pane.resize` only moves split ratios; the
  character grid belongs to the attached client. `scripts/herdr-session.py` pins the host pty
  (default `200x50`, which yields a `174x49` pane) and the browser scales its font to fit.
- **Full-frame repaints, not diffs.** `pane.read` returns a whole screen, so each change repaints.
  Frames are hashed and only sent when they actually differ.
- **No cursor position.** The JSON API doesn't report it, so the cursor sits wherever the frame ends.
- `source: recent` drains on read and returns empty on the next call — `visible` is the reliable one.
- **Screen mode's pointer is tap-to-click, not a cursor you drag.** Each tap warps the cursor and
  clicks; there is no hover, and press-and-drag is spent on scrolling rather than on dragging
  windows or selecting text. Real dragging is what the Stream view is for.
- **The virtual pointer outlives the request.** `/dev/uinput` is opened on the first click and the
  device stays registered until the bridge stops, so it shows up in `hyprctl devices`.
- **Screen mode captures whatever the compositor shows**, including a locked screen. It is a picture
  of the desktop, not a private session.
- **xterm is vendored, not loaded from a CDN.** The cdnjs path this used to
  reference started returning 404, which left the terminal page a dead black
  rectangle (`Terminal is not defined`) — invisible to any check that only
  asserts `/terminal.html` returns 200. `public/vendor/` is served locally.
- **The terminal is wider than a phone.** The host pty is pinned to a 174x49
  grid and `fit()` floors the font at 6px, so the grid is ~625px wide however
  narrow the screen is. `#term` scrolls horizontally rather than clipping.
- **`100vh` is a lie on a phone.** It ignores the browser chrome and does not shrink for the
  on-screen keyboard, which put the type bars underneath it. The full-height pages size themselves
  from `visualViewport` (`public/viewport.js` publishes it as `--vh`, with `100dvh` as the
  fallback), and bottom bars pad by `env(safe-area-inset-bottom)` because the pages are
  `viewport-fit=cover`.

## Auth

Access control is expected to live in **Cloudflare Access**, fronting the hostname with an email
allowlist. Unauthenticated requests are redirected to your team's `*.cloudflareaccess.com` login and
never reach the origin. Check that this covers `/`, `/files.html`, `/desktop.html`, `/moonlight/`,
`/api/fs/*`, `/api/desktop/*`, `/healthz`, and `/ws`. Covering `/ws` matters most: that WebSocket is
the channel that actually carries keystrokes into the shell.

Two things Access does **not** protect against, handled in `server/index.mjs`:

- **Cross-site POSTs.** A page on another origin can submit a form as `text/plain` with a JSON body
  and no CORS preflight. Every mutating endpoint therefore requires `content-type: application/json`
  *and* rejects a foreign `Origin` — otherwise merely having a valid Access session in the browser
  would be enough for another site to drive the desktop.
- **Cross-site WebSockets**, which aren't subject to CORS at all. `/ws` applies the same origin check.

The bridge also has a shared-secret gate of its own, in `server/auth.mjs`. It is redundant behind
Access and can be switched off with `HERDR_TERM_NO_AUTH=1` in `.env`. **If you are not putting an
edge policy in front of this, leave the gate on** and set `HERDR_TERM_TOKEN`:

- First visit becomes `https://<your-host>/?t=<token>`; the server redirects to `/` and sets an
  `HttpOnly` cookie so the token leaves the URL, history, and referrers.
- Unauthenticated HTTP then gets `401`, and WebSocket upgrades are refused before the socket opens.

Note that with the gate off, `127.0.0.1:8790` is reachable by any local process without a token.
That is the intended trade on a single-user machine, but it does mean local access is unrestricted.

**On scope:** the Files tab can read and download anything under `$HOME`, and the Desktop tab can
drive the machine. Neither widens the blast radius — the terminal already gives an unrestricted
shell as this user — but both make it reachable with fewer steps, so the Access email allowlist is
the only thing standing in front of them. Narrow `HERDR_TERM_FS_ROOT` if that isn't wanted.

## Setup

Assumes an Omarchy / Hyprland machine with Herdr installed, plus `grim` and `wtype` (both are
already there on Omarchy). `cloudflared` is only needed if you want it reachable from outside.

```bash
git clone https://github.com/sh1ftmaker/herdr-term ~/herdr-term
cd ~/herdr-term
npm install

cp .env.example .env && chmod 600 .env          # then edit it
cp cloudflared/config.example.yml cloudflared/config.yml   # then edit it
```

Unit templates are in [`systemd/`](systemd/) — they use `%h` rather than a hard-coded home, but
assume the clone is at `~/herdr-term`. See [`systemd/README.md`](systemd/README.md).

To run it without systemd at all:

```bash
node server/index.mjs      # prints the URL with the token
```

## Running

Managed by systemd user units:

```bash
systemctl --user status herdr-session herdr-term herdr-term-tunnel herdr-term-stream
systemctl --user restart herdr-term
journalctl --user -u herdr-term -f
```

| Unit | Role |
|---|---|
| `herdr-session.service` | headless Herdr session on a fixed-size pty |
| `herdr-term.service` | the Node bridge on `127.0.0.1:8790` |
| `herdr-term-tunnel.service` | `cloudflared` for your hostname |
| `herdr-term-stream.service` | moonlight-web on `127.0.0.1:8791` |

Enable them to start at boot, and turn on lingering (`loginctl enable-linger "$USER"`; check with
`loginctl show-user "$USER" --property=Linger`) so they come up **before anyone logs in**. If the
home directory is on an encrypted volume, it has to be unlocked at boot for `.env` and the tunnel
credentials to be readable by then.

The bridge therefore can't rely on its own environment to find the Wayland session — it may have
started before one existed. `server/desktop.mjs` re-resolves `WAYLAND_DISPLAY` and
`HYPRLAND_INSTANCE_SIGNATURE` from `$XDG_RUNTIME_DIR` on **every** call, which also survives
Hyprland restarting underneath it.

> **Do not add `After=default.target` to these units.** They are `WantedBy=default.target`, so
> ordering after it forms a cycle. systemd resolves that cycle by silently deleting the `herdr-term`
> and `herdr-term-tunnel` start jobs — everything looks fine until a reboot brings up only the Herdr
> session. Check with `systemd-analyze --user verify` after editing.

## Tunnel

Copy `cloudflared/config.example.yml` to `cloudflared/config.yml` and fill in your own tunnel id,
credentials path, and hostname. The real `config.yml` is gitignored because it names one specific
machine.

```bash
cloudflared tunnel create <name>
cloudflared tunnel route dns <name> <hostname>
```

If the hostname returns `530`, the tunnel exists but has no connector running — start the unit.

Everything is served from the single `127.0.0.1:8790` origin, including the proxied stream, so the
tunnel config needs no ingress changes as pages are added.

Run by `herdr-term-tunnel.service`; by hand it is:

```bash
cloudflared --config cloudflared/config.yml tunnel run
```
