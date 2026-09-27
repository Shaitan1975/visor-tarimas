// ═══════════════════════════════════════════════════════════════════
// VISOR TARIMAS - LÓGICA DE LA PWA (v8)
// Detecta automáticamente QR de PT (texto plano) o INSUMOS (cifrado)
// Empresa: Mediese
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  APPS_SCRIPT_URL: `https://script.google.com/macros/s/AKfycbysNMzTsi82faMvOvOmbH2E4KIhH8D5GIUSl8CMdlZT28LoO27AFi52OoPbLo4tgXCE0g/exec`,
  CLAVE_EMPRESA: "MediesE2026$Almacen",
  SALT_PBKDF2: "salt-fijo-empresa-2026",
  ITERACIONES: 100000,
  SESSION_KEY: "visor_tarimas_session"
};

// Mapeo de lugares a eventos
const MAPA_LUGARES = {
  "planta": {
    evento: "SALIDA_PLANTA",
    ubicacion: "PLANTA",
    etiqueta: "🚚 SALIDA DE PLANTA",
    color: "#1F4E79",
    colorFondo: "#D9E5F2",
    icono: "🚚",
  },
  "aduana-entrada": {
    evento: "ADUANA_ENTRADA",
    ubicacion: "ADUANA",
    etiqueta: "🛃 ENTRADA A ADUANA",
    color: "#B8860B",
    colorFondo: "#FFF8DC",
    icono: "🛃",
  },
  "aduana-salida": {
    evento: "ADUANA_SALIDA",
    ubicacion: "EN_TRANSITO",
    etiqueta: "📦 SALIDA DE ADUANA",
    color: "#8B4513",
    colorFondo: "#F5DEB3",
    icono: "📦",
  },
  "cedis": {
    evento: "ENTREGA_CEDIS",
    ubicacion: "CEDIS",
    etiqueta: "✅ ENTREGA EN CEDIS",
    color: "#1F7A1F",
    colorFondo: "#D9F0D9",
    icono: "✅",
  },
  "insumos": {
    evento: null,
    ubicacion: "ALMACEN",
    etiqueta: "📋 CONSULTA DE INSUMOS",
    color: "#666666",
    colorFondo: "#F5F5F5",
    icono: "📋",
  },
};

const App = (() => {

  // ═══════════════════════════════════════════════════════════
  // CONFIGURACIÓN DE MODO (según URL)
  // ═══════════════════════════════════════════════════════════

  function obtenerModo() {
    const params = new URLSearchParams(window.location.search);
    const lugar = params.get("lugar") || "insumos";
    return MAPA_LUGARES[lugar] || MAPA_LUGARES["insumos"];
  }

  function aplicarModoVisual(modo) {
    const indicador = document.getElementById("modo-indicador");
    const texto = document.getElementById("modo-texto");
    const icono = document.getElementById("modo-icono");

    if (indicador && texto && icono) {
      texto.textContent = modo.etiqueta;
      icono.textContent = modo.icono;
      indicador.style.background = modo.color;
      indicador.style.color = "#FFFFFF";
    }

    const readyTitulo = document.getElementById("ready-titulo");
    const readyDesc = document.getElementById("ready-descripcion");

    if (modo.evento === null) {
      if (readyTitulo) readyTitulo.textContent = "Listo para escanear";
      if (readyDesc) readyDesc.textContent = "Consulta la información de la tarima.";
    } else {
      if (readyTitulo) readyTitulo.textContent = modo.etiqueta;
      if (readyDesc) readyDesc.textContent = "Escanea cada tarima para registrar el evento.";
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SESIÓN
  // ═══════════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════════
  // PBKDF2
  // ═══════════════════════════════════════════════════════════

  async function pbkdf2Hash(password, saltHex) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(password),
      { name: "PBKDF2" }, false, ["deriveBits"]
    );
    const saltBytes = new Uint8Array(
      saltHex.match(/.{1,2}/g).map(b => parseInt(b, 16))
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: saltBytes, iterations: CONFIG.ITERACIONES, hash: "SHA-256" },
      keyMaterial,
      256
    );
    return Array.from(new Uint8Array(bits))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function verificarUsuario(usuario, password) {
    try {
      const resp = await fetch("usuarios.json?t=" + Date.now());
      const usuarios = await resp.json();
      const user = usuarios.find(u => u.user === usuario.toLowerCase().trim());
      if (!user) return null;
      const hashCalc = await pbkdf2Hash(password, user.salt);
      if (hashCalc === user.hash) {
        return { user: user.user, nombre: user.nombre, rol: user.rol };
      }
      return null;
    } catch (e) {
      console.error("Error al verificar usuario:", e);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // DESCIFRADO (para insumos)
  // ═══════════════════════════════════════════════════════════

  function descifrarBlobQR(blobB64, password) {
    const key = CryptoJS.PBKDF2(password, CONFIG.SALT_PBKDF2, {
      keySize: 256 / 32,
      iterations: CONFIG.ITERACIONES,
      hasher: CryptoJS.algo.SHA256
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
      { ciphertext: ciphertext },
      key,
      { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
    );

    const texto = decrypted.toString(CryptoJS.enc.Utf8);
    if (!texto) throw new Error("Contraseña incorrecta o datos corruptos");
    return JSON.parse(texto);
  }

  // ═══════════════════════════════════════════════════════════
  // PARSEO DE QR DE PT (texto plano)
  // ═══════════════════════════════════════════════════════════

  function parsearQRPT(texto) {
    // Ej: "PO:14641379|CEDIS:99003|DC:003|S:OR|CAM:C22|TARIMA:3|TOT:28|LOTES:LMKSH-4:5200"
    const partes = {};
    texto.split("|").forEach(p => {
      const idx = p.indexOf(":");
      if (idx > 0) {
        const k = p.substring(0, idx).trim();
        const v = p.substring(idx + 1).trim();
        partes[k] = v;
      }
    });

    let lotes = [];
    if (partes.LOTES) {
      partes.LOTES.split(",").forEach(l => {
        const idx = l.indexOf(":");
        if (idx > 0) {
          const lote = l.substring(0, idx).trim();
          const pz = parseInt(l.substring(idx + 1).trim()) || 0;
          lotes.push({ lote: lote, pz: pz });
        }
      });
    }

    const dc = partes.DC || "";
    const tarima = partes.TARIMA || "";

    return {
      o: dc,
      l: tarima,
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

  // ═══════════════════════════════════════════════════════════
  // LOGIN
  // ═══════════════════════════════════════════════════════════

  function initLogin() {
    if (getSession()) {
      const params = window.location.search;
      window.location.href = "scanner.html" + params;
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
        const params = window.location.search;
        window.location.href = "scanner.html" + params;
      } else {
        errorMsg.textContent = "Usuario o contraseña incorrectos";
        btn.disabled = false;
        btn.textContent = "Entrar";
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // SCANNER
  // ═══════════════════════════════════════════════════════════

  let stream = null;
  let scanning = false;
  let modoActual = null;

  function initScanner() {
    const session = getSession();
    if (!session) {
      const params = window.location.search;
      window.location.href = "index.html" + params;
      return;
    }

    modoActual = obtenerModo();
    aplicarModoVisual(modoActual);

    document.getElementById("user-info").textContent =
      `${session.nombre} (${session.rol})`;

    document.getElementById("btn-logout").addEventListener("click", () => {
      clearSession();
      window.location.href = "index.html";
    });

    document.getElementById("btn-start-scan").addEventListener("click", iniciarCamara);
    document.getElementById("btn-cancel-scan").addEventListener("click", cancelarCamara);
    document.getElementById("btn-scan-again").addEventListener("click", () => {
      document.getElementById("send-status").textContent = "";
      mostrarVista("view-ready");
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").then(reg => {
        reg.update().catch(() => {});
      }).catch(() => {});
    }
  }

  function mostrarVista(id) {
    ["view-ready", "view-scanning", "view-loading", "view-result"].forEach(v => {
      document.getElementById(v).classList.add("hidden");
    });
    document.getElementById(id).classList.remove("hidden");
  }

  async function iniciarCamara() {
    mostrarVista("view-scanning");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
      });
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

      // Detectar tipo de QR
      if (datosQR.includes("PO:") && datosQR.includes("|")) {
        // QR de PT (texto plano)
        console.log("QR de PT detectado");
        datos = parsearQRPT(datosQR);
      } else {
        // QR de INSUMOS (cifrado)
        console.log("QR de INSUMOS detectado");
        datos = descifrarBlobQR(datosQR, CONFIG.CLAVE_EMPRESA);
      }

      const session = getSession();
      const payload = {
        accion: "evento",
        qr_id: datos.qr_id || (datos.camion || "") + "-DC" + (datos.dc || "") + "-" + (datos.s || "") + "-T" + (datos.num_tarima || ""),
        camion: datos.c || datos.camion || "",
        po: datos.po || "",
        cedis: datos.cedis || "",
        dc: datos.dc || datos.g || datos.o || "",
        sabor: datos.s || datos.sabor || "",
        lote: datos.lote || (datos.lotes && datos.lotes[0] ? datos.lotes[0].lote : ""),
        num_tarima: datos.num_tarima || datos.t || 0,
        evento: modoActual.evento,
        usuario: session.user,
        nombre: session.nombre,
        rol: session.rol,
        notas: "",
      };

      // Si hay lotes (PT), agregar
      if (datos.lotes && datos.lotes.length > 0) {
        payload.lotes = datos.lotes;
        payload.lotes_json = JSON.stringify(datos.lotes);
      }

      const resp = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });

      setTimeout(() => mostrarExito(datos, session), 500);

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

    document.getElementById("result-titulo").textContent = "OK: " + modoActual.etiqueta;
    document.getElementById("result-subtitulo").textContent =
      (datos.dc ? "DC " + datos.dc : "") + " " + (datos.s || "");

    document.getElementById("meta-evento").textContent = modoActual.evento || "CONSULTA";
    document.getElementById("meta-ubicacion").textContent = modoActual.ubicacion;
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

  // ═══════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════

  return { initLogin, initScanner };

})();
