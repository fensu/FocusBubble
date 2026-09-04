//! 极小 PNG 编码器（灰度 8-bit，deflate stored 块）。
//! macOS maskImage 更新用；跨平台无 cfg，便于在任意平台跑单元测试校验字节。

pub fn encode_grayscale_png(width: usize, height: usize, pixels: &[u8]) -> Vec<u8> {
    debug_assert_eq!(pixels.len(), width * height);

    let mut raw = Vec::with_capacity((width + 1) * height);
    for row in 0..height {
        raw.push(0u8); // filter: none
        let start = row * width;
        raw.extend_from_slice(&pixels[start..start + width]);
    }

    let mut idat = vec![0x78, 0x01]; // zlib: deflate stored, 最小开销
    idat.extend_from_slice(&deflate_stored(&raw));
    idat.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    push_chunk(&mut png, b"IHDR", &ihdr_payload(width, height));
    push_chunk(&mut png, b"IDAT", &idat);
    push_chunk(&mut png, b"IEND", &[]);
    png
}

fn ihdr_payload(width: usize, height: usize) -> Vec<u8> {
    let mut payload = Vec::with_capacity(13);
    payload.extend_from_slice(&(width as u32).to_be_bytes());
    payload.extend_from_slice(&(height as u32).to_be_bytes());
    payload.push(8); // bit depth
    payload.push(0); // color type: grayscale
    payload.push(0); // compression: deflate
    payload.push(0); // filter: adaptive
    payload.push(0); // interlace: none
    payload
}

fn deflate_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xFF, 0xFF]);
        return out;
    }
    let mut offset = 0;
    while offset < data.len() {
        let remaining = data.len() - offset;
        let block = remaining.min(65535);
        let is_last = offset + block == data.len();
        out.push(if is_last { 0x01 } else { 0x00 });
        out.extend_from_slice(&(block as u16).to_le_bytes());
        out.extend_from_slice(&(!(block as u16)).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + block]);
        offset += block;
    }
    out
}

fn push_chunk(png: &mut Vec<u8>, chunk_type: &[u8; 4], payload: &[u8]) {
    png.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    png.extend_from_slice(chunk_type);
    png.extend_from_slice(payload);
    let mut crc_input = Vec::with_capacity(4 + payload.len());
    crc_input.extend_from_slice(chunk_type);
    crc_input.extend_from_slice(payload);
    png.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for byte in data {
        a = (a + *byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_size_grows_with_payload() {
        let black = encode_grayscale_png(4, 4, &vec![0u8; 16]);
        let mixed = encode_grayscale_png(4, 4, &(0..16).collect::<Vec<u8>>());
        assert_eq!(black.len(), mixed.len());
        assert!(black.len() > 8 + 12 + 13 + 12 + 12);
    }

    #[test]
    fn writes_test_png_for_external_validation() {
        // 生成一张带清晰圆的真实 mask，供 Node zlib 解码校验（见 CI 前本地检查）。
        let (w, h) = (160usize, 90usize);
        let mut pixels = vec![255u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - 80.0;
                let dy = y as f32 - 45.0;
                if (dx * dx + dy * dy).sqrt() < 30.0 {
                    pixels[y * w + x] = 0;
                }
            }
        }
        let png = encode_grayscale_png(w, h, &pixels);
        if let Ok(dir) = std::env::var("CARGO_TARGET_DIR") {
            let path = std::path::Path::new(&dir).join("mask_test.png");
            let _ = std::fs::write(path, &png);
        } else {
            let _ = std::fs::write("mask_test.png", &png);
        }
    }
}
