// The VPN gate (spec rules 25 to 30): a torrent of any kind, from the built-in engine or a debrid
// service, plays only while Flick detects a VPN that hides this computer. There is no other mode.
// These are the route checks: the default route goes through a tunnel that is not a mesh network
// (Tailscale), and every system DNS server routes through it.
// Decisions are pure functions over a `Probe`; `System` is the real one, tests use a fake. A
// system read that fails yields nothing, and nothing fails the gate.

use serde::Serialize;
use std::io::Write;
use std::net::IpAddr;
use std::path::Path;
use std::process::{Command, Stdio};

// Addresses whose routes stand for "all traffic": Cloudflare's resolver, and documentation ranges
// nobody routes on purpose, so a split tunnel that carries only some destinations fails. The route
// checks only ask the system how it would reach them.
const PROBE_V4: &str = "1.1.1.1";
const ROUTES_V4: [&str; 3] = [PROBE_V4, "198.51.100.1", "203.0.113.1"];
const ROUTES_V6: [&str; 2] = ["2606:4700:4700::1111", "2001:db8::1"];

/// Why the gate fails; Settings > Privacy shows the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Fail {
    NoVpn,
    Mesh,
    Split,
    Ipv6Leak,
    Dns,
    Unchecked,
}

impl Fail {
    pub fn message(self) -> &'static str {
        match self {
            Fail::NoVpn => "No VPN is on: your traffic leaves through your normal connection.",
            Fail::Mesh => {
                "Tailscale and other mesh networks don't hide you. Turn on a privacy VPN."
            }
            Fail::Split => "Your VPN carries only some of your traffic. Turn on its full tunnel.",
            Fail::Ipv6Leak => {
                "IPv6 traffic goes around your VPN. Turn on its IPv6 leak protection."
            }
            Fail::Dns => "Your DNS goes around your VPN. Turn on its DNS leak protection.",
            Fail::Unchecked => "Flick can't check a VPN on this computer yet.",
        }
    }
}

/// What the gate asks of the system. `ip` strings may carry an IPv6 scope (fe80::1%en0).
pub trait Probe {
    /// The interface the system routes `ip` through.
    fn route(&self, ip: &str) -> Option<String>;
    /// The DNS servers general lookups use; None when a local stub's upstreams are unknown.
    fn dns(&self) -> Option<Vec<Dns>>;
    /// Addresses of an interface that is up; empty when it is down or missing.
    fn addrs(&self, iface: &str) -> Vec<IpAddr>;
    fn is_tunnel(&self, iface: &str) -> bool;
    /// A mesh VPN (Tailscale) owns this interface.
    fn mesh_service(&self, iface: &str) -> bool;
    /// Some interface has a global IPv6 address (2000::/3).
    fn global_v6(&self) -> bool;
    /// The system tools the checks read are present.
    fn ready(&self) -> bool {
        true
    }
}

/// A DNS server general lookups use. A link-bound server (systemd-resolved's per-link DNS) is
/// queried out of that link whatever the routes say.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dns {
    pub server: String,
    pub link: Option<String>,
}

impl Dns {
    pub fn routed(server: &str) -> Self {
        let (server, link) = (server.to_string(), None);
        Dns { server, link }
    }
}

/// Tailscale's ranges: 100.64.0.0/10 (shared with other CGNAT meshes) and fd7a:115c:a1e0::/48.
pub fn is_mesh_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => a.octets()[0] == 100 && a.octets()[1] & 0xc0 == 64,
        IpAddr::V6(a) => a.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

/// The default route's tunnel when the route checks pass (rule 25 a to c).
pub fn route_check(p: &dyn Probe) -> Result<String, Fail> {
    if !p.ready() {
        return Err(Fail::Unchecked);
    }
    let iface = p.route(PROBE_V4).ok_or(Fail::NoVpn)?;
    let addrs = p.addrs(&iface);
    if !p.is_tunnel(&iface) || addrs.is_empty() {
        return Err(Fail::NoVpn);
    }
    if addrs.iter().any(|a| is_mesh_addr(*a)) || p.mesh_service(&iface) {
        return Err(Fail::Mesh);
    }
    if ROUTES_V4
        .iter()
        .any(|ip| p.route(ip).as_deref() != Some(&iface))
    {
        return Err(Fail::Split);
    }
    let v6_around = |ip: &&str| p.route(ip).is_some_and(|i| i != iface);
    if p.global_v6() && ROUTES_V6.iter().any(v6_around) {
        return Err(Fail::Ipv6Leak);
    }
    let dns = p.dns().unwrap_or_default();
    let around = |d: &Dns| match &d.link {
        Some(link) => *link != iface,
        None => p.route(&d.server).as_deref() != Some(&iface),
    };
    if dns.is_empty() || dns.iter().any(around) {
        return Err(Fail::Dns);
    }
    Ok(iface)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GateState {
    pub ok: bool,
    pub iface: Option<String>,
    pub reason: Option<Fail>,
    pub message: Option<&'static str>,
}

impl GateState {
    pub fn pass(iface: String) -> Self {
        let (reason, message) = (None, None);
        GateState {
            ok: true,
            iface: Some(iface),
            reason,
            message,
        }
    }
    pub fn fail(f: Fail) -> Self {
        let (reason, message) = (Some(f), Some(f.message()));
        GateState {
            ok: false,
            iface: None,
            reason,
            message,
        }
    }
}

/// Every check of rule 25, in order. Only macOS and Linux have detection; elsewhere (Windows) it
/// never passes.
pub fn check(p: &dyn Probe) -> GateState {
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return GateState::fail(Fail::Unchecked);
    }
    decide(p)
}

/// The checks themselves, on any system (tests run them everywhere).
pub fn decide(p: &dyn Probe) -> GateState {
    match route_check(p) {
        Ok(iface) => GateState::pass(iface),
        Err(f) => GateState::fail(f),
    }
}

/// The interface of `route -n get <ip>` on macOS ("  interface: utun5").
pub fn parse_route_macos(out: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.trim().strip_prefix("interface:"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The `dev` of `ip route get <ip>` on Linux ("1.1.1.1 via 10.0.0.1 dev wg0 src ...").
pub fn parse_route_linux(out: &str) -> Option<String> {
    let mut w = out.split_whitespace();
    while let Some(t) = w.next() {
        if t == "dev" {
            return w.next().map(String::from);
        }
    }
    None
}

/// Name servers of `scutil --dns` that answer general lookups: unscoped resolvers with no
/// `domain` and no Supplemental flag (Tailscale's resolver only serves its tailnet's names).
pub fn parse_scutil_dns(out: &str) -> Vec<String> {
    let unscoped = out
        .split("DNS configuration (for scoped queries)")
        .next()
        .unwrap_or("");
    let general = |r: &&str| {
        !r.lines().map(str::trim).any(|l| {
            l.starts_with("domain ") || (l.starts_with("flags") && l.contains("Supplemental"))
        })
    };
    let servers = |r: &str| -> Vec<String> {
        r.lines()
            .filter_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.trim()
                    .starts_with("nameserver[")
                    .then(|| v.trim().to_string())
            })
            .collect()
    };
    unscoped
        .split("\nresolver #")
        .skip(1)
        .filter(general)
        .flat_map(servers)
        .collect()
}

/// `nameserver` lines from a resolv.conf.
pub fn parse_resolv_conf(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            (w.next() == Some("nameserver"))
                .then(|| w.next().map(String::from))
                .flatten()
        })
        .collect()
}

/// Linux DNS from resolv.conf's servers. systemd-resolved's stub (127.0.0.53 or 127.0.0.54)
/// counts through `resolved`, read only when the stub is listed; any other local stub (dnsmasq,
/// unbound) has unknown upstreams, so the answer is None.
pub fn linux_dns(
    servers: Vec<String>,
    resolved: impl FnOnce() -> Option<Vec<Dns>>,
) -> Option<Vec<Dns>> {
    let stub = |s: &String| s == "127.0.0.53" || s == "127.0.0.54";
    let local = |s: &String| s.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if servers.iter().any(|s| local(s) && !stub(s)) {
        return None;
    }
    let mut out: Vec<Dns> = servers
        .iter()
        .filter(|s| !stub(s))
        .map(|s| Dns::routed(s))
        .collect();
    if servers.iter().any(stub) {
        out.extend(resolved()?);
    }
    Some(out)
}

/// One `resolvectl` listing: (None for Global or the link's name, its values). Long values
/// wrap onto indented lines that continue the scope above them.
fn scopes(out: &str) -> Vec<(Option<String>, Vec<String>)> {
    let mut all: Vec<(Option<String>, Vec<String>)> = vec![];
    for l in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let words = |v: &str| v.split_whitespace().map(String::from).collect::<Vec<_>>();
        let link = l.strip_prefix("Link ").and_then(|r| r.split_once("): "));
        let link = link.or_else(|| l.strip_prefix("Link ")?.strip_suffix("):").map(|r| (r, "")));
        if let Some((head, vals)) = link {
            let name = head.split_once('(').map_or("", |h| h.1);
            all.push((Some(name.to_string()), words(vals)));
        } else if let Some(vals) = l.strip_prefix("Global:") {
            all.push((None, words(vals)));
        } else if let Some(last) = all.last_mut() {
            last.1.extend(words(l));
        }
    }
    all
}

/// The servers systemd-resolved sends general lookups to, from `resolvectl dns`, `domain` and
/// `default-route`. A query goes to the links with the catch-all routing domain `~.` when any has
/// one, else to every link with DefaultRoute on. Global servers always count (strict), checked by
/// route; a link's servers are checked by their link.
pub fn parse_resolved(dns: &str, domains: &str, default_route: &str) -> Vec<Dns> {
    let (doms, routes) = (scopes(domains), scopes(default_route));
    let has = |set: &[(Option<String>, Vec<String>)], link: &Option<String>, v: &str| {
        set.iter()
            .any(|(l, vs)| l == link && vs.iter().any(|x| x == v))
    };
    let catch_all = doms.iter().any(|(_, vs)| vs.iter().any(|x| x == "~."));
    let general = |link: &Option<String>| match catch_all {
        _ if link.is_none() => true,
        true => has(&doms, link, "~."),
        false => !has(&routes, link, "no"),
    };
    let server = |v: &String| v.split('#').next().unwrap_or("").to_string();
    scopes(dns)
        .into_iter()
        .filter(|(link, _)| general(link))
        .flat_map(|(link, vs)| {
            let server = &server;
            vs.into_iter().map(move |v| Dns {
                server: server(&v),
                link: link.clone(),
            })
        })
        .collect()
}

/// Linux: a link carries traffic when sysfs `flags` has IFF_UP and `operstate` is `up`, or
/// `unknown`, which WireGuard and TUN devices always report.
pub fn link_up(operstate: &str, flags: &str) -> bool {
    let flags = u32::from_str_radix(flags.trim().trim_start_matches("0x"), 16).unwrap_or(0);
    flags & 1 == 1 && matches!(operstate.trim(), "up" | "unknown")
}

/// Linux mesh VPNs by interface name: Tailscale, ZeroTier, Nebula, NetBird.
pub fn linux_mesh_name(iface: &str) -> bool {
    ["tailscale", "zt", "nebula", "wt"]
        .iter()
        .any(|p| iface.starts_with(p))
}

/// Service ids of connected Tailscale services in `scutil --nc list`.
pub fn parse_mesh_services(out: &str) -> Vec<String> {
    out.lines()
        .filter(|l| l.contains("(Connected)") && l.contains("io.tailscale"))
        .filter_map(|l| l.split_whitespace().nth(2).map(String::from))
        .collect()
}

/// `InterfaceName` of a `show State:/Network/Service/<id>/IPv4` scutil answer.
pub fn parse_interface_name(out: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.trim().strip_prefix("InterfaceName :"))
        .map(|s| s.trim().to_string())
}

/// macOS utun and ipsec; Linux tun, wg, or any TUN or WireGuard device by type (Proton, Nord).
pub fn tunnel_name(os: &str, name: &str, tun_device: bool) -> bool {
    let num = |p: &str| {
        name.strip_prefix(p)
            .is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()))
    };
    match os {
        "macos" => num("utun") || num("ipsec"),
        "linux" => num("tun") || name.starts_with("wg") || tun_device,
        _ => false,
    }
}

fn run(bin: &str, args: &[&str], stdin: Option<&str>) -> Option<String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let input = stdin.unwrap_or("").as_bytes();
    child.stdin.take()?.write_all(input).ok()?;
    let out = child.wait_with_output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn ip_bin() -> Option<&'static str> {
    let nixos = "/run/current-system/sw/bin/ip";
    let bins = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip", nixos];
    bins.into_iter().find(|p| Path::new(p).is_file())
}

fn resolvectl() -> Option<Vec<Dns>> {
    let bins = [
        "/usr/bin/resolvectl",
        "/bin/resolvectl",
        "/run/current-system/sw/bin/resolvectl",
    ];
    let bin = bins.into_iter().find(|p| Path::new(p).is_file())?;
    let dns = run(bin, &["dns"], None)?;
    let domains = run(bin, &["domain"], None).unwrap_or_default();
    let routes = run(bin, &["default-route"], None).unwrap_or_default();
    Some(parse_resolved(&dns, &domains, &routes))
}

/// The real system: macOS route and scutil; Linux ip and resolv.conf.
pub struct System;

impl Probe for System {
    fn route(&self, ip: &str) -> Option<String> {
        let v6 = ip.contains(':');
        if cfg!(target_os = "macos") {
            let args: &[&str] = if v6 {
                &["-n", "get", "-inet6", ip]
            } else {
                &["-n", "get", ip]
            };
            parse_route_macos(&run("/sbin/route", args, None)?)
        } else {
            let fam = if v6 { "-6" } else { "-4" };
            parse_route_linux(&run(ip_bin()?, &[fam, "route", "get", ip], None)?)
        }
    }
    fn dns(&self) -> Option<Vec<Dns>> {
        if cfg!(target_os = "macos") {
            let out = run("/usr/sbin/scutil", &["--dns"], None)?;
            return Some(
                parse_scutil_dns(&out)
                    .iter()
                    .map(|s| Dns::routed(s))
                    .collect(),
            );
        }
        let conf = std::fs::read_to_string("/etc/resolv.conf").ok()?;
        linux_dns(parse_resolv_conf(&conf), resolvectl)
    }
    fn addrs(&self, iface: &str) -> Vec<IpAddr> {
        let all = if_addrs::get_if_addrs().unwrap_or_default();
        let sys = Path::new("/sys/class/net").join(iface);
        let read = |f: &str| std::fs::read_to_string(sys.join(f)).unwrap_or_default();
        let linux_up = || link_up(&read("operstate"), &read("flags"));
        let up = |i: &&if_addrs::Interface| {
            i.name == iface
                && match cfg!(target_os = "linux") {
                    true => linux_up(),
                    false => i.oper_status == if_addrs::IfOperStatus::Up,
                }
        };
        all.iter().filter(up).map(|i| i.ip()).collect()
    }
    fn is_tunnel(&self, iface: &str) -> bool {
        let sys = Path::new("/sys/class/net").join(iface);
        let uevent = std::fs::read_to_string(sys.join("uevent")).unwrap_or_default();
        let dev = uevent.contains("DEVTYPE=wireguard") || sys.join("tun_flags").exists();
        tunnel_name(std::env::consts::OS, iface, dev)
    }
    fn mesh_service(&self, iface: &str) -> bool {
        if !cfg!(target_os = "macos") {
            return linux_mesh_name(iface);
        }
        let list = run("/usr/sbin/scutil", &["--nc", "list"], None).unwrap_or_default();
        parse_mesh_services(&list).iter().any(|id| {
            let q = format!("show State:/Network/Service/{id}/IPv4\n");
            let out = run("/usr/sbin/scutil", &[], Some(&q)).unwrap_or_default();
            parse_interface_name(&out).as_deref() == Some(iface)
        })
    }
    fn global_v6(&self) -> bool {
        let all = if_addrs::get_if_addrs().unwrap_or_default();
        all.iter()
            .any(|i| matches!(i.ip(), IpAddr::V6(a) if a.segments()[0] & 0xe000 == 0x2000))
    }
    fn ready(&self) -> bool {
        cfg!(target_os = "macos") || ip_bin().is_some()
    }
}

/// The gate right now: it passes, or says what failed. The torrent engine and the debrid player
/// both gate on it.
#[tauri::command]
pub async fn vpn_gate() -> Result<GateState, String> {
    let run = tauri::async_runtime::spawn_blocking(|| check(&System));
    run.await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
