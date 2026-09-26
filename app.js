// ═══════════════════════════════════════════════════════════════════
// VISOR TARIMAS - LÓGICA DE LA PWA (v4)
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  APPS_SCRIPT_URL: `https://script.google.com/macros/s/AKfycbxWEaP-MbHf4UeI3EZ62BhtxN37s9rtafJtTCGvOTEczmY2WUVqFpR7W8Hkn1vZ5lQ1/exec`,
  CLAVE_EMPRESA: "MediesE2026$Almacen",
  SALT_PBKDF2: "salt-fijo-empresa-2026",
  ITERACIONES: 100000,
  SESSION_KEY: "visor_tarimas_session"
};

const App = (() => {

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
  // PBKDF2 (mismo que Python)
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
  // DESCIFRADO AES-256-CBC
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

  // ═══════════════════════════════════════════════════════════
  // SCANNER
  // ═══════════════════════════════════════════════════════════

  let stream = null;
  let scanning = false;
  let datosActuales = null;

  function initScanner() {
    const session = getSession();
    if (!session) {
      window.location.href = "index.html";
      return;
    }

    document.getElementById("user-info").textContent =
      `${session.nombre} (${session.rol})`;

    document.getElementById("btn-logout").addEventListener("click", () => {
      clearSession();
      window.location.href = "index.html";
    });

    document.getElementById("btn-start-scan").addEventListener("click", iniciarCamara);
    document.getElementById("btn-cancel-scan").addEventListener("click", cancelarCamara);
    document.getElementById("btn-scan-again").addEventListener("click", () => {
      datosActuales = null;
      document.getElementById("send-status").textContent = "";
      mostrarVista("view-ready");
    });
    document.getElementById("btn-send-email").addEventListener("click", enviarCorreo);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
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

  function procesarQR(blobCifrado) {
    console.log("🔍 BLOB LEÍDO:", blobCifrado);
    console.log("🔍 LONGITUD:", blobCifrado.length);
    mostrarVista("view-loading");
    try {
      const datos = descifrarBlobQR(blobCifrado, CONFIG.CLAVE_EMPRESA);
      datosActuales = datos;
      setTimeout(() => mostrarDatos(datos), 200);
    } catch (e) {
      setTimeout(() => {
        alert("Error al descifrar el QR:\n\n" + e.message +
              "\n\nVerifica que la etiqueta sea del sistema Visor Tarimas.");
        mostrarVista("view-ready");
      }, 200);
    }
  }

  function fmtNumero(n) {
    return Number(n || 0).toLocaleString("es-MX", {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  function mostrarDatos(d) {
    document.getElementById("result-titulo").textContent = `Tarima ${d.o}`;
    document.getElementById("result-subtitulo").textContent = `Lote: ${d.l}`;
    document.getElementById("meta-oar").textContent = d.o;
    document.getElementById("meta-lote").textContent = d.l;
    document.getElementById("meta-total").textContent = d.u;

    document.getElementById("val-entrada").textContent = fmtNumero(d.e);
    document.getElementById("val-consumo").textContent = fmtNumero(d.c);
    document.getElementById("val-saldo").textContent = fmtNumero(d.s);
    document.getElementById("unidad-entrada").textContent = d.u;
    document.getElementById("unidad-consumo").textContent = d.u;
    document.getElementById("unidad-saldo").textContent = d.u;

    mostrarVista("view-result");
  }

  // ═══════════════════════════════════════════════════════════
  // ENVÍO A APPS SCRIPT
  // ═══════════════════════════════════════════════════════════

  async function enviarCorreo() {
    if (!datosActuales) return;
    const session = getSession();
    const statusEl = document.getElementById("send-status");
    const btn = document.getElementById("btn-send-email");

    statusEl.textContent = "Enviando reporte...";
    statusEl.className = "send-status";
    btn.disabled = true;

    const payload = {
      usuario: session.user,
      nombre: session.nombre,
      rol: session.rol,
      codigo_oar: datosActuales.o,
      lote: datosActuales.l,
      blob_cifrado: JSON.stringify(datosActuales),
      timestamp: new Date().toISOString()
    };

    try {
      await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      statusEl.textContent = "✅ Reporte enviado a sensabit@gmail.com";
      statusEl.className = "send-status ok";
      btn.disabled = false;
    } catch (e) {
      statusEl.textContent = "❌ Error al enviar: " + e.message;
      statusEl.className = "send-status error";
      btn.disabled = false;
    }
  }

  return { initLogin, initScanner };

})();
