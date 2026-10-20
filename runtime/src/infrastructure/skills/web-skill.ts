import { PublicAddress } from "../../domain/skills/public-address.js";
import { assertPublicHost } from "../public-host.js";
import { clip, text } from "./text.js";

export class WebSkill {
  async run(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let current = PublicAddress.parse(text(args.url)).url;
    let status = 0;
    let body = "";
    for (let hop = 0; hop < 4; hop += 1) {
      await assertPublicHost(current);
      const response = await fetch(current, { redirect: "manual", signal: signal ?? AbortSignal.timeout(10_000) });
      status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) break;
        current = PublicAddress.parse(new URL(location, current).toString()).url;
        continue;
      }
      body = await response.text();
      break;
    }
    const readable = pageText(body);
    return { url: current.toString(), status, title: readable.title, text: clip(readable.text), body: clip(readable.text) };
  }
}

function pageText(html: string): { title: string; text: string } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const text = decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
  return { title, text };
}

function decode(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
