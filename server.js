const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const DATA_FILE = path.join(__dirname, "data", "groups.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Garante que o arquivo de dados existe (primeira execução em disco novo)
if (!fs.existsSync(DATA_FILE)) {
  writeData({ groups: [] });
}

app.get("/api/groups", (req, res) => {
  try {
    res.json(readData());
  } catch (e) {
    res.status(500).json({ error: "failed to read data" });
  }
});

app.post("/api/groups/:id/matches/:idx", (req, res) => {
  const { id, idx } = req.params;
  const { scoreA, scoreB, cancelled } = req.body || {};
  const i = parseInt(idx, 10);

  if (!Number.isInteger(i) || i < 0) {
    return res.status(400).json({ error: "invalid match index" });
  }

  const data = readData();
  const group = data.groups.find((g) => String(g.number) === String(id));
  if (!group) return res.status(404).json({ error: "group not found" });
  if (!group.matches[i]) return res.status(404).json({ error: "match not found" });

  if (cancelled) {
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
app.listen(PORT, () => console.log("Champions League server running on port " + PORT));
