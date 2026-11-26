//! Photos: listed with their capture date, and served as small upright thumbnails.
use flick_server::index::{content_type, item_id, kind, scan, scan_with, taken};
use flick_server::{start, Config};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, UNIX_EPOCH};

fn temp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("flick-server-photo-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// An APP1 segment holding EXIF Orientation and DateTimeOriginal, big-endian TIFF.
fn exif_app1(date: &str, orientation: u16) -> Vec<u8> {
    let mut t: Vec<u8> = b"MM\0\x2a".to_vec();
    t.extend(8u32.to_be_bytes());
    // IFD0 at 8: Orientation, then the pointer to the Exif IFD at 38.
    t.extend(2u16.to_be_bytes());
    t.extend(0x0112u16.to_be_bytes());
    t.extend(3u16.to_be_bytes());
    t.extend(1u32.to_be_bytes());
    t.extend(orientation.to_be_bytes());
    t.extend([0, 0]);
    t.extend(0x8769u16.to_be_bytes());
    t.extend(4u16.to_be_bytes());
    t.extend(1u32.to_be_bytes());
    t.extend(38u32.to_be_bytes());
    t.extend(0u32.to_be_bytes());
    // Exif IFD at 38: DateTimeOriginal, its 20 bytes at 56.
    t.extend(1u16.to_be_bytes());
    t.extend(0x9003u16.to_be_bytes());
    t.extend(2u16.to_be_bytes());
    t.extend(20u32.to_be_bytes());
    t.extend(56u32.to_be_bytes());
    t.extend(0u32.to_be_bytes());
    t.extend(date.as_bytes());
    t.push(0);
    let mut seg = vec![0xFF, 0xE1];
    seg.extend(((t.len() + 8) as u16).to_be_bytes());
    seg.extend(b"Exif\0\0");
    seg.extend(t);
    seg
}

/// A w by h JPEG, with an EXIF block when `exif` is given.
fn jpeg(w: u32, h: u32, exif: Option<(&str, u16)>) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, _| image::Rgb([(x % 256) as u8, 90, 160]));
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut out)
        .encode_image(&img)
        .unwrap();
    if let Some((date, o)) = exif {
        out.splice(2..2, exif_app1(date, o));
    }
    out
}

#[test]
fn photo_kinds_and_types() {
    for e in ["jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "avif"] {
        assert_eq!(kind(e), Some("photo"), "{e}");
    }
    assert_eq!(content_type("jpg"), "image/jpeg");
    assert_eq!(content_type("heic"), "image/heic");
    assert_eq!(content_type("webp"), "image/webp");
}

#[test]
fn scan_lists_photos_with_capture_dates() {
    let root = temp("scan").join("Camera");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("IMG_1234.JPG"),
        jpeg(40, 30, Some(("2024:06:01 10:20:30", 1))),
    )
    .unwrap();
    fs::write(
        root.join("IMG_1235.JPG"),
        jpeg(40, 30, Some(("0000:00:00 00:00:00", 1))),
    )
    .unwrap();
    fs::write(root.join("IMG_1236.png"), b"not really a png").unwrap();
    fs::write(root.join("IMG_1237.MOV"), b"x").unwrap();
    let idx = scan(std::slice::from_ref(&root));
    let got: Vec<_> = idx
        .items
        .iter()
        .map(|i| (i.name.as_str(), i.kind, i.taken.as_deref()))
        .collect();
    assert_eq!(
        got,
        [
            ("IMG_1234.JPG", "photo", Some("2024-06-01T10:20:30")),
            ("IMG_1235.JPG", "photo", None),
            ("IMG_1236.png", "photo", None),
            ("IMG_1237.MOV", "video", None),
        ]
    );
    let v = serde_json::to_value(&idx.items[0]).unwrap();
    assert_eq!(v["taken"], "2024-06-01T10:20:30");
    assert!(serde_json::to_value(&idx.items[3])
        .unwrap()
        .get("taken")
        .is_none());
}

#[test]
fn rescan_reuses_dates_of_unchanged_photos() {
    let root = temp("reuse").join("Camera");
    fs::create_dir_all(&root).unwrap();
    let p = root.join("a.jpg");
    let with = jpeg(40, 30, Some(("2023:01:02 03:04:05", 1)));
    fs::write(&p, &with).unwrap();
    let stamp = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    fs::File::options()
        .write(true)
        .open(&p)
        .unwrap()
        .set_modified(stamp)
        .unwrap();
    let first = scan(std::slice::from_ref(&root));
    // Same size and mtime, but no EXIF any more: a rescan does not read the file again.
    let mut blank = with.clone();
    let at = blank.windows(4).position(|w| w == b"2023").unwrap();
    blank[at..at + 4].copy_from_slice(b"0000");
    fs::write(&p, &blank).unwrap();
    fs::File::options()
        .write(true)
        .open(&p)
        .unwrap()
        .set_modified(stamp)
        .unwrap();
    assert_eq!(taken(&p), None);
    let again = scan_with(std::slice::from_ref(&root), Some(&first));
    assert_eq!(again.items[0].taken.as_deref(), Some("2023-01-02T03:04:05"));
    // A changed file is read again.
    fs::File::options()
        .write(true)
        .open(&p)
        .unwrap()
        .set_modified(stamp + Duration::from_secs(5))
        .unwrap();
    assert_eq!(scan_with(&[root], Some(&first)).items[0].taken, None);
}

fn get(port: u16, path: &str) -> (u16, String, Vec<u8>) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut raw = vec![];
    s.read_to_end(&mut raw).unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    (
        head[9..12].parse().unwrap(),
        head,
        raw[split + 4..].to_vec(),
    )
}

fn dims(jpeg: &[u8]) -> (u32, u32) {
    let img = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).unwrap();
    (img.width(), img.height())
}

#[test]
fn serves_small_upright_thumbnails() {
    let base = temp("http");
    let media = base.join("Photos");
    fs::create_dir_all(&media).unwrap();
    // Orientation 6: the camera was turned, so the upright picture is tall.
    fs::write(
        media.join("wide.jpg"),
        jpeg(1000, 500, Some(("2024:06:01 10:20:30", 6))),
    )
    .unwrap();
    fs::write(media.join("plain.jpg"), jpeg(800, 600, None)).unwrap();
    fs::write(media.join("phone.heic"), b"\0\0\0\x18ftypheic").unwrap();
    fs::write(media.join("clip.mp4"), b"x").unwrap();
    let h = start(Config {
        media: vec![media],
        port: 0,
        name: "Photo box".into(),
        lan: false,
        config_dir: base.join("cfg"),
        web: None,
    })
    .unwrap();
    let (p, t) = (h.port(), h.token().to_string());
    let id = |name: &str| item_id("Photos", name);

    assert_eq!(get(p, &format!("/thumb/{}", id("wide.jpg"))).0, 401);
    let (status, head, body) = get(p, &format!("/thumb/{}?t={t}", id("wide.jpg")));
    assert_eq!(status, 200);
    assert!(
        head.to_lowercase().contains("content-type: image/jpeg"),
        "{head}"
    );
    assert!(head.contains("max-age=31536000"), "{head}");
    assert_eq!(dims(&body), (160, 320));
    assert!(body.len() < 40_000, "{} bytes", body.len());
    let dir = base.join("cfg/thumbs");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    // The second request comes from the cache, byte for byte.
    assert_eq!(get(p, &format!("/thumb/{}?t={t}", id("wide.jpg"))).2, body);

    assert_eq!(
        dims(&get(p, &format!("/thumb/{}?t={t}", id("plain.jpg"))).2),
        (320, 240)
    );
    assert_eq!(get(p, &format!("/thumb/{}?t={t}", id("phone.heic"))).0, 415);
    assert_eq!(get(p, &format!("/thumb/{}?t={t}", id("clip.mp4"))).0, 404);
    assert_eq!(get(p, &format!("/thumb/nope?t={t}")).0, 404);
    // Full size stays at /media with its image type.
    let (status, head, _) = get(p, &format!("/media/{}?t={t}", id("phone.heic")));
    assert_eq!(status, 200);
    assert!(
        head.to_lowercase().contains("content-type: image/heic"),
        "{head}"
    );
    h.stop();
}
