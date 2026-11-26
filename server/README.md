# flick-server

`flick-server` shares media folders with Flick. Run it on a NAS, a desktop or any always-on machine, and every
Flick app (phone, TV, desktop, the website) can browse and play what is in those folders. It can also serve the
Flick web app itself, so a browser needs nothing but the server's address.

The HTTP API is in [CONTRACT.md](CONTRACT.md).

## Install

Download an archive for your system from
[Releases](https://github.com/baney75/flick/releases?q=server-v) (`flick-server-<version>-<target>`, with the
web app built in), unpack it and run `flick-server`. Builds exist for macOS (Apple silicon and Intel), Linux
(x86_64 and arm64) and Windows (x86_64).

On a NAS, use Docker. The image is `ghcr.io/baney75/flick-server` (amd64 and arm64), and
[compose/](compose) has ready files:

```sh
# edit /path/to/media in the file first
docker compose -f server/compose/docker-compose.yml up -d
docker compose -f server/compose/docker-compose.yml logs flick-server   # access code and setup links
```

The container keeps its settings and access code in the `/config` volume and serves the folder mounted at
`/media`. It listens on all interfaces inside the container; the setup links it prints use the container's own
address, so open the NAS address instead, or pass `--public-url http://<nas>:8740`.

Last option, build it with Rust:

```sh
npm ci && npx vite build
cargo build --release --manifest-path server/Cargo.toml --features embed-web
# binary: server/target/release/flick-server
```

Leave out `--features embed-web` (and the web build) for a server without the web app, or serve a built copy
from a folder with `--web dist`.

## Quick start

```sh
flick-server --media /srv/Movies --media /srv/TV --name "Living room NAS"
```

It prints an address and a setup link for each way to reach it, then keeps running until Ctrl-C. Settings are
saved, so next time plain `flick-server` is enough. The access code lives in the settings folder
(`~/.config/flick-server` by default); `--new-code` replaces it and breaks old links.

## Start at login

To keep the server running after a reboot, install it as a background service with the settings you want:

```sh
flick-server --media /srv/Movies --name "Living room NAS" --lan --install
```

This saves the settings, then registers the binary to start at login with `--config <settings folder>` and
starts it now. Run `--install` again after changing settings to restart it with them.

- macOS: a LaunchAgent at `~/Library/LaunchAgents/com.dbaney.flick-server.plist`, logging to
  `~/Library/Logs/flick-server.log`.
- Linux: a systemd user unit, `~/.config/systemd/user/flick-server.service`; logs with
  `journalctl --user -u flick-server`. User units stop at logout unless you run `sudo loginctl enable-linger $USER`.
- Windows: a scheduled task, `FlickServer`, that runs at logon.

`--install --tailscale` sets up Serve once; the mapping persists, so the installed server stays reachable there.
Quick tunnels change address each run, so for Cloudflare use a named tunnel and `--public-url`.
`flick-server --uninstall` stops and removes the service.

## Tailscale (recommended)

Private to your tailnet, real HTTPS, and works on phones and TVs that run Tailscale.

```sh
flick-server --tailscale
```

This runs `tailscale serve --bg --https=8740 http://127.0.0.1:8740` and prints `https://<machine>.<tailnet>.ts.net:8740`.
It uses its own HTTPS port, so anything you already serve on 443 is left alone, and it refuses if that port is
already mapped to something else. If Serve fails:

- Turn on HTTPS certificates for the tailnet at https://login.tailscale.com/admin/dns.
- On Linux, allow your user to run Serve once: `sudo tailscale set --operator=$USER`.

The mapping stays after the server stops and does nothing while nothing listens. Remove it with
`tailscale serve --https=8740 off`.

With Docker, [compose/tailscale.yml](compose/tailscale.yml) runs a Tailscale sidecar that joins the tailnet
as `flick` and serves [compose/serve.json](compose/serve.json): HTTPS on 443 to the server, so the NAS is
`https://flick.<tailnet>.ts.net` with no port opened. Set `TS_AUTHKEY` and put your tailnet name in
`--public-url` in the file.

## Cloudflare

Quick tunnel, for a short test from anywhere. Needs
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):

```sh
flick-server --cloudflare
```

It prints a `https://<x>.trycloudflare.com` address. The address changes every run, and anyone with the link and
the code can reach the server.

Named tunnel, for a lasting address on your own domain: set up the tunnel with cloudflared yourself, point it at
`http://127.0.0.1:8740`, and tell the server its address:

```sh
flick-server --public-url https://flick.example.com
```

Put Cloudflare Access in front of a named tunnel for a second lock besides the access code. `--no-public-url`
forgets the address. The same flag works behind any reverse proxy.

With Docker, [compose/cloudflare.yml](compose/cloudflare.yml) runs cloudflared next to the server. Create the
tunnel in the Cloudflare dashboard, give its public hostname the service `http://flick-server:8740`, set
`TUNNEL_TOKEN`, and put the hostname in `--public-url` in the file.

## LAN

```sh
flick-server --lan
```

Listens on every interface and prints an address per network. This is plain HTTP, so the hosted website at
https://flick-player.pages.dev cannot load from it (browsers block HTTP from an HTTPS page). Build the web app
in and open the LAN address instead.
`--local` goes back to this machine only.

## Connect a device

Open the setup link on the device, or paste it into Flick. It adds the server with its address and code. When
the server serves the web app, the link opens Flick from the server itself; otherwise it opens
https://flick-player.pages.dev.
