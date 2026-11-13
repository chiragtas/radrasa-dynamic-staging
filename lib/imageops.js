// Image clean-up and quality checks. Uses `sharp`; if it is not installed everything here quietly does nothing
// (the preview still works, just without these improvements).
let sharpPromise;
const getSharp = () => (sharpPromise ||= import('sharp').then((m) => m.default).catch(() => null));

const toBuf = (b64) => Buffer.from(b64, 'base64');
const isPng = (b64) => b64.startsWith('iVBOR');

/**
 * Make the product photo easier for the AI to copy: remove plain borders, flatten transparency onto white,
 * centre it on a square with a margin, resize. Falls back to the original photo if anything goes wrong.
 */
export async function prepareProduct(img, side) {
  const sharp = await getSharp();
  if (!sharp) return img;
  try {
    const src = sharp(toBuf(img.data), { failOn: 'none' }).rotate().flatten({ background: '#ffffff' });
    const meta = await src.clone().metadata();
    let work = src;
    try {
      const trimmed = await src.clone().trim({ background: '#ffffff', threshold: 14 }).toBuffer({ resolveWithObject: true });
      // keep the crop unless it is a speck or a sliver (noise), in which case the photo is used as it is
      const tw = trimmed.info.width, th = trimmed.info.height;
      if (tw >= 24 && th >= 24 && Math.min(tw, th) / Math.max(tw, th) > 0.05) work = sharp(trimmed.data);
    } catch { /* nothing to trim */ }
    const inner = Math.round(side * 0.92);
    const fitted = await work.resize(inner, inner, { fit: 'inside', withoutEnlargement: false }).toBuffer();
    const out = await sharp({ create: { width: side, height: side, channels: 3, background: '#ffffff' } })
      .composite([{ input: fitted, gravity: 'centre' }])
      .jpeg({ quality: 92 })
      .toBuffer();
    return { mime: 'image/jpeg', data: out.toString('base64') };
  } catch (e) {
    console.warn('[imageops] product clean-up skipped:', e.message);
    return img;
  }
}

/**
 * The AI sometimes returns a picture whose shape is a hair off the photo it was given (sizes snap to multiples of 16).
 * When the difference is small (up to 6%), trim that sliver so nothing looks stretched or squashed. Bigger differences are left alone.
 */
export async function fitAspect(out, targetW, targetH) {
  const sharp = await getSharp();
  if (!sharp) return out;
  try {
    const img = sharp(toBuf(out.data), { failOn: 'none' });
    const { width: w, height: h } = await img.metadata();
    if (!w || !h) return out;
    const want = targetW / targetH;
    const have = w / h;
    const off = Math.abs(have / want - 1);
    if (off < 0.002 || off > 0.06) return out;
    const nw = have > want ? Math.round(h * want) : w;
    const nh = have > want ? h : Math.round(w / want);
    const crop = img.extract({ left: Math.floor((w - nw) / 2), top: Math.floor((h - nh) / 2), width: nw, height: nh });
    const buf = isPng(out.data) ? await crop.png().toBuffer() : await crop.jpeg({ quality: 95 }).toBuffer();
    return { mime: isPng(out.data) ? 'image/png' : 'image/jpeg', data: buf.toString('base64') };
  } catch {
    return out;
  }
}

// Large changes (hair, hats, scarves) must change the picture overall. Small items (earrings, glasses, watches...) change only a
// patch, so they are judged on whether ANY part of the picture changed noticeably. Makeup only gets the blank check.
const LARGE = new Set(['hair', 'hat', 'scarf']);
const NO_CHANGE_CHECK = new Set(['makeup']);

async function gray(buf, sharp, n) {
  return sharp(buf, { failOn: 'none' }).resize(n, n, { fit: 'fill' }).greyscale().raw().toBuffer();
}

/** Largest average brightness change in any one block of an 8x8 grid (64x64 grey versions of both pictures). */
function maxBlockChange(a, b, n = 64, grid = 8) {
  const step = n / grid;
  let worst = 0;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      let sum = 0;
      for (let y = gy * step; y < (gy + 1) * step; y++) for (let x = gx * step; x < (gx + 1) * step; x++) sum += Math.abs(a[y * n + x] - b[y * n + x]);
      worst = Math.max(worst, sum / (step * step));
    }
  }
  return worst;
}

/** Spot useless results: blank/flat images, or the photo handed back unchanged. Returns { ok, reason }. Unreadable images are not judged. */
export async function assess(out, person, categoryId) {
  const sharp = await getSharp();
  if (!sharp) return { ok: true };
  try {
    const a = await gray(toBuf(out.data), sharp, 64);
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
    if (sd < 6) return { ok: false, reason: 'blank' };
    if (NO_CHANGE_CHECK.has(categoryId)) return { ok: true };
    const b = await gray(toBuf(person.data), sharp, 64);
    if (LARGE.has(categoryId)) {
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
      return diff / a.length < 1.5 ? { ok: false, reason: 'unchanged' } : { ok: true };
    }
    return maxBlockChange(a, b) < 6 ? { ok: false, reason: 'unchanged' } : { ok: true };
  } catch {
    return { ok: true };
  }
}

/**
 * Re-save the AI picture with no metadata, so a downloaded preview carries no maker, software or
 * provenance tags (EXIF, XMP, PNG text chunks, C2PA manifests). Pixels are unchanged.
 */
export async function cleanOutput(out) {
  const buf = Buffer.from(out.data, 'base64');
  const png = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  const sharp = await getSharp();
  if (sharp) {
    try {
      const s = sharp(buf, { failOn: 'none' }); // sharp drops all metadata unless asked to keep it
      const clean = png ? await s.png({ compressionLevel: 8 }).toBuffer() : await s.jpeg({ quality: 93, mozjpeg: true }).toBuffer();
      return { mime: png ? 'image/png' : 'image/jpeg', data: clean.toString('base64') };
    } catch { /* fall through to the byte-level clean-up */ }
  }
  return { mime: png ? 'image/png' : out.mime || 'image/jpeg', data: (png ? stripPng(buf) : stripJpeg(buf)).toString('base64') };
}

// Keep only the chunks needed to draw the picture.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs']);
export function stripPng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return buf;
  const parts = [buf.subarray(0, 8)];
  for (let i = 8; i + 12 <= buf.length;) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) break;
    if (PNG_KEEP.has(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}
// Drop APP1 (EXIF/XMP), APP11-APP15 (C2PA/JUMBF and vendor data) and comments; keep JFIF, ICC (APP2) and image data.
export function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xda) { parts.push(buf.subarray(i)); return Buffer.concat(parts); } // start of scan: the rest is image data
    const len = buf.readUInt16BE(i + 2);
    const drop = marker === 0xe1 || (marker >= 0xeb && marker <= 0xef) || marker === 0xfe;
    if (!drop) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return buf;
}
