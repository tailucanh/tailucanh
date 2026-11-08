// Builds two SVG cards (profile stats + top languages) from the GitHub GraphQL API.
// Runs in GitHub Actions with the built-in GITHUB_TOKEN; no external service needed.
//   node .github/scripts/stats.mjs <login> <outDir>
//   MOCK=path/to/data.json node .github/scripts/stats.mjs <login> <outDir>   (offline preview)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOGIN = process.argv[2] || "tailucanh";
const OUT = process.argv[3] || "dist";
const TOKEN = process.env.GITHUB_TOKEN;
// Markup/template languages that would drown out real code in the language card.
const EXCLUDE_LANGS = new Set(["HTML", "CSS", "SCSS", "Handlebars", "ShaderLab", "HLSL"]);
const TOP_LANGS = 8;

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "profile-stats" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

async function rest(path) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "profile-stats" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`REST ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Runs one optional section; on failure logs why and returns the fallback instead of failing the job.
async function optional(label, fallback, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`::warning::${label} unavailable: ${err.message}`);
    return fallback;
  }
}

// GitHub linguist colors for languages we are likely to see (REST does not return colors).
const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Dart: "#00B4AB", "C#": "#178600", "C++": "#f34b7d", C: "#555555",
  Java: "#b07219", Kotlin: "#A97BFF", Swift: "#F05138", Python: "#3572A5", Go: "#00ADD8", Rust: "#dea584",
  PHP: "#4F5D95", Ruby: "#701516", Erlang: "#B83998", Shell: "#89e051", PowerShell: "#012456", Vue: "#41b883",
  "Objective-C": "#438eff", CMake: "#DA3434", Solidity: "#AA6746", Lua: "#000080", GDScript: "#355570",
};

async function fetchData() {
  // Core data from REST (works with the Actions GITHUB_TOKEN for public data).
  const user = await rest(`/users/${LOGIN}`);
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await rest(`/users/${LOGIN}/repos?type=owner&per_page=100&page=${page}`);
    repos.push(...batch.filter((r) => !r.fork));
    if (batch.length < 100) break;
  }
  const languages = [];
  for (const r of repos) {
    const langs = await optional(`languages of ${r.name}`, {}, () => rest(`/repos/${r.full_name}/languages`));
    for (const [name, size] of Object.entries(langs)) languages.push({ name, color: LANG_COLORS[name] || "#8b949e", size });
  }
  const count = (q) => optional(`search ${q}`, null, async () => (await rest(`/search/issues?per_page=1&q=${encodeURIComponent(q)}`)).total_count);
  const prs = await count(`author:${LOGIN} type:pr`);
  const issues = await count(`author:${LOGIN} type:issue`);

  // Contribution numbers only exist in GraphQL; keep them optional.
  const contrib = await optional("contributions (GraphQL)", null, async () => {
    const base = await gql(
      `query($login: String!) { user(login: $login) { contributionsCollection { totalCommitContributions restrictedContributionsCount contributionYears } } }`,
      { login: LOGIN },
    );
    const cc = base.user.contributionsCollection;
    let allTime = 0;
    for (const year of cc.contributionYears) {
      const d = await gql(
        `query($login: String!, $from: DateTime!, $to: DateTime!) {
          user(login: $login) { contributionsCollection(from: $from, to: $to) { contributionCalendar { totalContributions } } }
        }`,
        { login: LOGIN, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
      );
      allTime += d.user.contributionsCollection.contributionCalendar.totalContributions;
    }
    return { commitsYear: cc.totalCommitContributions + cc.restrictedContributionsCount, allTime };
  });
  const contributedTo = await optional("contributedTo (GraphQL)", null, async () => {
    const d = await gql(
      `query($login: String!) { user(login: $login) { repositoriesContributedTo(contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) { totalCount } } }`,
      { login: LOGIN },
    );
    return d.user.repositoriesContributedTo.totalCount;
  });

  return {
    name: user.name || LOGIN,
    stars: repos.reduce((s, r) => s + r.stargazers_count, 0),
    commitsYear: contrib?.commitsYear ?? null,
    prs,
    issues,
    contributedTo,
    followers: user.followers,
    repoCount: user.public_repos,
    allTime: contrib?.allTime ?? null,
    languages,
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif";
const frame = (w, h, title, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1023"/><stop offset="1" stop-color="#140c2b"/></linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a855f7"/></linearGradient>
  </defs>
  <style>
    text { font-family: ${FONT}; }
    .title { font-size: 17px; font-weight: 700; fill: url(#edge); }
    .label { font-size: 13.5px; fill: #c9d1d9; }
    .value { font-size: 13.5px; font-weight: 700; fill: #ffffff; }
    .muted { font-size: 11px; fill: #8b949e; }
    .row { opacity: 0; animation: fade .5s ease-out forwards; }
    @keyframes fade { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: none; } }
    @keyframes grow { from { stroke-dashoffset: 251; } }
    @keyframes bar { from { transform: scaleX(0); } }
  </style>
  <rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="12" fill="url(#bg)" stroke="url(#edge)" stroke-opacity=".55"/>
  <text x="24" y="36" class="title">${esc(title)}</text>
${body}
</svg>
`;

function statsCard(d) {
  const rows = [
    ["#facc15", "Total stars earned", d.stars],
    ["#22d3ee", `Commits (last year)`, d.commitsYear],
    ["#a855f7", "Pull requests", d.prs],
    ["#f472b6", "Issues", d.issues],
    ["#4ade80", "Contributed to", d.contributedTo],
    ["#60a5fa", "Public repositories", d.repoCount],
  ];
  const lines = rows
    .map(([color, label, value], i) => {
      const y = 70 + i * 22;
      return `  <g class="row" style="animation-delay:${150 + i * 120}ms">
    <circle cx="30" cy="${y - 4.5}" r="4" fill="${color}"/>
    <text x="44" y="${y}" class="label">${esc(label)}:</text>
    <text x="230" y="${y}" class="value">${fmt(value)}</text>
  </g>`;
    })
    .join("\n");
  // Ring on the right: all-time contributions, or followers if contributions are unavailable.
  // The ring is decorative and always fills to 100%.
  const [ringValue, ringLabel, ringSub] = d.allTime != null ? [d.allTime, "contributions", "all time"] : [d.followers, "followers", "on GitHub"];
  const ring = `  <g transform="translate(395 110)">
    <circle r="40" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="7"/>
    <circle r="40" fill="none" stroke="url(#edge)" stroke-width="7" stroke-linecap="round" stroke-dasharray="251" transform="rotate(-90)" style="animation: grow 1.4s ease-out"/>
    <text y="4" text-anchor="middle" class="value" style="font-size:22px">${fmt(ringValue)}</text>
    <text y="22" text-anchor="middle" class="muted">${ringLabel}</text>
    <text y="62" text-anchor="middle" class="muted">${ringSub}</text>
  </g>`;
  return frame(495, 205, `${d.name}'s GitHub Stats`, `${lines}\n${ring}`);
}

function langsCard(d) {
  const totals = new Map();
  for (const l of d.languages) {
    if (EXCLUDE_LANGS.has(l.name)) continue;
    const cur = totals.get(l.name) || { size: 0, color: l.color || "#8b949e" };
    cur.size += l.size;
    totals.set(l.name, cur);
  }
  const top = [...totals.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, TOP_LANGS);
  const sum = top.reduce((s, [, v]) => s + v.size, 0) || 1;
  const barW = 447;
  let x = 0;
  const segs = top
    .map(([, v]) => {
      const w = (v.size / sum) * barW;
      const seg = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="10" fill="${v.color}"/>`;
      x += w;
      return seg;
    })
    .join("");
  const bar = `  <clipPath id="round"><rect width="${barW}" height="10" rx="5"/></clipPath>
  <g transform="translate(24 54)"><g clip-path="url(#round)" style="transform-origin:left;animation: bar 1s ease-out">${segs}</g></g>`;
  const items = top
    .map(([name, v], i) => {
      const col = i % 2;
      const rowI = Math.floor(i / 2);
      const pct = ((v.size / sum) * 100).toFixed(1);
      const tx = 24 + col * 230;
      const ty = 98 + rowI * 25;
      return `  <g class="row" style="animation-delay:${300 + i * 90}ms">
    <circle cx="${tx + 6}" cy="${ty - 4.5}" r="5" fill="${v.color}"/>
    <text x="${tx + 18}" y="${ty}" class="label">${esc(name)}</text>
    <text x="${tx + 200}" y="${ty}" text-anchor="end" class="muted">${pct}%</text>
  </g>`;
    })
    .join("\n");
  return frame(495, 205, "Most Used Languages", `${bar}\n${items}`);
}

const data = process.env.MOCK ? JSON.parse(readFileSync(process.env.MOCK, "utf8")) : await fetchData();
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "stats.svg"), statsCard(data));
writeFileSync(join(OUT, "top-langs.svg"), langsCard(data));
console.log(`Wrote stats.svg and top-langs.svg to ${OUT} (stars=${data.stars}, allTime=${data.allTime}, langs=${new Set(data.languages.map((l) => l.name)).size})`);
