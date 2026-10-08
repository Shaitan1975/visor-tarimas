// ═══════════════════════════════════════════════════════════════════
// VISOR TARIMAS - LÓGICA DE LA PWA (v28)
// Multi-CEDIS + Cálculo por PO (salidas de EVENTOS) + FIFO
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  APPS_SCRIPT_URL: `https://script.google.com/macros/s/AKfycbwjCqDsjwCGqxHsXpUk9za12KBC_iLdfJaKGPBTX--eQ4vXHzmT3ZKSB-6LexLFi0nH/exec`,
  CLAVE_EMPRESA: "MediesE2026$Almacen",
  SALT_PBKDF2: "salt-fijo-empresa-2026",
  ITERACIONES: 100000,
  SESSION_KEY: "visor_tarimas_session",
  CAMION_KEY: "visor_tarimas_camion_actual"
};

const EVENTOS = {
  "SALIDA_PLANTA": { etiqueta: "🚚 SALIDA DE PLANTA", ubicacion: "PLANTA", color: "#1F4E79", icono: "🚚" },
  "ADUANA_ENTRADA": { etiqueta: "🛃 ENTRADA A ADUANA", ubicacion: "ADUANA", color: "#B8860B", icono: "🛃" },
  "ADUANA_SALIDA": { etiqueta: "📦 SALIDA DE ADUANA", ubicacion: "EN_TRANSITO", color: "#8B4513", icono: "📦" },
  "ENTREGA_CEDIS": { etiqueta: "✅ ENTREGA EN CEDIS", ubicacion: "CEDIS", color: "#1F7A1F", icono: "✅" },
  "DEVOLUCION": { etiqueta: "🔄 DEVOLUCIÓN", ubicacion: "DEVUELTO", color: "#C00000", icono: "🔄" },
};

const MAPA_LUGARES = {
  "planta": "SALIDA_PLANTA",
  "aduana-entrada": "ADUANA_ENTRADA",
  "aduana-salida": "ADUANA_SALIDA",
  "cedis": "ENTREGA_CEDIS",
  "devolucion": "DEVOLUCION",
};

const SKUS_VALIDOS = ["MK150", "MKLM150", "MKCH150"];

const App = (() => {

  let modoSeleccionado = null;
  let catalogoCache = null;
  let contextoCancelar = null;

  function getSession() {
    const s = localStorage.getItem(CONFIG.SESSION_KEY);
    return s ? JSON.parse(s) : null;
  }
  function setSession(d) { localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(d)); }
  function clearSession() { localStorage.removeItem(CONFIG.SESSION_KEY); }

  function getCamionActual() { return localStorage.getItem(CONFIG.CAMION_KEY) || null; }
  function setCamionActual(camion) { if (camion) localStorage.setItem(CONFIG.CAMION_KEY, camion); }
  function limpiarCamionActual() { localStorage.removeItem(CONFIG.CAMION_KEY); }

  async function pbkdf2Hash(password, saltHex) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
    );
    const saltBytes = new Uint8Array(saltHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: saltBytes, iterations: CONFIG.ITERACIONES, hash: "SHA-256" },
      keyMaterial, 256
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function verificarUsuario(usuario, password) {
    try {
      const resp = await fetch("usuarios.json?t=" + Date.now(), {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" }
      });
      const usuarios = await resp.json();
      const user = usuarios.find(u => u.user === usuario.toLowerCase().trim());
      if (!user) return null;
      const hashCalc = await pbkdf2Hash(password, user.salt);
      if (hashCalc === user.hash) {
        return {
          user: user.user, nombre: user.nombre, rol: user.rol,
          ubicacion: user.ubicacion || "planta",
          eventos_permitidos: user.eventos_permitidos || ["SALIDA_PLANTA"],
        };
      }
      return null;
    } catch (e) { return null; }
  }

  function descifrarBlobQR(blobB64, password) {
    const key = CryptoJS.PBKDF2(password, CONFIG.SALT_PBKDF2, {
      keySize: 256 / 32, iterations: CONFIG.ITERACIONES, hasher: CryptoJS.algo.SHA256
    });
    let normalized = blobB64.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4 !== 0) normalized += "=";
    const combined = CryptoJS.enc.Base64.parse(normalized);
    const combinedHex = combined.toString(CryptoJS.enc.Hex);
    const ivHex = combinedHex.substring(0, 32);
    const ciphertextHex = combinedHex.substring(32);
    const iv = CryptoJS.enc.Hex.parse(ivHex);
    const ciphertext = CryptoJS.enc.Hex.parse(ciphertextHex);
    const decrypted = CryptoJS.AES.decrypt(
      { ciphertext: ciphertext }, key,
      { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
    );
    const texto = decrypted.toString(CryptoJS.enc.Utf8);
    if (!texto) throw new Error("Contraseña incorrecta o datos corruptos");
    return JSON.parse(texto);
  }

  function parsearQRPT(texto) {
    const partes = {};
    texto.split("|").forEach(p => {
      const idx = p.indexOf(":");
      if (idx > 0) partes[p.substring(0, idx).trim()] = p.substring(idx + 1).trim();
    });
    let lotes = [];
    if (partes.LOTES) {
      partes.LOTES.split(",").forEach(l => {
        const idx = l.indexOf(":");
        if (idx > 0) {
          lotes.push({
            lote: l.substring(0, idx).trim(),
            pz: parseInt(l.substring(idx + 1).trim()) || 0
          });
        }
      });
    }
    const dc = partes.DC || "";
    const tarima = partes.TARIMA || "";
    return {
      o: dc, l: tarima,
      po: partes.PO || "", cedis: partes.CEDIS || "",
      dc: dc, s: partes.S || "",
      c: partes.CAM || "", camion: partes.CAM || "",
      num_tarima: tarima, t: tarima,
      tot: partes.TOT || "",
      lotes: lotes, es_pt: true,
    };
  }

  function initLogin() {
    if (getSession()) { window.location.href = "scanner.html"; return; }
    const form = document.getElementById("login-form");
    const errorMsg = document.getElementById("error-msg");
    const btn = form.querySelector("button");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorMsg.textContent = "";
      btn.disabled = true;
      btn.textContent = "Verificando...";
      const usuario = document.getElementById("usuario").value;
      const password = document.getElementById("password").value;
      const user = await verificarUsuario(usuario, password);
      if (user) {
        setSession(user);
        window.location.href = "scanner.html";
      } else {
        errorMsg.textContent = "Usuario o contraseña incorrectos";
        btn.disabled = false;
        btn.textContent = "Entrar";
      }
    });
  }

  let stream = null;
  let scanning = false;

  function initScanner() {
    const session = getSession();
    if (!session) { window.location.href = "index.html"; return; }

    document.getElementById("user-info").textContent = `${session.nombre} (${session.rol})`;

    if (session.rol === "admin") {
      document.getElementById("btn-registro-manual").classList.remove("hidden");
    }

    const ROLES_PEDIDOS = ["gerencia", "admin"];
    if (ROLES_PEDIDOS.includes(session.rol)) {
      const btnPedidos = document.getElementById("btn-pedidos");
      if (btnPedidos) btnPedidos.classList.remove("hidden");
      const btnGenQR = document.getElementById("btn-generar-qr");
      if (btnGenQR) btnGenQR.classList.remove("hidden");
    }

    document.getElementById("btn-logout").addEventListener("click", () => {
      clearSession();
      window.location.href = "index.html";
    });

    const btnCambiar = document.getElementById("btn-cambiar-evento");
    if (btnCambiar) {
      btnCambiar.addEventListener("click", () => {
        modoSeleccionado = null;
        iniciarFlujo(session);
      });
    }

    document.getElementById("btn-start-scan").addEventListener("click", iniciarCamara);
    document.getElementById("btn-cancel-scan").addEventListener("click", cancelarCamara);
    document.getElementById("btn-scan-again").addEventListener("click", () => {
      document.getElementById("send-status").textContent = "";
      mostrarVista("view-ready");
    });

    document.getElementById("btn-ver-estatus").addEventListener("click", verEstatusCamiones);
    document.getElementById("btn-cerrar-estatus").addEventListener("click", () => mostrarVista("view-ready"));
    document.getElementById("btn-cerrar-detalle").addEventListener("click", verEstatusCamiones);

    const btnLimpiar = document.getElementById("btn-limpiar-progreso");
    if (btnLimpiar) {
      btnLimpiar.addEventListener("click", () => {
        if (confirm("¿Cerrar el progreso del camión actual?")) {
          const camion = getCamionActual();
          if (camion) window['camion_' + camion + '_completado_alertado'] = false;
          limpiarCamionActual();
          actualizarProgresoPantalla();
        }
      });
    }

    document.getElementById("btn-registro-manual").addEventListener("click", abrirRegistroManual);
    document.getElementById("btn-cerrar-manual").addEventListener("click", cerrarRegistroManual);
    document.getElementById("manual-camion").addEventListener("change", onCamionSeleccionado);
    document.getElementById("btn-registrar-manual").addEventListener("click", registrarEventoManual);
    document.getElementById("btn-registrar-otro").addEventListener("click", resetFormularioManual);

    const btnCerrarCancelar = document.getElementById("btn-cerrar-cancelar");
    if (btnCerrarCancelar) {
      btnCerrarCancelar.addEventListener("click", () => mostrarVista("view-detalle-camion"));
    }
    const btnConfirmarCancelar = document.getElementById("btn-confirmar-cancelar");
    if (btnConfirmarCancelar) {
      btnConfirmarCancelar.addEventListener("click", ejecutarCancelar);
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").then(reg => {
        reg.update().catch(() => {});
      }).catch(() => {});
    }

    window.addEventListener("focus", () => {
      const estatusVisible = !document.getElementById("view-estatus").classList.contains("hidden");
      if (estatusVisible) verEstatusCamiones();
    });

    iniciarFlujo(session);
  }

  function iniciarFlujo(session) {
    const params = new URLSearchParams(window.location.search);
    const lugarParam = params.get("lugar");
    if (lugarParam && MAPA_LUGARES[lugarParam]) {
      modoSeleccionado = MAPA_LUGARES[lugarParam];
      aplicarModo(EVENTOS[modoSeleccionado]);
      mostrarVista("view-ready");
      return;
    }
    const eventos = session.eventos_permitidos || ["SALIDA_PLANTA"];
    if (eventos.length === 0) {
      alert("Tu usuario no tiene eventos asignados.");
      clearSession();
      window.location.href = "index.html";
      return;
    }
    if (eventos.length === 1) {
      modoSeleccionado = eventos[0];
      aplicarModo(EVENTOS[modoSeleccionado]);
      mostrarVista("view-ready");
      return;
    }
    mostrarSelector(eventos);
  }

  function mostrarSelector(eventos) {
    ["view-ready", "view-scanning", "view-loading", "view-result", "view-selector",
     "view-estatus", "view-detalle-camion", "view-manual", "view-cancelar",
     "pantalla-pedidos", "pantalla-form-pedido", "pantalla-detalle-pedido"]
      .forEach(v => {
        const el = document.getElementById(v);
        if (el) el.classList.add("hidden");
      });

    const banner = document.getElementById("modo-indicador");
    if (banner) banner.style.display = "none";

    const contenedor = document.getElementById("lista-eventos");
    contenedor.innerHTML = "";

    eventos.forEach(ev => {
      const info = EVENTOS[ev];
      if (!info) return;
      const btn = document.createElement("button");
      btn.className = "btn-evento";
      btn.style.background = info.color;
      btn.innerHTML = `${info.icono}<br/><span>${info.etiqueta}</span>`;
      btn.addEventListener("click", () => {
        modoSeleccionado = ev;
        aplicarModo(info);
        mostrarVista("view-ready");
      });
      contenedor.appendChild(btn);
    });
    document.getElementById("view-selector").classList.remove("hidden");
  }

  function aplicarModo(info) {
    const banner = document.getElementById("modo-indicador");
    const texto = document.getElementById("modo-texto");
    const icono = document.getElementById("modo-icono");
    if (banner) banner.style.display = "flex";
    if (texto) texto.textContent = info.etiqueta;
    if (icono) icono.textContent = info.icono;
    if (banner) banner.style.background = info.color;

    const btnCambiar = document.getElementById("btn-cambiar-evento");
    if (btnCambiar) {
      const session = getSession();
      if (session && session.eventos_permitidos && session.eventos_permitidos.length > 1) {
        btnCambiar.classList.remove("hidden");
      } else {
        btnCambiar.classList.add("hidden");
      }
    }
    const readyTitulo = document.getElementById("ready-titulo");
    const readyDesc = document.getElementById("ready-descripcion");
    if (readyTitulo) readyTitulo.textContent = info.etiqueta;
    if (readyDesc) readyDesc.textContent = "Escanea cada tarima para registrar el evento.";
  }

  function mostrarVista(id) {
    ["view-ready", "view-scanning", "view-loading", "view-result", "view-selector",
     "view-estatus", "view-detalle-camion", "view-manual", "view-cancelar"]
      .forEach(v => {
        const el = document.getElementById(v);
        if (el) el.classList.add("hidden");
      });
    document.getElementById(id).classList.remove("hidden");
    if (id === "view-ready") actualizarProgresoPantalla();
  }

  async function iniciarCamara() {
    mostrarVista("view-scanning");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const video = document.getElementById("qr-video");
      video.srcObject = stream;
      video.setAttribute("playsinline", true);
      await video.play();
      scanning = true;
      requestAnimationFrame(tick);
    } catch (e) {
      alert("No se pudo acceder a la cámara:\n" + e.message);
      mostrarVista("view-ready");
    }
  }

  function cancelarCamara() {
    scanning = false;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    mostrarVista("view-ready");
  }

  function tick() {
    if (!scanning) return;
    const video = document.getElementById("qr-video");
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code && code.data) {
        scanning = false;
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        procesarQR(code.data);
        return;
      }
    }
    requestAnimationFrame(tick);
  }

  async function procesarQR(datosQR) {
    mostrarVista("view-loading");
    document.getElementById("loading-text").textContent = "Registrando evento...";

    try {
      let datos = null;
      if (datosQR.includes("PO:") && datosQR.includes("|")) {
        datos = parsearQRPT(datosQR);
      } else {
        datos = descifrarBlobQR(datosQR, CONFIG.CLAVE_EMPRESA);
      }

      const session = getSession();
      const numTarimaStr = String(datos.num_tarima || "").padStart(2, "0");

      const payload = {
        accion: "evento",
        qr_id: (datos.camion || "") + "-DC" + (datos.dc || "") + "-" + (datos.s || "") + "-T" + numTarimaStr,
        camion: datos.c || datos.camion || "",
        po: datos.po || "",
        cedis: datos.cedis || "",
        dc: datos.dc || datos.g || datos.o || "",
        sabor: datos.s || datos.sabor || "",
        num_tarima: datos.num_tarima || datos.t || 0,
        evento: modoSeleccionado,
        usuario: session.user,
        nombre: session.nombre,
        rol: session.rol,
        notas: "",
      };

      if (datos.lotes && datos.lotes.length > 0) payload.lotes = datos.lotes;

      const url = CONFIG.APPS_SCRIPT_URL + "?accion=evento&data=" + encodeURIComponent(JSON.stringify(payload));
      const resp = await jsonp(url);

      if (!resp.ok) {
        if (resp.duplicado) {
          setTimeout(() => {
            alert("⚠️ TARIMA YA REGISTRADA\n\n" + resp.mensaje + "\n\nRegistrada el: " + resp.fecha_anterior);
            mostrarVista("view-ready");
          }, 300);
          return;
        } else {
          throw new Error(resp.error || "Error desconocido");
        }
      }

      if (payload.camion) setCamionActual(payload.camion);
      setTimeout(() => mostrarExito(datos, session), 100);
      actualizarProgresoPantalla();

    } catch (e) {
      setTimeout(() => {
        alert("Error al procesar el QR:\n\n" + e.message);
        mostrarVista("view-ready");
      }, 300);
    }
  }

  function mostrarExito(datos, session) {
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString("es-MX");
    const hora = ahora.toLocaleTimeString("es-MX");
    const info = EVENTOS[modoSeleccionado];

    document.getElementById("result-titulo").textContent = "OK: " + info.etiqueta;
    document.getElementById("result-subtitulo").textContent = (datos.dc ? "DC " + datos.dc : "") + " " + (datos.s || "");
    document.getElementById("meta-evento").textContent = modoSeleccionado;
    document.getElementById("meta-ubicacion").textContent = info.ubicacion;
    document.getElementById("meta-fecha").textContent = fecha + " " + hora;
    document.getElementById("meta-camion").textContent = datos.c || datos.camion || "-";
    document.getElementById("meta-dc").textContent = datos.dc || "-";
    document.getElementById("meta-sabor").textContent = datos.s || "-";
    document.getElementById("meta-lote").textContent =
      (datos.lotes && datos.lotes.length > 0)
        ? datos.lotes.map(l => l.lote + " (" + l.pz + " PZ)").join(", ")
        : (datos.lote || datos.l || "-");
    document.getElementById("meta-tarima").textContent = datos.num_tarima || datos.t || "-";
    document.getElementById("meta-po").textContent = datos.po || "-";
    mostrarVista("view-result");
  }

  async function actualizarProgresoPantalla() {
    const camion = getCamionActual();
    const contenedor = document.getElementById("progreso-camion");
    const btnLimpiar = document.getElementById("btn-limpiar-progreso");
    if (!contenedor) return;

    if (!camion) {
      contenedor.innerHTML = "";
      contenedor.classList.add("hidden");
      if (btnLimpiar) btnLimpiar.classList.add("hidden");
      return;
    }
    if (btnLimpiar) btnLimpiar.classList.remove("hidden");
    contenedor.classList.remove("hidden");
    contenedor.innerHTML = '<div class="progreso-loading">⏳ Cargando progreso...</div>';

    try {
      const data = await jsonp(CONFIG.APPS_SCRIPT_URL + "?accion=estatus_camion&camion=" + encodeURIComponent(camion));
      if (!data.ok) throw new Error("Error");
      const eventoActual = modoSeleccionado || "SALIDA_PLANTA";
      const info = EVENTOS[eventoActual];
      const ev = data.eventos[eventoActual];
      if (!ev) throw new Error("Evento no encontrado");

      const pct = ev.total > 0 ? Math.round((ev.registradas.length / ev.total) * 100) : 0;
      const completado = ev.completado;

      let html = '<div class="progreso-titulo">';
      html += '<span class="progreso-icono">🚚</span>';
      html += '<span class="progreso-camion-nombre">' + camion + '</span>';
      html += '<span class="progreso-evento">' + info.icono + ' ' + info.etiqueta + '</span>';
      html += '</div>';
      html += '<div class="progreso-barra"><div class="progreso-barra-relleno" style="width: ' + pct + '%;"></div></div>';
      html += '<div class="progreso-numeros">';
      if (completado) {
        html += '<span class="progreso-completo">✅ COMPLETADO ' + ev.registradas.length + '/' + ev.total + '</span>';
      } else {
        html += '<span class="progreso-conteo">📊 ' + ev.registradas.length + '/' + ev.total + '</span>';
        html += '<span class="progreso-faltan">⏳ Faltan ' + ev.faltantes.length + '</span>';
      }
      html += '</div>';

      if (completado && !window['camion_' + camion + '_completado_alertado']) {
        window['camion_' + camion + '_completado_alertado'] = true;
        setTimeout(() => {
          alert("✅ ¡CAMIÓN " + camion + " COMPLETADO!");
        }, 500);
      }

      if (ev.registradas.length > 0) {
        html += '<div class="progreso-lista-titulo"><span>✅ Registradas (' + ev.registradas.length + '):</span></div>';
        html += '<div class="progreso-lista">';
        ev.registradas.slice().reverse().forEach(qr => {
          html += '<span class="chip-registrada">✅ ' + qr + '</span>';
        });
        html += '</div>';
      }

      const MAX_FALTANTES = 28;
      if (ev.faltantes.length > 0 && !completado) {
        html += '<div class="progreso-lista-titulo"><span>⏳ Faltantes (' + ev.faltantes.length + '):</span></div>';
        html += '<div class="progreso-lista progreso-lista-faltantes">';
        ev.faltantes.slice(0, MAX_FALTANTES).forEach(qr => {
          html += '<span class="chip-faltante">⏳ ' + qr + '</span>';
        });
        if (ev.faltantes.length > MAX_FALTANTES) {
          html += '<span class="chip-mas">+ ' + (ev.faltantes.length - MAX_FALTANTES) + ' más...</span>';
        }
        html += '</div>';
      }

      contenedor.innerHTML = html;
    } catch (e) {
      contenedor.innerHTML = '<div class="progreso-error">⚠️ Error al cargar progreso</div>';
    }
  }

  function abrirRegistroManual() {
    const session = getSession();
    if (!session || session.rol !== "admin") { alert("No tienes permisos."); return; }
    document.getElementById("manual-camion").value = "";
    document.getElementById("manual-evento").value = "";
    document.getElementById("manual-tarima").innerHTML = '<option value="">-- Primero selecciona un camión --</option>';
    document.getElementById("manual-notas").value = "";
    document.getElementById("manual-registro-status").textContent = "";
    document.getElementById("manual-registro-status").className = "send-status";
    document.getElementById("btn-registrar-otro").classList.add("hidden");
    cargarCatalogoManual();
    mostrarVista("view-manual");
  }

  function cerrarRegistroManual() { mostrarVista("view-ready"); }

  async function cargarCatalogoManual() {
    const selectCamion = document.getElementById("manual-camion");
    selectCamion.innerHTML = '<option value="">-- Cargando camiones... --</option>';
    try {
      const data = await jsonp(CONFIG.APPS_SCRIPT_URL + "?accion=listar_catalogo");
      if (!data.ok) throw new Error("Error al cargar catálogo");
      catalogoCache = data.camiones;
      selectCamion.innerHTML = '<option value="">-- Selecciona un camión --</option>';
      data.camiones.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c.camion;
        opt.textContent = c.camion + " (" + c.tarimas.length + " tarimas)";
        selectCamion.appendChild(opt);
      });
    } catch (e) {
      selectCamion.innerHTML = '<option value="">-- Error al cargar --</option>';
      alert("Error al cargar catálogo: " + e.message);
    }
  }

  function onCamionSeleccionado() {
    const camion = document.getElementById("manual-camion").value;
    const selectTarima = document.getElementById("manual-tarima");
    if (!camion || !catalogoCache) {
      selectTarima.innerHTML = '<option value="">-- Primero selecciona un camión --</option>';
      return;
    }
    const infoCamion = catalogoCache.find(c => c.camion === camion);
    if (!infoCamion) return;
    selectTarima.innerHTML = '<option value="">-- Selecciona una tarima --</option>';
    infoCamion.tarimas.forEach(qr => {
      const opt = document.createElement("option");
      opt.value = qr;
      opt.textContent = qr;
      selectTarima.appendChild(opt);
    });
  }

  async function registrarEventoManual() {
    const session = getSession();
    if (!session || session.rol !== "admin") { alert("Sesión inválida."); return; }
    const camion = document.getElementById("manual-camion").value;
    const evento = document.getElementById("manual-evento").value;
    const qrId = document.getElementById("manual-tarima").value;
    const notas = document.getElementById("manual-notas").value;
    const statusEl = document.getElementById("manual-registro-status");

    if (!camion) { statusEl.textContent = "Selecciona un camión"; statusEl.className = "send-status error"; return; }
    if (!evento) { statusEl.textContent = "Selecciona un evento"; statusEl.className = "send-status error"; return; }
    if (!qrId) { statusEl.textContent = "Selecciona una tarima"; statusEl.className = "send-status error"; return; }

    statusEl.textContent = "Registrando...";
    statusEl.className = "send-status";

    try {
      const infoCamion = catalogoCache.find(c => c.camion === camion);
      const partes = qrId.split("-");
      const dc = partes[1] ? partes[1].replace("DC", "") : "";
      const sabor = partes[2] || "";
      const numTarima = partes[3] ? partes[3].replace("T", "") : "";

      const payload = {
        accion: "evento",
        qr_id: qrId,
        camion: camion,
        po: infoCamion ? infoCamion.po : "",
        cedis: "99" + dc,
        dc: dc, sabor: sabor, num_tarima: numTarima,
        evento: evento,
        usuario: session.user, nombre: session.nombre, rol: session.rol,
        notas: "[MANUAL] " + (notas || ""),
      };

      const url = CONFIG.APPS_SCRIPT_URL + "?accion=evento&data=" + encodeURIComponent(JSON.stringify(payload));
      const resp = await jsonp(url);

      if (!resp.ok) {
        if (resp.duplicado) {
          statusEl.textContent = "⚠️ Ya registrado el " + resp.fecha_anterior;
          statusEl.className = "send-status error";
        } else {
          statusEl.textContent = "❌ " + (resp.error || "Error");
          statusEl.className = "send-status error";
        }
        return;
      }
      statusEl.textContent = "✅ Evento registrado";
      statusEl.className = "send-status ok";
      if (camion === getCamionActual()) setCamionActual(camion);
      document.getElementById("btn-registrar-otro").classList.remove("hidden");
    } catch (e) {
      statusEl.textContent = "❌ " + e.message;
      statusEl.className = "send-status error";
    }
  }

  function resetFormularioManual() {
    document.getElementById("manual-evento").value = "";
    document.getElementById("manual-tarima").value = "";
    document.getElementById("manual-notas").value = "";
    document.getElementById("manual-registro-status").textContent = "";
    document.getElementById("manual-registro-status").className = "send-status";
    document.getElementById("btn-registrar-otro").classList.add("hidden");
  }

  function abrirFormularioCancelar(camion, evento, qrId) {
    contextoCancelar = { camion, evento, qrId };
    document.getElementById("cancelar-info-camion").textContent = camion;
    document.getElementById("cancelar-info-evento").textContent = EVENTOS[evento]?.etiqueta || evento;
    document.getElementById("cancelar-info-tarima").textContent = qrId;
    document.getElementById("cancelar-motivo").value = "";
    document.getElementById("cancelar-status").textContent = "";
    document.getElementById("cancelar-status").className = "send-status";
    mostrarVista("view-cancelar");
  }

  async function ejecutarCancelar() {
    const session = getSession();
    const statusEl = document.getElementById("cancelar-status");

    if (!session || !["gerencia", "admin"].includes(session.rol)) {
      statusEl.textContent = "Solo Gerencia y Admin";
      statusEl.className = "send-status error";
      return;
    }
    const motivo = document.getElementById("cancelar-motivo").value.trim();
    if (!motivo) {
      statusEl.textContent = "Escribe el motivo";
      statusEl.className = "send-status error";
      return;
    }
    if (!contextoCancelar) {
      statusEl.textContent = "No hay evento seleccionado";
      statusEl.className = "send-status error";
      return;
    }
    if (!confirm("¿Confirmas cancelar?\n\nCamión: " + contextoCancelar.camion +
                 "\nEvento: " + contextoCancelar.evento +
                 "\nTarima: " + contextoCancelar.qrId)) return;

    statusEl.textContent = "Cancelando...";
    statusEl.className = "send-status";

    try {
      const payload = {
        qr_id: contextoCancelar.qrId,
        camion: contextoCancelar.camion,
        evento: contextoCancelar.evento,
        motivo: motivo,
        usuario: session.user, nombre: session.nombre, rol: session.rol,
      };
      const url = CONFIG.APPS_SCRIPT_URL + "?accion=cancelar_evento&data=" + encodeURIComponent(JSON.stringify(payload));
      const resp = await jsonp(url);

      if (!resp.ok) {
        statusEl.textContent = "❌ " + (resp.error || "Error");
        statusEl.className = "send-status error";
        return;
      }
      statusEl.textContent = "✅ " + (resp.mensaje || "Evento cancelado");
      statusEl.className = "send-status ok";
      setTimeout(() => {
        alert("✅ " + (resp.mensaje || "Cancelado") + "\n\nFilas: " + (resp.cancelados || 1));
        verDetalleCamion(contextoCancelar.camion);
      }, 800);
    } catch (e) {
      statusEl.textContent = "❌ " + e.message;
      statusEl.className = "send-status error";
    }
  }

  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const callbackName = "jsonp_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
      window[callbackName] = (data) => {
        delete window[callbackName];
        if (document.body.contains(script)) document.body.removeChild(script);
        resolve(data);
      };
      const script = document.createElement("script");
      script.src = url + "&callback=" + callbackName;
      script.onerror = () => {
        delete window[callbackName];
        if (document.body.contains(script)) document.body.removeChild(script);
        reject(new Error("Error de red"));
      };
      document.body.appendChild(script);
      setTimeout(() => {
        if (window[callbackName]) {
          delete window[callbackName];
          if (document.body.contains(script)) document.body.removeChild(script);
          reject(new Error("Timeout"));
        }
      }, 60000);
    });
  }

  async function verEstatusCamiones() {
    mostrarVista("view-loading");
    document.getElementById("loading-text").textContent = "Cargando estatus...";
    try {
      const data = await jsonp(CONFIG.APPS_SCRIPT_URL + "?accion=estatus_camiones");
      if (!data.ok) throw new Error("Error");
      mostrarListaCamiones(data.camiones);
    } catch (e) {
      alert("Error: " + e.message);
      mostrarVista("view-ready");
    }
  }

  function mostrarListaCamiones(camiones) {
    const contenedor = document.getElementById("lista-camiones");
    contenedor.innerHTML = "";
    const activos = camiones.filter(c => c.activo);
    const completados = camiones.filter(c => !c.activo);
    if (activos.length === 0 && completados.length === 0) {
      contenedor.innerHTML = '<p style="text-align:center;padding:20px;">No hay camiones registrados.</p>';
      mostrarVista("view-estatus");
      return;
    }
    if (activos.length > 0) {
      const t = document.createElement("h3");
      t.textContent = "🔥 Camiones Activos";
      t.style.marginTop = "10px";
      contenedor.appendChild(t);
      activos.forEach(c => contenedor.appendChild(crearTarjetaCamion(c)));
    }
    if (completados.length > 0) {
      const t = document.createElement("h3");
      t.textContent = "✅ Camiones Completados";
      t.style.marginTop = "20px";
      contenedor.appendChild(t);
      completados.slice(0, 10).forEach(c => contenedor.appendChild(crearTarjetaCamion(c)));
    }
    mostrarVista("view-estatus");
  }

  function crearTarjetaCamion(camion) {
    const card = document.createElement("div");
    card.className = "camion-card";
    if (camion.activo) card.classList.add("activo");
    const EVS = ["SALIDA_PLANTA", "ADUANA_ENTRADA", "ADUANA_SALIDA", "ENTREGA_CEDIS", "DEVOLUCION"];
    let html = '<div class="camion-titulo">🚚 ' + camion.camion + ' <span class="camion-total">(' + camion.total_tarimas + ' tarimas)</span></div>';
    html += '<div class="eventos-lista">';
    EVS.forEach(ev => {
      const info = EVENTOS[ev];
      const e = camion.eventos[ev];
      if (!info || !e) return;
      if (ev === "DEVOLUCION" && e.registradas === 0) return;
      const cls = e.completado ? "completado" : "pendiente";
      let faltanTexto = "";
      if (!e.completado) faltanTexto = '<span class="evento-faltan">(faltan ' + e.faltan + ')</span>';
      html += '<div class="evento-linea ' + cls + '">' +
              '<span class="evento-icono">' + info.icono + '</span>' +
              '<span class="evento-nombre">' + info.etiqueta + ' ' + faltanTexto + '</span>' +
              '<span class="evento-progreso">' + e.registradas + '/' + e.total + '</span>' +
              '<span class="evento-check">' + (e.completado ? '✅' : '⏳') + '</span>' +
              '</div>';
    });
    html += '</div>';
    card.innerHTML = html;
    card.addEventListener("click", () => verDetalleCamion(camion.camion));
    return card;
  }

  async function verDetalleCamion(camion) {
    mostrarVista("view-loading");
    document.getElementById("loading-text").textContent = "Cargando detalle...";
    try {
      const data = await jsonp(CONFIG.APPS_SCRIPT_URL + "?accion=estatus_camion&camion=" + encodeURIComponent(camion));
      if (!data.ok) throw new Error("Error");
      mostrarDetalleCamion(data);
    } catch (e) {
      alert("Error: " + e.message);
      verEstatusCamiones();
    }
  }

  function mostrarDetalleCamion(data) {
    document.getElementById("detalle-titulo").textContent = "🚚 " + data.camion;
    const contenedor = document.getElementById("detalle-camion");
    contenedor.innerHTML = "";
    const session = getSession();
    const puedeCancelar = session && ["gerencia", "admin"].includes(session.rol);
    const EVS = ["SALIDA_PLANTA", "ADUANA_ENTRADA", "ADUANA_SALIDA", "ENTREGA_CEDIS", "DEVOLUCION"];

    let html = '<div class="detalle-info">' +
               '<p><b>PO:</b> ' + (data.po || '-') + '</p>' +
               '<p><b>Total tarimas:</b> ' + data.total_tarimas + '</p>' +
               '</div>';

    EVS.forEach(ev => {
      const info = EVENTOS[ev];
      const e = data.eventos[ev];
      if (!info || !e) return;
      if (ev === "DEVOLUCION" && e.registradas.length === 0) return;

      let status, clase;
      if (e.completado) { status = "✅ COMPLETADO"; clase = "completado"; }
      else if (e.registradas.length > 0) { status = "⏳ FALTAN " + e.faltantes.length; clase = "parcial"; }
      else { status = "⏳ PENDIENTE"; clase = "pendiente"; }

      html += '<div class="detalle-evento ' + clase + '">';
      html += '<h4>' + info.icono + ' ' + info.etiqueta + '</h4>';
      html += '<p class="detalle-status">' + status + '</p>';
      html += '<p class="detalle-numero">' + e.registradas.length + '/' + e.total + '</p>';

      if (e.registradas.length > 0) {
        html += '<details open><summary>Ver registradas (' + e.registradas.length + ')</summary>';
        if (!puedeCancelar) {
          html += '<p style="font-size:12px;color:#92400E;background:#FEF3C7;padding:8px;border-radius:6px;margin:8px 0;">' +
                  '⚠️ Solo <b>Gerencia</b> y <b>Admin</b> pueden cancelar</p>';
        }
        html += '<ul class="lista-registradas">';
        e.registradas.forEach(qr => {
          html += '<li><span class="qr-texto">' + qr + '</span>';
          if (puedeCancelar) {
            const escQr = qr.replace(/'/g, "\\'");
            const escCamion = data.camion.replace(/'/g, "\\'");
            html += '<button class="btn-cancelar-chico" ' +
                    'onclick="event.stopPropagation(); App.abrirFormularioCancelar(\'' +
                    escCamion + '\', \'' + ev + '\', \'' + escQr + '\')">❌ Cancelar</button>';
          }
          html += '</li>';
        });
        html += '</ul></details>';
      }

      if (e.faltantes.length > 0 && e.faltantes.length <= 30) {
        html += '<details><summary>Ver faltantes (' + e.faltantes.length + ')</summary><ul class="lista-faltantes">';
        e.faltantes.forEach(q => { html += '<li>' + q + '</li>'; });
        html += '</ul></details>';
      } else if (e.faltantes.length > 30) {
        html += '<p class="texto-faltantes">Faltan ' + e.faltantes.length + ' tarimas</p>';
      }
      html += '</div>';
    });

    contenedor.innerHTML = html;
    mostrarVista("view-detalle-camion");
  }

  return {
    initLogin,
    initScanner,
    abrirFormularioCancelar,
    jsonp,
    getSession,
  };
})();

// ═══════════════════════════════════════════════════════════════════
// PEDIDOS - Frontend
// ═══════════════════════════════════════════════════════════════════

function formatearNumero(n, decimales = 2) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toLocaleString("es-MX", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimales
  });
}

let pedidoActual = null;
let skusFormTemporal = [];

function getSessionGlobal() {
  const s = localStorage.getItem(CONFIG.SESSION_KEY);
  return s ? JSON.parse(s) : null;
}

function mostrarPantalla(id) {
  const loginBody = document.querySelector(".login-body");
  if (loginBody) loginBody.style.display = "none";

  ["view-ready", "view-scanning", "view-loading", "view-result", "view-selector",
   "view-estatus", "view-detalle-camion", "view-manual", "view-cancelar",
   "pantalla-pedidos", "pantalla-form-pedido", "pantalla-detalle-pedido"]
    .forEach(v => {
      const el = document.getElementById(v);
      if (el) el.classList.add("hidden");
    });

  const el = document.getElementById(id);
  if (el) el.classList.remove("hidden");
}

function volverMenu() {
  ["pantalla-pedidos", "pantalla-form-pedido", "pantalla-detalle-pedido"]
    .forEach(p => {
      const el = document.getElementById(p);
      if (el) el.classList.add("hidden");
    });
  const selector = document.getElementById("view-selector");
  if (selector) selector.classList.remove("hidden");
}

function llamarBackend(url) { return App.jsonp(url); }

async function mostrarListaPedidos() {
  mostrarPantalla("pantalla-pedidos");
  const cont = document.getElementById("lista-pedidos");
  cont.innerHTML = "<p>Cargando pedidos...</p>";
  try {
    const data = await llamarBackend(CONFIG.APPS_SCRIPT_URL + "?accion=listar_pedidos");
    renderizarListaPedidos(data.pedidos || []);
  } catch (e) {
    cont.innerHTML = "<p>Error: " + e.message + "</p>";
  }
}

function renderizarListaPedidos(pedidos) {
  const cont = document.getElementById("lista-pedidos");
  if (pedidos.length === 0) {
    cont.innerHTML = "<p>No hay pedidos capturados.</p>";
    return;
  }

  const estadoIcon = { "PENDIENTE": "⏳", "PARCIAL": "🔄", "SURTIDO": "✅", "CANCELADO": "❌" };
  const estadoColor = { "PENDIENTE": "#B45309", "PARCIAL": "#1F4E79", "SURTIDO": "#1F7A1F", "CANCELADO": "#C00000" };

  let html = "<div style='margin-bottom:12px;'>";
  html += `<button onclick="imprimirConsolidado()" style="width:100%;padding:12px;background:#2C5282;color:white;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:14px;">📊 Ver Consolidado General de Todos los Pedidos Activos</button>`;
  html += "</div>";

  html += "<table style='width:100%;border-collapse:collapse;font-size:13px;'>"
  html += "<thead><tr style='background:#f2f2f2;'>";
  html += "<th style='padding:8px;text-align:left;'>PO</th>";
  html += "<th>CEDIS</th>";
  html += "<th>Estado</th>";
  html += "<th>Pedidas</th>";
  html += "<th>Surtidas</th>";
  html += "<th></th>";
  html += "</tr></thead><tbody>";
  for (const p of pedidos) {
    const est = p.estado_calculado || p.estado_pedido || "PENDIENTE";
    html += `<tr style="border-bottom:1px solid #eee;">
      <td style="padding:8px;">${p.po}</td>
      <td style="padding:8px;">${(p.cedis || []).join(", ")}</td>
      <td style="padding:8px;text-align:center;">
        <span style="color:${estadoColor[est] || '#666'};font-weight:700;font-size:11px;">
          ${estadoIcon[est] || ""} ${est}
        </span>
      </td>
      <td style="padding:8px;text-align:right;">${formatearNumero(p.total_pz, 0)}</td>
      <td style="padding:8px;text-align:right;">${formatearNumero(p.pz_surtidas || 0, 0)}</td>
      <td style="padding:8px;"><button onclick="abrirPedido('${p.po}')" style="padding:5px 10px;">Ver</button></td>
    </tr>`;
  }
  html += "</tbody></table>";
  cont.innerHTML = html;
}

function volverListaPedidos() { mostrarListaPedidos(); }

function mostrarFormPedido(pedidoExistente = null) {
  skusFormTemporal = [];
  document.getElementById("form-po").value = "";
  document.getElementById("form-fecha-entrega").value = "";
  document.getElementById("titulo-form-pedido").textContent = "Nuevo pedido";
  document.getElementById("form-pedido-status").textContent = "";

  if (pedidoExistente) {
    document.getElementById("form-po").value = pedidoExistente.po;
    document.getElementById("form-fecha-entrega").value = pedidoExistente.fecha_entrega || "";
    document.getElementById("titulo-form-pedido").textContent = "Editar pedido";
    skusFormTemporal = pedidoExistente.skus.map(s => ({
      sku: s.sku, cedis: s.cedis, pz: s.pz
    }));
  } else {
    skusFormTemporal = [{ sku: "MK150", cedis: "", pz: 0 }];
  }
  renderizarSKUsForm();
  mostrarPantalla("pantalla-form-pedido");
}

function renderizarSKUsForm() {
  const cont = document.getElementById("lista-skus-form");
  let html = "";
  skusFormTemporal.forEach((s, i) => {
    html += `
      <div style="display:grid;grid-template-columns:80px 1fr 70px 34px;gap:6px;align-items:center;margin-bottom:6px;">
        <select onchange="cambiarSKU(${i}, this.value)"
          style="width:100%;padding:6px 4px;border:1px solid #ccc;border-radius:6px;font-size:12px;">
          ${SKUS_VALIDOS.map(sku => `<option value="${sku}" ${sku === s.sku ? "selected" : ""}>${sku}</option>`).join("")}
        </select>
        <input type="text" inputmode="numeric" placeholder="CEDIS" maxlength="3"
          value="${s.cedis || ""}" onchange="cambiarCedis(${i}, this.value)"
          style="width:100%;padding:6px 4px;border:1px solid #ccc;border-radius:6px;font-size:12px;text-align:center;">
        <input type="number" inputmode="numeric" placeholder="PZ" min="0"
          value="${s.pz || ""}" onchange="cambiarPZ(${i}, this.value)"
          style="width:100%;padding:6px 4px;border:1px solid #ccc;border-radius:6px;font-size:12px;text-align:right;">
        <button onclick="quitarFilaSKU(${i})"
          style="width:34px;height:32px;padding:0;background:#FEE2E2;border:1px solid #FECACA;border-radius:6px;cursor:pointer;font-size:13px;">🗑</button>
      </div>`;
  });
  cont.innerHTML = html;
}

function agregarFilaSKU() {
  skusFormTemporal.push({ sku: "MK150", cedis: "", pz: 0 });
  renderizarSKUsForm();
}

function quitarFilaSKU(i) {
  skusFormTemporal.splice(i, 1);
  if (skusFormTemporal.length === 0) skusFormTemporal.push({ sku: "MK150", cedis: "", pz: 0 });
  renderizarSKUsForm();
}

function cambiarSKU(i, v) { skusFormTemporal[i].sku = v; }
function cambiarCedis(i, v) { skusFormTemporal[i].cedis = String(v || "").trim().padStart(3, "0"); }
function cambiarPZ(i, v) { skusFormTemporal[i].pz = Number(v) || 0; }

async function guardarPedidoForm(evt) {
  const po = document.getElementById("form-po").value.trim();
  const fecha = document.getElementById("form-fecha-entrega").value;
  const statusEl = document.getElementById("form-pedido-status");

  if (!po) return alert("Falta PO");

  const invalidos = skusFormTemporal.filter(s => s.pz > 0 && !s.cedis);
  if (invalidos.length > 0) return alert("Hay " + invalidos.length + " SKU(s) sin CEDIS");

  const skus = skusFormTemporal.filter(s => s.pz > 0 && s.cedis);
  if (skus.length === 0) return alert("Agrega al menos un SKU con CEDIS y cantidad");

  const session = getSessionGlobal();
  if (!session) return alert("Sesión expirada");

  const btn = evt ? evt.target : null;
  if (btn) { btn.disabled = true; btn.textContent = "Calculando..."; }
  statusEl.textContent = "Calculando explosión de insumos...";
  statusEl.className = "send-status";

  const body = {
    po: po,
    fecha_entrega: fecha || "",
    skus: skus.map(s => ({ sku: s.sku, cedis: s.cedis, pz: s.pz })),
    usuario: session.user,
    nombre: session.nombre,
    rol: session.rol
  };

  const url = CONFIG.APPS_SCRIPT_URL + "?accion=guardar_pedido&data=" + encodeURIComponent(JSON.stringify(body));

  try {
    const resp = await llamarBackend(url);
    if (!resp.ok) throw new Error(resp.error || "Error desconocido");

    statusEl.textContent = "✅ Pedido guardado";
    statusEl.className = "send-status ok";

    // 🔥 FIX: usamos la respuesta del guardado (ya trae la explosión)
    pedidoActual = {
      ok: true,
      id_pedido: resp.id_pedido,
      po: po,
      cedis: resp.cedis || [],
      fecha_entrega: fecha,
      fecha_captura: new Date().toLocaleString("es-MX"),
      usuario: session.user,
      estado_pedido: "PENDIENTE",
      pz_pedidas_total: skus.reduce((s, k) => s + k.pz, 0),
      pz_surtidas_total: 0,
      pz_pendientes_total: skus.reduce((s, k) => s + k.pz, 0),
      skus: (resp.skus || []).map(s => ({
        sku: s.sku, cedis: s.cedis, pt_codigo: s.pt_codigo, pz: s.pz
      })),
      resumen_pt: resp.resumen_pt || [],
      total_pz: skus.reduce((s, k) => s + k.pz, 0),
      explosion: resp.explosion || []
    };

    // Renderizar directamente con lo que nos devolvió el backend
    renderizarDetallePedido(pedidoActual);
    mostrarPantalla("pantalla-detalle-pedido");

    // Restaurar botón por si regresan a editar
    if (btn) { btn.disabled = false; btn.textContent = "✅ Guardar y calcular"; }

  } catch (e) {
    statusEl.textContent = "❌ " + e.message;
    statusEl.className = "send-status error";
    if (btn) { btn.disabled = false; btn.textContent = "✅ Guardar y calcular"; }
  }
}

async function abrirPedido(po) {
  try {
    const url = CONFIG.APPS_SCRIPT_URL + "?accion=ver_pedido&po=" + encodeURIComponent(po);
    const data = await llamarBackend(url);
    if (!data.ok) throw new Error(data.error || "Pedido no encontrado");

    // 🔥 PROTECCIONES: garantizar que existan los campos
    data.explosion = data.explosion || [];
    data.skus = data.skus || [];
    data.cedis = data.cedis || [];
    data.resumen_pt = data.resumen_pt || [];

    pedidoActual = data;
    renderizarDetallePedido(data);
    mostrarPantalla("pantalla-detalle-pedido");
  } catch (e) {
    alert("Error al abrir pedido: " + e.message);
  }
}

function formatearFecha(valor) {
  if (!valor) return "";
  if (typeof valor === "string" && /^\d{1,2}\/\d{1,2}\/\d{4}/.test(valor)) return valor;
  try {
    const fecha = new Date(valor);
    if (isNaN(fecha.getTime())) return String(valor);
    const dd = String(fecha.getDate()).padStart(2, "0");
    const mm = String(fecha.getMonth() + 1).padStart(2, "0");
    const yyyy = fecha.getFullYear();
    const hh = String(fecha.getHours()).padStart(2, "0");
    const min = String(fecha.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  } catch (e) { return String(valor); }
}

function renderizarDetallePedido(p) {
  document.getElementById("titulo-detalle-pedido").textContent =
    "PO " + p.po + " · CEDIS " + (p.cedis || []).join(", ");

  const estadoColor = { "PENDIENTE": "#B45309", "PARCIAL": "#1F4E79", "SURTIDO": "#1F7A1F", "CANCELADO": "#C00000" };
  const estadoIcon = { "PENDIENTE": "⏳", "PARCIAL": "🔄", "SURTIDO": "✅", "CANCELADO": "❌" };
  const estado = p.estado_pedido || "PENDIENTE";

  // 🔥 NUEVA: Tabla PT
  const resumenPT = p.resumen_pt || [];
  let tablaPT_HTML = "";
  if (resumenPT.length > 0) {
    let totalesPedidas = 0;
    let totalesSurtidas = 0;
    let totalesEnStock = 0;
    let totalesPendientes = 0;

    let filas = "";
    for (const pt of resumenPT) {
      totalesPedidas += pt.pz_pedidas || 0;
      totalesSurtidas += pt.pz_surtidas || 0;
      totalesEnStock += pt.pz_en_stock || 0;
      totalesPendientes += pt.pz_pendientes || 0;

      filas += `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:6px;font-family:monospace;font-weight:600;color:#1F4E79;font-size:12px;">${pt.pt_codigo}</td>
        <td style="padding:6px;font-size:11px;">${pt.descripcion || "—"}</td>
        <td style="padding:6px;text-align:right;font-size:12px;">${formatearNumero(pt.pz_pedidas, 0)}</td>
        <td style="padding:6px;text-align:right;font-size:12px;">${formatearNumero(pt.pz_surtidas, 0)}</td>
        <td style="padding:6px;text-align:right;font-size:12px;color:#1F7A1F;font-weight:600;">${formatearNumero(pt.pz_en_stock, 0)}</td>
        <td style="padding:6px;text-align:right;font-size:12px;${pt.pz_pendientes > 0 ? 'color:#B45309;font-weight:700;' : ''}">${formatearNumero(pt.pz_pendientes, 0)}</td>
      </tr>`;
    }

    tablaPT_HTML = `
      <div style="margin:15px 0;">
        <h3 style="font-size:14px;color:#1F4E79;margin-bottom:8px;">📦 Resumen por Producto Terminado (PT)</h3>
        <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
          <table style="width:100%;border-collapse:collapse;font-size:11px;min-width:400px;">
            <thead>
              <tr style="background:#1F4E79;color:white;">
                <th style="padding:6px;text-align:left;">Código OAR</th>
                <th style="padding:6px;text-align:left;">Descripción</th>
                <th style="padding:6px;text-align:right;">Pedidas</th>
                <th style="padding:6px;text-align:right;">Surtidas</th>
                <th style="padding:6px;text-align:right;">Stock PT</th>
                <th style="padding:6px;text-align:right;">Pendientes</th>
              </tr>
            </thead>
            <tbody>
              ${filas}
              <tr style="background:#F0F4FA;font-weight:700;">
                <td colspan="2" style="padding:6px;text-align:right;">TOTAL:</td>
                <td style="padding:6px;text-align:right;">${formatearNumero(totalesPedidas, 0)}</td>
                <td style="padding:6px;text-align:right;">${formatearNumero(totalesSurtidas, 0)}</td>
                <td style="padding:6px;text-align:right;color:#1F7A1F;">${formatearNumero(totalesEnStock, 0)}</td>
                <td style="padding:6px;text-align:right;color:#B45309;">${formatearNumero(totalesPendientes, 0)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  document.getElementById("info-pedido").innerHTML = `
    <div class="detalle-info" style="margin:15px 0;padding:10px;background:#f9f9f9;border-radius:8px;">
      <p style="margin:0 0 6px 0;">
        <span style="display:inline-block;padding:4px 10px;border-radius:12px;background:${estadoColor[estado]}15;color:${estadoColor[estado]};font-weight:700;font-size:13px;">
          ${estadoIcon[estado]} ${estado}
        </span>
      </p>
      <p><b>CEDIS:</b> ${(p.cedis || []).join(", ")}</p>
      <p><b>SKUs:</b> ${p.skus.length}</p>
      <p><b>PZ pedidas:</b> ${formatearNumero(p.pz_pedidas_total || 0, 0)} · 
         <b>Surtidas:</b> ${formatearNumero(p.pz_surtidas_total || 0, 0)} · 
         <b>Pendientes:</b> <span style="color:#B45309;font-weight:700;">${formatearNumero(p.pz_pendientes_total || 0, 0)}</span></p>
      ${p.fecha_entrega ? `<p><b>Fecha entrega:</b> ${formatearFecha(p.fecha_entrega)}</p>` : ""}
      <p><b>Capturado:</b> ${formatearFecha(p.fecha_captura)} por ${p.usuario}</p>
    </div>
    ${tablaPT_HTML}
  `;

  renderizarConsolidado(p.explosion);
  renderizarPorSKU(p.skus, p.explosion);
  cambiarTabPedido("consolidado");
}

function renderizarConsolidado(explosion) {
  const cont = document.getElementById("tab-consolidado");
  if (!explosion || explosion.length === 0) {
    cont.innerHTML = "<p>Sin insumos calculados (pedido ya surtido).</p>";
    return;
  }

  const session = getSessionGlobal();
  const puedeEditar = session && ["gerencia", "admin"].includes(String(session.rol || "").toLowerCase());

  let html = "<div style='margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;'>";
  html += `<div><b>Total a comprar:</b> <span id="total-general" style="font-size:20px;color:#1F4E79;font-weight:700;">$0.00</span></div>`;
  if (puedeEditar) {
    html += `<button onclick="guardarPreciosPedido()" style="padding:8px 16px;background:#1F4E79;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">💾 Guardar precios</button>`;
  }
  html += "</div>";
  html += "<div style='font-size:11px;color:#718096;margin-bottom:6px;text-align:right;'>👉 Desliza la tabla para ver más columnas</div>";
  html += "<table class='tabla-insumos' id='tabla-insumos'>";
  html += "<thead><tr>";
  html += "<th>Insumo</th><th>Descripción</th>";
  html += "<th class='col-num'>Neces.</th>";
  html += "<th class='col-num'>Stock</th>";
  html += "<th class='col-num'>Comprom.</th>";
  html += "<th class='col-num'>Dispon.</th>";
  html += "<th class='col-num'>Faltante</th>";
  html += "<th class='col-num'>Comprar</th>";
  html += "<th class='col-num'>PU</th><th class='col-num'>IVA</th>";
  html += "<th class='col-num'>Subtotal</th>";
  html += "<th class='col-center'>Est.</th>";
  html += "</tr></thead><tbody>";

  for (let idx = 0; idx < explosion.length; idx++) {
    const e = explosion[idx];
    const icon = e.estado === "OK" ? "✅" : (e.estado === "PARCIAL" ? "⚠️" : "❌");
    const comprar = e.comprar || 0;
    const pu = Number(e.pu || 0);
    const ivaUnit = Number(e.iva_tasa || 0);
    const sub = Number(e.subtotal || 0);
    const editado = e.editado ? " background:#FFFBEB;" : "";

    const inputStyle = "width:70px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;text-align:right;font-size:12px;";
    const inputPU = puedeEditar
      ? `<input type="number" step="0.01" min="0" value="${pu}" data-idx="${idx}" data-campo="pu" onchange="onPrecioChange(this)" style="${inputStyle}">`
      : `<span>${pu > 0 ? "$" + formatearNumero(pu) : "—"}</span>`;
    const inputIVA = puedeEditar
      ? `<input type="number" step="0.01" min="0" value="${ivaUnit}" data-idx="${idx}" data-campo="iva" onchange="onPrecioChange(this)" style="${inputStyle}">`
      : `<span>${ivaUnit > 0 ? "$" + formatearNumero(ivaUnit) : "—"}</span>`;

    html += `<tr data-idx="${idx}" style="border-bottom:1px solid #eee;${editado}">
      <td class="col-codigo" style="padding:6px;font-family:monospace;font-size:11px;font-weight:600;color:#1F4E79;">${e.insumo}</td>
      <td style="padding:6px;font-size:11px;">${e.descripcion || "—"}</td>
      <td class="col-num" style="padding:6px;text-align:center;font-size:11px;">${formatearNumero(e.cantidad_necesaria)} ${e.unidad || ""}</td>
      <td class="col-num" style="padding:6px;text-align:center;font-size:11px;">${formatearNumero(e.stock_actual)}</td>
      <td class="col-num" style="padding:6px;text-align:center;font-size:11px;color:#92400E;">${e.stock_comprometido > 0 ? formatearNumero(e.stock_comprometido) : "—"}</td>
      <td class="col-num" style="padding:6px;text-align:center;font-size:11px;font-weight:600;">${formatearNumero(e.stock_disponible)}</td>
      <td class="col-num" style="padding:6px;text-align:center;font-size:11px;${e.faltante > 0 ? 'color:#B45309;' : ''}">${e.faltante > 0 ? "+" + formatearNumero(e.faltante) : formatearNumero(e.faltante)}</td>
      <td class="col-num" style="padding:6px;text-align:center;font-size:11px;${comprar > 0 ? 'color:#C00000;font-weight:700;' : ''}">${comprar > 0 ? formatearNumero(comprar) + " " + (e.unidad || "") : "—"}</td>
      <td class="col-num" style="padding:6px;text-align:center;">${inputPU}</td>
      <td class="col-num" style="padding:6px;text-align:center;">${inputIVA}</td>
      <td class="col-num" style="padding:6px;text-align:right;font-weight:700;color:#C00000;font-size:11px;" data-subtotal="${idx}">${sub > 0 ? "$" + formatearNumero(sub) : "—"}</td>
      <td class="col-center" style="padding:6px;text-align:center;font-size:10px;">${icon}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  cont.innerHTML = html;
  window.explosionActual = explosion.slice();
  recalcularTotalesGenerales();
}

function onPrecioChange(input) {
  const idx = Number(input.getAttribute("data-idx"));
  const campo = input.getAttribute("data-campo");
  const valor = Number(input.value) || 0;
  if (!window.explosionActual || !window.explosionActual[idx]) return;
  const e = window.explosionActual[idx];
  if (campo === "pu") e.pu = valor;
  if (campo === "iva") e.iva_tasa = valor;

  const precioConIva = (Number(e.pu) || 0) + (Number(e.iva_tasa) || 0);
  e.precio_con_iva = Math.round(precioConIva * 100) / 100;
  e.subtotal = Math.round((Number(e.comprar) || 0) * precioConIva * 100) / 100;

  const subCell = document.querySelector(`[data-subtotal="${idx}"]`);
  if (subCell) subCell.textContent = e.subtotal > 0 ? "$" + formatearNumero(e.subtotal) : "—";
  const fila = document.querySelector(`tr[data-idx="${idx}"]`);
  if (fila) fila.style.background = "#FFFBEB";
  recalcularTotalesGenerales();
}

function recalcularTotalesGenerales() {
  if (!window.explosionActual) return;
  let total = 0;
  for (const e of window.explosionActual) total += Number(e.subtotal) || 0;
  const el = document.getElementById("total-general");
  if (el) el.textContent = "$" + formatearNumero(total);
}

async function guardarPreciosPedido() {
  if (!pedidoActual || !window.explosionActual) return;
  const session = getSessionGlobal();
  if (!session || !["gerencia", "admin"].includes(session.rol)) {
    return alert("Solo Gerencia y Admin");
  }
  const precios = window.explosionActual.map(e => ({
    insumo: e.insumo, pu: Number(e.pu) || 0, iva: Number(e.iva_tasa) || 0
  }));
  const body = {
    accion: "guardar_precios_pedido",
    id_pedido: pedidoActual.id_pedido,
    precios: precios,
    usuario: session.user,
    rol: session.rol
  };
  const url = CONFIG.APPS_SCRIPT_URL + "?accion=guardar_precios_pedido&data=" + encodeURIComponent(JSON.stringify(body));
  try {
    const resp = await llamarBackend(url);
    if (!resp.ok) throw new Error(resp.error);
    alert("✅ " + (resp.mensaje || "Precios guardados"));
  } catch (e) { alert("❌ " + e.message); }
}

function renderizarPorSKU(skus, explosion) {
  const cont = document.getElementById("tab-por-sku");
  let html = "";
  for (const s of skus) {
    html += `<div class="bloque-sku" style="margin-bottom:15px;padding:10px;background:#f9f9f9;border-radius:8px;">
      <h4 style="margin:0 0 8px 0;">${s.sku} · CEDIS ${s.cedis} · ${formatearNumero(s.pz, 0)} PZ · ${s.pt_codigo}</h4>
      <ul style="margin:0;padding-left:20px;font-size:13px;">`;
    for (const e of explosion) {
      const etiquetaSKU = s.sku + " (CEDIS " + s.cedis + ")";
      const porSku = e.por_sku?.find(x => x.pt_codigo === etiquetaSKU || x.pt_codigo === s.sku);
      if (!porSku) continue;
      const icon = e.estado === "OK" ? "✅" : (e.estado === "PARCIAL" ? "⚠️" : "❌");
      const desc = e.descripcion ? " (" + e.descripcion + ")" : "";
      html += `<li><b>${e.insumo}</b>${desc}: ${porSku.cantidad} ${e.unidad} ${icon}</li>`;
    }
    html += "</ul></div>";
  }
  cont.innerHTML = html;
}

function cambiarTabPedido(tab, evt) {
  const contenedor = document.getElementById("pantalla-detalle-pedido");
  contenedor.querySelectorAll(".tab").forEach(t => t.classList.remove("activo"));
  contenedor.querySelectorAll(".tab-contenido").forEach(c => c.classList.add("hidden"));
  if (evt && evt.target) evt.target.classList.add("activo");
  else {
    const tabBtn = contenedor.querySelector(`.tab[onclick*="${tab}"]`);
    if (tabBtn) tabBtn.classList.add("activo");
  }
  const contenido = document.getElementById("tab-" + tab);
  if (contenido) contenido.classList.remove("hidden");
}

async function refrescarStock() {
  if (!pedidoActual) return;
  const url = CONFIG.APPS_SCRIPT_URL + "?accion=refrescar_stock_pedido&po=" + encodeURIComponent(pedidoActual.po);
  try {
    const resp = await llamarBackend(url);
    if (!resp.ok) throw new Error(resp.error);
    pedidoActual.explosion = resp.explosion;
    renderizarConsolidado(resp.explosion);
    renderizarPorSKU(pedidoActual.skus, resp.explosion);
    alert("Stock actualizado: " + resp.refrescado);
  } catch (e) { alert("Error: " + e.message); }
}

function editarPedidoActual() {
  if (!pedidoActual) return;
  mostrarFormPedido(pedidoActual);
}

async function eliminarPedidoActual() {
  if (!pedidoActual) return;
  if (!confirm("¿Eliminar este pedido?")) return;
  const session = getSessionGlobal();
  if (!session) return alert("Sesión expirada");
  const body = { po: pedidoActual.po, usuario: session.user, rol: session.rol };
  const url = CONFIG.APPS_SCRIPT_URL + "?accion=eliminar_pedido&data=" + encodeURIComponent(JSON.stringify(body));
  try {
    const resp = await llamarBackend(url);
    if (!resp.ok) throw new Error(resp.error);
    alert("Pedido eliminado");
    mostrarListaPedidos();
  } catch (e) { alert("Error: " + e.message); }
}

async function marcarPedidoSurtido(nuevoEstado) {
  if (!pedidoActual) return;
  const session = getSessionGlobal();
  if (!session || !["gerencia", "admin"].includes(session.rol)) {
    return alert("Solo Gerencia y Admin");
  }

  const msg = nuevoEstado === "SURTIDO"
    ? "¿Marcar este pedido como SURTIDO manualmente? Dejará de contar en el cálculo de otros pedidos."
    : "¿Reabrir este pedido? Volverá a PENDIENTE.";
  if (!confirm(msg)) return;

  const body = {
    po: pedidoActual.po,
    estado: nuevoEstado,
    usuario: session.user,
    rol: session.rol
  };
  const url = CONFIG.APPS_SCRIPT_URL + "?accion=marcar_pedido_surtido&data=" + encodeURIComponent(JSON.stringify(body));
  try {
    const resp = await llamarBackend(url);
    if (!resp.ok) throw new Error(resp.error);
    alert("✅ " + resp.mensaje);
    await abrirPedido(pedidoActual.po);
  } catch (e) { alert("❌ " + e.message); }
}

function imprimirPedido() {
  if (!pedidoActual) return;
  const p = pedidoActual;
  const insumos = p.explosion || [];
  const orden = { "SIN_STOCK": 0, "PARCIAL": 1, "OK": 2 };
  const ordenados = insumos.slice().sort((a, b) => (orden[a.estado] || 9) - (orden[b.estado] || 9));

  const total = ordenados.length;
  const sinStock = ordenados.filter(i => i.estado === "SIN_STOCK").length;
  const parciales = ordenados.filter(i => i.estado === "PARCIAL").length;
  const oks = ordenados.filter(i => i.estado === "OK").length;

  // ═══════════════════════════════════════════════════════════════
  // 🔥 NUEVO: Resumen por PT (Producto Terminado)
  // ═══════════════════════════════════════════════════════════════
  const resumenPT = p.resumen_pt || [];
  let filasPT_HTML = "";
  let totalPedidas = 0;
  let totalSurtidas = 0;
  let totalEnStock = 0;
  let totalPendientes = 0;

  for (const pt of resumenPT) {
    const surtidas = pt.pz_surtidas || 0;
    const enStock = pt.pz_en_stock || 0;
    totalPedidas += pt.pz_pedidas || 0;
    totalSurtidas += surtidas;
    totalEnStock += enStock;
    totalPendientes += pt.pz_pendientes || 0;

    filasPT_HTML += `<tr>
      <td class="codigo">${pt.pt_codigo}</td>
      <td>${pt.descripcion || "—"}</td>
      <td class="num">${formatearNumero(pt.pz_pedidas, 0)}</td>
      <td class="num">${formatearNumero(surtidas, 0)}</td>
      <td class="num" style="color:#1F7A1F;font-weight:600;">${formatearNumero(enStock, 0)}</td>
      <td class="num ${pt.pz_pendientes > 0 ? 'pendiente' : ''}">${formatearNumero(pt.pz_pendientes, 0)}</td>
    </tr>`;
  }

  // ═══════════════════════════════════════════════════════════════
  // Filas de insumos
  // ═══════════════════════════════════════════════════════════════
  let filasHTML = "";
  let totalGeneral = 0;
  for (const e of ordenados) {
    const faltante = Number(e.faltante) || 0;
    const comprar = Number(e.comprar) || 0;
    const pu = Number(e.pu) || 0;
    const ivaUnit = Number(e.iva_tasa) || 0;
    const sub = Number(e.subtotal) || 0;
    totalGeneral += sub;
    const faltanteTxt = faltante > 0 ? "+" + formatearNumero(faltante) : formatearNumero(faltante);
    const comprarTxt = comprar > 0 ? formatearNumero(comprar) + " " + (e.unidad || "") : "—";
    const puTxt = pu > 0 ? "$" + formatearNumero(pu) : "—";
    const ivaTxt = ivaUnit > 0 ? "$" + formatearNumero(ivaUnit) : "—";
    const subTxt = sub > 0 ? "$" + formatearNumero(sub) : "—";
    const estadoIcon = e.estado === "OK" ? "OK" : (e.estado === "PARCIAL" ? "PARCIAL" : "SIN STOCK");
    const colorEstado = e.estado === "OK" ? "#1F7A1F" : (e.estado === "PARCIAL" ? "#B45309" : "#C00000");

    filasHTML += `<tr>
      <td class="codigo">${e.insumo || ""}</td>
      <td>${e.descripcion || "—"}</td>
      <td class="centro">${e.unidad || ""}</td>
      <td class="num">${formatearNumero(e.cantidad_necesaria)}</td>
      <td class="num">${formatearNumero(e.stock_actual)}</td>
      <td class="num">${formatearNumero(e.stock_comprometido)}</td>
      <td class="num">${formatearNumero(e.stock_disponible)}</td>
      <td class="num">${faltanteTxt}</td>
      <td class="num comprar">${comprarTxt}</td>
      <td class="num">${puTxt}</td>
      <td class="num">${ivaTxt}</td>
      <td class="num subtotal">${subTxt}</td>
      <td class="centro" style="color:${colorEstado};font-weight:700;">${estadoIcon}</td>
    </tr>`;
  }

  filasHTML += `<tr class="fila-total">
    <td colspan="11" style="text-align:right;font-weight:700;font-size:13px;padding-top:10px;">TOTAL A COMPRAR:</td>
    <td class="num subtotal" style="font-weight:700;font-size:13px;color:#C00000;">$${formatearNumero(totalGeneral)}</td>
    <td></td>
  </tr>`;

  const htmlImpresion = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Pedido ${p.po}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1A202C; padding: 20px; font-size: 11px; background: white; }
  .encabezado { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1F4E79; padding-bottom: 12px; margin-bottom: 15px; }
  .encabezado-izq h1 { font-size: 20px; color: #1F4E79; margin-bottom: 4px; }
  .encabezado-izq p { font-size: 12px; color: #4A5568; margin: 2px 0; }
  .encabezado-der { text-align: right; font-size: 11px; color: #4A5568; }
  .resumen { display: flex; gap: 20px; background: #F9FAFB; border: 1px solid #E0E4EA; border-radius: 6px; padding: 10px 15px; margin-bottom: 15px; font-size: 11px; }
  .resumen strong { color: #1F4E79; }
  .resumen .st-stock { color: #C00000; font-weight: 700; }
  .resumen .st-parcial { color: #B45309; font-weight: 700; }
  .resumen .st-ok { color: #1F7A1F; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 20px; }
  thead { background: #1F4E79; color: white; }
  th { padding: 8px 5px; font-weight: 600; font-size: 9px; text-transform: uppercase; text-align: center; }
  th:first-child, th:nth-child(2) { text-align: left; }
  td { padding: 6px 5px; border-bottom: 1px solid #EEF1F5; text-align: center; }
  td:first-child, td:nth-child(2) { text-align: left; }
  tr:nth-child(even) { background: #FAFBFD; }
  td.codigo { font-family: "Courier New", monospace; font-weight: 700; color: #1F4E79; }
  td.num { text-align: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.pendiente { color: #B45309; font-weight: 700; }
  td.comprar { color: #C00000; font-weight: 700; }
  td.subtotal { color: #C00000; font-weight: 700; }
  tr.fila-total { background: #F0F4FA; border-top: 2px solid #1F4E79; }
  tr.fila-total td { font-weight: 700; font-size: 11px; padding: 10px 5px; }
  .seccion-titulo { font-size: 14px; color: #1F4E79; font-weight: 700; margin: 20px 0 10px 0; padding-bottom: 6px; border-bottom: 2px solid #1F4E79; }
  .pie { margin-top: 20px; padding-top: 10px; border-top: 1px solid #E0E4EA; font-size: 10px; color: #718096; text-align: center; }
  .sin-imprimir { display: block; margin: 0 auto 20px; padding: 10px 20px; background: #1F4E79; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
  @media print { .sin-imprimir { display: none; } body { padding: 0; } }
</style>
</head>
<body>
  <button class="sin-imprimir" onclick="window.print()">🖨️ Imprimir o Guardar como PDF</button>
  
  <div class="encabezado">
    <div class="encabezado-izq">
      <h1>Pedido de Insumos</h1>
      <p><strong>PO:</strong> ${p.po} &nbsp;·&nbsp; <strong>CEDIS:</strong> ${(p.cedis || []).join(", ")}</p>
      <p><strong>Estado:</strong> ${p.estado_pedido || "PENDIENTE"}</p>
      <p><strong>PZ pedidas:</strong> ${formatearNumero(p.pz_pedidas_total, 0)} · 
         <strong>Surtidas:</strong> ${formatearNumero(p.pz_surtidas_total, 0)} · 
         <strong>Pendientes:</strong> ${formatearNumero(p.pz_pendientes_total, 0)}</p>
      ${p.fecha_entrega ? `<p><strong>Fecha entrega:</strong> ${formatearFecha(p.fecha_entrega)}</p>` : ""}
      <p><strong>Capturado:</strong> ${formatearFecha(p.fecha_captura)} por ${p.usuario || "-"}</p>
    </div>
    <div class="encabezado-der">
      <p>Mediese</p>
      <p>Sistema Visor Tarimas</p>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
       SECCIÓN 1: RESUMEN POR PRODUCTO TERMINADO (PT)
       ═══════════════════════════════════════════════════════════════ -->
  ${resumenPT.length > 0 ? `
  <div class="seccion-titulo">📦 Resumen por Producto Terminado (PT)</div>
    <table>
    <thead>
      <tr>
        <th>Código OAR</th>
        <th>Descripción</th>
        <th>Pedidas</th>
        <th>Surtidas</th>
        <th>Stock PT</th>
        <th>Pendientes</th>
      </tr>
    </thead>
    <tbody>
      ${filasPT_HTML}
      <tr class="fila-total">
        <td colspan="2" style="text-align:right;font-weight:700;">TOTAL:</td>
        <td class="num" style="font-weight:700;">${formatearNumero(totalPedidas, 0)}</td>
        <td class="num" style="font-weight:700;">${formatearNumero(totalSurtidas, 0)}</td>
        <td class="num" style="font-weight:700;color:#1F7A1F;">${formatearNumero(totalEnStock, 0)}</td>
        <td class="num pendiente" style="font-weight:700;">${formatearNumero(totalPendientes, 0)}</td>
      </tr>
    </tbody>
  </table>
  ` : ''}

  <!-- ═══════════════════════════════════════════════════════════════
       SECCIÓN 2: DETALLE DE INSUMOS
       ═══════════════════════════════════════════════════════════════ -->
  <div class="seccion-titulo">🧪 Detalle de Insumos Requeridos</div>
  <div class="resumen">
    <div><strong>Total de insumos:</strong> ${total}</div>
    <div><span class="st-stock">❌ SIN STOCK:</span> ${sinStock}</div>
    <div><span class="st-parcial">⚠️ PARCIALES:</span> ${parciales}</div>
    <div><span class="st-ok">✅ OK:</span> ${oks}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Código</th><th>Descripción</th><th>Unidad</th>
        <th>Necesario</th><th>Stock</th><th>Comprom.</th><th>Disponible</th>
        <th>Faltante</th><th>Comprar</th>
        <th>PU</th><th>IVA</th><th>Subtotal</th><th>Estado</th>
      </tr>
    </thead>
    <tbody>${filasHTML}</tbody>
  </table>

  <div class="pie">
    Generado el ${new Date().toLocaleString("es-MX")} · Sistema Visor Tarimas - Mediese
  </div>
</body>
</html>`;

  const ventana = window.open("", "_blank");
  if (!ventana) { alert("Permite ventanas emergentes."); return; }
  ventana.document.write(htmlImpresion);
  ventana.document.close();
}

async function imprimirConsolidado() {
  const cont = document.getElementById("lista-pedidos");
  const original = cont.innerHTML;
  cont.innerHTML = "<p>Cargando consolidado...</p>";

  try {
    const data = await llamarBackend(CONFIG.APPS_SCRIPT_URL + "?accion=consolidado_general");
    if (!data.ok) throw new Error(data.error);
    cont.innerHTML = original;

    const pedidos = data.pedidos || [];
    const insumosConsolidados = data.insumos_consolidados || [];
    const ptConsolidado = data.pt_consolidado || [];

    // Columnas fijas
    const COLS_PT = `<colgroup>
      <col style="width:14%"><col style="width:34%"><col style="width:13%">
      <col style="width:13%"><col style="width:13%"><col style="width:13%">
    </colgroup>`;

    const COLS_INS = `<colgroup>
      <col style="width:14%"><col style="width:26%"><col style="width:7%">
      <col style="width:11%"><col style="width:10%"><col style="width:12%">
      <col style="width:12%"><col style="width:8%">
    </colgroup>`;

    const HEAD_PT = `<thead><tr>
      <th>Código OAR</th><th>Descripción</th><th>Pedidas</th>
      <th>Surtidas</th><th>Stock PT</th><th>Pendientes</th>
    </tr></thead>`;

    const HEAD_INS = `<thead><tr>
      <th>Código</th><th>Descripción</th><th>Unidad</th><th>Necesario</th>
      <th>Stock</th><th>Comprar</th><th>Subtotal</th><th>Estado</th>
    </tr></thead>`;

    // Filas por PT
    function filaPT(pt) {
      return `<tr>
        <td class="codigo">${pt.pt_codigo}</td>
        <td class="desc">${pt.descripcion || "—"}</td>
        <td class="num">${formatearNumero(pt.pz_pedidas, 0)}</td>
        <td class="num">${formatearNumero(pt.pz_surtidas, 0)}</td>
        <td class="num stock">${formatearNumero(pt.pz_en_stock, 0)}</td>
        <td class="num pend">${formatearNumero(pt.pz_pendientes, 0)}</td>
      </tr>`;
    }

    // Filas por insumo
    function filaInsumo(e) {
      const txt = e.estado === "OK" ? "OK" : (e.estado === "PARCIAL" ? "PARCIAL" : "SIN STOCK");
      const color = e.estado === "OK" ? "#1F7A1F" : (e.estado === "PARCIAL" ? "#B45309" : "#C00000");
      const comprar = e.comprar > 0 ? formatearNumero(e.comprar) + " " + (e.unidad || "") : "—";
      const sub = e.subtotal > 0 ? "$" + formatearNumero(e.subtotal) : "—";
      return `<tr>
        <td class="codigo">${e.insumo}</td>
        <td class="desc">${e.descripcion || "—"}</td>
        <td class="centro">${e.unidad || ""}</td>
        <td class="num">${formatearNumero(e.cantidad_necesaria)}</td>
        <td class="num">${formatearNumero(e.stock_actual)}</td>
        <td class="num comprar">${comprar}</td>
        <td class="num subtotal">${sub}</td>
        <td class="centro" style="color:${color};font-weight:700;">${txt}</td>
      </tr>`;
    }

    // Tabla PT completa
    function tablaPT(lista) {
      if (!lista || lista.length === 0) return "";
      let tP = 0, tS = 0, tSt = 0, tPe = 0;
      lista.forEach(pt => {
        tP += pt.pz_pedidas || 0;
        tS += pt.pz_surtidas || 0;
        tSt += pt.pz_en_stock || 0;
        tPe += pt.pz_pendientes || 0;
      });
      const total = `<tr class="fila-total">
        <td colspan="2" style="text-align:right;">TOTAL:</td>
        <td class="num">${formatearNumero(tP, 0)}</td>
        <td class="num">${formatearNumero(tS, 0)}</td>
        <td class="num stock">${formatearNumero(tSt, 0)}</td>
        <td class="num pend">${formatearNumero(tPe, 0)}</td>
      </tr>`;
      return `<table>${COLS_PT}${HEAD_PT}<tbody>${lista.map(filaPT).join("")}</tbody><tbody>${total}</tbody></table>`;
    }

    // Tabla insumos completa
    function tablaInsumos(lista, etiqueta, monto, grande) {
      const cls = grande ? "fila-total fila-total-grande" : "fila-total";
      const total = `<tr class="${cls}">
        <td colspan="6" style="text-align:right;">${etiqueta}</td>
        <td colspan="2" class="num subtotal" style="text-align:right;">$${formatearNumero(monto || 0)}</td>
      </tr>`;
      return `<table>${COLS_INS}${HEAD_INS}<tbody>${(lista || []).map(filaInsumo).join("")}</tbody><tbody>${total}</tbody></table>`;
    }

    // Secciones por pedido
    let seccionesHTML = "";
    for (const pedido of pedidos) {
      const pt = pedido.pt || [];
      seccionesHTML += `
        <section class="seccion-pedido">
          <h2>📋 PO ${pedido.po}</h2>
          <p class="meta-pedido">
            <strong>Fecha:</strong> ${formatearFecha(pedido.fecha)} &nbsp;·&nbsp;
            <strong>Pedidas:</strong> ${formatearNumero(pedido.pz_pedidas, 0)} PZ &nbsp;·&nbsp;
            <strong>Surtidas:</strong> ${formatearNumero(pedido.pz_surtidas, 0)} &nbsp;·&nbsp;
            <strong>En Stock PT:</strong> <span style="color:#1F7A1F;font-weight:700;">${formatearNumero(pedido.pz_en_stock, 0)}</span> &nbsp;·&nbsp;
            <strong>Pendientes:</strong> ${formatearNumero(pedido.pz_pendientes, 0)}
          </p>
          ${pt.length ? `<h3 class="sub-titulo">📦 Producto Terminado (PT)</h3>${tablaPT(pt)}` : ""}
          <h3 class="sub-titulo">🧪 Insumos Requeridos</h3>
          ${tablaInsumos(pedido.insumos, "Subtotal PO " + pedido.po + ":", pedido.total_comprar, false)}
        </section>`;
    }

    const htmlImpresion = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Consolidado General - Mediese</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: #1A202C; padding: 15px; font-size: 11px; background: white; }

  h1 { font-size: 22px; color: #1F4E79; margin-bottom: 4px; }
  h2 { font-size: 14px; color: #1F4E79; margin: 12px 0 8px; padding-bottom: 6px;
       border-bottom: 2px solid #1F4E79; }
  h3.sub-titulo { font-size: 12px; color: #1F4E79; margin: 10px 0 6px; padding-bottom: 4px;
       border-bottom: 1px solid #CBD5E0; }
  .meta-pedido { margin-bottom: 6px; }

  .encabezado { display: flex; justify-content: space-between; align-items: flex-start;
                border-bottom: 3px solid #1F4E79; padding-bottom: 12px; margin-bottom: 10px; }
  .encabezado-der { text-align: right; font-size: 11px; color: #4A5568; }

  .resumen { display: flex; gap: 20px; flex-wrap: wrap; background: #F9FAFB; border: 1px solid #E0E4EA;
             border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; font-size: 11px; }
  .resumen strong { color: #1F4E79; }
  .st-stock { color: #C00000; font-weight: 700; }
  .st-parcial { color: #B45309; font-weight: 700; }
  .st-ok { color: #1F7A1F; font-weight: 700; }

  table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed;
          font-size: 9px; margin-bottom: 12px; }
  thead { display: table-header-group; background: #1F4E79; color: white; }
  th { padding: 5px 3px; font-weight: 600; font-size: 8px; text-transform: uppercase; text-align: center; }
  th:first-child, th:nth-child(2) { text-align: left; }
  td { padding: 4px 3px; border-bottom: 1px solid #EEF1F5; text-align: center;
       vertical-align: middle; overflow-wrap: anywhere; }
  td:first-child, td:nth-child(2), td.desc { text-align: left; }
  tr:nth-child(even) { background: #FAFBFD; }
  td.codigo { font-family: "Courier New", monospace; font-weight: 700; color: #1F4E79; font-size: 8px; }
  td.num { font-variant-numeric: tabular-nums; }
  td.stock { color: #1F7A1F; font-weight: 600; }
  td.pend { color: #B45309; font-weight: 700; }
  td.comprar, td.subtotal { color: #C00000; font-weight: 700; }

  tr.fila-total { background: #F0F4FA; }
  tr.fila-total td { font-weight: 700; font-size: 10px; border-top: 2px solid #1F4E79; }
  tr.fila-total-grande td { font-size: 13px; padding: 8px 4px; }

  .seccion-pedido { margin-bottom: 15px; }
  .seccion-pedido + .seccion-pedido { page-break-before: always; break-before: page; }
  .salto { page-break-before: always; break-before: page; }

  .pie { margin-top: 12px; padding-top: 8px; border-top: 1px solid #E0E4EA; font-size: 9px;
         color: #718096; text-align: center; }

  .sin-imprimir { display: block; margin: 0 auto 15px; padding: 10px 20px; background: #1F4E79;
                  color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }

  @media print {
    .sin-imprimir { display: none; }
    body { padding: 0; }
  }
</style>
</head>
<body>
  <button class="sin-imprimir" onclick="window.print()">🖨️ Imprimir o Guardar como PDF</button>

  <div class="encabezado">
    <div>
      <h1>Consolidado General</h1>
      <p style="font-size:12px;color:#4A5568;"><strong>Pedidos activos:</strong> ${data.total_pedidos}</p>
      <p style="font-size:12px;color:#4A5568;"><strong>Generado:</strong> ${data.fecha_generacion}</p>
    </div>
    <div class="encabezado-der">
      <p>Mediese</p>
      <p>Sistema Visor Tarimas</p>
    </div>
  </div>

  ${seccionesHTML}

  <div class="salto">
    <h2>🧪 Consolidado Final (Todos los Pedidos)</h2>
    <div class="resumen">
      <div><strong>Total de insumos:</strong> ${data.total_insumos}</div>
      <div><span class="st-stock">❌ SIN STOCK:</span> ${data.insumos_sin_stock}</div>
      <div><span class="st-parcial">⚠️ PARCIALES:</span> ${data.insumos_parciales}</div>
      <div><span class="st-ok">✅ OK:</span> ${data.insumos_ok}</div>
    </div>

    <h3 class="sub-titulo">📦 PT Consolidado</h3>
    ${tablaPT(ptConsolidado)}

    <h3 class="sub-titulo">🧪 Insumos Consolidados</h3>
    ${tablaInsumos(insumosConsolidados, "TOTAL A COMPRAR:", data.total_general, true)}

    <div class="pie">Sistema Visor Tarimas - Mediese · ${data.fecha_generacion}</div>
  </div>
</body>
</html>`;

    const ventana = window.open("", "_blank");
    if (!ventana) { alert("Permite ventanas emergentes."); return; }
    ventana.document.write(htmlImpresion);
    ventana.document.close();

  } catch (e) {
    cont.innerHTML = original;
    alert("Error: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// CARGA MASIVA DE PEDIDO DESDE EXCEL
// ═══════════════════════════════════════════════════════════════════

const MAPEO_SABOR_SKU = {
  "ORIG": "MK150",
  "ORIGINAL": "MK150",
  "OR": "MK150",
  "LIME": "MKLM150",
  "LIMON": "MKLM150",
  "LIM": "MKLM150",
  "CHILI": "MKCH150",
  "CHILE": "MKCH150",
  "CHILES": "MKCH150",
  "CH": "MKCH150",
};

function abrirCargaMasiva() {
  document.getElementById("masivo-po").value = "";
  document.getElementById("masivo-texto").value = "";
  document.getElementById("masivo-status").textContent = "";
  document.getElementById("masivo-status").className = "send-status";
  mostrarPantalla("pantalla-carga-masiva");
}

function cerrarCargaMasiva() {
  mostrarPantalla("pantalla-form-pedido");
}

function procesarCargaMasiva() {
  const statusEl = document.getElementById("masivo-status");
  const po = document.getElementById("masivo-po").value.trim();
  const texto = document.getElementById("masivo-texto").value;

  // Reset
  statusEl.textContent = "";
  statusEl.className = "send-status";

  if (!po) {
    statusEl.textContent = "❌ Falta PO";
    statusEl.className = "send-status error";
    return;
  }

  if (!texto.trim()) {
    statusEl.textContent = "❌ No hay datos para procesar";
    statusEl.className = "send-status error";
    return;
  }

  // Parsear
  const lineas = texto.split("\n");
  let saborActual = null;
  const skus = [];
  const errores = [];
  let duplicados = 0;

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i].trim();
    if (!linea) continue;

    const lineaUpper = linea.toUpperCase();

    // Detectar encabezado de sabor (solo la palabra)
    if (lineaUpper.length <= 15 && MAPEO_SABOR_SKU[lineaUpper]) {
      saborActual = MAPEO_SABOR_SKU[lineaUpper];
      continue;
    }

    // Detectar línea de datos: "00014917931-99001  5200" (tabs o espacios)
    const partes = linea.split(/\s+/).filter(p => p);
    if (partes.length >= 2) {
      const matchData = partes[0].match(/^0*(\d+)-(\d+)$/);
      const pz = parseInt(partes[1].replace(/,/g, ""));

      if (matchData && !isNaN(pz) && pz > 0) {
        if (!saborActual) {
          errores.push(`Línea ${i + 1}: Falta encabezado (ORIG/LIME/CHILI) antes de la línea`);
          continue;
        }

        const cedisFull = matchData[2]; // 99001
        const cedisNum = cedisFull.length >= 3
          ? cedisFull.slice(-3)
          : cedisFull.padStart(3, "0");

        skus.push({
          sku: saborActual,
          cedis: cedisNum,
          pz: pz,
        });
        continue;
      }
    }

    // Línea no reconocida
    errores.push(`Línea ${i + 1}: Formato inválido "${linea}"`);
  }

  if (skus.length === 0) {
    statusEl.innerHTML = "❌ No se procesó ninguna línea.<br>" + errores.slice(0, 5).join("<br>");
    statusEl.className = "send-status error";
    return;
  }

  // Consolidar duplicados (mismo SKU + CEDIS)
  const consolidado = {};
  for (const s of skus) {
    const key = s.sku + "|" + s.cedis;
    if (consolidado[key]) {
      duplicados++;
    }
    consolidado[key] = s;
  }
  const skusFinales = Object.values(consolidado);

  // Cargar al formulario temporal
  skusFormTemporal = skusFinales.map(s => ({
    sku: s.sku,
    cedis: s.cedis,
    pz: s.pz,
  }));

  // Llenar el formulario de pedido
  document.getElementById("form-po").value = po;
  document.getElementById("titulo-form-pedido").textContent = "Nuevo pedido (carga masiva)";

  // Renderizar la tabla de SKUs
  renderizarSKUsForm();

  // Volver al formulario
  mostrarPantalla("pantalla-form-pedido");

  // Status final
  const statusForm = document.getElementById("form-pedido-status");
  statusForm.innerHTML = `✅ ${skusFinales.length} líneas cargadas` +
    (duplicados > 0 ? ` (${duplicados} consolidadas)` : "") +
    (errores.length > 0 ? `<br>⚠️ ${errores.length} errores: ${errores.slice(0, 3).join(", ")}` : "") +
    `<br><b>Revisa y presiona "Guardar y calcular"</b>`;
  statusForm.className = "send-status ok";
}

// ═══════════════════════════════════════════════════════════════════
// GENERAR QRs - Asignación FIFO de lotes PT por CEDIS
// ═══════════════════════════════════════════════════════════════════

let cedisPendientesCache = null;
let asignacionGenerada = null;

function mostrarGenerarQRs() {
  // Mostrar pantalla
  ["view-ready", "view-scanning", "view-loading", "view-result", "view-selector",
   "view-estatus", "view-detalle-camion", "view-manual", "view-cancelar",
   "pantalla-pedidos", "pantalla-form-pedido", "pantalla-detalle-pedido",
   "pantalla-generar-qr"]
    .forEach(v => {
      const el = document.getElementById(v);
      if (el) el.classList.add("hidden");
    });
  document.getElementById("pantalla-generar-qr").classList.remove("hidden");

  document.getElementById("qr-resumen").innerHTML = "";
  document.getElementById("qr-status").textContent = "";
  document.getElementById("qr-status").className = "send-status";
  document.getElementById("btn-descargar-csv").style.display = "none";
  asignacionGenerada = null;

  cargarCedisPendientes();
}

async function cargarCedisPendientes() {
  const cont = document.getElementById("qr-lista-cedis");
  cont.innerHTML = '<p style="text-align:center;color:#718096;">⏳ Cargando...</p>';

  try {
    const url = CONFIG.APPS_SCRIPT_URL + "?accion=cedis_pendientes_para_qr";
    const data = await llamarBackend(url);

    if (!data.ok) throw new Error(data.error || "Error desconocido");

    cedisPendientesCache = data.cedis_pendientes || [];
    renderizarListaCedis(cedisPendientesCache);
  } catch (e) {
    cont.innerHTML = '<p style="text-align:center;color:#C00000;">❌ Error: ' + e.message + '</p>';
  }
}

function renderizarListaCedis(lista) {
  const cont = document.getElementById("qr-lista-cedis");
  if (!lista || lista.length === 0) {
    cont.innerHTML = '<p style="text-align:center;color:#1F7A1F;padding:20px;">✅ No hay CEDIS pendientes de cubrir.</p>';
    return;
  }

  // Ordenar por PO ascendente, luego CEDIS ascendente
  lista.sort((a, b) => {
    if (String(a.po) !== String(b.po)) return String(a.po).localeCompare(String(b.po));
    return String(a.cedis).padStart(3, "0").localeCompare(String(b.cedis).padStart(3, "0"));
  });

  // Resumen arriba
  const totalPZ = lista.reduce((s, x) => s + (x.pz_pendientes || 0), 0);
  const totalTarimas = lista.reduce((s, x) => s + Math.ceil((x.pz_pendientes || 0) / 5200), 0);
  const posUnicos = new Set(lista.map(x => x.po));

  let html = '<div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px;margin-bottom:15px;font-size:12px;color:#1E40AF;">';
  html += '<b>ℹ️ Mostrando ' + lista.length + ' línea(s) con pendiente por generar</b><br>';
  html += '<span style="font-size:11px;opacity:0.85;">';
  html += posUnicos.size + ' PO(s) · ' + totalTarimas + ' tarima(s) estimadas · ' + formatearNumero(totalPZ, 0) + ' PZ';
  html += '</span><br>';
  html += '<span style="font-size:11px;opacity:0.85;font-style:italic;">Los CEDIS ya cubiertos por stock PT no aparecen aquí.</span>';
  html += '</div>';

  html += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
  html += '<thead><tr style="background:#1F4E79;color:white;">';
  html += '<th style="padding:8px;width:40px;"></th>';
  html += '<th style="padding:8px;text-align:left;">PO</th>';
  html += '<th style="padding:8px;text-align:left;">CEDIS</th>';
  html += '<th style="padding:8px;text-align:left;">PT</th>';
  html += '<th style="padding:8px;text-align:center;">Pendientes</th>';
  html += '<th style="padding:8px;text-align:center;">Tarimas</th>';
  html += '</tr></thead><tbody>';

  lista.forEach((item, idx) => {
    const tarimas = Math.ceil((item.pz_pendientes || 0) / 5200);
    html += `<tr style="border-bottom:1px solid #eee;">
      <td style="padding:8px;text-align:center;">
        <input type="checkbox" data-idx="${idx}" class="chk-cedis" checked
          style="width:18px;height:18px;cursor:pointer;">
      </td>
      <td style="padding:8px;font-family:monospace;font-size:12px;">${item.po}</td>
      <td style="padding:8px;font-weight:700;">${item.cedis}</td>
      <td style="padding:8px;font-size:12px;">${item.pt_codigo}<br><span style="color:#718096;font-size:10px;">${item.descripcion || ""}</span></td>
      <td style="padding:8px;text-align:center;font-weight:600;color:#B45309;">${formatearNumero(item.pz_pendientes, 0)}</td>
      <td style="padding:8px;text-align:center;font-weight:600;">${tarimas}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  cont.innerHTML = html;

  document.querySelectorAll(".chk-cedis").forEach(chk => {
    chk.addEventListener("change", actualizarResumenSeleccion);
  });
  actualizarResumenSeleccion();
}

function actualizarResumenSeleccion() {
  const checks = document.querySelectorAll(".chk-cedis");
  let totalPZ = 0;
  let totalTarimas = 0;
  let seleccionados = 0;

  checks.forEach(chk => {
    if (chk.checked) {
      const idx = Number(chk.getAttribute("data-idx"));
      const item = cedisPendientesCache[idx];
      if (item) {
        totalPZ += item.pz_pendientes || 0;
        totalTarimas += Math.ceil((item.pz_pendientes || 0) / 5200);
        seleccionados++;
      }
    }
  });

  const resumen = document.getElementById("qr-resumen");
  if (seleccionados === 0) {
    resumen.innerHTML = '<p style="text-align:center;color:#718096;font-style:italic;">Selecciona al menos un CEDIS</p>';
    return;
  }
  resumen.innerHTML = `
    <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:12px;display:flex;justify-content:space-around;flex-wrap:wrap;gap:10px;">
      <div style="text-align:center;"><div style="font-size:11px;color:#718096;">CEDIS seleccionados</div><div style="font-size:20px;font-weight:700;color:#1F7A1F;">${seleccionados}</div></div>
      <div style="text-align:center;"><div style="font-size:11px;color:#718096;">Piezas totales</div><div style="font-size:20px;font-weight:700;color:#1F7A1F;">${formatearNumero(totalPZ, 0)}</div></div>
      <div style="text-align:center;"><div style="font-size:11px;color:#718096;">Tarimas a generar</div><div style="font-size:20px;font-weight:700;color:#1F7A1F;">${totalTarimas}</div></div>
    </div>
  `;
}

async function generarAsignacionQR() {
  const statusEl = document.getElementById("qr-status");
  const checks = document.querySelectorAll(".chk-cedis");

  const seleccionados = [];
  checks.forEach(chk => {
    if (chk.checked) {
      const idx = Number(chk.getAttribute("data-idx"));
      const item = cedisPendientesCache[idx];
      if (item) seleccionados.push(item);
    }
  });

  if (seleccionados.length === 0) {
    statusEl.textContent = "❌ Selecciona al menos un CEDIS";
    statusEl.className = "send-status error";
    return;
  }

  statusEl.textContent = "⏳ Calculando asignación FIFO...";
  statusEl.className = "send-status";

  const session = getSessionGlobal();
  const body = {
    cedis_seleccionados: seleccionados.map(s => ({
      po: s.po,
      cedis: s.cedis,
      pt_codigo: s.pt_codigo,
      pz_pendientes: s.pz_pendientes,
    })),
    usuario: session ? session.user : "sistema",
    rol: session ? session.rol : "admin",
  };

  const url = CONFIG.APPS_SCRIPT_URL + "?accion=generar_asignacion_qr&data=" + encodeURIComponent(JSON.stringify(body));

  try {
    const resp = await llamarBackend(url);
    if (!resp.ok) throw new Error(resp.error || "Error desconocido");

    asignacionGenerada = resp;
    renderizarAsignacion(resp);

    // Status final con resumen
    const nTarimas = resp.total_tarimas || 0;
    const nNoCub = resp.total_no_cubiertos || 0;
    if (nTarimas === 0) {
      statusEl.textContent = "⚠️ No se generó ninguna tarima (sin stock PT)";
      statusEl.className = "send-status error";
    } else if (nNoCub > 0) {
      statusEl.textContent = "⚠️ " + nTarimas + " tarima(s) generada(s). " + nNoCub + " CEDIS sin cubrir.";
      statusEl.className = "send-status error";
    } else {
      statusEl.textContent = "✅ " + nTarimas + " tarima(s) generada(s) — todos los CEDIS cubiertos";
      statusEl.className = "send-status ok";
    }

    document.getElementById("btn-descargar-csv").style.display = "block";
  } catch (e) {
    statusEl.textContent = "❌ " + e.message;
    statusEl.className = "send-status error";
  }
}
function renderizarAsignacion(resp) {
  const cont = document.getElementById("qr-resumen");
  const tarimas = resp.tarimas || [];
  const noCubiertos = resp.no_cubiertos || [];

  let html = "";

  // ═══════════════════════════════════════════════════════════════
  // BLOQUE 1: Tarimas asignadas
  // ═══════════════════════════════════════════════════════════════
  if (tarimas.length > 0) {
    html += '<h3 style="margin-bottom:10px;color:#1F7A1F;font-size:15px;">✅ Tarimas Asignadas (' + tarimas.length + ')</h3>';
    html += '<div style="overflow-x:auto;">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<thead><tr style="background:#1F7A1F;color:white;">';
    html += '<th style="padding:6px;">#</th>';
    html += '<th style="padding:6px;">CEDIS</th>';
    html += '<th style="padding:6px;">PO</th>';
    html += '<th style="padding:6px;">Sabor</th>';
    html += '<th style="padding:6px;">Lotes asignados</th>';
    html += '<th style="padding:6px;">Total PZ</th>';
    html += '</tr></thead><tbody>';

    tarimas.forEach((t, i) => {
      const lotesTxt = (t.lotes || []).map(l =>
        `${l.lote}<br><span style="color:#718096;font-size:10px;">${l.pz} PZ</span>`
      ).join("<br>");
      const totalPZ = (t.lotes || []).reduce((s, l) => s + (l.pz || 0), 0);
      const parcial = totalPZ < 5200;

      html += `<tr style="border-bottom:1px solid #eee;${i % 2 === 0 ? "background:#FAFBFD;" : ""}">
        <td style="padding:6px;text-align:center;font-weight:700;">${t.num_tarima}</td>
        <td style="padding:6px;text-align:center;font-weight:600;">${t.cedis}</td>
        <td style="padding:6px;text-align:center;font-family:monospace;font-size:11px;">${t.po}</td>
        <td style="padding:6px;text-align:center;">${t.sabor}</td>
        <td style="padding:6px;font-size:11px;">${lotesTxt}</td>
        <td style="padding:6px;text-align:right;font-weight:700;${parcial ? "color:#B45309;" : ""}">${formatearNumero(totalPZ, 0)}${parcial ? " ⚠️" : ""}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
  } else {
    html += '<p style="color:#B45309;font-weight:600;">⚠️ No se generó ninguna tarima (sin stock PT).</p>';
  }

  // ═══════════════════════════════════════════════════════════════
  // BLOQUE 2: CEDIS no cubiertos
  // ═══════════════════════════════════════════════════════════════
  if (noCubiertos.length > 0) {
    html += '<h3 style="margin:20px 0 10px;color:#C00000;font-size:15px;">❌ CEDIS No Cubiertos (' + noCubiertos.length + ')</h3>';
    html += '<div style="overflow-x:auto;">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<thead><tr style="background:#C00000;color:white;">';
    html += '<th style="padding:6px;">CEDIS</th>';
    html += '<th style="padding:6px;">PO</th>';
    html += '<th style="padding:6px;">PT</th>';
    html += '<th style="padding:6px;">Pendientes</th>';
    html += '<th style="padding:6px;">Cubiertos</th>';
    html += '<th style="padding:6px;">Faltantes</th>';
    html += '<th style="padding:6px;">Motivo</th>';
    html += '</tr></thead><tbody>';

    noCubiertos.forEach((n, i) => {
      const cubiertos = n.pz_cubiertos || 0;
      const faltantes = n.pz_faltantes || n.pz_pendientes;
      html += `<tr style="border-bottom:1px solid #eee;${i % 2 === 0 ? "background:#FFF5F5;" : ""}">
        <td style="padding:6px;text-align:center;font-weight:600;">${n.cedis}</td>
        <td style="padding:6px;text-align:center;font-family:monospace;font-size:11px;">${n.po}</td>
        <td style="padding:6px;text-align:center;font-size:11px;">${n.pt_codigo}</td>
        <td style="padding:6px;text-align:right;">${formatearNumero(n.pz_pendientes, 0)}</td>
        <td style="padding:6px;text-align:right;color:#1F7A1F;">${cubiertos > 0 ? formatearNumero(cubiertos, 0) : "—"}</td>
        <td style="padding:6px;text-align:right;color:#C00000;font-weight:700;">${formatearNumero(faltantes, 0)}</td>
        <td style="padding:6px;font-size:11px;color:#718096;">${n.motivo || ""}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
  }

  // ═══════════════════════════════════════════════════════════════
  // BLOQUE 3: Alertas (tarimas parciales, etc.)
  // ═══════════════════════════════════════════════════════════════
  if (resp.alertas && resp.alertas.length > 0) {
    html += '<div style="margin-top:15px;padding:10px;background:#FEF3C7;border:1px solid #FDE68A;border-radius:8px;">';
    html += '<b>⚠️ Alertas (' + resp.alertas.length + '):</b>';
    html += '<ul style="margin:6px 0 0 20px;font-size:12px;max-height:200px;overflow-y:auto;">';
    resp.alertas.slice(0, 30).forEach(a => { html += '<li>' + a + '</li>'; });
    if (resp.alertas.length > 30) {
      html += '<li style="color:#718096;font-style:italic;">... y ' + (resp.alertas.length - 30) + ' más</li>';
    }
    html += '</ul></div>';
  }

  cont.innerHTML = html;
}

function descargarAsignacionCSV() {
  if (!asignacionGenerada || !asignacionGenerada.tarimas) {
    alert("Primero genera la asignación");
    return;
  }

  const tarimas = asignacionGenerada.tarimas;
  const noCub = asignacionGenerada.no_cubiertos || [];

  let csv = "=== TARIMAS ASIGNADAS ===\n";
  csv += "num_tarima,cedis,po,sabor,lote,pz,pt_codigo\n";

  tarimas.forEach(t => {
    (t.lotes || []).forEach(l => {
      csv += `${t.num_tarima},${t.cedis},${t.po},${t.sabor},${l.lote},${l.pz},${t.pt_codigo}\n`;
    });
  });

  if (noCub.length > 0) {
    csv += "\n=== CEDIS NO CUBIERTOS ===\n";
    csv += "cedis,po,pt_codigo,sabor,pz_pendientes,pz_cubiertos,pz_faltantes,motivo\n";
    noCub.forEach(n => {
      csv += `${n.cedis},${n.po},${n.pt_codigo},${n.sabor || ""},${n.pz_pendientes},${n.pz_cubiertos || 0},${n.pz_faltantes || n.pz_pendientes},"${n.motivo || ""}"\n`;
    });
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "asignacion_qr_" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}

// Exponer al scope global
window.mostrarGenerarQRs = mostrarGenerarQRs;
window.cargarCedisPendientes = cargarCedisPendientes;
window.generarAsignacionQR = generarAsignacionQR;
window.descargarAsignacionCSV = descargarAsignacionCSV;

// ═══════════════════════════════════════════════════════════════════
// ALIAS DE COMPATIBILIDAD
// Por si algún HTML viejo llama al nombre incorrecto
// ═══════════════════════════════════════════════════════════════════

window.refrescarStockPedidoData = refrescarStock;
window.refrescarStockPedido = refrescarStock;
window.refrescar_stock_pedido = refrescarStock;
