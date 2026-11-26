# flick-server

`flick-server` shares media folders with Flick. Run it on a NAS, a desktop or any always-on machine, and every
Flick app (phone, TV, desktop, the website) can browse and play what is in those folders. It can also serve the
Flick web app itself, so a browser needs nothing but the server's address.

The HTTP API is in [CONTRACT.md](CONTRACT.md).

## Install

For now, build it with Rust (releases and a Docker image come next):

```sh
cargo build --release --manifest-path server/Cargo.toml
# binary: server/target/release/flick-server
```

To build the web app in, so the server serves Flick at its own address:

```sh
npm ci && npx vite build
cargo build --release --manifest-path server/Cargo.toml --features embed-web
```

Or serve a built copy from a folder with `--web dist`.

## Quick start

```sh
flick-server --media /srv/Movies --media /srv/TV --name "Living room NAS"
```

It prints an address and a setup link for each way to reach it, then keeps running until Ctrl-C. Settings are
saved, so next time plain `flick-server` is enough. The access code lives in the settings folder
(`~/.config/flick-server` by default); `--new-code` replaces it and breaks old links.

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
