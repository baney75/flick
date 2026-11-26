use super::*;
use std::collections::HashMap;

/// A system whose routes, interfaces and DNS are set by the test.
#[derive(Clone)]
struct Fake {
    routes: HashMap<String, String>,
    addrs: HashMap<String, Vec<IpAddr>>,
    dns: Option<Vec<Dns>>,
    mesh: bool,
    v6: bool,
    os: &'static str,
    ready: bool,
    tun: bool,
}

impl Probe for Fake {
    fn route(&self, ip: &str) -> Option<String> {
        self.routes.get(ip).cloned()
    }
    fn dns(&self) -> Option<Vec<Dns>> {
        self.dns.clone()
    }
    fn addrs(&self, iface: &str) -> Vec<IpAddr> {
        self.addrs.get(iface).cloned().unwrap_or_default()
    }
    fn is_tunnel(&self, iface: &str) -> bool {
        tunnel_name(self.os, iface, self.tun)
    }
    fn mesh_service(&self, iface: &str) -> bool {
        self.mesh || (self.os == "linux" && linux_mesh_name(iface))
    }
    fn ready(&self) -> bool {
        self.ready
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
        dns: Some(vec![Dns::routed("10.2.0.1")]),
        mesh: false,
        v6: false,
        os: "macos",
        ready: true,
        tun: false,
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
    lan.dns = Some(vec![Dns::routed("10.2.0.1"), Dns::routed("192.168.1.1")]);
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
    // resolved sends a link's servers out of that link: an ISP server bound to eth0 leaks even
    // though its route says utun4.
    let mut bound = vpn().route("75.75.75.75", "utun4");
    let isp = Dns {
        server: "75.75.75.75".into(),
        link: Some("eth0".into()),
    };
    bound.dns = Some(vec![Dns::routed("10.2.0.1"), isp]);
    assert_eq!(
        fails(&bound),
        Some(Fail::Dns),
        "a server bound to the LAN link"
    );
    let mut tunnel = vpn();
    let own = Dns {
        server: "192.168.1.1".into(),
        link: Some("utun4".into()),
    };
    tunnel.dns = Some(vec![own]);
    assert!(decide(&tunnel).ok, "a server bound to the tunnel");
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
fn parses_linux_route_and_dns_output() {
    let get = "1.1.1.1 dev wg0 table 51820 src 10.66.0.2 uid 1000 \n    cache \n";
    assert_eq!(parse_route_linux(get).as_deref(), Some("wg0"));
    assert_eq!(parse_route_linux(""), None);
    let conf = "# generated\nnameserver 127.0.0.53\noptions edns0\nsearch lan\n";
    assert_eq!(parse_resolv_conf(conf), ["127.0.0.53"]);
    let stub = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let wg = || {
        Some(vec![Dns {
            server: "10.64.0.1".into(),
            link: Some("wg0".into()),
        }])
    };
    let mut got = linux_dns(stub(&["127.0.0.53"]), wg).unwrap();
    assert_eq!(got, wg().unwrap());
    got = linux_dns(stub(&["127.0.0.54", "9.9.9.9"]), wg).unwrap();
    assert_eq!(got, [Dns::routed("9.9.9.9"), wg().unwrap().remove(0)]);
    assert_eq!(
        linux_dns(stub(&["127.0.0.53"]), || None),
        None,
        "resolvectl missing"
    );
    let never = || -> Option<Vec<Dns>> { panic!("not resolved's stub") };
    assert_eq!(
        linux_dns(stub(&["127.0.0.1"]), never),
        None,
        "dnsmasq on 127.0.0.1"
    );
    assert_eq!(
        linux_dns(stub(&["127.0.1.1"]), never),
        None,
        "NetworkManager's dnsmasq"
    );
    assert_eq!(
        linux_dns(stub(&["10.64.0.1"]), never).unwrap(),
        [Dns::routed("10.64.0.1")]
    );
}

// `resolvectl dns`, `domain` and `default-route` with wg-quick up (it sets `~.` on wg0) and the
// ISP's server on eth0 from DHCP.
const RESOLVED_DNS: &str = "Global: 1.1.1.1#cloudflare-dns.com\nLink 2 (eth0): 75.75.75.75\nLink 3 (wg0): 10.64.0.1\nLink 4 (docker0):\n";
const RESOLVED_DOMAINS: &str = "Global:\nLink 2 (eth0): lan\nLink 3 (wg0): ~.\nLink 4 (docker0):\n";
const RESOLVED_ROUTES: &str = "Link 2 (eth0): yes\nLink 3 (wg0): yes\nLink 4 (docker0): no\n";

// Parish1 (Ubuntu, Tailscale, DNS over TLS to Cloudflare), cut short, with `~.` added on a
// wrapped line: values wrap onto indented lines.
const RESOLVED_WRAPPED: &str = "Global: 1.1.1.1#cloudflare-dns.com 1.0.0.1#cloudflare-dns.com\n        2606:4700:4700::1111#cloudflare-dns.com\nLink 3 (wlp0s20f3):\nLink 4 (tailscale0): 100.100.100.100 fd7a:115c:a1e0::53\nLink 2 (enp118s0):\n";
const RESOLVED_WRAPPED_DOMAINS: &str = "Global:\nLink 4 (tailscale0): tail2b1ef8.ts.net ~0.e.1.a.c.5.1.1.a.7.d.f.ip6.arpa\n        ~100.100.in-addr.arpa ~.\nLink 2 (enp118s0):\n";

#[test]
fn reads_systemd_resolved_links() {
    let link = |s: &str, l: &str| Dns {
        server: s.into(),
        link: Some(l.into()),
    };
    let catch_all = parse_resolved(RESOLVED_DNS, RESOLVED_DOMAINS, RESOLVED_ROUTES);
    assert_eq!(
        catch_all,
        [Dns::routed("1.1.1.1"), link("10.64.0.1", "wg0")]
    );
    // No `~.` anywhere: every DefaultRoute link answers, so eth0's server counts and leaks.
    let no_catch_all = RESOLVED_DOMAINS.replace("~.", "");
    let open = parse_resolved(RESOLVED_DNS, &no_catch_all, RESOLVED_ROUTES);
    let eth0 = link("75.75.75.75", "eth0");
    assert_eq!(
        open,
        [
            Dns::routed("1.1.1.1"),
            eth0.clone(),
            link("10.64.0.1", "wg0")
        ]
    );
    let off = RESOLVED_ROUTES.replace("(eth0): yes", "(eth0): no");
    let only_wg = parse_resolved(RESOLVED_DNS, &no_catch_all, &off);
    assert!(!only_wg.contains(&eth0), "DefaultRoute off on eth0");
    assert!(
        parse_resolved(RESOLVED_DNS, &no_catch_all, "").contains(&eth0),
        "unknown means on"
    );
    let wrapped = parse_resolved(RESOLVED_WRAPPED, RESOLVED_WRAPPED_DOMAINS, "");
    let ts = link("100.100.100.100", "tailscale0");
    let v6 = Dns::routed("2606:4700:4700::1111");
    assert_eq!(
        wrapped[2..],
        [v6, ts, link("fd7a:115c:a1e0::53", "tailscale0")]
    );
}

#[test]
fn a_linux_full_tunnel_passes_and_meshes_fail() {
    let mut wg = vpn();
    wg.os = "linux";
    for to in ["1.1.1.1", "198.51.100.1", "203.0.113.1"] {
        wg = wg.route(to, "wg0");
    }
    let wg = wg.addr("wg0", "10.66.0.2");
    let mut ok = wg.clone();
    ok.dns = Some(vec![Dns {
        server: "10.64.0.1".into(),
        link: Some("wg0".into()),
    }]);
    assert!(decide(&ok).ok, "{:?}", decide(&ok));
    let mut eth = ok.clone().route("1.1.1.1", "eth0");
    eth.addrs.insert("eth0".into(), vec![ip("192.168.1.5")]);
    assert_eq!(fails(&eth), Some(Fail::NoVpn));
    for mesh in ["tailscale0", "zt5u4y6bc4", "nebula1", "wt0"] {
        let mut m = ok.clone();
        for to in ["1.1.1.1", "198.51.100.1", "203.0.113.1"] {
            m = m.route(to, mesh);
        }
        let mut m = m.addr(mesh, "10.147.17.5");
        m.dns = Some(vec![Dns {
            server: "10.64.0.1".into(),
            link: Some(mesh.into()),
        }]);
        m.tun = true; // mesh clients' devices are TUN devices
        assert_eq!(fails(&m), Some(Fail::Mesh), "{mesh}");
    }
    let mut no_ip = ok;
    no_ip.ready = false;
    assert_eq!(fails(&no_ip), Some(Fail::Unchecked), "iproute2 missing");
}

#[test]
fn linux_tunnels_in_state_unknown_are_up() {
    // Parish1's tailscale0, a TUN device: operstate "unknown", flags UP|POINTOPOINT|NOARP|MULTICAST.
    assert!(link_up("unknown\n", "0x1091\n"));
    assert!(link_up("up", "0x1003"));
    assert!(!link_up("down", "0x1002"), "no carrier");
    assert!(!link_up("unknown", "0x1090"), "set down by the admin");
    assert!(!link_up("dormant", "0x1003") && !link_up("", ""));
}

#[test]
fn names_tunnels_per_os() {
    assert!(tunnel_name("macos", "utun4", false) && tunnel_name("macos", "ipsec0", false));
    assert!(!tunnel_name("macos", "en0", false) && !tunnel_name("macos", "utun", false));
    assert!(!tunnel_name("macos", "utunx", false) && !tunnel_name("linux", "tunx", false));
    assert!(tunnel_name("linux", "wg0-mullvad", false) && tunnel_name("linux", "tun0", false));
    assert!(
        tunnel_name("linux", "proton0", true),
        "a WireGuard device by type"
    );
    assert!(!tunnel_name("linux", "eth0", false) && !tunnel_name("linux", "tunl0", false));
    assert!(
        tunnel_name("linux", "tailscale0", true),
        "a TUN device; the mesh check refuses it"
    );
    assert!(
        !tunnel_name("windows", "Wintun", true),
        "Windows has no detection yet"
    );
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
