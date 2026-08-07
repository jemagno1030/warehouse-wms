import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { BrowserMultiFormatReader, BrowserCodeReader } from 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm';

const cfg = window.WMS_CONFIG || {};
const configReady = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
  && !cfg.SUPABASE_URL.includes('YOUR-PROJECT')
  && !cfg.SUPABASE_ANON_KEY.includes('YOUR-PUBLISHABLE');

const supabase = configReady
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;

const $ = (id) => document.getElementById(id);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const fmtQty = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
const fmtDate = (value) => value ? new Date(`${value}T00:00:00`).toLocaleDateString() : '—';
const fmtDateTime = (value) => value ? new Date(value).toLocaleString() : '—';
const normalizeLocation = (value) => String(value || '').trim().replace(/^LOC:/i, '').toUpperCase();
const normalizeBarcode = (value) => String(value || '').trim().toUpperCase() === 'N/A' ? 'N/A' : String(value || '').trim();
const uomLabel = (uom) => ({ PIECE: 'piece', PACK: 'pack', CASE: 'case' }[String(uom || '').toUpperCase()] || String(uom || 'unit').toLowerCase());
const fmtQtyUom = (qty, uom) => `${fmtQty(qty)} ${uomLabel(uom)}${Number(qty) === 1 ? '' : 's'}`;
const sumByUom = (rows, qtyKey = 'qty') => rows.reduce((totals, row) => {
  const uom = String(row.uom || 'PIECE').toUpperCase();
  totals[uom] = (totals[uom] || 0) + Number(row[qtyKey] || 0);
  return totals;
}, { PIECE: 0, PACK: 0, CASE: 0 });
const formatBalances = (balances) => ['CASE', 'PACK', 'PIECE']
  .filter((uom) => Number(balances[uom] || 0) !== 0)
  .map((uom) => fmtQtyUom(balances[uom], uom))
  .join(' · ') || '0 stock';
const balanceColumns = (row, prefix) => ({
  PIECE: Number(row[`${prefix}_piece_qty`] || 0),
  PACK: Number(row[`${prefix}_pack_qty`] || 0),
  CASE: Number(row[`${prefix}_case_qty`] || 0)
});
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[c]));

const locationRowKey = (row) => {
  if (row?.is_pending) return 'PENDING';
  if (row?.row_label) return String(row.row_label).toUpperCase();
  const match = String(row?.location_code || row?.code || '').match(/^([A-Z]+)\d+$/i);
  return match ? match[1].toUpperCase() : 'OTHER';
};
const locationNumber = (row) => {
  const source = String(row?.bay_label || row?.location_code || row?.code || '');
  const match = source.match(/(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};
const sortLocations = (rows) => [...rows].sort((a, b) => {
  const aOrder = Number.isFinite(Number(a.sort_order)) && a.sort_order !== null ? Number(a.sort_order) : Number.MAX_SAFE_INTEGER;
  const bOrder = Number.isFinite(Number(b.sort_order)) && b.sort_order !== null ? Number(b.sort_order) : Number.MAX_SAFE_INTEGER;
  if (aOrder !== bOrder) return aOrder - bOrder;
  const rowCompare = locationRowKey(a).localeCompare(locationRowKey(b), undefined, { numeric: true });
  if (rowCompare) return rowCompare;
  const numberCompare = locationNumber(a) - locationNumber(b);
  if (numberCompare) return numberCompare;
  return String(a.location_code || a.code || '').localeCompare(String(b.location_code || b.code || ''), undefined, { numeric: true });
});

let putawayDetailsTimer = null;

const state = {
  session: null,
  profile: null,
  mode: 'ACTIVE',
  currentScreen: 'dashboard',
  realtimeChannel: null,
  scanner: { reader: null, controls: null, target: null, kind: null },
  putaway: { locationCode: null, cart: [], matchedSkuId: null, duplicateDetailsSkuId: null, lookupSequence: 0 },
  pick: freshOperationState(),
  pickOrder: { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false },
  pickOrderLookupSequence: 0,
  pickOrderSummary: [],
  transfer: freshOperationState(),
  data: { inventory: [], containers: [], expiry: [], history: [], audit: [], locations: [], rackMap: [] },
  selectedQrLocations: new Set()
};

function freshOperationState() {
  return { lockToken: null, locationCode: null, heartbeat: null, cart: [], lots: [], rackLots: [], sku: null };
}

const screenMeta = {
  dashboard: ['Dashboard', 'Live warehouse overview'],
  putaway: ['Put-away', 'Receive pallet contents into a rack location'],
  picking: ['Picking', 'FEFO-guided picking by source location'],
  transfer: ['Stock transfer', 'Move stock lots between rack locations'],
  inventory: ['Inventory', 'Stock by SKU, container, expiry, and location'],
  containers: ['Containers', 'Container consumption and remaining contents'],
  rackmap: ['Rack map', 'Visual location occupancy and active locks'],
  expiry: ['Expiry alerts', 'Expired and near-expiry stock'],
  history: ['History', 'Complete transaction and correction trail'],
  locations: ['Locations & QR', 'Rack master data and printable labels'],
  control: ['System control', 'Discreet global operational control']
};

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('toast-root').appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function friendlyError(error) {
  const message = error?.message || String(error || 'Unknown error');
  return message.replace(/^.*?error:\s*/i, '').replace(/PGRST\d+:/g, '').trim();
}

function setBusy(button, busy, text = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function isSupervisor() {
  return ['supervisor', 'admin'].includes(state.profile?.role);
}

function setupStaticEvents() {
  qsa('[data-auth-tab]').forEach((btn) => btn.addEventListener('click', () => {
    qsa('[data-auth-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    $('login-form').classList.toggle('hidden', btn.dataset.authTab !== 'login');
    $('signup-form').classList.toggle('hidden', btn.dataset.authTab !== 'signup');
  }));

  $('login-form').addEventListener('submit', login);
  $('signup-form').addEventListener('submit', signup);
  $('logout-btn').addEventListener('click', logout);
  $('menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('refresh-btn').addEventListener('click', () => loadScreen(state.currentScreen, true));

  qsa('#main-nav [data-screen]').forEach((btn) => btn.addEventListener('click', () => showScreen(btn.dataset.screen)));
  qsa('[data-jump]').forEach((btn) => btn.addEventListener('click', () => showScreen(btn.dataset.jump)));
  qsa('[data-reset-form]').forEach((btn) => btn.addEventListener('click', () => $(btn.dataset.resetForm).reset()));
  qsa('.scan-btn').forEach((btn) => btn.addEventListener('click', () => openScanner(btn.dataset.scanTarget, btn.dataset.scanKind || 'barcode')));
  qsa('.na-btn').forEach((btn) => btn.addEventListener('click', () => {
    const target = $(btn.dataset.naTarget);
    target.value = 'N/A';
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }));
  qsa('.export-btn').forEach((btn) => btn.addEventListener('click', () => exportDataset(btn.dataset.export)));

  $('putaway-form').addEventListener('submit', addPutawayItem);
  $('pa-clear-line-btn').addEventListener('click', clearPutawayLine);
  $('pa-cancel-btn').addEventListener('click', resetPutawaySession);
  $('pa-complete-btn').addEventListener('click', completePutaway);
  ['pa-piece', 'pa-pack', 'pa-case'].forEach((id) => $(id).addEventListener('change', resolvePutawaySku));
  ['pa-brand', 'pa-description', 'pa-variant', 'pa-size'].forEach((id) => $(id).addEventListener('input', () => {
    clearTimeout(putawayDetailsTimer);
    putawayDetailsTimer = setTimeout(checkPutawayDuplicateDetails, 350);
  }));

  $('pick-lock-btn').addEventListener('click', lockPickLocation);
  $('pick-so').addEventListener('change', refreshPickSalesOrderStatus);
  $('pick-so').addEventListener('blur', refreshPickSalesOrderStatus);
  $('pick-so-override').addEventListener('change', syncPickOverrideControls);
  $('pick-barcode').addEventListener('change', () => loadOperationLots('pick'));
  $('pick-lot').addEventListener('change', () => { updatePickFefoNote(); updatePickQtyNote(); });
  $('pick-qty').addEventListener('input', updatePickQtyNote);
  $('pick-add-btn').addEventListener('click', () => addOperationItem('pick'));
  $('pick-cancel-btn').addEventListener('click', () => cancelOperation('pick'));
  $('pick-complete-btn').addEventListener('click', completePicking);
  $('pick-finish-so-btn').addEventListener('click', finishPickSalesOrder);
  $('pick-summary-refresh-btn').addEventListener('click', loadPickSalesOrderSummary);

  $('tr-lock-btn').addEventListener('click', lockTransferLocation);
  $('tr-barcode').addEventListener('change', () => loadOperationLots('transfer'));
  $('tr-add-btn').addEventListener('click', () => addOperationItem('transfer'));
  $('tr-cancel-btn').addEventListener('click', () => cancelOperation('transfer'));
  $('tr-complete-btn').addEventListener('click', completeTransfer);

  $('inventory-search').addEventListener('input', renderInventory);
  $('container-search').addEventListener('input', renderContainers);
  $('history-search').addEventListener('input', renderHistory);
  $('history-type').addEventListener('change', renderHistory);
  $('rack-map-row').addEventListener('change', renderRackMap);
  $('rack-map-search').addEventListener('input', renderRackMap);

  $('location-form').addEventListener('submit', addLocation);
  $('location-search').addEventListener('input', renderLocationsTable);
  $('location-row-filter').addEventListener('change', renderLocationsTable);
  $('select-visible-qr-btn').addEventListener('click', selectVisibleQrLocations);
  $('clear-qr-btn').addEventListener('click', clearQrSelection);
  $('print-qr-btn').addEventListener('click', printSelectedQrLabels);
  $('admin-code-btn').addEventListener('click', applyAdministrativeCode);

  $('scanner-close').addEventListener('click', closeScanner);
  $('camera-start').addEventListener('click', startCamera);
  $('camera-select').addEventListener('change', startCamera);
  $('manual-scan-form').addEventListener('submit', (event) => {
    event.preventDefault();
    acceptScannedValue($('manual-scan-input').value);
  });
  $('scanner-dialog').addEventListener('close', stopCamera);

  $('edit-close').addEventListener('click', () => $('edit-dialog').close());
  $('edit-transaction-form').addEventListener('submit', submitSupervisorEdit);

  document.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-cart]');
    if (remove) removeCartItem(remove.dataset.operation, Number(remove.dataset.removeCart));
    const removePutaway = event.target.closest('[data-remove-putaway]');
    if (removePutaway) removePutawayItem(Number(removePutaway.dataset.removePutaway));
    const detail = event.target.closest('[data-container-detail]');
    if (detail) showContainerDetail(detail.dataset.containerDetail);
    const edit = event.target.closest('[data-edit-transaction]');
    if (edit) openSupervisorEdit(edit.dataset.editTransaction);
    const bypassPick = event.target.closest('[data-pick-bypass-lot]');
    if (bypassPick) addSupervisorBarcodeBypass(bypassPick.dataset.pickBypassLot);
    const qr = event.target.closest('[data-qr-location]');
    if (qr) toggleQrSelection(qr.dataset.qrLocation, qr.checked);
  });

  window.addEventListener('beforeunload', () => {
    // The server-side two-minute expiry is the safety net when a browser closes abruptly.
    stopHeartbeat(state.pick);
    stopHeartbeat(state.transfer);
  });
}

async function init() {
  setupStaticEvents();
  $('app-name').textContent = cfg.APP_NAME || 'Warehouse Control System v1';
  if (cfg.ALLOW_SIGNUP === false) {
    qsa('[data-auth-tab="signup"]').forEach((node) => node.classList.add('hidden'));
  }

  if (!configReady) {
    $('login-form').insertAdjacentHTML('afterbegin', '<div class="warning-box">Open <code>config.js</code> and paste your Supabase URL and publishable anon key first.</div>');
    qsa('#login-form button, #signup-form button').forEach((b) => b.disabled = true);
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  await handleSession(session);
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    setTimeout(() => handleSession(nextSession), 0);
  });
}

async function login(event) {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, true, 'Signing in…');
  const { error } = await supabase.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value
  });
  setBusy(button, false);
  if (error) toast(friendlyError(error), 'error');
}

async function signup(event) {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, true, 'Creating…');
  const { data, error } = await supabase.auth.signUp({
    email: $('signup-email').value.trim(),
    password: $('signup-password').value,
    options: { data: { username: $('signup-username').value.trim() } }
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');
  if (!data.session) toast('Account created. Check your email if confirmation is enabled.', 'success');
  else toast('Account created and signed in.', 'success');
}

async function logout() {
  resetPutawaySession();
  await cancelOperation('pick', true);
  await cancelOperation('transfer', true);
  await supabase.auth.signOut();
}

async function handleSession(session) {
  state.session = session;
  if (!session) {
    state.profile = null;
    $('auth-view').classList.remove('hidden');
    $('app-view').classList.add('hidden');
    unsubscribeRealtime();
    return;
  }

  const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
  if (error) {
    toast(`Profile could not be loaded: ${friendlyError(error)}`, 'error');
    return;
  }
  if (!profile.is_active) {
    toast('This account is inactive.', 'error');
    await supabase.auth.signOut();
    return;
  }

  state.profile = profile;
  $('current-username').textContent = profile.username;
  $('current-role').textContent = profile.role;
  qsa('[data-role-min="supervisor"]').forEach((node) => node.classList.toggle('hidden', !isSupervisor()));
  $('auth-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  await loadSystemMode();
  subscribeRealtime();

  const savedScreen = getSavedScreen();
  showScreen(canOpenScreen(savedScreen) ? savedScreen : 'dashboard');
}

async function loadSystemMode() {
  const { data, error } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  if (error) return toast(friendlyError(error), 'error');
  applyMode(data.operational_mode);
}

function applyMode(mode) {
  state.mode = mode;
  const active = mode === 'ACTIVE';
  $('system-state-chip').textContent = active ? 'Operational' : 'Administrative Pause';
  $('system-state-chip').className = `status-chip ${active ? 'active' : 'hold'}`;
  $('hold-banner').classList.toggle('hidden', active);
  $('pick-lock-btn').disabled = !active || Boolean(state.pick.lockToken);
  $('tr-lock-btn').disabled = !active || Boolean(state.transfer.lockToken);
  const putawaySubmit = $('putaway-form').querySelector('button[type="submit"]');
  putawaySubmit.disabled = !active;
  if (state.putaway.cart.length) $('pa-complete-btn').disabled = !active;
  if (state.pick.lockToken) $('pick-complete-btn').disabled = !active;
  updatePickSalesOrderControls();
  if (state.transfer.lockToken) $('tr-complete-btn').disabled = !active;
}

function subscribeRealtime() {
  unsubscribeRealtime();
  state.realtimeChannel = supabase.channel('wms-global-state')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_settings', filter: 'id=eq.1' },
      (payload) => applyMode(payload.new.operational_mode))
    .subscribe();
}

function unsubscribeRealtime() {
  if (state.realtimeChannel && supabase) supabase.removeChannel(state.realtimeChannel);
  state.realtimeChannel = null;
}

function screenStorageKey() {
  return state.session?.user?.id ? `wms:last-screen:${state.session.user.id}` : null;
}

function getSavedScreen() {
  const key = screenStorageKey();
  if (!key) return 'dashboard';
  try {
    return localStorage.getItem(key) || 'dashboard';
  } catch (_) {
    return 'dashboard';
  }
}

function saveCurrentScreen(name) {
  const key = screenStorageKey();
  if (!key) return;
  try { localStorage.setItem(key, name); } catch (_) { /* Browser storage can be unavailable. */ }
}

function canOpenScreen(name) {
  if (!name || !screenMeta[name] || !$(`screen-${name}`)) return false;
  if (['locations', 'control'].includes(name) && !isSupervisor()) return false;
  return true;
}

function showScreen(name) {
  if (!canOpenScreen(name)) {
    if (['locations', 'control'].includes(name) && !isSupervisor()) toast('Supervisor access is required.', 'error');
    name = 'dashboard';
  }
  state.currentScreen = name;
  saveCurrentScreen(name);
  qsa('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  qsa('#main-nav [data-screen]').forEach((b) => b.classList.toggle('active', b.dataset.screen === name));
  const [title, subtitle] = screenMeta[name] || [name, ''];
  $('screen-title').textContent = title;
  $('screen-subtitle').textContent = subtitle;
  $('sidebar').classList.remove('open');
  loadScreen(name);
}

async function loadScreen(name, force = false) {
  try {
    if (name === 'dashboard') await loadDashboard();
    if (name === 'picking') await refreshPickSalesOrderStatus();
    if (name === 'inventory') await loadInventory(force);
    if (name === 'containers') await loadContainers(force);
    if (name === 'rackmap') await loadRackMap(force);
    if (name === 'expiry') await loadExpiry(force);
    if (name === 'history') await loadHistory(force);
    if (name === 'locations') await loadLocations(force);
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

async function loadDashboard() {
  const [inventoryRes, locationRes, historyRes] = await Promise.all([
    supabase.from('v_inventory_details').select('*').limit(5000),
    supabase.from('v_location_summary').select('*').limit(5000),
    supabase.from('v_history_details').select('*').order('created_at', { ascending: false }).limit(12)
  ]);
  [inventoryRes, locationRes, historyRes].forEach((r) => { if (r.error) throw r.error; });
  const inventory = inventoryRes.data || [];
  const locations = locationRes.data || [];
  const attention = inventory.filter((r) => r.expiry_status !== 'OK');
  const containers = new Set(inventory.map((r) => r.container_no));
  const physicalLocations = locations.filter((r) => !r.is_pending);
  const occupied = physicalLocations.filter((r) => Number(r.total_piece_qty) > 0 || Number(r.total_pack_qty) > 0 || Number(r.total_case_qty) > 0).length;
  const locked = physicalLocations.filter((r) => r.is_locked).length;

  $('dashboard-kpis').innerHTML = [
    ['Stock balances', formatBalances(sumByUom(inventory))],
    ['Occupied rack locations', `${occupied} / ${physicalLocations.length}`],
    ['Active containers', containers.size],
    ['Expiry attention', attention.length]
  ].map(([label, value]) => `<div class="kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  $('dashboard-expiry').innerHTML = attention.length ? miniTable(attention.slice(0, 6), [
    ['Status', (r) => expiryPill(r.expiry_status)],
    ['SKU', (r) => escapeHtml(r.sku_name)],
    ['Expiry', (r) => fmtDate(r.expiry_date)],
    ['Location', (r) => escapeHtml(r.location_code)]
  ]) : emptyState('No expired or near-expiry stock.');

  const distinctHistory = uniqueBy(historyRes.data || [], (r) => r.transaction_id).slice(0, 6);
  $('dashboard-history').innerHTML = distinctHistory.length ? miniTable(distinctHistory, [
    ['Transaction', (r) => escapeHtml(r.tx_no)],
    ['Action', (r) => escapeHtml(r.transaction_type)],
    ['User', (r) => escapeHtml(r.created_by_username)],
    ['Time', (r) => fmtDateTime(r.created_at)]
  ]) : emptyState('No transactions yet.');

  if (locked) toast(`${locked} location${locked === 1 ? '' : 's'} currently locked for active work.`);
}

function miniTable(rows, columns) {
  return `<div class="table-wrap"><table><thead><tr>${columns.map(([h]) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map(([, fn]) => `<td>${fn(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function uniqueBy(rows, keyFn) {
  const seen = new Set();
  return rows.filter((row) => { const key = keyFn(row); if (seen.has(key)) return false; seen.add(key); return true; });
}

function invalidateReports() {
  state.data.inventory = [];
  state.data.containers = [];
  state.data.expiry = [];
  state.data.history = [];
  state.data.audit = [];
  state.data.rackMap = [];
}

function emptyState(message) { return `<div class="empty-state">${escapeHtml(message)}</div>`; }
function expiryPill(status) {
  if (status === 'EXPIRED') return '<span class="pill expired">Expired</span>';
  if (status === 'NEAR_EXPIRY') return '<span class="pill near">Near expiry</span>';
  return '<span class="pill">OK</span>';
}

function setPutawayDetailsReadonly(readonly) {
  ['pa-brand', 'pa-description', 'pa-variant', 'pa-size'].forEach((id) => { $(id).readOnly = readonly; });
}

function hidePutawayDuplicateWarning() {
  state.putaway.duplicateDetailsSkuId = null;
  $('pa-duplicate-warning').classList.add('hidden');
  $('pa-duplicate-details').textContent = '';
  $('pa-still-add').checked = false;
}

async function resolvePutawaySku() {
  const sequence = ++state.putaway.lookupSequence;
  const entered = ['pa-piece', 'pa-pack', 'pa-case'].map((id) => {
    const value = normalizeBarcode($(id).value);
    $(id).value = value;
    return value;
  });
  const actualBarcodes = [...new Set(entered.filter((value) => value && value !== 'N/A').map((value) => value.toLowerCase()))];

  if (!actualBarcodes.length) {
    state.putaway.matchedSkuId = null;
    setPutawayDetailsReadonly(false);
    $('pa-match-note').classList.add('hidden');
    await checkPutawayDuplicateDetails();
    return 'new';
  }

  const responses = await Promise.all(actualBarcodes.map((barcode) => supabase.rpc('find_sku_by_barcode', { p_barcode: barcode })));
  if (sequence !== state.putaway.lookupSequence) return 'stale';
  const failed = responses.find((response) => response.error);
  if (failed) { toast(friendlyError(failed.error), 'error'); return 'error'; }

  const matches = uniqueBy(responses.flatMap((response) => response.data || []), (row) => row.id);
  if (matches.length > 1) {
    state.putaway.matchedSkuId = null;
    setPutawayDetailsReadonly(false);
    $('pa-match-note').innerHTML = '<strong>Barcode conflict:</strong> the entered codes point to different stored SKUs. Check all three barcodes.';
    $('pa-match-note').classList.remove('hidden');
    toast('The entered barcodes point to different stored SKUs.', 'error');
    return 'conflict';
  }

  const sku = matches[0];
  if (!sku) {
    state.putaway.matchedSkuId = null;
    setPutawayDetailsReadonly(false);
    $('pa-match-note').classList.add('hidden');
    await checkPutawayDuplicateDetails();
    return 'new';
  }

  $('pa-piece').value = sku.piece_barcode;
  $('pa-pack').value = sku.pack_barcode;
  $('pa-case').value = sku.case_barcode;
  $('pa-brand').value = sku.brand;
  $('pa-description').value = sku.description;
  $('pa-variant').value = sku.variant;
  $('pa-size').value = sku.size;
  state.putaway.matchedSkuId = sku.id;
  setPutawayDetailsReadonly(true);
  hidePutawayDuplicateWarning();
  $('pa-match-note').innerHTML = `Existing SKU found through a stored barcode. The complete CASE/PACK/PIECE barcode set and SKU details were loaded from the database.`;
  $('pa-match-note').classList.remove('hidden');
  return 'existing';
}

async function checkPutawayDuplicateDetails() {
  if (state.putaway.matchedSkuId) {
    hidePutawayDuplicateWarning();
    return null;
  }
  const details = {
    p_brand: $('pa-brand').value.trim(),
    p_description: $('pa-description').value.trim(),
    p_variant: $('pa-variant').value.trim(),
    p_size: $('pa-size').value.trim()
  };
  if (Object.values(details).some((value) => !value)) {
    hidePutawayDuplicateWarning();
    return null;
  }

  const { data, error } = await supabase.rpc('find_sku_by_details', details);
  if (error) {
    toast(friendlyError(error), 'error');
    return null;
  }
  const match = data?.[0];
  if (!match) {
    hidePutawayDuplicateWarning();
    return null;
  }

  state.putaway.duplicateDetailsSkuId = match.id;
  $('pa-duplicate-details').textContent = `Existing barcodes — CASE: ${match.case_barcode}; PACK: ${match.pack_barcode}; PIECE: ${match.piece_barcode}. Added by: ${match.created_by_username || 'unknown user'}.`;
  $('pa-duplicate-warning').classList.remove('hidden');
  return match;
}

function putawayLinePayload() {
  return {
    piece_barcode: normalizeBarcode($('pa-piece').value),
    pack_barcode: normalizeBarcode($('pa-pack').value),
    case_barcode: normalizeBarcode($('pa-case').value),
    brand: $('pa-brand').value.trim(),
    description: $('pa-description').value.trim(),
    variant: $('pa-variant').value.trim(),
    size: $('pa-size').value.trim(),
    container_no: $('pa-container').value.trim(),
    expiry_date: $('pa-expiry').value,
    piece_qty: Number($('pa-piece-qty').value || 0),
    pack_qty: Number($('pa-pack-qty').value || 0),
    case_qty: Number($('pa-case-qty').value || 0),
    allow_duplicate_details: $('pa-still-add').checked
  };
}

function putawayQuantityText(item) {
  return formatBalances({ PIECE: item.piece_qty, PACK: item.pack_qty, CASE: item.case_qty });
}

async function addPutawayItem(event) {
  event.preventDefault();
  // Keep stable references before awaiting database lookups. In browsers,
  // event.currentTarget is cleared after the synchronous event phase ends.
  const form = event.currentTarget;
  const button = event.submitter || $('pa-add-btn');
  setBusy(button, true, 'Checking…');

  try {
    const resolution = await resolvePutawaySku();
    if (['conflict', 'error', 'stale'].includes(resolution)) return;
    if (!form.reportValidity()) return;

    const location = normalizeLocation($('pa-location').value);
    if (!location) return toast('Scan or enter a rack location.', 'error');

    const item = putawayLinePayload();
    const codes = [item.case_barcode, item.pack_barcode, item.piece_barcode];
    if (codes.some((code) => !code)) return toast('CASE, PACK, and PIECE barcode are all required. Enter N/A when unavailable.', 'error');
    const actualCodes = codes.filter((code) => code !== 'N/A').map((code) => code.toLowerCase());
    if (!actualCodes.length) return toast('At least one actual barcode is required; use N/A only for unavailable barcode types.', 'error');
    if (new Set(actualCodes).size !== actualCodes.length) return toast('The same actual barcode cannot be used as CASE, PACK, or PIECE barcode.', 'error');
    if ([item.case_qty, item.pack_qty, item.piece_qty].some((qty) => qty < 0)) return toast('Quantities cannot be negative.', 'error');
    if (item.case_qty <= 0 && item.pack_qty <= 0 && item.piece_qty <= 0) return toast('Enter at least one CASE, PACK, or PIECE quantity.', 'error');

    const duplicateMatch = await checkPutawayDuplicateDetails();
    if (duplicateMatch && !$('pa-still-add').checked) {
      return toast('ITEM WITH THE SAME DETAILS EXISTED. Please check BARCODE, or select Still Add to Database.', 'error');
    }
    item.allow_duplicate_details = $('pa-still-add').checked;

    if (!state.putaway.locationCode) state.putaway.locationCode = location;
    if (state.putaway.locationCode !== location) return toast('All lines in this pallet session must use the same rack location.', 'error');
    state.putaway.cart.push(item);
    $('pa-location').disabled = true;
    qsa('[data-scan-target="pa-location"]').forEach((b) => b.disabled = true);
    $('pa-cancel-btn').disabled = false;
    $('pa-complete-btn').disabled = state.mode !== 'ACTIVE';
    renderPutawayCart();
    clearPutawayLine();
    toast('SKU line added to the pallet session.', 'success');
  } catch (error) {
    console.error('Put-away line error:', error);
    toast(`Could not add SKU line: ${friendlyError(error)}`, 'error');
  } finally {
    setBusy(button, false);
    button.disabled = state.mode !== 'ACTIVE';
  }
}

function clearPutawayLine() {
  ['pa-piece','pa-pack','pa-case','pa-brand','pa-description','pa-variant','pa-size','pa-container','pa-expiry'].forEach((id) => $(id).value = '');
  ['pa-piece-qty','pa-pack-qty','pa-case-qty'].forEach((id) => $(id).value = '0');
  state.putaway.matchedSkuId = null;
  state.putaway.lookupSequence += 1;
  setPutawayDetailsReadonly(false);
  $('pa-match-note').classList.add('hidden');
  hidePutawayDuplicateWarning();
  $('pa-case').focus();
}

function renderPutawayCart() {
  const rows = state.putaway.cart;
  $('pa-cart').innerHTML = rows.length ? `<table><thead><tr><th>SKU</th><th>Barcodes</th><th>Container</th><th>Expiry</th><th>Quantities</th><th></th></tr></thead><tbody>${rows.map((r, i) => `<tr>
    <td class="wrap">${escapeHtml([r.brand,r.description,r.variant,r.size].join(' '))}</td><td class="wrap">C: ${escapeHtml(r.case_barcode)}<br>Pk: ${escapeHtml(r.pack_barcode)}<br>P: ${escapeHtml(r.piece_barcode)}</td><td>${escapeHtml(r.container_no)}</td><td>${fmtDate(r.expiry_date)}</td><td>${putawayQuantityText(r)}</td>
    <td><button class="link-btn" type="button" data-remove-putaway="${i}">Remove</button></td></tr>`).join('')}</tbody></table>` : emptyState('No SKU lines added to this pallet yet.');
}

function removePutawayItem(index) {
  state.putaway.cart.splice(index, 1);
  if (!state.putaway.cart.length) {
    state.putaway.locationCode = null;
    $('pa-location').disabled = false;
    qsa('[data-scan-target="pa-location"]').forEach((b) => b.disabled = false);
    $('pa-cancel-btn').disabled = true;
    $('pa-complete-btn').disabled = true;
  }
  renderPutawayCart();
}

function resetPutawaySession() {
  state.putaway = { locationCode: null, cart: [], matchedSkuId: null, duplicateDetailsSkuId: null, lookupSequence: 0 };
  $('putaway-form').reset();
  ['pa-piece-qty','pa-pack-qty','pa-case-qty'].forEach((id) => $(id).value = '0');
  setPutawayDetailsReadonly(false);
  $('pa-location').disabled = false;
  qsa('[data-scan-target="pa-location"]').forEach((b) => b.disabled = false);
  $('pa-cancel-btn').disabled = true;
  $('pa-complete-btn').disabled = true;
  $('pa-match-note').classList.add('hidden');
  hidePutawayDuplicateWarning();
  renderPutawayCart();
}

async function completePutaway() {
  if (!state.putaway.cart.length) return toast('Add at least one SKU line.', 'error');
  const button = $('pa-complete-btn');
  setBusy(button, true, 'Completing…');
  const { data, error } = await supabase.rpc('complete_putaway', {
    p_location_code: state.putaway.locationCode,
    p_items: state.putaway.cart,
    p_note: $('pa-note').value.trim() || null
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');
  toast(`Put-away saved: ${data?.[0]?.transaction_no || 'completed'} · ${data?.[0]?.line_count || 0} stock balance line(s)`, 'success');
  invalidateReports();
  resetPutawaySession();
}

async function lockPickLocation() {
  const so = $('pick-so').value.trim();
  const location = normalizeLocation($('pick-location').value);
  if (!so || !location) return toast('Enter the sales order and scan the source location first.', 'error');

  // Verify the sales order immediately before locking. This prevents a stale status
  // or a supervisor override left checked from a previously entered sales order.
  const statusOk = await refreshPickSalesOrderStatus();
  if (!statusOk || !['NEW', 'OPEN', 'COMPLETED'].includes(state.pickOrder.status)) {
    return toast('The sales order status could not be verified. Please try again.', 'error');
  }

  const isCompletedOrder = state.pickOrder.status === 'COMPLETED';
  const overrideCompleted = isSupervisor() && isCompletedOrder && $('pick-so-override').checked;
  const overrideReason = overrideCompleted ? $('pick-so-override-reason').value.trim() : '';
  if (overrideCompleted && !overrideReason) {
    return toast('Enter the supervisor override reason before reopening a completed sales order.', 'error');
  }

  const locked = await acquireOperationLock('pick', location, 'PICK', so, {
    overrideCompleted,
    overrideReason: overrideReason || null
  });
  if (locked) {
    $('pick-so-override').checked = false;
    $('pick-so-override-reason').value = '';
    await refreshPickSalesOrderStatus();
  }
}

async function lockTransferLocation() {
  const location = normalizeLocation($('tr-source').value);
  if (!location) return toast('Scan the source location first.', 'error');
  await acquireOperationLock('transfer', location, 'TRANSFER', null);
}

async function acquireOperationLock(operation, location, type, salesOrder, options = {}) {
  const opState = state[operation];
  const button = operation === 'pick' ? $('pick-lock-btn') : $('tr-lock-btn');
  setBusy(button, true, 'Locking…');
  const { data, error } = await supabase.rpc('acquire_location_lock', {
    p_location_code: location,
    p_operation: type,
    p_sales_order: salesOrder,
    p_override_completed: Boolean(options.overrideCompleted),
    p_override_reason: options.overrideReason || null
  });
  setBusy(button, false);
  if (error) {
    const message = friendlyError(error);
    if (message.includes('SALES_ORDER_ALREADY_COMPLETED') && isSupervisor()) {
      $('pick-so-override').checked = true;
      $('pick-so-override-reason').disabled = false;
      $('pick-so-override-reason').focus();
      toast('This sales order is completed. Enter a supervisor override reason, then lock the rack again.', 'error');
      await refreshPickSalesOrderStatus();
      return false;
    }
    toast(message, 'error');
    return false;
  }
  opState.lockToken = data[0].lock_token;
  state.data.rackMap = [];
  state.data.audit = [];
  opState.locationCode = data[0].location_code;
  startHeartbeat(opState);
  configureOperationUi(operation, true);
  if (operation === 'pick') await loadPickRackContents();
  toast(`${opState.locationCode} locked for your ${type.toLowerCase()} session.`, 'success');
  return true;
}

function startHeartbeat(opState) {
  stopHeartbeat(opState);
  opState.heartbeat = setInterval(async () => {
    if (!opState.lockToken) return;
    const { error } = await supabase.rpc('heartbeat_location_lock', { p_lock_token: opState.lockToken });
    if (error) {
      toast(friendlyError(error), 'error');
      stopHeartbeat(opState);
    }
  }, 45000);
}

function stopHeartbeat(opState) {
  if (opState.heartbeat) clearInterval(opState.heartbeat);
  opState.heartbeat = null;
}

function configureOperationUi(operation, locked) {
  const pick = operation === 'pick';
  const prefix = pick ? 'pick' : 'tr';
  const lockBtn = $(pick ? 'pick-lock-btn' : 'tr-lock-btn');
  const locationInput = $(pick ? 'pick-location' : 'tr-source');
  lockBtn.disabled = locked || state.mode !== 'ACTIVE';
  locationInput.disabled = locked;
  if (pick) {
    // Sales Order locking is controlled by the full order session, not merely
    // by the current rack lock. Once this user opens an order, it remains locked
    // while moving between racks until Finish sales order is completed.
    syncPickOverrideControls();
  }
  $(`${prefix}-barcode`).disabled = !locked;
  qsa(`[data-scan-target="${prefix}-barcode"]`).forEach((b) => b.disabled = !locked);
  $(`${prefix}-lot`).disabled = !locked;
  $(`${prefix}-qty`).disabled = !locked;
  $(pick ? 'pick-add-btn' : 'tr-add-btn').disabled = !locked;
  $(pick ? 'pick-cancel-btn' : 'tr-cancel-btn').disabled = !locked;
  $(pick ? 'pick-complete-btn' : 'tr-complete-btn').disabled = !locked;
  if (pick) updatePickSalesOrderControls();
  if (!pick) {
    $('tr-destination').disabled = !locked;
    qsa('[data-scan-target="tr-destination"]').forEach((b) => b.disabled = !locked);
  }
  const chip = $(pick ? 'pick-lock-chip' : 'transfer-lock-chip');
  chip.textContent = locked ? `${state[operation].locationCode} locked by you` : 'No location locked';
  chip.className = `status-chip ${locked ? 'active' : 'neutral'}`;
}

async function loadPickRackContents() {
  const location = state.pick.locationCode;
  const container = $('pick-rack-contents');
  if (!location) {
    state.pick.rackLots = [];
    $('pick-rack-title').textContent = 'Source rack contents';
    container.innerHTML = emptyState('Lock a source rack to display its available items.');
    return;
  }

  $('pick-rack-title').textContent = `Items currently stored in ${location}`;
  container.innerHTML = '<div class="empty-state">Loading rack contents…</div>';
  const { data, error } = await supabase
    .from('v_inventory_details')
    .select('*')
    .eq('location_code', location)
    .order('sku_name')
    .order('container_no')
    .order('expiry_date')
    .order('uom');
  if (error) {
    state.pick.rackLots = [];
    container.innerHTML = `<div class="warning-box">${escapeHtml(friendlyError(error))}</div>`;
    return;
  }
  state.pick.rackLots = data || [];
  renderPickRackContents();
}

function renderPickRackContents() {
  const rows = state.pick.rackLots;
  const container = $('pick-rack-contents');
  if (!rows.length) {
    container.innerHTML = emptyState(state.pick.locationCode
      ? `No available stock is recorded in ${state.pick.locationCode}.`
      : 'Lock a source rack to display its available items.');
    return;
  }

  container.innerHTML = `<table><thead><tr><th>Item</th><th>Container</th><th>Expiry</th><th>Stock unit</th><th>Available</th><th>Queued</th><th></th></tr></thead><tbody>${rows.map((lot) => {
    const queued = state.pick.cart.filter((x) => x.lot_id === lot.lot_id).reduce((sum, x) => sum + Number(x.qty), 0);
    const remaining = Math.max(Number(lot.qty) - queued, 0);
    const bypassAction = isSupervisor()
      ? `<button class="link-btn" type="button" data-pick-bypass-lot="${lot.lot_id}">Bypass unreadable barcode</button>`
      : '<small>Correct barcode required</small>';
    return `<tr>
      <td class="wrap"><strong>${escapeHtml(lot.sku_name)}</strong></td>
      <td>${escapeHtml(lot.container_no)}</td>
      <td>${fmtDate(lot.expiry_date)} ${expiryPill(lot.expiry_status)}</td>
      <td><span class="pill">${escapeHtml(lot.uom)}</span></td>
      <td>${fmtQtyUom(remaining, lot.uom)}${queued ? `<br><small>Original: ${fmtQtyUom(lot.qty, lot.uom)}</small>` : ''}</td>
      <td>${queued ? fmtQtyUom(queued, lot.uom) : '—'}</td>
      <td>${bypassAction}</td>
    </tr>`;
  }).join('')}</tbody></table>`;
}


function clearPickBarcodeMatch(message = 'Scan or type a registered CASE, PACK, or PIECE barcode to confirm the item.') {
  const panel = $('pick-barcode-match');
  if (!panel) return;
  panel.classList.remove('hidden');
  panel.innerHTML = `<strong>Barcode confirmation:</strong> ${escapeHtml(message)}`;
  const qtyNote = $('pick-qty-note');
  if (qtyNote) { qtyNote.textContent = ''; qtyNote.classList.add('hidden'); }
}

function renderPickBarcodeMatch(sku, expectedUom, lots) {
  const panel = $('pick-barcode-match');
  if (!panel || !sku) return;
  const available = (lots || []).reduce((sum, lot) => sum + Number(lot.qty || 0), 0);
  panel.classList.remove('hidden');
  panel.innerHTML = `<strong>Barcode confirmed as ${escapeHtml(expectedUom)}</strong>
    <div class="table-wrap"><table><tbody>
      <tr><th>Brand</th><td>${escapeHtml(sku.brand)}</td><th>Description</th><td>${escapeHtml(sku.description)}</td></tr>
      <tr><th>Variant</th><td>${escapeHtml(sku.variant)}</td><th>Size</th><td>${escapeHtml(sku.size)}</td></tr>
      <tr><th>Source rack</th><td>${escapeHtml(state.pick.locationCode || '—')}</td><th>Available ${escapeHtml(expectedUom)}</th><td>${fmtQtyUom(available, expectedUom)}</td></tr>
    </tbody></table></div>`;
}

function readWholePickQuantity() {
  const raw = String($('pick-qty').value || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const qty = Number(raw);
  return Number.isSafeInteger(qty) && qty > 0 ? qty : null;
}

function updatePickQtyNote() {
  const note = $('pick-qty-note');
  if (!note) return;
  note.classList.remove('hidden');
  const lotValue = $('pick-lot').value;
  if (lotValue === '') {
    note.textContent = 'Select an expiry / container before entering the quantity.';
    return;
  }
  const lot = state.pick.lots[Number(lotValue)];
  if (!lot) {
    note.textContent = 'Select a valid stock lot.';
    return;
  }
  const raw = String($('pick-qty').value || '').trim();
  if (!raw) {
    note.textContent = `Enter a whole number from 1 to ${fmtQty(lot.qty)} ${uomLabel(lot.uom)}${Number(lot.qty) === 1 ? '' : 's'}.`;
    return;
  }
  const qty = readWholePickQuantity();
  if (qty === null) {
    note.textContent = `Whole numbers only for ${lot.uom}. Example: 1, 2, 3.`;
    return;
  }
  const already = state.pick.cart.filter((x) => x.lot_id === lot.lot_id).reduce((sum, x) => sum + Number(x.qty), 0);
  const remaining = Number(lot.qty) - already;
  note.textContent = qty <= remaining
    ? `${qty} ${lot.uom} accepted for entry · ${fmtQtyUom(remaining, lot.uom)} currently available before this line.`
    : `${qty} ${lot.uom} exceeds the remaining ${fmtQtyUom(remaining, lot.uom)}.`;
}

async function loadOperationLots(operation) {
  const pick = operation === 'pick';
  const barcodeInput = $(pick ? 'pick-barcode' : 'tr-barcode');
  const barcode = barcodeInput.value.trim();
  const opState = state[operation];
  const lotSelect = $(pick ? 'pick-lot' : 'tr-lot');
  if (!barcode || !opState.locationCode) {
    if (pick) clearPickBarcodeMatch();
    return;
  }

  if (barcode.toUpperCase() === 'N/A') {
    lotSelect.innerHTML = '<option value="">N/A cannot be used for picking</option>';
    if (pick) {
      $('pick-unit-label').textContent = 'matched unit';
      clearPickBarcodeMatch('N/A is not a scannable picking barcode. Use a supervisor bypass only when the physical barcode is unreadable.');
    }
    return toast('Scan or type an actual CASE, PACK, or PIECE barcode. N/A cannot authorize a pick.', 'error');
  }

  const { data: skuData, error: skuError } = await supabase.rpc('find_sku_by_barcode', { p_barcode: barcode });
  if (skuError) return toast(friendlyError(skuError), 'error');
  const sku = skuData?.[0];
  if (!sku) {
    lotSelect.innerHTML = '<option value="">Barcode is not registered</option>';
    if (pick) {
      $('pick-unit-label').textContent = 'matched unit';
      clearPickBarcodeMatch('This barcode is not registered in the permanent SKU database.');
    }
    return toast('This barcode is not registered to a SKU.', 'error');
  }

  const barcodeType = String(sku.barcode_type || sku.matched_type || '').toUpperCase();
  const expectedUom = ['CASE', 'PACK', 'PIECE'].includes(barcodeType) ? barcodeType : null;
  if (pick && !expectedUom) {
    lotSelect.innerHTML = '<option value="">Barcode type could not be identified</option>';
    $('pick-unit-label').textContent = 'matched unit';
    clearPickBarcodeMatch(`${sku.brand} ${sku.description} was found, but the barcode type could not be identified.`);
    return toast('The barcode could not be matched to CASE, PACK, or PIECE.', 'error');
  }

  let lotsQuery = supabase.from('v_inventory_details')
    .select('*')
    .eq('location_code', opState.locationCode)
    .eq('sku_id', sku.id)
    .order('expiry_date');
  let earliestQuery = supabase.from('v_inventory_details')
    .select('expiry_date,location_code,container_no,uom')
    .eq('sku_id', sku.id)
    .order('expiry_date')
    .limit(1);

  if (pick) {
    lotsQuery = lotsQuery.eq('uom', expectedUom);
    earliestQuery = earliestQuery.eq('uom', expectedUom);
  }

  const [{ data: lots, error: lotsError }, { data: earliestRows, error: earliestError }] = await Promise.all([lotsQuery, earliestQuery]);
  if (lotsError || earliestError) return toast(friendlyError(lotsError || earliestError), 'error');

  opState.sku = sku;
  opState.lots = (lots || []).map((lot) => ({
    ...lot,
    earliestExpiry: earliestRows?.[0]?.expiry_date || lot.expiry_date,
    scannedBarcode: barcode,
    scannedBarcodeType: expectedUom
  }));

  if (pick) {
    $('pick-unit-label').textContent = expectedUom;
    renderPickBarcodeMatch(sku, expectedUom, opState.lots);
  }

  lotSelect.innerHTML = opState.lots.length
    ? `<option value="">Select expiry / container</option>${opState.lots.map((lot, i) => `<option value="${i}">${fmtDate(lot.expiry_date)} · ${escapeHtml(lot.container_no)} · Available ${fmtQtyUom(lot.qty, lot.uom)}</option>`).join('')}`
    : `<option value="">No ${pick ? expectedUom : ''} stock for this SKU in the locked location</option>`;

  if (pick && opState.lots.length === 1) lotSelect.value = '0';

  if (!opState.lots.length && pick) {
    $('pick-qty-note').textContent = `Barcode is valid, but there is no ${expectedUom} balance to deduct in ${opState.locationCode}.`;
    toast(`This is the correct ${expectedUom} barcode for ${sku.brand} ${sku.description}, but no ${expectedUom} quantity is available in ${opState.locationCode}.`, 'error');
  }
  if (pick) {
    updatePickFefoNote();
    updatePickQtyNote();
  }
}
async function addSupervisorBarcodeBypass(lotId) {
  if (!isSupervisor()) return toast('Only a supervisor can bypass an unreadable barcode.', 'error');
  if (!state.pick.lockToken || !state.pick.locationCode) return toast('Lock the source rack first.', 'error');
  const lot = state.pick.rackLots.find((row) => row.lot_id === lotId);
  if (!lot) return toast('The selected rack item is no longer available. Refresh the source rack.', 'error');

  const reason = window.prompt(`Supervisor bypass reason for ${lot.sku_name} (${lot.uom}). Explain why the barcode cannot be read:`);
  if (!reason?.trim()) return toast('A supervisor bypass reason is required.', 'error');

  const qtyText = window.prompt(`Enter the ${lot.uom} quantity to pick. Available: ${Number(lot.qty).toLocaleString()}`);
  if (qtyText === null) return;
  const qty = Number(qtyText);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
    return toast('Pick quantity must be a whole number greater than zero.', 'error');
  }

  const already = state.pick.cart.filter((x) => x.lot_id === lot.lot_id).reduce((sum, x) => sum + Number(x.qty), 0);
  if (qty + already > Number(lot.qty)) return toast(`Cannot exceed available stock of ${fmtQtyUom(lot.qty, lot.uom)}.`, 'error');

  const { data: earliestRows, error: earliestError } = await supabase
    .from('v_inventory_details')
    .select('expiry_date')
    .eq('sku_id', lot.sku_id)
    .eq('uom', lot.uom)
    .order('expiry_date')
    .limit(1);
  if (earliestError) return toast(friendlyError(earliestError), 'error');
  const earliestSameUnit = earliestRows?.[0]?.expiry_date || lot.expiry_date;

  state.pick.cart.push({
    lot_id: lot.lot_id,
    qty,
    barcode: null,
    supervisor_bypass: true,
    bypass_reason: reason.trim(),
    sku_name: lot.sku_name,
    container_no: lot.container_no,
    expiry_date: lot.expiry_date,
    earliest_expiry: earliestSameUnit,
    available: Number(lot.qty),
    uom: lot.uom
  });
  renderOperationCart('pick');
  renderPickRackContents();
  toast('Supervisor barcode bypass added and will be recorded in history.', 'success');
}

function updatePickFefoNote() {
  const index = Number($('pick-lot').value);
  const lot = state.pick.lots[index];
  const note = $('pick-fefo-note');
  if (!lot || lot.expiry_date <= lot.earliestExpiry) return note.classList.add('hidden');
  note.innerHTML = `FEFO warning: selected expiry <strong>${fmtDate(lot.expiry_date)}</strong>, but the earliest available stock expires <strong>${fmtDate(lot.earliestExpiry)}</strong>. Completing this line will be recorded as an override.`;
  note.classList.remove('hidden');
}

function addOperationItem(operation) {
  const pick = operation === 'pick';
  const opState = state[operation];
  const lotSelect = $(pick ? 'pick-lot' : 'tr-lot');
  const lotValue = lotSelect.value;
  if (lotValue === '') return toast('Select an expiry / container first.', 'error');
  const lotIndex = Number(lotValue);
  const lot = opState.lots[lotIndex];
  if (!lot) return toast('Select a valid stock lot.', 'error');

  let qty;
  if (pick) {
    qty = readWholePickQuantity();
    if (qty === null) return toast(`Enter a whole-number ${lot.uom} quantity greater than zero.`, 'error');
  } else {
    qty = Number($('tr-qty').value);
    if (!Number.isFinite(qty) || qty <= 0) return toast('Enter a valid transfer quantity.', 'error');
  }

  const already = opState.cart.filter((x) => x.lot_id === lot.lot_id).reduce((a, x) => a + Number(x.qty), 0);
  if (qty + already > Number(lot.qty)) return toast(`Cannot exceed available stock of ${fmtQtyUom(lot.qty, lot.uom)}.`, 'error');

  opState.cart.push({
    lot_id: lot.lot_id,
    qty,
    barcode: lot.scannedBarcode,
    sku_name: lot.sku_name,
    brand: opState.sku?.brand || '',
    description: opState.sku?.description || '',
    variant: opState.sku?.variant || '',
    size: opState.sku?.size || '',
    container_no: lot.container_no,
    expiry_date: lot.expiry_date,
    earliest_expiry: lot.earliestExpiry,
    available: Number(lot.qty),
    uom: lot.uom,
    supervisor_bypass: false,
    bypass_reason: null
  });
  renderOperationCart(operation);
  if (pick) {
    renderPickRackContents();
    renderPickSalesOrderSummary();
  }
  $(pick ? 'pick-qty' : 'tr-qty').value = '';
  if (pick) updatePickQtyNote();
  toast(`${fmtQtyUom(qty, lot.uom)} added to the ${pick ? 'picking' : 'transfer'} session.`, 'success');
}
function renderOperationCart(operation) {
  const pick = operation === 'pick';
  const rows = state[operation].cart;
  const container = $(pick ? 'pick-cart' : 'tr-cart');
  if (!rows.length) return container.innerHTML = emptyState('No items added yet.');
  container.innerHTML = `<table><thead><tr><th>SKU</th><th>Container</th><th>Expiry</th><th>Quantity</th><th>Barcode control</th><th></th></tr></thead><tbody>${rows.map((r, i) => `<tr>
    <td class="wrap">${escapeHtml(r.sku_name)}</td><td>${escapeHtml(r.container_no)}</td><td>${fmtDate(r.expiry_date)}</td><td>${fmtQtyUom(r.qty, r.uom)}</td>
    <td class="wrap">${pick
      ? (r.supervisor_bypass
        ? `<span class="pill override">Supervisor bypass</span><br><small>${escapeHtml(r.bypass_reason || '')}</small>`
        : `<span class="pill">${escapeHtml((r.uom || '').toUpperCase())} barcode verified</span>`)
      : '<span class="pill">Barcode scanned</span>'}</td>
    <td><button class="link-btn" data-operation="${operation}" data-remove-cart="${i}">Remove</button></td></tr>`).join('')}</tbody></table>`;
}

function removeCartItem(operation, index) {
  state[operation].cart.splice(index, 1);
  renderOperationCart(operation);
  if (operation === 'pick') {
    renderPickRackContents();
    renderPickSalesOrderSummary();
    updatePickQtyNote();
  }
}

async function cancelOperation(operation, silent = false) {
  const opState = state[operation];
  if (opState.lockToken) {
    const { error } = await supabase.rpc('cancel_location_operation', {
      p_lock_token: opState.lockToken,
      p_reason: silent ? 'Session ended during sign out.' : 'User cancelled or restarted the source-location session.'
    });
    if (error && !silent) toast(friendlyError(error), 'error');
  }
  invalidateReports();
  resetOperation(operation);
  if (!silent) toast(operation === 'pick'
    ? 'Rack session cancelled. The sales order remains open so you may scan the same or a different location.'
    : 'Session cancelled. You may scan the same or a different location.');
}

function resetOperation(operation) {
  const pick = operation === 'pick';
  const opState = state[operation];
  stopHeartbeat(opState);
  state[operation] = freshOperationState();
  if (pick) {
    $('pick-location').value = '';
    $('pick-barcode').value = '';
    $('pick-lot').innerHTML = '<option value="">Scan a barcode first</option>';
    $('pick-qty').value = '';
    $('pick-unit-label').textContent = 'matched unit';
    $('pick-rack-title').textContent = 'Source rack contents';
    $('pick-rack-contents').innerHTML = emptyState('Lock a source rack to display its available items.');
    $('pick-fefo-note').classList.add('hidden');
    clearPickBarcodeMatch();
    $('pick-qty-note').textContent = '';
    $('pick-qty-note').classList.add('hidden');
    renderPickSalesOrderSummary();
  } else {
    $('tr-source').value = '';
    $('tr-barcode').value = '';
    $('tr-lot').innerHTML = '<option value="">Scan a barcode first</option>';
    $('tr-qty').value = '';
    $('tr-destination').value = '';
    $('tr-note').value = '';
  }
  configureOperationUi(operation, false);
  renderOperationCart(operation);
}



async function loadPickSalesOrderSummary() {
  const so = $('pick-so').value.trim();
  if (!so || state.pickOrder.status === 'NEW' || !state.pickOrder.status) {
    state.pickOrderSummary = [];
    renderPickSalesOrderSummary();
    return;
  }
  const { data, error } = await supabase.rpc('get_pick_sales_order_summary', { p_sales_order: so });
  if (error) {
    state.pickOrderSummary = [];
    $('pick-order-summary').innerHTML = `<div class="warning-box">${escapeHtml(friendlyError(error))}</div>`;
    return;
  }
  state.pickOrderSummary = data || [];
  renderPickSalesOrderSummary();
}

function renderPickSalesOrderSummary() {
  const container = $('pick-order-summary');
  if (!container) return;
  const so = $('pick-so').value.trim();
  if (!so) {
    container.innerHTML = emptyState('Enter a sales order number to see its picking summary.');
    return;
  }
  const saved = (state.pickOrderSummary || []).map((row) => ({ ...row, line_status: 'SAVED' }));
  const queued = (state.pick.cart || []).map((row) => ({
    transaction_no: 'Current rack', picked_at: null, location_code: state.pick.locationCode || '—',
    brand: row.brand || '', description: row.description || row.sku_name || '', variant: row.variant || '', size: row.size || '',
    container_no: row.container_no, expiry_date: row.expiry_date, uom: row.uom, picked_qty: row.qty, line_status: 'QUEUED'
  }));
  const rows = [...saved, ...queued];
  if (!rows.length) {
    container.innerHTML = emptyState(`No items have been picked yet for sales order ${so}.`);
    return;
  }
  const totals = sumByUom(rows, 'picked_qty');
  const racks = new Set(rows.map((r) => r.location_code).filter(Boolean));
  container.innerHTML = `<div class="info-box"><strong>${escapeHtml(so)} progress:</strong> ${formatBalances(totals)} · ${racks.size.toLocaleString()} rack${racks.size === 1 ? '' : 's'} represented. Rows marked QUEUED are from the currently locked rack and are not saved until you click Complete this rack.</div>
    <table><thead><tr><th>Status</th><th>Rack</th><th>Item</th><th>Container</th><th>Expiry</th><th>Picked</th><th>Transaction / time</th></tr></thead><tbody>${rows.map((r) => {
      const item = [r.brand, r.description, r.variant, r.size].filter(Boolean).join(' ') || r.sku_name || '—';
      return `<tr><td>${r.line_status === 'QUEUED' ? '<span class="pill near">QUEUED</span>' : '<span class="pill">SAVED</span>'}</td><td>${escapeHtml(r.location_code || '—')}</td><td class="wrap"><strong>${escapeHtml(item)}</strong></td><td>${escapeHtml(r.container_no || '—')}</td><td>${fmtDate(r.expiry_date)}</td><td>${fmtQtyUom(r.picked_qty, r.uom)}</td><td>${escapeHtml(r.transaction_no || '—')}${r.picked_at ? `<br><small>${fmtDateTime(r.picked_at)}</small>` : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
}

function isPickSalesOrderInputLocked() {
  return Boolean(state.pick.lockToken)
    || (state.pickOrder.status === 'OPEN' && Boolean(state.pickOrder.isCurrentOwner));
}

function updatePickSalesOrderControls() {
  const hasSo = Boolean($('pick-so').value.trim());
  const orderOpen = state.pickOrder.status === 'OPEN';
  const hasSavedPick = Number(state.pickOrder.pickCount || 0) > 0;
  const unlocked = !state.pick.lockToken;
  const soLocked = isPickSalesOrderInputLocked();

  $('pick-so').disabled = soLocked;
  $('pick-so').title = soLocked
    ? 'Sales Order is locked while this picking order is in progress. Finish the Sales Order to release it.'
    : '';

  $('pick-finish-so-btn').disabled = !(state.mode === 'ACTIVE' && hasSo && orderOpen && hasSavedPick && unlocked);
}

function syncPickOverrideControls() {
  const checkbox = $('pick-so-override');
  const reason = $('pick-so-override-reason');
  if (!checkbox || !reason) return;

  const completed = state.pickOrder.status === 'COMPLETED';
  const available = isSupervisor() && completed && !state.pick.lockToken;

  // The override belongs only to the completed sales order currently displayed.
  // Clear it as soon as the user switches to a NEW or OPEN sales order.
  if (!completed) {
    checkbox.checked = false;
    reason.value = '';
  }

  checkbox.disabled = !available;
  reason.disabled = !available || !checkbox.checked;
}

async function refreshPickSalesOrderStatus() {
  const so = $('pick-so').value.trim();
  const box = $('pick-so-status');
  const requestNo = ++state.pickOrderLookupSequence;

  if (!so) {
    state.pickOrder = { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false };
    box.innerHTML = '<strong>Sales order status:</strong> enter a sales order number. A completed sales order cannot be reused by a regular user.';
    syncPickOverrideControls();
    updatePickSalesOrderControls();
    await loadPickSalesOrderSummary();
    return true;
  }

  const { data, error } = await supabase.rpc('get_pick_sales_order_status', { p_sales_order: so });

  // Ignore an older lookup if the user has already entered another sales order.
  if (requestNo !== state.pickOrderLookupSequence || $('pick-so').value.trim() !== so) return false;

  if (error) {
    state.pickOrder = { salesOrder: so, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false };
    box.innerHTML = `<strong>Sales order status:</strong> ${escapeHtml(friendlyError(error))}`;
    syncPickOverrideControls();
    updatePickSalesOrderControls();
    state.pickOrderSummary = [];
    renderPickSalesOrderSummary();
    return false;
  }

  const row = data?.[0];
  if (!row?.order_exists) {
    state.pickOrder = { salesOrder: so, status: 'NEW', pickCount: 0, openedBy: null, isCurrentOwner: false };
    box.innerHTML = `<strong>Sales order status:</strong> New sales order <strong>${escapeHtml(so)}</strong>. It will open when the first source rack is locked.`;
  } else {
    state.pickOrder = {
      salesOrder: row.order_number,
      status: row.order_status,
      pickCount: Number(row.pick_transaction_count || 0),
      openedBy: row.opened_by_username || null,
      isCurrentOwner: Boolean(row.is_current_owner)
    };
    if (row.order_status === 'COMPLETED') {
      box.innerHTML = `<strong>Sales order status:</strong> <strong>${escapeHtml(row.order_number)}</strong> was completed ${row.completed_at ? `on ${escapeHtml(fmtDateTime(row.completed_at))}` : ''}. It cannot be reused unless a supervisor checks the override and records a reason.`;
    } else {
      const lockMessage = row.is_current_owner
        ? ' · Sales Order number is locked until you finish this Sales Order.'
        : '';
      box.innerHTML = `<strong>Sales order status:</strong> <strong>${escapeHtml(row.order_number)}</strong> is OPEN by ${escapeHtml(row.opened_by_username || 'a user')} · ${Number(row.pick_transaction_count || 0).toLocaleString()} completed rack pick(s). Continue to another rack or finish the sales order.${lockMessage}`;
    }
  }

  syncPickOverrideControls();
  updatePickSalesOrderControls();
  await loadPickSalesOrderSummary();
  return true;
}

async function finishPickSalesOrder() {
  const so = $('pick-so').value.trim();
  if (!so) return toast('Enter the sales order number.', 'error');
  if (state.pick.lockToken) return toast('Complete or cancel the current rack before finishing the sales order.', 'error');
  if (!window.confirm(`Finish sales order ${so}? After this, regular users cannot use this sales order number again.`)) return;

  const button = $('pick-finish-so-btn');
  setBusy(button, true, 'Finishing…');
  const { data, error } = await supabase.rpc('finish_pick_sales_order', { p_sales_order: so });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  const row = data?.[0];
  toast(`Sales order ${row?.result_sales_order || so} completed after ${Number(row?.pick_transaction_count || 0).toLocaleString()} rack pick(s).`, 'success');
  $('pick-so').value = '';
  $('pick-location').value = '';
  $('pick-so-override').checked = false;
  $('pick-so-override-reason').value = '';
  $('pick-so-override-reason').disabled = true;
  state.pickOrder = { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false };
  state.pickOrderSummary = [];
  await refreshPickSalesOrderStatus();
  invalidateReports();
}

async function completePicking() {
  if (!state.pick.cart.length) return toast('Add at least one item.', 'error');
  const requiresOverride = state.pick.cart.some((x) => x.expiry_date > x.earliest_expiry);
  let reason = null;
  if (requiresOverride) {
    reason = window.prompt('FEFO override reason (required):');
    if (!reason?.trim()) return toast('Picking was not completed because an override reason is required.', 'error');
  }
  const button = $('pick-complete-btn');
  setBusy(button, true, 'Completing…');
  const { data, error } = await supabase.rpc('complete_picking', {
    p_location_code: state.pick.locationCode,
    p_lock_token: state.pick.lockToken,
    p_sales_order: $('pick-so').value.trim(),
    p_items: state.pick.cart.map(({ lot_id, qty, barcode, supervisor_bypass, bypass_reason }) => ({
      lot_id, qty, barcode, supervisor_bypass: Boolean(supervisor_bypass), bypass_reason: bypass_reason || null
    })),
    p_allow_fefo_override: requiresOverride,
    p_override_reason: reason,
    p_note: null
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');
  const so = $('pick-so').value;
  toast(`Rack pick saved: ${data?.[0]?.transaction_no || 'completed'}${requiresOverride ? ' · FEFO override recorded' : ''}. Scan the next source rack, or finish the sales order when all items are complete.`, 'success');
  invalidateReports();
  resetOperation('pick');
  $('pick-so').value = so; // Keep the sales order for picking from the next rack.
  await refreshPickSalesOrderStatus();
}

async function completeTransfer() {
  if (!state.transfer.cart.length) return toast('Add at least one item.', 'error');
  const destination = normalizeLocation($('tr-destination').value);
  if (!destination) return toast('Scan the destination location.', 'error');
  const button = $('tr-complete-btn');
  setBusy(button, true, 'Completing…');
  const { data, error } = await supabase.rpc('complete_transfer', {
    p_source_code: state.transfer.locationCode,
    p_destination_code: destination,
    p_lock_token: state.transfer.lockToken,
    p_items: state.transfer.cart.map(({ lot_id, qty, barcode }) => ({ lot_id, qty, barcode })),
    p_note: $('tr-note').value.trim() || null
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');
  toast(`Transfer saved: ${data?.[0]?.transaction_no || 'completed'}`, 'success');
  invalidateReports();
  resetOperation('transfer');
}

async function loadInventory(force = false) {
  if (!force && state.data.inventory.length) return renderInventory();
  const { data, error } = await supabase.from('v_inventory_details').select('*').order('location_sort_order', { ascending: true, nullsFirst: false }).order('location_code').order('sku_name').limit(10000);
  if (error) throw error;
  state.data.inventory = data || [];
  renderInventory();
}

function renderInventory() {
  const term = $('inventory-search').value.trim().toLowerCase();
  const rows = state.data.inventory.filter((r) => [r.sku_name, r.container_no, r.location_code, r.expiry_date, r.uom].join(' ').toLowerCase().includes(term));
  const grouped = new Map();
  rows.forEach((r) => {
    const item = grouped.get(r.sku_id) || { sku_name: r.sku_name, balances: { PIECE: 0, PACK: 0, CASE: 0 }, containers: new Set(), locations: new Set(), earliest: r.expiry_date };
    item.balances[r.uom] = (item.balances[r.uom] || 0) + Number(r.qty);
    item.containers.add(r.container_no);
    item.locations.add(r.location_code);
    if (r.expiry_date < item.earliest) item.earliest = r.expiry_date;
    grouped.set(r.sku_id, item);
  });
  const summaryRows = [...grouped.values()].sort((a, b) => a.sku_name.localeCompare(b.sku_name));
  $('inventory-summary-table').innerHTML = summaryRows.length ? `<table><thead><tr><th>SKU</th><th>Balances</th><th>Containers</th><th>Locations</th><th>Earliest expiry</th></tr></thead><tbody>${summaryRows.map((r) => `<tr><td class="wrap">${escapeHtml(r.sku_name)}</td><td>${formatBalances(r.balances)}</td><td>${r.containers.size}</td><td>${r.locations.size}</td><td>${fmtDate(r.earliest)}</td></tr>`).join('')}</tbody></table>` : emptyState('No matching SKU summary.');
  $('inventory-table').innerHTML = rows.length ? `<table><thead><tr><th>Location</th><th>SKU</th><th>Container</th><th>Expiry</th><th>Status</th><th>Quantity</th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${escapeHtml(r.location_code)}</td><td class="wrap">${escapeHtml(r.sku_name)}</td><td>${escapeHtml(r.container_no)}</td><td>${fmtDate(r.expiry_date)}</td><td>${expiryPill(r.expiry_status)}</td><td>${fmtQtyUom(r.qty, r.uom)}</td>
  </tr>`).join('')}</tbody></table>` : emptyState('No matching inventory.');
}

async function loadContainers(force = false) {
  if (!force && state.data.containers.length) return renderContainers();
  const { data, error } = await supabase.from('v_container_summary').select('*').order('container_no').limit(10000);
  if (error) throw error;
  state.data.containers = data || [];
  renderContainers();
}

function renderContainers() {
  const term = $('container-search').value.trim().toLowerCase();
  const rows = state.data.containers.filter((r) => r.container_no.toLowerCase().includes(term));
  $('container-summary-table').innerHTML = rows.length ? `<table><thead><tr><th>Container</th><th>Remaining / received</th><th>Consumed</th><th>SKUs</th><th>Locations</th><th>Earliest expiry</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td><strong>${escapeHtml(r.container_no)}</strong><br>${r.consumption_status === 'CONSUMED' ? '<span class="pill">Consumed</span>' : '<span class="pill">Active</span>'}</td><td>${formatBalances(balanceColumns(r, 'remaining'))}<br><small>Received: ${formatBalances(balanceColumns(r, 'received'))}</small></td><td>${formatBalances(balanceColumns(r, 'consumed'))}</td><td>${r.sku_count}</td><td class="wrap">${escapeHtml(r.locations || '—')}</td><td>${fmtDate(r.earliest_expiry)} ${r.has_expired ? '<span class="pill expired">Expired stock</span>' : r.has_near_expiry ? '<span class="pill near">Near expiry</span>' : ''}</td>
    <td><button class="link-btn" data-container-detail="${escapeHtml(r.container_no)}">Details</button></td></tr>`).join('')}</tbody></table>` : emptyState('No matching container history.');
}

async function showContainerDetail(containerNo) {
  const panel = $('container-detail');
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="empty-state">Loading container details…</div>';
  const { data, error } = await supabase.from('v_inventory_details').select('*').eq('container_no', containerNo).order('location_sort_order', { ascending: true, nullsFirst: false }).order('location_code').order('expiry_date');
  if (error) return panel.innerHTML = `<div class="warning-box">${escapeHtml(friendlyError(error))}</div>`;
  panel.innerHTML = `<div class="card-head"><div><h3>Container ${escapeHtml(containerNo)}</h3><p>All remaining contents and locations</p></div></div>${data?.length ? `<table><thead><tr><th>SKU</th><th>Location</th><th>Expiry</th><th>Quantity</th></tr></thead><tbody>${data.map((r) => `<tr><td class="wrap">${escapeHtml(r.sku_name)}</td><td>${escapeHtml(r.location_code)}</td><td>${fmtDate(r.expiry_date)}</td><td>${fmtQtyUom(r.qty, r.uom)}</td></tr>`).join('')}</tbody></table>` : emptyState('This container has no remaining stock. It has been fully consumed or never received.')}`;
}

async function loadRackMap(force = false) {
  if (!force && state.data.rackMap.length) return renderRackMap();
  const { data, error } = await supabase
    .from('v_location_summary')
    .select('*')
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('location_code')
    .limit(10000);
  if (error) throw error;
  state.data.rackMap = sortLocations(data || []);
  populateLocationRowSelect($('rack-map-row'), state.data.rackMap);
  renderRackMap();
}

function populateLocationRowSelect(select, rows) {
  const current = select.value;
  const rowKeys = [...new Set(sortLocations(rows).map(locationRowKey))];
  select.innerHTML = '<option value="">All rack rows</option>' + rowKeys
    .map((row) => `<option value="${escapeHtml(row)}">${row === 'PENDING' ? 'PENDING area' : `Row ${escapeHtml(row)}`}</option>`)
    .join('');
  if (rowKeys.includes(current)) select.value = current;
}

function filteredRackMapRows() {
  const rowFilter = $('rack-map-row').value;
  const term = $('rack-map-search').value.trim().toLowerCase();
  return sortLocations(state.data.rackMap).filter((r) => {
    const rowMatches = !rowFilter || locationRowKey(r) === rowFilter;
    const haystack = [r.location_code, r.display_name, r.row_label, r.containers, r.locked_by].join(' ').toLowerCase();
    return rowMatches && haystack.includes(term);
  });
}

function renderRackMap() {
  const rows = filteredRackMapRows();
  if (!rows.length) {
    $('rack-map').innerHTML = emptyState('No locations match the selected row or search.');
    return;
  }

  const groups = new Map();
  rows.forEach((row) => {
    const key = locationRowKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  $('rack-map').innerHTML = [...groups.entries()].map(([groupName, groupRows]) => {
    const occupiedCount = groupRows.filter((r) => Number(r.total_piece_qty) > 0 || Number(r.total_pack_qty) > 0 || Number(r.total_case_qty) > 0).length;
    const groupTitle = groupName === 'PENDING' ? 'PENDING area' : `Rack Row ${groupName}`;
    return `<section class="rack-row-group">
      <div class="rack-row-heading"><h4>${escapeHtml(groupTitle)}</h4><span>${occupiedCount} occupied · ${groupRows.length} locations</span></div>
      <div class="rack-row-grid">${groupRows.map((r) => {
        const occupied = Number(r.total_piece_qty) > 0 || Number(r.total_pack_qty) > 0 || Number(r.total_case_qty) > 0;
        const cls = r.is_pending ? 'pending' : r.is_locked ? 'locked' : occupied ? 'occupied' : '';
        return `<div class="rack-cell ${cls}"><h4>${escapeHtml(r.location_code)}</h4>
          <p>${r.is_locked ? `Locked by ${escapeHtml(r.locked_by)} for ${escapeHtml(r.lock_operation)}` : occupied ? `${r.sku_count} SKU(s) · ${formatBalances({ PIECE: r.total_piece_qty, PACK: r.total_pack_qty, CASE: r.total_case_qty })}` : 'Empty location'}</p>
          <p>${r.containers ? `Containers: ${escapeHtml(r.containers)}` : r.is_pending ? 'Virtual pending area' : 'No container'}</p></div>`;
      }).join('')}</div>
    </section>`;
  }).join('');
}

async function loadExpiry(force = false) {
  if (!force && state.data.expiry.length) return renderExpiry();
  const { data, error } = await supabase.from('v_inventory_details').select('*').neq('expiry_status', 'OK').order('expiry_date').limit(10000);
  if (error) throw error;
  state.data.expiry = data || [];
  renderExpiry();
}

function renderExpiry() {
  const rows = state.data.expiry;
  $('expiry-table').innerHTML = rows.length ? `<table><thead><tr><th>Status</th><th>Days</th><th>SKU</th><th>Container</th><th>Location</th><th>Expiry</th><th>Quantity</th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${expiryPill(r.expiry_status)}</td><td>${r.days_to_expiry}</td><td class="wrap">${escapeHtml(r.sku_name)}</td><td>${escapeHtml(r.container_no)}</td><td>${escapeHtml(r.location_code)}</td><td>${fmtDate(r.expiry_date)}</td><td>${fmtQtyUom(r.qty, r.uom)}</td>
  </tr>`).join('')}</tbody></table>` : emptyState('No expired or near-expiry stock.');
}

async function loadHistory(force = false) {
  if (!force && state.data.history.length && state.data.audit.length) { renderHistory(); return renderAuditHistory(); }
  const [historyRes, auditRes] = await Promise.all([
    supabase.from('v_history_details').select('*').order('created_at', { ascending: false }).order('line_no').limit(10000),
    supabase.from('v_audit_history').select('*').order('created_at', { ascending: false }).limit(2000)
  ]);
  if (historyRes.error || auditRes.error) throw historyRes.error || auditRes.error;
  state.data.history = historyRes.data || [];
  state.data.audit = auditRes.data || [];
  renderHistory();
  renderAuditHistory();
}

function renderHistory() {
  const term = $('history-search').value.trim().toLowerCase();
  const type = $('history-type').value;
  const rows = state.data.history.filter((r) => {
    const haystack = [r.tx_no, r.created_by_username, r.sales_order, r.sku_name, r.container_no, r.location_code, r.override_reason, r.edit_reason].join(' ').toLowerCase();
    return (!type || r.transaction_type === type) && haystack.includes(term);
  });
  const firstLineByTx = new Set();
  $('history-table').innerHTML = rows.length ? `<table><thead><tr><th>Transaction</th><th>Action</th><th>User / time</th><th>SO</th><th>Location</th><th>SKU / container</th><th>Qty</th><th>Flags</th><th></th></tr></thead><tbody>${rows.map((r) => {
    const first = !firstLineByTx.has(r.transaction_id); firstLineByTx.add(r.transaction_id);
    const flags = [
      r.fefo_overridden ? '<span class="pill override">FEFO override</span>' : '',
      r.barcode_bypassed ? '<span class="pill override">Supervisor barcode bypass</span>' : '',
      r.edited_at ? '<span class="pill">Corrected</span>' : ''
    ].filter(Boolean).join(' ');
    return `<tr><td><strong>${escapeHtml(r.tx_no)}</strong><br><small>${first ? escapeHtml(r.transaction_note || '') : ''}</small></td><td>${escapeHtml(r.transaction_type)}</td>
      <td>${escapeHtml(r.created_by_username)}<br><small>${fmtDateTime(r.created_at)}</small></td><td>${escapeHtml(r.sales_order || '—')}</td><td>${escapeHtml(r.location_code || '—')}</td>
      <td class="wrap">${escapeHtml(r.sku_name || 'System action')}<br><small>${escapeHtml(r.container_no || '')} ${r.expiry_date ? `· ${fmtDate(r.expiry_date)}` : ''}</small></td>
      <td>${r.signed_qty == null ? '—' : fmtQtyUom(r.signed_qty, r.uom)}</td><td class="wrap">${flags}${r.barcode_bypassed ? `<br><small>Bypass by ${escapeHtml(r.bypassed_by_username || r.created_by_username)}: ${escapeHtml(r.bypass_reason || '')}</small>` : ''}${first && r.override_reason ? `<br><small>${escapeHtml(r.override_reason)}</small>` : ''}${first && r.edit_reason ? `<br><small>Edit: ${escapeHtml(r.edit_reason)}</small>` : ''}</td>
      <td>${first && isSupervisor() && ['PUTAWAY','PICK','TRANSFER'].includes(r.transaction_type) ? `<button class="link-btn" data-edit-transaction="${r.transaction_id}">Correct</button>` : ''}</td></tr>`;
  }).join('')}</tbody></table>` : emptyState('No matching history.');
}

function renderAuditHistory() {
  const rows = state.data.audit;
  $('audit-history-table').innerHTML = rows.length ? `<table><thead><tr><th>Time</th><th>Action</th><th>User</th><th>Entity</th><th>Reason</th><th>Stored details</th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${fmtDateTime(r.created_at)}</td><td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.username || '—')}</td><td>${escapeHtml(r.entity_type)} ${escapeHtml(r.entity_id || '')}</td><td class="wrap">${escapeHtml(r.reason || '')}</td>
    <td class="wrap"><details><summary>View JSON</summary><pre>${escapeHtml(JSON.stringify({ before: r.before_data, after: r.after_data }, null, 2))}</pre></details></td></tr>`).join('')}</tbody></table>` : emptyState('No audit events yet.');
}

async function openSupervisorEdit(transactionId) {
  if (!isSupervisor()) return toast('Supervisor access is required.', 'error');
  const { data, error } = await supabase.from('v_history_details').select('*').eq('transaction_id', transactionId).order('line_no');
  if (error) return toast(friendlyError(error), 'error');
  const rows = data || [];
  if (!rows.length) return;
  $('edit-transaction-id').value = transactionId;
  $('edit-sales-order').value = rows[0].sales_order || '';
  $('edit-sales-order').disabled = rows[0].transaction_type !== 'PICK';
  $('edit-lines').innerHTML = rows.map((r) => `<section class="edit-line-card" data-edit-card data-line-id="${r.line_id}">
    <div><strong>Line ${r.line_no} · ${r.signed_qty < 0 ? 'Stock out' : 'Stock in'}</strong><p>${escapeHtml(r.sku_name)} · Current ${escapeHtml(r.location_code)}</p></div>
    <div class="form-grid two">
      <label>SKU barcode<input data-edit-field="barcode" value="${escapeHtml(r.barcode_scanned || r.piece_barcode || '')}" required /></label>
      <label>Location code<input data-edit-field="location" value="${escapeHtml(r.location_code)}" required /></label>
      <label>Container number<input data-edit-field="container" value="${escapeHtml(r.container_no)}" required /></label>
      <label>Expiry date<input data-edit-field="expiry" type="date" value="${escapeHtml(r.expiry_date)}" required /></label>
      <label>Stock unit<select data-edit-field="uom" required><option value="PIECE" ${r.uom === 'PIECE' ? 'selected' : ''}>PIECE</option><option value="PACK" ${r.uom === 'PACK' ? 'selected' : ''}>PACK</option><option value="CASE" ${r.uom === 'CASE' ? 'selected' : ''}>CASE</option></select></label>
      <label>Absolute quantity<input data-edit-field="qty" type="number" min="0.001" step="0.001" value="${Math.abs(Number(r.signed_qty))}" required /></label>
    </div>
  </section>`).join('');
  $('edit-reason').value = '';
  $('edit-dialog').showModal();
}

async function submitSupervisorEdit(event) {
  event.preventDefault();
  const button = event.submitter;
  const lineCorrections = qsa('[data-edit-card]', $('edit-lines')).map((card) => ({
    line_id: card.dataset.lineId,
    new_barcode: card.querySelector('[data-edit-field="barcode"]').value.trim(),
    new_location_code: normalizeLocation(card.querySelector('[data-edit-field="location"]').value),
    new_container_no: card.querySelector('[data-edit-field="container"]').value.trim(),
    new_expiry_date: card.querySelector('[data-edit-field="expiry"]').value,
    new_uom: card.querySelector('[data-edit-field="uom"]').value,
    new_abs_qty: Number(card.querySelector('[data-edit-field="qty"]').value)
  }));
  setBusy(button, true, 'Saving…');
  const { data, error } = await supabase.rpc('supervisor_edit_transaction', {
    p_transaction_id: $('edit-transaction-id').value,
    p_sales_order: $('edit-sales-order').value.trim() || null,
    p_line_quantities: lineCorrections,
    p_reason: $('edit-reason').value.trim()
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');
  $('edit-dialog').close();
  invalidateReports();
  toast(`Correction saved for ${data}.`, 'success');
  await loadHistory(true);
}

async function loadLocations(force = false) {
  if (!force && state.data.locations.length) return renderLocationsTable();
  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('code')
    .limit(10000);
  if (error) throw error;
  state.data.locations = sortLocations(data || []);
  populateLocationRowSelect($('location-row-filter'), state.data.locations);
  renderLocationsTable();
}

function filteredLocationRows() {
  const term = $('location-search').value.trim().toLowerCase();
  const rowFilter = $('location-row-filter').value;
  return sortLocations(state.data.locations).filter((r) => {
    const rowMatches = !rowFilter || locationRowKey(r) === rowFilter;
    const haystack = [r.code, r.display_name, r.zone, r.row_label, r.bay_label, r.level_label].join(' ').toLowerCase();
    return rowMatches && haystack.includes(term);
  });
}

function renderLocationsTable() {
  const rows = filteredLocationRows();
  $('location-count').textContent = `${rows.length.toLocaleString()} shown · ${state.selectedQrLocations.size.toLocaleString()} selected`;
  $('locations-table').innerHTML = rows.length ? `<table><thead><tr><th></th><th>Code</th><th>Row</th><th>Position</th><th>Name</th><th>Zone</th><th>Type</th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td><input type="checkbox" data-qr-location="${escapeHtml(r.code)}" ${state.selectedQrLocations.has(r.code) ? 'checked' : ''}></td><td><strong>${escapeHtml(r.code)}</strong></td><td>${escapeHtml(r.row_label || '')}</td><td>${escapeHtml(r.bay_label || '')}</td><td class="wrap">${escapeHtml(r.display_name || '')}</td><td>${escapeHtml(r.zone || '')}</td><td>${r.is_pending ? 'Pending' : 'Rack'}</td>
  </tr>`).join('')}</tbody></table>` : emptyState('No locations match the selected row or search.');
}

function selectVisibleQrLocations() {
  filteredLocationRows().forEach((row) => state.selectedQrLocations.add(row.code));
  renderLocationsTable();
}

function clearQrSelection() {
  state.selectedQrLocations.clear();
  renderLocationsTable();
}

async function addLocation(event) {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, true, 'Adding…');
  const { error } = await supabase.rpc('add_location', {
    p_code: $('loc-code').value,
    p_display_name: $('loc-name').value || null,
    p_zone: $('loc-zone').value || null,
    p_row: $('loc-row').value || null,
    p_bay: $('loc-bay').value || null,
    p_level: $('loc-level').value || null,
    p_is_pending: $('loc-pending').checked
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');
  event.target.reset();
  state.data.locations = [];
  state.data.rackMap = [];
  state.data.audit = [];
  toast('Location added.', 'success');
  await loadLocations(true);
}

function toggleQrSelection(code, checked) {
  if (checked) state.selectedQrLocations.add(code); else state.selectedQrLocations.delete(code);
  $('location-count').textContent = `${filteredLocationRows().length.toLocaleString()} shown · ${state.selectedQrLocations.size.toLocaleString()} selected`;
}

async function printSelectedQrLabels() {
  if (!state.selectedQrLocations.size) return toast('Select at least one location.', 'error');
  const printArea = document.createElement('section');
  printArea.id = 'print-area';
  printArea.className = 'qr-print-grid';
  document.body.appendChild(printArea);
  try {
    const selectedRows = sortLocations(state.data.locations.filter((row) => state.selectedQrLocations.has(row.code)));
    const selectedCodes = selectedRows.length
      ? selectedRows.map((row) => row.code)
      : [...state.selectedQrLocations].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const code of selectedCodes) {
      const dataUrl = await QRCode.toDataURL(`LOC:${code}`, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
      printArea.insertAdjacentHTML('beforeend', `<div class="qr-label"><img src="${dataUrl}" alt="QR ${escapeHtml(code)}"><strong>${escapeHtml(code)}</strong><span>Rack Location</span></div>`);
    }
    window.print();
  } catch (error) {
    toast(`QR generation failed: ${friendlyError(error)}`, 'error');
  } finally {
    setTimeout(() => printArea.remove(), 1000);
  }
}

async function applyAdministrativeCode() {
  const code = $('admin-code').value;
  if (!code) return toast('Enter an administrative control code.', 'error');
  const button = $('admin-code-btn');
  setBusy(button, true, 'Applying…');
  const { data, error } = await supabase.rpc('apply_administrative_code', { p_code: code });
  setBusy(button, false);
  $('admin-code').value = '';
  if (error) return toast(friendlyError(error), 'error');
  const row = data?.[0];
  if (row?.new_mode === 'INVALID') return toast('Invalid administrative control code.', 'error');
  if (row?.new_mode === 'LOCKED_OUT') return toast('Too many unsuccessful attempts. Try again after 10 minutes.', 'error');
  applyMode(row.new_mode);
  state.data.history = [];
  state.data.audit = [];
  $('control-result').textContent = `${row.new_mode === 'ACTIVE' ? 'Operations resumed' : 'Administrative Pause activated'} · ${row.transaction_no}`;
  $('control-result').classList.remove('hidden');
  toast('Global system mode changed across connected devices.', 'success');
}

async function openScanner(targetId, kind) {
  state.scanner.target = targetId;
  state.scanner.kind = kind;
  $('scanner-title').textContent = kind === 'location' ? 'Scan rack QR' : 'Scan barcode';
  $('manual-scan-input').value = '';
  $('scanner-status').textContent = 'Choose a camera or use the manual / USB scanner field.';
  $('scanner-dialog').showModal();
  await listCameras();
  await startCamera();
}

async function listCameras() {
  try {
    const devices = await BrowserCodeReader.listVideoInputDevices();
    $('camera-select').innerHTML = devices.map((d, index) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Camera ${index + 1}`)}</option>`).join('');
    const rearIndex = devices.findIndex((d) => /back|rear|environment/i.test(d.label));
    if (rearIndex >= 0) $('camera-select').selectedIndex = rearIndex;
  } catch (error) {
    $('scanner-status').textContent = `Camera list unavailable: ${friendlyError(error)}`;
  }
}

async function startCamera() {
  stopCamera();
  try {
    state.scanner.reader = new BrowserMultiFormatReader();
    const deviceId = $('camera-select').value || undefined;
    $('scanner-status').textContent = 'Scanning…';
    state.scanner.controls = await state.scanner.reader.decodeFromVideoDevice(deviceId, $('scanner-video'), (result, error) => {
      if (result) acceptScannedValue(result.getText());
      else if (error && error.name !== 'NotFoundException') $('scanner-status').textContent = friendlyError(error);
    });
  } catch (error) {
    $('scanner-status').textContent = `Camera could not start: ${friendlyError(error)}. Use HTTPS and allow camera permission, or type the code below.`;
  }
}

function stopCamera() {
  try { state.scanner.controls?.stop(); } catch (_) { /* no-op */ }
  state.scanner.controls = null;
  const stream = $('scanner-video').srcObject;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  $('scanner-video').srcObject = null;
}

function closeScanner() {
  stopCamera();
  if ($('scanner-dialog').open) $('scanner-dialog').close();
}

function acceptScannedValue(rawValue) {
  const value = state.scanner.kind === 'location' ? normalizeLocation(rawValue) : String(rawValue || '').trim();
  if (!value) return;
  const target = $(state.scanner.target);
  target.value = value;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  closeScanner();
  toast(`Scanned: ${value}`, 'success');
}

function exportDataset(name) {
  let rows = [];
  let filename = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  if (name === 'inventory') rows = state.data.inventory;
  if (name === 'containers') rows = state.data.containers;
  if (name === 'expiry') rows = state.data.expiry;
  if (name === 'history') rows = state.data.history;
  if (name === 'audit') rows = state.data.audit;
  if (!rows.length) return toast('Load the report first; there is no data to export.', 'error');
  const columns = Object.keys(rows[0]);
  const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

renderPutawayCart();
renderOperationCart('pick');
renderOperationCart('transfer');
clearPickBarcodeMatch();
renderPickSalesOrderSummary();
init();
