import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isPrivateHost } from "../domain/skills/public-address.js";

/**
 * The addresses of a host, refused when any of them is loopback, link-local or private. The name check alone
 * (PublicAddress) lets a public domain that resolves to 127.0.0.1 or 192.168.x.x through; this looks up every address
 * the name has and checks each one.
 */
async function publicAddresses(hostname: string, resolve: typeof lookup): Promise<LookupAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHost(host)) throw new Error("That address is not allowed");
  let addresses: LookupAddress[];
  try {
    addresses = await resolve(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve ${host}`);
  }
  if (!addresses.length || addresses.some((entry) => isPrivateHost(entry.address))) {
    throw new Error("That address is not allowed");
  }
  return addresses;
}

/** Refuses a URL whose host resolves to a private address, for a program that will make the connection itself. */
export async function assertPublicHost(url: URL, resolve: typeof lookup = lookup): Promise<void> {
  await publicAddresses(url.hostname, resolve);
}

/** A DNS lookup for a connection that only answers with public addresses. */
export function publicLookup(resolve: typeof lookup = lookup): LookupFunction {
  return (hostname, options, callback) => {
    publicAddresses(hostname, resolve).then(
      (addresses) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    );
  };
}

/**
 * Fetches a public URL with no redirects followed. The check happens in the connection's own lookup, so the address that
 * was checked is the one connected to: a name cannot answer with a public address for a check and then a private one
 * for the connection (DNS rebinding), as it could if fetch looked it up again.
 */
export async function fetchPublic(url: URL, options: { signal?: AbortSignal; headers?: Record<string, string> } = {}, resolve: typeof lookup = lookup): Promise<Response> {
  // An address needs no lookup, so nothing above would see it.
  if (isPrivateHost(url.hostname)) throw new Error("That address is not allowed");
  return await requestThrough(url, options, publicLookup(resolve));
}

/** One GET over a connection that resolves its host with `resolver`, as a fetch Response. */
export function requestThrough(url: URL, options: { signal?: AbortSignal; headers?: Record<string, string> }, resolver: LookupFunction): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: "GET",
      // Its own connection: a kept one would skip the lookup.
      agent: false,
      lookup: resolver,
      headers: { "accept-encoding": "gzip, deflate, br", ...options.headers },
      ...(options.signal ? { signal: options.signal } : {}),
    }, (incoming) => {
      const headers = new Headers();
      for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
        try {
          headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        } catch {
          // A header fetch would not accept either: the page still loads without it.
        }
      }
      const status = incoming.statusCode ?? 502;
      if ([101, 204, 205, 304].includes(status) || status < 200) {
        incoming.resume();
        resolve(new Response(null, { status: status < 200 ? 502 : status, headers }));
        return;
      }
      const encoding = headers.get("content-encoding")?.trim().toLowerCase();
      const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
      let body: Readable = incoming;
      if (decoder) {
        incoming.on("error", (error) => decoder.destroy(error));
        body = incoming.pipe(decoder);
        headers.delete("content-encoding");
      }
      resolve(new Response(Readable.toWeb(body) as ReadableStream, { status, headers }));
    });
    request.on("error", reject);
    request.end();
  });
}
