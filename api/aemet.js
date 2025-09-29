// Función serverless para Vercel
const tar = require("tar");
const fs = require("fs");
const path = require("path");
const os = require("os");

const AEMET_TAR_URL = "https://www.aemet.es/es/geojson/download/avisos/geojson_1759057320.tar.gz";

async function downloadToFile(url, dest) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
  });
}

module.exports = async (req, res) => {
  try {
    const tmp = os.tmpdir();
    const tarPath = path.join(tmp, "avisos.tar.gz");
    const extractDir = path.join(tmp, "aemet_extract");

    // Limpia extract dir
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(extractDir, { recursive: true });

    await downloadToFile(AEMET_TAR_URL, tarPath);
    await tar.x({ file: tarPath, cwd: extractDir });

    const files = fs.readdirSync(extractDir)
      .filter(f => f.endsWith(".geojson"))
      .map(f => ({ f, t: fs.statSync(path.join(extractDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);

    if (!files.length) {
      return res.status(502).json({ error: "No se encontró ningún .geojson en el paquete" });
    }

    const geo = fs.readFileSync(path.join(extractDir, files[0].f), "utf8");
    res.setHeader("Access-Control-Allow-Origin", "*"); // CORS para que GoodBarber pueda hacer fetch
    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader("Content-Type", "application/geo+json; charset=utf-8");
    return res.send(geo);
  } catch (e) {
    console.error(e);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: "Fallo al obtener o extraer los avisos de AEMET" });
  }
};
