//! Small JPEG previews of photos, so a photo grid never downloads full-size pictures.
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageDecoder, ImageError, ImageReader};
use std::io::{BufReader, Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

/// The longest edge of a thumbnail, in pixels.
pub const EDGE: u32 = 320;
/// Thumbnails decoded at once. A phone photo takes about 150 MB while it decodes, so a small NAS
/// would run out of memory with every worker on one, and video streams would wait.
pub const RENDERS: usize = 2;
/// Thumbnail requests that may wait for a render. The rest are told to retry, so most workers
/// stay free for /media and /api.
pub const WAITING: usize = 4;
/// Bumped when this build learns new formats, so photos it could not decode before get another try.
pub const DECODERS: u32 = 1;

/// Lets at most `n` renders run at a time, with at most `queue` more waiting.
pub struct Gate {
    state: Mutex<(usize, usize)>,
    free: Condvar,
    n: usize,
    queue: usize,
}

pub struct Turn<'a>(&'a Gate);

impl Gate {
    pub fn new(n: usize, queue: usize) -> Self {
        Gate {
            state: Mutex::new((0, 0)),
            free: Condvar::new(),
            n,
            queue,
        }
    }
    /// A turn to render, after waiting if the slots are busy. `None` when the queue is full too.
    pub fn enter(&self) -> Option<Turn<'_>> {
        let mut st = self.state.lock().unwrap();
        if st.0 >= self.n {
            if st.1 >= self.queue {
                return None;
            }
            st.1 += 1;
            while st.0 >= self.n {
                st = self.free.wait(st).unwrap();
            }
            st.1 -= 1;
        }
        st.0 += 1;
        Some(Turn(self))
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().0 -= 1;
        self.0.free.notify_one();
    }
}

/// Why a photo has no thumbnail.
#[derive(Debug, PartialEq)]
pub enum Failure {
    /// The format is one this build cannot decode (HEIC, AVIF), or the file is damaged.
    Undecodable,
    /// Reading the file failed; it may work next time.
    Io,
}

fn why(e: ImageError) -> Failure {
    match e {
        ImageError::IoError(_) => Failure::Io,
        _ => Failure::Undecodable,
    }
}

/// A JPEG preview of the picture in `file`, turned upright from its EXIF orientation.
pub fn render<R: Read + Seek>(file: R) -> Result<Vec<u8>, Failure> {
    let mut dec = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| Failure::Io)?
        .into_decoder()
        .map_err(why)?;
    let orientation = dec.orientation().map_err(why)?;
    // Shrink first: the box is square, so turning the small picture gives the same result.
    let mut small = DynamicImage::from_decoder(dec)
        .map_err(why)?
        .thumbnail(EDGE, EDGE);
    small.apply_orientation(orientation);
    let small = on_white(small);
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 78)
        .encode_image(&small)
        .map_err(why)?;
    Ok(out)
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
pub fn cache_path(dir: &Path, id: &str, size: u64, mtime: u64) -> PathBuf {
    dir.join(format!("{id}-{size}-{mtime}.jpg"))
}

/// Records that this version of a photo could not be decoded by a build with these decoders.
pub fn failed_path(dir: &Path, id: &str, size: u64, mtime: u64) -> PathBuf {
    dir.join(format!("{id}-{size}-{mtime}.none{DECODERS}"))
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
