// ═══════════════════════════════════════════════════════════════════
// VISOR TARIMAS - LÓGICA DE LA PWA (v24)
// Con progreso + alerta + registro manual admin + cancelar eventos
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

const App = (() => {

  let modoActual = null;
  let modoSeleccionado = null;
  let datosActuales = null;
  let catalogoCache = null;
  let contextoCancelar = null;

  function getSession() {
    const s = localStorage.getItem(CONFIG.SESSION_KEY);
    return s ? JSON.parse(s) : null;
  }
  function setSession(d) {
    localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(d));
  }
  function clearSession() {
    localStorage.removeItem(CONFIG.SESSION_KEY);
  }

  function getCamionActual() {
    return localStorage.getItem(CONFIG.CAMION_KEY) || null;
  }
  function setCamionActual(camion) {
    if (camion) {
      localStorage.setItem(CONFIG.CAMION_KEY, camion);
    }
  }
  function limpiarCamionActual() {
    localStorage.removeItem(CONFIG.CAMION_KEY);
  }

  async function pbkdf2Hash(password, saltHex) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
    );
    const saltBytes = new Uint8Array(
      saltHex.match(/.{1,2}/g).map(b => parseInt(b, 16))
    );
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
    } catch (e) {
      console.error("Error al verificar usuario:", e);
      return null;
    }
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
      if (idx > 0) {
        partes[p.substring(0, idx).trim()] = p.substring(idx + 1).trim();
      }
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
      po: partes.PO || "",
      cedis: partes.CEDIS || "",
      dc: dc,
      s: partes.S || "",
      c: partes.CAM || "",
      camion: partes.CAM || "",
      num_tarima: tarima,
      t: tarima,
      tot: partes.TOT || "",
      lotes: lotes,
      es_pt: true,
    };
  }

  function initLogin() {
    if (getSession()) {
      window.location.href = "scanner.html";
      return;
    }
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
    if (!session) {
      window.location.href = "index.html";
      return;
    }

    document.getElementById("user-info").textContent = `${session.nombre} (${session.rol})`;

    if (session.rol === "admin") {
      document.getElementById("btn-registro-manual").classList.remove("hidden");
    }
    const ROLES_PEDIDOS = ["gerencia", "admin"];
    if (ROLES_PEDIDOS.includes(session.rol)) {
      const btnPedidos = document.getElementById("btn-pedidos");
      if (btnPedidos) btnPedidos.classList.remove("hidden");
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
        if (confirm("¿Cerrar el progreso del camión actual?\n\nEl siguiente escaneo empezará un camión nuevo.")) {
          const camion = getCamionActual();
          if (camion) {
            window['camion_' + camion + '_completado_alertado'] = false;
          }
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
      if (estatusVisible) {
        verEstatusCamiones();
      }
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
      alert("Tu usuario no tiene eventos asignados. Contacta al administrador.");
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
    ["view-ready", "view-scanning", "view-loading", "view-result", "view-selector", "view-estatus", "view-detalle-camion", "view-manual", "view-cancelar"]
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
    ["view-ready", "view-scanning", "view-loading", "view-result", "view-selector", "view-estatus", "view-detalle-camion", "view-manual", "view-cancelar"]
      .forEach(v => {
        const el = document.getElementById(v);
        if (el) el.classList.add("hidden");
      });
    document.getElementById(id).classList.remove("hidden");

    if (id === "view-ready") {
      actualizarProgresoPantalla();
    }
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
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
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
        if (stream) {
          stream.getTracks().forEach(t => t.stop());
          stream = null;
        }
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

      datosActuales = datos;
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

      if (datos.lotes && datos.lotes.length > 0) {
        payload.lotes = datos.lotes;
      }

      const url = CONFIG.APPS_SCRIPT_URL
        + "?accion=evento"
        + "&data=" + encodeURIComponent(JSON.stringify(payload));

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

      if (payload.camion) {
        setCamionActual(payload.camion);
      }

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

      html += '<div class="progreso-barra">';
      html += '<div class="progreso-barra-relleno" style="width: ' + pct + '%;"></div>';
      html += '</div>';

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
          alert("✅ ¡CAMIÓN " + camion + " COMPLETADO!\n\n" +
                "Se registraron las " + ev.total + " tarimas del evento " + info.etiqueta + ".\n\n" +
                "Puedes cerrar el progreso o escanear otro camión.");
        }, 500);
      }

      if (ev.registradas.length > 0) {
        html += '<div class="progreso-lista-titulo">';
        html += '<span>✅ Registradas (' + ev.registradas.length + '):</span>';
        html += '</div>';
        html += '<div class="progreso-lista">';
        ev.registradas.slice().reverse().forEach(qr => {
          html += '<span class="chip-registrada">✅ ' + qr + '</span>';
        });
        html += '</div>';
      }

      const MAX_FALTANTES = 28;
      if (ev.faltantes.length > 0 && !completado) {
        html += '<div class="progreso-lista-titulo">';
        html += '<span>⏳ Faltantes (' + ev.faltantes.length + '):</span>';
        html += '</div>';
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
    if (!session || session.rol !== "admin") {
      alert("No tienes permisos para acceder al registro manual.");
      return;
    }

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

  function cerrarRegistroManual() {
    mostrarVista("view-ready");
  }

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

    if (!session || session.rol !== "admin") {
      alert("Sesión inválida. Vuelve a iniciar sesión.");
      return;
    }

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
        dc: dc,
        sabor: sabor,
        num_tarima: numTarima,
        evento: evento,
        usuario: session.user,
        nombre: session.nombre,
        rol: session.rol,
        notas: "[MANUAL] " + (notas || ""),
      };

      const url = CONFIG.APPS_SCRIPT_URL
        + "?accion=evento"
        + "&data=" + encodeURIComponent(JSON.stringify(payload));

      const resp = await jsonp(url);

      if (!resp.ok) {
        if (resp.duplicado) {
          statusEl.textContent = "⚠️ Esta tarima ya tenía registrado este evento el " + resp.fecha_anterior;
          statusEl.className = "send-status error";
        } else {
          statusEl.textContent = "❌ Error: " + (resp.error || "Desconocido");
          statusEl.className = "send-status error";
        }
        return;
      }

      statusEl.textContent = "✅ Evento registrado correctamente";
      statusEl.className = "send-status ok";

      if (camion === getCamionActual()) {
        setCamionActual(camion);
      }

      document.getElementById("btn-registrar-otro").classList.remove("hidden");

    } catch (e) {
      statusEl.textContent = "❌ Error: " + e.message;
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

  // ═══════════════════════════════════════════════════════════
  // CANCELAR EVENTOS (TARIMAS)
  // ═══════════════════════════════════════════════════════════

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

    const ROLES_CANCELAR = ["gerencia", "admin"];
    if (!session || !ROLES_CANCELAR.includes(session.rol)) {
      statusEl.textContent = "Solo Gerencia y Admin pueden cancelar eventos";
      statusEl.className = "send-status error";
      return;
    }

    const motivo = document.getElementById("cancelar-motivo").value.trim();
    if (!motivo) {
      statusEl.textContent = "Escribe el motivo de la cancelación";
      statusEl.className = "send-status error";
      return;
    }

    if (!contextoCancelar) {
      statusEl.textContent = "No hay evento seleccionado";
      statusEl.className = "send-status error";
      return;
    }

    if (!confirm("¿Confirmas cancelar el evento?\n\nCamión: " + contextoCancelar.camion +
                 "\nEvento: " + contextoCancelar.evento +
                 "\nTarima: " + contextoCancelar.qrId)) {
      return;
    }

    statusEl.textContent = "Cancelando...";
    statusEl.className = "send-status";

    try {
      const payload = {
        qr_id: contextoCancelar.qrId,
        camion: contextoCancelar.camion,
        evento: contextoCancelar.evento,
        motivo: motivo,
        usuario: session.user,
        nombre: session.nombre,
        rol: session.rol,
      };

      const url = CONFIG.APPS_SCRIPT_URL
        + "?accion=cancelar_evento"
        + "&data=" + encodeURIComponent(JSON.stringify(payload));

      const resp = await jsonp(url);

      if (!resp.ok) {
        statusEl.textContent = "❌ " + (resp.error || "Error desconocido");
        statusEl.className = "send-status error";
        return;
      }

      statusEl.textContent = "✅ " + (resp.mensaje || "Evento cancelado");
      statusEl.className = "send-status ok";

      setTimeout(() => {
        alert("✅ " + (resp.mensaje || "Evento cancelado") + "\n\nFilas canceladas: " + (resp.cancelados || 1));
        verDetalleCamion(contextoCancelar.camion);
      }, 800);

    } catch (e) {
      statusEl.textContent = "❌ " + e.message;
      statusEl.className = "send-status error";
    }
  }

  // ═══════════════════════════════════════════════════════════
  // JSONP
  // ═══════════════════════════════════════════════════════════

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
      }, 15000);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // ESTATUS DE CAMIONES
  // ═══════════════════════════════════════════════════════════

  async function verEstatusCamiones() {
    mostrarVista("view-loading");
    document.getElementById("loading-text").textContent = "Cargando estatus...";
    try {
      const data = await jsonp(CONFIG.APPS_SCRIPT_URL + "?accion=estatus_camiones");
      if (!data.ok) throw new Error("Error al cargar estatus");
      mostrarListaCamiones(data.camiones);
    } catch (e) {
      alert("Error al cargar estatus:\n\n" + e.message);
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
      const titulo = document.createElement("h3");
      titulo.textContent = "🔥 Camiones Activos";
      titulo.style.marginTop = "10px";
      contenedor.appendChild(titulo);
      activos.forEach(c => contenedor.appendChild(crearTarjetaCamion(c)));
    }

    if (completados.length > 0) {
      const titulo = document.createElement("h3");
      titulo.textContent = "✅ Camiones Completados";
      titulo.style.marginTop = "20px";
      contenedor.appendChild(titulo);
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
      if (!e.completado) {
        faltanTexto = '<span class="evento-faltan">(faltan ' + e.faltan + ')</span>';
      }

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
      if (!data.ok) throw new Error("Error al cargar detalle");
      mostrarDetalleCamion(data);
    } catch (e) {
      alert("Error al cargar detalle:\n\n" + e.message);
      verEstatusCamiones();
    }
  }

  function mostrarDetalleCamion(data) {
    document.getElementById("detalle-titulo").textContent = "🚚 " + data.camion;

    const contenedor = document.getElementById("detalle-camion");
    contenedor.innerHTML = "";

    const ROLES_CANCELAR = ["gerencia", "admin"];
    const session = getSession();
    const puedeCancelar = session && ROLES_CANCELAR.includes(session.rol);

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
      if (e.completado) {
        status = "✅ COMPLETADO";
        clase = "completado";
      } else if (e.registradas.length > 0) {
        status = "⏳ FALTAN " + e.faltantes.length;
        clase = "parcial";
      } else {
        status = "⏳ PENDIENTE";
        clase = "pendiente";
      }

      html += '<div class="detalle-evento ' + clase + '">';
      html += '<h4>' + info.icono + ' ' + info.etiqueta + '</h4>';
      html += '<p class="detalle-status">' + status + '</p>';
      html += '<p class="detalle-numero">' + e.registradas.length + '/' + e.total + '</p>';

      if (e.registradas.length > 0) {
        html += '<details open><summary>Ver registradas (' + e.registradas.length + ')</summary>';

        if (!puedeCancelar) {
          html += '<p style="font-size: 12px; color: #92400E; background: #FEF3C7; ' +
                  'padding: 8px; border-radius: 6px; margin: 8px 0;">' +
                  '⚠️ Solo <b>Gerencia</b> y <b>Admin</b> pueden cancelar eventos</p>';
        }

        html += '<ul class="lista-registradas">';
        e.registradas.forEach(qr => {
          html += '<li>' +
                  '<span class="qr-texto">' + qr + '</span>';

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
        html += '<details><summary>Ver faltantes (' + e.faltantes.length + ')</summary>';
        html += '<ul class="lista-faltantes">';
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
  jsonp,           // ← expuesto
  getSession,      // ← expuesto
};

})();

// ═══════════════════════════════════════════════════════════════════
// PEDIDOS - Funciones de PWA (integradas con App)
// ═══════════════════════════════════════════════════════════════════

const SKUS_VALIDOS = ["MK150", "MKLM150", "MKCH150"];

let pedidoActual = null;
let skusFormTemporal = [];

/**
 * Obtiene la sesión actual desde localStorage.
 */
function getSessionGlobal() {
  const s = localStorage.getItem(CONFIG.SESSION_KEY);
  return s ? JSON.parse(s) : null;
}

/**
 * Muestra una pantalla (login, scanner o pedidos) y oculta las demás.
 */
function mostrarPantalla(id) {
  // Ocultar login (si aplica)
  const loginBody = document.querySelector(".login-body");
  if (loginBody) loginBody.style.display = "none";

  // Ocultar vistas del scanner
  ["view-ready", "view-scanning", "view-loading", "view-result", "view-selector",
   "view-estatus", "view-detalle-camion", "view-manual", "view-cancelar"]
    .forEach(v => {
      const el = document.getElementById(v);
      if (el) el.classList.add("hidden");
    });

  // Ocultar pantallas de pedidos
  ["pantalla-pedidos", "pantalla-form-pedido", "pantalla-detalle-pedido"]
    .forEach(p => {
      const el = document.getElementById(p);
      if (el) el.classList.add("hidden");
    });

  // Mostrar la pantalla solicitada
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove("hidden");
    if (el.classList.contains("view-section")) {
      el.classList.add("view-section");
    }
  }
}

/**
 * Vuelve al selector de eventos del scanner.
 */
function volverMenu() {
  // Ocultar pantallas de pedidos
  ["pantalla-pedidos", "pantalla-form-pedido", "pantalla-detalle-pedido"]
    .forEach(p => {
      const el = document.getElementById(p);
      if (el) el.classList.add("hidden");
    });

  // Mostrar selector del scanner
  const selector = document.getElementById("view-selector");
  if (selector) {
    selector.classList.remove("hidden");
  }
}

/**
 * Llama al backend con JSONP (para evitar CORS).
 */
function llamarBackend(url) {
  return App.jsonp(url);
}

// ─── Lista de pedidos ───

async function mostrarListaPedidos() {
  mostrarPantalla("pantalla-pedidos");
  const cont = document.getElementById("lista-pedidos");
  cont.innerHTML = "<p>Cargando pedidos...</p>";

  try {
    const data = await llamarBackend(CONFIG.APPS_SCRIPT_URL + "?accion=listar_pedidos");
    renderizarListaPedidos(data.pedidos || []);
  } catch (e) {
    cont.innerHTML = "<p>Error al cargar pedidos: " + e.message + "</p>";
  }
}

function renderizarListaPedidos(pedidos) {
  const cont = document.getElementById("lista-pedidos");
  if (pedidos.length === 0) {
    cont.innerHTML = "<p>No hay pedidos capturados.</p>";
    return;
  }

  let html = "<table style='width:100%;border-collapse:collapse;'>";
  html += "<thead><tr style='background:#f2f2f2;'><th style='padding:8px;text-align:left;'>PO</th><th>CEDIS</th><th>SKUs</th><th>PZ</th><th></th></tr></thead><tbody>";
  for (const p of pedidos) {
    html += `<tr style="border-bottom:1px solid #eee;">
      <td style="padding:8px;">${p.po}</td>
      <td style="padding:8px;">${p.cedis}</td>
      <td style="padding:8px;">${p.skus.length}</td>
      <td style="padding:8px;">${p.total_pz.toLocaleString()}</td>
      <td style="padding:8px;"><button onclick="abrirPedido('${p.po}','${p.cedis}')" style="padding:5px 10px;">Ver</button></td>
    </tr>`;
  }
  html += "</tbody></table>";
  cont.innerHTML = html;
}

function volverListaPedidos() {
  mostrarListaPedidos();
}

// ─── Formulario ───

function mostrarFormPedido(pedidoExistente = null) {
  skusFormTemporal = [];
  document.getElementById("form-po").value = "";
  document.getElementById("form-cedis").value = "";
  document.getElementById("form-fecha-entrega").value = "";
  document.getElementById("titulo-form-pedido").textContent = "Nuevo pedido";
  document.getElementById("form-pedido-status").textContent = "";

  if (pedidoExistente) {
    document.getElementById("form-po").value = pedidoExistente.po;
    document.getElementById("form-cedis").value = pedidoExistente.cedis;
    document.getElementById("form-fecha-entrega").value = pedidoExistente.fecha_entrega || "";
    document.getElementById("titulo-form-pedido").textContent = "Editar pedido";
    skusFormTemporal = pedidoExistente.skus.map(s => ({ sku: s.sku, pz: s.pz }));
  } else {
    skusFormTemporal = [{ sku: "MK150", pz: 0 }];
  }

  renderizarSKUsForm();
  mostrarPantalla("pantalla-form-pedido");
}

function renderizarSKUsForm() {
  const cont = document.getElementById("lista-skus-form");
  let html = "";
  skusFormTemporal.forEach((s, i) => {
    html += `<div class="fila-sku" style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:center;">
      <select onchange="cambiarSKU(${i}, this.value)" style="padding:8px;border:1px solid #ccc;border-radius:6px;">
        ${SKUS_VALIDOS.map(sku => `<option value="${sku}" ${sku === s.sku ? "selected" : ""}>${sku}</option>`).join("")}
      </select>
      <input type="number" inputmode="numeric" value="${s.pz}" onchange="cambiarPZ(${i}, this.value)" style="padding:8px;border:1px solid #ccc;border-radius:6px;">
      <button onclick="quitarFilaSKU(${i})" style="padding:8px;background:#FEE2E2;border:1px solid #FECACA;border-radius:6px;">🗑</button>
    </div>`;
  });
  cont.innerHTML = html;
}

function agregarFilaSKU() {
  skusFormTemporal.push({ sku: "MK150", pz: 0 });
  renderizarSKUsForm();
}

function quitarFilaSKU(i) {
  skusFormTemporal.splice(i, 1);
  if (skusFormTemporal.length === 0) skusFormTemporal.push({ sku: "MK150", pz: 0 });
  renderizarSKUsForm();
}

function cambiarSKU(i, v) { skusFormTemporal[i].sku = v; }
function cambiarPZ(i, v) { skusFormTemporal[i].pz = Number(v) || 0; }

async function guardarPedidoForm(evt) {
  const po = document.getElementById("form-po").value.trim();
  const cedis = document.getElementById("form-cedis").value.trim().padStart(3, "0");
  const fecha = document.getElementById("form-fecha-entrega").value;
  const statusEl = document.getElementById("form-pedido-status");

  if (!po) return alert("Falta PO");
  if (!cedis) return alert("Falta CEDIS");

  const skus = skusFormTemporal.filter(s => s.pz > 0);
  if (skus.length === 0) return alert("Agrega al menos un SKU con cantidad");

  const session = getSessionGlobal();
  if (!session) return alert("Sesión expirada, vuelve a iniciar sesión");

  const btn = evt ? evt.target : null;
  if (btn) { btn.disabled = true; btn.textContent = "Calculando..."; }
  statusEl.textContent = "Calculando explosión de insumos...";
  statusEl.className = "send-status";

  const body = {
    po: po,
    cedis: cedis,
    fecha_entrega: fecha || "",
    skus: skus,
    usuario: session.user,
    nombre: session.nombre,
    rol: session.rol
  };

  const url = CONFIG.APPS_SCRIPT_URL
    + "?accion=guardar_pedido"
    + "&data=" + encodeURIComponent(JSON.stringify(body));

  try {
    const resp = await llamarBackend(url);
    if (!resp.ok) throw new Error(resp.error || "Error desconocido");

    statusEl.textContent = "✅ Pedido guardado";
    statusEl.className = "send-status ok";

    await abrirPedido(po, cedis);
  } catch (e) {
    statusEl.textContent = "❌ " + e.message;
    statusEl.className = "send-status error";
    if (btn) { btn.disabled = false; btn.textContent = "✅ Guardar y calcular"; }
  }
}

// ─── Detalle del pedido ───

async function abrirPedido(po, cedis) {
  try {
    const url = CONFIG.APPS_SCRIPT_URL
      + "?accion=ver_pedido&po=" + encodeURIComponent(po)
      + "&cedis=" + encodeURIComponent(cedis);
    const data = await llamarBackend(url);
    if (!data.ok) throw new Error(data.error || "Pedido no encontrado");

    pedidoActual = data;
    renderizarDetallePedido(data);
    mostrarPantalla("pantalla-detalle-pedido");
  } catch (e) {
    alert("Error al abrir pedido: " + e.message);
  }
}

function renderizarDetallePedido(p) {
  document.getElementById("titulo-detalle-pedido").textContent =
    "PO " + p.po + " · CEDIS " + p.cedis;

  document.getElementById("info-pedido").innerHTML = `
    <div class="detalle-info" style="margin:15px 0;padding:10px;background:#f9f9f9;border-radius:8px;">
      <p><b>SKUs:</b> ${p.skus.length} · <b>Total piezas:</b> ${p.total_pz.toLocaleString()}</p>
      ${p.fecha_entrega ? `<p><b>Fecha entrega:</b> ${p.fecha_entrega}</p>` : ""}
      <p><b>Capturado:</b> ${p.fecha_captura} por ${p.usuario}</p>
    </div>
  `;

  renderizarConsolidado(p.explosion);
  renderizarPorSKU(p.skus, p.explosion);
  cambiarTabPedido("consolidado");
}

function renderizarConsolidado(explosion) {
  const cont = document.getElementById("tab-consolidado");
  if (!explosion || explosion.length === 0) {
    cont.innerHTML = "<p>Sin insumos calculados.</p>";
    return;
  }

  let html = "<table style='width:100%;border-collapse:collapse;font-size:13px;'>";
  html += "<thead><tr style='background:#f2f2f2;'><th style='padding:8px;text-align:left;'>Insumo</th><th>Necesario</th><th>Stock</th><th>Faltante</th><th>Estado</th></tr></thead><tbody>";
  for (const e of explosion) {
    const icon = e.estado === "OK" ? "✅" : (e.estado === "PARCIAL" ? "⚠️" : "❌");
    html += `<tr style="border-bottom:1px solid #eee;">
      <td style="padding:8px;">${e.insumo}</td>
      <td style="padding:8px;text-align:right;">${e.cantidad_necesaria} ${e.unidad}</td>
      <td style="padding:8px;text-align:right;">${e.stock_actual}</td>
      <td style="padding:8px;text-align:right;">${e.faltante > 0 ? "+" + e.faltante : e.faltante}</td>
      <td style="padding:8px;text-align:center;">${icon} ${e.estado}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  cont.innerHTML = html;
}

function renderizarPorSKU(skus, explosion) {
  const cont = document.getElementById("tab-por-sku");
  let html = "";
  for (const s of skus) {
    html += `<div class="bloque-sku" style="margin-bottom:15px;padding:10px;background:#f9f9f9;border-radius:8px;">
      <h4 style="margin:0 0 8px 0;">${s.sku} · ${s.pz.toLocaleString()} PZ · ${s.pt_codigo}</h4>
      <ul style="margin:0;padding-left:20px;font-size:13px;">`;
    for (const e of explosion) {
      const porSku = e.por_sku?.find(x => x.pt_codigo === s.sku || x.pt_codigo === s.pt_codigo);
      if (!porSku) continue;
      const icon = e.estado === "OK" ? "✅" : (e.estado === "PARCIAL" ? "⚠️" : "❌");
      html += `<li>${e.insumo}: ${porSku.cantidad} ${e.unidad} ${icon}</li>`;
    }
    html += "</ul></div>";
  }
  cont.innerHTML = html;
}

function cambiarTabPedido(tab, evt) {
  const contenedor = document.getElementById("pantalla-detalle-pedido");
  contenedor.querySelectorAll(".tab").forEach(t => t.classList.remove("activo"));
  contenedor.querySelectorAll(".tab-contenido").forEach(c => c.classList.add("hidden"));

  if (evt && evt.target) {
    evt.target.classList.add("activo");
  } else {
    const tabBtn = contenedor.querySelector(`.tab[onclick*="${tab}"]`);
    if (tabBtn) tabBtn.classList.add("activo");
  }

  const contenido = document.getElementById("tab-" + tab);
  if (contenido) contenido.classList.remove("hidden");
}

// ─── Acciones sobre el pedido ───

async function refrescarStock() {
  if (!pedidoActual) return;
  const url = CONFIG.APPS_SCRIPT_URL
    + "?accion=refrescar_stock_pedido"
    + "&po=" + encodeURIComponent(pedidoActual.po)
    + "&cedis=" + encodeURIComponent(pedidoActual.cedis);

  try {
    const resp = await llamarBackend(url);
    if (!resp.ok) throw new Error(resp.error);
    pedidoActual.explosion = resp.explosion;
    renderizarConsolidado(resp.explosion);
    renderizarPorSKU(pedidoActual.skus, resp.explosion);
    alert("Stock actualizado: " + resp.refrescado);
  } catch (e) {
    alert("Error al actualizar stock: " + e.message);
  }
}

function editarPedidoActual() {
  if (!pedidoActual) return;
  mostrarFormPedido(pedidoActual);
}

async function eliminarPedidoActual() {
  if (!pedidoActual) return;
  if (!confirm("¿Eliminar este pedido? Se puede recuperar del historial.")) return;

  const session = getSessionGlobal();
  if (!session) return alert("Sesión expirada");

  const body = {
    po: pedidoActual.po,
    cedis: pedidoActual.cedis,
    usuario: session.user,
    rol: session.rol
  };

  const url = CONFIG.APPS_SCRIPT_URL
    + "?accion=eliminar_pedido"
    + "&data=" + encodeURIComponent(JSON.stringify(body));

  try {
    const resp = await llamarBackend(url);
    if (!resp.ok) throw new Error(resp.error);
    alert("Pedido eliminado");
    mostrarListaPedidos();
  } catch (e) {
    alert("Error al eliminar: " + e.message);
  }
}
