/// <reference types="@cloudflare/workers-types" />
import { pickUser, schedule } from "./index.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = pickUser({ profile: { name: url.searchParams.get("name") } });
    const d = schedule(() => {});
    d();
    d.cancel();
    return new Response(name, { headers: { "content-type": "text/plain" } });
  },
};
