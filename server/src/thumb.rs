//! Small JPEG previews of photos, so a photo grid never downloads full-size pictures.
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageDecoder, ImageReader};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

/// The longest edge of a thumbnail, in pixels.
pub const EDGE: u32 = 320;
/// Thumbnails decoded at once. A phone photo takes about 150 MB while it decodes, so a small NAS
/// would run out of memory with every worker on one, and video streams would wait.
pub const RENDERS: usize = 2;

/// Lets at most `n` renders run at a time.
pub struct Gate {
    busy: Mutex<usize>,
    free: Condvar,
    n: usize,
}

pub struct Turn<'a>(&'a Gate);

impl Gate {
    pub fn new(n: usize) -> Self {
        Gate {
            busy: Mutex::new(0),
            free: Condvar::new(),
            n,
        }
    }
    pub fn enter(&self) -> Turn<'_> {
        let mut busy = self.busy.lock().unwrap();
        while *busy >= self.n {
            busy = self.free.wait(busy).unwrap();
        }
        *busy += 1;
        Turn(self)
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        *self.0.busy.lock().unwrap() -= 1;
        self.0.free.notify_one();
    }
}

/// A JPEG preview of the picture in `file`, turned upright from its EXIF orientation.
/// `None` for formats this build cannot decode (HEIC, AVIF) or a damaged file.
pub fn render(file: std::fs::File) -> Option<Vec<u8>> {
    let mut dec = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let orientation = dec.orientation().ok()?;
    // Shrink first: the box is square, so turning the small picture gives the same result.
    let mut small = DynamicImage::from_decoder(dec).ok()?.thumbnail(EDGE, EDGE);
    small.apply_orientation(orientation);
    let small = on_white(small);
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 78)
        .encode_image(&small)
        .ok()?;
    Some(out)
}

/// JPEG has no transparency: see-through parts of a PNG, WebP or GIF go on white, not black.
fn on_white(img: DynamicImage) -> image::RgbImage {
    if !img.color().has_alpha() {
        return img.to_rgb8();
    }
    let rgba = img.to_rgba8();
    image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let mix = |c: u8| ((c as u32 * a as u32 + 255 * (255 - a as u32)) / 255) as u8;
        image::Rgb([mix(r), mix(g), mix(b)])
    })
}

/// Where the thumbnail for this version of a photo is kept. A changed file gets a new name.
/// The same name ending in `.none` records a photo that could not be decoded.
pub fn cache_path(dir: &Path, id: &str, size: u64, mtime: u64) -> PathBuf {
    dir.join(format!("{id}-{size}-{mtime}.jpg"))
}

/// Writes through a temp file and a rename, so a reader never sees half a thumbnail.
pub fn store(path: &Path, jpeg: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    // The desktop app and an installed service can share this folder, so the process is in the name.
    let tag = format!(
        "{}.{:?}.tmp",
        std::process::id(),
        std::thread::current().id()
    );
    let tmp = path.with_extension(tag);
    std::fs::write(&tmp, jpeg)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}
