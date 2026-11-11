// The routes of the one server: web/src/routes.json is the single description (path, app, access, chrome, title,
// group). This script checks it against the code and writes everything derived from it:
//   server/app/routes.json        the manifest for the Python server (EMBEDDABLE, which HTML file answers)
//   server/app/mcp/app_map.json   every page route with the data-deeplink anchors it renders (MCP deep links)
//   README.md, .gaer/agents/instructions.md   the route tables between <!-- routes:start --> and <!-- routes:end -->
// It fails when a <Route> in App.tsx / admin-app/main.tsx is missing from the manifest (or the other way round), when a
// menu item in admin-app/nav.ts has no route, or when a catalog link in specs/mcp/catalog.json has no anchor.
//
//   npm run app-map            regenerate
//   npm run app-map -- --check fail if anything is out of date (part of the build)
//
// An anchor is a string literal in data-deeplink="…" / data-deeplink={…} or a `deeplink` prop; template literals
// like `feature-ring-${f.key}` become feature-ring-{x}.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(web, "src");
const out = resolve(web, "../server/app/mcp/app_map.json");
const catalogFile = resolve(web, "../specs/mcp/catalog.json");
const manifestFile = join(src, "routes.json");
const serverManifest = resolve(web, "../server/app/routes.json");
const docs = [{ file: resolve(web, "../.gaer/agents/instructions.md"), lang: "en" }, { file: resolve(web, "../README.md"), lang: "da" }];
// The Docker build copies only web/ (to /web), so the server, specs and docs are not there. The routes in web/src are
// still checked; the generated files, route tables and catalog links are checked by npm run build in the full checkout
// (test.yml on every PR).
const fullCheckout = [catalogFile, resolve(web, "../server/app"), ...docs.map((d) => d.file)].every((f) => existsSync(f));
const check = process.argv.includes("--check");
if (!fullCheckout && !check) {
  console.error("app-map: run it from the full repository (server/, specs/, README.md and .gaer/ next to web/)");
  process.exit(1);
}

const read = (f) => readFileSync(f, "utf8");

function resolveImport(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const f of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    if (existsSync(f) && !f.endsWith("/")) try { read(f); return f; } catch { /* a directory */ }
  }
  return null;
}

function imports(file) {
  const map = {};
  for (const m of read(file).matchAll(/import\s+(?:(\w+)|\{([^}]+)\})(?:\s*,\s*\{([^}]+)\})?\s+from\s+"([^"]+)"/g)) {
    const target = resolveImport(file, m[4]);
    if (!target) continue;
    if (m[1]) map[m[1]] = target;
    for (const names of [m[2], m[3]]) {
      for (const n of (names ?? "").split(",")) {
        const name = n.trim().split(/\s+as\s+/).pop();
        if (name) map[name] = target;
      }
    }
  }
  return map;
}

function anchorsIn(code) {
  const found = new Set();
  const literal = (expr) => {
    for (const s of expr.matchAll(/"([a-z0-9{}_-]+)"|`([^`]+)`/g)) {
      const v = s[1] ?? s[2].replace(/\$\{[^}]+\}/g, "{x}");
      if (/^[a-z0-9{}_-]+$/.test(v)) found.add(v);
    }
  };
  for (const m of code.matchAll(/\b(?:data-deeplink|deeplink)=("([^"]+)"|\{)/g)) {
    if (m[2]) { literal(`"${m[2]}"`); continue; }
    let depth = 1, i = m.index + m[0].length;
    while (depth && i < code.length) { if (code[i] === "{") depth++; else if (code[i] === "}") depth--; i++; }
    literal(code.slice(m.index + m[0].length, i - 1));
  }
  // Action lists that render data-deeplink={a.anchor}, e.g. the user drawer.
  for (const m of code.matchAll(/\banchor:\s*("[^"]+"|`[^`]+`)/g)) literal(m[1]);
  return found;
}

/** Anchors of a page file plus the page-level files it imports from its own folder (drawers, tabs). */
function pageAnchors(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const anchors = anchorsIn(read(file));
  for (const target of Object.values(imports(file))) {
    if (dirname(target).startsWith(dirname(file)) && !/\/(ui|theme|api|auth|context)\.tsx?$/.test(target)) {
      for (const a of pageAnchors(target, seen)) anchors.add(a);
    }
  }
  return anchors;
}

/** <Route> elements with their nesting: child paths are relative to the parent, index routes take the parent's path and
 * layout routes (no path) only group. Returns { "/full/path": [anchors] }. */
function jsxRoutes(file, prefix) {
  const code = read(file);
  const imported = imports(file);
  const result = {};
  const stack = [prefix];
  const tag = /<Route\b|<\/Route>/g;
  let m;
  while ((m = tag.exec(code))) {
    if (m[0] === "</Route>") { stack.pop(); continue; }
    let i = m.index + 6, depth = 0;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    const attrs = code.slice(m.index + 6, i);
    tag.lastIndex = i + 1;
    const outside = attrs.replace(/\{[\s\S]*\}/g, "");
    const path = outside.match(/\bpath="([^"]*)"/)?.[1];
    const parent = stack[stack.length - 1];
    const full = path === undefined ? parent : path.startsWith("/") ? path : `${parent.replace(/\/$/, "")}/${path}`;
    if (!outside.trimEnd().endsWith("/")) stack.push(full);
    if ((path === undefined && !/\bindex\b/.test(outside)) || path === "*") continue;
    const anchors = new Set(result[full || "/"] ?? []);
    for (const c of (attrs.match(/element=\{([\s\S]*)\}/)?.[1] ?? "").matchAll(/<([A-Z]\w*)/g)) {
      const target = imported[c[1]];
      if (target) for (const a of pageAnchors(target)) anchors.add(a);
    }
    result[full || "/"] = [...anchors].sort();
  }
  return result;
}

const problems = [];
const manifest = JSON.parse(read(manifestFile));
const groups = new Map(manifest.groups.map((g) => [g.id, g]));
const seen = new Set();
for (const r of manifest.routes) {
  if (seen.has(r.path)) problems.push(`routes.json: ${r.path} twice`);
  seen.add(r.path);
  if (!groups.has(r.group)) problems.push(`routes.json: ${r.path} has unknown group ${r.group}`);
  if (!["app", "admin", "server"].includes(r.app)) problems.push(`routes.json: ${r.path} app must be app, admin or server`);
  if (!["public", "user", "admin", "token"].includes(r.access)) problems.push(`routes.json: ${r.path} unknown access ${r.access}`);
}
for (const g of manifest.groups) if (!manifest.routes.some((r) => r.group === g.id)) problems.push(`routes.json: group ${g.id} has no routes`);

const pages = { ...jsxRoutes(join(src, "App.tsx"), ""), ...jsxRoutes(join(src, "admin-app/main.tsx"), "/admin") };
const declared = manifest.routes.filter((r) => r.app !== "server");
for (const path of Object.keys(pages)) if (!declared.some((r) => r.path === path)) problems.push(`${path} is a <Route> but not in web/src/routes.json`);
for (const r of declared) if (!(r.path in pages)) problems.push(`routes.json: ${r.path} (${r.app}) has no <Route>`);
for (const r of declared) {
  const inAdmin = r.path === "/admin" || r.path.startsWith("/admin/");
  if ((r.app === "admin") !== inAdmin) problems.push(`routes.json: ${r.path} — the admin app answers /admin and nothing else`);
}

// The /admin menu: every item is a route, with the manifest's title as its label.
for (const m of read(join(src, "admin-app/nav.ts")).matchAll(/\{\s*path:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)) {
  const path = m[1] === "/" ? "/admin" : `/admin${m[1]}`;
  const route = manifest.routes.find((r) => r.path === path);
  if (!route) problems.push(`admin-app/nav.ts: ${m[1]} is not a route`);
  else if (route.title !== m[2]) problems.push(`admin-app/nav.ts: "${m[2]}" ≠ routes.json title "${route.title}" for ${path}`);
}

const map = {
  generated_by: "npm run app-map --prefix web",
  routes: Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b))
    .map(([path, anchors]) => [path, { title: manifest.routes.find((r) => r.path === path)?.title ?? null, anchors }])),
};
const text = JSON.stringify(map, null, 2) + "\n";
const serverText = JSON.stringify({ generated_by: "npm run app-map --prefix web (from web/src/routes.json)",
  groups: manifest.groups, routes: manifest.routes }, null, 1) + "\n";

// ── Route tables in the docs ────────────────────────────────────────────────
const cell = (s) => String(s).replace(/\|/g, "\\|");
const code = (s) => (s.includes("`") ? s : `\`${s}\``);
const docsPath = (g) => (g.docs_path.includes("`") ? g.docs_path : code(g.docs_path)).replace(/(?<!\\)\|/g, (m, off, str) =>
  str.slice(0, off).split("`").length % 2 === 0 ? "\\|" : m);
function table(lang) {
  const head = lang === "en" ? "| Route | Who | What | Code |\n| --- | --- | --- | --- |" : "| Rute | Hvem | Hvad |\n| --- | --- | --- |";
  const rows = manifest.groups.map((g) => lang === "en"
    ? `| ${docsPath(g)} | ${cell(g.who.en)} | ${g.what.en} | ${g.code.map(code).join(", ")} |`
    : `| ${docsPath(g)} | ${cell(g.who.da)} | ${g.what.da} |`);
  const access = lang === "en" ? { public: "everyone", user: "logged in", admin: "admin", token: "OAuth bearer" }
    : { public: "alle", user: "logget ind", admin: "admin", token: "OAuth" };
  const app = lang === "en" ? { app: "app (`index.html`)", admin: "admin app (`admin.html`)", server: "server" }
    : { app: "appen", admin: "admin-appen", server: "serveren" };
  const all = manifest.routes.map((r) => `| \`${r.path}\` | ${app[r.app]} | ${access[r.access]} | ${cell(r.title)}${
    r.feature ? ` (feature \`${r.feature}\`)` : ""}${r.chrome === "own" ? (lang === "en" ? " · own chrome" : " · eget layout") : ""}${
    r.embeddable ? (lang === "en" ? " · embeddable" : " · kan indlejres") : ""} |`);
  const allHead = lang === "en" ? "| Path | Served by | Access | Page |\n| --- | --- | --- | --- |" : "| Sti | Svarer | Adgang | Side |\n| --- | --- | --- | --- |";
  const summary = lang === "en" ? "All routes" : "Alle ruter";
  return [lang === "en" ? "<!-- Generated from web/src/routes.json by npm run app-map --prefix web — edit the manifest, not this table. -->"
    : "<!-- Genereret fra web/src/routes.json af npm run app-map --prefix web — ret manifestet, ikke tabellen. -->",
    head, ...rows, "", `<details><summary>${summary} (${manifest.routes.length})</summary>`, "", allHead, ...all, "", "</details>"].join("\n");
}
const docTexts = !fullCheckout ? [] : docs.map(({ file, lang }) => {
  const current = read(file);
  const start = current.indexOf("<!-- routes:start -->"), end = current.indexOf("<!-- routes:end -->");
  if (start < 0 || end < start) { problems.push(`${file}: missing <!-- routes:start --> / <!-- routes:end -->`); return { file, current, next: current }; }
  const next = current.slice(0, start) + "<!-- routes:start -->\n" + table(lang) + "\n" + current.slice(end);
  return { file, current, next };
});

// Every catalog link must resolve.
const catalog = fullCheckout ? JSON.parse(read(catalogFile)) : { tools: [] };
const routeFor = (section) => {
  const path = section.replace(/\{\w+\}/g, "1");
  return Object.entries(map.routes).find(([p]) => new RegExp(`^${p.replace(/:\w+/g, "[^/]+")}$`).test(path))?.[1];
};
// A {placeholder} on either side stands for one or more anchor characters: the catalog's analytics-{by} matches the
// literal analytics-pages, and the page's feature-ring-{x} matches a concrete feature-ring-ai.
const pattern = (s) => new RegExp(`^${s.split(/\{\w+\}/).map((p) => p.replace(/[-]/g, "\\-")).join("[a-z0-9_{}-]+")}$`);
const anchorMatches = (anchor, focus) => pattern(focus).test(anchor) || pattern(anchor).test(focus);
for (const t of catalog.tools) {
  if (!t.link) continue;
  const route = routeFor(t.link.section);
  if (!route) problems.push(`${t.server}:${t.name} → ${t.link.section} is not a route`);
  else if (t.link.focus && !route.anchors.some((a) => anchorMatches(a, t.link.focus))) {
    problems.push(`${t.server}:${t.name} → ${t.link.section} has no data-deeplink="${t.link.focus}"`);
  }
}

if (check && !fullCheckout) {
  console.log(`routes.json: ${manifest.routes.length} routes checked (web/ only — generated files and docs are checked in the full checkout)`);
} else if (check) {
  const stale = (file, want) => !existsSync(file) || read(file) !== want;
  if (stale(out, text)) problems.push("server/app/mcp/app_map.json is out of date — run npm run app-map --prefix web");
  if (stale(serverManifest, serverText)) problems.push("server/app/routes.json is out of date — run npm run app-map --prefix web");
  for (const d of docTexts) if (d.current !== d.next) problems.push(`${d.file}: the route table is out of date — run npm run app-map --prefix web`);
} else {
  writeFileSync(out, text);
  writeFileSync(serverManifest, serverText);
  for (const d of docTexts) if (d.current !== d.next) writeFileSync(d.file, d.next);
  console.log(`routes.json: ${manifest.routes.length} routes · app_map.json: ${Object.keys(map.routes).length} pages · route tables updated`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
