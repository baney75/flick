use super::*;
use std::collections::HashMap;

/// A system whose routes, interfaces and DNS are set by the test.
#[derive(Clone)]
struct Fake {
    routes: HashMap<String, String>,
    addrs: HashMap<String, Vec<IpAddr>>,
    dns: Option<Vec<String>>,
    mesh: bool,
    v6: bool,
}

impl Probe for Fake {
    fn route(&self, ip: &str) -> Option<String> {
        self.routes.get(ip).cloned()
    }
    fn dns(&self) -> Option<Vec<String>> {
        self.dns.clone()
    }
    fn addrs(&self, iface: &str) -> Vec<IpAddr> {
        self.addrs.get(iface).cloned().unwrap_or_default()
    }
    fn is_tunnel(&self, iface: &str) -> bool {
        tunnel_name(iface)
    }
    fn mesh_service(&self, _: &str) -> bool {
        self.mesh
    }
    fn global_v6(&self) -> bool {
        self.v6
    }
}

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

impl Fake {
    fn route(mut self, to: &str, iface: &str) -> Self {
        self.routes.insert(to.into(), iface.into());
        self
    }
    fn addr(mut self, iface: &str, a: &str) -> Self {
        self.addrs.entry(iface.into()).or_default().push(ip(a));
        self
    }
}

/// Spec case 1: default route via utun4 (10.2.0.2), DNS 10.2.0.1 via utun4.
fn vpn() -> Fake {
    let f = Fake {
        routes: HashMap::new(),
        addrs: HashMap::new(),
        dns: Some(vec!["10.2.0.1".into()]),
        mesh: false,
        v6: false,
    };
    f.route("1.1.1.1", "utun4")
        .route("198.51.100.1", "utun4")
        .route("203.0.113.1", "utun4")
        .route("10.2.0.1", "utun4")
        .addr("utun4", "10.2.0.2")
        .addr("en0", "192.168.1.5")
}

fn fails(p: &Fake) -> Option<Fail> {
    decide(p).reason
}

#[test]
fn a_full_tunnel_vpn_passes() {
    let s = decide(&vpn());
    assert!(s.ok, "{s:?}");
    assert_eq!(s.iface.as_deref(), Some("utun4"));
}

#[test]
fn no_vpn_fails() {
    let p = vpn().route("1.1.1.1", "en0");
    assert_eq!(fails(&p), Some(Fail::NoVpn));
    let mut gone = vpn();
    gone.addrs.remove("utun4");
    assert_eq!(fails(&gone), Some(Fail::NoVpn), "a tunnel that is down");
    let mut none = vpn();
    none.routes.remove("1.1.1.1");
    assert_eq!(fails(&none), Some(Fail::NoVpn), "no route at all");
}

#[test]
fn tailscale_is_a_mesh_not_a_vpn() {
    let exit_node = vpn().route("1.1.1.1", "utun19").route("10.2.0.1", "utun19");
    let exit_node = exit_node.addr("utun19", "100.101.2.3");
    assert_eq!(fails(&exit_node), Some(Fail::Mesh));
    let v6_only = vpn().addr("utun4", "fd7a:115c:a1e0::b73b:ce49");
    assert_eq!(fails(&v6_only), Some(Fail::Mesh));
    let mut service = vpn();
    service.mesh = true;
    assert_eq!(fails(&service), Some(Fail::Mesh));
    assert!(!is_mesh_addr(ip("100.128.0.1")) && !is_mesh_addr(ip("10.64.0.1")));
}

#[test]
fn a_split_tunnel_fails() {
    // A profile that routes only 1.1.1.1/32 (and DNS to it) through the tunnel.
    let p = vpn().route("203.0.113.1", "en0");
    assert_eq!(fails(&p), Some(Fail::Split));
    let mut gone = vpn();
    gone.routes.remove("198.51.100.1");
    assert_eq!(fails(&gone), Some(Fail::Split));
}

#[test]
fn dns_outside_the_tunnel_fails() {
    let mut lan = vpn().route("192.168.1.1", "en0");
    lan.dns = Some(vec!["10.2.0.1".into(), "192.168.1.1".into()]);
    assert_eq!(fails(&lan), Some(Fail::Dns));
    let mut unknown = vpn();
    unknown.dns = None;
    assert_eq!(
        fails(&unknown),
        Some(Fail::Dns),
        "a stub with unknown upstreams"
    );
    let mut empty = vpn();
    empty.dns = Some(vec![]);
    assert_eq!(fails(&empty), Some(Fail::Dns));
}

#[test]
fn an_ipv6_route_around_the_tunnel_fails() {
    let mut route = vpn().route("2001:db8::1", "en0");
    route.v6 = true;
    assert_eq!(fails(&route), Some(Fail::Ipv6Leak));
    let mut blocked = vpn().route("2606:4700:4700::1111", "utun4");
    blocked.v6 = true;
    assert!(decide(&blocked).ok, "a tunnel that takes IPv6 too");
    let mut no_route = vpn();
    no_route.v6 = true;
    assert!(decide(&no_route).ok, "IPv6 with no route goes nowhere");
}

// Taken from this Mac: Tailscale on utun19 (not an exit node), the router's DNS on en0.
const SCUTIL_TAILSCALE: &str = "\nDNS configuration\n\nresolver #1\n  search domain[0] : tail2b1ef8.ts.net\n  nameserver[0] : 100.100.100.100\n  nameserver[1] : fd7a:115c:a1e0::53\n  if_index : 58 (utun19)\n  flags    : Supplemental, Request A records, Request AAAA records\n  reach    : 0x00000003 (Reachable,Transient Connection)\n  order    : 102400\n\nresolver #2\n  nameserver[0] : 10.0.0.1\n  if_index : 14 (en0)\n  flags    : Request A records\n  reach    : 0x00020002 (Reachable,Directly Reachable Address)\n  order    : 200000\n\nresolver #3\n  domain   : tail2b1ef8.ts.net.\n  nameserver[0] : 100.100.100.100\n  if_index : 58 (utun19)\n  flags    : Supplemental, Request A records, Request AAAA records\n\nresolver #4\n  domain   : local\n  options  : mdns\n\nDNS configuration (for scoped queries)\n\nresolver #1\n  nameserver[0] : 10.0.0.1\n  if_index : 14 (en0)\n";
const SCUTIL_VPN: &str = "\nDNS configuration\n\nresolver #1\n  nameserver[0] : 10.64.0.1\n  nameserver[1] : fe80::1%utun5\n  if_index : 22 (utun5)\n  flags    : Request A records, Request AAAA records\n\nresolver #2\n  domain   : local\n  options  : mdns\n";
const NC_LIST: &str = "Available network connection services in the current set (*=enabled):\n* (Connected)      DC1441BC-F588-49DC-8B46-DF3A4ED26081 VPN (io.tailscale.ipn.macsys) \"Tailscale\"                      [VPN:io.tailscale.ipn.macsys]\n  (Invalid)        DD1431E0-932B-42F7-9881-548EBF86ACC0 VPN (com.sonicwall.SonicWALL-Mobile-Connect) \"Work\"   [VPN:com.sonicwall.SonicWALL-Mobile-Connect]\n";
const SERVICE_IPV4: &str = "<dictionary> {\n  Addresses : <array> {\n    0 : 100.107.206.73\n  }\n  InterfaceName : utun19\n  Router : 100.107.206.73\n}\n";

#[test]
fn parses_macos_route_dns_and_service_output() {
    let get =
        "   route to: 1.1.1.1\ndestination: 0.0.0.0\n  interface: utun5\n      flags: <UP,DONE>\n";
    assert_eq!(parse_route_macos(get).as_deref(), Some("utun5"));
    assert_eq!(
        parse_route_macos("route: writing to routing socket: not in table"),
        None
    );
    assert_eq!(parse_scutil_dns(SCUTIL_TAILSCALE), ["10.0.0.1"]);
    assert_eq!(parse_scutil_dns(SCUTIL_VPN), ["10.64.0.1", "fe80::1%utun5"]);
    assert_eq!(
        parse_mesh_services(NC_LIST),
        ["DC1441BC-F588-49DC-8B46-DF3A4ED26081"]
    );
    assert_eq!(
        parse_interface_name(SERVICE_IPV4).as_deref(),
        Some("utun19")
    );
}

#[test]
fn names_macos_tunnels() {
    assert!(tunnel_name("utun4") && tunnel_name("ipsec0"));
    assert!(!tunnel_name("en0") && !tunnel_name("utun") && !tunnel_name("utunx"));
}

/// The gate on this computer, for a manual check:
/// `cargo test vpn::tests::live -- --ignored --nocapture`.
#[test]
#[ignore]
fn live() {
    let p = System;
    println!("{:?}", check(&p));
    println!("utun19 is a mesh service: {}", p.mesh_service("utun19"));
}
