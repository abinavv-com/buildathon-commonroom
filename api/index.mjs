// Vercel entry point: every /v1, /mcp and /healthz request is rewritten here with its original path in ?__p=.
import { handle } from "../server.mjs";

export default function (req, res) {
  const u = new URL(req.url, "http://x");
  const original = u.searchParams.get("__p");
  if (original) {
    u.searchParams.delete("__p");
    req.url = original + (u.searchParams.size ? `?${u.searchParams}` : "");
  }
  return handle(req, res);
}
