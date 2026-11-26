// The VPN gate (spec rules 25 to 30): a torrent of any kind, from the built-in engine or a debrid
// service, plays only while Flick detects a VPN that hides this computer. There is no other mode.
// The gate passes when the default route goes through a tunnel that is not a mesh network
// (Tailscale), every system DNS server routes through it, and Cloudflare's trace page sees a
// different address through the tunnel than through the physical interface.
// Decisions are pure functions over a `Probe`; `System` is the real one, tests use a fake.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

// Addresses whose routes stand for "all traffic": Cloudflare's resolver, which the exit check also
// fetches, and documentation ranges nobody routes on purpose, so a split tunnel that carries only
// some destinations fails.
const PROBE_V4: &str = "1.1.1.1";
const PROBE_V6: &str = "2606:4700:4700::1111";
const ROUTES_V4: [&str; 3] = [PROBE_V4, "198.51.100.1", "203.0.113.1"];
const ROUTES_V6: [&str; 2] = [PROBE_V6, "2001:db8::1"];

/// Why the gate fails; Settings > Privacy shows the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Fail {
    NoVpn,
    Mesh,
    Split,
    Ipv6Leak,
    Dns,
    Offline,
    NotHidden,
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
            Fail::Offline => "Flick can't reach the internet through your VPN.",
            Fail::NotHidden => {
                "Your VPN isn't hiding your address: sites see the same address with it on."
            }
            Fail::Unchecked => "Flick can't check a VPN on this computer yet.",
        }
    }
}

/// A trace request that failed. Only `Net` means nothing reached the server: the connection was
/// refused or timed out, as a VPN's kill switch does to the physical link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TraceErr {
    /// The socket could not be bound to the interface.
    Bind,
    /// The connection did not open.
    Net,
    /// The connection opened, but no usable answer came back (TLS, a read, a bad response).
    Answer,
}

/// What the gate asks of the system. `ip` strings may carry an IPv6 scope (fe80::1%en0).
pub trait Probe {
    /// The interface the system routes `ip` through.
    fn route(&self, ip: &str) -> Option<String>;
    /// The first default-route interface that is not a tunnel: where traffic goes without the VPN.
    /// Ok(None) when every default route is a tunnel or down; Err(Unchecked) when the routes could
    /// not be read or held no default route.
    fn physical(&self) -> Result<Option<String>, Fail>;
    /// The DNS servers general lookups use; None when a local stub's upstreams are unknown.
    fn dns(&self) -> Option<Vec<Dns>>;
    /// Addresses of an interface that is up; empty when it is down or missing.
    fn addrs(&self, iface: &str) -> Vec<IpAddr>;
    fn is_tunnel(&self, iface: &str) -> bool;
    /// A mesh VPN (Tailscale) owns this interface.
    fn mesh_service(&self, iface: &str) -> bool;
    /// Some interface has a global IPv6 address (2000::/3).
    fn global_v6(&self) -> bool;
    /// The `ip=` Cloudflare's trace page reports, bound to `bind` when given.
    fn trace(&self, v6: bool, bind: Option<&str>) -> Result<IpAddr, TraceErr>;
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

/// Rule 25 d: the address sites see through the tunnel, when it differs from the physical one.
/// A physical request the network refuses (a VPN's own kill switch) exposes nothing, so it passes.
pub fn exit_check(p: &dyn Probe) -> Result<IpAddr, Fail> {
    let phys = p.physical()?;
    let leaks = |seen: IpAddr, v6: bool| -> Result<bool, Fail> {
        let Some(ph) = phys.as_deref() else {
            return Ok(false);
        };
        if p.addrs(ph).contains(&seen) {
            return Ok(true);
        }
        match p.trace(v6, Some(ph)) {
            Ok(ip) => Ok(ip == seen),
            Err(TraceErr::Net) => Ok(false),
            Err(TraceErr::Bind | TraceErr::Answer) => Err(Fail::Unchecked),
        }
    };
    let v4 = p.trace(false, None).map_err(|_| Fail::Offline)?;
    if leaks(v4, false)? {
        return Err(Fail::NotHidden);
    }
    if p.global_v6() {
        if let Ok(v6) = p.trace(true, None) {
            if leaks(v6, true)? {
                return Err(Fail::Ipv6Leak);
            }
        }
    }
    Ok(v4)
}

/// "185.65.134.x": the exit address with its last part hidden, for Settings.
pub fn mask(ip: IpAddr) -> String {
    let s = ip.to_string();
    let cut = if ip.is_ipv4() { '.' } else { ':' };
    match s.rsplit_once(cut) {
        Some((head, _)) => format!("{head}{cut}x"),
        None => s,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GateState {
    pub ok: bool,
    pub iface: Option<String>,
    pub exit: Option<String>,
    pub reason: Option<Fail>,
    pub message: Option<&'static str>,
}

impl GateState {
    pub fn pass(iface: String, exit: IpAddr) -> Self {
        let (iface, exit) = (Some(iface), Some(mask(exit)));
        let (reason, message) = (None, None);
        GateState {
            ok: true,
            iface,
            exit,
            reason,
            message,
        }
    }
    pub fn fail(f: Fail) -> Self {
        let (reason, message) = (Some(f), Some(f.message()));
        GateState {
            ok: false,
            iface: None,
            exit: None,
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
    match route_check(p).and_then(|i| exit_check(p).map(|ip| (i, ip))) {
        Ok((iface, ip)) => GateState::pass(iface, ip),
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
    // A route that drops traffic (an IPv6 block such as `unreachable ::/0`) goes nowhere.
    let first = w.clone().next();
    if matches!(first, Some("unreachable" | "blackhole" | "prohibit")) {
        return None;
    }
    while let Some(t) = w.next() {
        if t == "dev" {
            return w.next().filter(|d| *d != "lo").map(String::from);
        }
    }
    None
}

/// Default-route interfaces in order: the fourth column of `netstat -rn -f inet` (macOS), or
/// each `dev` of `ip route show default` (Linux), the `nexthop` lines of a multipath route included.
pub fn parse_defaults(out: &str, linux: bool) -> Vec<String> {
    let mut found = vec![];
    let mut in_default = false;
    for l in out.lines() {
        let nexthop = l.trim_start().starts_with("nexthop");
        if !nexthop {
            in_default = l.starts_with("default");
        }
        if !in_default {
            continue;
        }
        let dev = if linux {
            parse_route_linux(l)
        } else if nexthop {
            None
        } else {
            l.split_whitespace().nth(3).map(String::from)
        };
        found.extend(dev);
    }
    found
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

/// What systemd-resolved says, when it runs.
#[derive(Debug, PartialEq)]
pub enum Resolved {
    /// Not running: resolv.conf is the whole answer.
    Off,
    /// Running, but its servers couldn't be read.
    Unknown,
    Links(Vec<Dns>),
}

/// Linux DNS: resolv.conf's servers, plus resolved's whenever it runs (glibc may ask it over
/// nsswitch whatever resolv.conf says, and it sends a link's servers out of that link). Its stub
/// (127.0.0.53 or .54) needs resolved; any other local stub (dnsmasq, unbound) has unknown
/// upstreams. None when the servers can't be known.
pub fn linux_dns(servers: Vec<String>, resolved: Resolved) -> Option<Vec<Dns>> {
    let stub = |s: &String| s == "127.0.0.53" || s == "127.0.0.54";
    let local = |s: &String| s.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if servers.iter().any(|s| local(s) && !stub(s)) {
        return None;
    }
    let plain = servers.iter().filter(|s| !stub(s)).map(|s| Dns::routed(s));
    let mut out: Vec<Dns> = plain.collect();
    match resolved {
        Resolved::Links(links) => out.extend(links),
        Resolved::Off if !servers.iter().any(stub) => {}
        _ => return None,
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

/// Linux: a WireGuard or kernel OpenVPN (`ovpn`, Linux 6.16) device, or a TUN device (IFF_TUN
/// set, IFF_TAP clear in `tun_flags`); a bridged TAP (qemu's vnet0) or a device merely named wg0
/// is not one.
pub fn linux_tun(uevent: &str, tun_flags: Option<&str>) -> bool {
    let flags =
        tun_flags.and_then(|f| u32::from_str_radix(f.trim().trim_start_matches("0x"), 16).ok());
    let typed = |l: &str| matches!(l.trim(), "DEVTYPE=wireguard" | "DEVTYPE=ovpn");
    uevent.lines().any(typed) || flags.is_some_and(|f| f & 3 == 1)
}

/// macOS utun and ipsec by name; Linux by device type (`linux_tun`).
pub fn tunnel_name(os: &str, name: &str, tun_device: bool) -> bool {
    let num = |p: &str| {
        name.strip_prefix(p)
            .is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()))
    };
    match os {
        "macos" => num("utun") || num("ipsec"),
        "linux" => tun_device,
        _ => false,
    }
}

fn run(bin: &str, args: &[&str], stdin: Option<&str>) -> Option<String> {
    run_within(bin, args, stdin, Duration::from_secs(5))
}

/// A tool's output, or None when it fails or runs past `limit` (then it is killed): a hung
/// resolvectl must fail the check, not stall it on its last answer.
fn run_within(bin: &str, args: &[&str], stdin: Option<&str>, limit: Duration) -> Option<String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let input = stdin.unwrap_or("").as_bytes();
    let wrote = child.stdin.take().map(|mut i| i.write_all(input));
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = vec![];
        stdout.read_to_end(&mut buf).map(|_| buf)
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = reader.join().ok()?.ok()?;
    (wrote?.is_ok() && status?.success()).then(|| String::from_utf8_lossy(&out).into_owned())
}

fn ip_bin() -> Option<&'static str> {
    let nixos = "/run/current-system/sw/bin/ip";
    let bins = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip", nixos];
    bins.into_iter().find(|p| Path::new(p).is_file())
}

fn resolvectl() -> Resolved {
    if !Path::new("/run/systemd/resolve").is_dir() {
        return Resolved::Off;
    }
    let bins = [
        "/usr/bin/resolvectl",
        "/bin/resolvectl",
        "/run/current-system/sw/bin/resolvectl",
    ];
    let Some(bin) = bins.into_iter().find(|p| Path::new(p).is_file()) else {
        return Resolved::Unknown;
    };
    let Some(dns) = run(bin, &["dns"], None) else {
        return Resolved::Unknown;
    };
    let domains = run(bin, &["domain"], None).unwrap_or_default();
    let routes = run(bin, &["default-route"], None).unwrap_or_default();
    Resolved::Links(parse_resolved(&dns, &domains, &routes))
}

/// The real system: macOS route, netstat and scutil; Linux ip and resolv.conf.
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
    fn physical(&self) -> Result<Option<String>, Fail> {
        let linux = !cfg!(target_os = "macos");
        let out = if linux {
            let args = ["-4", "route", "show", "table", "all", "default"];
            ip_bin().and_then(|ip| run(ip, &args, None))
        } else {
            run("/usr/sbin/netstat", &["-rn", "-f", "inet"], None)
        };
        let defaults = parse_defaults(&out.ok_or(Fail::Unchecked)?, linux);
        if defaults.is_empty() {
            return Err(Fail::Unchecked);
        }
        let usable = |i: &String| !self.is_tunnel(i) && !self.addrs(i).is_empty();
        Ok(defaults.into_iter().find(usable))
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
        linux_dns(parse_resolv_conf(&conf), resolvectl())
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
        let flags = std::fs::read_to_string(sys.join("tun_flags")).ok();
        let dev = linux_tun(&uevent, flags.as_deref());
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
    fn trace(&self, v6: bool, bind: Option<&str>) -> Result<IpAddr, TraceErr> {
        let ip: IpAddr = if v6 { PROBE_V6 } else { PROBE_V4 }
            .parse()
            .map_err(|_| TraceErr::Net)?;
        let tcp = connect(SocketAddr::new(ip, 443), bind)?;
        let resp = https_get(tcp, ip).map_err(|_| TraceErr::Answer)?;
        parse_trace(&resp).ok_or(TraceErr::Answer)
    }
}

/// A TCP connection, bound to `bind` when given (IP_BOUND_IF on macOS, SO_BINDTODEVICE on Linux).
fn connect(addr: SocketAddr, bind: Option<&str>) -> Result<TcpStream, TraceErr> {
    use socket2::{Domain, Protocol, Socket, Type};
    let net = |_| TraceErr::Net;
    let s =
        Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP)).map_err(net)?;
    if let Some(name) = bind {
        bind_device(&s, name, addr.is_ipv6()).map_err(|_| TraceErr::Bind)?;
    }
    let t = Duration::from_secs(4);
    s.connect_timeout(&addr.into(), t).map_err(net)?;
    s.set_read_timeout(Some(t))
        .and(s.set_write_timeout(Some(t)))
        .map_err(net)?;
    Ok(s.into())
}

#[cfg(target_os = "macos")]
fn bind_device(s: &socket2::Socket, name: &str, v6: bool) -> std::io::Result<()> {
    let all = if_addrs::get_if_addrs()?;
    let idx = all.iter().find(|i| i.name == name).and_then(|i| i.index);
    let idx = idx
        .and_then(std::num::NonZeroU32::new)
        .ok_or(std::io::ErrorKind::NotFound)?;
    if v6 {
        s.bind_device_by_index_v6(Some(idx))
    } else {
        s.bind_device_by_index_v4(Some(idx))
    }
}

#[cfg(target_os = "linux")]
fn bind_device(s: &socket2::Socket, name: &str, _v6: bool) -> std::io::Result<()> {
    s.bind_device(Some(name.as_bytes()))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn bind_device(_: &socket2::Socket, _: &str, _: bool) -> std::io::Result<()> {
    Err(std::io::ErrorKind::Unsupported.into())
}

/// GET /cdn-cgi/trace over TLS, the server checked against the address itself (Cloudflare's
/// certificate names 1.1.1.1 and 2606:4700:4700::1111).
fn https_get(tcp: TcpStream, ip: IpAddr) -> Result<String, Box<dyn std::error::Error>> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let ring = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ClientConfig::builder_with_provider(ring)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let conn = rustls::ClientConnection::new(Arc::new(cfg), ip.into())?;
    let mut tls = rustls::StreamOwned::new(conn, tcp);
    let host = if ip.is_ipv6() {
        format!("[{ip}]")
    } else {
        ip.to_string()
    };
    let req = format!(
        "GET /cdn-cgi/trace HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Flick\r\nConnection: close\r\n\r\n"
    );
    tls.write_all(req.as_bytes())?;
    let mut buf = vec![];
    // A server may close without a TLS close_notify; what arrived before that still counts.
    if let Err(e) = tls.read_to_end(&mut buf) {
        if buf.is_empty() || e.kind() != std::io::ErrorKind::UnexpectedEof {
            return Err(e.into());
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// The `ip=` line of a 200 response from /cdn-cgi/trace.
pub fn parse_trace(resp: &str) -> Option<IpAddr> {
    if !resp.starts_with("HTTP/1.1 200") {
        return None;
    }
    resp.lines()
        .find_map(|l| l.trim().strip_prefix("ip=")?.parse().ok())
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
