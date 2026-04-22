const { 
  crearCaso,
  generarSugerenciasMotor,
  fallbackSuggestions
} = require("./suggestionEngine");

function prepararCasoSugerencias({
  operador = "",
  texto = "",
  contexto = "",
  cliente = "",
  perfil = "",
  chat_signals = {},
  page_type = ""
}) {
  return {
    operador,
    ...crearCaso({
      texto,
      contexto,
      cliente,
      perfil,
      chat_signals,
      page_type
    })
  };
}

function filtrarSugerenciasFinales(items = []) {
  return Array.isArray(items) ? items : [];
}

async function generarSugerencias(caso = {}) {
  return generarSugerenciasMotor(caso);
}

function construirFallbackSugerencias(caso = {}) {
  return fallbackSuggestions(caso);
}

module.exports = {
  prepararCasoSugerencias,
  filtrarSugerenciasFinales,
  generarSugerencias,
  construirFallbackSugerencias
};
