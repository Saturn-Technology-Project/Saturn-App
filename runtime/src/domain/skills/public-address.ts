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

/** True for loopback, link-local, private and reserved hosts and addresses (IPv4, IPv6, and IPv4 carried inside IPv6). */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const parts = v4.slice(1).map((part) => Number(part));
  if (parts.some((part) => part > 255)) return true;
  return isPrivateIpv4(parts[0]!, parts[1]!, parts[2]!);
}

/** The IPv4 ranges that are not the public internet, judged by an address's first three bytes. */
function isPrivateIpv4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-grade NAT, also what Tailscale uses.
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return true;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224; // Multicast and reserved.
}

/**
 * Judged on the address's eight groups, not its spelling: URL rewrites [::ffff:127.0.0.1] as [::ffff:7f00:1]. An IPv4
 * address carried inside (mapped, NAT64, 6to4) is judged as that address, and what cannot be read is refused.
 */
function isPrivateIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [first, second, third, , fifth, sixth, seventh, eighth] = groups as [number, number, number, number, number, number, number, number];
  const ipv4 = (high: number, low: number) => isPrivateIpv4(high >> 8, high & 0xff, low >> 8);
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (zeros(0, 5)) return sixth === 0xffff ? ipv4(seventh, eighth) : sixth === 0; // ::ffff:a.b.c.d, or ::, ::1 and the deprecated ::a.b.c.d.
  if (zeros(0, 4) && fifth === 0xffff && sixth === 0) return ipv4(seventh, eighth);
  if (first === 0x64 && second === 0xff9b) return zeros(2, 6) ? ipv4(seventh, eighth) : true;
  if (first === 0x2002) return ipv4(second, third);
  if (first === 0x2001 && second === 0) return true; // Teredo.
  return (first & 0xfe00) === 0xfc00 || (first & 0xff80) === 0xfe80 || (first & 0xff00) === 0xff00; // Unique local, link-local and site-local, multicast.
}

/** An IPv6 address as its eight 16-bit groups, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address.split("%")[0]!;
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map((part) => Number(part)) as [number, number, number, number];
    if ([a, b, c, d].some((part) => part > 255)) return null;
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const sides = text.split("::");
  if (sides.length > 2) return null;
  const words = (side: string) => (side ? side.split(":") : []);
  const head = words(sides[0]!);
  const tail = words(sides[1] ?? "");
  const missing = 8 - head.length - tail.length;
  if (sides.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array.from({ length: Math.max(missing, 0) }, () => "0"), ...tail];
  return all.every((word) => /^[0-9a-f]{1,4}$/.test(word)) ? all.map((word) => parseInt(word, 16)) : null;
}
