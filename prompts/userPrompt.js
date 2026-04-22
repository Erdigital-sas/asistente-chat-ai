const { quitarTildes } = require("../lib/utils");

function lista(items = []) {
  return Array.isArray(items) && items.length ? items.join(" | ") : "Ninguno";
}

function construirUserPrompt(caso = {}) {
  const banned = Array.isArray(caso.bannedSuggestions) ? caso.bannedSuggestions : [];
  const feedback = String(caso.feedbackCorreccion || "").trim();

  return `
CASO

MODO
${caso.mode || "APERTURA_FRIA"}

TIPO DE CONTACTO
${caso.tipoContacto || "nuevo_total"}

HAY RESPUESTA REAL DE LA CLIENTA
${caso?.estadoConversacion?.hayConversacionReal ? "sí" : "no"}

BORRADOR DEL OPERADOR
"""
${caso.textoPlano || "Sin borrador claro"}
"""

ÚLTIMO MENSAJE REAL DE LA CLIENTA
"""
${caso.clientePlano || "Sin mensaje claro de la clienta"}
"""

ÚLTIMAS LÍNEAS DE LA CLIENTA
"""
${(caso.lineasClienteRecientes || []).join("\n") || "Sin líneas recientes"}
"""

ÚLTIMAS LÍNEAS DEL OPERADOR
"""
${(caso.lineasOperadorRecientes || []).join("\n") || "Sin líneas recientes"}
"""

CONTEXTO RELEVANTE
"""
${caso.contextoPlano || "Sin contexto claro"}
"""

PERFIL VISIBLE
- INTERESES_EN_COMUN: ${lista(caso?.perfilEstructurado?.interesesEnComun)}
- INTERESES_CLIENTA: ${lista(caso?.perfilEstructurado?.interesesClienta)}
- UBICACION_CLIENTA: ${caso?.perfilEstructurado?.ubicacionClienta || "Ninguna"}
- DATOS_CLIENTA: ${lista(caso?.perfilEstructurado?.datosClienta)}

DETALLE PRIORITARIO
${caso.detallePrioritario?.value || "Ninguno"}

ANCLA PRINCIPAL
${caso.anchor || "Sin ancla fuerte"}

LECTURA DE LA CLIENTA
${quitarTildes(caso.lecturaCliente || "Tono neutral")}

LECTURA DEL BORRADOR
${quitarTildes(caso.lecturaOperador || "")}

OBJETIVO CONVERSACIONAL
${quitarTildes(caso.objetivoConversacional || "Abrir o continuar la conversacion con naturalidad")}

REGLAS ESPECIALES
- ${quitarTildes(caso.saludoRule || "Saludo natural solo si ayuda")}
- ${quitarTildes(caso.followUpRule || "No fingir continuidad")}
- ${quitarTildes(caso.profileUseRule || "Usa el perfil solo como apoyo")}
- ${quitarTildes(caso.locationRule || "No usar ubicacion salvo que el borrador vaya por ahi")}

NO REPITAS ESTAS SALIDAS
${banned.length ? banned.map((x, i) => `${i + 1}. ${x}`).join("\n") : "Ninguna"}

${feedback ? `CORRECCIÓN OBLIGATORIA\n${feedback}\n` : ""}

INSTRUCCIÓN FINAL
Escribe 3 opciones finales, distintas entre sí, listas para enviar.
La opción 1 debe ser más directa.
La opción 2 más cálida.
La opción 3 un poco más desarrollada, pero sin sonar pesada.
Si no hay respuesta real de la clienta, no escribas como si ya vinieran conversando.
Si hay respuesta real, responde primero a ella.
Si usas perfil, usa solo un detalle concreto.
Devuelve solo las 3 opciones numeradas.
`.trim();
}

module.exports = {
  construirUserPrompt
};
