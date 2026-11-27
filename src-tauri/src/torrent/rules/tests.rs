// The engine's checks (rules 2, 4, 6, 15 and 16) on crafted input.

use super::{Vetted, Want};
use crate::torrent::rules;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const HASH: &str = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c";

pub fn want(hash: &str, trackers: &[&str]) -> Want {
    let trackers = trackers.iter().map(|t| t.to_string()).collect();
    Want {
        info_hash: hash.to_string(),
        file_idx: None,
        trackers,
    }
}

#[test]
fn a_stream_asks_for_a_40_hex_hash_and_web_trackers_only() {
    let upper = HASH.to_ascii_uppercase();
    let ok = rules::check_want(&want(
        &upper,
        &["udp://t.example:80", "https://t.example/a"],
    ));
    let (hash, trackers) = ok.unwrap();
    assert_eq!(hash, HASH);
    assert_eq!(trackers, ["udp://t.example:80", "https://t.example/a"]);

    let field = |r: Result<(String, Vec<String>), String>| r.unwrap_err();
    assert!(field(rules::check_want(&want(&HASH[..39], &[]))).contains("torrent.infoHash"));
    let not_hex = format!("{}g", &HASH[..39]);
    assert!(field(rules::check_want(&want(&not_hex, &[]))).contains("torrent.infoHash"));
    for bad in [
        "file:///etc/passwd",
        "udp://",
        "ws://t.example",
        "udp://t.example/a b",
        "udp://t.example/\u{e9}",
        "http:t.example",
        "magnet:?xt=urn:btih:x",
    ] {
        let e = field(rules::check_want(&want(HASH, &[bad])));
        assert!(e.contains("udp, http and https"), "{bad}: {e}");
    }
    for inside in [
        "http://127.0.0.1:11470/settings",
        "http://127.1/announce",
        "http://localhost:6969/announce",
        "http://LOCALHOST/announce",
        "http://nas.local/announce",
        "http://[::1]/announce",
        "http://[::ffff:192.168.1.1]/announce",
        "udp://192.168.1.1:80",
        "udp://10.0.0.2:53",
        "https://172.16.0.1/announce",
        "udp://169.254.169.254:80",
        "udp://100.100.100.100:80",
        "http://0.0.0.0/announce",
        "http://[fd7a:115c:a1e0::1]/announce",
        "udp://127.1:11470",
        "udp://2130706433:53",
        "udp://0x7f.1:80",
        "udp://0177.0.0.1:80",
        "udp://192.168.1:53",
        "udp://127.0.0.1.:80",
        "udp://[::1]:80",
        "udp://user@10.0.0.2:80",
        "udp://localhost.:80",
        "http://localhost./announce",
        "udp://nas.local.:6969",
    ] {
        let e = field(rules::check_want(&want(HASH, &[inside])));
        assert!(e.contains("inside this network"), "{inside}: {e}");
    }
    let public = [
        "udp://1.2.3.4:80",
        "udp://tracker.example:1337/announce",
        "udp://[2606:4700::1]:80",
    ];
    assert!(rules::check_want(&want(HASH, &public)).is_ok());
    let fits = format!("https://t.example/{}", "a".repeat(2048 - 18));
    assert!(rules::check_want(&want(HASH, &[&fits])).is_ok());
    let long = format!("https://t.example/{}", "a".repeat(2048));
    let e = field(rules::check_want(&want(HASH, &[&long])));
    assert!(e.contains("at most 2048 bytes"), "{e}");
    let many: Vec<String> = (0..51).map(|i| format!("udp://t{i}.example:80")).collect();
    let many: Vec<&str> = many.iter().map(String::as_str).collect();
    assert!(field(rules::check_want(&want(HASH, &many))).contains("at most 50"));
    assert!(rules::check_want(&want(HASH, &many[..50])).is_ok());
}

#[test]
fn a_stream_arrives_as_the_plugin_contract_names_it() {
    let w: Want = serde_json::from_str(&format!(r#"{{"infoHash":"{HASH}","fileIdx":2}}"#)).unwrap();
    assert_eq!((w.info_hash.as_str(), w.file_idx), (HASH, Some(2)));
    assert!(w.trackers.is_empty());
    let w: Want = serde_json::from_str(&format!(
        r#"{{"infoHash":"{HASH}","trackers":["udp://t:1"]}}"#
    ))
    .unwrap();
    assert_eq!(
        (w.file_idx, w.trackers),
        (None, vec!["udp://t:1".to_string()])
    );
    assert!(serde_json::from_str::<Want>(r#"{"fileIdx":2}"#).is_err());
    assert!(
        serde_json::from_str::<Want>(&format!(r#"{{"infoHash":"{HASH}","fileIdx":-1}}"#)).is_err()
    );
}

#[test]
fn the_magnet_carries_only_the_stream_trackers_percent_encoded() {
    let m = rules::magnet(HASH, &["udp://t.example:80/a?b=c&d".to_string()]);
    let tr = "udp%3A%2F%2Ft%2Eexample%3A80%2Fa%3Fb%3Dc%26d";
    assert_eq!(m, format!("magnet:?xt=urn:btih:{HASH}&tr={tr}"));
    assert_eq!(
        rules::magnet(HASH, &[]),
        format!("magnet:?xt=urn:btih:{HASH}")
    );
}

// A bencoded .torrent: `files` as (path parts, length, attr), or one file named `name`.
fn ben(b: &[u8]) -> Vec<u8> {
    let mut v = format!("{}:", b.len()).into_bytes();
    v.extend_from_slice(b);
    v
}

fn int(n: u64) -> Vec<u8> {
    format!("i{n}e").into_bytes()
}

struct Entry<'a> {
    path: Vec<&'a [u8]>,
    len: u64,
    attr: Option<&'a [u8]>,
}

fn entry(path: &[&'static str], len: u64) -> Entry<'static> {
    let path = path.iter().map(|p| p.as_bytes()).collect();
    Entry {
        path,
        len,
        attr: None,
    }
}

fn torrent(name: &[u8], files: &[Entry], piece: u64) -> Vec<u8> {
    let total: u64 = files.iter().map(|f| f.len).sum();
    let pieces = total.div_ceil(piece).max(1) as usize;
    let mut info = b"d".to_vec();
    if let [one] = files {
        if one.path.is_empty() {
            info.extend(ben(b"length"));
            info.extend(int(one.len));
        }
    }
    if files.len() != 1 || !files[0].path.is_empty() {
        info.extend(ben(b"files"));
        info.push(b'l');
        for f in files {
            info.push(b'd');
            if let Some(a) = f.attr {
                info.extend(ben(b"attr"));
                info.extend(ben(a));
            }
            info.extend(ben(b"length"));
            info.extend(int(f.len));
            info.extend(ben(b"path"));
            info.push(b'l');
            for p in &f.path {
                info.extend(ben(p));
            }
            info.push(b'e');
            if f.attr == Some(b"l") {
                info.extend(ben(b"symlink path"));
                info.extend(b"l6:targete");
            }
            info.push(b'e');
        }
        info.push(b'e');
    }
    info.extend(ben(b"name"));
    info.extend(ben(name));
    info.extend(ben(b"piece length"));
    info.extend(int(piece));
    info.extend(ben(b"pieces"));
    info.extend(ben(&vec![7u8; pieces * 20]));
    info.push(b'e');
    let mut t = b"d".to_vec();
    t.extend(ben(b"info"));
    t.extend(info);
    t.push(b'e');
    t
}

pub const PIECE: u64 = 1 << 16;

#[test]
fn a_torrent_lists_its_files_by_last_name_with_padding_unnamed() {
    let mut pad = entry(&[".pad", "1"], 50);
    pad.attr = Some(b"p");
    let files = [
        entry(&["extras", "sample.mkv"], 100),
        pad,
        entry(&["movie.mp4"], 5000),
        entry(&["readme.txt"], 10),
    ];
    let v = rules::vet(&torrent(b"Movie", &files, PIECE)).unwrap();
    let names: Vec<(&str, u64)> = v.files.iter().map(|(n, l)| (n.as_str(), *l)).collect();
    assert_eq!(
        names,
        [
            ("sample.mkv", 100),
            ("", 50),
            ("movie.mp4", 5000),
            ("readme.txt", 10)
        ]
    );
    let one = rules::vet(&torrent(b"movie.mp4", &[entry(&[], 3000)], PIECE)).unwrap();
    assert_eq!(
        one,
        Vetted {
            files: vec![("movie.mp4".into(), 3000)]
        }
    );
}

#[test]
fn a_file_name_that_would_leave_the_cache_is_refused() {
    let long = "a".repeat(256);
    let long: &'static str = Box::leak(long.into_boxed_str());
    let cases: [(&[u8], &[&'static str]); 8] = [
        (b"Movie", &["..", "..", "evil.mp4"]),
        (b"Movie", &["../../evil.mp4"]),
        (b"Movie", &["/etc", "x"]),
        (b"Movie", &["a\\..\\evil.mp4"]),
        (b"Movie", &["C:", "evil.mp4"]),
        (b"Movie", &["evil\0.mp4"]),
        (b"Movie", &[long]),
        (b"Movie", &[".", "evil.mp4"]),
    ];
    for (name, path) in cases {
        let t = torrent(name, &[entry(path, 10), entry(&["ok.mp4"], 10)], PIECE);
        assert!(rules::vet(&t).is_err(), "{path:?} passed");
    }
    for name in [&b"/etc/x"[..], b"..", b"C:", b"a\0b"] {
        let t = torrent(name, &[entry(&[], 10)], PIECE);
        assert!(rules::vet(&t).is_err(), "name {name:?} passed");
    }
    // A name librqbit itself accepts still meets Flick's own check.
    let t = torrent(b"Movie", &[entry(&["C:evil.mp4"], 10)], PIECE);
    let e = rules::vet(&t).unwrap_err();
    assert!(e.contains("won't write"), "{e}");
    let t = torrent(b"Movie", &[entry(&[long], 10)], PIECE);
    assert!(rules::vet(&t).unwrap_err().contains("won't write"));
    let fits: &'static str = Box::leak("a".repeat(255).into_boxed_str());
    assert!(rules::vet(&torrent(b"Movie", &[entry(&[fits], 10)], PIECE)).is_ok());
}

#[test]
fn a_torrent_with_a_symlink_is_refused() {
    let mut link = entry(&["movie.mp4"], 0);
    link.attr = Some(b"l");
    let t = torrent(b"Movie", &[link, entry(&["b.mp4"], 10)], PIECE);
    assert!(rules::vet(&t).unwrap_err().contains("link to another file"));
}

#[test]
fn a_torrent_over_the_size_limits_is_refused() {
    let big = vec![b'd'; rules::MAX_INFO + 1];
    assert!(rules::vet(&big).unwrap_err().contains("over 10 MB"));

    let names: Vec<String> = (0..=rules::MAX_FILES)
        .map(|i| format!("f{i}.mp4"))
        .collect();
    let names: Vec<&'static str> = names
        .into_iter()
        .map(|n| &*Box::leak(n.into_boxed_str()))
        .collect();
    let files: Vec<Entry> = names.iter().map(|n| entry(&[n], 1)).collect();
    let e = rules::vet(&torrent(b"Many", &files, PIECE)).unwrap_err();
    assert!(e.contains("10,000 files"), "{e}");
    let at_cap = rules::vet(&torrent(b"Many", &files[..rules::MAX_FILES], PIECE));
    assert_eq!(at_cap.unwrap().files.len(), rules::MAX_FILES);

    let huge = u64::from(rules::MAX_PIECE) * 2;
    let e = rules::vet(&torrent(b"movie.mp4", &[entry(&[], 1)], huge)).unwrap_err();
    assert!(e.contains("over 16 MB"), "{e}");
    let max = u64::from(rules::MAX_PIECE);
    assert!(rules::vet(&torrent(b"movie.mp4", &[entry(&[], 1)], max)).is_ok());
}

#[test]
fn the_chosen_file_must_be_media_and_otherwise_the_largest_video_plays() {
    let named = |files: &[(&str, u64)]| Vetted {
        files: files.iter().map(|(n, l)| (n.to_string(), *l)).collect(),
    };
    let v = named(&[
        ("a.mkv", 100),
        ("", 9000),
        ("b.mp4", 5000),
        ("song.mp3", 8000),
        ("x.txt", 9),
    ]);
    assert_eq!(rules::pick_file(&v, None), Ok(2));
    assert_eq!(rules::pick_file(&v, Some(0)), Ok(0));
    assert_eq!(rules::pick_file(&v, Some(3)), Ok(3));
    assert!(rules::pick_file(&v, Some(4))
        .unwrap_err()
        .contains("isn't a video"));
    assert!(rules::pick_file(&v, Some(1)).is_err());
    assert!(rules::pick_file(&v, Some(5))
        .unwrap_err()
        .contains("no file 5"));
    let none = named(&[("song.mp3", 8000), ("x.txt", 9)]);
    assert!(rules::pick_file(&none, None)
        .unwrap_err()
        .contains("no video"));
}

pub fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("flick-torrent-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn aged(dir: &Path, secs_ago: u64) {
    let when = SystemTime::now() - Duration::from_secs(secs_ago);
    std::fs::File::open(dir)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

/// A torrent folder holding `kb` KiB of written data.
fn folder(cache: &Path, name: &str, kb: usize, secs_ago: u64) -> PathBuf {
    let d = cache.join(name);
    std::fs::create_dir_all(d.join("sub")).unwrap();
    // Incompressible bytes, so the blocks on disk match the length on compressing filesystems.
    let mut x: u32 = 0x9e37_79b9 ^ name.len() as u32;
    let data: Vec<u8> = (0..kb << 10)
        .map(|_| {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (x >> 24) as u8
        })
        .collect();
    std::fs::write(d.join("sub/part"), data).unwrap();
    aged(&d, secs_ago);
    d
}

const K64: u64 = 64 << 10;

#[test]
fn the_cache_trims_the_oldest_torrents_first_and_only_torrent_folders() {
    let cache = tmp("trim");
    let hex = |c: char| c.to_string().repeat(40);
    let (old, mid, new) = (hex('a'), hex('b'), hex('c'));
    for (name, age) in [(&old, 300), (&mid, 200), (&new, 100)] {
        folder(&cache, name, 64, age);
    }
    folder(&cache, "notes", 1024, 1000);
    std::fs::write(cache.join("stray"), vec![0u8; 1 << 20]).unwrap();

    assert!(rules::trim(&cache, 3 * K64, &[]).unwrap().is_empty());
    let gone = rules::trim(&cache, 2 * K64 + 100, std::slice::from_ref(&old)).unwrap();
    assert_eq!(gone, [cache.join(&mid)]);
    assert!(cache.join(&old).exists() && cache.join(&new).exists());
    let gone = rules::trim(&cache, 50, &[]).unwrap();
    assert_eq!(gone, [cache.join(&old), cache.join(&new)]);
    assert!(cache.join("notes/sub/part").exists() && cache.join("stray").exists());

    let d = cache.join(&old);
    std::fs::create_dir_all(&d).unwrap();
    aged(&d, 500);
    rules::touch(&d).unwrap();
    let used = std::fs::metadata(&d).unwrap().modified().unwrap();
    assert!(used.elapsed().unwrap() < Duration::from_secs(60));
    std::fs::remove_dir_all(&cache).unwrap();
}

#[cfg(unix)]
#[test]
fn the_cache_counts_the_bytes_on_disk_not_a_sparse_file_s_length() {
    let cache = tmp("sparse");
    let hex = |c: char| c.to_string().repeat(40);
    let old = folder(&cache, &hex('a'), 64, 300);
    // A torrent just started: its 8 GB file is allocated at full length with 64 KiB arrived.
    let new = folder(&cache, &hex('b'), 64, 100);
    let f = std::fs::OpenOptions::new()
        .write(true)
        .open(new.join("sub/part"))
        .unwrap();
    f.set_len(8 << 30).unwrap();
    aged(&new, 100);
    assert!(rules::trim(&cache, 1 << 20, &[hex('b')])
        .unwrap()
        .is_empty());
    assert!(old.exists());
    std::fs::remove_dir_all(&cache).unwrap();
}

#[cfg(unix)]
#[test]
fn a_folder_that_will_not_delete_does_not_stop_the_trim() {
    use std::os::unix::fs::PermissionsExt;
    let cache = tmp("stuck");
    let hex = |c: char| c.to_string().repeat(40);
    let stuck = folder(&cache, &hex('a'), 64, 300);
    let next = folder(&cache, &hex('b'), 64, 200);
    let mode = |m| std::fs::Permissions::from_mode(m);
    std::fs::set_permissions(stuck.join("sub"), mode(0o555)).unwrap();
    // Root deletes through any mode, so there is nothing to show as root.
    let root = std::fs::File::create(stuck.join("sub/probe")).is_ok();
    let gone = rules::trim(&cache, 0, &[]).unwrap();
    if !root {
        assert_eq!(
            gone,
            std::slice::from_ref(&next),
            "the stuck folder is skipped, the next one goes"
        );
        std::fs::set_permissions(stuck.join("sub"), mode(0o755)).unwrap();
    }
    assert!(!next.exists());
    std::fs::remove_dir_all(&cache).unwrap();
}
