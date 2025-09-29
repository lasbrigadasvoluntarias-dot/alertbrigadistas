module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const key = process.env.AEMET_API_KEY || "";
  return res.status(200).json({
    ok: true,
    node: process.version,
    hasKey: !!key,
    keyLen: key.length
  });
};
