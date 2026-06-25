(() => {
'use strict';

const DB_NAME = 'FuentesCommDB';
const DB_VER = 1;
const STORE = 'comm_cache';
const DATA_VER_KEY = 'fuentes_data_ver';
const DATA_VER = 6;
const COMM_INDEX_URL = 'data/index.json';
const LEGACY_URL = 'fuentes_espana.json';
const STATE_COMM_KEY = 'fuentes_current_comm';
const TILE_LAYERS = {
  osm:  { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; <a href="https://osm.org/copyright">OSM</a>', maxZoom: 19 },
  topo: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attr: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17 },
  sat:  { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: '&copy; <a href="https://esri.com">Esri</a>', maxZoom: 18 },
};

const CUENCA_COLORS = {
  'GUADALQUIVIR':'#2ecc71','GUADIANA':'#e74c3c','TAJO':'#3498db','DUERO':'#9b59b6',
  'EBRO':'#e67e22','JUCAR':'#1abc9c','SEGURA':'#f39c12','SUR':'#e91e63',
  'NORTE':'#00bcd4','C. I. DE CATALUÑA':'#ff5722','MALLORCA':'#8bc34a',
  'MENORCA':'#ff9800','IBIZA':'#795548'
};

const state = {
  db: null, allData: [], filtered: [], activeId: null,
  comunidad: '', provincia: '', municipio: '', cuenca: '',
  commIndex: null, commSlug: null, commLoading: false,
  _allData: null, _isLegacy: false,
  map: null, markers: null, singleLayer: null,
  renderTimer: null,
  searchTerm: '',
  favorites: (() => {
    try {
      const stored = JSON.parse(localStorage.getItem('fuentes_favorites') || '[]');
      return Array.isArray(stored) ? stored.map(String) : [];
    } catch (e) {
      return [];
    }
  })(),
  showFavoritesOnly: false,
  userCoords: null,
  userMarker: null,
  dwData: null, dwLayer: null, showDW: false,
  lastRenderedSig: null,
};

function $(id) { return document.getElementById(id); }

function normalizeStr(s) {
  if (!s) return '';
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeKey(s) {
  return normalizeStr(String(s || '').trim());
}

function displayName(d) {
  return d.nombre || (
    d._observaciones && d._observaciones.length < 80 ? d._observaciones :
    d.osm_description && d.osm_description.length < 80 ? d.osm_description.split(',')[0] :
    (d.tipo_surgencia || 'Fuente') + (d.municipio ? ' en ' + d.municipio : '') + (d.provincia ? ' (' + d.provincia.split('/')[0] + ')' : '')
  ) || d.id_fuente;
}

function slugify(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

const EDITS_KEY = 'fuentes_edits';
let __editingId = null;
let __editOriginals = null;

function getEditsHash() {
  try { return JSON.parse(localStorage.getItem(EDITS_KEY) || '{}'); } catch(e) { return {}; }
}

function saveEditsHash(h) {
  localStorage.setItem(EDITS_KEY, JSON.stringify(h));
}

function saveEditAction(id, changes, originals) {
  const h = getEditsHash();
  const sid = String(id);
  if (!h[sid]) {
    h[sid] = { changes: {}, originals: {}, timestamp: 0 };
  }
  Object.assign(h[sid].changes, changes);
  if (originals) {
    for (const k of Object.keys(changes)) {
      if (!(k in h[sid].originals)) {
        h[sid].originals[k] = originals[k];
      }
    }
  }
  h[sid].timestamp = Date.now();
  const base = state.allData.find(d => String(d.id_fuente) === sid);
  if (base) {
    for (const k of Object.keys(h[sid].changes)) {
      if (h[sid].changes[k] === base[k]) delete h[sid].changes[k];
    }
  }
  if (!Object.keys(h[sid].changes).length) {
    delete h[sid];
  }
  saveEditsHash(h);
}

function deleteEditAction(id) {
  const h = getEditsHash();
  const sid = String(id);
  const edit = h[sid];
  if (edit && edit.originals) {
    const record = state.allData.find(d => String(d.id_fuente) === sid);
    if (record) {
      for (const [k, v] of Object.entries(edit.originals)) {
        record[k] = (v === null || v === '') ? null : v;
      }
    }
  }
  delete h[sid];
  saveEditsHash(h);
}

function getEditAction(id) {
  const h = getEditsHash();
  return h[String(id)] || null;
}

function applyStoredEdits() {
  const h = getEditsHash();
  for (const [sid, edit] of Object.entries(h)) {
    const record = state.allData.find(d => String(d.id_fuente) === sid);
    if (record && edit.changes) {
      for (const [k, v] of Object.entries(edit.changes)) {
        if (v === null || v === '') record[k] = null;
        else if (k === 'altitud' || k === 'huso') record[k] = Number(v);
        else record[k] = v;
      }
    }
  }
}

async function ensureLegacyData() {
  if (state._allData && state._allData.length) return state._allData;
  if (window.FUENTES_ESPANA && Array.isArray(window.FUENTES_ESPANA) && window.FUENTES_ESPANA.length) {
    state._allData = window.FUENTES_ESPANA;
    return state._allData;
  }
  if (window.FUENTES_DATA && Array.isArray(window.FUENTES_DATA) && window.FUENTES_DATA.length) {
    state._allData = window.FUENTES_DATA;
    return state._allData;
  }
  if (location.protocol === 'file:') {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'fuentes_espana.js';
      s.onload = () => {
        state._allData = Array.isArray(window.FUENTES_ESPANA) ? window.FUENTES_ESPANA : (Array.isArray(window.FUENTES_DATA) ? window.FUENTES_DATA : null);
        resolve();
      };
      s.onerror = () => reject(new Error('No se pudo cargar fuentes_espana.js'));
      document.head.appendChild(s);
    }).catch(() => {});
    if (state._allData && state._allData.length) return state._allData;
  }
  try {
    const resp = await fetch(LEGACY_URL);
    if (resp.ok) {
      state._allData = await resp.json();
      return state._allData;
    }
  } catch (e) {
    /* ignore */
  }
  if ((window.FUENTES_ESPANA && Array.isArray(window.FUENTES_ESPANA) && window.FUENTES_ESPANA.length) || (window.FUENTES_DATA && Array.isArray(window.FUENTES_DATA) && window.FUENTES_DATA.length)) {
    state._allData = window.FUENTES_ESPANA || window.FUENTES_DATA;
    return state._allData;
  }
  return null;
}

window.__openEdit = function(id) {
  const idStr = String(id);
  __editingId = idStr;
  const d = state.allData.find(x => String(x.id_fuente) === idStr);
  if (!d) return;
  __editOriginals = {};
  for (const k of Object.keys(d)) __editOriginals[k] = d[k];
  $('modal-info-view').style.display = 'none';
  $('modal-edit-form').style.display = 'block';
};

window.__cancelEdit = function() {
  __editingId = null; __editOriginals = null;
  $('modal-info-view').style.display = '';
  $('modal-edit-form').style.display = 'none';
};

window.__saveEdit = function(id) {
  const idStr = String(id);
  const d = state.allData.find(x => String(x.id_fuente) === idStr);
  if (!d) return;
  const form = $('modal-edit-form');
  const inputs = form.querySelectorAll('[name]');
  const changes = {};
  for (const inp of inputs) {
    const val = inp.type === 'number' ? (inp.value === '' ? null : (isNaN(Number(inp.value)) ? null : Number(inp.value))) : inp.value;
    if (val !== __editOriginals[inp.name]) {
      changes[inp.name] = val;
    }
  }
  if (!Object.keys(changes).length) {
    showToast('No hay cambios que guardar');
    return;
  }
  const originals = {};
  for (const k of Object.keys(changes)) {
    originals[k] = d[k];
  }
  for (const [k, v] of Object.entries(changes)) {
    d[k] = (v === null || v === '') ? null : v;
  }
  saveEditAction(id, changes, originals);
  window.__cancelEdit();
  showModal(d);
  showToast('Corrección guardada');
};

window.__deleteEdit = function(id) {
  const idStr = String(id);
  deleteEditAction(idStr);
  const d = state.allData.find(x => String(x.id_fuente) === idStr);
  if (d) showModal(d);
  showToast('Edición deshecha');
};

window.__suggestName = function(id) {
  window.__openEdit(id);
  // Focus the nombre field
  setTimeout(() => {
    const inp = $('modal-edit-form')?.querySelector('[name="nombre"]');
    if (inp) inp.focus();
  }, 100);
};

window.__lookupOsm = async function(id) {
  const btn = $('osmLookupBtn');
  if (btn) { btn.textContent = '⏳ Buscando...'; btn.disabled = true; }
  const idStr = String(id);
  const d = state.allData.find(x => String(x.id_fuente) === idStr);
  if (!d || !d._osm_id) {
    if (btn) { btn.textContent = '🔍 Buscar en OSM'; btn.disabled = false; }
    return;
  }
  try {
    const resp = await fetch('https://api.openstreetmap.org/api/0.6/node/' + d._osm_id);
    if (!resp.ok) { showToast('OSM no disponible'); return; }
    const xml = await resp.text();
    const nameMatch = xml.match(/<tag k="name" v="([^"]+)"/);
    if (nameMatch) {
      d.nombre = nameMatch[1];
      saveEditAction(id, { nombre: d.nombre }, { nombre: null });
      showModal(d);
      showToast('Nombre obtenido de OSM: ' + d.nombre);
    } else {
      showToast('Sin nombre en OSM para este elemento');
    }
  } catch(e) {
    showToast('Error al consultar OSM');
  } finally {
    if (btn) { btn.textContent = '🔍 Buscar en OSM'; btn.disabled = false; }
  }
};

const EDIT_FIELDS = [
  { key:'nombre', label:'Nombre' },
  { key:'provincia', label:'Provincia' },
  { key:'municipio', label:'Municipio' },
  { key:'pedania', label:'Pedanía' },
  { key:'altitud', label:'Altitud (m)' },
  { key:'cuenca', label:'Cuenca' },
  { key:'subcuenca', label:'Subcuenca' },
  { key:'rio_arroyo', label:'Río/Arroyo' },
  { key:'masa_agua_subterranea', label:'Masa Agua Subterránea' },
  { key:'sistema_acuifero', label:'Sistema Acuífero' },
  { key:'espacio_natural_protegido', label:'Espacio Natural Protegido' },
  { key:'procedencia_lugar', label:'Procedencia Lugar' },
  { key:'naturaleza_rocas', label:'Naturaleza Rocas' },
  { key:'tipo_surgencia', label:'Tipo Surgencia' },
  { key:'caudal_medio', label:'Caudal Medio (L/s)' },
  { key:'se_agota', label:'¿Se agota?' },
  { key:'acceso', label:'Acceso' },
  { key:'uso_publico_actual', label:'Uso Público Actual' },
  { key:'valoracion_instalaciones', label:'Valoración Instalaciones' },
  { key:'descripcion', label:'Descripción' },
  { key:'organismo', label:'Organismo' },
];

let PROV_CAPITALS = {};

function computeProvCapitals(data) {
  const groups = {};
  for (const d of data) {
    if (d.lat == null || d.lon == null) continue;
    if (!groups[d.provincia]) groups[d.provincia] = { lats: [], lons: [] };
    groups[d.provincia].lats.push(d.lat);
    groups[d.provincia].lons.push(d.lon);
  }
  for (const [prov, coords] of Object.entries(groups)) {
    const n = coords.lats.length;
    PROV_CAPITALS[prov] = [
      coords.lats.reduce((a, b) => a + b, 0) / n,
      coords.lons.reduce((a, b) => a + b, 0) / n
    ];
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'slug' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function initData() {
  showLoading('Cargando comunidades...');
  try { state.db = await openDB(); } catch(e) { state.db = null; }

  let index;
  // Try cache-first (SW may have cached old format — accept that for speed)
  try {
    const resp = await fetch(COMM_INDEX_URL);
    if (resp.ok) index = await resp.json();
  } catch(e) { /* ignore */ }
  // If index is old format (provinces instead of communities), force fresh fetch
  if (index && !index.communities) {
    index = null;
    try {
      const resp = await fetch(COMM_INDEX_URL + '?v=' + DATA_VER);
      if (resp.ok) index = await resp.json();
    } catch(e) { /* ignore */ }
  }

  if (!index || !index.communities) {
    // Fallback: if we have legacy full data, build community index from scratch
    showLoading('Cargando datos...');
    let data = null;

    // On file:// protocol, fetch() doesn't work — load fuentes_espana.js as <script>
    if (location.protocol === 'file:') {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'fuentes_espana.js';
        s.onload = () => { data = window.FUENTES_ESPANA || window.FUENTES_DATA || null; res(); };
        s.onerror = rej;
        document.head.appendChild(s);
      });
    } else {
      try {
        const resp = await fetch(LEGACY_URL);
        if (resp.ok) data = await resp.json();
      } catch(e) { /* ignore */ }
      if (!data || !data.length) {
        try {
          if (window.FUENTES_ESPANA) { data = window.FUENTES_ESPANA; } else if (window.FUENTES_DATA) { data = window.FUENTES_DATA; }
        } catch(e) { /* ignore */ }
      }
    }
    if (data && data.length) {
      // Build community index dynamically from the data
      const provToCC = {
        'Almería':'Andalucía','Cádiz':'Andalucía','Córdoba':'Andalucía',
        'Granada':'Andalucía','Huelva':'Andalucía','Jaén':'Andalucía',
        'Málaga':'Andalucía','Sevilla':'Andalucía',
        'Huesca':'Aragón','Teruel':'Aragón','Zaragoza':'Aragón',
        'Asturias':'Asturias',
        'Illes Balears':'Illes Balears','Islas Baleares':'Illes Balears',
        'Las Palmas':'Canarias','Santa Cruz de Tenerife':'Canarias',
        'Cantabria':'Cantabria',
        'Ávila':'Castilla y León','Avila':'Castilla y León',
        'Burgos':'Castilla y León','León':'Castilla y León','Leon':'Castilla y León',
        'Palencia':'Castilla y León','Salamanca':'Castilla y León',
        'Segovia':'Castilla y León','Soria':'Castilla y León',
        'Valladolid':'Castilla y León','Zamora':'Castilla y León',
        'Albacete':'Castilla-La Mancha','Ciudad Real':'Castilla-La Mancha',
        'Cuenca':'Castilla-La Mancha','Guadalajara':'Castilla-La Mancha',
        'Toledo':'Castilla-La Mancha',
        'Barcelona':'Cataluña','Girona':'Cataluña','Gerona':'Cataluña',
        'Lleida':'Cataluña','Lérida':'Cataluña','Tarragona':'Cataluña',
        'A Coruña':'Galicia','La Coruña':'Galicia',
        'Lugo':'Galicia','Ourense':'Galicia','Orense':'Galicia',
        'Pontevedra':'Galicia',
        'Madrid':'Comunidad de Madrid',
        'Murcia':'Región de Murcia',
        'Navarra':'Navarra','Navarre':'Navarra',
        'Araba/Álava':'País Vasco','Álava':'País Vasco','Alava':'País Vasco',
        'Bizkaia':'País Vasco','Vizcaya':'País Vasco',
        'Gipuzkoa':'País Vasco','Guipúzcoa':'País Vasco','Guipuzcoa':'País Vasco',
        'La Rioja':'La Rioja',
        'Alacant/Alicante':'Comunitat Valenciana','Alicante':'Comunitat Valenciana',
        'Castelló/Castellón':'Comunitat Valenciana','Castellón':'Comunitat Valenciana','Castellon':'Comunitat Valenciana',
        'València/Valencia':'Comunitat Valenciana','Valencia':'Comunitat Valenciana',
        'Badajoz':'Extremadura','Cáceres':'Extremadura','Caceres':'Extremadura',
      };
      const normalizedProvToCC = {};
      for (const [provName, cc] of Object.entries(provToCC)) {
        normalizedProvToCC[normalizeKey(provName)] = cc;
      }
      const commMap = {};
      for (const d of data) {
        const prov = String(d.provincia || 'Sin provincia').trim();
        const cc = normalizedProvToCC[normalizeKey(prov)] || 'Otras';
        if (!commMap[cc]) commMap[cc] = { name: cc, slug: slugify(cc), count: 0, named: 0, provinces: {} };
        commMap[cc].count++;
        if (d.nombre) commMap[cc].named++;
        if (!commMap[cc].provinces[prov]) commMap[cc].provinces[prov] = 0;
        commMap[cc].provinces[prov]++;
      }
      const communities = Object.values(commMap).map(c => ({
        name: c.name, slug: c.slug, count: c.count, named: c.named,
        provinces: Object.entries(c.provinces).sort().map(([name, cnt]) => ({ name, slug: slugify(name), count: cnt }))
      })).sort((a,b) => a.name.localeCompare(b.name));
      index = { total: data.length, communities };
      state._allData = data;
      state._isLegacy = true;
    } else {
      // No data at all — show error
      hideLoading();
      throw new Error('No se pudieron cargar los datos');
    }
  }

  state.commIndex = index;
  hideLoading();

  // Populate community selector immediately (only if element exists in HTML)
  const commSel = $('commSelect');
  if (commSel && index.communities) {
    commSel.innerHTML = '<option value="">Selecciona comunidad...</option>' +
      index.communities.filter(c => c.slug !== 'otras').map(c =>
        `<option value="${esc(c.slug)}">${esc(c.name)} (${c.count.toLocaleString()})</option>`
      ).join('');
  }

  // Restore previously selected community
  const saved = localStorage.getItem(STATE_COMM_KEY);
  if (saved) {
    const match = index.communities.find(c => c.slug === saved);
    if (match) {
      state.comunidad = match.name;
      state.commSlug = match.slug;
      if (state._isLegacy) {
        // Legacy mode: no community files, filter from full data
        const provNames = new Set(match.provinces.map(p => normalizeKey(p.name)));
        state.allData = provNames.size ? (state._allData || []).filter(d => provNames.has(normalizeKey(d.provincia))) : (state._allData || []);
        state.filtered = state.allData;
        applyStoredEdits();
        computeProvCapitals(state.allData);
        populateProvSelect();
        state.map.invalidateSize();
        renderMapAll();
        fitToFiltered();
        hideLoading();
        return;
      }
      await loadCommunity(match.slug);
      return;
    }
  }

  // No saved community: show map centered on Spain
  state.allData = [];
  state.filtered = [];
  updateUI();
}

async function loadCommunity(slug) {
  if (state.commLoading) return;
  state.commLoading = true;
  state._isLegacy = false;
  renderSidePanelSkeleton();
  showLoading(`Cargando ${slug}...`);

  try {
    // Check IndexedDB cache first
    let commData = null;
    if (state.db) {
      try {
        const tx = state.db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(slug);
        commData = await new Promise((res, rej) => {
          req.onsuccess = () => { const r = req.result; res(r ? r.data : null); };
          req.onerror = () => res(null);
        });
      } catch(e) { /* ignore */ }
    }

    if (!commData) {
      if (location.protocol === 'file:') {
        await ensureLegacyData();
        if (state._allData) {
          const comm = state.commIndex.communities.find(c => c.slug === slug);
          const provNames = comm ? new Set(comm.provinces.map(p => normalizeKey(p.name))) : new Set();
          commData = provNames.size ? state._allData.filter(d => provNames.has(normalizeKey(d.provincia))) : state._allData;
          state._isLegacy = true;
        }
      }
    }

    if (!commData) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      let resp = null;
      try {
        resp = await fetch(`data/_${slug}.json`, { signal: ctrl.signal });
      } catch (fetchError) {
        resp = null;
      } finally {
        clearTimeout(to);
      }
      if (!resp || !resp.ok) {
        await ensureLegacyData();
        if (state._allData) {
          const comm = state.commIndex.communities.find(c => c.slug === slug);
          const provNames = comm ? new Set(comm.provinces.map(p => normalizeKey(p.name))) : new Set();
          commData = provNames.size ? state._allData.filter(d => provNames.has(normalizeKey(d.provincia))) : state._allData;
          state._isLegacy = true;
        }
        if (!commData) {
          throw new Error(resp ? 'HTTP ' + resp.status : 'No se pudo cargar datos de comunidad');
        }
      }
      if (resp && resp.ok) commData = await resp.json();

      // Cache in IndexedDB
      if (state.db && commData) {
        try {
          const tx = state.db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({ slug, data: commData, updated: Date.now() });
          await new Promise((res, rej) => {
            tx.oncomplete = res;
            tx.onerror = e => rej(tx.error);
          });
          localStorage.setItem(DATA_VER_KEY, DATA_VER);
        } catch(e) { /* ignore */ }
      }
    }

    state.allData = commData;
    state.commSlug = slug;
    state.comunidad = state.commIndex.communities.find(c => c.slug === slug)?.name || slug;
    localStorage.setItem(STATE_COMM_KEY, slug);

    // Reset local filters
    state.provincia = '';
    state.municipio = '';
    state.cuenca = '';

    applyStoredEdits();
    populateProvSelect();
    populateMuni();
    populateCuenca();

    applyFilters();
    updateUI();
    renderSidePanel();
    state.map.invalidateSize();
    renderMapAll();
    fitToFiltered();
    hideLoading();

  } catch(e) {
    hideLoading();
    showToast('Error al cargar comunidad: ' + e.message);
  } finally {
    state.commLoading = false;
  }
}

function applyFilters() {
  state.filtered = state.allData.filter(d => {
    if (state.provincia && normalizeKey(d.provincia) !== normalizeKey(state.provincia)) return false;
    if (state.municipio && normalizeKey(d.municipio) !== normalizeKey(state.municipio)) return false;
    if (state.cuenca && normalizeKey(d.cuenca) !== normalizeKey(state.cuenca)) return false;
    if (state.showFavoritesOnly && !state.favorites.includes(String(d.id_fuente))) return false;
    if (state.searchTerm) {
      if (!normalizeStr(displayName(d)).includes(state.searchTerm)) {
        return false;
      }
    }
    return true;
  });

  if (state.userCoords) {
    for (const d of state.filtered) {
      if (isValidCoord(d.lat, d.lon)) {
        d._distance = getDistance(state.userCoords.lat, state.userCoords.lon, d.lat, d.lon);
      } else {
        d._distance = Infinity;
      }
    }
    state.filtered.sort((a, b) => a._distance - b._distance);
  } else {
    for (const d of state.filtered) {
      d._distance = null;
    }
  }
}

function updateUI() {
  applyFilters();
  renderMap();
  updateStats();
  updateHash();
  renderSidePanel();
}

function initMap() {
  state.map = L.map('map', { center: [40.0, -3.5], zoom: 6.5, zoomControl: false, attributionControl: false });
  state.tileLayers = {};
  for (const k in TILE_LAYERS) {
    state.tileLayers[k] = L.tileLayer(TILE_LAYERS[k].url, {
      attribution: TILE_LAYERS[k].attr, maxZoom: TILE_LAYERS[k].maxZoom
    });
  }
  state.currentLayer = localStorage.getItem('map_layer') || 'osm';
  state.tileLayers[state.currentLayer].addTo(state.map);
  state.markers = L.markerClusterGroup({ maxClusterRadius: 50, spiderfyOnMaxZoom: true, showCoverageOnHover: false, zoomToBoundsOnClick: true, disableClusteringAtZoom: 15 });
  state.map.addLayer(state.markers);
  state.dwLayer = L.markerClusterGroup({ maxClusterRadius: 50, spiderfyOnMaxZoom: true, showCoverageOnHover: false, zoomToBoundsOnClick: true, disableClusteringAtZoom: 16, chunkedLoading: true });
  state.map.on('moveend zoomend', () => {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(renderMap, 150);
  });

  document.querySelectorAll('.layer-btn[data-layer]').forEach(b => b.classList.toggle('active', b.dataset.layer === state.currentLayer));
  document.querySelectorAll('.layer-btn[data-layer]').forEach(btn => {
    btn.addEventListener('click', () => setLayer(btn.dataset.layer));
  });
  $('zoomIn').onclick = () => state.map.zoomIn();
  $('zoomOut').onclick = () => state.map.zoomOut();

  $('gpsBtn').onclick = () => {
    if (!navigator.geolocation) {
      showToast("La geolocalización no es compatible con este navegador.");
      return;
    }
    showToast("Obteniendo ubicación GPS...");
    navigator.geolocation.getCurrentPosition(pos => {
      state.userCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.map.setView([state.userCoords.lat, state.userCoords.lon], 15, { animate: true });

      if (state.userMarker) state.map.removeLayer(state.userMarker);
      const gpsIcon = L.divIcon({
        className: 'user-gps-marker',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });
      state.userMarker = L.marker([state.userCoords.lat, state.userCoords.lon], { icon: gpsIcon }).addTo(state.map);

      $('gpsBtn').classList.add('active');
      updateUI();
      showToast("Ubicación encontrada. Fuentes ordenadas por cercanía.");
    }, err => {
      showToast("No se pudo obtener la ubicación GPS.");
    }, { enableHighAccuracy: true, timeout: 8000 });
  };

  $('dwBtn').onclick = toggleDWLayer;
  $('downloadTilesBtn').onclick = downloadVisibleTiles;
}

function lon2tile(lon, zoom) { return Math.floor((lon + 180) / 360 * Math.pow(2, zoom)); }
function lat2tile(lat, zoom) { return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)); }
function getTileRange(bounds, zoom) {
  const nw = bounds.getNorthWest();
  const se = bounds.getSouthEast();
  return {
    xMin: lon2tile(nw.lng, zoom),
    xMax: lon2tile(se.lng, zoom),
    yMin: lat2tile(nw.lat, zoom),
    yMax: lat2tile(se.lat, zoom)
  };
}
function getTileUrl(template, x, y, z) {
  const s = ['a', 'b', 'c'][Math.abs(x + y) % 3];
  return template.replace('{s}', s).replace('{x}', x).replace('{y}', y).replace('{z}', z);
}

async function downloadVisibleTiles() {
  if (!state.map) return;
  const bounds = state.map.getBounds();
  const template = TILE_LAYERS[state.currentLayer].url;
  const zooms = [11, 12, 13, 14];
  let tileUrls = [];

  for (const z of zooms) {
    const r = getTileRange(bounds, z);
    for (let x = r.xMin; x <= r.xMax; x++) {
      for (let y = r.yMin; y <= r.yMax; y++) {
        tileUrls.push(getTileUrl(template, x, y, z));
      }
    }
  }

  const total = tileUrls.length;
  if (total === 0) {
    showToast("No hay mapas para descargar.");
    return;
  }
  if (total > 600) {
    showToast(`Área demasiado grande (${total} teselas). Acerca el mapa.`);
    return;
  }

  showToast(`Descargando ${total} imágenes de mapa offline...`);
  try {
    const cache = await caches.open('osm-tiles-v1');
    let downloaded = 0;
    const concurrency = 6;
    const queue = [...tileUrls];

    async function worker() {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) continue;
        try {
          const req = new Request(url, { mode: 'cors' });
          const has = await cache.match(req);
          if (!has) {
            const resp = await fetch(req);
            if (resp.ok) await cache.put(req, resp);
          }
        } catch(e) {}
        downloaded++;
        if (downloaded % 25 === 0 || downloaded === total) {
          showToast(`Descarga de mapas: ${Math.round(downloaded/total*100)}%`);
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    showToast("¡Mapa offline descargado y listo para usar!");
  } catch(e) {
    showToast("Error al guardar mapas offline.");
  }
}

function setLayer(name) {
  if (name === state.currentLayer) return;
  if (state.tileLayers[state.currentLayer]) state.map.removeLayer(state.tileLayers[state.currentLayer]);
  if (state.tileLayers[name]) state.tileLayers[name].addTo(state.map);
  state.currentLayer = name;
  localStorage.setItem('map_layer', name);
  document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === name));
}

function renderMap() {
  if (state.comunidad || state.provincia || state.cuenca) { renderMapAll(); return; }
  state.markers.clearLayers();
  if (state.singleLayer) { state.map.removeLayer(state.singleLayer); state.singleLayer = null; }
  if (!state.filtered.length) return;

  const b = state.map.getBounds();
  const pad = 0.1;

  for (const d of state.filtered) {
    if (!isValidCoord(d.lat, d.lon)) continue;
    if (!b.contains([d.lat, d.lon]) &&
        (d.lat < b.getSouth()-pad || d.lat > b.getNorth()+pad ||
         d.lon < b.getWest()-pad || d.lon > b.getEast()+pad)) continue;
    addMarker(d);
  }
}

function getRenderSignature() {
  if (!state.filtered || !state.filtered.length) return 'empty';
  const len = state.filtered.length;
  let boundsSig = 'all';
  if (len > 5000 && state.map) {
    const b = state.map.getBounds();
    boundsSig = `${b.getSouth().toFixed(2)},${b.getNorth().toFixed(2)},${b.getWest().toFixed(2)},${b.getEast().toFixed(2)}`;
  }
  const sample = len > 0 ? `${state.filtered[0].id_fuente}-${state.filtered[Math.floor(len/2)]?.id_fuente || ''}-${state.filtered[len-1].id_fuente}` : '';
  return `${len}_${state.activeId}_${boundsSig}_${sample}`;
}

function renderMapAll() {
  if (!state.filtered || !state.filtered.length) {
    state.markers.clearLayers();
    if (state.singleLayer) { state.map.removeLayer(state.singleLayer); state.singleLayer = null; }
    state.lastRenderedSig = 'empty';
    return;
  }

  const sig = getRenderSignature();
  if (state.lastRenderedSig === sig) return;
  state.lastRenderedSig = sig;

  state.markers.clearLayers();
  if (state.singleLayer) { state.map.removeLayer(state.singleLayer); state.singleLayer = null; }

  if (state.filtered.length > 5000) {
    const b = state.map.getBounds();
    const pad = Math.max(b.getNorth() - b.getSouth(), b.getEast() - b.getWest()) * 1.5;
    for (const d of state.filtered) {
      if (!isValidCoord(d.lat, d.lon)) continue;
      if (!b.contains([d.lat, d.lon]) &&
          (d.lat < b.getSouth()-pad || d.lat > b.getNorth()+pad ||
           d.lon < b.getWest()-pad || d.lon > b.getEast()+pad)) continue;
      addMarker(d);
    }
  } else {
    for (const d of state.filtered) {
      if (isValidCoord(d.lat, d.lon)) addMarker(d);
    }
  }
}

function addMarker(d) {
  const isActive = String(d.id_fuente) === state.activeId;
  const color = CUENCA_COLORS[d.cuenca] || '#666';
  const pinSvg = `<svg viewBox="0 0 24 36" width="${isActive ? 26 : 20}" height="${isActive ? 39 : 30}">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0z"
          fill="${color}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="12" cy="12" r="${isActive ? 5 : 3.5}" fill="#fff"/>
    ${isActive ? '<circle cx="12" cy="12" r="2.5" fill="'+color+'"/>' : ''}
  </svg>`;
  const marker = L.marker([d.lat, d.lon], {
    icon: L.divIcon({
      className: 'marker-pin',
      html: pinSvg,
      iconSize: [isActive ? 26 : 20, isActive ? 39 : 30],
      iconAnchor: [isActive ? 13 : 10, isActive ? 39 : 30],
      popupAnchor: [0, isActive ? -42 : -33]
    })
  });
  const nombre = displayName(d);
  const meta = [d.tipo_surgencia, d.altitud ? d.altitud+' m' : ''].filter(Boolean).join(' · ');
  const loc = [d.municipio, d.provincia].filter(Boolean).join(', ');
  const id = String(d.id_fuente);
  const hasPhoto = window.PHOTO_COUNTS && window.PHOTO_COUNTS[id];
  const popupHtml = `<div class="marker-popup">${hasPhoto ? `<img src="images/cf_${id}_1.jpg" onerror="this.style.display='none'" class="popup-img">` : ''}<b>${esc(nombre)}</b>${loc ? `<br><small>${esc(loc)}</small>` : ''}${meta ? `<div class="popup-meta">${esc(meta)}</div>` : ''}</div>`;
  marker.bindPopup(popupHtml, { maxWidth: 220, className: 'marker-popup-wrap', closeButton: false });
  marker.fuenteId = d.id_fuente;
  marker.on('mouseover', () => marker.openPopup());
  marker.on('mouseout', () => marker.closePopup());
  marker.on('click', () => selectFuente(d.id_fuente));
  const target = state.singleLayer || state.markers;
  target.addLayer(marker);
}

function isValidCoord(lat, lon) {
  return lat != null && lon != null && lat >= 27 && lat <= 44 && lon >= -19 && lon <= 5;
}

function fitToFiltered() {
  const coords = state.filtered.filter(d => isValidCoord(d.lat, d.lon)).map(d => [d.lat, d.lon]);
  if (!coords.length) return;
  if (coords.length === 1) {
    state.map.setView(coords[0], 14, { animate: true });
  } else {
    const bounds = L.latLngBounds(coords);
    const mapSize = state.map.getSize();
    const offsetX = Math.round(mapSize.x * 0.15);
    state.map.fitBounds(bounds, { paddingTopLeft: [offsetX, 30], paddingBottomRight: [30, 30], animate: true });
  }
}

function fitToMunicipio(muni) {
  const coords = state.allData.filter(d => d.municipio === muni && isValidCoord(d.lat, d.lon)).map(d => [d.lat, d.lon]);
  if (!coords.length) return;
  const lat = coords.reduce((s,c) => s+c[0], 0) / coords.length;
  const lon = coords.reduce((s,c) => s+c[1], 0) / coords.length;
  state.map.setView([lat, lon], 13, { animate: true });
}

async function loadDWData() {
  try {
    const resp = await fetch('osm_drinking_water.json');
    if (!resp.ok) throw new Error('HTTP '+resp.status);
    state.dwData = await resp.json();
    return state.dwData.elements || [];
  } catch(e) {
    showToast('Error al cargar fuentes de agua potable');
    return [];
  }
}

async function toggleDWLayer() {
  state.showDW = !state.showDW;
  $('dwBtn').classList.toggle('active', state.showDW);

  if (!state.showDW) {
    if (state.dwLayer) state.map.removeLayer(state.dwLayer);
    return;
  }

  if (!state.dwData) {
    showToast('Cargando fuentes de agua potable...');
    const elements = await loadDWData();
    if (!elements.length) {
      state.showDW = false;
      $('dwBtn').classList.remove('active');
      return;
    }
    if (!state.showDW) return;
  }

  state.dwLayer.clearLayers();
  const elements = state.dwData.elements || state.dwData;
  for (const e of elements) {
    const tags = e.tags || {};
    const name = tags.name || '';
    const m = L.circleMarker([e.lat, e.lon], {
      radius: 4, fillColor: '#3498db', color: '#fff', weight: 1, fillOpacity: 0.8
    });
    const popup = `<div class="marker-popup"><b>${esc(name || 'Fuente de agua potable')}</b>${tags.operator ? '<br><small>'+esc(tags.operator)+'</small>' : ''}</div>`;
    m.bindPopup(popup, { maxWidth: 220, className: 'marker-popup-wrap', closeButton: false });
    m.on('mouseover', () => m.openPopup());
    m.on('mouseout', () => m.closePopup());
    state.dwLayer.addLayer(m);
  }
  state.map.addLayer(state.dwLayer);
  showToast(`Mostrando ${elements.length.toLocaleString()} fuentes de agua potable`);
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function selectFuente(id) {
  const idStr = String(id);
  state.activeId = idStr;
  const d = state.allData.find(x => String(x.id_fuente) === idStr);
  if (!d) return;

  if (d.lat != null) {
    state.map.setView([d.lat, d.lon], 16, { animate: true });
    renderMap();
    setTimeout(() => {
      const layer = state.singleLayer || state.markers;
      layer.eachLayer(m => {
        if (String(m.fuenteId) === idStr) m.openPopup();
      });
    }, 100);
  }

  $('active-card-name').textContent = displayName(d);
  updateHash();
  await showModal(d);
}
window.selectFuente = selectFuente;

function updateHash() {
  if (state.activeId) {
    history.replaceState(null, '', `#fuente=${state.activeId}&comm=${state.commSlug || ''}`);
  } else {
    history.replaceState(null, '', window.location.pathname);
  }
}

window.__toggleFav = function(id) {
  const fid = String(id);
  const idx = state.favorites.indexOf(fid);
  if (idx === -1) {
    state.favorites.push(fid);
  } else {
    state.favorites.splice(idx, 1);
  }
  localStorage.setItem('fuentes_favorites', JSON.stringify(state.favorites));

  const btn = $('modalFavBtn');
  if (btn) {
    const isFav = state.favorites.includes(fid);
    btn.classList.toggle('active', isFav);
    btn.textContent = isFav ? '★' : '☆';
  }
  updateUI();
};

async function showModal(d) {
  const body = $('modal-body');
  const modal = $('modal');
  const id = String(d.id_fuente);
  const gid = id;
  const isFav = state.favorites.includes(id);
  const nombre = displayName(d);
  const desc = d.descripcion || d._observaciones || d._osm_description || '';

  const fields = [
    { l:'Provincia', v:d.provincia }, { l:'Municipio', v:d.municipio },
    { l:'Pedanía', v:d.pedania }, { l:'Altitud', v:d.altitud != null ? d.altitud+' m' : null },
    { l:'Cuenca', v:d.cuenca }, { l:'Subcuenca', v:d.subcuenca },
    { l:'Río/Arroyo', v:d.rio_arroyo },
    { l:'Masa Agua Subterránea', v:d.masa_agua_subterranea },
    { l:'Sistema Acuífero', v:d.sistema_acuifero },
    { l:'Espacio Natural', v:d.espacio_natural_protegido },
    { l:'Procedencia', v:d.procedencia_lugar },
    { l:'Naturaleza Rocas', v:d.naturaleza_rocas },
    { l:'Tipo Surgencia', v:d.tipo_surgencia },
    { l:'Caudal Medio', v:d.caudal_medio != null ? d.caudal_medio+' L/s' : null },
    { l:'¿Se agota?', v:d.se_agota },
    { l:'Acceso', v:d.acceso },
    { l:'Uso Público', v:d.uso_publico_actual },
    { l:'Valoración', v:d.valoracion_instalaciones },
    { l:'Organismo', v:d.organismo && d.organismo !== 'Desconocido' ? d.organismo : null },
    { l:'Fuente', v:{igme:'IGME',osm:'OpenStreetMap',miteco:'MITECO',access_db:'Access DB'}[d._source] || d._source },
    { l:'Caudal Mín', v:d._caudal_min > 0 ? d._caudal_min+' L/s' : null },
    { l:'Caudal Máx', v:d._caudal_max > 0 ? d._caudal_max+' L/s' : null },
    { l:'Nº Mediciones', v:d._num_medidas > 0 ? d._num_medidas : null },
    { l:'Condición', v:d._condicion === 'Activo' ? d._condicion : null },
    { l:'Observaciones', v:d._miteco_obs || null },
    { l:'Agua Potable', v:d.osm_drinking_water === 'yes' ? 'Sí' : null },
    { l:'Intermitente', v:d.osm_intermittent === 'yes' ? 'Sí' : null },
    { l:'Estacional', v:d.osm_seasonal === 'yes' ? 'Sí' : null },
  ].filter(f => f.v != null && f.v !== '');

  let gridHtml = fields.map(f =>
    `<div${f.l==='Acceso'?' class="full"':''}><span class="label">${f.l}</span><div class="value">${f.v}</div></div>`
  ).join('');

  let actionsHtml = '';
  if (d.lat != null && d.lon != null) {
    actionsHtml = `<div class="modal-actions">
      <a class="btn btn-accent" href="https://www.google.com/maps?q=${d.lat},${d.lon}" target="_blank">🗺️ Google Maps</a>
      <a class="btn btn-sec" href="https://www.openstreetmap.org/?mlat=${d.lat}&mlon=${d.lon}#map=16/${d.lat}/${d.lon}" target="_blank">🗺️ OpenStreetMap</a>
      ${d.url_detalle ? `<a class="btn btn-sec" href="https://info.igme.es/BDAguas/" target="_blank" title="Buscar ${esc(d.id_fuente)} en IGME">🔗 IGME BDAGuas</a>` : ''}
    </div>`;
  }

  let nameActions = '';
  if (!d.nombre) {
    nameActions = `<div class="modal-actions" style="margin-top:4px">
      <button class="btn btn-accent" onclick="window.__suggestName('${id}')">💡 Sugerir nombre</button>
      ${d._source === 'osm' && d._osm_id ? `<button class="btn btn-sec" onclick="window.__lookupOsm('${id}')">🔍 Buscar en OSM</button>` : ''}
    </div>`;
  }

  // Photo gallery
  const hasPhotoCounts = typeof window.PHOTO_COUNTS !== 'undefined';
  let maxPhotos = 0;
  let useFallbackOnError = false;
  if (hasPhotoCounts) {
    if (id in window.PHOTO_COUNTS) {
      maxPhotos = window.PHOTO_COUNTS[id];
    } else {
      maxPhotos = 1;
      useFallbackOnError = true;
    }
  } else {
    maxPhotos = 5;
    useFallbackOnError = true;
  }

  let mainPhotoHtml = '';
  let thumbs = '';
  if (maxPhotos > 0) {
    const thumbsArray = [];
    for (let n = 1; n <= maxPhotos; n++) {
      const onerrorAttr = useFallbackOnError
        ? ` onerror="this.style.display='none';this.classList.add('missing-thumb')"`
        : '';
      thumbsArray.push(
        `<div class="gal-thumb-wrap">
          <img src="images/cf_${id}_${n}.jpg" ${onerrorAttr}
                class="gal-thumb${n===1?' active':''}"
                data-idx="${n-1}"
                onclick="window.__galGo(${n-1})">
          <button class="gal-delete-btn" onclick="event.stopPropagation();window.__galDeletePhoto(${n})" title="Eliminar foto">✕</button>
        </div>`
      );
    }
    thumbs = thumbsArray.join('');
    const mainOnerror = useFallbackOnError
      ? ` onerror="this.style.display='none';this.classList.add('missing-main')"`
      : '';
    mainPhotoHtml = `
      <button class="gal-arrow gal-prev" onclick="window.__galMove(-1)">&#9664;</button>
      <div class="gal-main-wrap">
        <img class="modal-img-inline"
             src="images/cf_${id}_1.jpg"
             ${mainOnerror}
             alt="${esc(nombre)}"
             id="modal-main-img"
             onclick="window.__galFs()">
        <div class="gal-counter" id="gal-counter"
             style="${maxPhotos > 1 ? '' : 'display:none'}">1/${maxPhotos}</div>
        <button class="gal-fs-btn"
                onclick="event.stopPropagation();window.__galFs()"
                title="Ver a pantalla completa">⛶</button>
        <button class="gal-del-main-btn"
                onclick="event.stopPropagation();var idx=window.__galIdx;if(idx!=null)window.__galDeletePhoto(idx+1)"
                title="Eliminar esta foto">🗑</button>
      </div>
      <button class="gal-arrow gal-next" onclick="window.__galMove(1)">&#9654;</button>
    `;
  }

  let descHtml = '';
  if (desc || maxPhotos > 0 || true) {
    descHtml = `<div class="modal-desc-img">
      ${maxPhotos > 0 ? `
      <div class="modal-desc-photo">
        ${mainPhotoHtml}
      </div>
      <div class="gal-thumbs" id="gal-thumbs">${thumbs}</div>
      ` : `
      <div class="modal-desc-photo" id="modal-desc-photo-empty" style="display:none">
      </div>
      `}
      <div class="gal-toolbar">
        <button class="gal-upload-btn" onclick="document.getElementById('gal-file-input').click()" title="Subir foto(s) — también Ctrl+V">📷 Subir foto</button>
        <input type="file" id="gal-file-input" multiple accept="image/*" style="display:none"
               onchange="window.__galUploadFiles(this.files);this.value=''">
        <span class="gal-srv-status" title="Estado del servidor de fotos"></span>
      </div>
      <div class="modal-desc-text">
        ${desc ? `<div class="desc-label">Descripción</div>
        <div class="desc-value">${esc(desc)}</div>` : ''}
      </div>
    </div>`;
  }

  body.innerHTML = `
    <div id="modal-info-view">
      <div class="modal-info">
        <div class="modal-title">
          ${esc(nombre)}
          <button id="modalFavBtn" class="fav-btn-modal${isFav ? ' active' : ''}" onclick="window.__toggleFav('${id}')" title="Marcar como favorito">${isFav ? '★' : '☆'}</button>
          <button class="edit-btn" onclick="window.__openEdit('${id}')" title="Editar ficha">✏️</button>
        </div>
        <div class="modal-address">${esc(d.municipio || '')}${d.pedania ? ', '+esc(d.pedania) : ''}, ${esc(d.provincia || '')}</div>
        ${nameActions}
        ${actionsHtml}
        ${descHtml}
        <div class="modal-grid">${gridHtml}</div>
      </div>
    </div>
    <div id="modal-edit-form" style="display:none">
      <h3 style="margin-bottom:8px;font-size:.85rem">✏️ Editar ficha #${id}</h3>
      <div class="edit-grid">
        ${EDIT_FIELDS.map(f => {
          const val = d[f.key] != null ? d[f.key] : '';
          if (f.key === 'provincia') {
            const provs = [...new Set(state.allData.map(x => x.provincia))].sort();
            return `<label>${f.label} <select name="${f.key}">${provs.map(p => `<option value="${esc(p)}"${p===val?' selected':''}>${esc(p)}</option>`).join('')}</select></label>`;
          }
          if (f.key === 'cuenca') {
            const cuencas = [...new Set(state.allData.map(x => x.cuenca).filter(Boolean))].sort();
            return `<label>${f.label} <select name="${f.key}"><option value="">—</option>${cuencas.map(c => `<option value="${esc(c)}"${c===val?' selected':''}>${esc(c)}</option>`).join('')}</select></label>`;
          }
          const isLong = f.key === 'descripcion' || f.key === 'acceso' || f.key === 'observaciones';
          if (isLong) return `<label class="edit-full">${f.label}<textarea name="${f.key}" rows="3">${esc(val)}</textarea></label>`;
          const isNum = f.key === 'altitud' || f.key === 'huso' || f.key === 'caudal_medio';
          return `<label>${f.label} <input type="${isNum?'number':'text'}" name="${f.key}" value="${esc(val)}"></label>`;
        }).join('')}
      </div>
      <div class="edit-actions">
        <button onclick="window.__saveEdit('${id}')" class="btn btn-accent">💾 Guardar</button>
        <span class="edit-actions-note">(solo campos modificados)</span>
        <button onclick="window.__cancelEdit()" class="btn btn-sec">Cancelar</button>
        ${getEditAction(id) ? `<button onclick="window.__deleteEdit('${id}')" class="btn btn-del" style="margin-left:auto">🗑️ Deshacer edición</button>` : ''}
      </div>
    </div>
  `;

  modal.classList.add('show');
  modal.removeAttribute('hidden');
  const mContent = modal.querySelector('.modal-content');
  if (mContent) { mContent.setAttribute('tabindex','-1'); mContent.focus(); }
  modal.scrollTop = 0;

  // Gallery navigation
  window.__galIdx = 0;
  window.__galN = maxPhotos;
  window.__galId = gid;

  window.__galGo = function(i) {
    if (window.__galId !== gid) return;
    window.__galIdx = i;
    const img = document.getElementById('modal-main-img');
    if (img) {
      img.src = `images/cf_${gid}_${i+1}.jpg`;
      img.style.display = '';
    }
    document.querySelectorAll('.gal-thumb').forEach(
      (t,j) => t.classList.toggle('active', j===i)
    );
    const counter = document.getElementById('gal-counter');
    if (counter) counter.textContent = `${i+1}/${maxPhotos}`;
  };

  window.__galMove = function(d) {
    if (window.__galId !== gid || !window.__galN) return;
    let i = window.__galIdx + d;
    if (i < 0) i = window.__galN - 1;
    if (i >= window.__galN) i = 0;
    window.__galGo(i);
  };

  window.__galFs = function() {
    if (window.__galId !== gid) return;
    const img = document.getElementById('modal-main-img');
    if (img && img.style.display !== 'none') {
      document.getElementById('fs-img').src = img.src;
      document.getElementById('fullscreen-photo').classList.add('show');
    }
  };

  // Photo management (upload/delete) — only when server is running
  window.__galCanEdit = false;

  window.__galServerCheck = function(callback) {
    fetch('/api/photos/1', { method: 'GET' })
      .then(r => {
        if (r.ok) {
          window.__galCanEdit = true;
          document.querySelectorAll('.gal-srv-status').forEach(el => { el.textContent = '●'; el.className = 'gal-srv-status online'; });
        }
        if (callback) callback(r.ok);
      })
      .catch(() => {
        document.querySelectorAll('.gal-srv-status').forEach(el => { el.textContent = '○'; el.className = 'gal-srv-status offline'; });
        if (callback) callback(false);
      });
  };

  window.__galServerCheck(function(serverOk) {
    if (serverOk) {
      window.__galRefresh();
    } else if (useFallbackOnError) {
      let loaded = 0;
      const photos = [];
      function onAllChecked() {
        window.__galN = photos.length;
        const mainImg = document.getElementById('modal-main-img');
        if (photos.length === 0) {
          if (mainImg) mainImg.style.display = 'none';
          const photoWrap = document.querySelector('.modal-desc-photo');
          if (photoWrap) photoWrap.style.display = 'none';
        } else if (mainImg) {
          mainImg.src = `images/cf_${gid}_${photos[0]}.jpg`;
          mainImg.style.display = '';
          window.__galGo(0);
        }
        document.querySelectorAll('.gal-thumb').forEach(t => t.style.display = 'none');
        photos.forEach(i => {
          const t = document.querySelector(`.gal-thumb[data-idx="${i - 1}"]`);
          if (t) t.style.display = '';
        });
        const counter = document.getElementById('gal-counter');
        if (counter) counter.textContent = photos.length > 1 ? `1/${photos.length}` : '';
        if (counter && photos.length <= 1) counter.style.display = 'none';
      }
      for (let i = 1; i <= 5; i++) {
        const p = new Image();
        p.onload = () => { loaded++; photos.push(i); if (loaded === 5) onAllChecked(); };
        p.onerror = () => { loaded++; if (loaded === 5) onAllChecked(); };
        p.src = `images/cf_${gid}_${i}.jpg`;
      }
    }
  });

  window.__galRefresh = async function() {
    if (window.__galId !== gid) return;
    try {
      const resp = await fetch('/api/photos/' + gid);
      if (!resp.ok) return;
      const data = await resp.json();
      window.__galN = data.count;
      window.PHOTO_COUNTS[gid] = data.count;

      const photoWrap = document.querySelector('.modal-desc-photo');
      const thumbsContainer = document.getElementById('gal-thumbs');

      if (data.count === 0) {
        if (photoWrap) photoWrap.style.display = 'none';
        if (thumbsContainer) thumbsContainer.innerHTML = '';
        const counter = document.getElementById('gal-counter');
        if (counter) counter.style.display = 'none';
        return;
      }

      // Rebuild gallery if it was empty (first upload)
      if (photoWrap && !document.getElementById('modal-main-img')) {
        photoWrap.style.display = '';
        photoWrap.innerHTML = `
          <button class="gal-arrow gal-prev" onclick="window.__galMove(-1)">&#9664;</button>
          <div class="gal-main-wrap">
            <img class="modal-img-inline"
                 src="images/cf_${gid}_1.jpg"
                 alt="" id="modal-main-img"
                 onclick="window.__galFs()">
            <div class="gal-counter" id="gal-counter">1/${data.count}</div>
            <button class="gal-fs-btn"
                    onclick="event.stopPropagation();window.__galFs()"
                    title="Ver a pantalla completa">⛶</button>
            <button class="gal-del-main-btn"
                    onclick="event.stopPropagation();window.__galDeletePhoto(window.__galIdx+1)"
                    title="Eliminar esta foto">🗑</button>
          </div>
          <button class="gal-arrow gal-next" onclick="window.__galMove(1)">&#9654;</button>
        `;
      } else if (photoWrap) {
        photoWrap.style.display = '';
        const mainImg = document.getElementById('modal-main-img');
        if (mainImg) {
          mainImg.src = `images/cf_${gid}_1.jpg`;
          mainImg.style.display = '';
        }
      }

      if (thumbsContainer) {
        thumbsContainer.innerHTML = data.photos.map((n, i) =>
          `<div class="gal-thumb-wrap">
            <img src="images/cf_${gid}_${n}.jpg"
                 class="gal-thumb${i===0?' active':''}"
                 data-idx="${i}"
                 onclick="window.__galGo(${i})">
            <button class="gal-delete-btn" onclick="event.stopPropagation();window.__galDeletePhoto(${n})" title="Eliminar foto">✕</button>
          </div>`
        ).join('');
      }

      const counter = document.getElementById('gal-counter');
      if (counter) {
        counter.textContent = `1/${data.count}`;
        counter.style.display = data.count > 1 ? '' : 'none';
      }
      window.__galGo(0);
    } catch(e) { /* server not available */ }
  };

  window.__galDeletePhoto = async function(n) {
    if (!confirm('¿Eliminar esta foto?')) return;
    try {
      const resp = await fetch(`/api/photos/${gid}/${n}`, { method: 'DELETE' });
      if (!resp.ok) { showToast('Error al eliminar'); return; }
      showToast('Foto eliminada');
      await window.__galRefresh();
    } catch(e) { showToast('Error: servidor no disponible'); }
  };

  window.__galUploadFiles = async function(files) {
    if (!files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('photos', f);
    try {
      showToast(`Subiendo ${files.length} foto(s)...`);
      const resp = await fetch('/api/photos/' + gid, { method: 'POST', body: fd });
      if (!resp.ok) { showToast('Error al subir'); return; }
      showToast('Foto(s) subida(s)');
      await window.__galRefresh();
    } catch(e) { showToast('Error: servidor no disponible'); }
  };
}

function renderSidePanelSkeleton() {
  const list = $('sideList');
  const panel = $('sidePanel');
  if (!list || !panel) return;
  panel.classList.remove('collapsed');
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += `<div class="side-item" style="animation:none;border:none;padding:.4rem .5rem">
      <div class="skeleton skeleton-img" style="width:36px;height:36px;border-radius:6px;flex-shrink:0"></div>
      <div class="side-item-info">
        <div class="skeleton skeleton-text" style="width:${60 + Math.random()*30}%;height:10px;margin-bottom:5px"></div>
        <div class="skeleton skeleton-text" style="width:${40 + Math.random()*30}%;height:8px"></div>
      </div>
    </div>`;
  }
  list.innerHTML = s;
}

function renderSidePanel() {
  const list = $('sideList');
  const panel = $('sidePanel');

  const hasFilter = state.comunidad || state.provincia || state.cuenca || state.searchTerm || state.showFavoritesOnly || state.userCoords;
  if (!hasFilter) {
    list.innerHTML = '<div style="padding:.5rem;font-size:.72rem;color:var(--sub);text-align:center">Selecciona una provincia/cuenca, busca por nombre o usa el GPS</div>';
    panel.classList.add('collapsed');
    return;
  }

  panel.classList.remove('collapsed');

  const maxRender = 200;
  const itemsToRender = state.filtered.slice(0, maxRender);

  let listHtml = itemsToRender.map(d => {
    const nombre = displayName(d);
    const distText = d._distance && d._distance !== Infinity
      ? ` · <b style="color:var(--accent)">📍 ${d._distance.toFixed(1)} km</b>`
      : '';
    const id = String(d.id_fuente);
    const hasPhoto = window.PHOTO_COUNTS && window.PHOTO_COUNTS[id];
    const imgHtml = hasPhoto
      ? `<img src="images/cf_${id}_1.jpg" onerror="this.style.display='none'" class="side-item-img">`
      : `<div class="side-item-img" style="display:flex;align-items:center;justify-content:center;font-size:1rem;background:var(--bg)">💧</div>`;

    return `
      <div class="side-item${String(d.id_fuente) === state.activeId ? ' active' : ''}" data-id="${d.id_fuente}" onclick="window.selectFuente('${d.id_fuente}')">
        ${imgHtml}
        <div class="side-item-info">
          <div class="side-item-name">${esc(nombre)}</div>
          <div class="side-item-muni">${esc(d.municipio)}, ${esc(d.provincia)}${distText}</div>
          ${d.tipo_surgencia ? `<div class="side-item-type">${esc(d.tipo_surgencia)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  if (state.filtered.length > maxRender) {
    listHtml += `<div style="padding:.6rem;font-size:.65rem;color:var(--muted);text-align:center;border-top:1px solid var(--border)">Mostrando primeros ${maxRender} de ${state.filtered.length} resultados</div>`;
  } else if (state.filtered.length === 0) {
    listHtml = '<div style="padding:1rem;font-size:.72rem;color:var(--muted);text-align:center">No se encontraron resultados</div>';
  }

  list.innerHTML = listHtml;
  $('sideTitle').textContent = `Resultados (${state.filtered.length})`;
}

function updateStats() {
  $('statTotal').textContent = state.allData.length.toLocaleString() + ' fuentes';
  $('statFiltered').textContent = state.filtered.length.toLocaleString() + ' mostradas';
}

function buildFilters() {
  const comms = state.commIndex && state.commIndex.communities;
  const hasFiles = comms && !state._isLegacy;

  const commSel = $('commSelect');
  if (commSel) {
    commSel.addEventListener('change', async e => {
      const slug = e.target.value;
      state.provincia = '';
      state.municipio = '';
      state.cuenca = '';
      if ($('provSelect')) $('provSelect').value = '';
      if ($('muniSelect')) $('muniSelect').value = '';
      if ($('cuencaSelect')) $('cuencaSelect').value = '';

      if (!slug) {
        state.allData = [];
        state.filtered = [];
        state.comunidad = '';
        state.commSlug = null;
        localStorage.removeItem(STATE_COMM_KEY);
        state.map.setView([40.0, -3.5], 6.5, { animate: true });
        renderMap();
        renderSidePanel();
        updateStats();
        updateHash();
        return;
      }

      if (hasFiles) {
        await loadCommunity(slug);
      } else {
        showLoading('Filtrando...');
        await new Promise(r => setTimeout(r, 50));
        const comm = comms.find(c => c.slug === slug);
        state.comunidad = comm ? comm.name : slug;
        state.commSlug = slug;
        const provNames = comm ? new Set(comm.provinces.map(p => normalizeKey(p.name))) : new Set();
        state.allData = provNames.size ? (state._allData || []).filter(d => provNames.has(normalizeKey(d.provincia))) : (state._allData || []);
        state.provincia = '';
        state.municipio = '';
        state.cuenca = '';
        populateProvSelect();
        populateMuni();
        populateCuenca();
        applyFilters();
        renderSidePanel();
        state.map.invalidateSize();
        renderMapAll();
        fitToFiltered();
        updateStats();
        updateHash();
        hideLoading();
      }
    });

    if (state.commSlug) {
      commSel.value = state.commSlug;
    }
  }

  const provSel = $('provSelect');
  if (provSel) {
    populateProvSelect();
    provSel.addEventListener('change', e => {
      state.provincia = e.target.value;
      state.municipio = '';
      state.cuenca = '';
      if ($('muniSelect')) $('muniSelect').value = '';
      if ($('cuencaSelect')) $('cuencaSelect').value = '';
      if (!state.allData.length && state._allData && state._allData.length) {
        state.allData = state._allData;
      }
      populateMuni();
      populateCuenca();
      applyFilters();
      renderSidePanel();
      state.map.invalidateSize();
      if (state.provincia || state.cuenca) { renderMapAll(); fitToFiltered(); }
      else if (state.comunidad) { renderMapAll(); fitToFiltered(); }
      else { state.map.setView([40.0, -3.5], 6.5, { animate: true }); renderMap(); }
      updateStats();
      updateHash();
    });
  }
}

function populateProvSelect() {
  const sel = $('provSelect');
  if (!sel) return;

  let provs = [];
  if (state.commSlug && state.commIndex) {
    const comm = state.commIndex.communities.find(c => c.slug === state.commSlug);
    if (comm && comm.provinces) {
      provs = comm.provinces.map(p => p.name);
    }
  } else if (state._allData && state._allData.length) {
    // Legacy: derive from full data
    provs = [...new Set(state._allData.map(d => d.provincia).filter(Boolean))].sort();
  } else if (state.allData.length) {
    provs = [...new Set(state.allData.map(d => d.provincia).filter(Boolean))].sort();
  }

  sel.innerHTML = '<option value="">Todas las provincias</option>' +
    provs.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');

  if (state.provincia) {
    sel.value = state.provincia;
  }
}

function populateMuni() {
  let data = state.allData;
  if (state.provincia) data = data.filter(d => d.provincia === state.provincia);
  const muniCounts = {};
  data.forEach(d => { if (d.municipio) muniCounts[d.municipio] = (muniCounts[d.municipio] || 0) + 1; });
  const munis = Object.keys(muniCounts).sort();
  const mSel = $('muniSelect');
  if (mSel) mSel.innerHTML = '<option value="">Municipio</option>' + munis.map(m => `<option value="${esc(m)}">${esc(m)} (${muniCounts[m]})</option>`).join('');
}

function populateCuenca() {
  let data = state.allData;
  if (state.provincia) data = data.filter(d => d.provincia === state.provincia);
  const cuencaCounts = {};
  data.forEach(d => { if (d.cuenca) cuencaCounts[d.cuenca] = (cuencaCounts[d.cuenca] || 0) + 1; });
  const cuencas = Object.keys(cuencaCounts).sort();
  const cSel = $('cuencaSelect');
  if (cSel) cSel.innerHTML = '<option value="">Cuenca</option>' + cuencas.map(c => `<option value="${esc(c)}">${esc(c)} (${cuencaCounts[c]})</option>`).join('');
}

function initSidePanel() {
  $('sideClose').onclick = () => $('sidePanel').classList.add('collapsed');
  $('map').addEventListener('click', () => {
    if (window.innerWidth <= 768 && !$('sidePanel').classList.contains('collapsed')) $('sidePanel').classList.add('collapsed');
  });
}

function initLegal() {
  if (!localStorage.getItem('cookies_accepted')) $('cookie-banner').style.display = 'block';
  $('cb-accept').onclick = () => { localStorage.setItem('cookies_accepted','1'); $('cookie-banner').style.display='none'; };
  $('cb-info').onclick = () => showLegal('cookies');
  $('link-legal').onclick = e => { e.preventDefault(); showLegal('legal'); };
  $('link-privacy').onclick = e => { e.preventDefault(); showLegal('privacy'); };
  $('link-cookies').onclick = e => { e.preventDefault(); showLegal('cookies'); };
}

function showLegal(section) {
  const modal = $('legal-modal');
  const texts = {
    legal: '<h2>Aviso Legal</h2><p>Información sobre manantiales y fuentes de España con fines divulgativos. Datos: IGME (Instituto Geológico y Minero de España).</p>',
    privacy: '<h2>Privacidad</h2><p>App 100% offline. No recopilamos ni compartimos datos. Todo se almacena localmente (IndexedDB/localStorage).</p>',
    cookies: '<h2>Cookies</h2><p>Solo almacenamiento local para preferencias. Sin cookies de rastreo ni terceros.</p>'
  };
  $('legal-body').innerHTML = texts[section] || '';
  modal.style.display = 'block';
  modal.querySelector('.modal-close').onclick = () => { modal.style.display = 'none'; };
  modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
}

$('modal')?.querySelector('.close-btn')?.addEventListener('click', () => { const m = $('modal'); if (m) { m.classList.remove('show'); m.setAttribute('hidden',''); } });
$('modal')?.addEventListener('click', e => { if (e.target === $('modal')) { const m = $('modal'); if (m) { m.classList.remove('show'); m.setAttribute('hidden',''); } } });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const fsPhoto = $('fullscreen-photo');
    if (fsPhoto && fsPhoto.classList.contains('show')) {
      fsPhoto.classList.remove('show');
    } else {
      const m = $('modal');
      if (m) { m.classList.remove('show'); m.setAttribute('hidden',''); }
    }
    return;
  }
  if (e.key === 'ArrowLeft' && typeof window.__galMove === 'function') {
    e.preventDefault();
    window.__galMove(-1);
  }
  if (e.key === 'ArrowRight' && typeof window.__galMove === 'function') {
    e.preventDefault();
    window.__galMove(1);
  }
});

document.addEventListener('paste', e => {
  const modal = $('modal');
  if (!modal || !modal.classList.contains('show')) return;
  if (typeof window.__galUploadFiles !== 'function') return;
  const items = e.clipboardData?.items;
  if (items) {
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          const file = new File([blob], `pasted_${Date.now()}.png`, { type: blob.type });
          showToast('Pegando imagen...');
          window.__galUploadFiles([file]);
        }
        return;
      }
    }
  }
  // Ensure modal-content is focused (helps clipboard access in some browsers)
  const mc = modal.querySelector('.modal-content');
  if (mc && document.activeElement !== mc) mc.focus();
  // Fallback: navigator.clipboard.read() for browsers without clipboardData items
  try {
    navigator.clipboard.read().then(clips => {
      for (const c of clips) {
        for (const t of c.types) {
          if (t.startsWith('image/')) {
            c.getType(t).then(blob => {
              const file = new File([blob], `pasted_${Date.now()}.png`, { type: t });
              showToast('Pegando imagen...');
              if (typeof window.__galUploadFiles === 'function')
                window.__galUploadFiles([file]);
            });
            return;
          }
        }
      }
    }).catch(() => {});
  } catch(_) {}
});

function showLoading(msg) { const el = $('loading'); if (el) el.style.display = 'flex'; $('loading-text').textContent = msg || 'Cargando...'; }
function hideLoading() { const el = $('loading'); if (el) el.style.display = 'none'; }

function initSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

(async function init() {
  try {
    initMap();
    try { await initData(); } catch(e) {
      $('loading').innerHTML = '<div style="color:var(--accent);font-size:1.2rem">⚠️</div><p>Error: '+esc(e.message)+'</p>';
      return;
    }
    buildFilters();
    initSidePanel();
    updateUI();
    initLegal();
    initSW();
    hideLoading();

    function on(sel, ev, fn) {
      const el = $(sel);
      if (el) el.addEventListener(ev, fn);
    }
    on('muniSelect','change', e => {
      state.municipio = e.target.value;
      applyFilters();
      if (state.comunidad || state.provincia || state.cuenca) { renderMapAll(); if (state.municipio) fitToMunicipio(state.municipio); else fitToFiltered(); }
      else renderMap();
      updateStats();
      updateHash();
      renderSidePanel();
    });
    on('cuencaSelect','change', e => {
      state.cuenca = e.target.value;
      state.municipio = '';
      if ($('muniSelect')) $('muniSelect').value = '';
      populateMuni();
      applyFilters();
      renderSidePanel();
      state.map.invalidateSize();
      if (state.cuenca) { renderMapAll(); fitToFiltered(); }
      else if (state.comunidad || state.provincia) { renderMapAll(); fitToFiltered(); }
      else { state.map.setView([40.0, -3.5], 6.5, { animate: true }); renderMap(); }
      updateStats();
      updateHash();
    });
    let searchTimer = null;
    on('textSearch','input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.searchTerm = normalizeStr(e.target.value);
        updateUI();
      }, 250);
    });
    on('favsToggleBtn','click', () => {
      state.showFavoritesOnly = !state.showFavoritesOnly;
      if ($('favsToggleBtn')) $('favsToggleBtn').classList.toggle('active', state.showFavoritesOnly);
      updateUI();
    });

    const hashMatch = location.hash.match(/fuente=([^&]+)/);
    const hashId = hashMatch?.[1];
    const hashComm = location.hash.match(/comm=([^&]+)/)?.[1];

    if (hashId) {
      if (hashComm && hashComm !== state.commSlug) {
        const comms = state.commIndex && state.commIndex.communities;
        const match = comms?.find(c => c.slug === hashComm);
        if (match) {
          state.comunidad = match.name;
          state.commSlug = match.slug;
          if ($('commSelect')) $('commSelect').value = match.slug;
          await loadCommunity(match.slug);
        }
      }
      const data = state.allData.length > 0 ? state.allData : (state._allData || []);
      const found = data.find(d => String(d.id_fuente) === hashId);
      if (found) {
        setTimeout(() => selectFuente(hashId), 400);
      }
    }
  } catch(e) {
    $('loading').innerHTML = '<div style="color:var(--accent);font-size:1.2rem">⚠️</div><p>Error en init: '+esc(e.message)+'</p>';
    console.error(e);
  }
})();

})();
