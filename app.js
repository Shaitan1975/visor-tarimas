// ═══════════════════════════════════════════════════════════════════
// VISOR TARIMAS - BACKEND v13
// Con JSONP + validación de duplicados + verificación de tarima
// Empresa: Mediese
// ═══════════════════════════════════════════════════════════════════

const DESTINATARIO = "sensabit@gmail.com";
const CC_COMPLETADO = "sensabit@gmail.com";
const SHEET_ID = "171i1B5MFv0N53xYs75IU2DG37iY1I2Wvtmmq234MmQY";
const HOJA_CATALOGO = "CATALOGO_TARIMAS";
const HOJA_EVENTOS = "EVENTOS";
const HOJA_ESTADO = "ESTADO_ACTUAL";

// ═══════════════════════════════════════════════════════════════════
// NORMALIZACIÓN DE QR_ID (por si acaso hay ceros de diferencia)
// ═══════════════════════════════════════════════════════════════════

function normalizarQR(qr) {
  if (!qr) return "";
  let s = qr.toString().trim().toUpperCase();
  s = s.replace(/-T0+(\d+)/g, "-T$1");
  return s;
}

// ═══════════════════════════════════════════════════════════════════
// ENDPOINT POST
// ═══════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    let body = null;

    if (e.postData && e.postData.contents) {
      const contents = e.postData.contents;
      try {
        body = JSON.parse(contents);
      } catch (err1) {
        const match = contents.match(/^data=([\s\S]+)$/);
        if (match) {
          try {
            body = JSON.parse(decodeURIComponent(match[1]));
          } catch (err2) {
            try {
              body = JSON.parse(match[1]);
            } catch (err3) {
              body = null;
            }
          }
        }
      }
    }

    if (!body && e.parameter && e.parameter.data) {
      try {
        body = JSON.parse(e.parameter.data);
      } catch (err4) {
        body = null;
      }
    }

    if (!body) {
      return respuesta({ ok: false, error: "No se pudo parsear el body" });
    }

    const accion = body.accion || "evento";

    if (accion === "registrar_tarima") {
      return registrarTarimaEnCatalogo(body);
    } else if (accion === "evento") {
      return registrarEvento(body);
    } else {
      return respuesta({ ok: false, error: "Acción desconocida: " + accion });
    }
  } catch (error) {
    console.error("Error:", error);
    return respuesta({ ok: false, error: error.toString() });
  }
}

// ═══════════════════════════════════════════════════════════════════
// ENDPOINT GET (con soporte JSONP)
// ═══════════════════════════════════════════════════════════════════

function doGet(e) {
  const accion = e.parameter ? e.parameter.accion : null;
  const callback = e.parameter ? e.parameter.callback : null;

  let resultado = null;

  if (accion === "estatus_camiones") {
    resultado = obtenerEstatusCamionesData();
  } else if (accion === "estatus_camion") {
    resultado = obtenerEstatusCamionData(e.parameter.camion);
  } else if (accion === "verificar_tarima") {
    resultado = verificarTarimaExiste(e.parameter.qr_id);
  } else if (accion === "evento") {
    let body = {};
    try {
      if (e.parameter.data) {
        body = JSON.parse(e.parameter.data);
      }
    } catch (err) {
      resultado = { ok: false, error: "Body inválido" };
    }
    if (!resultado) {
      resultado = registrarEventoData(body);
    }
  } else {
    resultado = { ok: true, mensaje: "Visor Tarimas activo" };
  }

  const jsonStr = JSON.stringify(resultado);

  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + jsonStr + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(jsonStr)
    .setMimeType(ContentService.MimeType.JSON);
}

function respuesta(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════
// VERIFICAR SI UNA TARIMA YA EXISTE EN EL CATÁLOGO
// ═══════════════════════════════════════════════════════════════════

function verificarTarimaExiste(qrId) {
  if (!qrId) return { ok: false, existe: false, error: "Falta qr_id" };

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const hoja = ss.getSheetByName(HOJA_CATALOGO);
  const datos = hoja.getDataRange().getValues();

  for (let i = 1; i < datos.length; i++) {
    if (datos[i][0] === qrId) {
      return { ok: true, existe: true, qr_id: qrId };
    }
  }

  return { ok: true, existe: false, qr_id: qrId };
}

// ═══════════════════════════════════════════════════════════════════
// REGISTRAR EVENTO VIA JSONP (con validación de duplicados)
// ═══════════════════════════════════════════════════════════════════

function registrarEventoData(body) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const hoja = ss.getSheetByName(HOJA_EVENTOS);

  const ahora = new Date();
  const fecha = Utilities.formatDate(ahora, "America/Mexico_City", "dd/MM/yyyy");
  const hora = Utilities.formatDate(ahora, "America/Mexico_City", "HH:mm:ss");
  const timestamp = ahora.toISOString();
  const ubicacion = obtenerUbicacion(body.evento);

  const qrId = body.qr_id || "";
  const camion = body.camion || "";
  const evento = body.evento || "";

  if (qrId && camion && evento) {
    const datosEventos = hoja.getDataRange().getValues();
    const qrNorm = normalizarQR(qrId);
    let yaRegistrado = false;
    let fechaRegistroAnterior = "";

    for (let i = 1; i < datosEventos.length; i++) {
      if (normalizarQR(datosEventos[i][1]) === qrNorm && datosEventos[i][5] === evento) {
        yaRegistrado = true;
        fechaRegistroAnterior = datosEventos[i][2] + " " + datosEventos[i][3];
        break;
      }
    }

    if (yaRegistrado) {
      return {
        ok: false,
        duplicado: true,
        error: "Esta tarima ya fue registrada",
        mensaje: "La tarima " + qrId + " ya tiene registrado el evento " + evento,
        fecha_anterior: fechaRegistroAnterior,
      };
    }
  }

  const idEvento = "EVT-" + ahora.getTime();

  let lotes = body.lotes || [];
  if (typeof lotes === "string") {
    try {
      lotes = JSON.parse(lotes);
    } catch (e) {
      lotes = [];
    }
  }
  if (!Array.isArray(lotes)) {
    lotes = [];
  }
  lotes = lotes.filter(l => l && typeof l === "object" && (l.lote || l.l));

  if (lotes.length > 0) {
    lotes.forEach(lote => {
      hoja.appendRow([
        idEvento, qrId, fecha, hora, timestamp, evento, ubicacion,
        camion, body.po || "", body.cedis || "", body.dc || "",
        body.sabor || "", body.num_tarima || "",
        lote.lote || lote.l || "", lote.pz || 0,
        body.usuario || "", body.nombre || "", body.rol || "", body.notas || "",
      ]);
    });
  } else {
    hoja.appendRow([
      idEvento, qrId, fecha, hora, timestamp, evento, ubicacion,
      camion, body.po || "", body.cedis || "", body.dc || "",
      body.sabor || "", body.num_tarima || "",
      "", "",
      body.usuario || "", body.nombre || "", body.rol || "", body.notas || "",
    ]);
  }

  actualizarEstadoActual(qrId);

  const estatus = calcularEstatusEvento(camion, evento);

  if (estatus.completado) {
    if (evento === "DEVOLUCION") {
      enviarCorreoDevolucion(camion, estatus);
    } else {
      enviarCorreoCompletado(camion, evento, estatus);
    }
  }

  return {
    ok: true,
    mensaje: "Evento registrado: " + evento,
    ubicacion: ubicacion,
    fecha: fecha,
    hora: hora,
    filas: lotes.length > 0 ? lotes.length : 1,
    estatus: estatus,
  };
}

// ═══════════════════════════════════════════════════════════════════
// REGISTRAR EVENTO (POST normal)
// ═══════════════════════════════════════════════════════════════════

function registrarEvento(body) {
  const result = registrarEventoData(body);
  return respuesta(result);
}

// ═══════════════════════════════════════════════════════════════════
// REGISTRAR TARIMA EN CATÁLOGO
// ═══════════════════════════════════════════════════════════════════

function registrarTarimaEnCatalogo(body) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const hoja = ss.getSheetByName(HOJA_CATALOGO);

  let lotes = body.lotes || [];
  if (typeof lotes === "string") {
    try {
      lotes = JSON.parse(lotes);
    } catch (e) {
      lotes = [];
    }
  }
  if (!Array.isArray(lotes)) {
    lotes = [];
  }
  lotes = lotes.filter(l => l && typeof l === "object" && (l.lote || l.l));

  const esPT = lotes.length > 0;

  if (esPT) {
    const fecha = body.fecha_gen || new Date().toLocaleDateString("es-MX");
    const hora = body.hora_gen || new Date().toLocaleTimeString("es-MX");

    lotes.forEach(lote => {
      const fila = [
        body.qr_id || "",
        fecha,
        hora,
        body.camion || "",
        body.año || new Date().getFullYear(),
        body.po || "",
        body.cedis || "",
        body.dc || "",
        body.sabor || "",
        body.sku || "",
        body.upc || "",
        body.num_tarima || 0,
        body.total_tarimas || 0,
        lote.lote || lote.l || "",
        lote.pz || 0,
        body.piezas_total || 0,
        body.unidad || "PZ",
        "PT",
      ];
      hoja.appendRow(fila);
    });

    return respuesta({
      ok: true,
      mensaje: "Tarima PT registrada: " + lotes.length + " filas",
    });
  } else {
    const fila = [
      body.qr_id || "",
      body.fecha_gen || new Date().toLocaleDateString("es-MX"),
      body.hora_gen || new Date().toLocaleTimeString("es-MX"),
      body.camion || "",
      body.año || new Date().getFullYear(),
      body.po || "",
      body.cedis || "",
      body.dc || "",
      body.sabor || "",
      body.sku || "",
      body.upc || "",
      body.num_tarima || 0,
      body.total_tarimas || 0,
      "",
      "",
      body.piezas_total || body.cantidad || 0,
      body.unidad || "PZ",
      "PT",
    ];
    hoja.appendRow(fila);
    return respuesta({ ok: true, mensaje: "Tarima registrada" });
  }
}

function obtenerUbicacion(evento) {
  const mapa = {
    "SALIDA_PLANTA": "PLANTA",
    "ADUANA_ENTRADA": "ADUANA",
    "ADUANA_SALIDA": "EN_TRANSITO",
    "ENTREGA_CEDIS": "CEDIS",
    "DEVOLUCION": "DEVUELTO",
    "REUBICACION": "ALMACEN",
  };
  return mapa[evento] || "DESCONOCIDO";
}

// ═══════════════════════════════════════════════════════════════════
// ESTATUS DE CAMIONES
// ═══════════════════════════════════════════════════════════════════

function obtenerEstatusCamionesData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const hojaCatalogo = ss.getSheetByName(HOJA_CATALOGO);
  const hojaEventos = ss.getSheetByName(HOJA_EVENTOS);

  const datosCatalogo = hojaCatalogo.getDataRange().getValues();
  const tarimasPorCamion = {};

  for (let i = 1; i < datosCatalogo.length; i++) {
    const qrId = datosCatalogo[i][0];
    const camion = datosCatalogo[i][3];
    if (!qrId || !camion) continue;
    if (!tarimasPorCamion[camion]) tarimasPorCamion[camion] = new Set();
    tarimasPorCamion[camion].add(normalizarQR(qrId));
  }

  const datosEventos = hojaEventos.getDataRange().getValues();
  const eventosPorCamion = {};

  for (let i = 1; i < datosEventos.length; i++) {
    const qrId = datosEventos[i][1];
    const camion = datosEventos[i][7];
    const evento = datosEventos[i][5];
    if (!qrId || !camion || !evento) continue;
    if (!eventosPorCamion[camion]) eventosPorCamion[camion] = {};
    if (!eventosPorCamion[camion][evento]) eventosPorCamion[camion][evento] = new Set();
    eventosPorCamion[camion][evento].add(normalizarQR(qrId));
  }

  const EVENTOS = ["SALIDA_PLANTA", "ADUANA_ENTRADA", "ADUANA_SALIDA", "ENTREGA_CEDIS", "DEVOLUCION"];
  const camiones = [];

  for (const camion in tarimasPorCamion) {
    const totalTarimas = tarimasPorCamion[camion].size;
    const eventos = {};
    let activo = false;

    EVENTOS.forEach(ev => {
      const registradas = eventosPorCamion[camion] && eventosPorCamion[camion][ev]
        ? eventosPorCamion[camion][ev].size : 0;
      const completado = registradas >= totalTarimas;
      const faltan = Math.max(0, totalTarimas - registradas);

      if (ev === "DEVOLUCION") {
        if (registradas > 0 && !completado) activo = true;
      } else {
        if (!completado) activo = true;
      }

      eventos[ev] = {
        registradas: registradas,
        total: totalTarimas,
        completado: completado,
        faltan: faltan,
      };
    });

    camiones.push({
      camion: camion,
      total_tarimas: totalTarimas,
      eventos: eventos,
      activo: activo,
    });
  }

  camiones.sort((a, b) => {
    if (a.activo !== b.activo) return a.activo ? -1 : 1;
    return b.camion.localeCompare(a.camion);
  });

  return { ok: true, camiones: camiones };
}

// ═══════════════════════════════════════════════════════════════════
// ESTATUS DE UN CAMIÓN ESPECÍFICO
// ═══════════════════════════════════════════════════════════════════

function obtenerEstatusCamionData(camion) {
  if (!camion) return { ok: false, error: "Falta camion" };

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const hojaCatalogo = ss.getSheetByName(HOJA_CATALOGO);
  const hojaEventos = ss.getSheetByName(HOJA_EVENTOS);

  // ── 1. Obtener tarimas del catálogo para este camión ──
  const datosCatalogo = hojaCatalogo.getDataRange().getValues();
  const tarimas = new Set();
  let po = "";

  for (let i = 1; i < datosCatalogo.length; i++) {
    if (datosCatalogo[i][3] === camion) {
      tarimas.add(datosCatalogo[i][0]);
      if (!po) po = datosCatalogo[i][5];
    }
  }

  // ── 2. Obtener eventos registrados para este camión ──
  const datosEventos = hojaEventos.getDataRange().getValues();
  const eventosDetalle = {};
  const EVENTOS = ["SALIDA_PLANTA", "ADUANA_ENTRADA", "ADUANA_SALIDA", "ENTREGA_CEDIS", "DEVOLUCION"];

  EVENTOS.forEach(ev => {
    eventosDetalle[ev] = { registradas: [], faltantes: [] };
  });

  for (let i = 1; i < datosEventos.length; i++) {
    if (datosEventos[i][7] === camion) {
      const qrId = datosEventos[i][1];
      const evento = datosEventos[i][5];
      if (eventosDetalle[evento]) {
        const qrNorm = normalizarQR(qrId);
        const yaExiste = eventosDetalle[evento].registradas.some(
          q => normalizarQR(q) === qrNorm
        );
        if (!yaExiste) {
          eventosDetalle[evento].registradas.push(qrId);
        }
      }
    }
  }

  // ── 3. Calcular faltantes para cada evento ──
  const tarimasArray = Array.from(tarimas);

  EVENTOS.forEach(ev => {
    const registradasNorm = eventosDetalle[ev].registradas.map(normalizarQR);
    eventosDetalle[ev].faltantes = tarimasArray.filter(t => {
      return !registradasNorm.includes(normalizarQR(t));
    });

    eventosDetalle[ev].total = tarimasArray.length;
    eventosDetalle[ev].completado =
      eventosDetalle[ev].faltantes.length === 0 && tarimasArray.length > 0;
  });

  // ── 4. Devolver resultado ──
  return {
    ok: true,
    camion: camion,
    po: po,
    total_tarimas: tarimasArray.length,
    eventos: eventosDetalle,
  };
}

function calcularEstatusEvento(camion, evento) {
  if (!camion || !evento) return { completado: false };

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const hojaCatalogo = ss.getSheetByName(HOJA_CATALOGO);
  const hojaEventos = ss.getSheetByName(HOJA_EVENTOS);

  const datosCatalogo = hojaCatalogo.getDataRange().getValues();
  const tarimas = new Set();
  for (let i = 1; i < datosCatalogo.length; i++) {
    if (datosCatalogo[i][3] === camion) tarimas.add(normalizarQR(datosCatalogo[i][0]));
  }

  const datosEventos = hojaEventos.getDataRange().getValues();
  const registradas = new Set();
  for (let i = 1; i < datosEventos.length; i++) {
    if (datosEventos[i][7] === camion && datosEventos[i][5] === evento) {
      registradas.add(normalizarQR(datosEventos[i][1]));
    }
  }

  return {
    completado: registradas.size >= tarimas.size && tarimas.size > 0,
    registradas: registradas.size,
    total: tarimas.size,
  };
}

// ═══════════════════════════════════════════════════════════════════
// ACTUALIZAR ESTADO ACTUAL
// ═══════════════════════════════════════════════════════════════════

function actualizarEstadoActual(qrId) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const hojaEventos = ss.getSheetByName(HOJA_EVENTOS);
  const hojaEstado = ss.getSheetByName(HOJA_ESTADO);

  const datos = hojaEventos.getDataRange().getValues();
  let ultimoEvento = null;

  for (let i = datos.length - 1; i >= 1; i--) {
    if (datos[i][1] === qrId) {
      ultimoEvento = datos[i];
      break;
    }
  }

  if (!ultimoEvento) return;

  const filaNueva = [
    qrId,
    ultimoEvento[7], ultimoEvento[8], ultimoEvento[9],
    ultimoEvento[10], ultimoEvento[11], ultimoEvento[12],
    ultimoEvento[5], ultimoEvento[2], ultimoEvento[3],
    ultimoEvento[6], 0, "ACTIVO",
  ];

  const datosEstado = hojaEstado.getDataRange().getValues();
  let filaExistente = -1;
  for (let i = 1; i < datosEstado.length; i++) {
    if (datosEstado[i][0] === qrId) {
      filaExistente = i + 1;
      break;
    }
  }

  if (filaExistente > 0) {
    hojaEstado.getRange(filaExistente, 1, 1, filaNueva.length).setValues([filaNueva]);
  } else {
    hojaEstado.appendRow(filaNueva);
  }
}

// ═══════════════════════════════════════════════════════════════════
// CORREOS
// ═══════════════════════════════════════════════════════════════════

function enviarCorreoCompletado(camion, evento, estatus) {
  const eventoTexto = formatearEvento(evento);
  const asunto = "✅ " + eventoTexto + " COMPLETADO - " + camion + " (" + estatus.registradas + "/" + estatus.total + ")";

  const cuerpoHTML = `
    <div style="font-family: Arial, sans-serif; max-width: 700px;">
      <h2 style="color: #1F7A1F;">✅ ${eventoTexto} COMPLETADO</h2>
      <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
        <tr><td style="padding: 8px; background: #F2F2F2;"><b>Camión:</b></td>
            <td style="padding: 8px;"><b>${camion}</b></td></tr>
        <tr><td style="padding: 8px; background: #F2F2F2;"><b>Evento:</b></td>
            <td style="padding: 8px;">${eventoTexto}</td></tr>
        <tr><td style="padding: 8px; background: #F2F2F2;"><b>Tarimas registradas:</b></td>
            <td style="padding: 8px;"><b>${estatus.registradas} de ${estatus.total}</b></td></tr>
        <tr><td style="padding: 8px; background: #F2F2F2;"><b>Fecha:</b></td>
            <td style="padding: 8px;">${Utilities.formatDate(new Date(), "America/Mexico_City", "dd/MM/yyyy HH:mm:ss")}</td></tr>
      </table>
      <p style="color: #888; font-size: 11px; margin-top: 30px;">
        Sistema Visor Tarimas - Mediese
      </p>
    </div>
  `;

  try {
    MailApp.sendEmail({
      to: DESTINATARIO,
      cc: CC_COMPLETADO,
      subject: asunto,
      htmlBody: cuerpoHTML,
    });
  } catch (e) {
    console.error("Error enviando correo:", e);
  }
}

function enviarCorreoDevolucion(camion, estatus) {
  const asunto = "🔄 DEVOLUCIÓN COMPLETA - " + camion + " (" + estatus.registradas + "/" + estatus.total + ")";

  const cuerpoHTML = `
    <div style="font-family: Arial, sans-serif; max-width: 700px;">
      <h2 style="color: #C00000;">🔄 DEVOLUCIÓN COMPLETA</h2>
      <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
        <tr><td style="padding: 8px; background: #F2F2F2;"><b>Camión:</b></td>
            <td style="padding: 8px;"><b>${camion}</b></td></tr>
        <tr><td style="padding: 8px; background: #F2F2F2;"><b>Tarimas devueltas:</b></td>
            <td style="padding: 8px;"><b>${estatus.registradas} de ${estatus.total}</b></td></tr>
        <tr><td style="padding: 8px; background: #F2F2F2;"><b>Fecha:</b></td>
            <td style="padding: 8px;">${Utilities.formatDate(new Date(), "America/Mexico_City", "dd/MM/yyyy HH:mm:ss")}</td></tr>
      </table>
      <p style="color: #888; font-size: 11px; margin-top: 30px;">
        Sistema Visor Tarimas - Mediese
      </p>
    </div>
  `;

  try {
    MailApp.sendEmail({
      to: DESTINATARIO,
      cc: CC_COMPLETADO,
      subject: asunto,
      htmlBody: cuerpoHTML,
    });
  } catch (e) {
    console.error("Error enviando correo devolución:", e);
  }
}

function formatearEvento(evento) {
  const mapa = {
    "SALIDA_PLANTA": "🚚 Salida de Planta",
    "ADUANA_ENTRADA": "🛃 Entrada a Aduana",
    "ADUANA_SALIDA": "📦 Salida de Aduana",
    "ENTREGA_CEDIS": "✅ Entrega en CEDIS",
    "DEVOLUCION": "🔄 Devolución",
    "REUBICACION": "📍 Reubicación",
  };
  return mapa[evento] || evento;
}
