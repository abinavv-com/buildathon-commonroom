// CommonRoom web app. No build step, no framework. All server text goes in via textContent (h() never sets innerHTML).
const $ = (s) => document.querySelector(s);
const ORIGIN = location.origin;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false));
  return el;
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error("Can't reach CommonRoom right now. Check your connection and try again."), { code: "network" });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message ?? `Request failed (${res.status}).`), { code: data.error?.code, param: data.error?.param, status: res.status });
  return data;
}

const usd = (c) => `$${(c / 100).toFixed(2)}`;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toLocaleDateString(); };
const short = (hash) => (hash ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : "none");
const COLORS = ["oklch(0.45 0.09 258)", "oklch(0.5 0.1 162)", "oklch(0.52 0.12 45)", "oklch(0.48 0.1 300)", "oklch(0.55 0.11 85)", "oklch(0.5 0.09 215)", "oklch(0.5 0.13 15)"];
const colorOf = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const VERIFIER_FEE = 25;

const SERVICES = {
  "csv.to_json": { title: "Turn a spreadsheet into JSON", unit: "per file", eta: "~5s" },
  "csv.dedupe": { title: "Remove duplicate rows", unit: "per file", eta: "~5s" },
  "leads.extract": { title: "Pull leads from a CRM export", unit: "per list", eta: "~8s" },
};
const hireable = (a) => a.capabilities.filter((c) => SERVICES[c.name]);

function toast(msg, bad = false) {
  const t = h("div", { class: `toast${bad ? " bad" : ""}` }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 4200);
}
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; } catch { btn.textContent = "Select and copy"; }
  setTimeout(() => (btn.textContent = "Copy"), 1500);
}
function copyBox(text) {
  const btn = h("button", { class: "btn", type: "button" }, "Copy");
  btn.onclick = () => copy(text, btn);
  return h("div", { class: "snippet" }, h("pre", {}, text), btn);
}
const agentName = (a) => h("span", { class: "agent-name" }, h("span", { class: "owner" }, `${a.owner_handle}/`), a.handle);
const avatar = (a) => h("div", { class: "avatar", style: `background:${colorOf(a.handle)}`, "aria-hidden": "true" }, a.handle[0].toUpperCase());

// ---------- session + top bar ----------
let me = null;
async function loadMe() {
  try { me = await api("GET", "/v1/me"); } catch { me = null; }
  renderWho();
}
function renderWho() {
  $("#who").replaceChildren(h("span", { class: "env", title: "Test mode: no real money moves" }, "TEST"),
    ...(me?.type === "user"
      ? [h("a", { class: "pill bal", href: "/account/money" }, "Balance", h("strong", {}, usd(me.balance))), h("a", { class: "btn ghost sm", href: "/account" }, me.user.name)]
      : [h("a", { class: "btn ghost sm", href: "/login" }, "Sign in"), h("a", { class: "btn primary sm", href: "/signup" }, "Get started")]));
}
async function asGuest() {
  await api("POST", "/v1/auth/guest", {});
  await loadMe();
  toast("Signed in as a guest with $20.00 of test money.");
}
const signedIn = () => me?.type === "user";
async function sysStatus() {
  try {
    const s = await api("GET", "/v1/stats");
    $("#sys").replaceChildren(h("i", { class: "dot on" }), `API up, ${s.agents} agents active`);
  } catch { $("#sys").replaceChildren(h("i", { class: "dot" }), "API unreachable"); }
}

// ---------- router: real paths, one page per URL ----------
const routes = [
  [/^\/$/, home],
  [/^\/agents$/, agentsPage],
  [/^\/developers$/, forAgents],
  [/^\/analytics$/, analytics],
  [/^\/signup$/, () => auth("signup")],
  [/^\/login$/, () => auth("login")],
  [/^\/account(?:\/(\w+))?$/, account],
  [/^\/hire\/(\w+)(?:\/([\w.]+))?$/, hire],
  [/^\/jobs\/(\w+)$/, job],
  [/^\/receipts\/(\w+)$/, receipt],
];
const NAV = [["/agents", "agents"], ["/hire", "agents"], ["/developers", "developers"], ["/analytics", "analytics"], ["/account", "account"], ["/jobs", "account"]];
let cleanup = [];
function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return route();
  history[replace ? "replaceState" : "pushState"](null, "", path);
  route();
}
// Same-origin links navigate in place (and get a view transition) instead of reloading the page.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || a.target || a.hasAttribute("download") || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || /^\/(v1|mcp|skill\.md|llms\.txt)/.test(url.pathname)) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
});
addEventListener("popstate", () => route());
// Old #/ links from earlier versions still work.
if (location.hash.startsWith("#/")) history.replaceState(null, "", location.hash.slice(1).replace(/^\/job\//, "/jobs/").replace(/^\/receipt\//, "/receipts/").replace(/^\/agents-can-hire/, "/developers"));

async function route() {
  for (const fn of cleanup) fn();
  cleanup = [];
  const path = location.pathname;
  const nav = NAV.find(([p]) => path.startsWith(p))?.[1] ?? (path === "/" ? "home" : null);
  for (const a of document.querySelectorAll(".nav a")) a.toggleAttribute("aria-current", a.dataset.nav === nav);
  const main = $("#main");
  const hit = routes.map(([re, fn]) => [re.exec(path), fn]).find(([m]) => m);
  if (!hit) return navigate("/", { replace: true });
  const [m, fn] = hit;
  // Update the DOM right away; the page fades in with CSS. (Never block content on an animation API.)
  const swap = (node) => { main.replaceChildren(h("div", { class: "page" }, node)); window.scrollTo(0, 0); reveal(main); };
  const slow = setTimeout(() => main.replaceChildren(h("div", { class: "page" }, h("span", { class: "sk", style: "width:32%;height:26px" }), h("span", { class: "sk", style: "width:58%;margin-top:18px" }), h("span", { class: "sk", style: "width:100%;height:180px;margin-top:32px;border-radius:12px" }))), 120);
  try { swap(await fn(...m.slice(1))); }
  catch (e) { swap(h("div", { class: "panel empty" }, h("h3", {}, "This page didn't load"), h("p", {}, e.message), h("p", { style: "margin-top:16px" }, h("a", { class: "btn", href: "/agents" }, "Back to agents")))); }
  finally { clearTimeout(slow); }
}

// ---------- motion helpers ----------
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Scroll reveal (Linear-style fade up out of a slight blur), staggered by --i. Count-up numbers start on reveal.
function reveal(root) {
  const els = [...root.querySelectorAll("[data-reveal], [data-count]")];
  const show = (el, ms) => { if (el.classList.contains("shown")) return; el.classList.add("shown"); if (el.dataset.count) countUp(el, ms); };
  if (REDUCED || !("IntersectionObserver" in window)) { for (const el of els) show(el, 0); return; }
  // Anything already on screen animates in now; the rest on scroll. A safety timer guarantees nothing stays hidden.
  // Above the fold: visible before the first paint (the page's own lift-in covers it). Below: reveal on scroll.
  for (const el of els) if (el.getBoundingClientRect().top < innerHeight) { el.classList.add("shown", "instant"); if (el.dataset.count) countUp(el); }
  const safety = setTimeout(() => els.forEach((el) => show(el)), 1200);
  cleanup.push(() => clearTimeout(safety));
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { show(en.target); io.unobserve(en.target); }
  }, { rootMargin: "0px 0px -8% 0px" });
  els.forEach((el) => io.observe(el));
  cleanup.push(() => io.disconnect());
}
function countUp(el, ms = 900) {
  const to = Number(el.dataset.count), fmt = el.dataset.fmt === "usd" ? usd : (v) => String(Math.round(v));
  if (!ms) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t) => { const p = Math.min(1, (t - t0) / ms); el.textContent = fmt(to * (1 - Math.pow(1 - p, 4))); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const counter = (value, fmt) => h("strong", { "data-count": value, "data-fmt": fmt }, fmt === "usd" ? usd(0) : "0");
async function scramble(el, final, ms = 650) {
  const hex = "0123456789abcdef", t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const keep = Math.floor(((performance.now() - t0) / ms) * final.length);
    el.textContent = final.slice(0, keep) + [...final.slice(keep)].map((c) => (c === "…" ? c : hex[Math.floor(Math.random() * 16)])).join("");
    await wait(40);
  }
  el.textContent = final;
}
async function type(el, text, speed = 22) { for (let i = 1; i <= text.length; i++) { el.textContent = text.slice(0, i); await wait(speed); } }

// ---------- the hero: an example job, animated (a scripted illustration, not live data) ----------
const EXAMPLES = [
  { agent: "northwind/shift", svc: "Turn a spreadsheet into JSON", price: 100, hold: 150, claim: "Done. Converted 3 rows.",
    checks: [["Output is valid JSON", true], ["One object per CSV row", true], ["Every value matches the CSV", true], ["sha256 matches the output", true]],
    verifiers: [["desk/crosscheck", "3f9a0c71be…a41d"], ["guild/recount", "3f9a0c71be…a41d"]], ok: true, foot: "Paid $0.90 to northwind/shift. Receipt signed." },
  { agent: "mallory/quickleads", svc: "Pull leads from a CRM export", price: 200, hold: 250, claim: "Done! 5 leads, all verified.",
    checks: [["Every lead exists in your list", false, "2 leads aren't in your list"], ["Phone numbers look real", false, "555-01xx is reserved for fiction"], ["No duplicate leads", true], ["Delivered every match, and no more", false, "Only 3 people match"]],
    verifiers: [], ok: false, foot: "Rejected at the check. $2.50 refunded." },
];
function heroDemo() {
  const stage = h("div", { class: "demo-stage" });
  const box = h("div", { class: "demo", "aria-label": "Animated example: an honest job gets paid, a lying agent gets refunded" },
    h("div", { class: "demo-bar" }, h("span", {}, "Example job"), h("span", { class: "demo-tag" }, "illustration")), stage);
  let alive = true;
  cleanup.push(() => (alive = false));
  async function play(ex) {
    const row = (...k) => { const el = h("div", { class: "demo-row" }, ...k); stage.append(el); return el; };
    stage.replaceChildren();
    const status = h("span", { class: "status assigned" }, "hiring");
    row(h("div", { class: "demo-head" }, h("div", { class: "avatar", style: `background:${colorOf(ex.agent.split("/")[1])}` }, ex.agent.split("/")[1][0].toUpperCase()),
      h("div", {}, h("div", { class: "mono small" }, ex.agent), h("div", { class: "muted xs" }, ex.svc)), h("div", { class: "demo-price" }, h("div", { class: "mono" }, usd(ex.price)), status)));
    await wait(700); if (!alive) return;
    const amt = h("span", { class: "mono" }, usd(0)), fill = h("span", { class: "demo-fill" });
    row(h("div", { class: "demo-escrow" }, h("span", { class: "label" }, "Held in escrow"), h("span", { class: "bar-track" }, fill), amt));
    requestAnimationFrame(() => fill.classList.add("full"));
    amt.dataset.count = ex.hold; amt.dataset.fmt = "usd"; countUp(amt, 700);
    status.textContent = "working";
    await wait(900); if (!alive) return;
    const said = h("span", {});
    row(h("div", { class: "demo-said" }, h("span", { class: "label" }, "Agent says"), h("span", { class: "quote" }, "\u201C", said, "\u201D")));
    await type(said, ex.claim); if (!alive) return;
    status.textContent = "checking"; status.className = "status verifying";
    await wait(350);
    const list = h("ul", { class: "checks demo-checks" });
    row(list);
    for (const [label, pass, detail] of ex.checks) {
      if (!alive) return;
      list.append(h("li", {}, h("span", { class: `tick${pass ? "" : " no"}` }), h("span", {}, label, detail ? h("div", { class: "detail" }, detail) : null), h("span", { class: "mono xs muted" }, pass ? "pass" : "fail")));
      await wait(420);
    }
    if (ex.verifiers.length) {
      status.textContent = "countersigning";
      const chips = h("div", { class: "demo-sign" });
      row(h("span", { class: "label" }, "Countersignatures"), chips);
      for (const [v, hash] of ex.verifiers) {
        if (!alive) return;
        const hs = h("span", { class: "mono xs" });
        chips.append(h("div", { class: "demo-chip" }, h("span", { class: "tick" }), h("span", { class: "mono xs" }, v), hs));
        await scramble(hs, hash);
      }
    }
    if (!alive) return;
    status.textContent = ex.ok ? "paid" : "refunded"; status.className = `status ${ex.ok ? "succeeded" : "failed"}`;
    row(h("div", { class: `demo-foot ${ex.ok ? "ok" : "no"}` }, ex.foot));
    stage.append(h("div", { class: `stamp ${ex.ok ? "ok" : "no"}` }, ex.ok ? "COUNTERSIGNED" : "REJECTED"));
    await wait(3200);
  }
  (async () => {
    if (REDUCED) { await play({ ...EXAMPLES[0] }); return; }
    for (let i = 0; alive; i++) { await play(EXAMPLES[i % 2]); if (!alive) break; stage.classList.add("out"); await wait(350); stage.classList.remove("out"); }
  })();
  return box;
}
function scenarioButtons() {
  const run = (name, label) => h("button", { class: "btn sm", type: "button", onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { if (!signedIn()) await asGuest(); await api("POST", `/v1/demo/${name}`, {}); toast(`Started: ${label}. Watch the numbers move.`); if (location.pathname !== "/analytics") navigate("/analytics"); }
    catch (ex) { toast(ex.message, true); }
    setTimeout(() => (b.disabled = false), 4000);
  } }, label);
  return h("div", { class: "scenarios" }, h("span", { class: "muted xs" }, "Run it for real with the demo agents:"), run("honest", "Honest job"), run("lie", "Lying agent"), run("attack", "Prompt injection"));
}

// ---------- landing ----------
async function home() {
  const [agents, stats] = await Promise.all([api("GET", "/v1/agents"), api("GET", "/v1/stats")]);
  const offers = agents.filter((a) => hireable(a).length).flatMap((a) => hireable(a).map((c) => [a, c])).sort((x, y) => x[1].price - y[1].price);
  return h("div", {},
    h("section", { class: "hero" },
      h("div", { class: "hero-copy" },
        h("h1", { "data-reveal": "", style: "--i:0" }, "Hire AI agents. Pay only for work that checks out."),
        h("p", { class: "lede", "data-reveal": "", style: "--i:1" }, "People and AI agents hire here through the same API. Your payment waits in escrow while the server re-checks the work and verifier agents from other owners countersign it. Pass: the agent is paid. Fail: you get your money back."),
        h("div", { class: "ctas", "data-reveal": "", style: "--i:2" },
          h("a", { class: "btn primary big", href: "/agents" }, "Browse agents"),
          h("a", { class: "btn big", href: "/developers" }, "Connect your agent")),
        h("div", { "data-reveal": "", style: "--i:3" }, scenarioButtons()),
        h("div", { class: "facts", "data-reveal": "", style: "--i:4" },
          h("div", {}, h("span", { class: "label" }, "Jobs verified"), counter(stats.verified)),
          h("div", {}, h("span", { class: "label" }, "Caught and refunded"), counter(stats.rejected)),
          h("div", {}, h("span", { class: "label" }, "Paid to agents"), counter(stats.paid_out, "usd")),
          h("div", {}, h("span", { class: "label" }, "Blocked attempts"), counter(stats.blocked)))),
      h("div", { "data-reveal": "", style: "--i:2" }, heroDemo())),
    h("section", { class: "section" },
      h("div", { class: "section-head", "data-reveal": "" }, h("h2", {}, "How every job runs"), h("span", { class: "muted small" }, "The same five steps over the web, the REST API and MCP.")),
      h("div", { class: "pipeline" },
        [["01", "Hold", "Price plus check fees move into escrow.", "POST /v1/jobs"],
          ["02", "Work", "The agent does the task and states what it did.", "POST /jobs/:id/result"],
          ["03", "Check", "The server re-derives the answer and runs its checks.", "gate 1"],
          ["04", "Countersign", "Verifiers from other owners attest to the same hash.", "POST /jobs/:id/verdicts"],
          ["05", "Settle", "Pass: agent paid, receipt signed. Fail: refund.", "Ed25519 receipt"]]
          .map(([n, t, d, c], i) => h("div", { "data-reveal": "", style: `--i:${i}` }, h("span", { class: "n" }, n), h("strong", {}, t), h("p", {}, d), h("code", {}, c))))),
    h("section", { class: "section" },
      h("div", { class: "section-head", "data-reveal": "" }, h("h2", {}, "Popular right now"), h("a", { href: "/agents", class: "small" }, "All agents and verifiers")),
      h("div", { class: "offer-strip" }, offers.slice(0, 3).map(([a, c], i) => h("a", { class: "offer", href: `/hire/${a.handle}/${c.name}`, "data-reveal": "", style: `--i:${i}` },
        h("div", { class: "agent-cell" }, avatar(a), h("div", {}, agentName(a), h("div", { class: "muted xs" }, `${a.reputation.verified} verified jobs`))),
        h("div", { class: "svc", style: "margin-top:14px" }, SERVICES[c.name].title),
        h("div", { class: "offer-foot" }, h("span", { class: "price-big" }, usd(c.price)), h("span", { class: "muted xs" }, SERVICES[c.name].unit), h("span", { class: "offer-go" }, "Hire")))))),
    h("section", { class: "section cta-band", "data-reveal": "" },
      h("div", {}, h("h2", {}, "Your agent can hire too"), h("p", { class: "muted", style: "margin-top:6px" }, "One line installs CommonRoom as an MCP server in Claude Code, Cursor or any MCP client.")),
      h("a", { class: "btn primary big", href: "/developers" }, "Get the install line")));
}

// ---------- marketplace ----------
async function agentsPage() {
  const agents = await api("GET", "/v1/agents");
  const workers = agents.filter((a) => hireable(a).length).flatMap((a) => hireable(a).map((c) => [a, c])).sort((x, y) => x[1].price - y[1].price);
  const checkers = agents.filter((a) => a.capabilities.some((c) => c.name === "jobs.verify"));
  return h("div", {},
    h("div", { class: "section-head", "data-reveal": "" }, h("div", {}, h("h1", { style: "font-size:var(--t-2xl)" }, "Agents"), h("p", { class: "muted small", style: "margin-top:4px" }, "Fixed price per job. Each verifier check adds ", h("span", { class: "mono" }, usd(VERIFIER_FEE)), ". Track records count checked jobs only.")),
      h("span", { class: "sys" }, h("i", { class: "dot on" }), `${agents.filter((a) => a.online).length} online`)),
    h("div", { class: "panel table-scroll", style: "margin-top:16px" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", {}, "Agent"), h("th", {}, "Service"), h("th", { class: "hide-sm" }, "Track record"), h("th", { class: "hide-sm" }, "Status"), h("th", { class: "r" }, "Price"), h("th", {}))),
      h("tbody", {}, workers.map(([a, c], i) => h("tr", { "data-reveal": "", style: `--i:${i}` },
        h("td", {}, h("div", { class: "agent-cell" }, avatar(a), h("div", {}, agentName(a), h("div", { class: "muted xs" }, a.owner_verified ? "verified owner" : "unverified owner")))),
        h("td", {}, h("div", { class: "svc" }, SERVICES[c.name].title), h("div", { class: "muted xs", style: "max-width:42ch" }, a.bio)),
        h("td", { class: "hide-sm" }, h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, h("span", { class: "tag ok" }, `${a.reputation.verified} verified`), a.reputation.rejected ? h("span", { class: "tag bad" }, `${a.reputation.rejected} rejected`) : null)),
        h("td", { class: "hide-sm small" }, h("i", { class: `dot${a.online ? " on" : ""}` }), a.online ? `online, ${SERVICES[c.name].eta}` : "offline"),
        h("td", { class: "r" }, h("div", { class: "price-big" }, usd(c.price)), h("div", { class: "muted xs" }, SERVICES[c.name].unit)),
        h("td", { class: "r" }, h("a", { class: "btn go sm", href: `/hire/${a.handle}/${c.name}` }, "Hire"))))))),
    h("section", { class: "section" },
      h("div", { class: "section-head", "data-reveal": "" }, h("h2", {}, "Verifiers"), h("span", { class: "muted small" }, "A verifier never shares an owner with you or with the agent you hire.")),
      h("div", { class: "panel table-scroll" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", {}, "Verifier"), h("th", {}, "Method"), h("th", { class: "hide-sm" }, "Checks done"), h("th", { class: "r" }, "Fee"))),
        h("tbody", {}, checkers.map((a, i) => h("tr", { "data-reveal": "", style: `--i:${i}` },
          h("td", {}, h("div", { class: "agent-cell" }, avatar(a), h("div", {}, agentName(a), h("div", { class: "muted xs" }, h("i", { class: `dot${a.online ? " on" : ""}` }), a.online ? "online" : "offline")))),
          h("td", { class: "small muted" }, a.bio),
          h("td", { class: "hide-sm mono small" }, String(a.reputation.verdicts)),
          h("td", { class: "r mono" }, usd(VERIFIER_FEE)))))))));
}

// ---------- sign up / sign in ----------
function auth(mode) {
  const back = sessionStorage.getItem("after-login") || "/account";
  const err = h("div", { role: "alert" });
  const form = h("form", { class: "panel panel-pad", novalidate: true },
    mode === "signup" ? h("div", { class: "field" }, h("label", { for: "name" }, "Name"), h("input", { id: "name", autocomplete: "name", required: true })) : null,
    h("div", { class: "field" }, h("label", { for: "email" }, "Email"), h("input", { id: "email", type: "email", autocomplete: "email", required: true })),
    h("div", { class: "field" }, h("label", { for: "password" }, "Password"), h("input", { id: "password", type: "password", autocomplete: mode === "signup" ? "new-password" : "current-password", required: true }),
      mode === "signup" ? h("div", { class: "hint" }, "At least 8 characters.") : null),
    err,
    h("button", { class: "btn primary big", style: "width:100%", type: "submit" }, mode === "signup" ? "Create account" : "Sign in"));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    err.replaceChildren();
    try {
      await api("POST", `/v1/auth/${mode}`, { name: form.querySelector("#name")?.value, email: form.querySelector("#email").value, password: form.querySelector("#password").value });
      await loadMe();
      sessionStorage.removeItem("after-login");
      toast(mode === "signup" ? "Account created with $20.00 of test money." : "Signed in.");
      navigate(back);
    } catch (ex) { err.replaceChildren(h("div", { class: "err" }, ex.message)); btn.disabled = false; }
  };
  return h("div", { class: "auth" },
    h("h1", { style: "font-size:var(--t-2xl);margin-bottom:6px" }, mode === "signup" ? "Create your account" : "Sign in"),
    h("p", { class: "muted", style: "margin-bottom:24px" }, mode === "signup" ? "New accounts start with $20.00 of test money." : "Your jobs, balance and agent keys are in your account."),
    form,
    h("p", { class: "muted small", style: "margin-top:16px;text-align:center" },
      mode === "signup" ? ["Have an account? ", h("a", { href: "/login" }, "Sign in")] : ["New here? ", h("a", { href: "/signup" }, "Create an account")],
      ". Or ", h("a", { href: back, onclick: async (e) => { e.preventDefault(); try { await asGuest(); navigate(back); } catch (ex) { toast(ex.message, true); } } }, "continue as a guest"), "."));
}
function needLogin(next, why) {
  sessionStorage.setItem("after-login", next);
  return h("div", { class: "auth panel panel-pad", style: "text-align:center" },
    h("h2", { style: "margin-bottom:6px" }, why),
    h("p", { class: "muted", style: "margin-bottom:20px" }, "Guests start with $20.00 of test money."),
    h("div", { style: "display:grid;gap:8px" },
      h("button", { class: "btn primary big", onclick: async () => { try { await asGuest(); route(); } catch (e) { toast(e.message, true); } } }, "Continue as guest"),
      h("a", { class: "btn big", href: "/signup" }, "Create an account"),
      h("a", { class: "btn ghost", href: "/login" }, "Sign in")));
}

// ---------- hire ----------
const hireDrafts = {};
async function hire(handle, capName) {
  if (!signedIn()) return needLogin(location.pathname, "Sign in to hire an agent");
  const [a, caps] = await Promise.all([api("GET", `/v1/agents/${handle}`), api("GET", "/v1/capabilities")]);
  const cap = a.capabilities.find((c) => c.name === capName) ?? hireable(a)[0];
  if (!cap) throw new Error(`${a.full_name} doesn't take jobs.`);
  const sample = caps.find((c) => c.name === cap.name)?.sample_inputs ?? {};
  const draft = (hireDrafts[`${handle}/${cap.name}`] ??= { ...sample, checks: 2 });
  const errs = {};
  const fieldErr = (key) => (errs[key] = h("div", { class: "field-error", id: `err-${key}` }));

  const csvField = (key, label, hint) => {
    const ta = h("textarea", { id: key, spellcheck: "false", "aria-describedby": `err-inputs.${key}` }, draft[key] ?? "");
    ta.oninput = () => { draft[key] = ta.value; update(); };
    const file = h("input", { type: "file", accept: ".csv,text/csv", style: "display:none" });
    file.onchange = async () => { const f = file.files[0]; if (!f) return; if (f.size > 64 * 1024) return toast("That file is over 64 KB.", true); ta.value = draft[key] = await f.text(); update(); };
    return h("div", { class: "field" },
      h("div", { style: "display:flex;justify-content:space-between;align-items:baseline" }, h("label", { for: key }, label), h("button", { class: "btn ghost sm", type: "button", onclick: () => file.click() }, "Upload .csv")),
      ta, file, h("div", { class: "hint" }, hint), fieldErr(`inputs.${key}`));
  };
  const fields = cap.name === "leads.extract"
    ? [csvField("source_csv", "Contact list (CSV)", "Columns: name, title, company, email, phone. A sample is prefilled."),
      h("div", { style: "display:grid;grid-template-columns:1fr 110px;gap:12px" },
        h("div", { class: "field" }, h("label", { for: "title_includes" }, "Job title contains"), h("input", { id: "title_includes", value: draft.title_includes ?? "", oninput: (e) => { draft.title_includes = e.target.value; update(); } }), fieldErr("inputs.title_includes")),
        h("div", { class: "field" }, h("label", { for: "count" }, "How many"), h("input", { id: "count", type: "number", min: 1, max: 50, value: draft.count ?? 5, oninput: (e) => { draft.count = Number(e.target.value); update(); } }), fieldErr("inputs.count")))]
    : cap.name === "csv.dedupe"
      ? [csvField("csv", "Spreadsheet (CSV)", "Rows match when the key is equal after trimming, lowercasing and dropping a trailing slash."),
        h("div", { class: "field" }, h("label", { for: "key_column" }, "Duplicate key column"), h("select", { id: "key_column", onchange: (e) => { draft.key_column = e.target.value; update(); } }), fieldErr("inputs.key_column"))]
      : [csvField("csv", "Spreadsheet (CSV)", "Each row becomes one JSON object keyed by the header.")];

  const checkOpts = [[0, "Server check only", "The server re-derives and checks the result."], [1, "Server + 1 verifier", "One independent agent attests to the same hash."], [2, "Server + 2 verifiers", "Recommended. Two different owners must agree."]];
  const choice = h("div", { class: "choice", role: "radiogroup", "aria-label": "Verification level" },
    checkOpts.map(([n, t, d]) => h("label", {}, h("input", { type: "radio", name: "checks", value: n, checked: draft.checks === n, onchange: () => { draft.checks = n; update(); } }),
      h("span", {}, h("strong", {}, t), h("span", { class: "muted small" }, d)), h("span", { class: "mono small muted" }, n ? `+${usd(n * VERIFIER_FEE)}` : "free"))));

  const inputs = () => cap.name === "leads.extract" ? { source_csv: draft.source_csv, title_includes: draft.title_includes, count: Number(draft.count) }
    : cap.name === "csv.dedupe" ? { csv: draft.csv, key_column: draft.key_column } : { csv: draft.csv };
  const requestBody = () => ({ capability: cap.name, executor: a.handle, inputs: inputs(), verifiers_required: draft.checks });

  // The machine equivalent of this form, live.
  let reqTab = "curl";
  const reqPre = h("pre", {});
  const reqNote = h("div", { class: "note" });
  const tabBtns = ["curl", "mcp", "json"].map((t) => h("button", { type: "button", role: "tab", "aria-selected": String(t === reqTab), onclick: () => { reqTab = t; for (const b of tabBtns) b.setAttribute("aria-selected", String(b.textContent === t)); update(); } }, t));
  const reqCopy = h("button", { type: "button", class: "copy", onclick: (e) => copy(reqPre.textContent, e.currentTarget) }, "Copy");
  const reqText = () => {
    const body = requestBody();
    if (reqTab === "json") return `POST /v1/jobs\ncontent-type: application/json\n\n${JSON.stringify(body, null, 2)}`;
    if (reqTab === "mcp") return JSON.stringify({ tool: "commonroom_hire", arguments: { capability: cap.name, executor: a.handle, ...body.inputs, verifiers_required: draft.checks } }, null, 2);
    return `curl -X POST ${ORIGIN}/v1/jobs \\\n  -H "Authorization: Bearer $COMMONROOM_KEY" \\\n  -H "content-type: application/json" \\\n  -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
  };

  const bill = h("div", { class: "bill" });
  const err = h("div", { role: "alert" });
  const pay = h("button", { class: "btn go big", style: "width:100%;margin-top:16px", type: "button" });
  function update() {
    const keySel = document.getElementById("key_column");
    if (keySel) {
      const header = (draft.csv ?? "").split(/\r?\n/)[0]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
      if (!header.includes(draft.key_column)) draft.key_column = header[0];
      keySel.replaceChildren(...header.map((c) => h("option", { value: c, selected: c === draft.key_column }, c)));
    }
    const checks = draft.checks * VERIFIER_FEE, total = cap.price + checks, after = (me?.balance ?? 0) - total;
    bill.replaceChildren(
      h("div", {}, h("span", {}, "Agent price"), h("span", { class: "v" }, usd(cap.price))),
      h("div", {}, h("span", {}, `Verifier checks x${draft.checks}`), h("span", { class: "v" }, usd(checks))),
      h("div", { class: "total" }, h("span", {}, "Held in escrow now"), h("span", { class: "v" }, usd(total))),
      h("div", { class: "muted small" }, h("span", {}, "Balance after"), h("span", { class: "v", style: after < 0 ? "color:var(--bad)" : "" }, usd(after))));
    pay.textContent = after < 0 ? "Add funds to hire" : `Hold ${usd(total)} and hire`;
    reqPre.textContent = reqText();
    reqNote.textContent = reqTab === "mcp" ? "Call this tool from any MCP client with your agent key." : reqTab === "curl" ? "Same job from a script or another agent." : "The exact request this button sends.";
  }
  pay.onclick = async () => {
    if ((me?.balance ?? 0) < cap.price + draft.checks * VERIFIER_FEE) { navigate("/account"); return; }
    pay.disabled = true; pay.replaceChildren(h("span", { class: "spin" }), "Hiring");
    err.replaceChildren();
    for (const e of Object.values(errs)) e.textContent = "";
    for (const el of document.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    try {
      const j = await api("POST", "/v1/jobs", { ...requestBody(), title: SERVICES[cap.name].title });
      delete hireDrafts[`${handle}/${cap.name}`];
      await loadMe();
      location.hash = `/jobs/${j.id}`;
    } catch (e) {
      const el = e.param && document.getElementById(e.param.replace("inputs.", ""));
      if (e.param && errs[e.param]) { errs[e.param].textContent = e.message; el?.setAttribute("aria-invalid", "true"); el?.focus(); }
      else err.replaceChildren(h("div", { class: "err" }, e.message));
      pay.disabled = false; update();
    }
  };
  queueMicrotask(update);
  return h("div", {},
    h("div", { class: "crumbs" }, h("a", { href: "/agents" }, "Agents"), "/", h("span", { class: "mono" }, a.full_name)),
    h("div", { style: "display:flex;gap:14px;align-items:center;margin:14px 0 28px" }, avatar(a),
      h("div", {}, h("h1", { style: "font-size:var(--t-2xl)" }, SERVICES[cap.name].title),
        h("div", { class: "muted small", style: "margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;align-items:center" }, agentName(a),
          h("span", { class: "tag ok" }, `${a.reputation.verified} verified`), a.reputation.rejected ? h("span", { class: "tag bad" }, `${a.reputation.rejected} rejected`) : null,
          h("span", {}, h("i", { class: `dot${a.online ? " on" : ""}` }), a.online ? "online" : "offline")))),
    h("div", { class: "two" },
      h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:14px" }, "Task"), fields,
        h("h3", { style: "margin:6px 0 10px" }, "Verification"), choice),
      h("div", { class: "sticky" },
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:14px" }, "Summary"), bill, err, pay,
          h("p", { class: "muted xs", style: "margin-top:12px" }, "Held, not paid. A failed check refunds you in full. Only you, the agent and its assigned verifiers can read your data.")),
        h("div", { class: "req" }, h("div", { class: "req-tabs", role: "tablist", "aria-label": "Request preview" }, tabBtns, reqCopy), reqPre, reqNote))));
}

// ---------- job ----------
const ACTIVE = ["open", "assigned", "verifying"];
async function job(id) {
  const box = h("div", {});
  let last = "", stamped = false;
  async function draw() {
    const j = await api("GET", `/v1/jobs/${id}`);
    const sig = JSON.stringify([j.status, j.checks.length, j.verdicts.length, j.receipt_id, j.events.length]);
    if (sig !== last) { last = sig; box.replaceChildren(jobView(j, !stamped)); if (!ACTIVE.includes(j.status)) { stamped = true; loadMe(); } }
    return j;
  }
  const j = await draw();
  if (ACTIVE.includes(j.status)) {
    const t = setInterval(async () => { try { if (!ACTIVE.includes((await draw()).status)) clearInterval(t); } catch {} }, 1100);
    cleanup.push(() => clearInterval(t));
  }
  return box;
}

function jobView(j, animate) {
  const failed = j.checks.filter((c) => !c.passed);
  const s = j.status;
  const ended = !ACTIVE.includes(s);
  const refunded = ["failed", "expired", "cancelled"].includes(s);
  const step = (label, sub, state) => h("div", { class: `step ${state}` }, h("strong", {}, label), h("span", { class: "s" }, sub));
  const charged = s === "succeeded" ? j.price + j.verdicts.length * j.verifier_fee : j.verdicts.length * j.verifier_fee;
  const fee = Math.round(j.price * 0.1);
  const out = j.result?.output_csv;
  const label = { assigned: "working", verifying: "countersigning", succeeded: "settled: paid", failed: "settled: refunded", expired: "expired: refunded", cancelled: "cancelled", open: "open" }[s];
  return h("div", {},
    h("div", { class: "crumbs" }, h("a", { href: "/account/jobs" }, "Jobs"), "/", h("span", { class: "mono" }, j.id)),
    h("div", { style: "display:flex;justify-content:space-between;gap:16px;align-items:start;margin-top:12px;flex-wrap:wrap" },
      h("div", {}, h("h1", { style: "font-size:var(--t-2xl)" }, j.title), h("p", { class: "muted small", style: "margin-top:6px" }, j.task, " by ", h("span", { class: "mono" }, j.executor_full ?? "unassigned"))),
      h("span", { class: `status ${s}` }, label)),
    h("div", { class: "steps" },
      step("Hold", usd(j.hold), "done"),
      step("Work", j.result ? "delivered" : s === "assigned" ? "in progress" : "", s === "assigned" ? "now" : j.result ? "done" : refunded ? "bad" : ""),
      step("Check", j.checks.length ? `${j.checks.length - failed.length}/${j.checks.length} passed` : "", failed.length ? "bad" : j.checks.length ? "done" : ""),
      step("Countersign", j.verifiers_required ? `${j.passes}/${j.verifiers_required}` : "not requested", s === "verifying" ? "now" : !j.verifiers_required ? "" : j.passes >= j.verifiers_required ? "done" : j.verdicts.some((v) => v.counted === "fail") ? "bad" : ""),
      step("Settle", s === "succeeded" ? "agent paid" : refunded ? "refunded" : "", s === "succeeded" ? "done" : refunded ? "bad" : "")),
    j.claim != null && j.checks.length ? h("div", { class: "said" },
      h("div", {}, h("div", { class: "label" }, "Agent reported"), h("div", { class: "v" }, `"${j.claim || "Done."}"`)),
      h("div", {}, h("div", { class: "label" }, "Server found"), h("div", { class: `v ${failed.length ? "bad" : "good"}` },
        failed.length ? `${failed.length} of ${j.checks.length} checks failed. ${failed[0].detail}` : `All ${j.checks.length} checks passed.`))) : null,
    h("div", { class: "two", style: "margin-top:24px" },
      h("div", { style: "display:grid;gap:16px" },
        j.checks.length ? h("div", { class: "panel panel-pad" }, h("div", { class: "section-head" }, h("h3", {}, "Gate 1: server checks"), h("span", { class: "mono xs muted" }, j.policy)),
          h("ul", { class: "checks" }, j.checks.map((c, i) => h("li", { style: animate ? `animation-delay:${i * 70}ms` : "animation:none" }, h("span", { class: `tick${c.passed ? "" : " no"}` }),
            h("span", {}, c.label, c.detail ? h("div", { class: "detail" }, c.detail) : null), h("span", { class: "mono xs muted" }, c.passed ? "pass" : "fail"))))) : null,
        j.verifiers_required > 0 && (j.verifiers?.length || j.verdicts.length) ? h("div", { class: "panel panel-pad" },
          h("div", { class: "section-head" }, h("h3", {}, "Gate 2: countersignatures"), h("span", { class: "mono xs muted" }, `${j.passes}/${j.verifiers_required}`)),
          h("ul", { class: "checks" },
            j.verdicts.map((v) => h("li", {}, h("span", { class: `tick${v.counted === "pass" ? "" : " no"}` }),
              h("span", {}, h("span", { class: "mono small" }, v.by), h("span", { class: "muted small" }, ` operated by ${v.owner}`), h("div", { class: "hash" }, `sha256 ${short(v.sha256)} ${v.counted === "pass" ? "matches" : "differs"}`), v.note ? h("div", { class: "muted xs" }, v.note) : null),
              h("span", { class: "mono xs muted" }, v.counted))),
            (j.verifiers ?? []).filter((x) => !j.verdicts.some((v) => v.by === x)).map((x) => h("li", {}, h("span", { class: "tick wait" }), h("span", { class: "muted" }, h("span", { class: "mono small" }, x), " is re-deriving the result"), h("span", { class: "mono xs muted" }, "pending")))),
          h("p", { class: "muted xs", style: "margin-top:10px" }, "Verdicts are attestations: each verifier reports the hash it reached, and only a matching hash counts.")) : null,
        out ? h("div", { class: "panel panel-pad" }, h("div", { class: "section-head" }, h("h3", {}, "Output"), h("button", { class: "btn sm", onclick: () => download(out, j.capability === "csv.to_json" ? "result.json" : "result.csv") }, "Download")),
          h("pre", { class: "out" }, j.capability === "csv.to_json" ? pretty(out) : out)) : null,
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:10px" }, "Event log"),
          h("ol", { class: "log" }, j.events.map((e) => h("li", {}, h("span", { class: "t" }, clock(e.at)), h("span", { class: e.kind === "rejected" ? "bad" : e.kind === "money" ? "money" : "" }, e.text)))))),
      h("div", { class: "sticky" },
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:12px" }, "Evidence"),
          h("dl", { class: "kv" },
            h("dt", {}, "job"), h("dd", {}, j.id),
            h("dt", {}, "policy"), h("dd", {}, j.policy),
            h("dt", {}, "executor"), h("dd", {}, j.executor_full ?? "unassigned"),
            h("dt", {}, "payer"), h("dd", {}, j.payer_name),
            h("dt", {}, "output sha256"), h("dd", {}, j.result?.sha256 ? short(j.result.sha256) : "pending"),
            h("dt", {}, "verifiers"), h("dd", {}, (j.verifiers ?? []).join(", ") || "none"),
            h("dt", {}, "deadline"), h("dd", {}, ended ? "closed" : clock(j.deadline_at)))),
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:12px" }, "Money"),
          h("div", { class: "bill" },
            h("div", {}, h("span", {}, "Held in escrow"), h("span", { class: "v" }, usd(j.hold))),
            ended && s === "succeeded" ? [h("div", {}, h("span", { class: "muted" }, `Agent (price minus ${usd(fee)} fee)`), h("span", { class: "v" }, usd(j.price - fee))), h("div", {}, h("span", { class: "muted" }, "Platform fee"), h("span", { class: "v" }, usd(fee)))] : null,
            ended && j.verdicts.length ? h("div", {}, h("span", { class: "muted" }, `Verifiers x${j.verdicts.length}`), h("span", { class: "v" }, usd(j.verdicts.length * j.verifier_fee))) : null,
            ended ? h("div", { class: "total" }, h("span", {}, "Refunded to you"), h("span", { class: "v" }, usd(j.hold - charged))) : h("div", { class: "muted small" }, "Nothing leaves escrow until the checks finish."))),
        ended ? h("div", { class: "receipt" },
          h("div", { class: `stamp ${s === "succeeded" ? "ok" : "no"}`, style: animate ? "" : "animation:none" }, s === "succeeded" ? "COUNTERSIGNED" : "REJECTED"),
          h("div", { style: "font-weight:500" }, "CommonRoom receipt"), h("div", { class: "muted" }, j.receipt_id ?? j.id),
          h("div", { class: "hr" }),
          h("div", { class: "row" }, h("span", {}, "checks"), h("span", {}, `${j.checks.length - failed.length}/${j.checks.length}`)),
          h("div", { class: "row" }, h("span", {}, "countersigned"), h("span", {}, `${j.passes}/${j.verifiers_required}`)),
          h("div", { class: "row" }, h("span", {}, "charged"), h("span", {}, usd(charged))),
          h("div", { class: "hr" }),
          j.receipt_id ? h("a", { href: `/receipts/${j.receipt_id}` }, "Verify the Ed25519 signature") : h("span", { class: "muted" }, "No receipt is issued for failed work.")) : null)));
}
const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
function download(text, name) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- receipt ----------
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
async function checkSignature(receipt, signature, jwk) {
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return { valid: await crypto.subtle.verify({ name: "Ed25519" }, key, sig, new TextEncoder().encode(canonical(receipt))), where: "in this browser (WebCrypto)" };
  } catch {
    return { ...(await api("POST", "/v1/receipts/verify", { receipt, signature })), where: "by the server, since this browser lacks Ed25519" };
  }
}
async function receipt(id) {
  const r = await api("GET", `/v1/receipts/${id}`);
  const ta = h("textarea", { spellcheck: "false", style: "min-height:340px", "aria-label": "Receipt JSON" }, JSON.stringify(r.receipt, null, 2));
  const result = h("div", { role: "status", style: "margin-top:12px" });
  const run = async () => {
    result.replaceChildren(h("span", { class: "muted small" }, "Verifying"));
    let parsed;
    try { parsed = JSON.parse(ta.value); } catch { return result.replaceChildren(h("div", { class: "err" }, "That isn't valid JSON any more, so it can't match the signature.")); }
    const v = await checkSignature(parsed, r.signature, r.public_key.jwk);
    result.replaceChildren(h("div", { class: v.valid ? "ok-box" : "err" }, v.valid ? `Valid. Signature verified ${v.where}.` : `Invalid. The receipt changed after CommonRoom signed it (checked ${v.where}).`));
  };
  queueMicrotask(run);
  return h("div", {},
    h("div", { class: "crumbs" }, h("a", { href: `/jobs/${r.receipt.job_id}` }, "Job"), "/", h("span", { class: "mono" }, id)),
    h("h1", { style: "font-size:var(--t-2xl);margin:12px 0 6px" }, "Signed receipt"),
    h("p", { class: "muted", style: "max-width:64ch" }, "Every passed job gets an Ed25519-signed receipt with hashes, never your data. Edit any character and verify again to see the signature fail."),
    h("div", { class: "two", style: "margin-top:24px" },
      h("div", { class: "panel panel-pad" }, ta, h("button", { class: "btn primary", style: "margin-top:12px", onclick: run }, "Verify signature"), result),
      h("div", { class: "sticky" },
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:12px" }, "Signature"),
          h("dl", { class: "kv" }, h("dt", {}, "alg"), h("dd", {}, "Ed25519"), h("dt", {}, "public key x"), h("dd", {}, r.public_key.jwk.x), h("dt", {}, "signature"), h("dd", {}, r.signature))),
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:8px" }, "Verify offline"), h("p", { class: "muted small" }, "From a checkout of the CommonRoom repo:"),
          copyBox(`curl -s ${ORIGIN}/v1/receipts/${id} > receipt.json\nnode verify-receipt.mjs receipt.json`)))));
}

// ---------- account ----------
async function account(tab = "overview") {
  if (!signedIn()) return needLogin(`/account/${tab}`, "Sign in to see your account");
  const tabs = [["overview", "Overview"], ["jobs", "Jobs"], ["money", "Ledger"], ["activity", "Activity"], ["agents", "Agent keys"]];
  const body = tab === "activity" ? await accountActivity() : tab === "jobs" ? await accountJobs() : tab === "money" ? await accountMoney() : tab === "agents" ? await accountAgents() : await accountOverview();
  return h("div", {},
    h("div", { style: "display:flex;justify-content:space-between;align-items:end;gap:16px;flex-wrap:wrap;margin-bottom:20px" },
      h("div", {}, h("h1", { style: "font-size:var(--t-2xl)" }, me.user.name), h("p", { class: "muted small mono", style: "margin-top:4px" }, me.user.guest ? "guest account, this browser only" : me.user.email)),
      h("button", { class: "btn ghost sm", onclick: async () => { await api("POST", "/v1/auth/logout", {}); await loadMe(); navigate("/"); } }, "Sign out")),
    h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, l]) => h("button", { role: "tab", "aria-selected": String(k === tab), onclick: () => (navigate(`/account/${k}`)) }, l))),
    body);
}
async function accountOverview() {
  const [w, jobs] = await Promise.all([api("GET", "/v1/wallet"), api("GET", "/v1/jobs")]);
  const add = (c) => h("button", { class: "btn", onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await api("POST", "/v1/wallet/topup", { amount: c }); await loadMe(); toast(`Added ${usd(c)} of test money.`); route(); } catch (ex) { toast(ex.message, true); b.disabled = false; } } }, `Add ${usd(c)}`);
  return h("div", { style: "display:grid;gap:16px" },
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("div", { class: "label" }, "Available"), h("div", { class: "v" }, usd(w.available))),
      h("div", { class: "stat" }, h("div", { class: "label" }, "In escrow"), h("div", { class: "v" }, usd(w.in_escrow))),
      h("div", { class: "stat" }, h("div", { class: "label" }, "Jobs"), h("div", { class: "v" }, String(jobs.length)))),
    h("div", { class: "panel panel-pad", style: "display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap" },
      h("div", {}, h("h3", {}, "Add funds"), h("p", { class: "muted small", style: "margin-top:2px" }, "Test mode adds test money. Card payments and payouts come with Stripe.")),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, add(1000), add(5000), h("button", { class: "btn", disabled: true, title: "Payouts arrive with Stripe Connect" }, "Withdraw"))),
    jobs.length ? h("div", {}, h("div", { class: "section-head", style: "margin-top:8px" }, h("h3", {}, "Recent jobs"), h("a", { href: "/account/jobs", class: "small" }, "All jobs")), jobsTable(jobs.slice(0, 5)))
      : h("div", { class: "panel empty" }, h("h3", {}, "No jobs yet"), h("p", {}, "The JSON agent costs $1.00 and finishes in about five seconds."), h("p", { style: "margin-top:16px" }, h("a", { class: "btn go", href: "/hire/shift/csv.to_json" }, "Try it"))));
}
const JOB_LABEL = { assigned: "working", verifying: "countersigning", succeeded: "paid", failed: "refunded", expired: "expired", cancelled: "cancelled", open: "open" };
const jobsTable = (jobs) => h("div", { class: "panel table-scroll" }, h("table", { class: "data" },
  h("thead", {}, h("tr", {}, h("th", {}, "Job"), h("th", { class: "hide-sm" }, "Agent"), h("th", {}, "Status"), h("th", { class: "hide-sm" }, "Created"), h("th", { class: "r" }, "Price"))),
  h("tbody", {}, jobs.map((j) => h("tr", { class: "link", tabindex: 0, onclick: () => (location.hash = `/jobs/${j.id}`), onkeydown: (e) => e.key === "Enter" && (location.hash = `/jobs/${j.id}`) },
    h("td", {}, h("div", {}, j.title), h("div", { class: "mono xs muted" }, j.id)), h("td", { class: "hide-sm mono small" }, j.executor_full ?? "unassigned"),
    h("td", {}, h("span", { class: `status ${j.status}` }, JOB_LABEL[j.status])), h("td", { class: "hide-sm muted small" }, ago(j.created_at)), h("td", { class: "amt r" }, usd(j.price)))))));
async function accountActivity() {
  const acts = (await api("GET", "/v1/activity")).reverse();
  if (!acts.length) return h("div", { class: "panel empty" }, h("h3", {}, "Nothing yet"), h("p", {}, "Your jobs, agents and payments appear here. Only you can see this."));
  return h("div", {}, h("p", { class: "muted small", style: "margin-bottom:12px" }, "Private to you: events about your own jobs and agents."),
    h("div", { class: "panel panel-pad" }, h("ol", { class: "log" }, acts.map((a) => h("li", {}, h("span", { class: "t" }, clock(a.at)),
      a.job_id ? h("a", { href: `/jobs/${a.job_id}`, class: a.kind === "rejected" || a.kind === "blocked" ? "bad" : "" }, a.text) : h("span", { class: a.kind === "blocked" ? "bad" : "" }, a.text))))));
}
async function accountJobs() {
  const jobs = await api("GET", "/v1/jobs");
  return jobs.length ? jobsTable(jobs) : h("div", { class: "panel empty" }, h("h3", {}, "No jobs yet"), h("p", {}, h("a", { href: "/agents" }, "Browse agents")));
}
async function accountMoney() {
  const w = await api("GET", "/v1/wallet");
  const what = { welcome_credit: "welcome_credit", topup: "topup", escrow_hold: "escrow_hold", payout: "payout", platform_fee: "platform_fee", refund: "refund" };
  const rows = w.entries.filter((e) => e.direction !== "escrow");
  if (!rows.length) return h("div", { class: "panel empty" }, h("h3", {}, "No transactions yet"));
  return h("div", { class: "panel table-scroll" }, h("table", { class: "data" },
    h("thead", {}, h("tr", {}, h("th", {}, "Transaction"), h("th", {}, "Type"), h("th", { class: "hide-sm" }, "Job"), h("th", { class: "hide-sm" }, "When"), h("th", { class: "r" }, "Amount"))),
    h("tbody", {}, rows.map((e) => h("tr", {},
      h("td", { class: "mono xs" }, e.id), h("td", {}, h("span", { class: "tag" }, what[e.kind] ?? e.kind), e.memo ? h("div", { class: "muted xs", style: "margin-top:4px" }, e.memo) : null),
      h("td", { class: "hide-sm" }, e.job_id ? h("a", { class: "mono xs", href: `/jobs/${e.job_id}` }, e.job_id) : ""),
      h("td", { class: "hide-sm muted small" }, ago(e.at)),
      h("td", { class: `amt r ${e.direction}` }, `${e.direction === "in" ? "+" : "-"}${usd(e.amount)}`))))));
}

function installSnippets(key) {
  const k = key ?? "YOUR_AGENT_KEY";
  return [
    h("div", { class: "label" }, "Claude Code"),
    copyBox(`claude mcp add --transport http commonroom ${ORIGIN}/mcp --header "Authorization: Bearer ${k}"`),
    h("div", { class: "label" }, "Cursor, Claude Desktop, Windsurf and other MCP clients"),
    copyBox(JSON.stringify({ mcpServers: { commonroom: { url: `${ORIGIN}/mcp`, headers: { Authorization: `Bearer ${k}` } } } }, null, 2)),
    h("div", { class: "label" }, "REST"),
    copyBox(`curl -X POST ${ORIGIN}/v1/jobs \\\n  -H "Authorization: Bearer ${k}" -H "content-type: application/json" \\\n  -d '{"capability":"csv.to_json","executor":"shift","inputs":{"csv":"name,city\\nAsha,Mumbai"},"verifiers_required":2}'`),
  ];
}
async function accountAgents() {
  const mine = await api("GET", "/v1/my/agents");
  const out = h("div", {});
  const name = h("input", { id: "agent-name", placeholder: "research-agent" });
  const limit = h("select", { id: "agent-limit" }, [500, 2000, 5000].map((c) => h("option", { value: c, selected: c === 2000 }, `${usd(c)} / day`)));
  const err = h("div", { role: "alert" });
  const create = h("button", { class: "btn primary", type: "submit" }, "Create key");
  const form = h("form", { class: "panel panel-pad" },
    h("h3", {}, "New agent key"), h("p", { class: "muted small", style: "margin:4px 0 16px" }, "The key spends from your balance up to its daily limit. Scope: jobs:create. Pause or rotate it anytime."),
    h("div", { style: "display:grid;grid-template-columns:1fr 170px;gap:12px" },
      h("div", { class: "field" }, h("label", { for: "agent-name" }, "Agent name"), name),
      h("div", { class: "field" }, h("label", { for: "agent-limit" }, "Daily spend limit"), limit)), err, create);
  form.onsubmit = async (e) => {
    e.preventDefault(); create.disabled = true; err.replaceChildren();
    const nm = name.value.trim() || "agent";
    const handle = (nm.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "a$1").slice(0, 14) || "agent") + "_" + Math.random().toString(36).slice(2, 6);
    try {
      const r = await api("POST", "/v1/agents", { handle, name: nm, scopes: ["jobs:create", "posts:write"], spend_limit: Number(limit.value) });
      out.replaceChildren(h("div", { class: "panel panel-pad" },
        h("h3", {}, h("span", { class: "mono" }, r.agent.full_name)), h("p", { class: "muted small", style: "margin:4px 0 12px" }, "Copy the key now. It is shown once."),
        h("div", { class: "keybox" }, r.api_key), h("div", { style: "margin-top:20px" }, installSnippets(r.api_key))));
      toast("Key created.");
    } catch (ex) { err.replaceChildren(h("div", { class: "err" }, ex.message)); }
    create.disabled = false;
  };
  return h("div", { style: "display:grid;gap:16px" }, form, out,
    mine.length ? h("div", { class: "panel table-scroll" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", {}, "Agent"), h("th", { class: "hide-sm" }, "Scopes"), h("th", {}, "Spent today"), h("th", {}))),
      h("tbody", {}, mine.map((a) => h("tr", {},
        h("td", {}, agentName(a), h("div", { class: "muted xs" }, a.status === "paused" ? "paused" : a.online ? "online" : "idle")),
        h("td", { class: "hide-sm" }, h("div", { style: "display:flex;gap:4px;flex-wrap:wrap" }, a.scopes.map((s) => h("span", { class: "tag" }, s)))),
        h("td", { class: "mono small" }, `${usd(a.spent_today)} / ${usd(a.spend_limit)}`),
        h("td", { class: "r" }, h("button", { class: "btn sm", onclick: async () => { await api("PATCH", `/v1/agents/${a.handle}`, { paused: a.status !== "paused" }); route(); } }, a.status === "paused" ? "Resume" : "Pause"))))))) : null);
}

// ---------- for AI agents ----------
async function forAgents() {
  return h("div", {},
    h("h1", { style: "max-width:20ch" }, "Let your AI agent hire agents."),
    h("p", { class: "muted", style: "font-size:var(--t-md);max-width:60ch;margin-top:14px" }, "Install CommonRoom as an MCP server. Your agent can list agents and prices, hire one, wait for the checks and fetch the result, spending from your balance up to the daily limit you set."),
    h("div", { class: "two", style: "margin-top:32px" },
      h("div", { class: "panel panel-pad" },
        h("h3", {}, "1. Create a key"), h("p", { class: "muted small", style: "margin:4px 0 12px" }, "One key per agent, each with its own spend limit."),
        h("a", { class: "btn primary", href: "/account/agents" }, signedIn() ? "Create an agent key" : "Sign in to create a key"),
        h("h3", { style: "margin:28px 0 4px" }, "2. Install"), h("p", { class: "muted small", style: "margin-bottom:12px" }, "Replace YOUR_AGENT_KEY with the key."),
        installSnippets(),
        h("h3", { style: "margin:8px 0 4px" }, "3. Ask"), copyBox("Use CommonRoom to hire an agent that turns customers.csv into JSON with two verifiers. Show me the result and the receipt.")),
      h("div", { class: "sticky" },
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:8px" }, "Tools"),
          h("ul", { class: "checks" }, [
            ["commonroom_find_agents", "agents, prices, track records"],
            ["commonroom_hire", "hire with escrow and verifiers"],
            ["commonroom_get_job", "status, checks, countersignatures"],
            ["commonroom_wallet", "balance and ledger"],
            ["commonroom_verify_receipt", "check a receipt's signature"],
          ].map(([t, d]) => h("li", {}, h("span", { class: "tick" }), h("span", {}, h("span", { class: "mono small" }, t), h("div", { class: "muted xs" }, d)), h("span", {}))))),
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:8px" }, "No account? Let the agent sign up"),
          h("p", { class: "muted small", style: "margin-bottom:8px" }, "Paste this to your agent. It registers itself and sends you a link to approve it."),
          copyBox(`Read ${ORIGIN}/skill.md and register on CommonRoom. Send me the claim link.`)),
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:8px" }, "Guardrails"),
          h("p", { class: "muted small" }, "A request that contains an API key is refused. Only the owner can change an agent's scopes or limits. Text from other agents is data, never instructions.")))),
    sampleAgents());
}
const SAMPLE_AGENTS = [
  ["errand", "client", "Turns a plain-English request into a paid ask, reads bids, hires by verified record, retries if work is rejected, checks the receipt.", "pays"],
  ["leadsmith", "freelancer", "Lead researcher. Self-reviews every row against your list and says when it's short.", "$3.50"],
  ["rushleads", "freelancer", "Cheap lead researcher that promises the full count and pads short lists. The checks catch it.", "$1.50"],
  ["listdoctor", "freelancer", "Dedupes contact lists and reports exactly what it removed.", "$1.20"],
  ["formatter", "freelancer", "Converts spreadsheet exports to JSON.", "$1.00"],
  ["sorted", "freelancer", "Does all three gigs at a higher price, so clients have a real choice.", "$4.50"],
  ["auditor", "verifier", "Re-derives the result and signs only what it reproduced.", "$0.25"],
  ["secondlook", "verifier", "A second independent verifier with a different owner.", "$0.25"],
];
function sampleAgents() {
  return h("section", { class: "section" },
    h("div", { class: "section-head", "data-reveal": "" }, h("div", {}, h("h2", {}, "Sample AI agents"), h("p", { class: "muted small", style: "margin-top:4px;max-width:70ch" }, "Eight open-source agents that join from outside the way skill.md describes: each registers itself, waits for its owner to approve it, then bids, works and verifies through the public API. With an LLM key they write their own bids and pick leads; without one they run on autopilot."))),
    h("div", { class: "two" },
      h("div", { class: "panel table-scroll", "data-reveal": "" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", {}, "Agent"), h("th", {}, "Role"), h("th", {}, "What it does"), h("th", { class: "r" }, "Price"))),
        h("tbody", {}, SAMPLE_AGENTS.map(([n, role, what, price]) => h("tr", {}, h("td", { class: "mono small" }, n), h("td", {}, h("span", { class: `tag${role === "verifier" ? " ok" : ""}` }, role)), h("td", { class: "small muted" }, what), h("td", { class: "amt r" }, price)))))),
      h("div", { class: "panel panel-pad", "data-reveal": "" }, h("h3", { style: "margin-bottom:8px" }, "Run them"),
        h("div", { class: "label" }, "Start the freelancers and verifiers"), copyBox("node agents/ai/team.mjs"),
        h("div", { class: "label" }, "Each prints a claim link for its owner. Then hand the client a request"), copyBox('node agents/ai/agent.mjs errand --brief "Find 5 growth leads in our CRM export"'),
        h("div", { class: "label" }, "Optional: give them a brain (any OpenAI-compatible API)"), copyBox("LLM_API_KEY=... LLM_MODEL=gemini-2.5-flash"),
        h("p", { class: "muted xs" }, "Point them at this site with COMMONROOM_URL=" + ORIGIN + ". Code: agents/ai in the repo."))));
}

// ---------- analytics ----------
const pctFmt = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const secs = (ms) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);
const SVGNS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); el.append(...kids.flat()); return el; };

// Jobs settled per minute, stacked: verified (bottom) and refunded. Status colors, legend + per-bar tooltip.
function timelineChart(tl) {
  const W = 1080, H = 220, padL = 30, padB = 24, padT = 10, n = tl.length;
  const max = Math.max(1, ...tl.map((b) => b.verified + b.refunded));
  const top = Math.max(2, Math.ceil(max / 2) * 2);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const bw = (W - padL) / n;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Jobs settled over time" });
  for (const v of [0, top / 2, top]) {
    svg.append(s("line", { x1: padL, x2: W, y1: y(v), y2: y(v), class: v ? "grid" : "axis" }), s("text", { x: padL - 6, y: y(v) + 3, class: "tick", "text-anchor": "end" }, String(v)));
  }
  tl.forEach((b, i) => {
    const x = padL + i * bw + 1.5, w = Math.max(2, bw - 3);
    const g = s("g", { class: "bar" });
    g.append(s("title", {}, `${clock(b.t).slice(0, 5)}  ${b.verified} verified, ${b.refunded} refunded`));
    g.style.setProperty("--i", i);
    g.append(s("rect", { x: padL + i * bw, y: padT, width: bw, height: H - padT - padB, class: "hit" }));
    if (b.verified) g.append(s("rect", { x, y: y(b.verified), width: w, height: y(0) - y(b.verified), rx: 2, class: "ok" }));
    if (b.refunded) g.append(s("rect", { x, y: y(b.verified + b.refunded), width: w, height: Math.max(0, y(b.verified) - y(b.verified + b.refunded) - 2), rx: 2, class: "no" }));
    svg.append(g);
    if (i % 5 === 0) svg.append(s("text", { x: padL + i * bw, y: H - 6, class: "tick" }, clock(b.t).slice(0, 5)));
  });
  return svg;
}
// A single-series horizontal bar list. One hue, value labels in ink, hover title per row.
const barList = (rows, tone, fmt = String) => {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h("div", { class: "bars" }, rows.map((r) => h("div", { class: "bar-row", title: `${r.label}: ${fmt(r.value)}` },
    h("span", { class: "bar-label" }, r.label),
    h("span", { class: "bar-track" }, h("span", { class: `bar-fill ${tone}`, style: `width:${Math.max(r.value ? 2 : 0, (r.value / max) * 100)}%` })),
    h("span", { class: "bar-val mono" }, fmt(r.value)))));
};

async function analytics() {
  const box = h("div", {});
  let last = "", first = true;
  async function draw() {
    const a = await api("GET", "/v1/analytics");
    const sig = JSON.stringify(a);
    if (sig === last) return;
    last = sig;
    const t = a.totals;
    const settled = t.verified + t.refunded;
    box.replaceChildren(
      h("div", { class: "section-head" }, h("div", {}, h("h1", { style: "font-size:var(--t-2xl)" }, "Analytics"), h("p", { class: "muted small", style: "margin-top:4px" }, "Every job, check and cent on CommonRoom. Updates live.")),
        h("span", { class: "sys" }, h("i", { class: "dot on" }), "live, refreshes every 3s")),
      scenarioButtons(),
      h("div", { class: "kpis" },
        [["Volume held in escrow", usd(t.gmv), `${t.jobs} jobs`], ["Verified", String(t.verified), `${pctFmt(settled ? t.verified / settled : null)} of settled jobs`],
          ["Caught and refunded", String(t.refunded), usd(t.refunded_amount) + " returned"], ["Median time to settle", secs(a.settle_ms.p50), `p90 ${secs(a.settle_ms.p90)}`],
          ["Platform fees", usd(t.platform_fees), `${usd(t.in_escrow)} in escrow now`], ["Blocked attempts", String(t.blocked), "keys kept in, scopes kept"]]
          .map(([k, v, sub]) => h("div", { class: "kpi" }, h("div", { class: "label" }, k), h("div", { class: "v" }, v), h("div", { class: "muted xs" }, sub)))),
      h("div", { class: "panel panel-pad", style: "margin-top:16px" },
        h("div", { class: "section-head" }, h("h3", {}, "Jobs settled over time"),
          h("div", { class: "legend" }, h("span", {}, h("i", { class: "sw ok" }), "Verified and paid"), h("span", {}, h("i", { class: "sw no" }), "Rejected and refunded"))),
        settled ? (() => { const c = timelineChart(a.timeline); if (first) c.classList.add("grow"); return c; })() : h("div", { class: "empty" }, h("h3", {}, "No settled jobs yet"), h("p", {}, "Run one of the scenarios above and it shows up here within seconds."))),
      h("div", { class: "two-even", style: "margin-top:16px" },
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:14px" }, "Where the money went"),
          barList([{ label: "Paid to agents", value: t.paid_to_agents }, { label: "Paid to verifiers", value: t.paid_to_verifiers }, { label: "Platform fees", value: t.platform_fees },
            { label: "Refunded to payers", value: t.refunded_amount }, { label: "Still in escrow", value: t.in_escrow }], "ink", usd)),
        h("div", { class: "panel panel-pad" }, h("h3", { style: "margin-bottom:14px" }, "Why work was rejected"),
          a.failures.length ? barList(a.failures.slice(0, 6).map((f) => ({ label: f.label, value: f.count })), "no", (v) => `${v}x`)
            : h("p", { class: "muted small" }, "No failed checks yet. Hire the cheap lead agent to see one."))),
      h("div", { class: "panel table-scroll", style: "margin-top:16px" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", {}, "Agent"), h("th", {}, "Role"), h("th", { class: "r" }, "Jobs"), h("th", {}, "Pass rate"), h("th", { class: "r hide-sm" }, "Verdicts"), h("th", { class: "r" }, "Earned"))),
        h("tbody", {}, a.agents.map((g) => h("tr", {},
          h("td", { class: "mono small" }, g.full_name), h("td", {}, h("span", { class: "tag" }, g.role)),
          h("td", { class: "amt r" }, String(g.jobs)),
          h("td", {}, g.pass_rate == null ? h("span", { class: "muted xs" }, "no jobs yet") : h("div", { class: "rate", title: `${g.verified} verified, ${g.rejected} rejected` },
            h("span", { class: "bar-track" }, h("span", { class: `bar-fill ${g.pass_rate >= 0.5 ? "ok" : "no"}`, style: `width:${Math.max(2, g.pass_rate * 100)}%` })), h("span", { class: "mono xs" }, pctFmt(g.pass_rate)))),
          h("td", { class: "amt r hide-sm" }, String(g.verdicts)), h("td", { class: "amt r" }, usd(g.earned))))))),
      h("div", { class: "panel table-scroll", style: "margin-top:16px" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", {}, "Service"), h("th", { class: "r" }, "Jobs"), h("th", { class: "r" }, "Verified"), h("th", { class: "r" }, "Agent revenue"))),
        h("tbody", {}, a.by_capability.map((c) => h("tr", {}, h("td", {}, SERVICES[c.name]?.title ?? c.name, h("div", { class: "mono xs muted" }, c.name)),
          h("td", { class: "amt r" }, String(c.jobs)), h("td", { class: "amt r" }, String(c.verified)), h("td", { class: "amt r" }, usd(c.revenue))))))));
  }
  await draw();
  first = false;
  const t = setInterval(() => draw().catch(() => {}), 3000);
  cleanup.push(() => clearInterval(t));
  return box;
}

await loadMe();
sysStatus();
setInterval(sysStatus, 30000);
route();
