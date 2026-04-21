const { quitarTildes } = require("../lib/utils");

function construirUserPrompt({
  mode,
  tipoTrabajo,
  tipoContacto,
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
  objetivoLongitud,
  ubicacionVisiblePerfil,
  feedbackCorreccion = ""
}) {
  const interesPrioritario =
    perfilEstructurado?.interesesEnComun?.[0] ||
    perfilEstructurado?.interesesClienta?.[0] ||
    "";

  const guiaTrabajo = {
    simple_profile_fastpath:
      "Debes resolver una pregunta simple usando un detalle claro del perfil o una observacion directa. Nada de discurso.",
    rewrite_operator_draft:
      "Tu tarea es mejorar el borrador del operador manteniendo su intencion. No respondas como si la clienta hubiera dicho el borrador.",
    reply_last_client_message:
      "Debes responder primero lo ultimo que dijo la clienta y luego, si cabe, enlazar con la intencion del operador.",
    complex_reframe:
      "Debes resolver un caso complejo con tacto y utilidad real, sin sonar robot."
  }[tipoTrabajo] || "Mejora el borrador sin cambiar el rol.";

  const guiaContacto = {
    nuevo_total:
      "Cliente nueva. Engancha como primer acercamiento.",
    viejo_sin_respuesta:
      "Hay historial del operador, pero no respuesta real de la clienta. No finjas continuidad ni respondas como si ella ya hubiera abierto tema.",
    viejo_con_respuesta:
      "Ya hubo respuesta real de la clienta. Responde eso primero."
  }[tipoContacto] || "Cliente nueva.";

  return `
CASO

MODO DETECTADO
${mode}

TIPO DE TRABAJO
${tipoTrabajo}

TIPO DE CONTACTO
${tipoContacto}

ANCLA OBLIGATORIA
${anchor || "sin ancla clara"}

RESUMEN DE PLAN
${planSummary || "seguir el tema real del borrador"}

OBJETIVO DE LONGITUD
Perfil: ${objetivoLongitud?.profile || "medio"}
Rango: ${objetivoLongitud?.min || 80}-${objetivoLongitud?.max || 150} caracteres
Estructura ideal: ${objetivoLongitud?.shape || "una reaccion concreta y un cierre simple"}
Guia: ${objetivoLongitud?.instruction || "si el caso es simple, responde simple"}

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
UBICACION_VISIBLE_PERFIL: ${ubicacionVisiblePerfil || "ninguna"}
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

GUIA DE TRABAJO
${quitarTildes(guiaTrabajo)}

GUIA DE CONTACTO
${quitarTildes(guiaContacto)}

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
Escribe una sola respuesta final.

La respuesta debe:
- sentirse humana
- sonar como alguien real interesado en la charla
- usar la ancla obligatoria
- responder primero lo ultimo de la clienta si aplica
- mantener la intencion del operador
- respetar el objetivo de longitud
- si el caso es simple, no alargarlo
- si usas perfil, usar solo un detalle concreto
- si la ubicacion del perfil es util, puedes mencionarla de forma simple
- si la clienta viene fria o breve, no des discurso
- si el operador hizo una pregunta simple y clara, no la conviertas en ensayo

ESTILO IDEAL SEGUN LONGITUD
- caso corto: observacion breve + pregunta corta
- caso medio: reaccion concreta + una pregunta o cierre ligero
- caso largo: reconocimiento breve + punto concreto + cierre ligero

NO HAGAS
- no hables del mensaje ni del borrador
- no digas que querias escribir mejor
- no digas que respondes con mas intencion
- no uses frases tipo eso que dijiste, por como lo dijiste, siempre hablas asi o me quede pensando en lo ultimo que compartiste
- no inventes saludos
- no inventes primer contacto
- no inventes nombres
- no conviertas hechos de la clienta en hechos del operador
- no inventes experiencias personales del operador sobre un pais o ciudad
- no propongas encuentros ni salir de la app
- no uses frases abstractas como lo que te inspira, lo que te apasiona, lo que mas te representa o tu mejor energia
- no rellenes solo para llegar a una longitud si el caso da para algo corto
- no uses tono de coach, poeta o asistente

${feedbackCorreccion ? `CORRECCION OBLIGATORIA\n${feedbackCorreccion}\n` : ""}

Devuelve solo el mensaje final.
`.trim();
}

module.exports = {
  construirUserPrompt
};
