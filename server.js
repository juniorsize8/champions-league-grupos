const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const DATA_FILE = path.join(__dirname, "data", "groups.json");

// ---- Persistência durável via GitHub -------------------------------------
// O disco do Render é efêmero (é resetado a cada deploy ou quando o serviço
// "dorme" e acorda de novo). Para os resultados não desaparecerem, gravamos
// cada atualização também em um branch dedicado do GitHub (fora do branch
// "main", para não disparar um novo deploy a cada jogo salvo), e recarregamos
// de lá sempre que o servidor inicia.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_DATA_REPO || "juniorsize8/champions-league-grupos";
const GITHUB_BRANCH = process.env.GITHUB_DATA_BRANCH || "data-store";
const GITHUB_PATH = process.env.GITHUB_DATA_PATH || "data/groups.json";
const GITHUB_API = "https://api.github.com";
const persistenceEnabled = !!GITHUB_TOKEN;

let githubFileSha = null; // sha do arquivo no branch de dados, para permitir updates
let githubQueue = Promise.resolve(); // serializa gravações para evitar conflitos de sha

function ghHeaders() {
  return {
    Authorization: "Bearer " + GITHUB_TOKEN,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "champions-league-grupos-app",
  };
}

async function ghGetBranchRef(branch) {
  const r = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/git/ref/heads/${branch}`, {
    headers: ghHeaders(),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("ghGetBranchRef failed: " + r.status);
  const j = await r.json();
  return j.object.sha;
}

async function ghCreateBranch(branch, fromSha) {
  const r = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/git/refs`, {
    method: "POST",
    headers: ghHeaders(),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  });
  if (!r.ok) throw new Error("ghCreateBranch failed: " + r.status + " " + (await r.text()));
}

async function ghGetFile(branch, filePath) {
  const r = await fetch(
    `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${filePath}?ref=${branch}`,
    { headers: ghHeaders() }
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("ghGetFile failed: " + r.status);
  const j = await r.json();
  return { content: Buffer.from(j.content, "base64").toString("utf8"), sha: j.sha };
}

async function ghPutFile(branch, filePath, contentStr, sha, message) {
  const body = {
    message: message || "Atualiza resultados",
    content: Buffer.from(contentStr, "utf8").toString("base64"),
    branch: branch,
  };
  if (sha) body.sha = sha;
  const r = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${filePath}`, {
    method: "PUT",
    headers: ghHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("ghPutFile failed: " + r.status + " " + (await r.text()));
  const j = await r.json();
  return j.content.sha;
}

// Carrega o estado mais recente do GitHub (se configurado) para dentro do
// disco local, na inicialização do servidor.
async function loadFromGithubIfConfigured() {
  if (!persistenceEnabled) {
    console.log("[persist] GITHUB_TOKEN não definido — rodando sem persistência durável (dados podem se perder ao reiniciar).");
    return;
  }
  try {
    let existing = await ghGetFile(GITHUB_BRANCH, GITHUB_PATH);

    if (!existing) {
      // Branch/arquivo de dados ainda não existe: cria a partir do main e do
      // arquivo local atual (ou de um estado vazio, se nenhum dos dois existir).
      console.log(`[persist] Branch "${GITHUB_BRANCH}" ou arquivo de dados não encontrado — criando…`);
      let branchSha = await ghGetBranchRef(GITHUB_BRANCH);
      if (!branchSha) {
        const mainSha = await ghGetBranchRef("main");
        if (!mainSha) throw new Error("não foi possível obter o branch main");
        await ghCreateBranch(GITHUB_BRANCH, mainSha);
      }
      const seedData = fs.existsSync(DATA_FILE)
        ? fs.readFileSync(DATA_FILE, "utf8")
        : JSON.stringify({ groups: [] }, null, 2);
      githubFileSha = await ghPutFile(GITHUB_BRANCH, GITHUB_PATH, seedData, null, "Cria armazenamento de dados inicial");
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, seedData);
      console.log("[persist] Armazenamento de dados criado no GitHub com sucesso.");
      return;
    }

    githubFileSha = existing.sha;
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, existing.content);
    console.log("[persist] Resultados recarregados do GitHub com sucesso.");
  } catch (e) {
    console.error("[persist] Falha ao carregar dados do GitHub, usando cópia local:", e.message);
  }
}

// Envia a gravação mais recente para o GitHub, uma de cada vez (fila),
// para nunca perder um "sha" e causar um conflito de escrita.
function persistToGithub(contentStr) {
  if (!persistenceEnabled) return;
  githubQueue = githubQueue
    .then(async () => {
      const newSha = await ghPutFile(GITHUB_BRANCH, GITHUB_PATH, contentStr, githubFileSha, "Atualiza resultados");
      githubFileSha = newSha;
    })
    .catch(async (e) => {
      console.error("[persist] Falha ao salvar no GitHub, tentando ressincronizar:", e.message);
      // Se o sha ficou desatualizado (409/422), busca o sha atual e tenta de novo uma vez.
      try {
        const existing = await ghGetFile(GITHUB_BRANCH, GITHUB_PATH);
        if (existing) {
          githubFileSha = existing.sha;
          const newSha = await ghPutFile(GITHUB_BRANCH, GITHUB_PATH, contentStr, githubFileSha, "Atualiza resultados (retry)");
          githubFileSha = newSha;
        }
      } catch (e2) {
        console.error("[persist] Retry também falhou — este resultado ficou salvo apenas localmente:", e2.message);
      }
    });
}
// ---------------------------------------------------------------------------

// ---- Fase eliminatória (mata-mata) ----------------------------------------
// Cruzamento definido manualmente a partir da classificação final dos grupos
// (já considerando desistências ajustadas pelo organizador): 1º de um grupo
// enfrenta o 2º do grupo cruzado, e vice-versa.
const KO_SEED = [
  { groupA: 5,  posA: 1, playerA: "Arthur",            groupB: 9,  posB: 2, playerB: "Joel" },
  { groupA: 9,  posA: 1, playerA: "Davi",              groupB: 5,  posB: 2, playerB: "Diego" },

  { groupA: 10, posA: 1, playerA: "Basile",            groupB: 6,  posB: 2, playerB: "Cassio" },
  { groupA: 6,  posA: 1, playerA: "Felipe",             groupB: 10, posB: 2, playerB: "Yuri" },

  { groupA: 4,  posA: 1, playerA: "Murilo",            groupB: 13, posB: 2, playerB: "Lelo" },
  { groupA: 13, posA: 1, playerA: "Marquinhos Ashcar",  groupB: 4,  posB: 2, playerB: "Oscar" },

  { groupA: 2,  posA: 1, playerA: "Paulo Schroeder",   groupB: 1,  posB: 2, playerB: "Paulo Yukio" },
  { groupA: 1,  posA: 1, playerA: "Rodrigo Arthur",     groupB: 2,  posB: 2, playerB: "Gustavo Monzani" },

  { groupA: 8,  posA: 1, playerA: "Guga Clark",        groupB: 14, posB: 2, playerB: "Beto Terzian" },
  { groupA: 14, posA: 1, playerA: "Will",               groupB: 8,  posB: 2, playerB: "Gustavo Toledo" },

  { groupA: 3,  posA: 1, playerA: "Pa",                groupB: 16, posB: 2, playerB: "Fabio Lacaz" },
  { groupA: 16, posA: 1, playerA: "Bruno Affonso",      groupB: 3,  posB: 2, playerB: "Romulo" },

  { groupA: 11, posA: 1, playerA: "Joao Lima",         groupB: 15, posB: 2, playerB: "Fred" },
  { groupA: 15, posA: 1, playerA: "Junior",             groupB: 11, posB: 2, playerB: "Silvio Veloso" },

  { groupA: 12, posA: 1, playerA: "Rodrigo Ruic",      groupB: 7,  posB: 2, playerB: "Marcio Adri" },
  { groupA: 7,  posA: 1, playerA: "Jonas Suzuki",       groupB: 12, posB: 2, playerB: "Kerr" },
];

function emptySets() {
  return [{ a: null, b: null }, { a: null, b: null }];
}

function buildKnockoutSeed() {
  return KO_SEED.map(function (m, idx) {
    return {
      idx: idx,
      groupA: m.groupA, posA: m.posA, playerA: m.playerA,
      groupB: m.groupB, posB: m.posB, playerB: m.playerB,
      sets: emptySets(),
      tiebreak: { a: null, b: null },
    };
  });
}

function isValidSetScore(a, b) {
  return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a !== b;
}
function isValidTiebreak(a, b) {
  if (a === null || b === null) return false;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) return false;
  return Math.max(a, b) >= 10 && Math.abs(a - b) >= 2;
}
// ---------------------------------------------------------------------------

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function writeData(data) {
  const contentStr = JSON.stringify(data, null, 2);
  fs.writeFileSync(DATA_FILE, contentStr);
  persistToGithub(contentStr);
}

// Garante que o arquivo de dados existe (primeira execução em disco novo)
if (!fs.existsSync(DATA_FILE)) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ groups: [], knockout: buildKnockoutSeed() }, null, 2));
}

// Garante que a fase eliminatória existe no arquivo de dados (migração de
// instalações antigas que só tinham "groups"), e grava/persiste se precisou criar.
function ensureKnockoutSeeded() {
  try {
    const data = readData();
    if (!data.knockout || !Array.isArray(data.knockout) || data.knockout.length === 0) {
      data.knockout = buildKnockoutSeed();
      writeData(data);
      console.log("[knockout] Fase eliminatória criada/semeada.");
    }
  } catch (e) {
    console.error("[knockout] Falha ao garantir fase eliminatória:", e.message);
  }
}

app.get("/api/groups", (req, res) => {
  try {
    res.json(readData());
  } catch (e) {
    res.status(500).json({ error: "failed to read data" });
  }
});

app.get("/api/persist-status", (req, res) => {
  res.json({ enabled: persistenceEnabled, repo: GITHUB_REPO, branch: GITHUB_BRANCH });
});

app.post("/api/groups/:id/matches/:idx", (req, res) => {
  const { id, idx } = req.params;
  const { scoreA, scoreB, cancelled, reset } = req.body || {};
  const i = parseInt(idx, 10);

  if (!Number.isInteger(i) || i < 0) {
    return res.status(400).json({ error: "invalid match index" });
  }

  const data = readData();
  const group = data.groups.find((g) => String(g.number) === String(id));
  if (!group) return res.status(404).json({ error: "group not found" });
  if (!group.matches[i]) return res.status(404).json({ error: "match not found" });

  if (reset) {
    // Limpa totalmente o jogo de volta ao estado "não jogado" (usado pelo botão Limpar / Reabrir jogo)
    group.matches[i].scoreA = null;
    group.matches[i].scoreB = null;
    group.matches[i].cancelled = false;
  } else if (cancelled) {
    group.matches[i].scoreA = null;
    group.matches[i].scoreB = null;
    group.matches[i].cancelled = true;
  } else {
    const a = parseInt(scoreA, 10);
    const b = parseInt(scoreB, 10);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || a < 0 || b < 0) {
      return res.status(400).json({ error: "invalid score" });
    }
    group.matches[i].scoreA = a;
    group.matches[i].scoreB = b;
    group.matches[i].cancelled = false;
  }

  writeData(data);
  res.json({ ok: true, group });
});

app.post("/api/knockout/matches/:idx", (req, res) => {
  const { idx } = req.params;
  const { sets, tiebreak, reset } = req.body || {};
  const i = parseInt(idx, 10);

  const data = readData();
  if (!data.knockout || !data.knockout[i]) {
    return res.status(404).json({ error: "knockout match not found" });
  }
  const m = data.knockout[i];

  if (reset) {
    m.sets = emptySets();
    m.tiebreak = { a: null, b: null };
    writeData(data);
    return res.json({ ok: true, match: m });
  }

  if (!Array.isArray(sets) || sets.length !== 2) {
    return res.status(400).json({ error: "invalid sets" });
  }
  const s0a = parseInt(sets[0] && sets[0].a, 10);
  const s0b = parseInt(sets[0] && sets[0].b, 10);
  const s1a = parseInt(sets[1] && sets[1].a, 10);
  const s1b = parseInt(sets[1] && sets[1].b, 10);
  if (!isValidSetScore(s0a, s0b) || !isValidSetScore(s1a, s1b)) {
    return res.status(400).json({ error: "invalid set score" });
  }

  const aWins = (s0a > s0b ? 1 : 0) + (s1a > s1b ? 1 : 0);
  const bWins = (s0b > s0a ? 1 : 0) + (s1b > s1a ? 1 : 0);

  let tb = { a: null, b: null };
  if (aWins === 1 && bWins === 1) {
    const ta = parseInt(tiebreak && tiebreak.a, 10);
    const tbv = parseInt(tiebreak && tiebreak.b, 10);
    if (!isValidTiebreak(ta, tbv)) {
      return res.status(400).json({ error: "invalid tiebreak" });
    }
    tb = { a: ta, b: tbv };
  }

  m.sets = [{ a: s0a, b: s0b }, { a: s1a, b: s1b }];
  m.tiebreak = tb;

  writeData(data);
  res.json({ ok: true, match: m });
});

// ---- Oitavas de final -----------------------------------------------------
// Os 16 vencedores da fase eliminatória são sorteados em 8 jogos. Regra:
// jogadores que foram do mesmo grupo na fase de grupos não podem se enfrentar
// (só poderiam se reencontrar na final).
function koWinnerOf(m) {
  const val = (v) => v !== null && v !== undefined;
  let wa = 0, wb = 0;
  (m.sets || []).forEach((s) => {
    if (!s || !val(s.a) || !val(s.b)) return;
    if (s.a > s.b) wa++; else if (s.b > s.a) wb++;
  });
  let side = null;
  if (wa >= 2) side = "A";
  else if (wb >= 2) side = "B";
  else if (wa === 1 && wb === 1 && m.tiebreak && val(m.tiebreak.a) && val(m.tiebreak.b)) {
    if (m.tiebreak.a > m.tiebreak.b) side = "A";
    else if (m.tiebreak.b > m.tiebreak.a) side = "B";
  }
  if (!side) return null;
  return side === "A"
    ? { player: m.playerA, group: m.groupA, pos: m.posA }
    : { player: m.playerB, group: m.groupB, pos: m.posB };
}

function shuffleArr(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pareamento aleatório com backtracking: ninguém enfrenta alguém do mesmo grupo.
function pairPlayers(players) {
  function solve(rest) {
    if (rest.length === 0) return [];
    const first = rest[0];
    const others = shuffleArr(rest.slice(1));
    for (let k = 0; k < others.length; k++) {
      const cand = others[k];
      if (cand.group === first.group) continue;
      const remaining = rest.slice(1).filter((p) => p !== cand);
      const sub = solve(remaining);
      if (sub) return [[first, cand]].concat(sub);
    }
    return null;
  }
  return solve(shuffleArr(players));
}

function hasAnyResult(m) {
  return (m.sets || []).some((s) => s && s.a !== null && s.a !== undefined);
}

app.post("/api/oitavas/draw", (req, res) => {
  const data = readData();
  const ko = data.knockout || [];
  if (ko.length === 0) return res.status(400).json({ error: "fase eliminatória não encontrada" });
  const winners = ko.map(koWinnerOf);
  if (winners.some((w) => !w)) {
    return res.status(400).json({ error: "Ainda há jogos da fase eliminatória sem resultado final." });
  }
  if (Array.isArray(data.oitavas) && data.oitavas.some(hasAnyResult)) {
    return res.status(409).json({ error: "As oitavas já têm resultados lançados; não é possível refazer o sorteio." });
  }
  const pairs = pairPlayers(winners);
  if (!pairs) {
    return res.status(422).json({ error: "Não foi possível sortear sem repetir jogadores do mesmo grupo." });
  }
  data.oitavas = pairs.map((p, i) => ({
    idx: i,
    groupA: p[0].group, posA: p[0].pos, playerA: p[0].player,
    groupB: p[1].group, posB: p[1].pos, playerB: p[1].player,
    sets: emptySets(),
    tiebreak: { a: null, b: null },
  }));
  writeData(data);
  res.json({ ok: true, oitavas: data.oitavas });
});

app.post("/api/oitavas/matches/:idx", (req, res) => {
  const { sets, tiebreak, reset } = req.body || {};
  const i = parseInt(req.params.idx, 10);
  const data = readData();
  if (!Array.isArray(data.oitavas) || !data.oitavas[i]) {
    return res.status(404).json({ error: "oitavas match not found" });
  }
  const m = data.oitavas[i];
  if (reset) {
    m.sets = emptySets();
    m.tiebreak = { a: null, b: null };
    writeData(data);
    return res.json({ ok: true, match: m });
  }
  if (!Array.isArray(sets) || sets.length !== 2) {
    return res.status(400).json({ error: "invalid sets" });
  }
  const s0a = parseInt(sets[0] && sets[0].a, 10);
  const s0b = parseInt(sets[0] && sets[0].b, 10);
  const s1a = parseInt(sets[1] && sets[1].a, 10);
  const s1b = parseInt(sets[1] && sets[1].b, 10);
  if (!isValidSetScore(s0a, s0b) || !isValidSetScore(s1a, s1b)) {
    return res.status(400).json({ error: "invalid set score" });
  }
  const aWins = (s0a > s0b ? 1 : 0) + (s1a > s1b ? 1 : 0);
  const bWins = (s0b > s0a ? 1 : 0) + (s1b > s1a ? 1 : 0);
  let tb = { a: null, b: null };
  if (aWins === 1 && bWins === 1) {
    const ta = parseInt(tiebreak && tiebreak.a, 10);
    const tbv = parseInt(tiebreak && tiebreak.b, 10);
    if (!isValidTiebreak(ta, tbv)) {
      return res.status(400).json({ error: "invalid tiebreak" });
    }
    tb = { a: ta, b: tbv };
  }
  m.sets = [{ a: s0a, b: s0b }, { a: s1a, b: s1b }];
  m.tiebreak = tb;
  writeData(data);
  res.json({ ok: true, match: m });
});
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
loadFromGithubIfConfigured().finally(() => {
  ensureKnockoutSeeded();
  app.listen(PORT, () => console.log("Champions League server running on port " + PORT));
});

// force redeploy 1791940963848
