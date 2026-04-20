// prompts/userPrompt.js
const { quitarTildes } = require("../lib/utils");

function construirUserPrompt({
  mode,
  anchor,
  textoPlano,
  clientePlano,
  contextoPlano,
  lecturaCliente,
  lecturaOperador,
  tonoCliente,
  contactoExterno,
  contactoEnBorrador,
  elementosClave,
  intencionOperador,
  guiaIntencion,
  metaEdicion,
  ghostwriterMode,
  perfilEstructurado,
  guiaPerfil,
  esChatNuevoOperativo,
  lineasClienteRecientes,
  lineasOperadorRecientes,
  mencionesGeograficasOperador,
  estadoConversacion,
  operadorTraeTemaPropio,
  anclarEnUltimoMensajeCliente,
  permisosApertura
}) {
  return `
CASO

MODO DETECTADO
${mode}

ANCLA OBLIGATORIA
${anchor || "sin ancla clara"}

BORRADOR DEL OPERADOR
"""
${textoPlano}
"""

ULTIMO MENSAJE REAL DE LA CLIENTA
"""
${clientePlano || "Sin mensaje claro"}
"""

ULTIMAS LINEAS RECIENTES DE CLIENTA
"""
${(lineasClienteRecientes || []).join("\n") || "Sin lineas recientes de clienta"}
"""

ULTIMAS LINEAS RECIENTES DE OPERADOR
"""
${(lineasOperadorRecientes || []).join("\n") || "Sin lineas recientes de operador"}
"""

CONTEXTO RELEVANTE
"""
${contextoPlano || "Sin contexto claro"}
"""

PERFIL ESTRUCTURADO
"""
INTERESES_EN_COMUN: ${(perfilEstructurado.interesesEnComun || []).join(" | ") || "Ninguno"}
INTERESES_CLIENTA: ${(perfilEstructurado.interesesClienta || []).join(" | ") || "Ninguno"}
DATOS_CLIENTA: ${(perfilEstructurado.datosClienta || []).join(" | ") || "Ninguno"}
"""

LECTURA DE LA CLIENTA
${quitarTildes(lecturaCliente)}

LECTURA DEL BORRADOR DEL OPERADOR
${quitarTildes(lecturaOperador)}

INTENCION DEL OPERADOR
${intencionOperador}

GUIA DE INTENCION
${quitarTildes(guiaIntencion)}

GUIA DE PERFIL
${quitarTildes(guiaPerfil || "Sin guia")}

ESTADO DE CONVERSACION
Hay respuesta real de la clienta: ${estadoConversacion?.hayConversacionReal ? "si" : "no"}
Solo hay mensajes del operador sin respuesta: ${estadoConversacion?.soloOperadorSinRespuesta ? "si" : "no"}
Chat vacio total: ${estadoConversacion?.chatVacioTotal ? "si" : "no"}
Operador trae tema propio claro: ${operadorTraeTemaPropio ? "si" : "no"}
Debes anclarte a lo ultimo de la clienta: ${anclarEnUltimoMensajeCliente ? "si" : "no"}

CONTROL DE APERTURA
Saludo explicito en borrador: ${permisosApertura.saludoExplicito ? "si" : "no"}
Primer contacto explicito en borrador: ${permisosApertura.primerContactoExplicito ? "si" : "no"}
Chat con historial o reenganche: ${permisosApertura.pareceChatViejo ? "si" : "no"}

ELEMENTOS A CONSERVAR
Nombre en apertura: ${elementosClave.nombreApertura || "ninguno"}
Terminos afectivos: ${elementosClave.afectivos.length ? elementosClave.afectivos.join(", ") : "ninguno"}
Meta edicion detectada: ${metaEdicion ? "si" : "no"}
Ghostwriter activo: ${ghostwriterMode ? "si" : "no"}
Chat nuevo o casi vacio: ${esChatNuevoOperativo ? "si" : "no"}

OTROS DATOS
Tono detectado de la clienta: ${tonoCliente}
Solicitud de contacto externo en clienta: ${contactoExterno ? "si" : "no"}
Solicitud de contacto externo en borrador: ${contactoEnBorrador ? "si" : "no"}
Menciones geograficas del operador: ${mencionesGeograficasOperador.length ? mencionesGeograficasOperador.join(" | ") : "ninguna"}

TAREA
Escribe una sola respuesta Premium entre 170 y 300 caracteres.
Debe sentirse humana, elegante, precisa y con interes real.
Debes respetar el MODO DETECTADO.
Debes usar la ANCLA OBLIGATORIA.
Si no hay respuesta previa real de la clienta, conviertelo en un enganche directo y no en continuidad falsa.
Si hay contacto externo, manten la charla dentro de la app con suavidad y redireccion concreta. No repitas numeros ni canales externos.
Si usas perfil, menciona un interes concreto.
No inventes saludos.
No inventes primer contacto.
No inventes nombres.
No conviertas hechos de la clienta en hechos del operador.
No propongas encuentros ni salir de la app.
Devuelve solo el mensaje final.
`.trim();
}

module.exports = {
  construirUserPrompt
};
