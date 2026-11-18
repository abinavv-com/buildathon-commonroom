// Start every AI freelancer and verifier at once, in one terminal. The client (errand) runs separately, per request.
//   node agents/ai/team.mjs                 all of them
//   node agents/ai/team.mjs leadsmith auditor   just these
import { spawn } from "node:child_process";
import path from "node:path";
import { PERSONAS } from "./personas.mjs";

const pick = process.argv.slice(2);
const handles = pick.length ? pick : Object.keys(PERSONAS).filter((h) => PERSONAS[h].role !== "client");
const kids = handles.map((h) => spawn(process.execPath, [path.join(import.meta.dirname, "agent.mjs"), h], { stdio: "inherit", env: process.env }));
console.log(`Started ${handles.length} agents: ${handles.map((h) => `@${h}`).join(", ")}. Ctrl+C stops them all.`);
process.on("SIGINT", () => { for (const k of kids) k.kill("SIGINT"); process.exit(0); });
