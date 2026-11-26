// Rule 26, when the gate runs: the route checks before a torrent starts and every 2 seconds while
// one plays; the exit check at first use, after any route change and every 5 minutes. A failure
// while anything plays stops every player through the change event.
//
// The 2-second rounds never wait on an exit check (two HTTPS requests): a due recheck runs on its
// own thread while the rounds keep checking routes, and the last pass stands until it answers.

use super::{exit_check, route_check, Fail, GateState, Probe, System};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Sent to the web view with the new GateState whenever the gate's answer changes.
pub const EVENT: &str = "vpn-gate";
const EXIT_EVERY: Duration = Duration::from_secs(300);
const ROUND: Duration = Duration::from_secs(2);
/// A recheck that fails without a verdict (offline, no usable answer) tries once more after this.
const RETRY: Duration = Duration::from_secs(1);

/// The exit check's last pass and the route it passed on.
struct Exit {
    iface: String,
    route: String,
    at: Instant,
    ip: IpAddr,
}

/// What the cached exit check allows on the current route.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// It passed on this route less than 5 minutes ago.
    Pass(IpAddr),
    /// It passed on this tunnel, but it is due (5 minutes, or the tunnel's addresses changed).
    Due(IpAddr),
    /// No pass on this tunnel: it must run before anything plays.
    Check,
}

/// The exit check's cache; the clock is a parameter so tests can move it.
#[derive(Default)]
pub struct Schedule {
    exit: Option<Exit>,
}

/// The tunnel and its addresses: a reconnect to another server usually changes them.
fn route_key(p: &dyn Probe, iface: &str) -> String {
    format!("{iface} {:?}", p.addrs(iface))
}

impl Schedule {
    pub fn plan(&self, iface: &str, route: &str, now: Instant, force: bool) -> Plan {
        match &self.exit {
            Some(e) if e.iface == iface && !force => {
                let fresh = e.route == route && now.duration_since(e.at) < EXIT_EVERY;
                if fresh {
                    Plan::Pass(e.ip)
                } else {
                    Plan::Due(e.ip)
                }
            }
            _ => Plan::Check,
        }
    }

    fn store(&mut self, iface: String, route: String, now: Instant, ip: IpAddr) {
        self.exit = Some(Exit {
            iface,
            route,
            at: now,
            ip,
        });
    }

    /// The gate at `now`, running the exit check inline when the plan asks (tests drive the clock
    /// through it). `force` reruns the
    /// exit check ("Check again").
    #[cfg(test)]
    pub fn tick(&mut self, p: &dyn Probe, now: Instant, force: bool) -> GateState {
        let iface = match route_check(p) {
            Ok(i) => i,
            Err(f) => return self.fail(f),
        };
        let route = route_key(p, &iface);
        if let Plan::Pass(ip) = self.plan(&iface, &route, now, force) {
            return GateState::pass(iface, ip);
        }
        match exit_check(p) {
            Ok(ip) => {
                self.store(iface.clone(), route, now, ip);
                GateState::pass(iface, ip)
            }
            Err(f) => self.fail(f),
        }
    }

    fn fail(&mut self, f: Fail) -> GateState {
        self.exit = None;
        GateState::fail(f)
    }
}

/// A recheck failure that says nothing about the VPN: the request didn't get through.
fn transient(f: Fail) -> bool {
    matches!(f, Fail::Offline | Fail::Unchecked)
}

type Hook = Box<dyn Fn(&GateState) + Send + Sync>;

/// The gate's answers so far: the cache, the last answer and how many failures there have been.
#[derive(Default)]
struct State {
    sched: Schedule,
    last: Option<GateState>,
    fails: u64,
    rechecking: bool,
}

/// The gate for the whole app: its last answer, who is playing through it, and who to tell.
pub struct Watch {
    probe: Box<dyn Probe + Send + Sync>,
    supported: bool,
    state: Mutex<State>,
    /// One exit check at a time.
    exiting: Mutex<()>,
    /// Who plays through the gate, with the failure count when they passed.
    holders: Mutex<HashMap<String, u64>>,
    hooks: Mutex<Vec<Hook>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Watch {
    /// `supported` is false where the gate has no detection (Windows): it then never passes.
    pub fn new(probe: Box<dyn Probe + Send + Sync>, supported: bool, on_change: Hook) -> Self {
        Watch {
            probe,
            supported,
            state: Mutex::default(),
            exiting: Mutex::default(),
            holders: Mutex::default(),
            hooks: Mutex::new(vec![on_change]),
        }
    }

    /// Records an answer and tells every hook when it differs from the last one. Returns the
    /// answer and the failure count after it. Hooks run under the state lock, so they hear the
    /// answers in order; they must not call back into the gate.
    fn publish(&self, r: Result<(String, IpAddr), Fail>) -> (GateState, u64) {
        self.record(&mut lock(&self.state), r)
    }

    fn record(&self, g: &mut State, r: Result<(String, IpAddr), Fail>) -> (GateState, u64) {
        let s = match r {
            Ok((iface, ip)) => GateState::pass(iface, ip),
            Err(f) => {
                g.fails += 1;
                g.sched.fail(f)
            }
        };
        if g.last.as_ref() != Some(&s) {
            g.last = Some(s.clone());
            for hook in lock(&self.hooks).iter() {
                hook(&s);
            }
        }
        (s, g.fails)
    }

    fn route(&self) -> Result<(String, String), Fail> {
        if !self.supported {
            return Err(Fail::Unchecked);
        }
        let iface = route_check(&*self.probe)?;
        let route = route_key(&*self.probe, &iface);
        Ok((iface, route))
    }

    /// The full gate: route checks, then the exit check when due, run outside the state lock so
    /// rounds go on meanwhile. `patient` retries once a failure without a verdict.
    fn check(&self, force: bool, patient: bool) -> (GateState, u64) {
        let (iface, route) = match self.route() {
            Ok(r) => r,
            Err(f) => return self.publish(Err(f)),
        };
        let plan = || {
            lock(&self.state)
                .sched
                .plan(&iface, &route, Instant::now(), force)
        };
        if let Plan::Pass(ip) = plan() {
            return self.publish(Ok((iface, ip)));
        }
        let _one = lock(&self.exiting);
        let before = lock(&self.state).fails;
        // Another caller may have just run it.
        if let (false, Plan::Pass(ip)) = (force, plan()) {
            return self.publish(Ok((iface, ip)));
        }
        let mut r = exit_check(&*self.probe);
        if let (true, Err(f)) = (patient, r) {
            if transient(f) {
                std::thread::sleep(RETRY);
                r = exit_check(&*self.probe);
            }
        }
        let ip = match r {
            Ok(ip) => ip,
            Err(f) => return self.publish(Err(f)),
        };
        // The route may have changed during the exit check: pass only on the one it checked.
        match self.route() {
            Ok((i, r)) if i == iface && r == route => {}
            Ok(_) => return self.publish(Err(Fail::Unchecked)),
            Err(f) => return self.publish(Err(f)),
        }
        let mut g = lock(&self.state);
        // A failure while the exit check ran (a dropped VPN that came back) stands.
        if g.fails != before {
            let last = g
                .last
                .clone()
                .unwrap_or_else(|| GateState::fail(Fail::Unchecked));
            return (last, g.fails);
        }
        g.sched.store(iface.clone(), route, Instant::now(), ip);
        self.record(&mut g, Ok((iface, ip)))
    }

    /// The gate now. `force` reruns the exit check ("Check again").
    pub fn now(&self, force: bool) -> GateState {
        self.check(force, false).0
    }

    /// A stream may start: the gate passes now, and `id` is watched until released.
    pub fn hold(&self, id: &str) -> GateState {
        let (s, fails) = self.check(false, false);
        if s.ok {
            lock(&self.holders).insert(id.to_string(), fails);
        }
        s
    }

    pub fn release(&self, id: &str) {
        lock(&self.holders).remove(id);
    }

    /// Every hold that passed before failure number `fails` ends.
    pub(super) fn drop_holds(&self, fails: u64) {
        lock(&self.holders).retain(|_, at| *at >= fails);
    }

    #[cfg(test)]
    pub(super) fn held(&self) -> Vec<String> {
        lock(&self.holders).keys().cloned().collect()
    }

    /// One round while anything plays: the route checks only. A due exit check runs on its own
    /// thread and the last pass stands until it answers; a new tunnel fails until checked. A
    /// failure reaches every player through the hooks and ends every hold that passed before it.
    pub fn round(self: &Arc<Self>) {
        if lock(&self.holders).is_empty() {
            return;
        }
        let (s, fails) = match self.route() {
            Err(f) => self.publish(Err(f)),
            Ok((iface, route)) => {
                let plan = lock(&self.state)
                    .sched
                    .plan(&iface, &route, Instant::now(), false);
                match plan {
                    Plan::Pass(ip) => self.publish(Ok((iface, ip))),
                    Plan::Due(ip) => {
                        self.recheck();
                        self.publish(Ok((iface, ip)))
                    }
                    Plan::Check => {
                        let failed = self.publish(Err(Fail::Unchecked));
                        self.recheck();
                        failed
                    }
                }
            }
        };
        if !s.ok {
            self.drop_holds(fails);
        }
    }

    /// Runs the exit check on its own thread, unless one is already running.
    fn recheck(self: &Arc<Self>) {
        let mut g = lock(&self.state);
        if g.rechecking {
            return;
        }
        g.rechecking = true;
        drop(g);
        let w = Arc::clone(self);
        std::thread::spawn(move || {
            let (s, fails) = w.check(false, true);
            lock(&w.state).rechecking = false;
            if !s.ok {
                w.drop_holds(fails);
            }
        });
    }

    /// Runs a round every `every` for the life of the app.
    pub fn spawn(self: &Arc<Self>, every: Duration) {
        let w = Arc::clone(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(every);
            w.round();
        });
    }
}

static WATCH: OnceLock<Arc<Watch>> = OnceLock::new();

/// Starts the app's gate: the real system, rounds every 2 seconds, changes sent as `EVENT`.
pub fn install(app: tauri::AppHandle) {
    let supported = cfg!(any(target_os = "macos", target_os = "linux"));
    let emit = Box::new(move |s: &GateState| {
        if let Err(e) = app.emit(EVENT, s) {
            eprintln!("vpn gate: {e}");
        }
    });
    let w = Arc::new(Watch::new(Box::new(System), supported, emit));
    if WATCH.set(Arc::clone(&w)).is_ok() {
        w.spawn(ROUND);
    }
}

/// The app's gate, for the torrent engine and the debrid player.
pub fn get() -> Result<&'static Arc<Watch>, String> {
    WATCH
        .get()
        .ok_or_else(|| "The VPN check hasn't started yet.".to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

/// The gate now: it passes, or says what failed. `force` reruns the exit check.
#[tauri::command]
pub async fn vpn_gate(force: Option<bool>) -> Result<GateState, String> {
    let w = get()?;
    blocking(move || w.now(force.unwrap_or(false))).await
}

/// Before a gated stream plays in the web view (a debrid URL): passes and watches `id`, or fails.
#[tauri::command]
pub async fn vpn_gate_hold(id: String) -> Result<GateState, String> {
    let w = get()?;
    blocking(move || w.hold(&id)).await
}

/// The gated stream stopped.
#[tauri::command]
pub fn vpn_gate_release(id: String) -> Result<(), String> {
    get()?.release(&id);
    Ok(())
}
