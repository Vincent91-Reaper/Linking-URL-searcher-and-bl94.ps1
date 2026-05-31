// ==UserScript==
// @name RED Purchase Links v3.38.14-fast-deezer-nz-qt-first
// @match https://redacted.sh/requests.php?action=view&id=*
// @match https://tidal.com/*
// @match https://www.tidal.com/*
// @match https://listen.tidal.com/*
// @run-at document-start
// @grant GM.xmlHttpRequest
// @grant GM.setClipboard
// @grant GM.getValue
// @grant GM.setValue
// @grant GM_getValue
// @grant GM_setValue
// @connect api.deezer.com
// @connect www.deezer.com
// @connect www.qobuz.com
// @connect tidal.com
// @connect www.tidal.com
// @connect listen.tidal.com
// @connect www.beatport.com
// @connect api.beatport.com
// @connect 127.0.0.1
// @connect localhost
// ==/UserScript==

(() => {
  "use strict";

  const QOBUZ_LOCALE = "nz-en";
  const QOBUZ_APP_ID = "798273057";
  const QOBUZ_USER_AUTH_TOKEN = "vwknsXlsf3q91IW8rTDGCThLAuBT1I2SWo86QZV0xdQGUoqts8A9BJU8yH56QV0egR1WqqOodJPMvPE0LQdJ1w";

  const DEEZER_ARL = "67788498ca742886f1511880bc8819801ebfc7c65fd5884d5fa38f53be11bfa9c1f62a830b880d0444c80e1141f81cde7a939c6ca84a72dc562138a9127a600e6d8534bf1c5c60138ff49e2988384da88c834794716994b93a964833e6007ab5";

  const TIDAL_TOKEN_STORAGE_KEY = "red_tidal_access_token_v1";
  const TIDAL_CLIENT_VERSION = "2026.4.7";
  const TIDAL_COUNTRY = "NZ";
  const TIDAL_LOCALE = "en_US";
  const TIDAL_DEVICE = "BROWSER";
  const TIDAL_LIMIT = 10;
  const TIDAL_SEARCH_TYPES = "ALBUMS,EPS,SINGLES,COMPILATIONS";

  const BEATPORT_TOKEN_STORAGE_KEY = "red_beatport_anon_token_v1";
  const BEATPORT_TOKEN_EXPIRY_STORAGE_KEY = "red_beatport_anon_token_expiry_v1";
  const BEATPORT_TOKEN_EXPIRY_BUFFER_MS = 120000;
  const BEATPORT_DEFAULT_TOKEN_EXPIRY_SEC = 3600;
  const BEATPORT_SEARCH_PAGE_SIZE = 100;

  const YEAR_SUFFIX_RE = /\s*(?:\[((?:19|20)\d{2})\]|\(((?:19|20)\d{2})\))\s*$/;

  const titleNoYear = (t) => String(t || "").replace(YEAR_SUFFIX_RE, "").trim();
  const normalizeBearer = (t) => (/^Bearer\s+/i.test(String(t || "").trim()) ? String(t).trim() : `Bearer ${String(t || "").trim()}`);
  const stripBearer = (t) => String(t || "").trim().replace(/^Bearer\s+/i, "").trim();

  const DEBUG_RED_PURCHASE_LINKS = false;
  const DEBUG_TOP_CANDIDATES = 8;
  const BL94_BRIDGE_ENDPOINT = "http://127.0.0.1:17894/bridge-url";

  const PANEL_LEFT = "200px";
  const PANEL_TOP = "350px";
  const PANEL_WIDTH = "500px";
  const PANEL_GAP = 10;

  const dbg = (...args) => {
    if (!DEBUG_RED_PURCHASE_LINKS) return;
    console.log("[RED Purchase Links][debug]", ...args);
  };

  const dbgGroup = (label, fn) => {
    if (!DEBUG_RED_PURCHASE_LINKS) return fn?.();
    try {
      console.groupCollapsed(`[RED Purchase Links][debug] ${label}`);
      fn?.();
    } finally {
      console.groupEnd();
    }
  };

  const gmGet = (url, headers = {}) =>
    new Promise((resolve, reject) => {
      GM.xmlHttpRequest({ method: "GET", url, headers, onload: resolve, onerror: reject });
    });

  const gmPost = (url, headers = {}, data = "") =>
    new Promise((resolve, reject) => {
      GM.xmlHttpRequest({ method: "POST", url, headers, data, onload: resolve, onerror: reject });
    });

  const gmGetValue = async (k, d = "") => {
    try {
      if (typeof GM !== "undefined" && GM.getValue) return await GM.getValue(k, d);
    } catch {}
    try {
      if (typeof GM_getValue === "function") return GM_getValue(k, d);
    } catch {}
    return d;
  };

  const gmSetValue = async (k, v) => {
    try {
      if (typeof GM !== "undefined" && GM.setValue) return await GM.setValue(k, v);
    } catch {}
    try {
      if (typeof GM_setValue === "function") return GM_setValue(k, v);
    } catch {}
  };

  const IS_RED_REQUEST_PAGE =
    location.hostname === "redacted.sh" &&
    location.pathname === "/requests.php" &&
    new URL(location.href).searchParams.get("action") === "view";

  const IS_TIDAL_PAGE =
    location.hostname === "tidal.com" ||
    location.hostname === "www.tidal.com" ||
    location.hostname === "listen.tidal.com";

  const installTidalTokenCapture = () => {
    const saveToken = async (authorization) => {
      const raw = stripBearer(authorization || "");
      if (!raw || raw.length < 30) return;
      await gmSetValue(TIDAL_TOKEN_STORAGE_KEY, raw);
    };

    window.addEventListener("message", (event) => {
      if (!event.data || event.data.type !== "RED_PURCHASE_LINKS_TIDAL_AUTH") return;
      saveToken(event.data.authorization);
    });

    const inject = () => {
      const root = document.documentElement || document.head || document.body;
      if (!root) {
        setTimeout(inject, 25);
        return;
      }

      const injected = document.createElement("script");
      injected.textContent = `
        (() => {
          const postAuth = (authorization) => {
            if (!authorization) return;
            window.postMessage({
              type: "RED_PURCHASE_LINKS_TIDAL_AUTH",
              authorization
            }, "*");
          };

          const looksLikeTidalSearch = (url) => {
            const s = String(url || "");
            return /\\/v2\\/search\\//i.test(s) || /tidal\\.com\\/v2\\/search\\//i.test(s);
          };

          const getHeader = (headers, name) => {
            if (!headers) return "";
            const lower = String(name).toLowerCase();

            try {
              if (headers instanceof Headers) {
                return headers.get(name) || headers.get(lower) || "";
              }
            } catch {}

            try {
              if (Array.isArray(headers)) {
                const found = headers.find(([k]) => String(k).toLowerCase() === lower);
                return found ? found[1] : "";
              }
            } catch {}

            try {
              if (typeof headers === "object") {
                for (const k of Object.keys(headers)) {
                  if (String(k).toLowerCase() === lower) return headers[k];
                }
                return headers[name] || headers[lower] || headers.Authorization || headers.authorization || "";
              }
            } catch {}

            return "";
          };

          const inspectHeaders = (url, headers) => {
            try {
              if (!looksLikeTidalSearch(url)) return;
              postAuth(getHeader(headers, "authorization"));
            } catch {}
          };

          const OriginalRequest = window.Request;
          if (typeof OriginalRequest === "function") {
            const WrappedRequest = function(input, init) {
              try {
                const url = typeof input === "string" ? input : input && input.url;
                const headers = (init && init.headers) || (input && input.headers) || null;
                inspectHeaders(url, headers);
              } catch {}
              return new OriginalRequest(input, init);
            };

            try {
              WrappedRequest.prototype = OriginalRequest.prototype;
              Object.setPrototypeOf(WrappedRequest, OriginalRequest);
              window.Request = WrappedRequest;
            } catch {}
          }

          const originalFetch = window.fetch;
          if (typeof originalFetch === "function") {
            window.fetch = function(input, init) {
              try {
                const url = typeof input === "string" ? input : input && input.url;
                const headers = (init && init.headers) || (input && input.headers) || null;
                inspectHeaders(url, headers);
              } catch {}
              return originalFetch.apply(this, arguments);
            };
          }

          const originalOpen = XMLHttpRequest.prototype.open;
          const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
          const originalSend = XMLHttpRequest.prototype.send;

          XMLHttpRequest.prototype.open = function(method, url) {
            try {
              this.__redPurchaseLinksUrl = url;
              this.__redPurchaseLinksHeaders = {};
            } catch {}
            return originalOpen.apply(this, arguments);
          };

          XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            try {
              this.__redPurchaseLinksHeaders[String(name).toLowerCase()] = value;
            } catch {}
            return originalSetRequestHeader.apply(this, arguments);
          };

          XMLHttpRequest.prototype.send = function() {
            try {
              inspectHeaders(this.__redPurchaseLinksUrl, this.__redPurchaseLinksHeaders);
            } catch {}
            return originalSend.apply(this, arguments);
          };
        })();
      `;

      root.appendChild(injected);
      injected.remove();
    };

    inject();
  };

  if (IS_TIDAL_PAGE) {
    installTidalTokenCapture();
    return;
  }

  if (!IS_RED_REQUEST_PAGE) return;

  const brandStyleByLabel = (label) => {
    if (label === "Qobuz") return { color: "#4DA3FF", key: "qobuz" };
    if (label === "Tidal" || label === "Tidal(search)") return { color: "#FFFFFF", key: "tidal" };
    if (label === "Deezer" || label === "Deezer(NZ)") return { color: "#FF6B6B", key: "deezer" };
    if (label === "Beatport" || label === "Beatport(search)") return { color: "#94D500", key: "beatport" };
    return { color: "#ddd", key: "" };
  };

  const logoData = { qobuz: "", tidal: "", deezer: "", beatport: "" };

  const logoForLabel = (label) => {
    const s = brandStyleByLabel(label);
    return logoData[s.key] || "";
  };

  const noticePanel = (() => {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:fixed",
      `left:${PANEL_LEFT}`,
      "right:auto",
      `top:${PANEL_TOP}`,
      "transform:none",
      "z-index:999999",
      `width:${PANEL_WIDTH}`,
      "background:rgba(0,0,0,.95)",
      "color:#7CFC90",
      "font:18px/1.4 monospace",
      "font-weight:800",
      "padding:10px",
      "border:1px solid #666",
      "border-radius:8px",
      "word-break:break-word",
      "display:none"
    ].join(";");
    document.documentElement.appendChild(el);
    return el;
  })();

  const resultPanel = (() => {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:fixed",
      `left:${PANEL_LEFT}`,
      "right:auto",
      `top:${PANEL_TOP}`,
      "transform:none",
      "z-index:999998",
      `width:${PANEL_WIDTH}`,
      "max-height:72vh",
      "overflow:auto",
      "background:rgba(0,0,0,.92)",
      "color:#eee",
      "font:16px/1.55 monospace",
      "padding:10px",
      "border:1px solid #666",
      "border-radius:8px",
      "word-break:break-word",
      "display:none"
    ].join(";");
    document.documentElement.appendChild(el);
    return el;
  })();

  const setPanelsLayout = () => {
    noticePanel.style.left = PANEL_LEFT;
    noticePanel.style.right = "auto";
    noticePanel.style.top = PANEL_TOP;
    noticePanel.style.transform = "none";

    resultPanel.style.left = PANEL_LEFT;
    resultPanel.style.right = "auto";
    resultPanel.style.transform = "none";

    const rect = noticePanel.getBoundingClientRect();
    const top = noticePanel.style.display !== "none"
      ? Math.min(window.innerHeight - 16, rect.bottom + PANEL_GAP)
      : parseInt(PANEL_TOP, 10);

    resultPanel.style.top = `${top}px`;
  };

  window.addEventListener("resize", () => {
    if (noticePanel.style.display !== "none" && resultPanel.style.display !== "none") setPanelsLayout();
  });

  const showNotice = (html, color = "#7CFC90") => {
    noticePanel.style.display = "block";
    noticePanel.style.color = color;
    noticePanel.innerHTML = html;
    requestAnimationFrame(setPanelsLayout);
  };

  const esc = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const makeTidalSearchUrl = (artist, titleNoYearStr) =>
    `https://tidal.com/search?q=${encodeURIComponent(`${artist} - ${titleNoYearStr}`)}`;

  const beatportSearchUrl = (artist, titleNoYearStr) =>
    `https://www.beatport.com/search?q=${encodeURIComponent(`${artist} ${titleNoYearStr}`)}`;

  const notifyCopied = (serviceLabel, url) => {
    showNotice(
      `Copied ${esc(serviceLabel)} URL to clipboard<br><span style="font-size:14px;color:#ddd;font-weight:600;">${esc(url)}</span>`,
      "#7CFC90"
    );
    sendBridgeUrl(serviceLabel, url);
  };

  const sendBridgeUrl = (serviceLabel, url) => {
    if (!url) return;

    try {
      GM.xmlHttpRequest({
        method: "POST",
        url: BL94_BRIDGE_ENDPOINT,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({
          source: "RED Purchase Links first panel",
          serviceLabel,
          url
        }),
        timeout: 1500,
        onload: () => {},
        onerror: () => {},
        ontimeout: () => {}
      });
    } catch {}
  };

  const copyNow = (serviceLabel, url) => {
    if (!url) return false;

    try {
      GM.setClipboard(url, { type: "text/plain" });
      notifyCopied(serviceLabel, url);
      return true;
    } catch {
      showNotice("Failed to copy URL to clipboard", "#ff8a8a");
      return false;
    }
  };

  const ensureResultPanelVisible = () => {
    if (resultPanel.style.display === "none") {
      resultPanel.style.display = "block";
      resultPanel.style.left = PANEL_LEFT;
      resultPanel.style.right = "auto";
      resultPanel.style.transform = "none";

      if (noticePanel.style.display !== "none") {
        requestAnimationFrame(setPanelsLayout);
      } else {
        resultPanel.style.top = PANEL_TOP;
      }
    }
  };

  const DEFAULT_RENDER_STATE = {
    release: "",
    qobuz: "",
    tidal: "",
    tidalSearch: "",
    deezer: "",
    deezerLabel: "Deezer",
    beatport: "",
    beatportSearch: "",
    copied: "",
    serviceStatus: {}
  };

  let lastRenderState = { ...DEFAULT_RENDER_STATE };
  let onDemandLabelSearch = null;

  const renderResults = ({ release = "", qobuz = "", tidal = "", tidalSearch = "", deezer = "", deezerLabel = "Deezer", beatport = "", beatportSearch = "", copied = "", serviceStatus = {} }) => {
    lastRenderState = {
      release,
      qobuz,
      tidal,
      tidalSearch,
      deezer,
      deezerLabel,
      beatport,
      beatportSearch,
      copied,
      serviceStatus: { ...(serviceStatus || {}) }
    };

    const row = (label, url, serviceKey = "", statusText = "") => {
      const style = brandStyleByLabel(label);
      const logo = logoForLabel(label);
      const logoHtml = logo
        ? `<img src="${logo}" alt="${esc(label)}" style="width:20px;height:20px;vertical-align:-4px;margin-right:8px;border-radius:4px;" />`
        : "";
      const labelHtml = serviceKey
        ? `<a href="#" class="service-label" data-service="${esc(serviceKey)}" data-label="${esc(label)}" style="color:${style.color};font-weight:900;text-decoration:underline;cursor:pointer;">${esc(label)}</a>:`
        : `<span style="color:${style.color};font-weight:900;">${esc(label)}:</span>`;

      if (statusText) return `<div>${logoHtml}${labelHtml} <span style="color:#ffd36e;">${esc(statusText)}</span></div>`;
      if (!url) return `<div>${logoHtml}${labelHtml}</div>`;
      const u = esc(url);
      return `<div>${logoHtml}${labelHtml} <a href="${u}" class="copy-link" data-url="${u}" data-label="${esc(label)}" style="color:#8fd3ff;text-decoration:underline;cursor:pointer">${u}</a></div>`;
    };

    ensureResultPanelVisible();

    resultPanel.innerHTML = `
      <div style="margin-bottom:8px;"><b>Copied:</b> ${esc(copied || "(none)")}</div>
      <div style="margin-bottom:8px;"><b>Requested Release:</b> ${esc(release)}</div>
      ${row("Qobuz", qobuz, "qobuz", serviceStatus?.qobuz || "")}
      ${row("Tidal", tidal, "tidal", serviceStatus?.tidal || "")}
      ${(!tidal && tidalSearch) ? row("Tidal(search)", tidalSearch) : ""}
      ${row(deezerLabel, deezer, "deezer", serviceStatus?.deezer || "")}
      ${row("Beatport", beatport, "beatport", serviceStatus?.beatport || "")}
      ${(!beatport && beatportSearch) ? row("Beatport(search)", beatportSearch) : ""}
      <div style="margin-top:10px;color:#bbb;">Click service label: search service • Single-click URL: copy • Double-click URL: open</div>
    `;

    resultPanel.querySelectorAll(".service-label").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const service = a.getAttribute("data-service") || "";
        if (!service || !onDemandLabelSearch) return;
        onDemandLabelSearch(service);
      });
    });

    resultPanel.querySelectorAll(".copy-link").forEach((a) => {
      let clickTimer = null;

      a.addEventListener("click", (e) => {
        e.preventDefault();
        const url = a.getAttribute("data-url") || "";
        const label = a.getAttribute("data-label") || "URL";
        if (!url) return;

        clickTimer = setTimeout(() => {
          try {
            GM.setClipboard(url, { type: "text/plain" });
            notifyCopied(label, url);
            const copiedLine = resultPanel.querySelector("div:nth-child(1)");
            if (copiedLine) copiedLine.innerHTML = `<b>Copied:</b> ${esc(url)}`;
          } catch {
            showNotice("Failed to copy clicked URL", "#ff8a8a");
          }
          clickTimer = null;
        }, 220);
      });

      a.addEventListener("dblclick", (e) => {
        e.preventDefault();
        const url = a.getAttribute("data-url") || "";
        if (!url) return;
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
        window.open(url, "_blank", "noopener,noreferrer");
      });
    });
  };

  const decodeHTML = (orig) => {
    const txt = document.createElement("textarea");
    txt.innerHTML = orig ?? "";
    return txt.value;
  };

  const getRedArtistNames = (response) => {
    const artists = Array.isArray(response?.musicInfo?.artists)
      ? response.musicInfo.artists
      : [];

    return artists
      .map((a) => decodeHTML(a?.name || "").trim())
      .filter(Boolean);
  };

  const toArtistNames = (artistInput) => {
    if (Array.isArray(artistInput)) {
      return artistInput.map((x) => String(x || "").trim()).filter(Boolean);
    }

    const s = String(artistInput || "").trim();
    return s ? [s] : [];
  };

  const primaryArtistName = (artistInput) => toArtistNames(artistInput)[0] || "";

  const displayArtistName = (artistInput) => {
    const names = toArtistNames(artistInput);
    return names.length ? names.join(" & ") : "";
  };

  const redAPI = async (id) => {
    const r = await fetch(`${location.origin}/ajax.php?action=request&id=${id}`);
    return r.json();
  };

  const extractLinks = (html) => {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    const out = { qobuz: "", tidal: "", deezer: "", beatport: "" };

    for (const a of [...doc.querySelectorAll("a[href]")]) {
      const h = a.href || "";
      if (!out.qobuz && /qobuz\.com/i.test(h)) out.qobuz = h;
      else if (!out.tidal && /tidal\.com/i.test(h)) out.tidal = h;
      else if (!out.deezer && /deezer\.com/i.test(h)) out.deezer = h;
      else if (!out.beatport && /beatport\.com/i.test(h)) out.beatport = h;
    }

    return out;
  };

  const splitGenreLikeText = (value) =>
    String(value || "")
      .split(/[,/|;]+/g)
      .map((x) => String(x || "").trim())
      .filter(Boolean);

  const normalizeGenreForMatch = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const BEATPORT_GENRE_ALLOWLIST = [
    /\belectronic\b/,
    /\belectronica\b/,
    /\bedm\b/,
    /\bdance\b/,
    /\bhouse\b/,
    /\btechno\b/,
    /\btrance\b/,
    /\bdrum and bass\b/,
    /\bdnb\b/,
    /\bjungle\b/,
    /\bdubstep\b/,
    /\bbreaks?\b/,
    /\bgarage\b/,
    /\bbass\b/,
    /\belectro\b/,
    /\bdisco\b/,
    /\bhard dance\b/,
    /\bhardcore\b/,
    /\bprogressive house\b/,
    /\bdeep house\b/,
    /\btech house\b/,
    /\bminimal\b/,
    /\bmelodic house\b/,
    /\bmelodic techno\b/,
    /\bafro house\b/,
    /\bindie dance\b/,
    /\bnu disco\b/
  ];

  const extractRedGenres = (response) => {
    const genres = [];
    const seen = new Set();
    const MAX_DEPTH = 5;

    const pushGenre = (value) => {
      for (const token of splitGenreLikeText(value)) {
        const key = normalizeGenreForMatch(token);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        genres.push(token);
      }
    };

    const visit = (node, depth = 0) => {
      if (node == null || depth > MAX_DEPTH) return;
      if (typeof node === "string") return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (typeof node !== "object") return;

      for (const [key, value] of Object.entries(node)) {
        if (/genre|tag/i.test(key)) {
          if (typeof value === "string") {
            pushGenre(value);
          } else if (Array.isArray(value)) {
            for (const entry of value) {
              if (typeof entry === "string") pushGenre(entry);
              else if (entry && typeof entry === "object") {
                pushGenre(entry?.name || entry?.tag || entry?.title || entry?.value || "");
                visit(entry, depth + 1);
              }
            }
          } else if (value && typeof value === "object") {
            pushGenre(value?.name || value?.tag || value?.title || value?.value || "");
            visit(value, depth + 1);
          }
        } else {
          visit(value, depth + 1);
        }
      }
    };

    visit(response);

    const desc = String(response?.description || "");
    if (desc) {
      const doc = new DOMParser().parseFromString(desc, "text/html");
      for (const a of [...doc.querySelectorAll("a")]) {
        const href = String(a.getAttribute("href") || "");
        if (!/tag|genre/i.test(href)) continue;
        pushGenre(a.textContent || "");
      }
    }

    return genres;
  };

  const isBeatportRelevantByGenres = (genres) => {
    const normalized = (genres || []).map((g) => normalizeGenreForMatch(g)).filter(Boolean);
    return normalized.some((genre) => BEATPORT_GENRE_ALLOWLIST.some((re) => re.test(genre)));
  };

  const buildRequestInfo = (response) => {
    const releaseTypeNumber = Number(response?.releaseType);
    const releaseName = String(response?.releaseName || "").trim();
    const releaseNameLower = releaseName.toLowerCase();

    const isSingle =
      releaseTypeNumber === 9 ||
      releaseNameLower === "single";

    const isAlbum =
      releaseTypeNumber === 1 ||
      releaseNameLower === "album";

    const isEP =
      releaseTypeNumber === 5 ||
      releaseNameLower === "ep";

    const isCompilation =
      releaseTypeNumber === 7 ||
      releaseNameLower === "compilation";

    const bitrateList = Array.isArray(response?.bitrateList) ? response.bitrateList : [];
    const mediaList = Array.isArray(response?.mediaList) ? response.mediaList : [];

    const is24BitOnly =
      bitrateList.length === 1 &&
      String(bitrateList[0] || "").toLowerCase() === "24bit lossless";

    const redGenres = extractRedGenres(response);
    const isBeatportRelevant = isBeatportRelevantByGenres(redGenres);

    return {
      releaseTypeNumber,
      releaseName,
      releaseNameLower,
      isSingle,
      isAlbum,
      isEP,
      isCompilation,
      bitrateList,
      mediaList,
      is24BitOnly,
      redGenres,
      isBeatportRelevant
    };
  };

  const streamingArtistNamesForRequest = (artistNames, requestInfo) => {
    if (requestInfo?.isCompilation) return ["Various Artists"];
    return artistNames;
  };

  const normalizeApostrophes = (s) => String(s || "").replace(/[’`´]/g, "'");

  const normalizeForMatch = (s) =>
    normalizeApostrophes(String(s || ""))
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}']+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const normalizeArtistForMatch = (s) =>
    normalizeApostrophes(String(s || ""))
      .replace(/&/g, " and ")
      .replace(/\+/g, " and ")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}']+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const normalizeArtistConnectorless = (s) =>
    normalizeArtistForMatch(s)
      .replace(/\band\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const parentheticalArtistAliases = (name) => {
    const raw = String(name || "").trim();
    if (!raw) return [];

    const m = raw.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
    if (!m) return [raw];

    const outside = String(m[1] || "").trim();
    const inside = String(m[2] || "").trim();

    return Array.from(new Set([outside, inside, raw].map((s) => String(s || "").trim()).filter(Boolean)));
  };

  const artistSearchAliases = (name) => {
    const rawAliases = parentheticalArtistAliases(name);
    const out = [];

    for (const alias of rawAliases) {
      out.push(alias);
      out.push(alias.replace(/\s*&\s*/g, " And "));
      out.push(alias.replace(/\s+and\s+/gi, " & "));
      out.push(alias.replace(/[&+]/g, " ").replace(/\s+/g, " ").trim());
    }

    return Array.from(new Set(out.map((s) => String(s || "").trim()).filter(Boolean)));
  };

  const artistMatchAliases = (name) => artistSearchAliases(name);

  const primaryArtistSearchAlias = (artistInput) => {
    const primary = primaryArtistName(artistInput);
    return artistSearchAliases(primary)[0] || primary;
  };

  const combinedArtistSearchAlias = (artistInput) => {
    const names = toArtistNames(artistInput);
    if (!names.length) return "";

    return names
      .map((name) => artistSearchAliases(name)[0] || name)
      .join(" ");
  };

  const parseYearFromTitle = (title) => {
    const m = String(title || "").match(YEAR_SUFFIX_RE);
    return m ? Number(m[1] || m[2]) : null;
  };

  const stripYearSuffix = (title) => titleNoYear(title);

  const splitVersionedTitle = (title) => {
    const clean = stripYearSuffix(title);
    const m = clean.match(/^(.+?)\s*\(([^()]+)\)\s*$/);

    if (!m) {
      return {
        fullTitle: clean,
        baseTitle: clean,
        versionText: ""
      };
    }

    return {
      fullTitle: clean,
      baseTitle: String(m[1] || "").trim(),
      versionText: String(m[2] || "").trim()
    };
  };

  const titleScoreInfo = (candidateTitleRaw, requestedTitleRaw) => {
    const titleInfo = splitVersionedTitle(requestedTitleRaw);

    const candidate = normalizeForMatch(candidateTitleRaw);
    const full = normalizeForMatch(titleInfo.fullTitle);
    const base = normalizeForMatch(titleInfo.baseTitle);
    const version = normalizeForMatch(titleInfo.versionText);

    let score = 0;
    let exactTitle = false;
    let titleKind = "none";

    if (candidate && full && candidate === full) {
      score += 80;
      exactTitle = true;
      titleKind = "exact";
    } else if (candidate && base && base !== full && candidate === base) {
      score += 62;
      titleKind = "base-exact";
    } else if (candidate && full && full.length >= 8 && candidate.includes(full)) {
      score += 50;
      titleKind = "full-loose";
    } else if (candidate && base && base.length >= 6 && candidate.includes(base)) {
      score += 42;
      titleKind = "base-loose";
    }

    if (version && candidate.includes(version)) {
      score += 20;
    }

    return { score, exactTitle, titleKind };
  };

  const SINGLE_BAD_RELEASE_TERMS = [
    "remix",
    "remixes",
    "remixed",
    "remixpack",
    "remix pack"
  ];

  const normalizedHasTerm = (text, term) => {
    const n = ` ${normalizeForMatch(text)} `;
    const t = normalizeForMatch(term);
    if (!n.trim() || !t) return false;
    if (t.includes(" ")) return n.includes(` ${t} `);
    return new RegExp(`\\s${t}\\s`).test(n);
  };

  const hasSingleBadReleaseTerm = (title) =>
    SINGLE_BAD_RELEASE_TERMS.some((term) => normalizedHasTerm(title, term));

  const hasSingleRequestedReleaseTerm = (title) =>
    SINGLE_BAD_RELEASE_TERMS.some((term) => normalizedHasTerm(title, term));

  const hasSingleOnlyBadReleaseTypeTitle = (candidateTitle, requestedTitle, requestInfo) => {
    if (!requestInfo?.isSingle) return false;

    const candidateHasBadTerm = hasSingleBadReleaseTerm(candidateTitle);
    if (!candidateHasBadTerm) return false;

    const requestAllowsBadTerm = hasSingleRequestedReleaseTerm(requestedTitle);
    return !requestAllowsBadTerm;
  };

  const variantTerms = ["deluxe", "remaster", "remastered", "live", "instrumental", "karaoke"];

  const variantTermsIn = (title) => {
    const t = normalizeForMatch(title);
    return variantTerms.filter((term) => new RegExp(`\\b${term}\\b`).test(t));
  };

  const hasUnrequestedBadVariant = (candidateTitle, requestedTitle) => {
    const candidateTerms = variantTermsIn(candidateTitle);
    if (!candidateTerms.length) return false;

    const requestedTerms = new Set(variantTermsIn(requestedTitle));
    return candidateTerms.some((term) => !requestedTerms.has(term));
  };

  const artistNameMatches = (candidateRaw, requestedRaw, strictCompound = false) => {
    const candidateAliases = artistMatchAliases(candidateRaw);
    const requestedAliases = artistMatchAliases(requestedRaw);

    for (const candidateAlias of candidateAliases) {
      for (const requestedAlias of requestedAliases) {
        const candidate = normalizeArtistForMatch(candidateAlias);
        const requested = normalizeArtistForMatch(requestedAlias);

        const candidateNoConnector = normalizeArtistConnectorless(candidateAlias);
        const requestedNoConnector = normalizeArtistConnectorless(requestedAlias);

        if (!candidate || !requested) continue;
        if (candidate === requested) return true;
        if (candidateNoConnector && candidateNoConnector === requestedNoConnector) return true;

        if (strictCompound) {
          if (candidate.includes(requested) || candidateNoConnector.includes(requestedNoConnector)) return true;
          continue;
        }

        if (
          candidate.includes(requested) ||
          requested.includes(candidate) ||
          candidateNoConnector.includes(requestedNoConnector) ||
          requestedNoConnector.includes(candidateNoConnector)
        ) {
          return true;
        }
      }
    }

    return false;
  };

  const strictArtistCloseMatch = (candidateRaw, requestedRaw) => {
    const candidateAliases = artistMatchAliases(candidateRaw);
    const requestedAliases = artistMatchAliases(requestedRaw);

    for (const candidateAlias of candidateAliases) {
      for (const requestedAlias of requestedAliases) {
        const candidate = normalizeArtistForMatch(candidateAlias);
        const requested = normalizeArtistForMatch(requestedAlias);

        const candidateNoConnector = normalizeArtistConnectorless(candidateAlias);
        const requestedNoConnector = normalizeArtistConnectorless(requestedAlias);

        if (!candidate || !requested) continue;
        if (candidate === requested) return true;
        if (candidateNoConnector && candidateNoConnector === requestedNoConnector) return true;
      }
    }

    return false;
  };

  const extractYearFromTidalAlbum = (album) => {
    const raw = String(album?.releaseDate || album?.release_date || "");
    const m = raw.match(/(19|20)\d{2}/);
    return m ? Number(m[0]) : null;
  };

  const unwrapTidalItem = (x) => x?.item || x?.data || x;

  const collectTidalSearchItems = (j, keys) => {
    const out = [];

    for (const key of keys) {
      const lower = key.toLowerCase();
      const upper = key.toUpperCase();

      const buckets = [
        j?.[lower]?.items,
        j?.[upper]?.items,
        j?.[key]?.items
      ];

      for (const bucket of buckets) {
        if (!Array.isArray(bucket)) continue;
        for (const entry of bucket) {
          const item = unwrapTidalItem(entry);
          if (item) out.push(item);
        }
      }
    }

    return out;
  };

  const tidalArtistNames = (obj) => {
    const names = [];

    if (Array.isArray(obj?.artists)) {
      for (const a of obj.artists) {
        if (a?.name) names.push(a.name);
      }
    }

    if (obj?.artist?.name) names.push(obj.artist.name);

    return names;
  };

  const tidalArtistMatchInfo = (albumOrTrack, requestedArtistInput) => {
    const requestedArtists = toArtistNames(requestedArtistInput);
    const candidateArtists = tidalArtistNames(albumOrTrack);

    if (!requestedArtists.length || !candidateArtists.length) {
      return { any: false, all: false, score: 0 };
    }

    const isSingleCompoundArtist =
      requestedArtists.length === 1 &&
      /[&+,/]/.test(requestedArtists[0]);

    const matchedCount = requestedArtists.filter((requested) =>
      candidateArtists.some((candidate) =>
        artistNameMatches(candidate, requested, isSingleCompoundArtist)
      )
    ).length;

    const any = matchedCount > 0;
    const all = matchedCount === requestedArtists.length;

    return {
      any,
      all,
      score: all ? 45 : any ? 25 : 0
    };
  };

  const tidalStrictArtistCloseInfo = (albumOrTrack, requestedArtistInput) => {
    const requestedArtists = toArtistNames(requestedArtistInput);
    const candidateArtists = tidalArtistNames(albumOrTrack);

    if (!requestedArtists.length || !candidateArtists.length) {
      return { any: false, all: false };
    }

    const matchedCount = requestedArtists.filter((requested) =>
      candidateArtists.some((candidate) =>
        strictArtistCloseMatch(candidate, requested)
      )
    ).length;

    return {
      any: matchedCount > 0,
      all: matchedCount === requestedArtists.length
    };
  };

  const qobuzAlbumArtistName = (album) =>
    album?.artist?.name ||
    album?.artists?.[0]?.name ||
    "";

  const qobuzAlbumTitle = (album) =>
    album?.title ||
    album?.name ||
    "";

  const makeQobuzAlbumUrl = (album) => {
    const id = album?.id;
    const slug = album?.slug;
    const locale = String(QOBUZ_LOCALE || "us-en").toLowerCase();

    if (id && slug) return `https://www.qobuz.com/${locale}/album/${slug}/${id}`;
    if (id) return `https://www.qobuz.com/${locale}/album/${id}`;

    return "";
  };

  const buildFastQueryVariants = (artistInput, cleanTitle) => {
    const names = toArtistNames(artistInput);
    const titleInfo = splitVersionedTitle(cleanTitle);

    const titleForms = Array.from(new Set([
      titleInfo.fullTitle,
      titleInfo.baseTitle
    ].map((s) => String(s || "").trim()).filter(Boolean)));

    const primary = primaryArtistName(names);
    const combinedSpace = names
      .map((name) => artistSearchAliases(name)[0] || name)
      .join(" ")
      .trim();

    const combinedAmp = names
      .map((name) => artistSearchAliases(name)[0] || name)
      .join(" & ")
      .trim();

    const artistForms = Array.from(new Set([
      combinedAmp,
      combinedSpace,
      primary,
      ...names.flatMap((name) => artistSearchAliases(name))
    ].map((s) => String(s || "").trim()).filter(Boolean)));

    const variants = [];

    for (const artistForm of artistForms.slice(0, 5)) {
      for (const titleForm of titleForms) {
        variants.push(`${artistForm} - ${titleForm}`);
        variants.push(`${artistForm} ${titleForm}`);
      }
    }

    for (const titleForm of titleForms) {
      variants.push(titleForm);
    }

    return Array.from(new Set(
      variants.map((s) => String(s || "").trim()).filter(Boolean)
    )).slice(0, 12);
  };

  const buildQobuzQueryVariants = (artistInput, cleanTitle) =>
    buildFastQueryVariants(artistInput, cleanTitle);

  const buildQueryVariants = (artistInput, cleanTitle) =>
    buildFastQueryVariants(artistInput, cleanTitle);

  const scoreQobuzAlbumCandidate = (album, reqArtistInput, reqTitleRaw, requestInfo) => {
    const albumTitleRaw = qobuzAlbumTitle(album);
    const albumArtistRaw = qobuzAlbumArtistName(album);

    const titleInfo = titleScoreInfo(albumTitleRaw, reqTitleRaw);

    const requestedArtists = toArtistNames(reqArtistInput);
    const isSingleCompoundArtist =
      requestedArtists.length === 1 &&
      /[&+,/]/.test(requestedArtists[0]);

    const matchedCount = requestedArtists.filter((requested) =>
      artistNameMatches(albumArtistRaw, requested, isSingleCompoundArtist)
    ).length;

    const strictMatchedCount = requestedArtists.filter((requested) =>
      strictArtistCloseMatch(albumArtistRaw, requested)
    ).length;

    const exactArtist =
      requestedArtists.length > 0 &&
      matchedCount === requestedArtists.length;

    const anyArtist = matchedCount > 0;

    const strictAnyArtist = strictMatchedCount > 0;
    const strictExactArtist =
      requestedArtists.length > 0 &&
      strictMatchedCount === requestedArtists.length;

    const badSingleReleaseType = hasSingleOnlyBadReleaseTypeTitle(
      albumTitleRaw,
      reqTitleRaw,
      requestInfo
    );

    let score = titleInfo.score;

    if (exactArtist) score += 45;
    else if (anyArtist) score += 25;

    if (hasUnrequestedBadVariant(albumTitleRaw, reqTitleRaw)) score -= 15;
    if (badSingleReleaseType) score -= 1000;

    return {
      score,
      exactTitle: titleInfo.exactTitle,
      titleKind: titleInfo.titleKind,
      exactArtist,
      anyArtist,
      strictAnyArtist,
      strictExactArtist,
      badSingleReleaseType,
      albumId: String(album?.id || ""),
      url: makeQobuzAlbumUrl(album),
      raw: album
    };
  };

  const scoreTidalAlbumCandidate = (album, reqArtistInput, reqTitleRaw, reqYear, requestInfo) => {
    const albumTitleRaw = album?.title || album?.name || "";
    const albumYear = extractYearFromTidalAlbum(album);

    const titleInfo = titleScoreInfo(albumTitleRaw, reqTitleRaw);
    const artistInfo = tidalArtistMatchInfo(album, reqArtistInput);
    const strictArtistInfo = tidalStrictArtistCloseInfo(album, reqArtistInput);

    const badSingleReleaseType = hasSingleOnlyBadReleaseTypeTitle(
      albumTitleRaw,
      reqTitleRaw,
      requestInfo
    );

    let score = titleInfo.score + artistInfo.score;

    if (reqYear && albumYear) {
      score += albumYear === reqYear ? 20 : -10;
    }

    if (hasUnrequestedBadVariant(albumTitleRaw, reqTitleRaw)) score -= 15;
    if (badSingleReleaseType) score -= 1000;

    return {
      score,
      exactTitle: titleInfo.exactTitle,
      titleKind: titleInfo.titleKind,
      exactArtist: artistInfo.all,
      anyArtist: artistInfo.any,
      strictAnyArtist: strictArtistInfo.any,
      strictExactArtist: strictArtistInfo.all,
      badSingleReleaseType,
      albumId: String(album?.id || ""),
      raw: album
    };
  };

  const qobuzSearch = async (artistInput, title, requestInfo) => {
    const cleanTitle = stripYearSuffix(title);
    const queryVariants = buildQobuzQueryVariants(artistInput, cleanTitle);

    const headers = {
      accept: "application/json",
      "x-app-id": QOBUZ_APP_ID,
      "x-user-auth-token": QOBUZ_USER_AUTH_TOKEN
    };

    const allCandidates = [];

    for (const query of queryVariants) {
      const url = `https://www.qobuz.com/api.json/0.2/search/getResults?${new URLSearchParams({
        query,
        type: "albums",
        limit: "10",
        offset: "0"
      })}`;

      const r = await gmGet(url, headers);
      if (r.status !== 200) continue;

      let j = {};
      try {
        j = JSON.parse(r.responseText || "{}");
      } catch {
        continue;
      }

      const items = Array.isArray(j?.albums?.items) ? j.albums.items : [];

      for (const album of items) {
        const scored = scoreQobuzAlbumCandidate(album, artistInput, title, requestInfo);
        if (scored.url) allCandidates.push(scored);
      }

      const exactNow = allCandidates
        .filter((c) => c.exactTitle && c.exactArtist && c.url && !c.badSingleReleaseType)
        .sort((a, b) => b.score - a.score)[0];

      if (exactNow) return exactNow.url;
    }

    if (!allCandidates.length) return "";

    const seen = new Set();
    const deduped = allCandidates
      .filter((c) => {
        const key = c.albumId || c.url;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.score - a.score);

    const exact = deduped.find((c) =>
      c.exactTitle &&
      c.exactArtist &&
      c.url &&
      !c.badSingleReleaseType
    );
    if (exact) return exact.url;

    const close = deduped.find((c) =>
      c.url &&
      !c.badSingleReleaseType &&
      c.score >= 60 &&
      c.titleKind !== "none" &&
      (c.strictExactArtist || c.strictAnyArtist || c.exactArtist)
    );

    if (close) return close.url;

    return "";
  };

  const getToken = async () => normalizeBearer(await gmGetValue(TIDAL_TOKEN_STORAGE_KEY, ""));

  const promptToken = async () => {
    const v = prompt("Paste TIDAL access token:");
    const c = stripBearer(v || "");
    if (c) await gmSetValue(TIDAL_TOKEN_STORAGE_KEY, c);
    return c ? normalizeBearer(c) : "";
  };

  const waitForCapturedTidalToken = async (oldAuth, timeoutMs = 120000) => {
    const oldRaw = stripBearer(oldAuth || "");
    const started = Date.now();

    try {
      window.open("https://tidal.com/search?q=da", "_blank", "noopener,noreferrer");
    } catch {}

    showNotice(
      `Tidal token expired.<br>` +
      `A Tidal search tab was opened.<br>` +
      `If you are logged into Tidal, wait for the search page to load or search anything there.<br>` +
      `This script will try to capture the new token automatically.`,
      "#ffd36e"
    );

    while (Date.now() - started < timeoutMs) {
      const currentRaw = stripBearer(await gmGetValue(TIDAL_TOKEN_STORAGE_KEY, ""));
      if (currentRaw && currentRaw !== oldRaw) {
        showNotice("Captured new Tidal token automatically. Retrying search...", "#7CFC90");
        return normalizeBearer(currentRaw);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return "";
  };

  let tidalTokenRefreshPromise = null;

  const getRenewedTidalAuth = async (oldAuth) => {
    if (!tidalTokenRefreshPromise) {
      tidalTokenRefreshPromise = (async () => {
        let newAuth = await waitForCapturedTidalToken(oldAuth);
        if (!newAuth) newAuth = await promptToken();
        return newAuth;
      })().finally(() => {
        tidalTokenRefreshPromise = null;
      });
    }

    return tidalTokenRefreshPromise;
  };

  const tidalGetWithRetry = async (url, auth) => {
    const headers = {
      accept: "application/json",
      authorization: auth,
      "x-tidal-client-version": TIDAL_CLIENT_VERSION
    };

    let r = await gmGet(url, headers);

    if (r.status === 401 || r.status === 403) {
      const newAuth = await getRenewedTidalAuth(auth);
      if (!newAuth) return { response: r, auth };

      r = await gmGet(url, {
        ...headers,
        authorization: newAuth
      });

      return { response: r, auth: newAuth };
    }

    return { response: r, auth };
  };

  const tidalReleaseSearch = async (artistInput, titleWithMaybeYear, auth, requestInfo) => {
    const reqYear = parseYearFromTitle(titleWithMaybeYear);
    const cleanTitle = stripYearSuffix(titleWithMaybeYear);
    const queryVariants = buildQueryVariants(artistInput, cleanTitle);

    const allCandidates = [];

    for (const query of queryVariants) {
      const api = `https://tidal.com/v2/search/?${new URLSearchParams({
        query,
        limit: String(TIDAL_LIMIT),
        types: TIDAL_SEARCH_TYPES,
        countryCode: TIDAL_COUNTRY,
        locale: TIDAL_LOCALE,
        deviceType: TIDAL_DEVICE
      })}`;

      const tidalRes = await tidalGetWithRetry(api, auth);
      auth = tidalRes.auth;

      let j = {};
      try {
        j = JSON.parse(tidalRes.response.responseText || "{}");
      } catch {}

      const items = collectTidalSearchItems(j, [
        "albums",
        "eps",
        "singles",
        "compilations"
      ]);

      for (const album of items) {
        const scored = scoreTidalAlbumCandidate(album, artistInput, titleWithMaybeYear, reqYear, requestInfo);
        if (scored.albumId) allCandidates.push({ ...scored, raw: album });
      }

      const exactNow = allCandidates
        .filter((c) => c.exactTitle && c.exactArtist && c.albumId && !c.badSingleReleaseType)
        .sort((a, b) => b.score - a.score)[0];

      if (exactNow) {
        return {
          exact: `https://tidal.com/album/${exactNow.albumId}`,
          close: "",
          auth
        };
      }
    }

    if (!allCandidates.length) return { exact: "", close: "", auth };

    const seen = new Set();
    const deduped = allCandidates
      .filter((c) => {
        const key = c.albumId;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.score - a.score);

    const exact = deduped.find((c) =>
      c.exactTitle &&
      c.exactArtist &&
      c.albumId &&
      !c.badSingleReleaseType
    );

    if (exact) {
      return {
        exact: `https://tidal.com/album/${exact.albumId}`,
        close: "",
        auth
      };
    }

    const close = deduped.find((c) =>
      c.albumId &&
      !c.badSingleReleaseType &&
      c.score >= 60 &&
      c.titleKind !== "none" &&
      (c.strictExactArtist || c.strictAnyArtist || c.exactArtist)
    );

    if (close) {
      return {
        exact: "",
        close: `https://tidal.com/album/${close.albumId}`,
        auth
      };
    }

    return { exact: "", close: "", auth };
  };

  const tidalTrackSearch = async (artistInput, titleWithMaybeYear, auth, requestInfo) => {
    const cleanTitle = stripYearSuffix(titleWithMaybeYear);
    const queryVariants = buildQueryVariants(artistInput, cleanTitle);

    const reqTitleNorm = normalizeForMatch(cleanTitle);
    const seenTrackIds = new Set();

    for (const query of queryVariants) {
      const api = `https://tidal.com/v2/search/?${new URLSearchParams({
        query,
        limit: String(TIDAL_LIMIT),
        types: "TRACKS",
        countryCode: TIDAL_COUNTRY,
        locale: TIDAL_LOCALE,
        deviceType: TIDAL_DEVICE
      })}`;

      const tidalRes = await tidalGetWithRetry(api, auth);
      auth = tidalRes.auth;

      let j = {};
      try {
        j = JSON.parse(tidalRes.response.responseText || "{}");
      } catch {}

      const tracks = collectTidalSearchItems(j, ["tracks"]);

      for (const track of tracks) {
        const trackId = String(track?.id || "");
        if (!trackId || seenTrackIds.has(trackId)) continue;
        seenTrackIds.add(trackId);

        const trackTitleNorm = normalizeForMatch(track?.title || "");
        const albumId = String(track?.album?.id || "");
        const albumTitleRaw = track?.album?.title || "";

        const badSingleReleaseType = hasSingleOnlyBadReleaseTypeTitle(
          albumTitleRaw,
          titleWithMaybeYear,
          requestInfo
        );

        const trackArtistInfo = tidalArtistMatchInfo(track, artistInput);
        const albumArtistInfo = tidalArtistMatchInfo(track?.album || {}, artistInput);

        const titleMatches = trackTitleNorm === reqTitleNorm;
        const artistMatches = trackArtistInfo.any || albumArtistInfo.any;

        if (titleMatches && artistMatches && albumId && !badSingleReleaseType) {
          return { exact: `https://tidal.com/album/${albumId}`, auth };
        }
      }
    }

    return { exact: "", auth };
  };

  const tidalSearch = async (artistInput, titleWithMaybeYear, requestInfo) => {
    const cleanTitle = stripYearSuffix(titleWithMaybeYear);
    const searchArtist = combinedArtistSearchAlias(artistInput) || primaryArtistSearchAlias(artistInput);
    const searchUrl = makeTidalSearchUrl(searchArtist, cleanTitle);

    let auth = await getToken();
    if (!auth) auth = await promptToken();
    if (!auth) return { exact: "", search: searchUrl };

    const releaseRes = await tidalReleaseSearch(artistInput, titleWithMaybeYear, auth, requestInfo).catch(() => {
      return { exact: "", close: "", auth };
    });

    auth = releaseRes.auth || auth;

    if (releaseRes.exact) {
      return { exact: releaseRes.exact, search: "" };
    }

    const trackRes = await tidalTrackSearch(artistInput, titleWithMaybeYear, auth, requestInfo).catch(() => {
      return { exact: "", auth };
    });

    if (trackRes.exact) {
      return { exact: trackRes.exact, search: "" };
    }

    if (releaseRes.close) {
      return { exact: releaseRes.close, search: "" };
    }

    return { exact: "", search: searchUrl };
  };

  const beatportReleaseUrl = (id) => id ? `https://www.beatport.com/release/-/${id}` : "";

  const getBeatportAnonToken = async (forceRefresh = false) => {
    if (!forceRefresh) {
      const storedToken = String(await gmGetValue(BEATPORT_TOKEN_STORAGE_KEY, "") || "").trim();
      const storedExpiry = Number(await gmGetValue(BEATPORT_TOKEN_EXPIRY_STORAGE_KEY, 0) || 0);
      if (storedToken && Date.now() < storedExpiry - BEATPORT_TOKEN_EXPIRY_BUFFER_MS) {
        return normalizeBearer(storedToken);
      }
    }

    const response = await gmPost(
      "https://www.beatport.com/api/auth/refresh-anon-token",
      {
        accept: "application/json",
        "content-type": "application/json"
      },
      "{}"
    );

    if (response.status !== 200) return "";

    let payload = {};
    try {
      payload = JSON.parse(response.responseText || "{}");
    } catch {
      return "";
    }

    const tokenRaw = String(
      payload?.access_token ||
      payload?.token ||
      payload?.data?.access_token ||
      payload?.data?.token ||
      ""
    ).trim();

    if (!tokenRaw) return "";

    const expiresInSec = Number(
      payload?.expires_in ||
      payload?.data?.expires_in ||
      payload?.expires ||
      payload?.data?.expires ||
      BEATPORT_DEFAULT_TOKEN_EXPIRY_SEC
    );

    const expiry = Date.now() + (Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1000 : BEATPORT_DEFAULT_TOKEN_EXPIRY_SEC * 1000);
    await gmSetValue(BEATPORT_TOKEN_STORAGE_KEY, stripBearer(tokenRaw));
    await gmSetValue(BEATPORT_TOKEN_EXPIRY_STORAGE_KEY, expiry);
    return normalizeBearer(tokenRaw);
  };

  const beatportArtistNameFromRelease = (release) => {
    const artists = Array.isArray(release?.artists) ? release.artists : [];
    const names = artists
      .map((a) => String(a?.name || a?.artist_name || "").trim())
      .filter(Boolean);
    if (names.length) return names.join(" & ");
    return String(release?.artist?.name || release?.artist_name || "").trim();
  };

  const extractYearFromBeatportRelease = (release) => {
    const dateText = String(
      release?.release_date ||
      release?.new_release_date ||
      release?.publish_date ||
      release?.published ||
      ""
    );
    const m = dateText.match(/\b((?:19|20)\d{2})\b/);
    return m ? Number(m[1]) : null;
  };

  const scoreBeatportReleaseCandidate = (release, reqArtistInput, reqTitleRaw, reqYear, requestInfo) => {
    const releaseTitleRaw = String(release?.name || release?.title || "").trim();
    const releaseArtistRaw = beatportArtistNameFromRelease(release);
    const releaseYear = extractYearFromBeatportRelease(release);

    const titleInfo = titleScoreInfo(releaseTitleRaw, reqTitleRaw);

    const requestedArtists = toArtistNames(reqArtistInput);
    const isSingleCompoundArtist =
      requestedArtists.length === 1 &&
      /[&+,/]/.test(requestedArtists[0]);

    const matchedCount = requestedArtists.filter((requested) =>
      artistNameMatches(releaseArtistRaw, requested, isSingleCompoundArtist)
    ).length;

    const strictMatchedCount = requestedArtists.filter((requested) =>
      strictArtistCloseMatch(releaseArtistRaw, requested)
    ).length;

    const exactArtist =
      requestedArtists.length > 0 &&
      matchedCount === requestedArtists.length;

    const anyArtist = matchedCount > 0;
    const strictAnyArtist = strictMatchedCount > 0;
    const strictExactArtist =
      requestedArtists.length > 0 &&
      strictMatchedCount === requestedArtists.length;

    const badSingleReleaseType = hasSingleOnlyBadReleaseTypeTitle(
      releaseTitleRaw,
      reqTitleRaw,
      requestInfo
    );

    let score = titleInfo.score;
    if (exactArtist) score += 45;
    else if (anyArtist) score += 25;

    if (reqYear && releaseYear) {
      score += releaseYear === reqYear ? 20 : -10;
    }

    if (hasUnrequestedBadVariant(releaseTitleRaw, reqTitleRaw)) score -= 15;
    if (badSingleReleaseType) score -= 1000;

    return {
      score,
      exactTitle: titleInfo.exactTitle,
      titleKind: titleInfo.titleKind,
      exactArtist,
      anyArtist,
      strictAnyArtist,
      strictExactArtist,
      badSingleReleaseType,
      albumId: String(release?.id || ""),
      url: beatportReleaseUrl(release?.id),
      raw: release
    };
  };

  const beatportSearch = async (artistInput, titleWithMaybeYear, requestInfo) => {
    const reqYear = parseYearFromTitle(titleWithMaybeYear);
    const cleanTitle = stripYearSuffix(titleWithMaybeYear);
    const queryVariants = buildQueryVariants(artistInput, cleanTitle);

    let auth = await getBeatportAnonToken(false);
    if (!auth) auth = await getBeatportAnonToken(true);
    if (!auth) return "";

    const allCandidates = [];

    for (const query of queryVariants) {
      const url = `https://api.beatport.com/v4/catalog/search/?${new URLSearchParams({
        q: query,
        type: "releases",
        per_page: String(BEATPORT_SEARCH_PAGE_SIZE)
      })}`;

      let r = await gmGet(url, {
        accept: "application/json",
        authorization: auth
      });

      if (r.status === 401 || r.status === 403) {
        auth = await getBeatportAnonToken(true);
        if (!auth) continue;
        r = await gmGet(url, {
          accept: "application/json",
          authorization: auth
        });
      }

      if (r.status !== 200) continue;

      let j = {};
      try {
        j = JSON.parse(r.responseText || "{}");
      } catch {
        continue;
      }

      const releases = Array.isArray(j?.results)
        ? j.results
        : Array.isArray(j?.data)
          ? j.data
          : Array.isArray(j?.releases)
            ? j.releases
            : [];

      for (const release of releases) {
        const scored = scoreBeatportReleaseCandidate(release, artistInput, titleWithMaybeYear, reqYear, requestInfo);
        if (scored.url) allCandidates.push(scored);
      }

      const exactNow = allCandidates
        .filter((c) => c.exactTitle && c.exactArtist && c.url && !c.badSingleReleaseType)
        .sort((a, b) => b.score - a.score)[0];
      if (exactNow) return exactNow.url;
    }

    if (!allCandidates.length) return "";

    const seen = new Set();
    const deduped = allCandidates
      .filter((c) => {
        const key = c.albumId || c.url;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.score - a.score);

    const exact = deduped.find((c) =>
      c.exactTitle &&
      c.exactArtist &&
      c.url &&
      !c.badSingleReleaseType
    );
    if (exact) return exact.url;

    const close = deduped.find((c) =>
      c.url &&
      !c.badSingleReleaseType &&
      c.score >= 60 &&
      c.titleKind !== "none" &&
      (c.strictExactArtist || c.strictAnyArtist || c.exactArtist)
    );
    if (close) return close.url;

    return "";
  };

  // -------------------------
  // Deezer NZ-authenticated search
  // -------------------------
  const deezerPrivateApi = async (method, input = "3", apiToken = "", payload = {}) => {
    if (!DEEZER_ARL || DEEZER_ARL === "PASTE_YOUR_DEEZER_ARL_HERE") return null;

    const headers = {
      accept: "*/*",
      "content-type": "application/json",
      cookie: `arl=${DEEZER_ARL}`
    };

    const url = `https://www.deezer.com/ajax/gw-light.php?method=${encodeURIComponent(method)}&input=${encodeURIComponent(input)}&api_version=1.0&api_token=${encodeURIComponent(apiToken || "")}`;
    const r = await gmPost(url, headers, JSON.stringify(payload || {}));
    if (r.status !== 200) return null;

    try {
      return JSON.parse(r.responseText || "{}");
    } catch {
      return null;
    }
  };

  const deezerGetApiToken = async () => {
    const j = await deezerPrivateApi("deezer.getUserData");
    return j?.results?.checkForm || "";
  };

  const deezerPrivateSearch = async (query, start = 0, nb = 10) => {
    const token = await deezerGetApiToken();
    if (!token) return null;

    return deezerPrivateApi("search.music", "3", token, {
      query,
      start,
      nb
    });
  };

  const deezerAlbumUrl = (id) => id ? `https://www.deezer.com/album/${id}` : "";

  const deezerScoreAlbumCandidate = (album, reqArtistInput, reqTitleRaw, requestInfo) => {
    const albumTitleRaw = album?.title || "";
    const albumArtistRaw =
      album?.artist?.name ||
      album?.artist?.title ||
      "";

    const titleInfo = titleScoreInfo(albumTitleRaw, reqTitleRaw);

    const requestedArtists = toArtistNames(reqArtistInput);
    const isSingleCompoundArtist =
      requestedArtists.length === 1 &&
      /[&+,/]/.test(requestedArtists[0]);

    const matchedCount = requestedArtists.filter((requested) =>
      artistNameMatches(albumArtistRaw, requested, isSingleCompoundArtist)
    ).length;

    const strictMatchedCount = requestedArtists.filter((requested) =>
      strictArtistCloseMatch(albumArtistRaw, requested)
    ).length;

    const exactArtist =
      requestedArtists.length > 0 &&
      matchedCount === requestedArtists.length;

    const anyArtist = matchedCount > 0;

    const strictAnyArtist = strictMatchedCount > 0;
    const strictExactArtist =
      requestedArtists.length > 0 &&
      strictMatchedCount === requestedArtists.length;

    const badSingleReleaseType = hasSingleOnlyBadReleaseTypeTitle(
      albumTitleRaw,
      reqTitleRaw,
      requestInfo
    );

    let score = titleInfo.score;
    if (exactArtist) score += 45;
    else if (anyArtist) score += 25;

    if (hasUnrequestedBadVariant(albumTitleRaw, reqTitleRaw)) score -= 15;
    if (badSingleReleaseType) score -= 1000;

    return {
      score,
      exactTitle: titleInfo.exactTitle,
      titleKind: titleInfo.titleKind,
      exactArtist,
      anyArtist,
      strictAnyArtist,
      strictExactArtist,
      badSingleReleaseType,
      albumId: String(album?.id || ""),
      url: deezerAlbumUrl(album?.id),
      raw: album
    };
  };

  const deezerExtractAlbumsFromPrivateSearch = (j) => {
    const data = Array.isArray(j?.results?.data) ? j.results.data : [];
    const albums = [];

    for (const item of data) {
      const album = item?.ALB_ID
        ? {
            id: item.ALB_ID,
            title: item.ALB_TITLE || item.ALB_TITLE_SHORT || "",
            artist: {
              name: item.ART_NAME || ""
            }
          }
        : item?.album
          ? item.album
          : null;

      if (album?.id) albums.push(album);
    }

    return albums;
  };

  const deezerAuthenticatedSearch = async (artistInput, title, requestInfo) => {
    if (!DEEZER_ARL || DEEZER_ARL === "PASTE_YOUR_DEEZER_ARL_HERE") return "";

    const cleanTitle = stripYearSuffix(title);
    const queryVariants = buildFastQueryVariants(artistInput, cleanTitle);
    const allCandidates = [];

    for (const query of queryVariants) {
      const j = await deezerPrivateSearch(query, 0, 10);
      const albums = deezerExtractAlbumsFromPrivateSearch(j);

      for (const album of albums) {
        const scored = deezerScoreAlbumCandidate(album, artistInput, title, requestInfo);
        if (scored.url) allCandidates.push(scored);
      }

      const exactNow = allCandidates
        .filter((c) => c.exactTitle && c.exactArtist && c.url && !c.badSingleReleaseType)
        .sort((a, b) => b.score - a.score)[0];

      if (exactNow) return exactNow.url;
    }

    if (!allCandidates.length) return "";

    const seen = new Set();
    const deduped = allCandidates
      .filter((c) => {
        const key = c.albumId || c.url;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.score - a.score);

    const exact = deduped.find((c) =>
      c.exactTitle &&
      c.exactArtist &&
      c.url &&
      !c.badSingleReleaseType
    );
    if (exact) return exact.url;

    const close = deduped.find((c) =>
      c.url &&
      !c.badSingleReleaseType &&
      c.score >= 60 &&
      c.titleKind !== "none" &&
      (c.strictExactArtist || c.strictAnyArtist || c.exactArtist)
    );

    if (close) return close.url;

    return "";
  };

  const deezerPublicSearch = async (artist, title) => {
    const q = `artist:"${artist}" album:"${title}"`;
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`;
    const r = await gmGet(url, { accept: "application/json" });
    const j = JSON.parse(r.responseText || "{}");
    const id = j?.data?.[0]?.album?.id;
    return id ? `https://www.deezer.com/album/${id}` : "";
  };

  const deezerSearch = async (artistInput, title, requestInfo) => {
    const nzUrl = await deezerAuthenticatedSearch(artistInput, title, requestInfo).catch(() => "");
    if (nzUrl) return { url: nzUrl, label: "Deezer(NZ)" };

    const publicArtist = primaryArtistName(artistInput);
    const publicUrl = await deezerPublicSearch(publicArtist, title).catch(() => "");
    if (publicUrl) return { url: publicUrl, label: "Deezer" };

    return { url: "", label: "Deezer" };
  };

  const firstResolvedPurchaseUrl = async (jobs) => {
    return new Promise((resolve) => {
      let pending = jobs.length;
      let resolved = false;

      for (const job of jobs) {
        job.promise
          .then((url) => {
            if (resolved || !url) return;
            resolved = true;
            resolve({ label: job.label, url });
          })
          .catch(() => {})
          .finally(() => {
            pending -= 1;
            if (!resolved && pending <= 0) {
              resolved = true;
              resolve({ label: "", url: "" });
            }
          });
      }
    });
  };

  const updateRenderedState = (patch = {}) => {
    const merged = {
      ...DEFAULT_RENDER_STATE,
      ...lastRenderState,
      ...patch
    };

    merged.serviceStatus = {
      ...(lastRenderState?.serviceStatus || {}),
      ...(patch?.serviceStatus || {})
    };

    renderResults(merged);
  };

  const buildNoMatchMessage = () => "No match at all";

  (async () => {
    try {
      const id = new URL(location.href).searchParams.get("id");
      if (!id) return;

      const data = await redAPI(id);
      if (data?.status !== "success") return;

      const response = data.response || {};
      const requestInfo = buildRequestInfo(response);

      const mediaList = requestInfo.mediaList;
      const okMedia = mediaList.includes("WEB") || mediaList.includes("Any");
      if (!okMedia) return;

      const artistNames = getRedArtistNames(response);
      const streamingArtistNames = streamingArtistNamesForRequest(artistNames, requestInfo);

      const artist = primaryArtistName(artistNames);
      const artistDisplay = displayArtistName(artistNames) || artist;

      const streamingArtist = primaryArtistName(streamingArtistNames);
      const streamingArtistSearch = combinedArtistSearchAlias(streamingArtistNames) || streamingArtist;

      const title = decodeHTML(response.title || "");
      const release = `${artistDisplay} - ${title}`;
      const manualSearchInFlight = new Set();

      onDemandLabelSearch = async (service) => {
        if (!service || manualSearchInFlight.has(service)) return;
        manualSearchInFlight.add(service);

        const current = { ...lastRenderState };
        const currentDeezerLabel = current.deezerLabel || "Deezer";
        const rowLabel =
          service === "qobuz" ? "Qobuz"
            : service === "tidal" ? "Tidal"
              : service === "deezer" ? currentDeezerLabel
                : "Beatport";

        updateRenderedState({
          serviceStatus: { [service]: "Searching..." }
        });

        try {
          let foundUrl = "";
          let nextDeezerLabel = currentDeezerLabel;

          if (service === "qobuz") {
            foundUrl = await qobuzSearch(streamingArtistNames, titleNoYear(title), requestInfo).catch(() => "");
          } else if (service === "tidal") {
            const tRes = await tidalSearch(streamingArtistNames, title, requestInfo).catch(() => ({ exact: "" }));
            foundUrl = tRes.exact || "";
          } else if (service === "deezer") {
            const dRes = await deezerSearch(streamingArtistNames, titleNoYear(title), requestInfo).catch(() => ({ url: "", label: "Deezer" }));
            foundUrl = dRes.url || "";
            nextDeezerLabel = dRes.label || "Deezer";
          } else if (service === "beatport") {
            foundUrl = await beatportSearch(streamingArtistNames, title, requestInfo).catch(() => "");
          }

          if (foundUrl) {
            const servicePatch =
              service === "qobuz" ? { qobuz: foundUrl }
                : service === "tidal" ? { tidal: foundUrl }
                  : service === "deezer" ? { deezer: foundUrl, deezerLabel: nextDeezerLabel }
                    : { beatport: foundUrl };

            const copiedLabel = service === "deezer" ? nextDeezerLabel : rowLabel;
            copyNow(copiedLabel, foundUrl);

            updateRenderedState({
              ...servicePatch,
              copied: foundUrl,
              serviceStatus: { [service]: "" }
            });
            return;
          }

          updateRenderedState({
            deezerLabel: service === "deezer" ? nextDeezerLabel : currentDeezerLabel,
            serviceStatus: { [service]: buildNoMatchMessage() }
          });
        } finally {
          manualSearchInFlight.delete(service);
        }
      };

      const desc = extractLinks(response.description || "");
      let q = desc.qobuz, t = desc.tidal, d = desc.deezer, b = desc.beatport;
      let deezerLabel = "Deezer";
      const count = [q, t, d, b].filter(Boolean).length;

      // Description Beatport links trump all other logic.
      // If the RED request description already contains a Beatport URL,
      // copy it immediately and display it without running any searches.
      if (b) {
        copyNow("Beatport", b);
        renderResults({
          copied: b,
          release,
          qobuz: q,
          tidal: t,
          deezer: d,
          deezerLabel,
          beatport: b
        });
        return;
      }

      if (requestInfo.is24BitOnly) {
        if (q) {
          copyNow("Qobuz", q);
          renderResults({ copied: q, release, qobuz: q, tidal: t, deezer: "", deezerLabel, beatport: "" });
          return;
        }

        if (t) {
          copyNow("Tidal", t);
          renderResults({ copied: t, release, qobuz: "", tidal: t, deezer: "", deezerLabel, beatport: "" });
          return;
        }

        const tRes = await tidalSearch(streamingArtistNames, title, requestInfo).catch(() => ({
          exact: "",
          search: makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title))
        }));

        if (tRes.exact) {
          copyNow("Tidal", tRes.exact);
          renderResults({ copied: tRes.exact, release, qobuz: "", tidal: tRes.exact, deezer: "", deezerLabel, beatport: "" });
          return;
        }

        renderResults({
          copied: "",
          release,
          qobuz: "",
          tidal: "",
          tidalSearch: tRes.search || makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title)),
          deezer: "",
          deezerLabel,
          beatport: ""
        });
        return;
      }

      if (q) {
        copyNow("Qobuz", q);
        renderResults({ copied: q, release, qobuz: q, tidal: t, deezer: d, deezerLabel, beatport: b });
        return;
      }

      if (t) {
        copyNow("Tidal", t);
        renderResults({ copied: t, release, qobuz: q, tidal: t, deezer: d, deezerLabel, beatport: b });
        return;
      }

      if (requestInfo.isSingle) {
        const tRes = await tidalSearch(streamingArtistNames, title, requestInfo).catch(() => ({
          exact: "",
          search: makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title))
        }));

        if (tRes.exact) {
          copyNow("Tidal", tRes.exact);
          renderResults({ copied: tRes.exact, release, qobuz: q, tidal: tRes.exact, deezer: d, deezerLabel, beatport: b });
          return;
        }

        if (d) {
          copyNow(deezerLabel, d);
          renderResults({
            copied: d,
            release,
            qobuz: q,
            tidal: "",
            tidalSearch: tRes.search || makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title)),
            deezer: d,
            deezerLabel,
            beatport: b
          });
          return;
        }

        q = await qobuzSearch(streamingArtistNames, titleNoYear(title), requestInfo).catch(() => "");

        if (q) {
          copyNow("Qobuz", q);
          renderResults({
            copied: q,
            release,
            qobuz: q,
            tidal: "",
            tidalSearch: tRes.search || makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title)),
            deezer: "",
            deezerLabel,
            beatport: b
          });
          return;
        }

        const dzRes = await deezerSearch(streamingArtistNames, titleNoYear(title), requestInfo).catch(() => ({ url: "", label: "Deezer" }));
        d = dzRes.url || "";
        deezerLabel = dzRes.label || "Deezer";

        if (d) {
          copyNow(deezerLabel, d);
          renderResults({
            copied: d,
            release,
            qobuz: q,
            tidal: "",
            tidalSearch: tRes.search || makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title)),
            deezer: d,
            deezerLabel,
            beatport: b
          });
          return;
        }

        renderResults({
          copied: "",
          release,
          qobuz: "",
          tidal: "",
          tidalSearch: tRes.search || makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title)),
          deezer: "",
          deezerLabel,
          beatport: b,
          beatportSearch: beatportSearchUrl(streamingArtistSearch, titleNoYear(title))
        });
        return;
      }

      if (count > 1) {
        const copied = q || t || (requestInfo.isBeatportRelevant ? (b || d) : (d || b)) || "";
        if (copied === q) copyNow("Qobuz", copied);
        else if (copied === t) copyNow("Tidal", copied);
        else if (copied === b) copyNow("Beatport", copied);
        else if (copied === d) copyNow(deezerLabel, copied);
        renderResults({ copied, release, qobuz: q, tidal: t, deezer: d, deezerLabel, beatport: b });
        return;
      }

      if (d && !q && !t && !b) {
        const qFound = await qobuzSearch(streamingArtistNames, titleNoYear(title), requestInfo).catch(() => "");
        if (qFound) {
          copyNow("Qobuz", qFound);
          renderResults({
            copied: qFound,
            release,
            qobuz: qFound,
            tidal: "",
            tidalSearch: makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title)),
            deezer: d,
            deezerLabel
          });
          return;
        }

        const tRes = await tidalSearch(streamingArtistNames, title, requestInfo).catch(() => ({
          exact: "",
          search: makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title))
        }));

        if (tRes.exact) {
          copyNow("Tidal", tRes.exact);
          renderResults({ copied: tRes.exact, release, qobuz: "", tidal: tRes.exact, deezer: d, deezerLabel });
          return;
        }

        const bFound = requestInfo.isBeatportRelevant
          ? await beatportSearch(streamingArtistNames, title, requestInfo).catch(() => "")
          : "";

        if (bFound) {
          copyNow("Beatport", bFound);
          renderResults({
            copied: bFound,
            release,
            qobuz: "",
            tidal: "",
            tidalSearch: tRes.search || makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title)),
            deezer: d,
            deezerLabel,
            beatport: bFound
          });
          return;
        }

        copyNow(deezerLabel, d);
        renderResults({
          copied: d,
          release,
          qobuz: "",
          tidal: "",
          tidalSearch: tRes.search || makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title)),
          deezer: d,
          deezerLabel
        });
        return;
      }

      let copied = "";

      const qPromise = q
        ? Promise.resolve(q)
        : qobuzSearch(streamingArtistNames, titleNoYear(title), requestInfo).catch(() => "");

      const tPromise = t
        ? Promise.resolve(t)
        : tidalSearch(streamingArtistNames, title, requestInfo)
            .then((res) => res.exact || "")
            .catch(() => "");

      // Race Qobuz and Tidal first.
      const firstQT = await firstResolvedPurchaseUrl([
        { label: "Qobuz", promise: qPromise },
        { label: "Tidal", promise: tPromise }
      ]);

      if (firstQT.url) {
        copied = firstQT.url;
        copyNow(firstQT.label, firstQT.url);
      }

      const [qFound, tFound] = await Promise.all([qPromise, tPromise]);

      q = q || qFound || "";
      t = t || tFound || "";

      // Only if both Qobuz and Tidal failed, try Beatport first (genre-gated search), then Deezer.
      if (!q && !t) {
        let bFound = b || "";

        if (!bFound && requestInfo.isBeatportRelevant) {
          bFound = await beatportSearch(streamingArtistNames, title, requestInfo).catch(() => "");
        }

        b = b || bFound || "";

        if (b && !copied) {
          copied = b;
          copyNow("Beatport", b);
        }

        if (!b) {
          const dzRes = d
            ? { url: d, label: "Deezer" }
            : await deezerSearch(streamingArtistNames, titleNoYear(title), requestInfo).catch(() => ({
                url: "",
                label: "Deezer"
              }));

          d = d || dzRes.url || "";
          deezerLabel = dzRes.label || "Deezer";

          if (d && !copied) {
            copied = d;
            copyNow(deezerLabel, d);
          }
        }
      }

      const fallbackTidalSearch = makeTidalSearchUrl(streamingArtistSearch, titleNoYear(title));
      const fallbackBeatportSearch = beatportSearchUrl(streamingArtistSearch, titleNoYear(title));

      if (!copied) {
        renderResults({
          copied: "",
          release,
          qobuz: q,
          tidal: t,
          tidalSearch: t ? "" : fallbackTidalSearch,
          deezer: d,
          deezerLabel,
          beatport: b,
          beatportSearch: fallbackBeatportSearch
        });
        return;
      }

      renderResults({
        copied,
        release,
        qobuz: q,
        tidal: t,
        tidalSearch: t ? "" : fallbackTidalSearch,
        deezer: d,
        deezerLabel,
        beatport: b,
        beatportSearch: b ? "" : fallbackBeatportSearch
      });
    } catch (e) {
      console.error("[RED Purchase Links] script error", e);
      showNotice("Script error (check console)", "#ff8a8a");
    }
  })();
})();