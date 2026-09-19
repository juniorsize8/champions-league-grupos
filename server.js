
server_js_conteudo.txt

100%
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
  fs.writeFileSync(DATA_FILE, JSON.stringify({ groups: [] }, null, 2));
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

const PORT = process.env.PORT || 3000;
loadFromGithubIfConfigured().finally(() => {
    app.listen(PORT, () => console.log("Champions League server running on port " + PORT));
  });
