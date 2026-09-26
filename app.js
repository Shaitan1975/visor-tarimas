// ═══════════════════════════════════════════════════════════════════
// VISOR TARIMAS - LÓGICA DE LA PWA
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwPHb9M_jIVCqQMvTi1JC33B5AY7mYFm1Fbtu9odGaksAjStEvSqOiFl6-7l8GSWxbhJQ/exec",
  CLAVE_EMPRESA: "MediesE2026$Almacen",
  SALT_PBKDF2: "salt-fijo-empresa-2026",
  ITERACIONES: 100000,
  SESSION_KEY: "visor_tarimas_session"
};

const App = (() => {

  // ═══════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════

  function getSession() {
    const s = localStorage.getItem(CONFIG.SESSION_KEY);
    return s ? JSON.parse(s) : null;
  }

  function setSession(data) {
    localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(data));
  }

  function clearSession() {
    localStorage.removeItem(CONFIG.SESSION_KEY);
  }

  async function pbkdf2Hash(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password),
    { name: "PBKDF2" }, false, ["deriveBits"]
  );
  // 🔧 FIX: convertir salt de string hex a bytes reales (igual que Python)
  const saltBytes = new Uint8Array(
    salt.match(/.{1,2}/g).map(b => parseInt(b, 16))
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: CONFIG.ITERACIONES,
      hash: "SHA-256"
    },
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
      const user = usuarios.find(u =>
        u.user === usuario.toLowerCase().trim()
      );
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
  // DESCIFRADO DEL QR
  // El QR contiene un blob generado con Fernet (AES-128-CBC + HMAC)
  // Fernet usa una clave derivada de PBKDF2 sobre la contraseña de empresa
  // ═══════════════════════════════════════════════════════════

  function descifrarBlobQR(blobB64, password) {
    // 1. Derivar clave con PBKDF2 (misma config que Python)
    const key = CryptoJS.PBKDF2(password, CONFIG.SALT_PBKDF2, {
      keySize: 256 / 32,
      iterations: CONFIG.ITERACIONES,
      hasher: CryptoJS.algo.SHA256
    });

    // 2. Decodificar base64 urlsafe
    const normalized = blobB64.replace(/-/g, "+").replace(/_/g, "/");
    const rawBytes = CryptoJS.enc.Base64.parse(normalized);

    // 3. Estructura Fernet: version(1) + timestamp(8) + IV(16) + ciphertext + HMAC(32)
    // Fernet usa la clave para AES-128 (primeros 16 bytes) y HMAC-SHA256 (últimos 16)
    const keyBytes = CryptoJS.enc.Base64.parse(
      key.toString(CryptoJS.enc.Base64)
    );
    const signingKey = CryptoJS.lib.WordArray.create(keyBytes.words.slice(0, 4));
    const encryptionKey = CryptoJS.lib.WordArray.create(keyBytes.words.slice(4, 8));

    // 4. Extraer IV y ciphertext del blob (saltando los primeros 9 bytes)
    const iv = CryptoJS.lib.WordArray.create(rawBytes.words.slice(2), 16);
    // Ajuste fino de offset (9 bytes = 2 palabras + 1 byte)
    const ivBytes = rawBytes.clone();
    ivBytes.sigBytes = 4;
    ivBytes.words = ivBytes.words.slice(2, 3);
    const ivReal = CryptoJS.lib.WordArray.create(
      rawBytes.words.slice(2, 6), 16
    );
    ivReal.words = rawBytes.words.slice(2, 6);

    const ciphertext = CryptoJS.lib.WordArray.create(
      rawBytes.words.slice(6, rawBytes.words.length - 8),
      rawBytes.sigBytes - 25 - 32
    );

    // 5. Descifrar AES-128-CBC
    const decrypted = CryptoJS.AES.decrypt(
      { ciphertext: ciphertext },
      encryptionKey,
      {
        iv: ivReal,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
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

  function mostrarDatos(datos) {
    document.getElementById("result-titulo").textContent =
      `Tarima ${datos.oar}`;
    document.getElementById("result-subtitulo").textContent =
      `Generado: ${datos.generado || "-"}`;
    document.getElementById("meta-oar").textContent = datos.oar;
    document.getElementById("meta-lote").textContent = datos.lote;
    document.getElementById("meta-total").textContent =
      (datos.movimientos || []).length;

    const tbody = document.getElementById("tabla-movimientos");
    tbody.innerHTML = "";

    (datos.movimientos || []).forEach(m => {
      const tr = document.createElement("tr");
      const claseTag = "tag-" + (m.movimiento || "").toLowerCase();

      const tdFecha = document.createElement("td");
      tdFecha.textContent = m.fecha || "";

      const tdMov = document.createElement("td");
      const span = document.createElement("span");
      span.className = claseTag;
      span.textContent = m.movimiento || "";
      tdMov.appendChild(span);

      const tdCant = document.createElement("td");
      tdCant.textContent = Number(m.cantidad || 0).toLocaleString("es-MX", {
        minimumFractionDigits: 2, maximumFractionDigits: 2
      });

      const tdUbic = document.createElement("td");
      tdUbic.textContent = m.ubicacion || "";

      tr.appendChild(tdFecha);
      tr.appendChild(tdMov);
      tr.appendChild(tdCant);
      tr.appendChild(tdUbic);
      tbody.appendChild(tr);
    });

    mostrarVista("view-result");
  }

  // ═══════════════════════════════════════════════════════════
  // ENVÍO A GOOGLE APPS SCRIPT
  // ═══════════════════════════════════════════════════════════

  async function enviarCorreo() {
    if (!datosActuales) return;

    const session = getSession();
    const statusEl = document.getElementById("send-status");
    const btn = document.getElementById("btn-send-email");

    statusEl.textContent = "Enviando reporte...";
    statusEl.className = "send-status";
    btn.disabled = true;

    // Reconstruimos el blob para enviar el mismo que estaba en el QR
    // Lo volvemos a cifrar para consistencia
    const blobNuevo = generarBlobParaEnvio(datosActuales);

    const payload = {
      usuario: session.user,
      nombre: session.nombre,
      rol: session.rol,
      codigo_oar: datosActuales.oar,
      lote: datosActuales.lote,
      blob_cifrado: blobNuevo,
      timestamp: new Date().toISOString()
    };

    try {
      const resp = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        mode: "no-cors",   // Apps Script no envía CORS, usamos no-cors
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });

      // Con no-cors no podemos leer la respuesta, asumimos éxito si no hay error de red
      statusEl.textContent = "✅ Reporte enviado a sensabit@gmail.com";
      statusEl.className = "send-status ok";
      btn.disabled = false;

    } catch (e) {
      statusEl.textContent = "❌ Error al enviar: " + e.message;
      statusEl.className = "send-status error";
      btn.disabled = false;
    }
  }

  // Re-genera el blob cifrado (para enviar por correo)
  function generarBlobParaEnvio(datos) {
    const jsonStr = JSON.stringify(datos);
    // Cifrar de nuevo con CryptoJS (versión simple, solo para el correo)
    const key = CryptoJS.PBKDF2(CONFIG.CLAVE_EMPRESA, CONFIG.SALT_PBKDF2, {
      keySize: 256 / 32,
      iterations: CONFIG.ITERACIONES,
      hasher: CryptoJS.algo.SHA256
    });
    const iv = CryptoJS.lib.WordArray.random(16);
    const encrypted = CryptoJS.AES.encrypt(jsonStr, key, {
      iv: iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7
    });
    // Empaquetamos IV + ciphertext en base64
    const combined = iv.clone().concat(encrypted.ciphertext);
    return CryptoJS.enc.Base64.stringify(combined);
  }

  // ═══════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════

  return {
    initLogin,
    initScanner
  };

})();
