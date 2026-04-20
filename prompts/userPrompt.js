// prompts/userPrompt.js
const { quitarTildes } = require("../lib/utils");

function construirUserPrompt({
  textoPlano,
  clientePlano,
  contextoPlano,
  perfilPlano,
  lecturaCliente,
  lecturaOperador,
  tonoCliente,
  contactoExterno,
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
CASO REAL

BORRADOR DEL OPERADOR
"""
${textoPlano}
"""

ULTIMO MENSAJE REAL DE LA CLIENTA
"""
${clientePlano || "Sin mensaje claro"}
"""

CONTEXTO RECIENTE DEL CHAT
"""
${contextoPlano || "Sin contexto claro"}
"""

ULTIMAS LINEAS DE CLIENTA
"""
${(lineasClienteRecientes || []).join("\n") || "Sin lineas recientes de clienta"}
"""

ULTIMAS LINEAS DE OPERADOR
"""
${(lineasOperadorRecientes || []).join("\n") || "Sin lineas recientes de operador"}
"""

PERFIL ESTRUCTURADO
"""
REGLA_PERFIL: ${perfilEstructurado.reglaPerfil || "Sin regla"}
INTERESES_EN_COMUN: ${(perfilEstructurado.interesesEnComun || []).join(" | ") || "Ninguno"}
INTERESES_CLIENTA: ${(perfilEstructurado.interesesClienta || []).join(" | ") || "Ninguno"}
DATOS_CLIENTA: ${(perfilEstructurado.datosClienta || []).join(" | ") || "Ninguno"}
"""

PERFIL VISIBLE ORIGINAL
"""
${perfilPlano || "Sin perfil claro"}
"""

LECTURA DE LA CLIENTA
${quitarTildes(lecturaCliente)}

LECTURA DEL BORRADOR DEL OPERADOR
${quitarTildes(lecturaOperador)}

TONO DETECTADO DE LA CLIENTA
${tonoCliente}

INTENCION DETECTADA DEL OPERADOR
${intencionOperador}

GUIA DE INTENCION
${quitarTildes(guiaIntencion)}

GUIA DE PERFIL
${quitarTildes(guiaPerfil || "Sin guia")}

SOLICITUD DE CONTACTO EXTERNO
${contactoExterno ? "si" : "no"}

ELEMENTOS DEL BORRADOR QUE DEBES CONSERVAR
Nombre en apertura: ${elementosClave.nombreApertura || "ninguno"}
Terminos afectivos: ${elementosClave.afectivos.length ? elementosClave.afectivos.join(", ") : "ninguno"}
Mensaje corto: ${elementosClave.mensajeCorto ? "si" : "no"}
Meta edicion detectada: ${metaEdicion ? "si" : "no"}
Ghostwriter activo: ${ghostwriterMode ? "si" : "no"}
Chat nuevo o casi vacio: ${esChatNuevoOperativo ? "si" : "no"}

MENCIONES GEOGRAFICAS DEL OPERADOR
${mencionesGeograficasOperador.length ? mencionesGeograficasOperador.join(" | ") : "ninguna"}

CONTROL DE APERTURA
Saludo explicito en borrador: ${permisosApertura.saludoExplicito ? "si" : "no"}
Primer contacto explicito en borrador: ${permisosApertura.primerContactoExplicito ? "si" : "no"}
Chat con historial o reenganche: ${permisosApertura.pareceChatViejo ? "si" : "no"}

ESTADO DE CONVERSACION
Hay respuesta real de la clienta: ${estadoConversacion?.hayConversacionReal ? "si" : "no"}
Solo hay mensajes del operador sin respuesta: ${estadoConversacion?.soloOperadorSinRespuesta ? "si" : "no"}
Chat vacio total: ${estadoConversacion?.chatVacioTotal ? "si" : "no"}
Operador trae tema propio claro: ${operadorTraeTemaPropio ? "si" : "no"}
Debes anclarte a lo ultimo de la clienta: ${anclarEnUltimoMensajeCliente ? "si" : "no"}

REGLA DURA DE ROLES
Todo lo que este en CLIENTA pertenece a la clienta
Todo lo que este en OPERADOR pertenece al operador
No conviertas hechos de CLIENTA en primera persona del operador

REGLA DURA DE APERTURA
Si el operador no escribio saludo, no abras con hola, hey, hi, buenas ni equivalente
Si el operador no escribio una intencion de primer contacto, no metas frases como conocerte, conocer mas de ti, saber mas de ti, romper el hielo o similares
Si el chat ya tiene historial, no lo trates como cliente nuevo

REGLA DURA DE CONTINUIDAD
Si no hay respuesta real de la clienta, no digas seguir conversando, retomar, continuar, volver a hablar, como te decia, otra vez ni equivalente
Si si hay mensajes recientes de la clienta y el operador no trae un tema nuevo claro, primero usa lo ultimo que dijo ella
Incluso con historial real, evita muletillas repetitivas como seguir conversando o seguir por aqui si puedes responder algo concreto

REGLA DURA DE INTERESES
Si hay INTERESES_EN_COMUN, usalos primero
Si no hay INTERESES_EN_COMUN, puedes usar INTERESES_CLIENTA
No digas que algo esta en comun si solo aparece en INTERESES_CLIENTA

REGLA DURA DE GEOGRAFIA
Si el operador menciona un lugar, puedes corregir la ortografia de ese mismo lugar
No puedes cambiarlo por otro distinto
Si el operador no menciona ningun lugar, no inventes ciudad, estado o pais
Si el operador dice un pais, no lo reduzcas a una ciudad

REGLA DURA DE META
Si el borrador parece una autoevaluacion o comentario sobre la calidad del mensaje, transformalo en un mensaje final para la clienta
No respondas literalmente a ese comentario ni como si el operador te estuviera hablando a ti

RESTRICCION ABSOLUTA
Nunca propongas vernos, salir, cenar, tomar algo, conocernos en persona, visitarnos ni ningun plan presencial

OBJETIVO DE LAS 3 SALIDAS
1. 200 a 260 caracteres, directa y agradable
2. 200 a 260 caracteres, mas atractiva o emocional
3. 320 a 420 caracteres, mas desarrollada y envolvente

TAREA FINAL
Reescribe el borrador del operador en 3 versiones mejores
Conserva el sentido principal
Ayuda aunque el borrador sea corto
Usa el ultimo mensaje de la clienta como prioridad cuando exista
Si no hay respuesta previa real de la clienta, convierte el texto en un enganche directo y no en continuidad falsa
Si la clienta acaba de compartir una noticia personal o un hecho importante, reconocelo primero de forma breve y natural
Usa contexto o perfil solo si mejoran de verdad la respuesta
Si el borrador es flojo, reclama o no engancha, conviertelo en un mensaje mejor y mas interesante
Mantente dentro de la app si hay solicitud de contacto externo
No sugieras encuentros presenciales
No inventes saludos
No inventes primer contacto
No contestes al operador como si el texto fuera una consulta para la herramienta
No conviertas hechos de la clienta en hechos del operador
Escribe como si la clienta fuera a leer el mensaje final
`.trim();
}

module.exports = {
  construirUserPrompt
};