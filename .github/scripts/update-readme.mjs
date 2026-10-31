// Rebuilds the Projects tables in README.md and assets/languages.svg from live GitHub data.
//
// For each repo, what's set on GitHub wins over .github/readme/projects.json:
//   description  -> repo "About" description, else config description
//   live link    -> repo "Website" field, else none
//   stack        -> repo topics, else config stack, else primary language
// Repos tagged with the "featured" topic are featured automatically.
// Any new public repo (not a fork, not archived, not hidden) shows up under "More projects".
//
// Usage: node .github/scripts/update-readme.mjs   (GITHUB_TOKEN optional, OWNER defaults to gauravera)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OWNER = process.env.OWNER || "gauravera";
const README = "README.md";
const config = JSON.parse(readFileSync(".github/readme/projects.json", "utf8"));

const headers = { Accept: "application/vnd.github+json", "User-Agent": `${OWNER}-readme` };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const res = await fetch(`https://api.github.com/users/${OWNER}/repos?per_page=100&type=owner`, { headers });
if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
const repos = await res.json();
const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
const url = (u) => (u && !/^https?:\/\//.test(u) ? `https://${u}` : u);
const pretty = (topic) => topic.replace(/-/g, " ");
const month = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });

const hidden = new Set(config.hide.map((n) => n.toLowerCase()));
const titleFromName = (name) => name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Featured: config order first, then any repo tagged "featured" on GitHub.
const featured = [];
for (const entry of config.featured) {
  const repo = byName.get(entry.repo.toLowerCase());
  if (repo && !repo.archived && !repo.private) featured.push({ repo, entry });
}
for (const repo of repos) {
  if (repo.topics?.includes("featured") && !featured.some((f) => f.repo.id === repo.id) && !repo.archived) {
    featured.push({ repo, entry: { title: titleFromName(repo.name) } });
  }
}
const featuredIds = new Set(featured.map((f) => f.repo.id));

function featuredRow({ repo, entry }) {
  const title = entry.title || titleFromName(repo.name);
  const live = url(repo.homepage) || url(entry.live);
  const description = repo.description || entry.description || "";
  const topics = (repo.topics || []).filter((t) => t !== "featured");
  const stack = topics.length ? topics.map(pretty) : entry.stack || (repo.language ? [repo.language] : []);
  const name = `**[${cell(title)}](${repo.html_url})**${live ? ` · [live](${live})` : ""}`;
  const desc = `${cell(description)}${stack.length ? `<br /><sub>${cell(stack.join(" · "))}</sub>` : ""}`;
  return `| ${name} | ${desc} |`;
}

const more = repos
  .filter((r) => !featuredIds.has(r.id) && !r.fork && !r.archived && !hidden.has(r.name.toLowerCase()))
  .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

function moreRow(repo) {
  const live = url(repo.homepage);
  const description = repo.description || config.more[repo.name] || repo.language || "";
  const name = `[${repo.name}](${repo.html_url})${live ? ` · [live](${live})` : ""}`;
  return `| ${name} | ${cell(description)} | ${month(repo.pushed_at)} |`;
}

const featuredTable = ["| Project | Description |", "| :-- | :-- |", ...featured.map(featuredRow)].join("\n");
const moreTable = ["| Project | Description | Updated |", "| :-- | :-- | :-- |", ...more.map(moreRow)].join("\n");

function replaceBlock(text, tag, body) {
  const re = new RegExp(`(<!-- ${tag}:START -->)[\\s\\S]*?(<!-- ${tag}:END -->)`);
  if (!re.test(text)) throw new Error(`Missing <!-- ${tag}:START/END --> markers in ${README}`);
  return text.replace(re, `$1\n${body}\n$2`);
}

const before = readFileSync(README, "utf8");
let after = replaceBlock(before, "PROJECTS", featuredTable);
after = replaceBlock(after, "MORE", moreTable);

if (after === before) {
  console.log("README already up to date.");
} else {
  writeFileSync(README, after);
  console.log(`README updated: ${featured.length} featured, ${more.length} more.`);
}

// ---------- Languages card ----------
// Sums bytes of code per language across every shown repo (featured + more),
// unlike commit-based cards that only count each repo's single main language.

const LANG_SVG = "assets/languages.svg";
const COLORS = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", CSS: "#663399", HTML: "#e34c26",
  Solidity: "#aa6746", SCSS: "#c6538c", Python: "#3572a5", Shell: "#89e051", Dockerfile: "#384d54",
};
const OTHER_COLOR = "#8b949e";

const totals = {};
for (const repo of [...featured.map((f) => f.repo), ...more]) {
  const r = await fetch(repo.languages_url, { headers });
  if (!r.ok) throw new Error(`GitHub API ${r.status} for ${repo.name} languages`);
  for (const [lang, bytes] of Object.entries(await r.json())) totals[lang] = (totals[lang] || 0) + bytes;
}

const sum = Object.values(totals).reduce((a, b) => a + b, 0);
const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
// Show up to 5 languages; anything under 0.1% would read as "0.0%", so it joins "Other".
const top = sorted.slice(0, 5).filter(([, bytes]) => bytes / sum >= 0.001);
const rest = sum - top.reduce((a, [, b]) => a + b, 0);
if (rest / sum >= 0.001) top.push(["Other", rest]);
const slices = top.map(([lang, bytes]) => ({ lang, share: bytes / sum, color: COLORS[lang] || OTHER_COLOR }));

function arc(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)}A${r1},${r1},0,${large},1,${p(r1, a1)}L${p(r0, a1)}A${r0},${r0},0,${large},0,${p(r0, a0)}Z`;
}

let angle = 0;
const donut = slices
  .map(({ share, color }) => {
    // A full circle can't be drawn as one arc; cap it just short of 2π.
    const end = Math.min(angle + share * 2 * Math.PI, angle + 2 * Math.PI - 0.0001);
    const d = arc(250, 120, 35, 60, angle, end);
    angle = end;
    return `<path d="${d}" fill="${color}" class="sep" stroke-width="2"/>`;
  })
  .join("");

const legend = slices
  .map(({ lang, share, color }, i) => {
    const y = 66 + i * 23;
    return `<rect x="30" y="${y}" width="12" height="12" rx="2" fill="${color}"/>` +
      `<text x="50" y="${y + 11}" class="label">${lang}</text>` +
      `<text x="160" y="${y + 11}" class="label" text-anchor="end">${(share * 100).toFixed(1)}%</text>`;
  })
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="200" viewBox="0 0 340 200" role="img" aria-label="Languages by code: ${slices.map((s) => `${s.lang} ${(s.share * 100).toFixed(1)}%`).join(", ")}">
<style>
  text{font-family:'Segoe UI',Ubuntu,"Helvetica Neue",Sans-Serif}
  .card{fill:#ffffff;stroke:#e4e2e2}.title{fill:#0366d6;font-size:22px}.label{fill:#586069;font-size:13px}.sep{stroke:#ffffff}
  @media (prefers-color-scheme: dark){.card{fill:#0d1117;stroke:#2e343b}.label{fill:#77909c}.sep{stroke:#0d1117}}
</style>
<rect x="1" y="1" rx="5" ry="5" width="338" height="198" class="card" stroke-width="1"/>
<text x="30" y="40" class="title">Languages by Code</text>
${legend}
${donut}
</svg>
`;

const oldSvg = (() => { try { return readFileSync(LANG_SVG, "utf8"); } catch { return ""; } })();
if (svg !== oldSvg) {
  mkdirSync(dirname(LANG_SVG), { recursive: true });
  writeFileSync(LANG_SVG, svg);
  console.log(`Languages card updated: ${slices.map((s) => `${s.lang} ${(s.share * 100).toFixed(1)}%`).join(", ")}`);
} else {
  console.log("Languages card already up to date.");
}
