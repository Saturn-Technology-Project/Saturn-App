import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../domain/errors.js";
import type { ImagePart } from "../infrastructure/llm/types.js";

/** Images one message may carry. */
export const MAX_IMAGES = 4;
/** Bytes per image, decoded. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const FOLDER = "run-images";

/**
 * The images a request attached, as data URLs ("data:image/png;base64,…") or { mimeType, base64 }.
 * Anything else, too many, too large or of another type is refused with a message the user can act on.
 */
export function parseImages(raw: unknown): ImagePart[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "images must be a list");
  if (raw.length > MAX_IMAGES) throw new HttpError(400, `Attach at most ${MAX_IMAGES} images to one message`);
  return raw.map((item, index) => {
    let mimeType = "";
    let base64 = "";
    if (typeof item === "string") {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(item);
      if (match) [mimeType, base64] = [match[1]!, match[2]!];
    } else if (item && typeof item === "object") {
      mimeType = String((item as ImagePart).mimeType ?? "");
      base64 = String((item as ImagePart).base64 ?? "");
    }
    base64 = base64.replace(/\s+/g, "");
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new HttpError(400, `Image ${index + 1} is not a base64 image`);
    if (!EXTENSIONS[mimeType]) throw new HttpError(400, `Image ${index + 1} is ${mimeType || "of an unknown type"}; use PNG, JPEG, WebP or GIF`);
    const bytes = Math.floor((base64.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) throw new HttpError(413, `Image ${index + 1} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    return { mimeType, base64 };
  });
}

/** Writes a run's images under `<data>/run-images/<runId>/` and returns their paths relative to the data root. */
export async function saveImages(root: string, runId: string, images: ImagePart[]): Promise<string[]> {
  if (!images.length) return [];
  const dir = path.join(root, FOLDER, safe(runId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const saved: string[] = [];
  for (const [index, image] of images.entries()) {
    const name = `${index + 1}.${EXTENSIONS[image.mimeType]}`;
    await writeFile(path.join(dir, name), Buffer.from(image.base64, "base64"), { mode: 0o600 });
    saved.push(`${FOLDER}/${safe(runId)}/${name}`);
  }
  return saved;
}

/** Absolute path of a saved image, refusing anything outside the images folder. */
export function imagePath(root: string, relative: string): string {
  const base = path.join(root, FOLDER);
  const full = path.resolve(root, relative);
  if (!full.startsWith(base + path.sep)) throw new HttpError(400, "Not a run image");
  return full;
}

/** A run's images, for a model call. Missing files are skipped. */
export async function loadImages(root: string, paths: string[] | undefined): Promise<ImagePart[]> {
  const images: ImagePart[] = [];
  for (const relative of paths ?? []) {
    const extension = path.extname(relative).slice(1);
    const mimeType = Object.keys(EXTENSIONS).find((key) => EXTENSIONS[key] === extension);
    if (!mimeType) continue;
    try {
      images.push({ mimeType, base64: (await readFile(imagePath(root, relative))).toString("base64") });
    } catch {
      // The file was removed; the text of the message still stands.
    }
  }
  return images;
}

export async function forgetImages(root: string, runIds: string[]): Promise<void> {
  await Promise.all(runIds.map((id) => rm(path.join(root, FOLDER, safe(id)), { recursive: true, force: true }).catch(() => undefined)));
}

function safe(id: string): string {
  return id.replace(/[^\w-]/g, "_");
}
