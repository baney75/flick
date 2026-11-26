use flick_server::access_code;

#[test]
fn racing_first_runs_agree_on_one_token() {
    for round in 0..20 {
        let dir =
            std::env::temp_dir().join(format!("flick-token-race-{}-{round}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let gate = std::sync::Arc::new(std::sync::Barrier::new(16));
        let runs: Vec<_> = (0..16)
            .map(|_| {
                let (dir, gate) = (dir.clone(), gate.clone());
                std::thread::spawn(move || {
                    gate.wait();
                    access_code(&dir, false)
                })
            })
            .collect();
        let codes: Vec<String> = runs
            .into_iter()
            .map(|r| r.join().unwrap().unwrap())
            .collect();
        let saved = std::fs::read_to_string(dir.join("token")).unwrap();
        assert!(
            codes.iter().all(|c| *c == saved.trim()),
            "round {round}: {codes:?} vs {saved}"
        );
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left.len(), 1, "temp files left: {left:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn renew_replaces_and_plain_keeps() {
    let dir = std::env::temp_dir().join(format!("flick-token-renew-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let a = access_code(&dir, false).unwrap();
    assert_eq!(access_code(&dir, false).unwrap(), a);
    let b = access_code(&dir, true).unwrap();
    assert_ne!(a, b);
    assert_eq!(access_code(&dir, false).unwrap(), b);
    let _ = std::fs::remove_dir_all(&dir);
}
