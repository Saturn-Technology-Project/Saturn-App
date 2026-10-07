/** An http(s) address an agent may fetch. Loopback and private networks are refused. */
export class PublicAddress {
  readonly url: URL;

  private constructor(url: URL) {
    this.url = url;
  }

  static parse(raw: string): PublicAddress {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("URL is invalid");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are allowed");
    if (url.username || url.password) throw new Error("That address is not allowed");
    if (isPrivateHost(url.hostname)) throw new Error("That address is not allowed");
    return new PublicAddress(url);
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const parts = v4.slice(1).map((part) => Number(part));
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
