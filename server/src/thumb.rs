//! Small JPEG previews of photos, so a photo grid never downloads full-size pictures.
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageDecoder, ImageReader};
use std::io::BufReader;
use std::path::{Path, PathBuf};

/// The longest edge of a thumbnail, in pixels.
pub const EDGE: u32 = 320;

/// A JPEG preview of the picture in `file`, turned upright from its EXIF orientation.
/// `None` for formats this build cannot decode (HEIC, AVIF) or a damaged file.
pub fn render(file: std::fs::File) -> Option<Vec<u8>> {
    let mut dec = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let orientation = dec.orientation().ok()?;
    let mut img = DynamicImage::from_decoder(dec).ok()?;
    img.apply_orientation(orientation);
    let small = img.thumbnail(EDGE, EDGE).to_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 78)
        .encode_image(&small)
        .ok()?;
    Some(out)
}

/// Where the thumbnail for this version of a photo is kept. A changed file gets a new name.
pub fn cache_path(dir: &Path, id: &str, size: u64, mtime: u64) -> PathBuf {
    dir.join(format!("{id}-{size}-{mtime}.jpg"))
}

/// Writes through a temp file and a rename, so a reader never sees half a thumbnail.
pub fn store(path: &Path, jpeg: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension(format!("{:?}.tmp", std::thread::current().id()));
    std::fs::write(&tmp, jpeg)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}
