# systemd user units

Templates for the four units. `%h` is systemd's specifier for the user's home
directory, so nothing here names a particular user — but they do assume the
repo is cloned at `%h/herdr-term`, and that `node` and `cloudflared` are on the
service PATH. Edit those paths if yours differ (a version-managed node, for
example, usually needs its absolute shim path).

```bash
mkdir -p ~/.config/systemd/user
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now herdr-session herdr-term herdr-term-tunnel
loginctl enable-linger "$USER"          # so they survive logout / start at boot
systemd-analyze --user verify ~/.config/systemd/user/herdr-term*.service
```

`herdr-term-stream.service` is only needed for the moonlight stream.
