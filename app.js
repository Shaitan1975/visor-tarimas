// ═══════════════════════════════════════════════════════════════════
// VISOR TARIMAS - LÓGICA DE LA PWA (v5)
// Detecta el evento según la URL (?lugar=planta, ?lugar=aduana-entrada, etc.)
// Empresa: Mediese
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  APPS_SCRIPT_URL: `https://script.google.com/macros/s/AKfycbxWEaP-MbHf4UeI3EZ62BhtxN37s9rtafJtTCGvOTEczmY2WUVqFpR7W8Hkn1vZ5lQ1/exec`,
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
    // Modo antiguo: solo muestra info sin registrar evento
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
    // Actualizar indicador
    const indicador = document.getElementById("modo-indicador");
    const texto = document.getElementById("modo-texto");
    const icono = document.getElementById("modo-icono");

    if (indicador && texto && icono) {
      texto.textContent = modo.etiqueta;
      icono.textContent = modo.icono;
      indicador.style.background = modo.color;
      indicador.style.color = "#FFFFFF";
    }

    // Actualizar textos según modo
    const readyTitulo = document.getElementById("ready-titulo");
    const readyDesc = document.getElementById("ready-descripcion");

    if (modo.evento === null) {
      // Modo insumos: solo consulta
      if (readyTitulo) readyTitulo.textContent = "Listo para escanear";
      if (readyDesc) readyDesc.textContent = "Consulta la información de la tarima.";
    } else {
      // Modo evento: registra
      if (readyTitulo) readyTitulo.textContent = modo.etiqueta;
      if (readyDesc) readyDesc.textContent = `Escanea cada tarima para registrar ${modo.etiqueta.replace(/^[^\s]+\s/, '')}`;
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
  // DESCIFRADO
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
  // LOGIN
  // ═══════════════════════════════════════════════════════════

  function initLogin() {
    if (getSession()) {
      // Preservar el parámetro ?lugar= al redirigir
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

  async function procesarQR(blobCifrado) {
    mostrarVista("view-loading");
    document.getElementById("loading-text").textContent = "Registrando evento...";

    try {
      // 1. Descifrar el QR
      const datos = descifrarBlobQR(blobCifrado, CONFIG.CLAVE_EMPRESA);

      // 2. Enviar a Apps Script
      const session = getSession();
      const payload = {
        accion: "evento",
        qr_id: datos.qr_id || (datos.o + "-" + datos.l),
        camion: datos.c || datos.camion || "",
        po: datos.po || "",
        dc: datos.dc || datos.g || "",
        sabor: datos.s || datos.sabor || "",
        lote: datos.l || datos.lote || "",
        num_tarima: datos.t || datos.num_tarima || 0,
        evento: modoActual.evento,
        usuario: session.user,
        nombre: session.nombre,
        rol: session.rol,
        notas: "",
      };

      const resp = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });

      // Con no-cors no podemos leer la respuesta
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

    document.getElementById("result-titulo").textContent = `✅ ${modoActual.etiqueta}`;
    document.getElementById("result-subtitulo").textContent =
      `${datos.dc ? "DC " + datos.dc : ""} ${datos.s || ""} - ${datos.po || ""}`;

    document.getElementById("meta-evento").textContent = modoActual.evento || "CONSULTA";
    document.getElementById("meta-ubicacion").textContent = modoActual.ubicacion;
    document.getElementById("meta-fecha").textContent = `${fecha} ${hora}`;

    document.getElementById("meta-camion").textContent = datos.c || datos.camion || "-";
    document.getElementById("meta-dc").textContent = datos.dc || datos.g || "-";
    document.getElementById("meta-sabor").textContent = datos.s || datos.sabor || "-";

    document.getElementById("meta-lote").textContent = datos.l || datos.lote || "-";
    document.getElementById("meta-tarima").textContent = datos.t || datos.num_tarima || "-";
    document.getElementById("meta-po").textContent = datos.po || "-";

    mostrarVista("view-result");
  }

  // ═══════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════

  return { initLogin, initScanner };

})();
