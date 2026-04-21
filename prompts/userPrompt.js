const { quitarTildes } = require("../lib/utils");

function construirUserPrompt({
  mode,
  anchor,
  planSummary,
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
  permisosApertura,
  chosenInterest,
  recentAvoid,
  fastMode
}) {
  const interesPrioritario =
    chosenInterest ||
    perfilEstructurado?.interesesEnComun?.[0] ||
    perfilEstructurado?.interesesClienta?.[0] ||
    "";

  return `
CASO

MODO DETECTADO
${mode}

ANCLA OBLIGATORIA
${anchor || "sin ancla clara"}

RESUMEN DE PLAN
${planSummary || "seguir el tema real del borrador"}

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
INTERES_PRIORITARIO: ${interesPrioritario || "Ninguno"}
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

FRASES RECIENTES A EVITAR
${(recentAvoid || []).join(" | ") || "sin referencias"}

TAREA
Devuelve ${fastMode ? "1" : "3"} opciones numeradas.
Cada opcion debe:
- sentirse escrita por una persona real
- sonar directa y natural
- usar la ancla obligatoria o lo ultimo que dijo la clienta
- evitar explicaciones sobre el mensaje
- tener como maximo una pregunta
- quedar entre 170 y 300 caracteres
- poder pegarse tal cual en el chat

NO HAGAS
- no hables del mensaje, del borrador ni de responder mejor
- no uses frases como no queria dejarte algo frio ni comun, preferi escribirte mejor, me quede pensando en lo ultimo que compartiste, responderte con mas intencion, lo reformulo mejor
- no suenes coach, poeta ni asistente
- no propongas encuentros ni salir de la app
- no inventes nombres
- no inventes primer contacto
- no conviertas hechos de la clienta en hechos del operador

Devuelve solo las opciones numeradas.
`.trim();
}

module.exports = {
  construirUserPrompt
};
