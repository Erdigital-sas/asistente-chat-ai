// routes/index.js
const adminRoutes = require("./admin");
const operatorRoutes = require("./operator");
const iaRoutes = require("./ia");
const { getHealthPayload } = require("../services/core");

function registerRoutes(app) {
  app.get("/health", (_req, res) => {
    return res.json(getHealthPayload());
  });

  app.use(adminRoutes);
  app.use(operatorRoutes);
  app.use(iaRoutes);
}

module.exports = registerRoutes;