// The VPN gate (spec rules 25 to 30): a torrent of any kind, from the built-in engine or a debrid
// service, plays only while Flick detects a VPN that hides this computer. There is no other mode.
// These are the route checks: the default route goes through a tunnel that is not a mesh network
// (Tailscale), and every system DNS server routes through it.
// Decisions are pure functions over a `Probe`; `System` is the real one, tests use a fake. A
// system read that fails yields nothing, and nothing fails the gate.

use serde::Serialize;
use std::io::Write;
use std::net::IpAddr;
use std::process::{Command, Stdio};

// Cloudflare's resolver addresses. The route checks only ask the system how it would reach them.
const PROBE_V4: &str = "1.1.1.1";
const PROBE_V6: &str = "2606:4700:4700::1111";

/// Why the gate fails; Settings > Privacy shows the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Fail {
    NoVpn,
    Mesh,
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
    fn dns(&self) -> Option<Vec<String>>;
    /// Addresses of an interface that is up; empty when it is down or missing.
    fn addrs(&self, iface: &str) -> Vec<IpAddr>;
    fn is_tunnel(&self, iface: &str) -> bool;
    /// A mesh VPN (Tailscale) owns this interface.
    fn mesh_service(&self, iface: &str) -> bool;
    /// Some interface has a global IPv6 address (2000::/3).
    fn global_v6(&self) -> bool;
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
    let iface = p.route(PROBE_V4).ok_or(Fail::NoVpn)?;
    let addrs = p.addrs(&iface);
    if !p.is_tunnel(&iface) || addrs.is_empty() {
        return Err(Fail::NoVpn);
    }
    if addrs.iter().any(|a| is_mesh_addr(*a)) || p.mesh_service(&iface) {
        return Err(Fail::Mesh);
    }
    if p.global_v6() && p.route(PROBE_V6).is_some_and(|i| i != iface) {
        return Err(Fail::Ipv6Leak);
    }
    let dns = p.dns().unwrap_or_default();
    if dns.is_empty() || dns.iter().any(|s| p.route(s).as_deref() != Some(&iface)) {
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

/// Every check of rule 25, in order. Only macOS has detection yet; elsewhere it never passes.
pub fn check(p: &dyn Probe) -> GateState {
    if !cfg!(target_os = "macos") {
        return GateState::fail(Fail::Unchecked);
    }
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

/// macOS VPN interfaces: utun and ipsec, each with a number.
pub fn tunnel_name(name: &str) -> bool {
    let num = |p: &str| {
        name.strip_prefix(p)
            .is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()))
    };
    num("utun") || num("ipsec")
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

/// The real system: macOS `route` and `scutil`.
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
            None
        }
    }
    fn dns(&self) -> Option<Vec<String>> {
        let out = run("/usr/sbin/scutil", &["--dns"], None)?;
        Some(parse_scutil_dns(&out))
    }
    fn addrs(&self, iface: &str) -> Vec<IpAddr> {
        let all = if_addrs::get_if_addrs().unwrap_or_default();
        let up = |i: &&if_addrs::Interface| {
            i.name == iface && i.oper_status == if_addrs::IfOperStatus::Up
        };
        all.iter().filter(up).map(|i| i.ip()).collect()
    }
    fn is_tunnel(&self, iface: &str) -> bool {
        tunnel_name(iface)
    }
    fn mesh_service(&self, iface: &str) -> bool {
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
