// server.js
const express = require("express");
const cors = require("cors");

const {
  PORT,
  OPENAI_MODEL_SUGGESTIONS,
  OPENAI_MODEL_TRANSLATE,
  SUGGESTION_OPENAI_CONCURRENCY,
  TRANSLATION_OPENAI_CONCURRENCY
} = require("./config");

const { runtimeStats } = require("./state");
const { crearRequestId } = require("./lib/utils");
const { adminEstaConfigurado } = require("./services/core");
const registerRoutes = require("./routes");

const app = express();
app.disable("x-powered-by");
app.use(cors());

app.use((req, res, next) => {
  const startedAt = Date.now();

  req.requestId = crearRequestId();
  res.setHeader("X-Request-Id", req.requestId);
  res.setHeader("Cache-Control", "no-store");

  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    runtimeStats.http.total += 1;
    runtimeStats.http.lastMs = ms;

    if (res.statusCode >= 400) runtimeStats.http.error += 1;
    else runtimeStats.http.ok += 1;
  });

  next();
});

app.use(express.json({ limit: "1mb" }));

app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      ok: false,
      error: "JSON invalido"
    });
  }

  return next(err);
});

registerRoutes(app);

app.use((err, _req, res, _next) => {
  console.error("Error no controlado:", err);

  if (res.headersSent) {
    return;
  }

  return res.status(500).json({
    ok: false,
    error: "Error interno"
  });
});

app.listen(PORT, () => {
  console.log(`Server PRO activo en puerto ${PORT}`);
  console.log(
    `Modelos => sugerencias: ${OPENAI_MODEL_SUGGESTIONS} | traduccion: ${OPENAI_MODEL_TRANSLATE}`
  );
  console.log(
    `Lanes OpenAI => sugerencias: ${SUGGESTION_OPENAI_CONCURRENCY} | traduccion: ${TRANSLATION_OPENAI_CONCURRENCY}`
  );
  console.log(
    `Admin panel => ${adminEstaConfigurado() ? "configurado" : "faltan variables ADMIN_*"}`
  );
});