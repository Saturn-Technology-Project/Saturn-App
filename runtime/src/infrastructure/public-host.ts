import { lookup } from "node:dns/promises";
import { isPrivateHost } from "../domain/skills/public-address.js";

/**
 * Refuses a URL whose host resolves to a loopback, link-local or private address. The name check alone
 * (PublicAddress) lets a public domain that resolves to 127.0.0.1 or 192.168.x.x through (DNS rebinding);
 * this looks up every address the name has and checks each one.
 */
export async function assertPublicHost(url: URL, resolve: typeof lookup = lookup): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHost(host)) throw new Error("That address is not allowed");
  let addresses: { address: string }[];
  try {
    addresses = await resolve(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve ${host}`);
  }
  if (!addresses.length || addresses.some((entry) => isPrivateHost(entry.address))) {
    throw new Error("That address is not allowed");
  }
}
