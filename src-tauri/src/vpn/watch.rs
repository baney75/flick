// Rule 26, when the gate runs: the route checks before a torrent starts and every 2 seconds while
// one plays; the exit check at first use, after any route change and every 5 minutes. A failure
// while anything plays stops every player through the change event.

use super::{exit_check, route_check, Fail, GateState, Probe, System};
use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Sent to the web view with the new GateState whenever the gate's answer changes.
pub const EVENT: &str = "vpn-gate";
const EXIT_EVERY: Duration = Duration::from_secs(300);
const ROUND: Duration = Duration::from_secs(2);

/// The exit check's last pass and the route it passed on.
struct Exit {
    route: String,
    at: Instant,
    ip: IpAddr,
}

/// When the exit check reruns; the clock is a parameter so tests can move it.
#[derive(Default)]
pub struct Schedule {
    exit: Option<Exit>,
}

impl Schedule {
    /// The gate at `now`. `force` reruns the exit check ("Check again").
    pub fn tick(&mut self, p: &dyn Probe, now: Instant, force: bool) -> GateState {
        let iface = match route_check(p) {
            Ok(i) => i,
            Err(f) => return self.fail(f),
        };
        // The tunnel and its addresses: a reconnect to another server changes them.
        let route = format!("{iface} {:?}", p.addrs(&iface));
        let fresh = self
            .exit
            .as_ref()
            .filter(|e| !force && e.route == route && now.duration_since(e.at) < EXIT_EVERY);
        let ip = match fresh {
            Some(e) => e.ip,
            None => match exit_check(p) {
                Ok(ip) => {
                    self.exit = Some(Exit { route, at: now, ip });
                    ip
                }
                Err(f) => return self.fail(f),
            },
        };
        GateState::pass(iface, ip)
    }

    fn fail(&mut self, f: Fail) -> GateState {
        self.exit = None;
        GateState::fail(f)
    }
}

type Hook = Box<dyn Fn(&GateState) + Send + Sync>;

/// The gate for the whole app: its last answer, who is playing through it, and who to tell.
pub struct Watch {
    probe: Box<dyn Probe + Send + Sync>,
    supported: bool,
    state: Mutex<(Schedule, Option<GateState>)>,
    holders: Mutex<HashSet<String>>,
    on_change: Hook,
}

impl Watch {
    /// `supported` is false where the gate has no detection (Windows): it then never passes.
    pub fn new(probe: Box<dyn Probe + Send + Sync>, supported: bool, on_change: Hook) -> Self {
        let (state, holders) = (Mutex::default(), Mutex::default());
        Watch {
            probe,
            supported,
            state,
            holders,
            on_change,
        }
    }

    /// The gate now. Tells `on_change` when the answer differs from the last one.
    pub fn now(&self, force: bool) -> GateState {
        let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let s = if self.supported {
            g.0.tick(&*self.probe, Instant::now(), force)
        } else {
            GateState::fail(Fail::Unchecked)
        };
        let changed = g.1.as_ref() != Some(&s);
        g.1 = Some(s.clone());
        drop(g);
        if changed {
            (self.on_change)(&s);
        }
        s
    }

    /// A stream may start: the gate passes now, and `id` is watched until released.
    pub fn hold(&self, id: &str) -> GateState {
        let s = self.now(false);
        if s.ok {
            self.holders().insert(id.to_string());
        }
        s
    }

    pub fn release(&self, id: &str) {
        self.holders().remove(id);
    }

    fn holders(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.holders.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// One round: while anything plays, recheck. A failure reaches every player through
    /// `on_change`, and nothing stays held, so the next stream must pass the gate again.
    pub fn round(&self) {
        if self.holders().is_empty() {
            return;
        }
        if !self.now(false).ok {
            self.holders().clear();
        }
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
