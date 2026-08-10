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
const NO_EXPIRY_DATE = '9999-12-31';
const isNoExpiryDate = (value) => String(value || '').slice(0, 10) === NO_EXPIRY_DATE;
const fmtDate = (value) => isNoExpiryDate(value) ? 'N/A' : value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString() : '—';
const fmtDateTime = (value) => value ? new Date(value).toLocaleString() : '—';
const localDateKey = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
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
  shipperPutaway: freshShipperPutawayState(),
  pick: freshOperationState(),
  pickOrder: { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false },
  pickOrderLookupSequence: 0,
  pickOrderSummary: [],
  transfer: freshOperationState(),
  data: { inventory: [], skuMaster: [], skuHealth: [], containers: [], expiry: [], nonFefo: [], users: [], history: [], audit: [], locations: [], rackMap: [] },
  selectedQrLocations: new Set(),
  accountAccessTimer: null
};

function freshOperationState() {
  return { lockToken: null, locationCode: null, heartbeat: null, cart: [], lots: [], rackLots: [], sku: null, naMode: false, adjustmentSessionKey: null };
}

function isStockAdjustmentSalesOrder(value) {
  return String(value ?? '').trim() === '0';
}

function isInternalStockAdjustmentKey(value) {
  return String(value ?? '').trim().toUpperCase().startsWith('__WMS_ADJ0__:');
}

function freshShipperPutawayState() {
  return {
    matchedShipperSku: null,
    shipperLookupSequence: 0,
    duplicateShipperSkuId: null,
    contents: [],
    contentSku: null,
    contentLookupSequence: 0,
    duplicateContentSkuId: null
  };
}

const screenMeta = {
  dashboard: ['Dashboard', 'Live warehouse overview'],
  putaway: ['Put-away', 'Receive pallet contents into a rack location'],
  picking: ['Picking', 'FEFO-guided picking by source location'],
  transfer: ['Stock transfer', 'Move stock lots between rack locations'],
  inventory: ['Inventory', 'Stock by SKU, container, expiry, and location'],
  skumaster: ['SKU Masterlist', 'Permanent SKU details and registered CASE / PACK / PIECE barcodes'],
  skuhealth: ['SKU Master Data Health', 'Admin/Owner duplicate, split-barcode, incomplete, and archived SKU review'],
  containers: ['Containers', 'Container consumption and remaining contents'],
  rackmap: ['Rack map', 'Visual location occupancy and active locks'],
  expiry: ['Expiry alerts', 'Expired and near-expiry stock'],
  nonfefo: ['Non-FEFO Compliance', 'Confirmed picking transactions that disregarded FEFO'],
  users: ['User Management', 'Registered users, roles, and account access'],
  systemmanager: ['System Manager', 'Supabase Free usage, retention, and controlled history cleanup'],
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
  return ['supervisor', 'admin', 'owner'].includes(state.profile?.role);
}

function isOwner() {
  return state.profile?.role === 'owner';
}

function isAdminOrOwner() {
  return ['admin', 'owner'].includes(state.profile?.role);
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
  $('pa-no-expiry').addEventListener('change', () => syncNoExpiryControl('pa-expiry', 'pa-no-expiry'));
  $('sp-content-no-expiry').addEventListener('change', () => syncNoExpiryControl('sp-content-expiry', 'sp-content-no-expiry'));
  $('pa-clear-line-btn').addEventListener('click', clearPutawayLine);
  $('pa-cancel-btn').addEventListener('click', resetPutawaySession);
  $('pa-complete-btn').addEventListener('click', completePutaway);
  ['pa-piece', 'pa-pack', 'pa-case'].forEach((id) => $(id).addEventListener('change', resolvePutawaySku));
  ['pa-brand', 'pa-description', 'pa-variant', 'pa-size'].forEach((id) => $(id).addEventListener('input', () => {
    clearTimeout(putawayDetailsTimer);
    putawayDetailsTimer = setTimeout(checkPutawayDuplicateDetails, 350);
  }));

  $('pa-mode-select').addEventListener('change', switchPutawayMode);
  $('shipper-putaway-form').addEventListener('submit', (event) => event.preventDefault());
  $('sp-case').addEventListener('change', resolveShipperSku);
  $('sp-content-pack').addEventListener('change', resolveShipperContentSku);
  ['sp-brand', 'sp-description', 'sp-variant', 'sp-size'].forEach((id) => $(id).addEventListener('input', () => {
    clearTimeout(putawayDetailsTimer);
    putawayDetailsTimer = setTimeout(checkShipperDuplicateDetails, 350);
  }));
  ['sp-content-brand', 'sp-content-description', 'sp-content-variant', 'sp-content-size'].forEach((id) => $(id).addEventListener('input', () => {
    clearTimeout(putawayDetailsTimer);
    putawayDetailsTimer = setTimeout(checkShipperContentDuplicateDetails, 350);
  }));
  $('sp-add-content-btn').addEventListener('click', addShipperContentLine);
  $('sp-clear-content-btn').addEventListener('click', clearShipperContentLine);
  $('sp-cancel-btn').addEventListener('click', resetShipperPutaway);
  $('sp-complete-btn').addEventListener('click', completeShipperPutaway);

  // Barcode entry must always remain exactly what the user typed/scanned.
  // Disable browser form-history/autocomplete so a partial code such as 12345
  // is never expanded to a previously used longer barcode.
  ['pa-case', 'pa-pack', 'pa-piece', 'sp-case', 'sp-content-pack', 'pick-barcode', 'tr-barcode'].forEach((id) => {
    const input = $(id);
    input.setAttribute('autocomplete', 'off');
    // A unique field name prevents Chrome/form-history from treating this barcode
    // field as the same previously completed input across visits. This is important
    // for real short barcodes such as 12345, which must never be expanded to a
    // previously entered longer code.
    input.name = `wms-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-autocomplete', 'none');
  });

  $('pick-lock-btn').addEventListener('click', lockPickLocation);
  $('pick-so').addEventListener('change', refreshPickSalesOrderStatus);
  $('pick-so').addEventListener('blur', refreshPickSalesOrderStatus);
  $('pick-so-override').addEventListener('change', syncPickOverrideControls);
  $('pick-barcode').addEventListener('change', () => loadOperationLots('pick'));
  $('pick-lot').addEventListener('change', () => handleOperationLotChange('pick'));
  $('pick-qty').addEventListener('input', updatePickQtyNote);
  $('pick-add-btn').addEventListener('click', () => addOperationItem('pick'));
  $('pick-cancel-btn').addEventListener('click', () => cancelOperation('pick'));
  $('pick-cancel-order-btn').addEventListener('click', cancelEntirePicking);
  $('pick-complete-btn').addEventListener('click', completePicking);
  $('pick-finish-so-btn').addEventListener('click', finishPickSalesOrder);
  $('pick-summary-refresh-btn').addEventListener('click', loadPickSalesOrderSummary);

  $('tr-lock-btn').addEventListener('click', lockTransferLocation);
  $('tr-barcode').addEventListener('change', () => loadOperationLots('transfer'));
  $('tr-lot').addEventListener('change', () => handleOperationLotChange('transfer'));
  $('tr-qty').addEventListener('input', updateTransferQtyNote);
  $('tr-add-btn').addEventListener('click', () => addOperationItem('transfer'));
  $('tr-cancel-btn').addEventListener('click', () => cancelOperation('transfer'));
  $('tr-complete-btn').addEventListener('click', completeTransfer);

  $('inventory-search').addEventListener('input', renderInventory);
  $('sku-master-search').addEventListener('input', renderSkuMaster);
  $('sku-health-search').addEventListener('input', renderSkuHealth);
  $('sku-health-filter').addEventListener('change', renderSkuHealth);
  $('container-search').addEventListener('input', renderContainers);
  $('history-search').addEventListener('input', renderHistory);
  $('history-type').addEventListener('change', renderHistory);
  $('nonfefo-search').addEventListener('input', renderNonFefoCompliance);
  $('nonfefo-from').addEventListener('change', renderNonFefoCompliance);
  $('nonfefo-to').addEventListener('change', renderNonFefoCompliance);
  $('users-search').addEventListener('input', renderUsers);
  $('users-role').addEventListener('change', renderUsers);
  $('users-status').addEventListener('change', renderUsers);
  $('rack-map-row').addEventListener('change', renderRackMap);
  $('rack-map-search').addEventListener('input', renderRackMap);

  $('location-form').addEventListener('submit', addLocation);
  $('location-search').addEventListener('input', renderLocationsTable);
  $('location-row-filter').addEventListener('change', renderLocationsTable);
  $('select-visible-qr-btn').addEventListener('click', selectVisibleQrLocations);
  $('clear-qr-btn').addEventListener('click', clearQrSelection);
  $('print-qr-btn').addEventListener('click', printSelectedQrLabels);
  $('admin-code-btn').addEventListener('click', applyAdministrativeCode);
  $('full-reset-open-btn').addEventListener('click', openFullResetDialog);
  $('full-reset-close').addEventListener('click', () => $('full-reset-dialog').close());
  $('full-reset-form').addEventListener('submit', submitFullReset);
  $('system-manager-refresh-btn').addEventListener('click', () => loadSystemManager(true));
  $('system-manager-usage-link').addEventListener('click', () => {
    window.open('https://supabase.com/dashboard/org/_/usage', '_blank', 'noopener,noreferrer');
  });
  $('system-history-preview-btn').addEventListener('click', previewSystemHistoryDelete);
  $('system-history-delete-form').addEventListener('submit', deleteSystemHistoryRange);

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
  $('inventory-adjust-close').addEventListener('click', () => $('inventory-adjust-dialog').close());
  $('inventory-adjust-form').addEventListener('submit', submitInventoryLotEdit);
  $('sku-master-edit-close').addEventListener('click', () => $('sku-master-edit-dialog').close());
  $('sku-master-edit-form').addEventListener('submit', submitSkuMasterEdit);
  $('user-role-close').addEventListener('click', () => $('user-role-dialog').close());
  $('user-role-form').addEventListener('submit', submitUserRoleChange);
  $('user-role-select').addEventListener('change', syncOwnerPromotionPasswordField);

  document.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-cart]');
    if (remove) removeCartItem(remove.dataset.operation, Number(remove.dataset.removeCart));
    const removePutaway = event.target.closest('[data-remove-putaway]');
    if (removePutaway) removePutawayItem(Number(removePutaway.dataset.removePutaway));
    const removeShipperContent = event.target.closest('[data-remove-shipper-content]');
    if (removeShipperContent) removeShipperContentLine(Number(removeShipperContent.dataset.removeShipperContent));
    const detail = event.target.closest('[data-container-detail]');
    if (detail) showContainerDetail(detail.dataset.containerDetail);
    const edit = event.target.closest('[data-edit-transaction]');
    if (edit) openSupervisorEdit(edit.dataset.editTransaction);
    const inventoryEdit = event.target.closest('[data-inventory-edit]');
    if (inventoryEdit) openInventoryLotEdit(inventoryEdit.dataset.inventoryEdit);
    const inventoryDelete = event.target.closest('[data-inventory-delete]');
    if (inventoryDelete) deleteInventoryLot(inventoryDelete.dataset.inventoryDelete);
    const skuMasterEdit = event.target.closest('[data-sku-master-edit]');
    if (skuMasterEdit) openSkuMasterEdit(skuMasterEdit.dataset.skuMasterEdit);
    const skuMasterDelete = event.target.closest('[data-sku-master-delete]');
    if (skuMasterDelete) deleteSkuMaster(skuMasterDelete.dataset.skuMasterDelete);
    const skuHealthReview = event.target.closest('[data-sku-health-review]');
    if (skuHealthReview) reviewSkuHealthInMasterlist(skuHealthReview.dataset.skuHealthReview);
    const containerDelete = event.target.closest('[data-container-delete]');
    if (containerDelete) deleteConsumedContainer(containerDelete.dataset.containerDelete);
    const userRole = event.target.closest('[data-user-role]');
    if (userRole) openUserRoleDialog(userRole.dataset.userRole);
    const userActive = event.target.closest('[data-user-active]');
    if (userActive) toggleManagedUserActive(userActive.dataset.userActive);
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
  const configuredAppName = cfg.APP_NAME || 'Warehouse Control System v1';
  $('app-name').textContent = configuredAppName;
  document.title = configuredAppName;
  const authTitle = document.querySelector('#auth-view .brand-lockup h1');
  if (authTitle) authTitle.textContent = configuredAppName;
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
  resetShipperPutaway();
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

  applyCurrentProfile(profile);
  $('auth-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  await loadSystemMode();
  subscribeRealtime();
  startAccountAccessWatch();

  const savedScreen = getSavedScreen();
  showScreen(canOpenScreen(savedScreen) ? savedScreen : 'dashboard');
}

function applyCurrentProfile(profile) {
  state.profile = profile;
  $('current-username').textContent = profile?.username || '—';
  $('current-role').textContent = profile?.role || '—';
  qsa('[data-role-min="supervisor"]').forEach((node) => node.classList.toggle('hidden', !isSupervisor()));
  qsa('[data-role-min="admin"]').forEach((node) => node.classList.toggle('hidden', !isAdminOrOwner()));
  const ownerFilterOption = $('users-role')?.querySelector('option[value="owner"]');
  if (ownerFilterOption) {
    ownerFilterOption.hidden = !isOwner();
    if (!isOwner() && $('users-role').value === 'owner') $('users-role').value = '';
  }
  const controlNav = document.querySelector('#main-nav [data-screen="control"]');
  if (controlNav) controlNav.classList.toggle('hidden', !isOwner());
}

async function refreshOwnAccountAccess() {
  if (!state.session?.user?.id || !supabase) return;
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', state.session.user.id)
    .single();
  if (error || !profile) {
    toast('Your WMS account no longer exists or is no longer accessible.', 'error');
    stopAccountAccessWatch();
    await supabase.auth.signOut();
    return;
  }

  if (!profile.is_active) {
    toast('Your account has been kicked out by an administrator.', 'error');
    stopAccountAccessWatch();
    await supabase.auth.signOut();
    return;
  }

  const roleChanged = state.profile?.role !== profile.role;
  applyCurrentProfile(profile);
  if (roleChanged) {
    state.data.users = [];
    if (!canOpenScreen(state.currentScreen)) showScreen('dashboard');
    else if (state.currentScreen === 'users') loadUsers(true);
  }
}

function startAccountAccessWatch() {
  stopAccountAccessWatch();
  state.accountAccessTimer = window.setInterval(refreshOwnAccountAccess, 15000);
}

function stopAccountAccessWatch() {
  if (state.accountAccessTimer) window.clearInterval(state.accountAccessTimer);
  state.accountAccessTimer = null;
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
  $('sp-add-content-btn').disabled = !active;
  $('sp-complete-btn').disabled = !active || !state.shipperPutaway.contents.length;
  if (state.putaway.cart.length) $('pa-complete-btn').disabled = !active;
  if (state.pick.lockToken) $('pick-complete-btn').disabled = !active;
  updatePickSalesOrderControls();
  if (state.transfer.lockToken) $('tr-complete-btn').disabled = !active;
}

function subscribeRealtime() {
  unsubscribeRealtime();
  let channel = supabase.channel('wms-global-state')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_settings', filter: 'id=eq.1' },
      (payload) => applyMode(payload.new.operational_mode));

  if (state.session?.user?.id) {
    channel = channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${state.session.user.id}` },
      () => refreshOwnAccountAccess()
    );
  }

  state.realtimeChannel = channel.subscribe();
}

function unsubscribeRealtime() {
  if (state.realtimeChannel && supabase) supabase.removeChannel(state.realtimeChannel);
  state.realtimeChannel = null;
  stopAccountAccessWatch();
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
  if (name === 'locations' && !isSupervisor()) return false;
  if (name === 'skumaster' && !isSupervisor()) return false;
  if (name === 'nonfefo' && !isSupervisor()) return false;
  if ((name === 'users' || name === 'systemmanager' || name === 'skuhealth') && !isAdminOrOwner()) return false;
  if (name === 'control' && !isOwner()) return false;
  return true;
}

function showScreen(name) {
  if (!canOpenScreen(name)) {
    if ((name === 'locations' || name === 'skumaster' || name === 'nonfefo') && !isSupervisor()) toast('Supervisor access is required.', 'error');
    if ((name === 'users' || name === 'systemmanager' || name === 'skuhealth') && !isAdminOrOwner()) toast('Admin or Owner access is required.', 'error');
    if (name === 'control' && !isOwner()) toast('Owner access is required.', 'error');
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
    if (name === 'skumaster') await loadSkuMaster(force);
    if (name === 'skuhealth') await loadSkuHealth(force);
    if (name === 'containers') await loadContainers(force);
    if (name === 'rackmap') await loadRackMap(force);
    if (name === 'expiry') await loadExpiry(force);
    if (name === 'nonfefo') await loadNonFefoCompliance(force);
    if (name === 'users') await loadUsers(force);
    if (name === 'systemmanager') await loadSystemManager(force);
    if (name === 'history') await loadHistory(force);
    if (name === 'locations') await loadLocations(force);
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

async function loadDashboard() {
  const [inventoryRes, locationRes, historyRes, pendingSoRes, activeLocksRes] = await Promise.all([
    supabase.from('v_inventory_details').select('*').limit(10000),
    supabase.from('v_location_summary').select('*').limit(5000),
    supabase.from('v_history_details').select('*').order('created_at', { ascending: false }).limit(12),
    supabase.rpc('get_dashboard_pending_pick_sales_orders'),
    supabase.rpc('get_dashboard_active_location_locks')
  ]);
  [inventoryRes, locationRes, historyRes, pendingSoRes, activeLocksRes].forEach((r) => { if (r.error) throw r.error; });
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

  renderDashboardPendingSalesOrders(pendingSoRes.data || []);
  renderDashboardActiveLocks(activeLocksRes.data || []);
  renderDashboardConsolidation(inventory);

  if (locked) toast(`${locked} location${locked === 1 ? '' : 's'} currently locked for active work.`);
}

function renderDashboardPendingSalesOrders(rows) {
  const container = $('dashboard-pending-sales-orders');
  const count = $('dashboard-pending-sales-orders-count');
  if (!container || !count) return;

  count.textContent = `${rows.length} pending`;
  if (!rows.length) {
    container.innerHTML = emptyState('No Sales Order has saved rack picks waiting for Finish Sales Order.');
    return;
  }

  container.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>Sales Order</th><th>Picker / locked to</th><th>Completed rack picks</th><th>Started</th><th>Last saved pick</th>
  </tr></thead><tbody>${rows.map((r) => `<tr>
    <td><strong>${escapeHtml(r.sales_order)}</strong></td>
    <td>${escapeHtml(r.picker_username || '—')}</td>
    <td>${Number(r.completed_rack_picks || 0).toLocaleString()}</td>
    <td>${fmtDateTime(r.started_at)}</td>
    <td>${fmtDateTime(r.last_pick_at)}</td>
  </tr>`).join('')}</tbody></table></div>`;
}

function renderDashboardActiveLocks(rows) {
  const container = $('dashboard-active-rack-locks');
  const count = $('dashboard-active-rack-locks-count');
  if (!container || !count) return;

  count.textContent = `${rows.length} active`;
  if (!rows.length) {
    container.innerHTML = emptyState('No rack location is currently locked for Picking or Stock Transfer.');
    return;
  }

  container.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>Rack</th><th>Operation</th><th>User</th><th>Sales Order</th><th>Locked at</th><th>Lock expires</th>
  </tr></thead><tbody>${rows.map((r) => `<tr>
    <td><strong>${escapeHtml(r.location_code)}</strong></td>
    <td>${escapeHtml(r.operation === 'PICK' ? 'Picking' : r.operation === 'TRANSFER' ? 'Stock Transfer' : r.operation)}</td>
    <td>${escapeHtml(r.username || '—')}</td>
    <td>${isInternalStockAdjustmentKey(r.sales_order) ? '<strong>0</strong><br><small>Stock Adjustment</small>' : escapeHtml(r.sales_order || '—')}</td>
    <td>${fmtDateTime(r.acquired_at)}</td>
    <td>${fmtDateTime(r.expires_at)}</td>
  </tr>`).join('')}</tbody></table></div>`;
}

function normalizedConsolidationText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function renderDashboardConsolidation(inventory) {
  const container = $('dashboard-consolidation');
  if (!container) return;

  // Physical stock only. PENDING is not a rack and a Shipper HEADER is a virtual
  // 1-CASE representation of the sealed physical box, not an additional SKU lot.
  const physicalRows = (inventory || []).filter((r) =>
    !r.is_pending &&
    Number(r.qty || 0) > 0 &&
    String(r.shipper_lot_role || '').toUpperCase() !== 'HEADER'
  );

  const groups = new Map();
  physicalRows.forEach((r) => {
    const key = [
      normalizedConsolidationText(r.brand),
      normalizedConsolidationText(r.description),
      normalizedConsolidationText(r.variant),
      normalizedConsolidationText(r.size),
      normalizedConsolidationText(r.container_no),
      String(r.expiry_date || '')
    ].join('|');

    if (!groups.has(key)) {
      groups.set(key, {
        sku_name: [r.brand, r.description, r.variant, r.size].filter(Boolean).join(' '),
        container_no: r.container_no,
        expiry_date: r.expiry_date,
        balances: { PIECE: 0, PACK: 0, CASE: 0 },
        locations: new Map()
      });
    }

    const group = groups.get(key);
    const uom = String(r.uom || '').toUpperCase();
    group.balances[uom] = (group.balances[uom] || 0) + Number(r.qty || 0);

    if (!group.locations.has(r.location_code)) {
      group.locations.set(r.location_code, {
        code: r.location_code,
        sort_order: Number(r.location_sort_order ?? Number.MAX_SAFE_INTEGER),
        balances: { PIECE: 0, PACK: 0, CASE: 0 },
        shipper_boxes: new Set()
      });
    }
    const loc = group.locations.get(r.location_code);
    loc.balances[uom] = (loc.balances[uom] || 0) + Number(r.qty || 0);
    if (r.shipper_box_no) loc.shipper_boxes.add(r.shipper_box_no);
  });

  const opportunities = [...groups.values()]
    .filter((g) => g.locations.size > 1)
    .sort((a, b) => b.locations.size - a.locations.size || a.sku_name.localeCompare(b.sku_name) || String(a.container_no).localeCompare(String(b.container_no)));

  $('dashboard-consolidation-count').textContent = `${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'}`;

  if (!opportunities.length) {
    container.innerHTML = emptyState('No current stock with the same SKU details, container, and expiry is spread across multiple physical rack locations.');
    return;
  }

  container.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>SKU</th><th>Container</th><th>Expiry</th><th>Total stock</th><th>Rack locations to consolidate</th><th>Rack count</th>
  </tr></thead><tbody>${opportunities.map((g) => {
    const locations = [...g.locations.values()]
      .sort((a, b) => a.sort_order - b.sort_order || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }))
      .map((loc) => {
        const boxes = [...loc.shipper_boxes].sort();
        const shipperText = boxes.length ? ` · ${boxes.map((box) => escapeHtml(box)).join(', ')}` : '';
        return `<strong>${escapeHtml(loc.code)}</strong> — ${formatBalances(loc.balances)}${shipperText}`;
      }).join('<br>');
    return `<tr>
      <td class="wrap"><strong>${escapeHtml(g.sku_name)}</strong></td>
      <td>${escapeHtml(g.container_no)}</td>
      <td>${fmtDate(g.expiry_date)}</td>
      <td>${formatBalances(g.balances)}</td>
      <td class="wrap">${locations}</td>
      <td><strong>${g.locations.size}</strong></td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
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
  state.data.skuMaster = [];
  state.data.skuHealth = [];
  state.data.containers = [];
  state.data.expiry = [];
  state.data.nonFefo = [];
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

function shipperDescriptor(lot) {
  if (!lot?.shipper_box_id) return 'Loose / standard stock';
  const role = lot.shipper_lot_role === 'HEADER' ? 'Complete Shipper' : 'Inside Shipper';
  return `${lot.shipper_box_no || 'Shipper'} · ${lot.shipper_status || '—'} · ${role}`;
}

function shipperBadge(lot) {
  if (!lot?.shipper_box_id) return '<span class="pill">Loose</span>';
  const role = lot.shipper_lot_role === 'HEADER' ? 'Complete' : 'Content';
  return `<span class="pill near">${escapeHtml(lot.shipper_box_no || 'Shipper')} · ${escapeHtml(role)}</span><br><small>${escapeHtml(lot.shipper_status || '')}</small>`;
}

function shipperOptionSuffix(lot) {
  if (!lot?.shipper_box_id) return ' · Loose stock';
  const role = lot.shipper_lot_role === 'HEADER' ? 'Complete Shipper' : 'Inside Shipper';
  return ` · ${lot.shipper_box_no || 'Shipper'} · ${role} · ${lot.shipper_status || ''}`;
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

function archivedSkuLabel(sku) {
  return [sku?.brand, sku?.description, sku?.variant, sku?.size].filter(Boolean).join(' ');
}

function archivedSkuBarcodeText(sku) {
  return `CASE: ${sku?.case_barcode || 'N/A'} · PACK: ${sku?.pack_barcode || 'N/A'} · PIECE: ${sku?.piece_barcode || 'N/A'}`;
}

async function offerArchivedSkuReactivation(sku, contextLabel = 'Put-away') {
  if (!sku?.id) return false;

  const label = archivedSkuLabel(sku);
  const deletedInfo = sku.deleted_at ? `\nDeleted: ${fmtDateTime(sku.deleted_at)}` : '';
  const deletedReason = sku.delete_reason ? `\nPrevious delete reason: ${sku.delete_reason}` : '';

  if (!isAdminOrOwner()) {
    toast('This barcode belongs to a previously deleted SKU. Ask an Admin or Owner to reactivate it.', 'warning');
    return false;
  }

  const ok = window.confirm(
    `This SKU was previously deleted from the SKU Masterlist.\n\n` +
    `${label}\n${archivedSkuBarcodeText(sku)}${deletedInfo}${deletedReason}\n\n` +
    `Do you want to reactivate the SAME original SKU record for ${contextLabel}?`
  );
  if (!ok) return false;

  const reason = window.prompt(
    `Enter the reason for reactivating this SKU:\n\n${label}`,
    'SKU received again during Put-away'
  );
  if (reason === null) return false;
  if (!reason.trim()) {
    toast('A reason is required to reactivate an archived SKU.', 'error');
    return false;
  }

  const { error } = await supabase.rpc('admin_reactivate_sku_master', {
    p_sku_id: sku.id,
    p_reason: reason.trim()
  });
  if (error) {
    toast(friendlyError(error), 'error');
    return false;
  }

  invalidateReports();
  toast('Archived SKU reactivated. The original SKU record and barcode family were restored.', 'success');
  return true;
}

async function findArchivedSkuByDetails(details, skuType = 'STANDARD') {
  const { data, error } = await supabase.rpc('find_archived_sku_by_details_type', {
    ...details,
    p_sku_type: skuType
  });
  if (error) throw error;
  return data || [];
}

async function resolvePutawaySku() {
  const sequence = ++state.putaway.lookupSequence;
  const fields = [
    { id: 'pa-piece', expectedType: 'PIECE', label: 'PIECE' },
    { id: 'pa-pack', expectedType: 'PACK', label: 'PACK' },
    { id: 'pa-case', expectedType: 'CASE', label: 'CASE' }
  ];

  const entered = fields.map((field) => {
    const value = normalizeBarcode($(field.id).value);
    $(field.id).value = value;
    return { ...field, value };
  });
  const actualEntries = entered.filter((entry) => entry.value && entry.value !== 'N/A');

  if (!actualEntries.length) {
    state.putaway.matchedSkuId = null;
    setPutawayDetailsReadonly(false);
    $('pa-match-note').classList.add('hidden');
    await checkPutawayDuplicateDetails();
    return 'new';
  }

  // Barcode uniqueness is category-scoped: CASE is unique among CASE codes,
  // PACK among PACK codes, and PIECE among PIECE codes. The same text may
  // legitimately exist in another barcode category, so cross-category matches
  // are warnings only and never rewrite the user's field.
  const responses = await Promise.all(actualEntries.map(async (entry) => {
    const [typed, all, archivedTyped] = await Promise.all([
      supabase.rpc('find_sku_by_barcode_type', { p_barcode: entry.value, p_barcode_type: entry.expectedType }),
      supabase.rpc('find_sku_barcode_matches', { p_barcode: entry.value }),
      supabase.rpc('find_archived_sku_by_barcode_type', { p_barcode: entry.value, p_barcode_type: entry.expectedType })
    ]);
    return { entry, typed, all, archivedTyped };
  }));
  if (sequence !== state.putaway.lookupSequence) return 'stale';

  const failed = responses.find((response) => response.typed.error || response.all.error || response.archivedTyped.error);
  if (failed) return toast(friendlyError(failed.typed.error || failed.all.error || failed.archivedTyped.error), 'error') || 'error';

  const typedRows = responses.flatMap((response) => response.typed.data?.[0] ? [response.typed.data[0]] : []);
  const matches = uniqueBy(typedRows, (row) => row.id);
  const archivedTypedRows = uniqueBy(
    responses.flatMap((response) => response.archivedTyped.data?.[0] ? [response.archivedTyped.data[0]] : []),
    (row) => row.id
  );

  if (matches.length > 1) {
    state.putaway.matchedSkuId = null;
    setPutawayDetailsReadonly(false);
    $('pa-match-note').innerHTML = '<strong>Barcode conflict:</strong> the entered CASE/PACK/PIECE codes belong to different stored SKUs in their respective barcode categories. Nothing was auto-filled; check the entered barcodes.';
    $('pa-match-note').classList.remove('hidden');
    toast('The entered barcodes belong to different stored SKUs.', 'error');
    return 'conflict';
  }

  const sku = matches[0];
  if (sku) {
    // Once any correctly categorized barcode identifies an existing SKU, every
    // manually entered category must agree with that SKU's stored master record.
    for (const entry of actualEntries) {
      const stored = normalizeBarcode(sku[`${entry.expectedType.toLowerCase()}_barcode`]);
      if (entry.value.toLowerCase() !== stored.toLowerCase()) {
        state.putaway.matchedSkuId = null;
        setPutawayDetailsReadonly(false);
        $('pa-match-note').innerHTML = `<strong>Barcode conflict:</strong> the entered ${escapeHtml(entry.expectedType)} barcode ${escapeHtml(entry.value)} does not match the stored ${escapeHtml(entry.expectedType)} barcode for the SKU identified by the other field(s). Nothing was auto-filled.`;
        $('pa-match-note').classList.remove('hidden');
        toast(`The entered ${entry.expectedType} barcode does not match the stored SKU.`, 'error');
        return 'conflict';
      }
    }

    if (String(sku.sku_type || 'STANDARD').toUpperCase() === 'SHIPPER') {
      state.putaway.matchedSkuId = null;
      setPutawayDetailsReadonly(false);
      $('pa-match-note').innerHTML = '<strong>Shipper CASE barcode detected.</strong> Change Put-away type to <strong>Shipper Box</strong> so the physical box contents and expiry lots can be encoded.';
      $('pa-match-note').classList.remove('hidden');
      return 'error';
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
    $('pa-match-note').innerHTML = 'Existing SKU found through the <strong>matching barcode category</strong>. The stored CASE/PACK/PIECE barcode set and SKU details were loaded from the database.';
    $('pa-match-note').classList.remove('hidden');
    return 'existing';
  }

  if (!matches.length && archivedTypedRows.length) {
    if (archivedTypedRows.length > 1) {
      state.putaway.matchedSkuId = null;
      setPutawayDetailsReadonly(false);
      $('pa-match-note').innerHTML = '<strong>Archived SKU conflict:</strong> the entered barcode categories point to more than one previously deleted SKU. Do not create a new SKU. Review SKU Master Data Health.';
      $('pa-match-note').classList.remove('hidden');
      toast('The entered barcodes point to different archived SKU records.', 'error');
      return 'conflict';
    }

    const archivedSku = archivedTypedRows[0];

    for (const entry of actualEntries) {
      const stored = normalizeBarcode(archivedSku[`${entry.expectedType.toLowerCase()}_barcode`]);
      if (entry.value.toLowerCase() !== stored.toLowerCase()) {
        state.putaway.matchedSkuId = null;
        setPutawayDetailsReadonly(false);
        $('pa-match-note').innerHTML =
          `<strong>Archived SKU barcode conflict:</strong> ${escapeHtml(entry.expectedType)} ${escapeHtml(entry.value)} does not match the archived SKU's stored ${escapeHtml(entry.expectedType)} barcode ${escapeHtml(stored)}.<br>` +
          `Archived SKU: ${escapeHtml(archivedSkuLabel(archivedSku))}. Review SKU Master Data Health instead of creating another master record.`;
        $('pa-match-note').classList.remove('hidden');
        return 'conflict';
      }
    }

    if (String(archivedSku.sku_type || 'STANDARD').toUpperCase() === 'SHIPPER') {
      state.putaway.matchedSkuId = null;
      setPutawayDetailsReadonly(false);
      $('pa-match-note').innerHTML =
        `<strong>Previously deleted Shipper SKU found.</strong> ${escapeHtml(archivedSkuLabel(archivedSku))}<br>` +
        `${escapeHtml(archivedSkuBarcodeText(archivedSku))}<br>Switch Put-away type to <strong>Shipper Box</strong> to reactivate/use it.`;
      $('pa-match-note').classList.remove('hidden');
      return 'archived';
    }

    $('pa-match-note').innerHTML =
      `<strong>Previously deleted SKU found.</strong> ${escapeHtml(archivedSkuLabel(archivedSku))}<br>` +
      `${escapeHtml(archivedSkuBarcodeText(archivedSku))}<br>` +
      `${isAdminOrOwner() ? 'Confirm reactivation to restore the original SKU record.' : 'Ask an Admin or Owner to reactivate this SKU before Put-away.'}`;
    $('pa-match-note').classList.remove('hidden');

    const reactivated = await offerArchivedSkuReactivation(archivedSku, 'Standard Put-away');
    if (reactivated) return resolvePutawaySku();
    return 'archived';
  }

  // No same-category match exists. Warn about any cross-category use, but allow
  // the user to continue creating this barcode in its entered category.
  const crossWarnings = [];
  responses.forEach((response) => {
    const other = (response.all.data || []).find((row) => String(row.matched_type || '').toUpperCase() !== response.entry.expectedType);
    if (other) {
      const otherType = String(other.matched_type || '').toUpperCase();
      crossWarnings.push(`Barcode type mismatch. ${response.entry.value} was entered in the ${response.entry.expectedType} field, but it is already registered as a ${otherType} barcode. Double-check before proceeding.`);
    }
  });

  state.putaway.matchedSkuId = null;
  setPutawayDetailsReadonly(false);
  if (crossWarnings.length) {
    $('pa-match-note').innerHTML = crossWarnings.map((warning) => `<strong>${escapeHtml(warning)}</strong>`).join('<br>');
    $('pa-match-note').classList.remove('hidden');
    toast(crossWarnings[0], 'warning');
  } else {
    $('pa-match-note').classList.add('hidden');
  }
  await checkPutawayDuplicateDetails();
  return 'new';
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
    try {
      const archivedMatches = await findArchivedSkuByDetails(details, 'STANDARD');
      const archived = archivedMatches[0];
      if (archived) {
        state.putaway.duplicateDetailsSkuId = archived.id;
        $('pa-duplicate-details').textContent =
          `A previously deleted SKU has the same details. Archived barcodes — CASE: ${archived.case_barcode}; PACK: ${archived.pack_barcode}; PIECE: ${archived.piece_barcode}. ` +
          `If this is the same physical product, use its original barcode so Admin/Owner can reactivate the original record. Only use Still Add to Database when this is genuinely a different barcode family.`;
        $('pa-duplicate-warning').classList.remove('hidden');
        return { ...archived, archived: true };
      }
    } catch (archivedError) {
      toast(friendlyError(archivedError), 'error');
    }
    hidePutawayDuplicateWarning();
    return null;
  }

  state.putaway.duplicateDetailsSkuId = match.id;
  $('pa-duplicate-details').textContent = `Existing barcodes — CASE: ${match.case_barcode}; PACK: ${match.pack_barcode}; PIECE: ${match.piece_barcode}. Added by: ${match.created_by_username || 'unknown user'}.`;
  $('pa-duplicate-warning').classList.remove('hidden');
  return match;
}

function syncNoExpiryControl(dateInputId, checkboxId) {
  const dateInput = $(dateInputId);
  const checkbox = $(checkboxId);
  const noExpiry = Boolean(checkbox?.checked);
  if (!dateInput) return;
  if (noExpiry) dateInput.value = '';
  dateInput.disabled = noExpiry;
  dateInput.required = !noExpiry;
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
    expiry_date: $('pa-no-expiry').checked ? NO_EXPIRY_DATE : $('pa-expiry').value,
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
    if (['conflict', 'error', 'stale', 'archived'].includes(resolution)) return;
    if (!form.reportValidity()) return;

    const location = normalizeLocation($('pa-location').value);
    if (!location) return toast('Scan or enter a rack location.', 'error');

    const item = putawayLinePayload();
    const codes = [item.case_barcode, item.pack_barcode, item.piece_barcode];
    if (codes.some((code) => !code)) return toast('CASE, PACK, and PIECE barcode are all required. Enter N/A when unavailable.', 'error');
    const actualCodes = codes.filter((code) => code !== 'N/A').map((code) => code.toLowerCase());
    if (!actualCodes.length) return toast('At least one actual barcode is required; use N/A only for unavailable barcode types.', 'error');
    if ([item.case_qty, item.pack_qty, item.piece_qty].some((qty) => qty < 0)) return toast('Quantities cannot be negative.', 'error');
    if ([item.case_qty, item.pack_qty, item.piece_qty].some((qty) => !Number.isInteger(qty))) return toast('CASE, PACK, and PIECE quantities must be whole numbers only (0, 1, 2, 3, ...).', 'error');
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
  $('pa-no-expiry').checked = false;
  syncNoExpiryControl('pa-expiry', 'pa-no-expiry');
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
  syncNoExpiryControl('pa-expiry', 'pa-no-expiry');
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
  if (state.putaway.cart.some((item) => [item.case_qty, item.pack_qty, item.piece_qty].some((qty) => !Number.isInteger(Number(qty))))) {
    return toast('Put-away cannot continue: CASE, PACK, and PIECE quantities must be whole numbers.', 'error');
  }
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


function switchPutawayMode() {
  const mode = $('pa-mode-select').value;
  const changingWithData = state.putaway.cart.length || state.shipperPutaway.contents.length;
  if (changingWithData) {
    const ok = window.confirm('Changing Put-away type will clear the current unsaved Put-away session. Continue?');
    if (!ok) {
      $('pa-mode-select').value = $('shipper-putaway-form').classList.contains('hidden') ? 'STANDARD' : 'SHIPPER';
      return;
    }
    resetPutawaySession();
    resetShipperPutaway();
  }
  $('putaway-form').classList.toggle('hidden', mode !== 'STANDARD');
  $('shipper-putaway-form').classList.toggle('hidden', mode !== 'SHIPPER');
  if (mode === 'SHIPPER') $('sp-case').focus();
  else $('pa-case').focus();
}

function setShipperDetailsReadonly(readonly) {
  ['sp-brand','sp-description','sp-variant','sp-size'].forEach((id) => { $(id).readOnly = readonly; });
}

function setShipperContentDetailsReadonly(readonly) {
  ['sp-content-brand','sp-content-description','sp-content-variant','sp-content-size'].forEach((id) => { $(id).readOnly = readonly; });
}

function hideShipperDuplicateWarning() {
  state.shipperPutaway.duplicateShipperSkuId = null;
  $('sp-duplicate-warning').classList.add('hidden');
  $('sp-duplicate-details').textContent = '';
  $('sp-still-add').checked = false;
}

function hideShipperContentDuplicateWarning() {
  state.shipperPutaway.duplicateContentSkuId = null;
  $('sp-content-duplicate-warning').classList.add('hidden');
  $('sp-content-duplicate-details').textContent = '';
  $('sp-content-still-add').checked = false;
}

async function resolveShipperSku() {
  const sequence = ++state.shipperPutaway.shipperLookupSequence;
  const barcode = normalizeBarcode($('sp-case').value);
  $('sp-case').value = barcode;
  if (!barcode || barcode === 'N/A') {
    state.shipperPutaway.matchedShipperSku = null;
    setShipperDetailsReadonly(false);
    $('sp-match-note').classList.add('hidden');
    if (barcode === 'N/A') toast('A Shipper Box requires an actual CASE barcode; N/A is not valid for the Shipper CASE.', 'error');
    return null;
  }

  const [typedResult, allResult, archivedResult] = await Promise.all([
    supabase.rpc('find_sku_by_barcode_type', { p_barcode: barcode, p_barcode_type: 'CASE' }),
    supabase.rpc('find_sku_barcode_matches', { p_barcode: barcode }),
    supabase.rpc('find_archived_sku_by_barcode_type', { p_barcode: barcode, p_barcode_type: 'CASE' })
  ]);
  if (sequence !== state.shipperPutaway.shipperLookupSequence) return null;
  if (typedResult.error || allResult.error || archivedResult.error) return toast(friendlyError(typedResult.error || allResult.error || archivedResult.error), 'error');
  const sku = typedResult.data?.[0];
  if (!sku && archivedResult.data?.[0]) {
    const archivedSku = archivedResult.data[0];
    state.shipperPutaway.matchedShipperSku = null;
    setShipperDetailsReadonly(false);

    if (String(archivedSku.sku_type || '').toUpperCase() !== 'SHIPPER') {
      $('sp-match-note').innerHTML =
        `<strong>Previously deleted STANDARD SKU found.</strong> CASE ${escapeHtml(barcode)} belongs to archived STANDARD SKU ${escapeHtml(archivedSkuLabel(archivedSku))}, not a Shipper master.`;
      $('sp-match-note').classList.remove('hidden');
      return toast('This archived CASE barcode belongs to a STANDARD SKU.', 'error');
    }

    $('sp-match-note').innerHTML =
      `<strong>Previously deleted Shipper SKU found.</strong> ${escapeHtml(archivedSkuLabel(archivedSku))}<br>` +
      `${escapeHtml(archivedSkuBarcodeText(archivedSku))}<br>` +
      `${isAdminOrOwner() ? 'Confirm reactivation to restore the original Shipper master record.' : 'Ask an Admin or Owner to reactivate it.'}`;
    $('sp-match-note').classList.remove('hidden');

    const reactivated = await offerArchivedSkuReactivation(archivedSku, 'Shipper Box Put-away');
    if (reactivated) return resolveShipperSku();
    return null;
  }
  if (!sku) {
    state.shipperPutaway.matchedShipperSku = null;
    setShipperDetailsReadonly(false);
    const cross = (allResult.data || []).find((row) => String(row.matched_type || '').toUpperCase() !== 'CASE');
    if (cross) {
      const otherType = String(cross.matched_type || '').toUpperCase();
      $('sp-match-note').innerHTML = `<strong>Barcode type mismatch. ${escapeHtml(barcode)} was entered in the CASE field, but it is already registered as a ${escapeHtml(otherType)} barcode. Double-check before proceeding.</strong><br>This CASE value may still be registered for the new Shipper because barcode uniqueness is enforced separately per category.`;
    } else {
      $('sp-match-note').innerHTML = '<strong>New Shipper CASE barcode.</strong> Enter the Shipper brand, description, variant, and size. Its contents will be entered separately below.';
    }
    $('sp-match-note').classList.remove('hidden');
    await checkShipperDuplicateDetails();
    return null;
  }

  if (String(sku.sku_type || 'STANDARD').toUpperCase() !== 'SHIPPER') {
    state.shipperPutaway.matchedShipperSku = null;
    setShipperDetailsReadonly(false);
    $('sp-match-note').innerHTML = '<strong>STANDARD SKU detected.</strong> This CASE barcode belongs to a normal SKU, not a Shipper master record.';
    $('sp-match-note').classList.remove('hidden');
    return toast('This CASE barcode is registered as a STANDARD SKU.', 'error');
  }

  state.shipperPutaway.matchedShipperSku = { ...sku, sku_type: 'SHIPPER' };
  $('sp-brand').value = sku.brand;
  $('sp-description').value = sku.description;
  $('sp-variant').value = sku.variant;
  $('sp-size').value = sku.size;
  setShipperDetailsReadonly(true);
  hideShipperDuplicateWarning();
  $('sp-match-note').innerHTML = `<strong>Existing Shipper SKU found.</strong> ${escapeHtml([sku.brand,sku.description,sku.variant,sku.size].join(' '))}. Enter the contents of this incoming physical box fresh; previous box compositions are not reused.`;
  $('sp-match-note').classList.remove('hidden');
  return sku;
}

async function checkShipperDuplicateDetails() {
  if (state.shipperPutaway.matchedShipperSku) { hideShipperDuplicateWarning(); return null; }
  const details = {
    p_brand: $('sp-brand').value.trim(),
    p_description: $('sp-description').value.trim(),
    p_variant: $('sp-variant').value.trim(),
    p_size: $('sp-size').value.trim()
  };
  if (Object.values(details).some((v) => !v)) { hideShipperDuplicateWarning(); return null; }
  const { data, error } = await supabase.rpc('find_sku_by_details_type', { ...details, p_sku_type: 'SHIPPER' });
  if (error) { toast(friendlyError(error), 'error'); return null; }
  const match = data?.[0];
  if (!match) {
    try {
      const archivedMatches = await findArchivedSkuByDetails(details, 'SHIPPER');
      const archived = archivedMatches[0];
      if (archived) {
        state.shipperPutaway.duplicateShipperSkuId = archived.id;
        $('sp-duplicate-details').textContent =
          `A previously deleted Shipper SKU has the same details. Archived CASE: ${archived.case_barcode}. ` +
          `If this is the same Shipper product, use that original CASE barcode so Admin/Owner can reactivate it.`;
        $('sp-duplicate-warning').classList.remove('hidden');
        return { ...archived, archived: true };
      }
    } catch (archivedError) {
      toast(friendlyError(archivedError), 'error');
    }
    hideShipperDuplicateWarning();
    return null;
  }
  state.shipperPutaway.duplicateShipperSkuId = match.id;
  $('sp-duplicate-details').textContent = `Existing barcodes — CASE: ${match.case_barcode}; PACK: ${match.pack_barcode}; PIECE: ${match.piece_barcode}. Added by: ${match.created_by_username || 'unknown user'}.`;
  $('sp-duplicate-warning').classList.remove('hidden');
  return match;
}

async function resolveShipperContentSku() {
  const sequence = ++state.shipperPutaway.contentLookupSequence;
  const barcode = normalizeBarcode($('sp-content-pack').value);
  $('sp-content-pack').value = barcode;
  if (!barcode || barcode === 'N/A') {
    state.shipperPutaway.contentSku = null;
    setShipperContentDetailsReadonly(false);
    $('sp-content-match-note').classList.add('hidden');
    if (barcode === 'N/A') toast('Shipper contents in this enhancement require an actual PACK barcode.', 'error');
    return null;
  }

  const [typedResult, allResult, archivedResult] = await Promise.all([
    supabase.rpc('find_sku_by_barcode_type', { p_barcode: barcode, p_barcode_type: 'PACK' }),
    supabase.rpc('find_sku_barcode_matches', { p_barcode: barcode }),
    supabase.rpc('find_archived_sku_by_barcode_type', { p_barcode: barcode, p_barcode_type: 'PACK' })
  ]);
  if (sequence !== state.shipperPutaway.contentLookupSequence) return null;
  if (typedResult.error || allResult.error || archivedResult.error) return toast(friendlyError(typedResult.error || allResult.error || archivedResult.error), 'error');
  const sku = typedResult.data?.[0];
  if (!sku && archivedResult.data?.[0]) {
    const archivedSku = archivedResult.data[0];
    state.shipperPutaway.contentSku = null;
    setShipperContentDetailsReadonly(false);

    if (String(archivedSku.sku_type || '').toUpperCase() !== 'STANDARD') {
      $('sp-content-match-note').innerHTML = '<strong>Archived Shipper master detected.</strong> A Shipper master cannot be used as a child PACK SKU.';
      $('sp-content-match-note').classList.remove('hidden');
      return toast('This archived PACK barcode is not a STANDARD child SKU.', 'error');
    }

    $('sp-content-match-note').innerHTML =
      `<strong>Previously deleted child SKU found.</strong> ${escapeHtml(archivedSkuLabel(archivedSku))}<br>` +
      `${escapeHtml(archivedSkuBarcodeText(archivedSku))}<br>` +
      `${isAdminOrOwner() ? 'Confirm reactivation to restore the original child SKU record.' : 'Ask an Admin or Owner to reactivate it.'}`;
    $('sp-content-match-note').classList.remove('hidden');

    const reactivated = await offerArchivedSkuReactivation(archivedSku, 'Shipper content Put-away');
    if (reactivated) return resolveShipperContentSku();
    return null;
  }
  if (!sku) {
    state.shipperPutaway.contentSku = null;
    setShipperContentDetailsReadonly(false);
    const cross = (allResult.data || []).find((row) => String(row.matched_type || '').toUpperCase() !== 'PACK');
    if (cross) {
      const otherType = String(cross.matched_type || '').toUpperCase();
      $('sp-content-match-note').innerHTML = `<strong>Barcode type mismatch. ${escapeHtml(barcode)} was entered in the PACK field, but it is already registered as a ${escapeHtml(otherType)} barcode. Double-check before proceeding.</strong><br>This PACK value may still be registered because barcode uniqueness is enforced separately per category.`;
    } else {
      $('sp-content-match-note').innerHTML = '<strong>New PACK barcode.</strong> Enter brand, description, variant, and size. The new SKU will be stored in the permanent SKU Masterlist with CASE/PIECE = N/A.';
    }
    $('sp-content-match-note').classList.remove('hidden');
    await checkShipperContentDuplicateDetails();
    return null;
  }

  if (String(sku.sku_type || 'STANDARD').toUpperCase() !== 'STANDARD') {
    return toast('A Shipper Box cannot contain another SHIPPER SKU as a child item.', 'error');
  }

  state.shipperPutaway.contentSku = { ...sku, sku_type: 'STANDARD' };
  $('sp-content-brand').value = sku.brand;
  $('sp-content-description').value = sku.description;
  $('sp-content-variant').value = sku.variant;
  $('sp-content-size').value = sku.size;
  setShipperContentDetailsReadonly(true);
  hideShipperContentDuplicateWarning();
  $('sp-content-match-note').innerHTML = `<strong>Existing PACK SKU found.</strong> ${escapeHtml([sku.brand,sku.description,sku.variant,sku.size].join(' '))}. Enter this physical box's expiry date and PACK quantity.`;
  $('sp-content-match-note').classList.remove('hidden');
  return sku;
}

async function checkShipperContentDuplicateDetails() {
  if (state.shipperPutaway.contentSku) { hideShipperContentDuplicateWarning(); return null; }
  const details = {
    p_brand: $('sp-content-brand').value.trim(),
    p_description: $('sp-content-description').value.trim(),
    p_variant: $('sp-content-variant').value.trim(),
    p_size: $('sp-content-size').value.trim()
  };
  if (Object.values(details).some((v) => !v)) { hideShipperContentDuplicateWarning(); return null; }
  const { data, error } = await supabase.rpc('find_sku_by_details_type', { ...details, p_sku_type: 'STANDARD' });
  if (error) { toast(friendlyError(error), 'error'); return null; }
  const match = data?.[0];
  if (!match) {
    try {
      const archivedMatches = await findArchivedSkuByDetails(details, 'STANDARD');
      const archived = archivedMatches[0];
      if (archived) {
        state.shipperPutaway.duplicateContentSkuId = archived.id;
        $('sp-content-duplicate-details').textContent =
          `A previously deleted STANDARD SKU has the same details. Archived PACK: ${archived.pack_barcode}. ` +
          `If this is the same physical item, use its original PACK barcode so Admin/Owner can reactivate the original record.`;
        $('sp-content-duplicate-warning').classList.remove('hidden');
        return { ...archived, archived: true };
      }
    } catch (archivedError) {
      toast(friendlyError(archivedError), 'error');
    }
    hideShipperContentDuplicateWarning();
    return null;
  }
  state.shipperPutaway.duplicateContentSkuId = match.id;
  $('sp-content-duplicate-details').textContent = `Existing barcodes — CASE: ${match.case_barcode}; PACK: ${match.pack_barcode}; PIECE: ${match.piece_barcode}. Added by: ${match.created_by_username || 'unknown user'}.`;
  $('sp-content-duplicate-warning').classList.remove('hidden');
  return match;
}

async function addShipperContentLine() {
  const button = $('sp-add-content-btn');
  const duplicateConfirmedBeforeLookup = $('sp-content-still-add').checked;
  setBusy(button, true, 'Checking…');
  try {
    await resolveShipperContentSku();
    const pack = normalizeBarcode($('sp-content-pack').value);
    const expiry = $('sp-content-no-expiry').checked ? NO_EXPIRY_DATE : $('sp-content-expiry').value;
    const rawQty = String($('sp-content-qty').value || '').trim();
    const qty = Number(rawQty);
    const brand = $('sp-content-brand').value.trim();
    const description = $('sp-content-description').value.trim();
    const variant = $('sp-content-variant').value.trim();
    const size = $('sp-content-size').value.trim();
    if (!pack || pack === 'N/A') return toast('Enter the actual PACK barcode for this Shipper content line.', 'error');
    if (!expiry) return toast('Enter the expiry date, or select No expiry (N/A), for this Shipper content line.', 'error');
    if (!/^\d+$/.test(rawQty) || !Number.isSafeInteger(qty) || qty <= 0) return toast('PACK quantity must be a whole number greater than zero.', 'error');
    if (!brand || !description || !variant || !size) return toast('Brand, description, variant, and size are required for the content SKU.', 'error');

    const duplicate = await checkShipperContentDuplicateDetails();
    const normalizedDetails = [brand, description, variant, size].map((v) => v.trim().toLowerCase()).join('|');
    const localDuplicate = state.shipperPutaway.contents.find((x) =>
      [x.brand, x.description, x.variant, x.size].map((v) => String(v || '').trim().toLowerCase()).join('|') === normalizedDetails
      && x.pack_barcode.toLowerCase() !== pack.toLowerCase()
    );
    const allowDuplicateDetails = duplicateConfirmedBeforeLookup || $('sp-content-still-add').checked;
    if (localDuplicate && !allowDuplicateDetails) {
      state.shipperPutaway.duplicateContentSkuId = 'CURRENT_SHIPPER';
      $('sp-content-duplicate-details').textContent = `The same Brand / Description / Variant / Size is already queued in this physical Shipper Box under PACK barcode ${localDuplicate.pack_barcode}.`;
      $('sp-content-duplicate-warning').classList.remove('hidden');
      return toast('ITEM WITH THE SAME DETAILS EXISTED in this Shipper Box. Please check BARCODE, or select Still Add to Database.', 'error');
    }
    if (duplicate && !allowDuplicateDetails) return toast('ITEM WITH THE SAME DETAILS EXISTED. Please check BARCODE, or select Still Add to Database.', 'error');

    const line = {
      pack_barcode: pack, brand, description, variant, size,
      expiry_date: expiry, pack_qty: qty,
      allow_duplicate_details: allowDuplicateDetails
    };
    const existing = state.shipperPutaway.contents.find((x) => x.pack_barcode.toLowerCase() === pack.toLowerCase() && x.expiry_date === expiry);
    if (existing) existing.pack_qty += qty;
    else state.shipperPutaway.contents.push(line);
    renderShipperContents();
    clearShipperContentLine();
    $('sp-complete-btn').disabled = state.mode !== 'ACTIVE' || !state.shipperPutaway.contents.length;
    toast(existing ? 'Same SKU + expiry consolidated in this Shipper Box.' : 'PACK content added to this physical Shipper Box.', 'success');
  } finally {
    setBusy(button, false);
  }
}

function clearShipperContentLine() {
  ['sp-content-pack','sp-content-brand','sp-content-description','sp-content-variant','sp-content-size','sp-content-expiry','sp-content-qty'].forEach((id) => { $(id).value = ''; });
  $('sp-content-no-expiry').checked = false;
  syncNoExpiryControl('sp-content-expiry', 'sp-content-no-expiry');
  state.shipperPutaway.contentSku = null;
  state.shipperPutaway.contentLookupSequence += 1;
  setShipperContentDetailsReadonly(false);
  $('sp-content-match-note').classList.add('hidden');
  hideShipperContentDuplicateWarning();
  $('sp-content-pack').focus();
}

function renderShipperContents() {
  const rows = state.shipperPutaway.contents;
  $('sp-content-cart').innerHTML = rows.length ? `<table><thead><tr><th>Content SKU</th><th>PACK barcode</th><th>Expiry</th><th>PACK qty</th><th></th></tr></thead><tbody>${rows.map((r,i) => `<tr>
    <td class="wrap"><strong>${escapeHtml([r.brand,r.description,r.variant,r.size].join(' '))}</strong></td>
    <td>${escapeHtml(r.pack_barcode)}</td><td>${fmtDate(r.expiry_date)}</td><td>${fmtQtyUom(r.pack_qty,'PACK')}</td>
    <td><button class="link-btn" type="button" data-remove-shipper-content="${i}">Remove</button></td></tr>`).join('')}</tbody></table>` : emptyState('No Shipper contents added yet.');
}

function removeShipperContentLine(index) {
  state.shipperPutaway.contents.splice(index,1);
  renderShipperContents();
  $('sp-complete-btn').disabled = state.mode !== 'ACTIVE' || !state.shipperPutaway.contents.length;
}

function resetShipperPutaway(preserveResult = false) {
  state.shipperPutaway = freshShipperPutawayState();
  $('shipper-putaway-form').reset();
  syncNoExpiryControl('sp-content-expiry', 'sp-content-no-expiry');
  if (!preserveResult) { $('sp-result').classList.add('hidden'); $('sp-result').innerHTML = ''; }
  setShipperDetailsReadonly(false);
  setShipperContentDetailsReadonly(false);
  $('sp-match-note').classList.add('hidden');
  $('sp-content-match-note').classList.add('hidden');
  hideShipperDuplicateWarning();
  hideShipperContentDuplicateWarning();
  $('sp-complete-btn').disabled = true;
  renderShipperContents();
}

async function completeShipperPutaway() {
  const location = normalizeLocation($('sp-location').value);
  const shipperCase = normalizeBarcode($('sp-case').value);
  const container = $('sp-container').value.trim();
  if (!location) return toast('Scan or enter the rack location.', 'error');
  if (!shipperCase || shipperCase === 'N/A') return toast('A Shipper Box requires an actual CASE barcode.', 'error');
  if (!container) return toast('Container number is required.', 'error');
  if (!state.shipperPutaway.contents.length) return toast('Add at least one PACK content line inside this Shipper Box.', 'error');

  await resolveShipperSku();
  const brand = $('sp-brand').value.trim();
  const description = $('sp-description').value.trim();
  const variant = $('sp-variant').value.trim();
  const size = $('sp-size').value.trim();
  if (!brand || !description || !variant || !size) return toast('Shipper brand, description, variant, and size are required.', 'error');
  const duplicate = await checkShipperDuplicateDetails();
  if (duplicate && !$('sp-still-add').checked && !state.shipperPutaway.matchedShipperSku) {
    return toast('ITEM WITH THE SAME DETAILS EXISTED. Please check BARCODE, or select Still Add Shipper to Database.', 'error');
  }

  const button = $('sp-complete-btn');
  setBusy(button, true, 'Completing…');
  const { data, error } = await supabase.rpc('complete_shipper_putaway', {
    p_location_code: location,
    p_shipper_case_barcode: shipperCase,
    p_shipper_brand: brand,
    p_shipper_description: description,
    p_shipper_variant: variant,
    p_shipper_size: size,
    p_container_no: container,
    p_contents: state.shipperPutaway.contents,
    p_allow_duplicate_shipper_details: $('sp-still-add').checked,
    p_note: $('sp-note').value.trim() || null
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');
  const row = data?.[0];
  const boxNo = row?.shipper_box_no || 'physical box';
  toast(`Shipper put-away saved: ${boxNo} · ${row?.transaction_no || 'transaction completed'}`, 'success');
  invalidateReports();
  resetShipperPutaway(true);
  $('sp-result').innerHTML = `<strong>Physical Shipper ID created: ${escapeHtml(boxNo)}</strong><br>Write or attach this SB number to the physical box so users can distinguish it from another box with the same manufacturer CASE barcode.`;
  $('sp-result').classList.remove('hidden');
}

async function lockPickLocation() {
  const so = $('pick-so').value.trim();
  const location = normalizeLocation($('pick-location').value);
  if (!so || !location) return toast('Enter the sales order and scan the source location first.', 'error');

  if (isStockAdjustmentSalesOrder(so)) {
    const locked = await acquireStockAdjustmentPickLock(location);
    if (locked) await refreshPickSalesOrderStatus();
    return;
  }

  // Verify the sales order immediately before locking. This prevents a stale status
  // or an Admin override left checked from a previously entered sales order.
  const statusOk = await refreshPickSalesOrderStatus();
  if (!statusOk || !['NEW', 'OPEN', 'COMPLETED'].includes(state.pickOrder.status)) {
    return toast('The sales order status could not be verified. Please try again.', 'error');
  }

  const isCompletedOrder = state.pickOrder.status === 'COMPLETED';
  const overrideCompleted = isAdminOrOwner() && isCompletedOrder && $('pick-so-override').checked;
  const overrideReason = overrideCompleted ? $('pick-so-override-reason').value.trim() : '';
  if (overrideCompleted && !overrideReason) {
    return toast('Enter the Admin override reason before reopening a completed sales order.', 'error');
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

async function acquireStockAdjustmentPickLock(location) {
  const opState = state.pick;
  const button = $('pick-lock-btn');
  setBusy(button, true, 'Locking…');

  const { data, error } = await supabase.rpc('acquire_stock_adjustment_pick_lock', {
    p_location_code: location
  });

  setBusy(button, false);
  if (error) {
    toast(friendlyError(error), 'error');
    return false;
  }

  const row = data?.[0];
  if (!row?.lock_token || !row?.adjustment_session_key) {
    toast('Stock Adjustment rack lock could not be created.', 'error');
    return false;
  }

  opState.lockToken = row.lock_token;
  opState.adjustmentSessionKey = row.adjustment_session_key;
  opState.locationCode = row.location_code;

  state.data.rackMap = [];
  state.data.audit = [];

  startHeartbeat(opState);
  configureOperationUi('pick', true);
  await loadPickRackContents();

  toast(`${opState.locationCode} locked for Warehouse Stock Adjustment (SO 0).`, 'success');
  return true;
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
    if (message.includes('SALES_ORDER_ALREADY_COMPLETED') && isAdminOrOwner()) {
      $('pick-so-override').checked = true;
      $('pick-so-override-reason').disabled = false;
      $('pick-so-override-reason').focus();
      toast('This sales order is completed. Enter an Admin override reason, then lock the rack again.', 'error');
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
  if (operation === 'transfer') await loadTransferRackContents();
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
  qsa(`[data-na-target="${prefix}-barcode"]`).forEach((b) => b.disabled = !locked);
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

  container.innerHTML = `<table><thead><tr><th>Item</th><th>Shipper box</th><th>Container</th><th>Expiry</th><th>Stock unit</th><th>Available</th><th>Queued</th><th></th></tr></thead><tbody>${rows.map((lot) => {
    const queued = state.pick.cart.filter((x) => x.lot_id === lot.lot_id).reduce((sum, x) => sum + Number(x.qty), 0);
    const remaining = Math.max(Number(lot.qty) - queued, 0);
    const bypassAction = isSupervisor()
      ? `<button class="link-btn" type="button" data-pick-bypass-lot="${lot.lot_id}">Bypass unreadable barcode</button>`
      : '<small>Correct barcode required</small>';
    return `<tr>
      <td class="wrap"><strong>${escapeHtml(lot.sku_name)}</strong></td>
      <td>${shipperBadge(lot)}</td>
      <td>${escapeHtml(lot.container_no)}</td>
      <td>${fmtDate(lot.expiry_date)} ${expiryPill(lot.expiry_status)}</td>
      <td><span class="pill">${escapeHtml(lot.uom)}</span></td>
      <td>${fmtQtyUom(remaining, lot.uom)}${queued ? `<br><small>Original: ${fmtQtyUom(lot.qty, lot.uom)}</small>` : ''}</td>
      <td>${queued ? fmtQtyUom(queued, lot.uom) : '—'}</td>
      <td>${bypassAction}</td>
    </tr>`;
  }).join('')}</tbody></table>`;
}


async function loadTransferRackContents() {
  const location = state.transfer.locationCode;
  const container = $('tr-rack-contents');
  if (!container) return;
  if (!location) {
    state.transfer.rackLots = [];
    $('tr-rack-title').textContent = 'Source rack contents';
    container.innerHTML = emptyState('Lock a source rack to display its available items.');
    return;
  }

  $('tr-rack-title').textContent = `Items currently stored in ${location}`;
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
    state.transfer.rackLots = [];
    container.innerHTML = `<div class="warning-box">${escapeHtml(friendlyError(error))}</div>`;
    return;
  }
  state.transfer.rackLots = data || [];
  renderTransferRackContents();
}

function renderTransferRackContents() {
  const container = $('tr-rack-contents');
  if (!container) return;
  const rows = state.transfer.rackLots || [];
  if (!rows.length) {
    container.innerHTML = emptyState(state.transfer.locationCode
      ? `No available stock is recorded in ${state.transfer.locationCode}.`
      : 'Lock a source rack to display its available items.');
    return;
  }

  container.innerHTML = `<table><thead><tr><th>Item</th><th>Shipper box</th><th>Container</th><th>Expiry</th><th>Stock unit</th><th>Available</th><th>Queued</th></tr></thead><tbody>${rows.map((lot) => {
    const queued = state.transfer.cart.filter((x) => x.lot_id === lot.lot_id).reduce((sum, x) => sum + Number(x.qty), 0);
    const remaining = Math.max(Number(lot.qty) - queued, 0);
    return `<tr>
      <td class="wrap"><strong>${escapeHtml(lot.sku_name)}</strong></td>
      <td>${shipperBadge(lot)}</td>
      <td>${escapeHtml(lot.container_no)}</td>
      <td>${fmtDate(lot.expiry_date)} ${expiryPill(lot.expiry_status)}</td>
      <td><span class="pill">${escapeHtml(lot.uom)}</span></td>
      <td>${fmtQtyUom(remaining, lot.uom)}${queued ? `<br><small>Original: ${fmtQtyUom(lot.qty, lot.uom)}</small>` : ''}</td>
      <td>${queued ? fmtQtyUom(queued, lot.uom) : '—'}</td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function lotUsesNaBarcode(lot) {
  const field = { CASE: 'case_barcode', PACK: 'pack_barcode', PIECE: 'piece_barcode' }[String(lot?.uom || '').toUpperCase()];
  return Boolean(field) && normalizeBarcode(lot?.[field]) === 'N/A';
}

function renderNaBarcodePrompt(operation) {
  const pick = operation === 'pick';
  const panel = $(pick ? 'pick-barcode-match' : 'tr-barcode-match');
  if (!panel) return;
  panel.classList.remove('hidden');
  panel.innerHTML = `<strong>N/A barcode selection mode</strong><br>
    Select the exact SKU, container, expiry, and CASE / PACK / PIECE unit from the eligible stock in the locked source rack.`;
}

function renderNaSelectedLot(operation) {
  const pick = operation === 'pick';
  const opState = state[operation];
  if (!opState.naMode) return;
  const select = $(pick ? 'pick-lot' : 'tr-lot');
  const lot = select.value === '' ? null : opState.lots[Number(select.value)];
  const unitLabel = $(pick ? 'pick-unit-label' : 'tr-unit-label');
  if (!lot) {
    unitLabel.textContent = 'selected unit';
    renderNaBarcodePrompt(operation);
    return;
  }
  unitLabel.textContent = lot.uom;
  const panel = $(pick ? 'pick-barcode-match' : 'tr-barcode-match');
  panel.classList.remove('hidden');
  const queued = opState.cart.filter((x) => x.lot_id === lot.lot_id).reduce((sum, x) => sum + Number(x.qty || 0), 0);
  const remaining = Math.max(Number(lot.qty || 0) - queued, 0);
  panel.innerHTML = `<strong>N/A confirmed for ${escapeHtml(lot.uom)} — selected item</strong>
    <div class="table-wrap"><table><tbody>
      <tr><th>Brand</th><td>${escapeHtml(lot.brand)}</td><th>Description</th><td>${escapeHtml(lot.description)}</td></tr>
      <tr><th>Variant</th><td>${escapeHtml(lot.variant)}</td><th>Size</th><td>${escapeHtml(lot.size)}</td></tr>
      <tr><th>Container</th><td>${escapeHtml(lot.container_no)}</td><th>Expiry</th><td>${fmtDate(lot.expiry_date)}</td></tr>
      <tr><th>Shipper box</th><td colspan="3">${escapeHtml(shipperDescriptor(lot))}</td></tr>
      <tr><th>Source rack</th><td>${escapeHtml(opState.locationCode || '—')}</td><th>Available ${escapeHtml(lot.uom)}</th><td>${fmtQtyUom(remaining, lot.uom)}</td></tr>
    </tbody></table></div>`;
}

function handleOperationLotChange(operation) {
  if (state[operation].naMode) renderNaSelectedLot(operation);
  else if (state[operation].multiBarcodeMode) renderSelectedBarcodeCategoryLot(operation);
  if (operation === 'pick') {
    updatePickFefoNote();
    updatePickQtyNote();
  } else {
    updateTransferQtyNote();
  }
}

function renderSelectedBarcodeCategoryLot(operation) {
  const pick = operation === 'pick';
  const opState = state[operation];
  const select = $(pick ? 'pick-lot' : 'tr-lot');
  if (!select || select.value === '') return;
  const lot = opState.lots[Number(select.value)];
  if (!lot) return;
  const sameSkuUnitLots = opState.lots.filter((row) => row.sku_id === lot.sku_id && row.uom === lot.uom);
  const sku = {
    brand: lot.brand || '', description: lot.description || '', variant: lot.variant || '', size: lot.size || ''
  };
  if (pick) renderPickBarcodeMatch(sku, lot.uom, sameSkuUnitLots);
  else renderTransferBarcodeMatch(sku, lot.uom, sameSkuUnitLots);
}


function clearPickBarcodeMatch(message = 'Scan or type a registered CASE, PACK, or PIECE barcode, or enter N/A to select from eligible rack stock.') {
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
  const available = (lots || []).reduce((sum, lot) => sum + Number(lot.effectiveQty ?? lot.qty ?? 0), 0);
  const shipperLots = (lots || []).filter((lot) => lot.shipper_box_id);
  const shipperContext = shipperLots.length
    ? `<tr><th>Shipper context</th><td colspan="3">${escapeHtml(shipperLots.map((lot) => `${lot.shipper_box_no || 'Shipper'} ${lot.shipper_lot_role === 'HEADER' ? '(complete SEALED box)' : '(content)'}`).join(' · '))}</td></tr>`
    : '';
  panel.classList.remove('hidden');
  panel.innerHTML = `<strong>Barcode confirmed as ${escapeHtml(expectedUom)}</strong>
    <div class="table-wrap"><table><tbody>
      <tr><th>Brand</th><td>${escapeHtml(sku.brand)}</td><th>Description</th><td>${escapeHtml(sku.description)}</td></tr>
      <tr><th>Variant</th><td>${escapeHtml(sku.variant)}</td><th>Size</th><td>${escapeHtml(sku.size)}</td></tr>
      <tr><th>Source rack</th><td>${escapeHtml(state.pick.locationCode || '—')}</td><th>Available ${escapeHtml(expectedUom)}</th><td>${fmtQtyUom(available, expectedUom)}</td></tr>
      ${shipperContext}
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


function clearTransferBarcodeMatch(message = 'Scan or type a registered CASE, PACK, or PIECE barcode, or enter N/A to select from eligible rack stock.') {
  const panel = $('tr-barcode-match');
  if (!panel) return;
  panel.classList.remove('hidden');
  panel.innerHTML = `<strong>Barcode confirmation:</strong> ${escapeHtml(message)}`;
  const qtyNote = $('tr-qty-note');
  if (qtyNote) { qtyNote.textContent = ''; qtyNote.classList.add('hidden'); }
}

function renderTransferBarcodeMatch(sku, expectedUom, lots) {
  const panel = $('tr-barcode-match');
  if (!panel || !sku) return;
  const available = (lots || []).reduce((sum, lot) => sum + Number(lot.qty || 0), 0);
  const shipperLots = (lots || []).filter((lot) => lot.shipper_box_id);
  const shipperContext = shipperLots.length
    ? `<tr><th>Shipper context</th><td colspan="3">${escapeHtml(shipperLots.map((lot) => `${lot.shipper_box_no || 'Shipper'} ${lot.shipper_lot_role === 'HEADER' ? '(complete SEALED box)' : '(content)'}`).join(' · '))}</td></tr>`
    : '';
  panel.classList.remove('hidden');
  panel.innerHTML = `<strong>Barcode confirmed as ${escapeHtml(expectedUom)}</strong>
    <div class="table-wrap"><table><tbody>
      <tr><th>Brand</th><td>${escapeHtml(sku.brand)}</td><th>Description</th><td>${escapeHtml(sku.description)}</td></tr>
      <tr><th>Variant</th><td>${escapeHtml(sku.variant)}</td><th>Size</th><td>${escapeHtml(sku.size)}</td></tr>
      <tr><th>Source rack</th><td>${escapeHtml(state.transfer.locationCode || '—')}</td><th>Available ${escapeHtml(expectedUom)}</th><td>${fmtQtyUom(available, expectedUom)}</td></tr>
      ${shipperContext}
    </tbody></table></div>`;
}

function updateTransferQtyNote() {
  const note = $('tr-qty-note');
  if (!note) return;
  note.classList.remove('hidden');
  const lotValue = $('tr-lot').value;
  if (lotValue === '') {
    note.textContent = 'Select an expiry / container before entering the transfer quantity.';
    return;
  }
  const lot = state.transfer.lots[Number(lotValue)];
  if (!lot) {
    note.textContent = 'Select a valid stock lot.';
    return;
  }
  const raw = String($('tr-qty').value || '').trim();
  const already = state.transfer.cart.filter((x) => x.lot_id === lot.lot_id).reduce((sum, x) => sum + Number(x.qty), 0);
  const remaining = Math.max(Number(lot.qty) - already, 0);
  if (!raw) {
    note.textContent = `Enter the ${lot.uom} quantity to transfer. Remaining available for this lot: ${fmtQtyUom(remaining, lot.uom)}.`;
    return;
  }
  const qty = Number(raw);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
    note.textContent = `Whole numbers only for ${lot.uom}. Example: 1, 2, 3.`;
    return;
  }
  note.textContent = qty <= remaining
    ? `${fmtQtyUom(qty, lot.uom)} accepted for entry · ${fmtQtyUom(remaining, lot.uom)} currently available before this line.`
    : `${fmtQtyUom(qty, lot.uom)} exceeds the remaining ${fmtQtyUom(remaining, lot.uom)}.`;
}

async function loadOperationLots(operation) {
  const pick = operation === 'pick';
  const transfer = operation === 'transfer';
  const barcodeInput = $(pick ? 'pick-barcode' : 'tr-barcode');
  const barcode = barcodeInput.value.trim();
  const opState = state[operation];
  const lotSelect = $(pick ? 'pick-lot' : 'tr-lot');
  if (!barcode || !opState.locationCode) {
    if (pick) clearPickBarcodeMatch();
    if (transfer) clearTransferBarcodeMatch();
    return;
  }

  if (barcode.toUpperCase() === 'N/A') {
    opState.naMode = true;
    opState.sku = null;
    const { data: rackRows, error: rackError } = await supabase
      .from('v_inventory_details')
      .select('*')
      .eq('location_code', opState.locationCode)
      .order('sku_name')
      .order('uom')
      .order('expiry_date')
      .order('container_no');
    if (rackError) return toast(friendlyError(rackError), 'error');

    const candidates = (rackRows || []).filter(lotUsesNaBarcode);
    const skuIds = [...new Set(candidates.map((row) => row.sku_id).filter(Boolean))];
    let fefoRows = [];
    if (pick && skuIds.length) {
      const { data, error } = await supabase
        .from('v_inventory_details')
        .select('lot_id,sku_id,expiry_date,location_code,container_no,qty,uom')
        .in('sku_id', skuIds)
        .gt('qty', 0)
        .neq('expiry_status', 'EXPIRED')
        .order('expiry_date');
      if (error) return toast(friendlyError(error), 'error');
      fefoRows = data || [];
    }

    const queuedByLot = new Map();
    opState.cart.forEach((line) => {
      queuedByLot.set(line.lot_id, (queuedByLot.get(line.lot_id) || 0) + Number(line.qty || 0));
    });

    opState.lots = candidates.map((lot) => {
      const effectiveQty = Math.max(Number(lot.qty || 0) - (queuedByLot.get(lot.lot_id) || 0), 0);
      const earliest = pick
        ? fefoRows.find((row) => row.sku_id === lot.sku_id && row.uom === lot.uom && Number(row.qty || 0) - (queuedByLot.get(row.lot_id) || 0) > 0)
        : null;
      return {
        ...lot,
        effectiveQty,
        earliestExpiry: earliest?.expiry_date || lot.expiry_date,
        earliestLocation: earliest?.location_code || opState.locationCode,
        earliestContainer: earliest?.container_no || lot.container_no,
        scannedBarcode: 'N/A',
        scannedBarcodeType: lot.uom
      };
    });

    lotSelect.innerHTML = opState.lots.length
      ? `<option value="">Select N/A item / expiry / container / unit</option>${opState.lots.map((lot, i) => `<option value="${i}" ${Number(lot.effectiveQty) <= 0 ? 'disabled' : ''}>${escapeHtml(lot.sku_name)} · ${escapeHtml(lot.uom)} · ${fmtDate(lot.expiry_date)} · ${escapeHtml(lot.container_no)}${escapeHtml(shipperOptionSuffix(lot))} · Available ${fmtQtyUom(lot.effectiveQty, lot.uom)}</option>`).join('')}`
      : '<option value="">No stock in this rack uses N/A for its active stock unit</option>';

    $(pick ? 'pick-unit-label' : 'tr-unit-label').textContent = 'selected unit';
    renderNaBarcodePrompt(operation);
    if (opState.lots.length === 1 && Number(opState.lots[0].effectiveQty) > 0) {
      lotSelect.value = '0';
      renderNaSelectedLot(operation);
    }
    if (!opState.lots.length) {
      const note = $(pick ? 'pick-qty-note' : 'tr-qty-note');
      note.classList.remove('hidden');
      note.textContent = `No positive stock in ${opState.locationCode} has N/A recorded for the barcode corresponding to its CASE, PACK, or PIECE stock unit.`;
      return toast(`No selectable N/A-barcode stock is available in ${opState.locationCode}.`, 'error');
    }
    if (pick) { updatePickFefoNote(); updatePickQtyNote(); }
    if (transfer) updateTransferQtyNote();
    return;
  }

  opState.naMode = false;
  opState.multiBarcodeMode = false;
  const { data: barcodeMatches, error: matchError } = await supabase.rpc('find_sku_barcode_matches', { p_barcode: barcode });
  if (matchError) return toast(friendlyError(matchError), 'error');
  const matches = barcodeMatches || [];
  if (!matches.length) {
    lotSelect.innerHTML = '<option value="">Barcode is not registered</option>';
    if (pick) {
      $('pick-unit-label').textContent = 'matched unit';
      clearPickBarcodeMatch('This barcode is not registered in the permanent SKU database.');
    }
    if (transfer) {
      $('tr-unit-label').textContent = 'matched unit';
      clearTransferBarcodeMatch('This barcode is not registered in the permanent SKU database.');
    }
    return toast('This barcode is not registered to a SKU.', 'error');
  }

  // One scanned value can now legally be registered in different barcode
  // categories. Build the selectable stock list from every matching SKU+unit
  // pair in the locked rack rather than choosing an arbitrary first match.
  const pairKeys = new Set(matches.map((m) => `${m.id}|${String(m.matched_type || '').toUpperCase()}`));
  const skuIds = [...new Set(matches.map((m) => m.id))];
  const [{ data: rackRows, error: rackError }, fefoResult] = await Promise.all([
    supabase.from('v_inventory_details').select('*').eq('location_code', opState.locationCode).in('sku_id', skuIds).order('sku_name').order('uom').order('expiry_date').order('container_no'),
    pick
      ? supabase.from('v_inventory_details').select('lot_id,sku_id,expiry_date,location_code,container_no,qty,uom').in('sku_id', skuIds).gt('qty', 0).neq('expiry_status', 'EXPIRED').order('expiry_date')
      : Promise.resolve({ data: [], error: null })
  ]);
  if (rackError || fefoResult.error) return toast(friendlyError(rackError || fefoResult.error), 'error');

  const candidates = (rackRows || []).filter((lot) => pairKeys.has(`${lot.sku_id}|${String(lot.uom || '').toUpperCase()}`));
  const queuedByLot = new Map();
  opState.cart.forEach((line) => {
    queuedByLot.set(line.lot_id, (queuedByLot.get(line.lot_id) || 0) + Number(line.qty || 0));
  });

  opState.lots = candidates.map((lot) => {
    const effectiveQty = Math.max(Number(lot.qty || 0) - (queuedByLot.get(lot.lot_id) || 0), 0);
    const earliest = pick
      ? (fefoResult.data || []).find((row) => row.sku_id === lot.sku_id && row.uom === lot.uom && Number(row.qty || 0) - (queuedByLot.get(row.lot_id) || 0) > 0)
      : null;
    return {
      ...lot,
      effectiveQty,
      earliestExpiry: earliest?.expiry_date || lot.expiry_date,
      earliestLocation: earliest?.location_code || opState.locationCode,
      earliestContainer: earliest?.container_no || lot.container_no,
      scannedBarcode: barcode,
      scannedBarcodeType: lot.uom
    };
  });

  const distinctPairs = [...new Set(matches.map((m) => `${m.id}|${String(m.matched_type || '').toUpperCase()}`))];
  opState.multiBarcodeMode = distinctPairs.length > 1;
  opState.sku = matches.length === 1 ? matches[0] : null;

  if (pick) {
    opState.lots.forEach((lot) => {
      const lotIds = new Set(opState.lots.filter((x) => x.sku_id === lot.sku_id && x.uom === lot.uom).map((x) => x.lot_id));
      opState.cart.forEach((line) => {
        if (lotIds.has(line.lot_id)) {
          line.earliest_expiry = lot.earliestExpiry || line.expiry_date;
          line.earliest_location = lot.earliestLocation || opState.locationCode;
          line.earliest_container = lot.earliestContainer || line.container_no;
        }
      });
    });
  }

  if (opState.multiBarcodeMode) {
    $(pick ? 'pick-unit-label' : 'tr-unit-label').textContent = 'selected unit';
    const panel = $(pick ? 'pick-barcode-match' : 'tr-barcode-match');
    panel.classList.remove('hidden');
    panel.innerHTML = `<strong>Barcode ${escapeHtml(barcode)} is registered in more than one barcode category.</strong> Select the exact item and CASE/PACK/PIECE unit from the list below. No unit is assumed automatically.`;
  } else {
    const match = matches[0];
    const expectedUom = String(match.matched_type || '').toUpperCase();
    $(pick ? 'pick-unit-label' : 'tr-unit-label').textContent = expectedUom;
    if (pick) renderPickBarcodeMatch(match, expectedUom, opState.lots);
    else renderTransferBarcodeMatch(match, expectedUom, opState.lots);
  }

  lotSelect.innerHTML = opState.lots.length
    ? `<option value="">${opState.multiBarcodeMode ? 'Select exact item / unit / expiry / container' : 'Select expiry / container'}</option>${opState.lots.map((lot, i) => `<option value="${i}" ${(pick || transfer) && Number(lot.effectiveQty ?? lot.qty) <= 0 ? 'disabled' : ''}>${opState.multiBarcodeMode ? `${escapeHtml(lot.sku_name)} · ${escapeHtml(lot.uom)} · ` : ''}${fmtDate(lot.expiry_date)} · ${escapeHtml(lot.container_no)}${escapeHtml(shipperOptionSuffix(lot))} · Available ${fmtQtyUom(pick ? lot.effectiveQty : lot.qty, lot.uom)}</option>`).join('')}`
    : '<option value="">No matching stock for this barcode in the locked location</option>';

  if (opState.lots.length === 1 && Number(opState.lots[0].effectiveQty ?? opState.lots[0].qty) > 0) {
    lotSelect.value = '0';
    if (opState.multiBarcodeMode) renderSelectedBarcodeCategoryLot(operation);
  }

  if (!opState.lots.length) {
    const categories = [...new Set(matches.map((m) => String(m.matched_type || '').toUpperCase()))].join(', ');
    if (pick) {
      $('pick-qty-note').classList.remove('hidden');
      $('pick-qty-note').textContent = `Barcode is registered as ${categories}, but none of those matching stock units are available in ${opState.locationCode}.`;
      toast(`Barcode is valid, but no matching stock is available in ${opState.locationCode}.`, 'error');
    } else {
      $('tr-qty-note').classList.remove('hidden');
      $('tr-qty-note').textContent = `Barcode is registered as ${categories}, but none of those matching stock units are available for transfer in ${opState.locationCode}.`;
      toast(`Barcode is valid, but no matching stock is available in ${opState.locationCode}.`, 'error');
    }
  }

  if (pick) { updatePickFefoNote(); updatePickQtyNote(); }
  if (transfer) updateTransferQtyNote();
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

  if (lot.shipper_box_id) {
    const sameBox = state.pick.cart.filter((x) => x.shipper_box_id === lot.shipper_box_id);
    if (lot.shipper_lot_role === 'HEADER' && qty !== 1) return toast('A complete SEALED Shipper Box is picked as exactly 1 CASE.', 'error');
    if (lot.shipper_lot_role === 'HEADER' && sameBox.some((x) => x.shipper_lot_role === 'CONTENT')) return toast('Individual contents from this Shipper are already queued.', 'error');
    if (lot.shipper_lot_role === 'CONTENT' && sameBox.some((x) => x.shipper_lot_role === 'HEADER')) return toast('The complete Shipper Box is already queued.', 'error');
  }

  const already = state.pick.cart.filter((x) => x.lot_id === lot.lot_id).reduce((sum, x) => sum + Number(x.qty), 0);
  if (qty + already > Number(lot.qty)) return toast(`Cannot exceed available stock of ${fmtQtyUom(lot.qty, lot.uom)}.`, 'error');

  const { data: fefoRows, error: earliestError } = await supabase
    .from('v_inventory_details')
    .select('lot_id,expiry_date,location_code,container_no,qty')
    .eq('sku_id', lot.sku_id)
    .eq('uom', lot.uom)
    .gt('qty', 0)
    .neq('expiry_status', 'EXPIRED')
    .order('expiry_date');
  if (earliestError) return toast(friendlyError(earliestError), 'error');
  const queuedByLot = new Map();
  state.pick.cart.forEach((line) => {
    queuedByLot.set(line.lot_id, (queuedByLot.get(line.lot_id) || 0) + Number(line.qty || 0));
  });
  const effectiveRows = (fefoRows || []).filter((row) => Number(row.qty || 0) - (queuedByLot.get(row.lot_id) || 0) > 0);
  const earliestRow = effectiveRows?.[0] || null;
  const earliestSameUnit = earliestRow?.expiry_date || lot.expiry_date;
  const fefoOverrideConfirmed = Boolean(earliestRow?.expiry_date && lot.expiry_date > earliestRow.expiry_date);
  if (fefoOverrideConfirmed && !window.confirm('Are you sure you want to disregard the FEFO warning?')) {
    return toast('Item was not added. The FEFO recommendation remains in effect.', 'error');
  }

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
    earliest_location: earliestRow?.location_code || state.pick.locationCode,
    earliest_container: earliestRow?.container_no || lot.container_no,
    fefo_override_confirmed: fefoOverrideConfirmed,
    available: Number(lot.qty),
    uom: lot.uom,
    shipper_box_id: lot.shipper_box_id || null,
    shipper_box_no: lot.shipper_box_no || null,
    shipper_status: lot.shipper_status || null,
    shipper_lot_role: lot.shipper_lot_role || null
  });
  renderOperationCart('pick');
  renderPickRackContents();
  toast('Supervisor barcode bypass added and will be recorded in history.', 'success');
}

function updatePickFefoNote() {
  const value = $('pick-lot').value;
  const note = $('pick-fefo-note');
  if (value === '') return note.classList.add('hidden');
  const index = Number(value);
  const lot = state.pick.lots[index];
  if (!lot || lot.expiry_date <= lot.earliestExpiry) return note.classList.add('hidden');
  const where = lot.earliestLocation
    ? ` at <strong>${escapeHtml(lot.earliestLocation)}</strong>${lot.earliestContainer ? ` / container <strong>${escapeHtml(lot.earliestContainer)}</strong>` : ''}`
    : '';
  note.innerHTML = `FEFO warning: selected expiry <strong>${fmtDate(lot.expiry_date)}</strong>, but the earliest CURRENT non-expired positive stock expires <strong>${fmtDate(lot.earliestExpiry)}</strong>${where}. Completing this line will be recorded as an override.`;
  note.classList.remove('hidden');
}

async function addOperationItem(operation) {
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
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) return toast(`Enter a whole-number ${lot.uom} transfer quantity greater than zero.`, 'error');
  }

  if (lot.shipper_box_id) {
    const sameBox = opState.cart.filter((x) => x.shipper_box_id === lot.shipper_box_id);
    if (lot.shipper_lot_role === 'HEADER' && sameBox.some((x) => x.shipper_lot_role === 'CONTENT')) {
      return toast(`Cannot add complete Shipper ${lot.shipper_box_no || ''}: individual contents from this same box are already queued.`, 'error');
    }
    if (lot.shipper_lot_role === 'CONTENT' && sameBox.some((x) => x.shipper_lot_role === 'HEADER')) {
      return toast(`Cannot add content from ${lot.shipper_box_no || 'this Shipper'} because the complete box is already queued.`, 'error');
    }
    if (lot.shipper_lot_role === 'HEADER' && qty !== 1) return toast('A complete SEALED Shipper Box is picked/transferred as exactly 1 CASE.', 'error');
  }

  const already = opState.cart.filter((x) => x.lot_id === lot.lot_id).reduce((a, x) => a + Number(x.qty), 0);
  if (qty + already > Number(lot.qty)) return toast(`Cannot exceed available stock of ${fmtQtyUom(lot.qty, lot.uom)}.`, 'error');

  const fefoOverrideConfirmed = Boolean(pick && lot.earliestExpiry && lot.expiry_date > lot.earliestExpiry);
  if (fefoOverrideConfirmed && !window.confirm('Are you sure you want to disregard the FEFO warning?')) {
    return toast('Item was not added. The FEFO recommendation remains in effect.', 'error');
  }

  opState.cart.push({
    lot_id: lot.lot_id,
    qty,
    barcode: lot.scannedBarcode,
    sku_name: lot.sku_name,
    brand: lot.brand || opState.sku?.brand || '',
    description: lot.description || opState.sku?.description || '',
    variant: lot.variant || opState.sku?.variant || '',
    size: lot.size || opState.sku?.size || '',
    container_no: lot.container_no,
    expiry_date: lot.expiry_date,
    earliest_expiry: lot.earliestExpiry,
    earliest_location: lot.earliestLocation || null,
    earliest_container: lot.earliestContainer || null,
    fefo_override_confirmed: fefoOverrideConfirmed,
    available: Number(lot.qty),
    uom: lot.uom,
    shipper_box_id: lot.shipper_box_id || null,
    shipper_box_no: lot.shipper_box_no || null,
    shipper_status: lot.shipper_status || null,
    shipper_lot_role: lot.shipper_lot_role || null,
    supervisor_bypass: false,
    bypass_reason: null
  });
  renderOperationCart(operation);
  if (pick) {
    renderPickRackContents();
    renderPickSalesOrderSummary();
  } else {
    renderTransferRackContents();
  }
  $(pick ? 'pick-qty' : 'tr-qty').value = '';
  if (pick && $('pick-barcode').value.trim()) loadOperationLots('pick');
  else if (pick) updatePickQtyNote();
  if (!pick) updateTransferQtyNote();
  toast(`${fmtQtyUom(qty, lot.uom)} added to the ${pick ? 'picking' : 'transfer'} session.`, 'success');
}
function renderOperationCart(operation) {
  const pick = operation === 'pick';
  const rows = state[operation].cart;
  const container = $(pick ? 'pick-cart' : 'tr-cart');
  if (!rows.length) return container.innerHTML = emptyState(pick ? 'No items added yet.' : 'No items queued for transfer yet.');

  const totals = rows.reduce((acc, r) => {
    acc[r.uom] = (acc[r.uom] || 0) + Number(r.qty || 0);
    return acc;
  }, { PIECE: 0, PACK: 0, CASE: 0 });
  const transferHeader = pick ? '' : `<div class="info-box"><strong>Transfer summary:</strong> ${rows.length.toLocaleString()} line(s) queued from ${escapeHtml(state.transfer.locationCode || '—')} · ${formatBalances(totals)}. Review these items before clicking Complete transfer.</div>`;

  container.innerHTML = `${transferHeader}<table><thead><tr>${pick ? '' : '<th>Item details</th>'}<th>SKU</th><th>Shipper box</th><th>Container</th><th>Expiry</th><th>Quantity</th><th>Barcode control</th><th></th></tr></thead><tbody>${rows.map((r, i) => `<tr>
    ${pick ? '' : `<td class="wrap"><strong>${escapeHtml([r.brand, r.description, r.variant, r.size].filter(Boolean).join(' '))}</strong><br><small>Source: ${escapeHtml(state.transfer.locationCode || '—')}</small></td>`}
    <td class="wrap">${escapeHtml(r.sku_name)}</td><td>${r.shipper_box_id ? `<span class="pill near">${escapeHtml(r.shipper_box_no || 'Shipper')} · ${escapeHtml(r.shipper_lot_role === 'HEADER' ? 'Complete' : 'Content')}</span>` : '<span class="pill">Loose</span>'}</td><td>${escapeHtml(r.container_no)}</td><td>${fmtDate(r.expiry_date)}</td><td>${fmtQtyUom(r.qty, r.uom)}</td>
    <td class="wrap">${pick
      ? (r.supervisor_bypass
        ? `<span class="pill override">Supervisor bypass</span><br><small>${escapeHtml(r.bypass_reason || '')}</small>`
        : `${normalizeBarcode(r.barcode) === 'N/A'
          ? `<span class="pill near">N/A ${escapeHtml((r.uom || '').toUpperCase())} selected</span>`
          : `<span class="pill">${escapeHtml((r.uom || '').toUpperCase())} barcode verified</span>`}${r.fefo_override_confirmed ? '<br><span class="pill override">FEFO override confirmed</span>' : ''}`)
      : (normalizeBarcode(r.barcode) === 'N/A'
        ? `<span class="pill near">N/A ${escapeHtml((r.uom || '').toUpperCase())} selected</span>`
        : `<span class="pill">${escapeHtml((r.uom || '').toUpperCase())} barcode verified</span><br><small>${escapeHtml(r.barcode || '')}</small>`)}</td>
    <td><button class="link-btn" data-operation="${operation}" data-remove-cart="${i}">Remove</button></td></tr>`).join('')}</tbody></table>`;
}

function removeCartItem(operation, index) {
  state[operation].cart.splice(index, 1);
  renderOperationCart(operation);
  if (operation === 'pick') {
    renderPickRackContents();
    renderPickSalesOrderSummary();
    if ($('pick-barcode').value.trim() && state.pick.locationCode) loadOperationLots('pick');
    else updatePickQtyNote();
  } else {
    renderTransferRackContents();
    if ($('tr-barcode').value.trim() && state.transfer.locationCode) loadOperationLots('transfer');
    else updateTransferQtyNote();
  }
}

async function cancelOperation(operation, silent = false) {
  const opState = state[operation];
  if (opState.lockToken) {
    const adjustmentMode = operation === 'pick' && Boolean(opState.adjustmentSessionKey);
    const rpcName = adjustmentMode ? 'cancel_stock_adjustment_pick' : 'cancel_location_operation';
    const rpcArgs = adjustmentMode
      ? {
          p_lock_token: opState.lockToken,
          p_adjustment_session_key: opState.adjustmentSessionKey,
          p_reason: silent ? 'Session ended during sign out.' : 'User cancelled or restarted the Stock Adjustment source-rack session.'
        }
      : {
          p_lock_token: opState.lockToken,
          p_reason: silent ? 'Session ended during sign out.' : 'User cancelled or restarted the source-location session.'
        };
    const { error } = await supabase.rpc(rpcName, rpcArgs);
    if (error && !silent) toast(friendlyError(error), 'error');
  }
  invalidateReports();
  resetOperation(operation);
  if (!silent) toast(operation === 'pick'
    ? (isStockAdjustmentSalesOrder($('pick-so').value)
        ? 'Stock Adjustment rack session cancelled. Sales Order 0 remains immediately reusable.'
        : 'Rack session cancelled. The sales order remains open so you may scan the same or a different location.')
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
    $('tr-unit-label').textContent = 'matched unit';
    $('tr-destination').value = '';
    $('tr-note').value = '';
    $('tr-rack-title').textContent = 'Source rack contents';
    $('tr-rack-contents').innerHTML = emptyState('Lock a source rack to display its available items.');
    clearTransferBarcodeMatch();
    $('tr-qty-note').textContent = '';
    $('tr-qty-note').classList.add('hidden');
  }
  configureOperationUi(operation, false);
  renderOperationCart(operation);
}



async function loadPickSalesOrderSummary() {
  const so = $('pick-so').value.trim();
  if (isStockAdjustmentSalesOrder(so)) {
    state.pickOrderSummary = [];
    renderPickSalesOrderSummary();
    return;
  }
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
  if (isStockAdjustmentSalesOrder(so)) {
    const queued = (state.pick.cart || []).map((row) => {
      const item = [row.brand, row.description, row.variant, row.size].filter(Boolean).join(' ') || row.sku_name || '—';
      return `<tr><td><span class="pill near">QUEUED</span></td><td>${escapeHtml(state.pick.locationCode || '—')}</td><td class="wrap"><strong>${escapeHtml(item)}</strong></td><td>${escapeHtml(row.container_no || '—')}</td><td>${fmtDate(row.expiry_date)}</td><td>${fmtQtyUom(row.qty, row.uom)}</td></tr>`;
    }).join('');

    container.innerHTML = `<div class="info-box">
      <strong>Warehouse Stock Adjustment — Sales Order 0.</strong>
      SO 0 has no permanent Sales Order lifecycle and can be reused indefinitely.
      Each completed rack is saved immediately to Transaction History as SO 0.
      <strong>Finish Sales Order is not required.</strong>
    </div>` + (queued
      ? `<table><thead><tr><th>Status</th><th>Rack</th><th>Item</th><th>Container</th><th>Expiry</th><th>Adjustment OUT</th></tr></thead><tbody>${queued}</tbody></table>`
      : emptyState('No stock-adjustment items are queued on the current rack.'));
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
  if (isStockAdjustmentSalesOrder($('pick-so').value)) {
    return Boolean(state.pick.lockToken);
  }
  return Boolean(state.pick.lockToken)
    || (state.pickOrder.status === 'OPEN' && Boolean(state.pickOrder.isCurrentOwner));
}

function updatePickSalesOrderControls() {
  const hasSo = Boolean($('pick-so').value.trim());
  const adjustmentMode = isStockAdjustmentSalesOrder($('pick-so').value);
  const orderOpen = state.pickOrder.status === 'OPEN';
  const hasSavedPick = Number(state.pickOrder.pickCount || 0) > 0;
  const unlocked = !state.pick.lockToken;
  const soLocked = isPickSalesOrderInputLocked();

  $('pick-so').disabled = soLocked;
  $('pick-so').title = soLocked
    ? (adjustmentMode
        ? 'Sales Order 0 is locked only while this Stock Adjustment rack is active.'
        : 'Sales Order is locked while this picking order is in progress. Finish the Sales Order to release it.')
    : '';

  $('pick-finish-so-btn').disabled = adjustmentMode || !(state.mode === 'ACTIVE' && hasSo && orderOpen && hasSavedPick && unlocked);
  $('pick-finish-so-btn').title = adjustmentMode ? 'Sales Order 0 is reusable Stock Adjustment mode and does not need to be finished.' : '';

  // Normal Sales Orders use the existing whole-order cancellation rule.
  // Sales Order 0 repurposes this button as a clean way to LEAVE
  // Warehouse Stock Adjustment mode.
  const cancelWhole = $('pick-cancel-order-btn');
  if (cancelWhole) {
    if (adjustmentMode) {
      cancelWhole.textContent = 'Exit stock adjustment';
      cancelWhole.disabled = !hasSo;
      cancelWhole.title = state.pick.lockToken
        ? 'Cancel/release the current Stock Adjustment rack and leave Sales Order 0 mode.'
        : 'Leave Sales Order 0 Warehouse Stock Adjustment mode.';
    } else {
      cancelWhole.textContent = 'Cancel picking';
      cancelWhole.disabled = !(state.mode === 'ACTIVE' && hasSo && orderOpen && !hasSavedPick && Boolean(state.pickOrder.isCurrentOwner));
      cancelWhole.title = hasSavedPick
        ? 'This Sales Order already has a saved pick and can no longer be cancelled as an empty picking session.'
        : 'Cancel the entire empty picking session and release this Sales Order number for reuse.';
    }
  }
}

function syncPickOverrideControls() {
  const checkbox = $('pick-so-override');
  const reason = $('pick-so-override-reason');
  if (!checkbox || !reason) return;

  const completed = state.pickOrder.status === 'COMPLETED';
  const adjustmentMode = isStockAdjustmentSalesOrder($('pick-so').value);
  const available = !adjustmentMode && isAdminOrOwner() && completed && !state.pick.lockToken;

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

  if (isStockAdjustmentSalesOrder(so)) {
    state.pickOrder = { salesOrder: '0', status: 'ADJUSTMENT', pickCount: 0, openedBy: state.profile?.username || null, isCurrentOwner: true };
    box.innerHTML = `<strong>Warehouse Stock Adjustment:</strong> Sales Order <strong>0</strong> is a reusable adjustment code and may be used indefinitely. Each completed rack is saved directly as a PICK transaction under SO 0. It does not become a completed Sales Order and does not require <strong>Finish Sales Order</strong>.`;
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
      box.innerHTML = `<strong>Sales order status:</strong> <strong>${escapeHtml(row.order_number)}</strong> was completed ${row.completed_at ? `on ${escapeHtml(fmtDateTime(row.completed_at))}` : ''}. It cannot be reused unless an Admin or Owner checks the override and records a reason.`;
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

async function exitStockAdjustmentMode() {
  if (!isStockAdjustmentSalesOrder($('pick-so').value)) return false;

  const hasRack = Boolean(state.pick.lockToken);
  const queuedCount = Number(state.pick.cart?.length || 0);
  const warning = hasRack
    ? `\n\nThe current Stock Adjustment rack ${state.pick.locationCode || ''} will be cancelled and its rack lock released.${queuedCount ? ` ${queuedCount} unsaved queued line(s) will be discarded; inventory has not yet been deducted for those queued lines.` : ''}`
    : '';

  if (!window.confirm(
    `Exit Warehouse Stock Adjustment mode (Sales Order 0)?${warning}\n\nCompleted Stock Adjustment transactions already saved to history will NOT be changed.`
  )) return false;

  const button = $('pick-cancel-order-btn');
  setBusy(button, true, hasRack ? 'Releasing rack…' : 'Exiting…');

  try {
    if (hasRack) {
      if (!state.pick.adjustmentSessionKey) {
        throw new Error('The Stock Adjustment session key is missing. Refresh the page to recover the screen; the rack lock will expire automatically if it cannot be released.');
      }

      const { error } = await supabase.rpc('cancel_stock_adjustment_pick', {
        p_lock_token: state.pick.lockToken,
        p_adjustment_session_key: state.pick.adjustmentSessionKey,
        p_reason: 'User exited Warehouse Stock Adjustment mode.'
      });
      if (error) throw error;
    }

    stopHeartbeat(state.pick);
    state.pick = freshOperationState();

    $('pick-so').value = '';
    $('pick-location').value = '';
    $('pick-barcode').value = '';
    $('pick-lot').innerHTML = '<option value="">Scan a barcode first</option>';
    $('pick-qty').value = '';
    $('pick-so-override').checked = false;
    $('pick-so-override-reason').value = '';
    $('pick-so-override-reason').disabled = true;

    clearPickBarcodeMatch();
    $('pick-fefo-note').classList.add('hidden');
    $('pick-qty-note').classList.add('hidden');
    $('pick-rack-title').textContent = 'Source rack contents';
    $('pick-rack-contents').innerHTML = emptyState('Lock a source rack to display its available items.');

    state.pickOrder = {
      salesOrder: null,
      status: null,
      pickCount: 0,
      openedBy: null,
      isCurrentOwner: false
    };
    state.pickOrderSummary = [];

    configureOperationUi('pick', false);
    renderOperationCart('pick');
    invalidateReports();
    await refreshPickSalesOrderStatus();

    toast('Warehouse Stock Adjustment mode closed. You may now enter a normal Sales Order.', 'success');
    return true;
  } catch (error) {
    toast(`Could not exit Stock Adjustment mode safely: ${friendlyError(error)}`, 'error');
    return false;
  } finally {
    setBusy(button, false);
    updatePickSalesOrderControls();
  }
}

async function cancelEntirePicking() {
  const so = $('pick-so').value.trim();
  if (!so) return toast('Enter the sales order number.', 'error');
  if (isStockAdjustmentSalesOrder(so)) {
    return exitStockAdjustmentMode();
  }

  // Refresh immediately before cancellation so an older client status cannot
  // accidentally release an order that already has a completed rack pick.
  const statusOk = await refreshPickSalesOrderStatus();
  if (!statusOk) return toast('The sales order status could not be verified. Please try again.', 'error');
  if (state.pickOrder.status !== 'OPEN') return toast('Only an OPEN picking session can be cancelled.', 'error');
  if (!state.pickOrder.isCurrentOwner) return toast('Only the user who opened this empty picking session may cancel it.', 'error');
  if (Number(state.pickOrder.pickCount || 0) > 0) {
    return toast('This Sales Order already has a saved rack pick. It can no longer be cancelled as an empty picking session.', 'error');
  }

  const queuedText = state.pick.cart.length
    ? `\n\n${state.pick.cart.length} unsaved queued line(s) on the current rack will be discarded. No inventory has been deducted yet.`
    : '';
  if (!window.confirm(`Cancel the entire picking process for Sales Order ${so}?${queuedText}\n\nBecause no rack pick has been saved, this Sales Order number will become available for use again.`)) return;

  const button = $('pick-cancel-order-btn');
  setBusy(button, true, 'Cancelling…');
  const { data, error } = await supabase.rpc('cancel_empty_pick_sales_order', { p_sales_order: so });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  // The database RPC releases any active rack lock belonging to this empty order.
  stopHeartbeat(state.pick);
  state.pick = freshOperationState();
  $('pick-so').value = '';
  $('pick-location').value = '';
  $('pick-barcode').value = '';
  $('pick-lot').innerHTML = '<option value="">Scan a barcode first</option>';
  $('pick-qty').value = '';
  $('pick-so-override').checked = false;
  $('pick-so-override-reason').value = '';
  $('pick-so-override-reason').disabled = true;
  clearPickBarcodeMatch();
  $('pick-fefo-note').classList.add('hidden');
  $('pick-qty-note').classList.add('hidden');
  $('pick-rack-title').textContent = 'Source rack contents';
  $('pick-rack-contents').innerHTML = emptyState('Lock a source rack to display its available items.');
  configureOperationUi('pick', false);
  renderOperationCart('pick');
  state.pickOrder = { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false };
  state.pickOrderSummary = [];
  invalidateReports();
  await refreshPickSalesOrderStatus();

  const result = data?.[0]?.result_action || 'CANCELLED_REUSABLE';
  toast(result === 'RESTORED_COMPLETED'
    ? `Picking session cancelled. ${so} remains protected as a previously completed Sales Order.`
    : `Picking session cancelled. ${so} is available for use again.`, 'success');
}

async function finishPickSalesOrder() {
  const so = $('pick-so').value.trim();
  if (!so) return toast('Enter the sales order number.', 'error');
  if (isStockAdjustmentSalesOrder(so)) {
    return toast('Sales Order 0 is reusable Warehouse Stock Adjustment mode. Finish Sales Order is not required.', 'success');
  }
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
  const so = $('pick-so').value.trim();
  const adjustmentMode = isStockAdjustmentSalesOrder(so);

  if (adjustmentMode && !state.pick.adjustmentSessionKey) {
    return toast('The Stock Adjustment session key is missing. Cancel/restart the rack and lock it again.', 'error');
  }

  const items = state.pick.cart.map(({ lot_id, qty, barcode, supervisor_bypass, bypass_reason, fefo_override_confirmed }) => ({
    lot_id, qty, barcode, supervisor_bypass: Boolean(supervisor_bypass), bypass_reason: bypass_reason || null,
    fefo_override_confirmed: Boolean(fefo_override_confirmed)
  }));

  setBusy(button, true, adjustmentMode ? 'Saving adjustment…' : 'Completing…');

  const rpcName = adjustmentMode ? 'complete_stock_adjustment_picking' : 'complete_picking';
  const rpcArgs = adjustmentMode
    ? {
        p_location_code: state.pick.locationCode,
        p_lock_token: state.pick.lockToken,
        p_adjustment_session_key: state.pick.adjustmentSessionKey,
        p_items: items,
        p_allow_fefo_override: requiresOverride,
        p_override_reason: reason
      }
    : {
        p_location_code: state.pick.locationCode,
        p_lock_token: state.pick.lockToken,
        p_sales_order: so,
        p_items: items,
        p_allow_fefo_override: requiresOverride,
        p_override_reason: reason,
        p_note: null
      };

  const { data, error } = await supabase.rpc(rpcName, rpcArgs);
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  if (adjustmentMode) {
    toast(`Stock Adjustment OUT saved: ${data?.[0]?.transaction_no || 'completed'} · Sales Order 0 remains reusable.${requiresOverride ? ' FEFO override recorded.' : ''} Put-away the remaining usable units as needed.`, 'success');
  } else {
    toast(`Rack pick saved: ${data?.[0]?.transaction_no || 'completed'}${requiresOverride ? ' · FEFO override recorded' : ''}. Scan the next source rack, or finish the sales order when all items are complete.`, 'success');
  }

  invalidateReports();
  resetOperation('pick');
  $('pick-so').value = so;
  await refreshPickSalesOrderStatus();
}

async function completeTransfer() {
  if (!state.transfer.cart.length) return toast('Add at least one item.', 'error');
  if (state.transfer.cart.some((item) => !Number.isInteger(Number(item.qty)))) return toast('Transfer cannot continue: CASE, PACK, and PIECE quantities must be whole numbers.', 'error');
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
  const { data, error } = await supabase.from('v_inventory_search').select('*').order('location_sort_order', { ascending: true, nullsFirst: false }).order('location_code').order('sku_name').limit(10000);
  if (error) throw error;
  state.data.inventory = data || [];
  renderInventory();
}

function renderInventory() {
  const term = $('inventory-search').value.trim().toLowerCase();
  const rows = state.data.inventory.filter((r) => [
    r.sku_name, r.brand, r.description, r.variant, r.size,
    r.case_barcode, r.pack_barcode, r.piece_barcode,
    r.container_no, r.location_code, isNoExpiryDate(r.expiry_date) ? 'N/A no expiry' : r.expiry_date,
    r.uom, r.putaway_remarks, r.transfer_remarks,
    r.shipper_box_no, r.shipper_status, r.shipper_lot_role
  ].join(' ').toLowerCase().includes(term));
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
  const actionHeader = isAdminOrOwner() ? '<th>Actions</th>' : '';
  $('inventory-table').innerHTML = rows.length ? `<table><thead><tr><th>Location</th><th>SKU</th><th>Shipper box</th><th>Container</th><th>Expiry</th><th>Status</th><th>Quantity</th><th>Put-away remarks</th><th>Stock transfer remarks</th>${actionHeader}</tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${escapeHtml(r.location_code)}</td><td class="wrap">${escapeHtml(r.sku_name)}</td><td>${shipperBadge(r)}</td><td>${escapeHtml(r.container_no)}</td><td>${fmtDate(r.expiry_date)}</td><td>${isNoExpiryDate(r.expiry_date) ? '<span class="pill">N/A</span>' : expiryPill(r.expiry_status)}</td><td>${fmtQtyUom(r.qty, r.uom)}</td><td class="wrap">${escapeHtml(r.putaway_remarks || '—')}</td><td class="wrap">${escapeHtml(r.transfer_remarks || '—')}</td>
    ${isAdminOrOwner() ? (r.shipper_box_id ? `<td><button class="link-btn" data-inventory-edit="${escapeHtml(r.lot_id)}">Edit</button><br><small>Shipper-safe correction · ${escapeHtml(r.shipper_box_no || '')}</small></td>` : `<td><button class="link-btn" data-inventory-edit="${escapeHtml(r.lot_id)}">Edit</button> <button class="link-btn" data-inventory-delete="${escapeHtml(r.lot_id)}">Delete</button></td>`) : ''}
  </tr>`).join('')}</tbody></table>` : emptyState('No matching inventory.');
}

async function openInventoryLotEdit(lotId) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required.', 'error');
  const row = state.data.inventory.find((r) => r.lot_id === lotId);
  if (!row) return toast('Inventory lot is no longer available. Refresh Inventory and try again.', 'error');

  const isShipperLot = Boolean(row.shipper_box_id);
  const shipperRole = String(row.shipper_lot_role || '').toUpperCase();
  const targetSkuType = isShipperLot && shipperRole === 'HEADER' ? 'SHIPPER' : 'STANDARD';

  const [skuRes, locationRes] = await Promise.all([
    supabase.from('skus').select('id,brand,description,variant,size,case_barcode,pack_barcode,piece_barcode,sku_type').eq('sku_type', targetSkuType).order('brand').order('description').order('variant').order('size').limit(10000),
    supabase.from('locations').select('id,code,sort_order,is_active').eq('is_active', true).order('sort_order', { ascending: true, nullsFirst: false }).order('code').limit(10000)
  ]);
  if (skuRes.error) return toast(friendlyError(skuRes.error), 'error');
  if (locationRes.error) return toast(friendlyError(locationRes.error), 'error');

  $('inventory-adjust-lot-id').value = lotId;
  $('inventory-adjust-shipper-box-id').value = row.shipper_box_id || '';
  $('inventory-adjust-current').innerHTML = `<strong>Current lot:</strong> ${escapeHtml(row.sku_name)} · ${escapeHtml(row.location_code)} · ${escapeHtml(row.container_no)} · ${fmtDate(row.expiry_date)} · ${fmtQtyUom(row.qty, row.uom)}`;

  $('inventory-adjust-sku').innerHTML = (skuRes.data || []).map((sku) => {
    const label = [sku.brand, sku.description, sku.variant, sku.size].filter(Boolean).join(' ');
    const barcode = targetSkuType === 'SHIPPER' ? sku.case_barcode : (sku.pack_barcode || sku.case_barcode || sku.piece_barcode);
    return `<option value="${escapeHtml(sku.id)}" ${sku.id === row.sku_id ? 'selected' : ''}>${escapeHtml(label)} · ${escapeHtml(targetSkuType === 'SHIPPER' ? 'CASE' : 'PACK')} ${escapeHtml(barcode || 'N/A')}</option>`;
  }).join('');

  $('inventory-adjust-location').innerHTML = (locationRes.data || []).map((loc) =>
    `<option value="${escapeHtml(loc.code)}" ${loc.code === row.location_code ? 'selected' : ''}>${escapeHtml(loc.code)}</option>`
  ).join('');

  $('inventory-adjust-container').value = row.container_no || '';
  $('inventory-adjust-expiry').value = row.expiry_date || '';
  $('inventory-adjust-uom').value = row.uom || 'PIECE';
  $('inventory-adjust-qty').value = Number(row.qty);
  $('inventory-adjust-reason').value = '';

  const shipperContext = $('inventory-adjust-shipper-context');
  const noteWrap = $('inventory-adjust-putaway-note-wrap');
  const noteInput = $('inventory-adjust-putaway-note');
  const help = $('inventory-adjust-shipper-help');

  // Reset generic field behavior before applying Shipper-specific safeguards.
  $('inventory-adjust-sku').disabled = false;
  $('inventory-adjust-location').disabled = false;
  $('inventory-adjust-container').disabled = false;
  $('inventory-adjust-expiry').disabled = false;
  $('inventory-adjust-uom').disabled = false;
  $('inventory-adjust-qty').disabled = false;
  $('inventory-adjust-qty').min = '1';
  shipperContext.classList.add('hidden');
  noteWrap.classList.add('hidden');
  help.classList.add('hidden');
  noteInput.value = '';

  if (isShipperLot) {
    const { data: box, error: boxError } = await supabase.from('shipper_boxes').select('id,box_no,status,shipper_sku_id,location_id,container_no,putaway_transaction_id').eq('id', row.shipper_box_id).single();
    if (boxError) return toast(friendlyError(boxError), 'error');
    const [shipperSkuRes, txRes] = await Promise.all([
      supabase.from('skus').select('brand,description,variant,size,case_barcode').eq('id', box.shipper_sku_id).single(),
      box.putaway_transaction_id
        ? supabase.from('transactions').select('note,tx_no,created_at').eq('id', box.putaway_transaction_id).single()
        : Promise.resolve({ data: null, error: null })
    ]);
    if (shipperSkuRes.error) return toast(friendlyError(shipperSkuRes.error), 'error');
    if (txRes.error) return toast(friendlyError(txRes.error), 'error');

    const shipperSku = shipperSkuRes.data || {};
    const selectedBarcode = shipperRole === 'HEADER' ? row.case_barcode : row.pack_barcode;
    shipperContext.innerHTML = `<strong>Physical Shipper correction</strong><br>
      Box ID: <strong>${escapeHtml(box.box_no || row.shipper_box_no || '—')}</strong> · Status: <strong>${escapeHtml(box.status || row.shipper_status || '—')}</strong><br>
      Shipper item: ${escapeHtml([shipperSku.brand, shipperSku.description, shipperSku.variant, shipperSku.size].filter(Boolean).join(' '))}<br>
      Shipper CASE barcode: ${escapeHtml(shipperSku.case_barcode || '—')}<br>
      Current ${escapeHtml(shipperRole === 'HEADER' ? 'Shipper CASE' : 'content PACK')} item: ${escapeHtml(row.sku_name)} · Barcode: ${escapeHtml(selectedBarcode || 'N/A')}<br>
      Original transaction: ${escapeHtml(txRes.data?.tx_no || '—')} · ${txRes.data?.created_at ? escapeHtml(fmtDateTime(txRes.data.created_at)) : '—'}`;
    shipperContext.classList.remove('hidden');
    noteWrap.classList.remove('hidden');
    help.classList.remove('hidden');
    noteInput.value = txRes.data?.note || '';

    // Physical Shipper identities have fixed stock units. HEADER CASE qty/expiry are
    // derived from the box contents; CONTENT rows are PACK-level only.
    $('inventory-adjust-uom').disabled = true;
    if (shipperRole === 'HEADER') {
      $('inventory-adjust-uom').value = 'CASE';
      $('inventory-adjust-qty').value = 1;
      $('inventory-adjust-qty').disabled = true;
      $('inventory-adjust-expiry').disabled = true;
      $('inventory-adjust-expiry').title = 'Complete Shipper expiry is automatically calculated from the earliest remaining content expiry.';
    } else {
      $('inventory-adjust-uom').value = 'PACK';
      $('inventory-adjust-qty').min = '0';
      $('inventory-adjust-expiry').title = '';
    }
  }

  $('inventory-adjust-dialog').showModal();
}

async function submitInventoryLotEdit(event) {
  event.preventDefault();
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required.', 'error');

  const lotId = $('inventory-adjust-lot-id').value;
  const row = state.data.inventory.find((r) => r.lot_id === lotId);
  if (!row) return toast('Inventory lot is no longer available. Refresh Inventory and try again.', 'error');
  const isShipperLot = Boolean(row.shipper_box_id);
  const shipperRole = String(row.shipper_lot_role || '').toUpperCase();
  const qty = isShipperLot && shipperRole === 'HEADER' ? 1 : Number($('inventory-adjust-qty').value);

  if (!Number.isInteger(qty) || (isShipperLot && shipperRole === 'CONTENT' ? qty < 0 : qty <= 0)) {
    return toast(isShipperLot && shipperRole === 'CONTENT'
      ? 'Shipper PACK quantity must be a whole number of 0 or greater.'
      : 'Adjusted CASE, PACK, and PIECE quantities must be positive whole numbers.', 'error');
  }
  const reason = $('inventory-adjust-reason').value.trim();
  if (!reason) return toast('Enter the reason for this inventory adjustment.', 'error');

  const button = event.submitter;
  setBusy(button, true, 'Saving…');

  let data, error;
  if (isShipperLot) {
    ({ data, error } = await supabase.rpc('supervisor_adjust_shipper_inventory_lot', {
      p_lot_id: lotId,
      p_sku_id: $('inventory-adjust-sku').value,
      p_location_code: normalizeLocation($('inventory-adjust-location').value),
      p_container_no: $('inventory-adjust-container').value.trim(),
      p_expiry_date: $('inventory-adjust-expiry').value || row.expiry_date,
      p_qty: qty,
      p_putaway_note: $('inventory-adjust-putaway-note').value.trim() || null,
      p_reason: reason
    }));
  } else {
    ({ data, error } = await supabase.rpc('supervisor_adjust_inventory_lot', {
      p_lot_id: lotId,
      p_sku_id: $('inventory-adjust-sku').value,
      p_location_code: normalizeLocation($('inventory-adjust-location').value),
      p_container_no: $('inventory-adjust-container').value.trim(),
      p_expiry_date: $('inventory-adjust-expiry').value,
      p_uom: $('inventory-adjust-uom').value,
      p_qty: qty,
      p_reason: reason
    }));
  }

  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  $('inventory-adjust-dialog').close();
  invalidateReports();
  await loadInventory(true);
  const result = data?.[0];
  if (isShipperLot) {
    toast(`Shipper inventory corrected${result?.result_box_no ? ` · ${result.result_box_no}` : ''}${result?.merged_into_existing ? ' · matching content lots merged' : ''}. Audit record saved.`, 'success');
  } else {
    toast(result?.merged_into_existing ? 'Inventory lot corrected and merged with an existing matching lot. Audit record saved.' : 'Inventory lot corrected. Audit record saved.', 'success');
  }
}

async function deleteInventoryLot(lotId) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required.', 'error');
  const row = state.data.inventory.find((r) => r.lot_id === lotId);
  if (!row) return toast('Inventory lot is no longer available. Refresh Inventory and try again.', 'error');
  if (row.shipper_box_id) return toast('Shipper-linked lots can be corrected with Edit, but direct Delete remains protected so the physical box status cannot be broken.', 'error');

  const reason = window.prompt(`Reason for deleting this active inventory lot:

${row.sku_name}
${row.location_code} · ${row.container_no} · ${fmtQtyUom(row.qty, row.uom)}`);
  if (!reason?.trim()) return;
  if (!window.confirm(`Delete this lot from active inventory?

${row.sku_name}
${row.location_code} · ${row.container_no} · ${fmtQtyUom(row.qty, row.uom)}

The balance will become zero. Historical transaction records will remain.`)) return;

  const { error } = await supabase.rpc('supervisor_delete_inventory_lot', {
    p_lot_id: lotId,
    p_reason: reason.trim()
  });
  if (error) return toast(friendlyError(error), 'error');

  invalidateReports();
  await loadInventory(true);
  toast('Inventory lot removed from active inventory. Audit record saved.', 'success');
}


function skuHealthActual(code) {
  const value = normalizeBarcode(code);
  return value && value !== 'N/A' ? value : null;
}

function buildSkuHealthGroups(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const key = row.detail_group_key || `${row.sku_type}|${row.brand}|${row.description}|${row.variant}|${row.size}`;
    if (!map.has(key)) map.set(key, { key, rows: [] });
    map.get(key).rows.push(row);
  }

  return Array.from(map.values()).map((group) => {
    const active = group.rows.filter((r) => r.is_active);
    const archived = group.rows.filter((r) => !r.is_active);
    const sample = active[0] || archived[0] || group.rows[0];

    const categoryStats = {};
    for (const category of ['case','pack','piece']) {
      const values = active.map((r) => skuHealthActual(r[`${category}_barcode`])).filter(Boolean);
      const unique = Array.from(new Set(values.map((v) => v.toLowerCase())));
      const naCount = active.filter((r) => !skuHealthActual(r[`${category}_barcode`])).length;
      categoryStats[category] = { values, unique, naCount };
    }

    const duplicateDetails = active.length > 1;
    const splitBarcodes = duplicateDetails && ['case','pack','piece'].some((category) => {
      const stat = categoryStats[category];
      return stat.unique.length > 1 || (stat.unique.length > 0 && stat.naCount > 0);
    });
    const incomplete = active.some((r) => {
      const type = String(r.sku_type || 'STANDARD').toUpperCase();
      if (type === 'SHIPPER') return !skuHealthActual(r.case_barcode);
      return !skuHealthActual(r.case_barcode) || !skuHealthActual(r.pack_barcode) || !skuHealthActual(r.piece_barcode);
    });
    const crossCategory = active.some((r) => Boolean(r.cross_category_reuse));
    const archivedOnly = active.length === 0 && archived.length > 0;

    let status = 'CLEAN';
    if (archivedOnly) status = 'ARCHIVED';
    else if (duplicateDetails || splitBarcodes || crossCategory) status = 'REVIEW';
    else if (incomplete) status = 'INCOMPLETE';

    const issues = [];
    if (duplicateDetails) issues.push('Duplicate details');
    if (splitBarcodes) issues.push('Possible split barcode family');
    if (crossCategory) issues.push('Cross-category barcode reuse');
    if (incomplete) issues.push('Incomplete barcode family');
    if (archivedOnly) issues.push('Archived only');

    return {
      ...group,
      active,
      archived,
      sample,
      categoryStats,
      duplicateDetails,
      splitBarcodes,
      incomplete,
      crossCategory,
      archivedOnly,
      status,
      issues
    };
  });
}

async function loadSkuHealth(force = false) {
  if (!isAdminOrOwner()) return;
  if (!force && state.data.skuHealth.length) return renderSkuHealth();

  const { data, error } = await supabase.rpc('admin_get_sku_master_health');
  if (error) throw error;

  state.data.skuHealth = data || [];
  renderSkuHealth();
}

function skuHealthPill(status) {
  if (status === 'REVIEW') return '<span class="pill expired">REVIEW</span>';
  if (status === 'INCOMPLETE') return '<span class="pill near">INCOMPLETE</span>';
  if (status === 'ARCHIVED') return '<span class="pill">ARCHIVED</span>';
  return '<span class="pill">CLEAN</span>';
}

function skuHealthBarcodeCoverage(group) {
  const parts = ['case','pack','piece'].map((category) => {
    const label = category.toUpperCase();
    const values = Array.from(new Set(
      group.active.map((r) => skuHealthActual(r[`${category}_barcode`])).filter(Boolean)
    ));
    return `${label}: ${values.length ? values.join(' / ') : 'N/A'}`;
  });
  return parts.join('<br>');
}

function skuHealthRecordDetails(group) {
  return group.rows.map((r) => {
    const stateText = r.is_active ? 'ACTIVE' : 'ARCHIVED';
    const stockText = Number(r.positive_lot_count || 0) > 0 ? ` · ${Number(r.positive_lot_count).toLocaleString()} positive lot(s)` : '';
    const deletedText = !r.is_active && r.deleted_at ? ` · deleted ${fmtDateTime(r.deleted_at)}` : '';
    return `<div style="margin-bottom:8px">
      <strong>${escapeHtml(stateText)}</strong> ·
      CASE ${escapeHtml(r.case_barcode || 'N/A')} ·
      PACK ${escapeHtml(r.pack_barcode || 'N/A')} ·
      PIECE ${escapeHtml(r.piece_barcode || 'N/A')}
      ${escapeHtml(stockText)}${escapeHtml(deletedText)}
      ${!r.is_active && r.delete_reason ? `<br><small>Delete reason: ${escapeHtml(r.delete_reason)}</small>` : ''}
    </div>`;
  }).join('');
}

function renderSkuHealth() {
  if (!isAdminOrOwner()) return;

  const groups = buildSkuHealthGroups(state.data.skuHealth);
  const term = $('sku-health-search').value.trim().toLowerCase();
  const filter = $('sku-health-filter').value;

  const visible = groups.filter((group) => {
    const haystack = group.rows.map((r) => [
      r.sku_type, r.brand, r.description, r.variant, r.size,
      r.case_barcode, r.pack_barcode, r.piece_barcode,
      r.created_by_username, r.deleted_by_username, r.delete_reason
    ].join(' ')).join(' ').toLowerCase();

    if (term && !haystack.includes(term)) return false;
    if (!filter || filter === 'ALL') return true;
    if (filter === 'NEEDS_REVIEW') return ['REVIEW','INCOMPLETE'].includes(group.status);
    if (filter === 'DUPLICATE') return group.duplicateDetails;
    if (filter === 'SPLIT') return group.splitBarcodes;
    if (filter === 'CROSS') return group.crossCategory;
    if (filter === 'INCOMPLETE') return group.incomplete && !group.archivedOnly;
    if (filter === 'ARCHIVED') return group.archived.length > 0;
    if (filter === 'CLEAN') return group.status === 'CLEAN';
    return true;
  });

  const activeSkuCount = state.data.skuHealth.filter((r) => r.is_active).length;
  const archivedSkuCount = state.data.skuHealth.filter((r) => !r.is_active).length;
  const duplicateGroups = groups.filter((g) => g.duplicateDetails).length;
  const splitGroups = groups.filter((g) => g.splitBarcodes).length;
  const reviewGroups = groups.filter((g) => ['REVIEW','INCOMPLETE'].includes(g.status)).length;
  const cleanGroups = groups.filter((g) => g.status === 'CLEAN').length;

  $('sku-health-summary').innerHTML =
    `<strong>Active SKUs:</strong> ${activeSkuCount.toLocaleString()} · ` +
    `<strong>Clean groups:</strong> ${cleanGroups.toLocaleString()} · ` +
    `<strong>Needs review:</strong> ${reviewGroups.toLocaleString()} · ` +
    `<strong>Duplicate-detail groups:</strong> ${duplicateGroups.toLocaleString()} · ` +
    `<strong>Split-barcode groups:</strong> ${splitGroups.toLocaleString()} · ` +
    `<strong>Archived records:</strong> ${archivedSkuCount.toLocaleString()}`;

  $('sku-health-count').textContent =
    `${visible.length.toLocaleString()} of ${groups.length.toLocaleString()} SKU detail group(s) shown`;

  $('sku-health-table').innerHTML = visible.length ? `<table>
    <thead><tr>
      <th>Status</th>
      <th>SKU details</th>
      <th>Barcode coverage</th>
      <th>Master records</th>
      <th>Issues / recommendation</th>
      <th></th>
    </tr></thead>
    <tbody>${visible.map((group) => {
      const s = group.sample;
      const label = [s.brand, s.description, s.variant, s.size].filter(Boolean).join(' ');
      const recommendation = group.status === 'CLEAN'
        ? 'No master-data issue detected.'
        : group.archivedOnly
          ? 'Archived record. If the original barcode is received again, Put-away will detect it and Admin/Owner can reactivate the same record.'
          : group.splitBarcodes
            ? 'Physically verify whether these records are one product. If yes, complete one canonical barcode family through SKU Masterlist Edit, then retire unnecessary zero-stock duplicates.'
            : group.duplicateDetails
              ? 'Verify whether these are truly different products/barcode families before keeping multiple master records.'
              : group.crossCategory
                ? 'The same digits are reused in different barcode categories. This is allowed, but warehouse staff should verify the correct CASE/PACK/PIECE field.'
                : 'Review N/A barcode categories. Complete the barcode family through SKU Masterlist Edit if official barcodes are now known.';

      const reviewRow = group.active[0];
      return `<tr>
        <td>${skuHealthPill(group.status)}</td>
        <td class="wrap"><strong>${escapeHtml(s.sku_type || 'STANDARD')}</strong><br>${escapeHtml(label)}</td>
        <td class="wrap">${skuHealthBarcodeCoverage(group)}</td>
        <td class="wrap"><details><summary>${group.active.length} active · ${group.archived.length} archived</summary>${skuHealthRecordDetails(group)}</details></td>
        <td class="wrap">${group.issues.length ? group.issues.map((x) => `<span class="pill near">${escapeHtml(x)}</span>`).join(' ') : '<span class="pill">Clean</span>'}<br><small>${escapeHtml(recommendation)}</small></td>
        <td>${reviewRow ? `<button class="link-btn" type="button" data-sku-health-review="${escapeHtml(reviewRow.sku_id)}">Review in Masterlist</button>` : '<small>Archived only</small>'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>` : emptyState('No SKU groups match the selected health filter.');
}

function reviewSkuHealthInMasterlist(skuId) {
  if (!isAdminOrOwner()) return;
  const row = state.data.skuHealth.find((r) => r.sku_id === skuId);
  if (!row) return toast('SKU health record not found. Refresh the report.', 'error');

  showScreen('skumaster');
  setTimeout(() => {
    const search = $('sku-master-search');
    search.value = skuHealthActual(row.case_barcode) || skuHealthActual(row.pack_barcode) || skuHealthActual(row.piece_barcode) || row.description || '';
    renderSkuMaster();
    search.focus();
  }, 50);
}

async function loadSkuMaster(force = false) {
  if (!isSupervisor()) return;
  if (!force && state.data.skuMaster.length) return renderSkuMaster();
  const { data, error } = await supabase
    .from('v_sku_master')
    .select('*')
    .order('brand')
    .order('description')
    .order('variant')
    .order('size')
    .limit(10000);
  if (error) throw error;
  state.data.skuMaster = data || [];
  renderSkuMaster();
}

function renderSkuMaster() {
  if (!isSupervisor()) return;
  const term = $('sku-master-search').value.trim().toLowerCase();
  const rows = state.data.skuMaster.filter((r) => [
    r.brand, r.description, r.variant, r.size,
    r.case_barcode, r.pack_barcode, r.piece_barcode, r.sku_type,
    r.created_by_username
  ].join(' ').toLowerCase().includes(term));

  const actionHeader = isAdminOrOwner() ? '<th>Admin / Owner action</th>' : '';
  $('sku-master-table').innerHTML = rows.length ? `<table><thead><tr>
    <th>Type</th><th>Brand</th><th>Description</th><th>Variant</th><th>Size</th>
    <th>CASE barcode</th><th>PACK barcode</th><th>PIECE barcode</th>
    <th>Added by</th><th>Date added</th>${actionHeader}
  </tr></thead><tbody>${rows.map((r) => `<tr>
    <td><span class="pill ${r.sku_type === 'SHIPPER' ? 'near' : ''}">${escapeHtml(r.sku_type || 'STANDARD')}</span></td>
    <td>${escapeHtml(r.brand)}</td>
    <td class="wrap">${escapeHtml(r.description)}</td>
    <td>${escapeHtml(r.variant)}</td>
    <td>${escapeHtml(r.size)}</td>
    <td>${escapeHtml(r.case_barcode)}</td>
    <td>${escapeHtml(r.pack_barcode)}</td>
    <td>${escapeHtml(r.piece_barcode)}</td>
    <td>${escapeHtml(r.created_by_username || '—')}</td>
    <td>${fmtDateTime(r.created_at)}</td>
    ${isAdminOrOwner() ? `<td><div class="button-cluster"><button class="link-btn" type="button" data-sku-master-edit="${escapeHtml(r.id)}">Edit</button><button class="danger ghost" type="button" data-sku-master-delete="${escapeHtml(r.id)}">Delete</button></div></td>` : ''}
  </tr>`).join('')}</tbody></table>` : emptyState('No matching SKU master records.');
  $('sku-master-count').textContent = `${rows.length.toLocaleString()} of ${state.data.skuMaster.length.toLocaleString()} SKU record(s) shown`;
}

function openSkuMasterEdit(skuId) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required to edit the SKU Masterlist.', 'error');
  const sku = state.data.skuMaster.find((row) => row.id === skuId);
  if (!sku) return toast('SKU master record was not found. Refresh the SKU Masterlist and try again.', 'error');

  $('sku-master-edit-id').value = sku.id;
  $('sku-master-edit-brand').value = sku.brand || '';
  $('sku-master-edit-description').value = sku.description || '';
  $('sku-master-edit-variant').value = sku.variant || '';
  $('sku-master-edit-size').value = sku.size || '';
  $('sku-master-edit-case').value = sku.case_barcode || 'N/A';
  $('sku-master-edit-pack').value = sku.pack_barcode || 'N/A';
  $('sku-master-edit-piece').value = sku.piece_barcode || 'N/A';
  const isShipperSku = String(sku.sku_type || 'STANDARD').toUpperCase() === 'SHIPPER';
  $('sku-master-edit-pack').readOnly = isShipperSku;
  $('sku-master-edit-piece').readOnly = isShipperSku;
  if (isShipperSku) { $('sku-master-edit-pack').value = 'N/A'; $('sku-master-edit-piece').value = 'N/A'; }
  $('sku-master-edit-reason').value = '';
  $('sku-master-edit-current').innerHTML = `<strong>Editing ${escapeHtml(sku.sku_type || 'STANDARD')} SKU:</strong> ${escapeHtml([sku.brand, sku.description, sku.variant, sku.size].filter(Boolean).join(' '))}${isShipperSku ? '<br><small>Shipper master records use CASE barcode only; PACK and PIECE remain N/A.</small>' : ''}`;
  $('sku-master-edit-dialog').showModal();
}

async function submitSkuMasterEdit(event) {
  event.preventDefault();
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required to edit the SKU Masterlist.', 'error');

  const brand = $('sku-master-edit-brand').value.trim();
  const description = $('sku-master-edit-description').value.trim();
  const variant = $('sku-master-edit-variant').value.trim();
  const size = $('sku-master-edit-size').value.trim();
  const caseBarcode = normalizeBarcode($('sku-master-edit-case').value || 'N/A');
  const packBarcode = normalizeBarcode($('sku-master-edit-pack').value || 'N/A');
  const pieceBarcode = normalizeBarcode($('sku-master-edit-piece').value || 'N/A');
  const reason = $('sku-master-edit-reason').value.trim();

  if (!brand || !description || !variant || !size) return toast('Brand, description, variant, and size are required.', 'error');
  if (!caseBarcode || !packBarcode || !pieceBarcode) return toast('CASE, PACK, and PIECE barcode fields are required. Enter N/A when unavailable.', 'error');
  if ([caseBarcode, packBarcode, pieceBarcode].every((code) => code.toUpperCase() === 'N/A')) {
    return toast('At least one actual barcode must remain registered for the SKU.', 'error');
  }
  if (!reason) return toast('Enter the reason for editing this SKU master record.', 'error');

  const button = event.submitter;
  setBusy(button, true, 'Saving…');
  const { error } = await supabase.rpc('owner_edit_sku_master', {
    p_sku_id: $('sku-master-edit-id').value,
    p_brand: brand,
    p_description: description,
    p_variant: variant,
    p_size: size,
    p_case_barcode: caseBarcode,
    p_pack_barcode: packBarcode,
    p_piece_barcode: pieceBarcode,
    p_reason: reason
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  $('sku-master-edit-dialog').close();
  invalidateReports();
  await loadSkuMaster(true);
  toast('SKU Masterlist record updated. Audit record saved.', 'success');
}


async function deleteSkuMaster(skuId) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required to delete a SKU Masterlist entry.', 'error');
  const sku = state.data.skuMaster.find((row) => row.id === skuId);
  if (!sku) return toast('SKU master record was not found. Refresh the SKU Masterlist and try again.', 'error');

  const label = [sku.brand, sku.description, sku.variant, sku.size].filter(Boolean).join(' ');
  const reason = window.prompt(`Delete this SKU from the active SKU Masterlist?\n\n${label}\n\nThis is allowed only when the SKU has NO current inventory. Historical transaction/audit records will keep the SKU details while those records are retained.\n\nEnter reason:`);
  if (reason === null) return;
  if (!reason.trim()) return toast('A reason is required to delete a SKU Masterlist entry.', 'error');

  if (!window.confirm(`Confirm delete from SKU Masterlist:\n\n${label}\n\nThe SKU will disappear from the active masterlist but historical records are preserved until normal history retention deletes them.`)) return;

  const { error } = await supabase.rpc('admin_delete_sku_master', {
    p_sku_id: skuId,
    p_reason: reason.trim()
  });
  if (error) return toast(friendlyError(error), 'error');

  invalidateReports();
  await loadSkuMaster(true);
  toast('SKU deleted from the active SKU Masterlist. Historical references were preserved.', 'success');
}

async function loadContainers(force = false) {
  if (!force && state.data.containers.length) return renderContainers();
  const { data, error } = await supabase.from('v_container_summary_active').select('*').order('container_no').limit(10000);
  if (error) throw error;
  state.data.containers = data || [];
  renderContainers();
}

function renderContainers() {
  const term = $('container-search').value.trim().toLowerCase();
  const rows = state.data.containers.filter((r) => r.container_no.toLowerCase().includes(term));
  $('container-summary-table').innerHTML = rows.length ? `<table><thead><tr><th>Container</th><th>Remaining / received</th><th>Consumed</th><th>SKUs</th><th>Locations</th><th>Earliest expiry</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td><strong>${escapeHtml(r.container_no)}</strong><br>${r.consumption_status === 'CONSUMED' ? '<span class="pill">Consumed</span>' : '<span class="pill">Active</span>'}</td><td>${formatBalances(balanceColumns(r, 'remaining'))}<br><small>Received: ${formatBalances(balanceColumns(r, 'received'))}</small></td><td>${formatBalances(balanceColumns(r, 'consumed'))}</td><td>${r.sku_count}</td><td class="wrap">${escapeHtml(r.locations || '—')}</td><td>${fmtDate(r.earliest_expiry)} ${r.has_expired ? '<span class="pill expired">Expired stock</span>' : r.has_near_expiry ? '<span class="pill near">Near expiry</span>' : ''}</td>
    <td><div class="button-cluster"><button class="link-btn" data-container-detail="${escapeHtml(r.container_no)}">Details</button>${isAdminOrOwner() && r.consumption_status === 'CONSUMED' ? `<button class="danger ghost" type="button" data-container-delete="${escapeHtml(r.container_no)}">Delete</button>` : ''}</div></td></tr>`).join('')}</tbody></table>` : emptyState('No matching container history.');
}


async function deleteConsumedContainer(containerNo) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required to delete a consumed container.', 'error');
  const row = state.data.containers.find((item) => item.container_no === containerNo);
  if (!row) return toast('Container was not found. Refresh the Containers report and try again.', 'error');
  if (row.consumption_status !== 'CONSUMED') return toast('Only empty/consumed containers can be deleted from the Containers list.', 'error');

  const reason = window.prompt(`Delete consumed container ${containerNo} from the Containers list?\n\nTransaction and audit history will keep the container number while those history records are retained.\n\nEnter reason:`);
  if (reason === null) return;
  if (!reason.trim()) return toast('A reason is required to delete a consumed container.', 'error');

  if (!window.confirm(`Confirm removal of consumed container ${containerNo} from the Containers list?\n\nThis does not erase its retained transaction/audit history.`)) return;

  const { error } = await supabase.rpc('admin_delete_consumed_container', {
    p_container_no: containerNo,
    p_reason: reason.trim()
  });
  if (error) return toast(friendlyError(error), 'error');

  state.data.containers = [];
  $('container-detail').classList.add('hidden');
  await loadContainers(true);
  toast(`Container ${containerNo} removed from the Containers list. Historical references were preserved.`, 'success');
}

async function showContainerDetail(containerNo) {
  const panel = $('container-detail');
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="empty-state">Loading container details…</div>';
  const { data, error } = await supabase.from('v_inventory_details').select('*').eq('container_no', containerNo).order('location_sort_order', { ascending: true, nullsFirst: false }).order('location_code').order('expiry_date');
  if (error) return panel.innerHTML = `<div class="warning-box">${escapeHtml(friendlyError(error))}</div>`;
  panel.innerHTML = `<div class="card-head"><div><h3>Container ${escapeHtml(containerNo)}</h3><p>All remaining contents and locations</p></div></div>${data?.length ? `<table><thead><tr><th>SKU</th><th>Shipper box</th><th>Location</th><th>Expiry</th><th>Quantity</th></tr></thead><tbody>${data.map((r) => `<tr><td class="wrap">${escapeHtml(r.sku_name)}</td><td>${shipperBadge(r)}</td><td>${escapeHtml(r.location_code)}</td><td>${fmtDate(r.expiry_date)}</td><td>${fmtQtyUom(r.qty, r.uom)}</td></tr>`).join('')}</tbody></table>` : emptyState('This container has no remaining stock. It has been fully consumed or never received.')}`;
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
        const pieceQty = Number(r.total_piece_qty || 0);
        const packQty = Number(r.total_pack_qty || 0);
        const caseQty = Number(r.total_case_qty || 0);
        const occupied = pieceQty > 0 || packQty > 0 || caseQty > 0;
        const lowVolumeReasons = [];
        if (caseQty > 0 && caseQty < 20) lowVolumeReasons.push(`${caseQty} CASE < 20`);
        if (packQty > 0 && packQty < 200) lowVolumeReasons.push(`${packQty} PACK < 200`);
        if (pieceQty > 0 && pieceQty < 500) lowVolumeReasons.push(`${pieceQty} PIECE < 500`);
        const lowVolume = occupied && !r.is_pending && !r.is_locked && lowVolumeReasons.length > 0;
        const cls = r.is_pending ? 'pending' : r.is_locked ? 'locked' : lowVolume ? 'low-volume' : occupied ? 'occupied' : '';
        return `<div class="rack-cell ${cls}"><h4>${escapeHtml(r.location_code)}</h4>
          <p>${r.is_locked ? `Locked by ${escapeHtml(r.locked_by)} for ${escapeHtml(r.lock_operation)}` : occupied ? `${r.sku_count} SKU(s) · ${formatBalances({ PIECE: pieceQty, PACK: packQty, CASE: caseQty })}` : 'Empty location'}</p>
          ${lowVolume ? `<p><strong>Low-volume:</strong> ${escapeHtml(lowVolumeReasons.join(' · '))}</p>` : ''}
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

async function loadNonFefoCompliance(force = false) {
  if (!isSupervisor()) return toast('Supervisor access is required.', 'error');
  if (!force && state.data.nonFefo.length) return renderNonFefoCompliance();
  const { data, error } = await supabase
    .from('v_non_fefo_compliance')
    .select('*')
    .order('confirmed_at', { ascending: false })
    .limit(5000);
  if (error) throw error;
  state.data.nonFefo = data || [];
  renderNonFefoCompliance();
}

function renderNonFefoCompliance() {
  const term = $('nonfefo-search').value.trim().toLowerCase();
  const from = $('nonfefo-from').value;
  const to = $('nonfefo-to').value;
  const rows = state.data.nonFefo.filter((r) => {
    const date = localDateKey(r.confirmed_at);
    const dateMatch = (!from || date >= from) && (!to || date <= to);
    const haystack = [
      r.transaction_no, r.sales_order, r.username, r.sku_name, r.uom,
      r.selected_location_code, r.selected_container_no, r.selected_expiry,
      r.recommended_location_code, r.recommended_container_no, r.recommended_expiry,
      r.override_reason, r.shipper_box_no
    ].join(' ').toLowerCase();
    return dateMatch && haystack.includes(term);
  });

  const userCount = new Set(rows.map((r) => r.user_id)).size;
  const txCount = new Set(rows.map((r) => r.transaction_id)).size;
  $('nonfefo-count').textContent = `${rows.length.toLocaleString()} override line(s) · ${txCount.toLocaleString()} transaction(s) · ${userCount.toLocaleString()} user(s)`;
  $('nonfefo-table').innerHTML = rows.length ? `<table><thead><tr>
    <th>Confirmation time</th><th>Transaction / SO</th><th>User</th><th>SKU</th><th>Picked stock</th><th>FEFO stock that was bypassed</th><th>Qty</th><th>Reason</th>
  </tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${fmtDateTime(r.confirmed_at)}</td>
    <td><strong>${escapeHtml(r.transaction_no)}</strong><br><small>SO: ${escapeHtml(r.sales_order || '—')}</small></td>
    <td>${escapeHtml(r.username || '—')}</td>
    <td class="wrap"><strong>${escapeHtml(r.sku_name || '—')}</strong>${r.shipper_box_no ? `<br><small>${escapeHtml(r.shipper_box_no)}</small>` : ''}</td>
    <td class="wrap"><strong>${fmtDate(r.selected_expiry)}</strong><br><small>${escapeHtml(r.selected_location_code || '—')} / ${escapeHtml(r.selected_container_no || '—')}</small></td>
    <td class="wrap"><strong>${fmtDate(r.recommended_expiry)}</strong><br><small>${escapeHtml(r.recommended_location_code || '—')} / ${escapeHtml(r.recommended_container_no || '—')}</small></td>
    <td>${fmtQtyUom(r.qty, r.uom)}</td>
    <td class="wrap">${escapeHtml(r.override_reason || '—')}</td>
  </tr>`).join('')}</tbody></table>` : emptyState('No Non-FEFO compliance records match the current filters.');
}

async function loadUsers(force = false) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required.', 'error');
  if (!force && state.data.users.length) return renderUsers();

  const { data, error } = await supabase.rpc('list_managed_users');
  if (error) throw error;
  state.data.users = data || [];
  renderUsers();
}

function userRoleRank(role) {
  return ({ owner: 4, admin: 3, supervisor: 2, user: 1 })[String(role || '').toLowerCase()] || 0;
}

function userRoleLabel(role) {
  const value = String(role || 'user').toLowerCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderUsers() {
  if (!isAdminOrOwner()) return;
  const term = $('users-search').value.trim().toLowerCase();
  const roleFilter = $('users-role').value;
  const statusFilter = $('users-status').value;

  const visible = state.data.users.filter((row) => {
    if (roleFilter && row.role !== roleFilter) return false;
    if (statusFilter === 'ACTIVE' && !row.is_active) return false;
    if (statusFilter === 'INACTIVE' && row.is_active) return false;
    return [row.username, row.email, row.role, row.is_active ? 'active' : 'kicked out']
      .join(' ').toLowerCase().includes(term);
  }).sort((a, b) => userRoleRank(b.role) - userRoleRank(a.role)
    || String(a.username).localeCompare(String(b.username)));

  const all = state.data.users;
  const active = all.filter((row) => row.is_active).length;
  const inactive = all.length - active;
  const roleCounts = ['owner','admin','supervisor','user']
    .map((role) => [role, all.filter((row) => row.role === role).length])
    .filter(([, count]) => count > 0)
    .map(([role, count]) => `${userRoleLabel(role)} ${count}`)
    .join(' · ') || 'No users';

  $('users-kpis').innerHTML = [
    ['Visible registered users', all.length],
    ['Active', active],
    ['Kicked out', inactive],
    ['Role mix', roleCounts]
  ].map(([label, value]) => `<div class="kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  $('users-count').textContent = `${visible.length} shown of ${all.length} visible account(s)`;
  $('users-table').innerHTML = visible.length ? `<table><thead><tr>
    <th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Registered</th><th>Last sign-in</th><th>Actions</th>
  </tr></thead><tbody>${visible.map((row) => {
    const rolePill = `<span class="pill${row.role === 'owner' ? ' near' : ''}">${escapeHtml(userRoleLabel(row.role))}</span>`;
    const status = row.is_active ? '<span class="pill">Active</span>' : '<span class="pill expired">Kicked out</span>';
    let actions = '<small>Read only</small>';
    if (row.is_self) actions = '<small>Current account</small>';
    else if (row.can_manage) actions = `<div class="button-cluster">
      <button type="button" class="link-btn" data-user-role="${escapeHtml(row.user_id)}">Change role</button>
      <button type="button" class="link-btn" data-user-active="${escapeHtml(row.user_id)}">${row.is_active ? 'Kick out' : 'Reactivate'}</button>
    </div>`;
    return `<tr>
      <td><strong>${escapeHtml(row.username)}</strong>${row.is_self ? '<br><small>You</small>' : ''}</td>
      <td class="wrap">${escapeHtml(row.email || '—')}</td>
      <td>${rolePill}</td>
      <td>${status}</td>
      <td>${fmtDateTime(row.registered_at)}</td>
      <td>${fmtDateTime(row.last_sign_in_at)}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('')}</tbody></table>` : emptyState('No registered users match the current filters.');
}

function openUserRoleDialog(userId) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required.', 'error');
  const row = state.data.users.find((user) => user.user_id === userId);
  if (!row) return toast('User account not found. Refresh User Management and try again.', 'error');
  if (row.is_self || !row.can_manage) return toast('This account cannot be changed by your current role.', 'error');

  $('user-role-target-id').value = row.user_id;
  $('user-role-current-role').value = row.role;
  $('user-role-target-info').innerHTML = `<strong>${escapeHtml(row.username)}</strong> · ${escapeHtml(row.email || '—')}<br>Current role: <strong>${escapeHtml(userRoleLabel(row.role))}</strong> · Status: <strong>${row.is_active ? 'Active' : 'Kicked out'}</strong>`;

  const allowedRoles = isOwner()
    ? ['user','supervisor','admin','owner']
    : ['user','supervisor','admin'];
  const currentAllowed = allowedRoles.includes(row.role);
  $('user-role-select').innerHTML = `${currentAllowed ? '' : '<option value="" selected disabled>Choose demotion role</option>'}${allowedRoles.map((role) =>
    `<option value="${role}" ${row.role === role ? 'selected' : ''}>${escapeHtml(userRoleLabel(role))}</option>`
  ).join('')}`;
  $('user-owner-password').value = '';
  syncOwnerPromotionPasswordField();
  $('user-role-dialog').showModal();
}

function syncOwnerPromotionPasswordField() {
  const currentRole = $('user-role-current-role').value;
  const newRole = $('user-role-select').value;
  const required = isOwner() && newRole === 'owner' && currentRole !== 'owner';
  $('user-owner-password-wrap').classList.toggle('hidden', !required);
  $('user-owner-password').required = required;
  if (!required) $('user-owner-password').value = '';
}

async function submitUserRoleChange(event) {
  event.preventDefault();
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required.', 'error');

  const targetId = $('user-role-target-id').value;
  const row = state.data.users.find((user) => user.user_id === targetId);
  if (!row) return toast('User account not found. Refresh and try again.', 'error');
  const newRole = $('user-role-select').value;
  const ownerPassword = $('user-owner-password').value;
  if (!newRole) return toast('Choose the new role first.', 'error');

  if (newRole === row.role) {
    $('user-role-dialog').close();
    return toast('No role change was needed.');
  }

  if (isOwner() && newRole === 'owner' && row.role !== 'owner' && !ownerPassword) {
    return toast('Enter the Owner-promotion password.', 'error');
  }

  if (!window.confirm(`Change ${row.username} from ${userRoleLabel(row.role)} to ${userRoleLabel(newRole)}?`)) return;

  const button = event.submitter;
  setBusy(button, true, 'Saving…');
  const { error } = await supabase.rpc('set_managed_user_role', {
    p_target_user_id: targetId,
    p_new_role: newRole,
    p_owner_password: ownerPassword || null
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  $('user-role-dialog').close();
  $('user-owner-password').value = '';
  state.data.users = [];
  state.data.audit = [];
  await loadUsers(true);
  toast(`${row.username} is now ${userRoleLabel(newRole)}.`, 'success');
}

async function toggleManagedUserActive(userId) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required.', 'error');
  const row = state.data.users.find((user) => user.user_id === userId);
  if (!row) return toast('User account not found. Refresh User Management and try again.', 'error');
  if (row.is_self || !row.can_manage) return toast('This account cannot be changed by your current role.', 'error');

  const nextActive = !row.is_active;
  const action = nextActive ? 'reactivate' : 'kick out';
  const message = nextActive
    ? `Reactivate ${row.username}? They will be able to sign in and use the system again.`
    : `Kick out ${row.username}? Their transaction history will be preserved. Active rack locks will be released. Empty open Sales Orders will be released, while partially picked open Sales Orders will be reassigned to you.`;
  if (!window.confirm(message)) return;

  const { data, error } = await supabase.rpc('set_managed_user_active', {
    p_target_user_id: userId,
    p_is_active: nextActive
  });
  if (error) return toast(friendlyError(error), 'error');

  state.data.users = [];
  state.data.audit = [];
  await loadUsers(true);

  const result = data?.[0] || {};
  if (nextActive) {
    toast(`${row.username} has been reactivated.`, 'success');
  } else {
    const details = [];
    if (Number(result.released_lock_count || 0)) details.push(`${result.released_lock_count} rack lock(s) released`);
    if (Number(result.released_empty_order_count || 0)) details.push(`${result.released_empty_order_count} empty SO(s) released`);
    if (Number(result.reassigned_open_order_count || 0)) details.push(`${result.reassigned_open_order_count} partial SO(s) reassigned to you`);
    toast(`${row.username} has been kicked out${details.length ? ` · ${details.join(' · ')}` : ''}.`, 'success');
  }
}


function fmtBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toLocaleString(undefined, { maximumFractionDigits: index >= 2 ? 2 : 0 })} ${units[index]}`;
}

function usagePercent(value, limit) {
  const n = Number(value || 0);
  const max = Number(limit || 0);
  if (!max) return 0;
  return Math.max(0, Math.min(100, (n / max) * 100));
}

function usageRow(label, valueText, limitText, percent, note = '') {
  const safePercent = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : 0;
  return `<div class="card" style="padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(valueText)} / ${escapeHtml(limitText)}</span>
    </div>
    <progress max="100" value="${safePercent}" style="width:100%;margin-top:10px"></progress>
    ${note ? `<p class="small-note" style="margin-bottom:0">${escapeHtml(note)}</p>` : ''}
  </div>`;
}

async function loadSystemManager(force = false) {
  if (!isAdminOrOwner()) return;
  const button = $('system-manager-refresh-btn');
  if (force) setBusy(button, true, 'Refreshing…');

  const { data, error } = await supabase.rpc('system_manager_usage_snapshot');
  if (force) setBusy(button, false);
  if (error) throw error;

  const row = data?.[0] || {};
  const databaseBytes = Number(row.database_bytes || 0);
  const storageBytes = Number(row.storage_bytes || 0);
  const databaseLimit = Number(row.database_limit_bytes || (500 * 1024 * 1024));
  const storageLimit = Number(row.storage_limit_bytes || (1024 ** 3));
  const mauLimit = Number(row.mau_limit || 50000);

  $('system-manager-usage-grid').innerHTML = [
    usageRow(
      'Egress',
      'Supabase Usage page',
      '5 GB',
      0,
      'Exact billing-cycle Egress is platform analytics and is not safely exposed to this browser-only WMS.'
    ),
    usageRow(
      'Database size',
      fmtBytes(databaseBytes),
      '500 MB',
      usagePercent(databaseBytes, databaseLimit),
      'Exact current PostgreSQL database size when this module was loaded.'
    ),
    usageRow(
      'Monthly active users',
      `${Number(row.signed_in_last_30_days || 0).toLocaleString()} local indicator`,
      mauLimit.toLocaleString(),
      usagePercent(Number(row.signed_in_last_30_days || 0), mauLimit),
      `Supabase billing MAU must be checked on Usage. Registered Auth users: ${Number(row.registered_users || 0).toLocaleString()}.`
    ),
    usageRow(
      'File storage',
      fmtBytes(storageBytes),
      '1 GB',
      usagePercent(storageBytes, storageLimit),
      'Exact current size recorded for objects in Supabase Storage.'
    )
  ].join('');

  $('system-manager-checked-at').textContent = `Checked: ${fmtDateTime(row.checked_at)} · Values refresh whenever System Manager is opened or Refresh usage is pressed.`;
  $('system-manager-retention-status').innerHTML = `
    <strong>Automatic retention:</strong> ${row.retention_job_active ? 'Enabled' : 'Not active'} · ${Number(row.retention_days || 90)} days<br>
    <strong>Transaction history rows:</strong> ${Number(row.transaction_history_count || 0).toLocaleString()} · Oldest: ${escapeHtml(fmtDateTime(row.oldest_transaction_at))}<br>
    <strong>System audit rows:</strong> ${Number(row.audit_history_count || 0).toLocaleString()} · Oldest: ${escapeHtml(fmtDateTime(row.oldest_audit_at))}<br>
    <small>Automatic cleanup runs daily. History belonging to an OPEN Sales Order is protected until that Sales Order is closed.</small>`;
}

async function getSystemHistoryPreview() {
  if (!isAdminOrOwner()) throw new Error('Admin or Owner access is required.');
  const start = $('system-history-start').value;
  const end = $('system-history-end').value;
  if (!start || !end) throw new Error('Select both a start date and an end date.');
  if (end < start) throw new Error('End date cannot be earlier than start date.');

  const { data, error } = await supabase.rpc('admin_preview_history_delete', {
    p_start_date: start,
    p_end_date: end
  });
  if (error) throw error;
  return data?.[0] || {};
}

async function previewSystemHistoryDelete() {
  const button = $('system-history-preview-btn');
  setBusy(button, true, 'Checking…');
  try {
    const row = await getSystemHistoryPreview();
    $('system-history-preview').classList.remove('hidden');
    $('system-history-preview').innerHTML = `<strong>Selected inclusive date range:</strong> ${escapeHtml($('system-history-start').value)} to ${escapeHtml($('system-history-end').value)}<br>
      Transactions: <strong>${Number(row.transaction_count || 0).toLocaleString()}</strong> ·
      Transaction lines: <strong>${Number(row.transaction_line_count || 0).toLocaleString()}</strong> ·
      System audit events: <strong>${Number(row.audit_event_count || 0).toLocaleString()}</strong> ·
      Non-FEFO detail rows: <strong>${Number(row.non_fefo_event_count || 0).toLocaleString()}</strong>`;
  } catch (error) {
    toast(friendlyError(error), 'error');
  } finally {
    setBusy(button, false);
  }
}

async function deleteSystemHistoryRange(event) {
  event.preventDefault();
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required.', 'error');

  const start = $('system-history-start').value;
  const end = $('system-history-end').value;
  const reason = $('system-history-reason').value.trim();
  if (!start || !end) return toast('Select both a start date and an end date.', 'error');
  if (end < start) return toast('End date cannot be earlier than start date.', 'error');
  if (!reason) return toast('Enter a reason for deleting the selected history.', 'error');

  let preview;
  try {
    preview = await getSystemHistoryPreview();
  } catch (error) {
    return toast(friendlyError(error), 'error');
  }

  const summary = `${Number(preview.transaction_count || 0).toLocaleString()} transaction(s), ${Number(preview.transaction_line_count || 0).toLocaleString()} transaction line(s), ${Number(preview.audit_event_count || 0).toLocaleString()} audit event(s), and ${Number(preview.non_fefo_event_count || 0).toLocaleString()} Non-FEFO detail row(s)`;

  if (!window.confirm(`PERMANENT HISTORY DELETE\n\nInclusive dates: ${start} through ${end}\n\nThis will delete ${summary}.\n\nCurrent inventory balances are not deleted. An audit event recording this administrative deletion will be created after the purge.\n\nContinue?`)) return;

  const button = event.submitter;
  setBusy(button, true, 'Deleting…');
  const { data, error } = await supabase.rpc('admin_delete_history_range', {
    p_start_date: start,
    p_end_date: end,
    p_reason: reason
  });
  setBusy(button, false);

  if (error) return toast(friendlyError(error), 'error');

  const result = data?.[0] || {};
  state.data.history = [];
  state.data.audit = [];
  state.data.nonFefo = [];
  // Container received/consumed figures are partly derived from retained history.
  state.data.containers = [];
  $('system-history-preview').classList.remove('hidden');
  $('system-history-preview').innerHTML = `<strong>Deletion complete.</strong><br>
    Deleted ${Number(result.deleted_transactions || 0).toLocaleString()} transaction(s),
    ${Number(result.deleted_transaction_lines || 0).toLocaleString()} transaction line(s),
    ${Number(result.deleted_audit_events || 0).toLocaleString()} audit event(s), and
    ${Number(result.deleted_non_fefo_events || 0).toLocaleString()} Non-FEFO detail row(s).`;
  $('system-history-reason').value = '';
  await loadSystemManager(true);
  toast('Selected transaction and audit history permanently deleted.', 'success');
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
    const haystack = [r.tx_no, r.created_by_username, r.sales_order, r.sku_name, r.container_no, r.location_code, r.transaction_note, r.override_reason, r.edit_reason, r.line_note, r.shipper_box_no, r.shipper_status, r.shipper_action].join(' ').toLowerCase();
    return (!type || r.transaction_type === type) && haystack.includes(term);
  });
  const firstLineByTx = new Set();
  $('history-table').innerHTML = rows.length ? `<table><thead><tr><th>Transaction</th><th>Action</th><th>User / time</th><th>SO</th><th>Location</th><th>SKU / container</th><th>Qty</th><th>Remarks</th><th>Flags</th><th></th></tr></thead><tbody>${rows.map((r) => {
    const first = !firstLineByTx.has(r.transaction_id); firstLineByTx.add(r.transaction_id);
    const flags = [
      r.fefo_overridden ? '<span class="pill override">FEFO override</span>' : '',
      r.barcode_bypassed ? '<span class="pill override">Supervisor barcode bypass</span>' : '',
      r.edited_at ? '<span class="pill">Corrected</span>' : ''
    ].filter(Boolean).join(' ');
    return `<tr><td><strong>${escapeHtml(r.tx_no)}</strong></td><td>${escapeHtml(r.transaction_type)}</td>
      <td>${escapeHtml(r.created_by_username)}<br><small>${fmtDateTime(r.created_at)}</small></td><td>${escapeHtml(r.sales_order || '—')}</td><td>${escapeHtml(r.location_code || '—')}</td>
      <td class="wrap">${escapeHtml(r.sku_name || 'System action')}<br><small>${escapeHtml(r.container_no || '')} ${r.expiry_date ? `· ${fmtDate(r.expiry_date)}` : ''}${r.shipper_box_no ? ` · ${escapeHtml(r.shipper_box_no)}` : ''}</small>${r.line_note ? `<br><small>${escapeHtml(r.line_note)}</small>` : ''}</td>
      <td>${r.signed_qty == null ? '—' : fmtQtyUom(r.signed_qty, r.uom)}</td><td class="wrap">${first ? escapeHtml(r.transaction_note || '—') : '—'}</td><td class="wrap">${flags}${r.shipper_action ? `<br><span class="pill near">${escapeHtml(r.shipper_action)}</span>` : ''}${r.barcode_bypassed ? `<br><small>Bypass by ${escapeHtml(r.bypassed_by_username || r.created_by_username)}: ${escapeHtml(r.bypass_reason || '')}</small>` : ''}${first && r.override_reason ? `<br><small>${escapeHtml(r.override_reason)}</small>` : ''}${first && r.edit_reason ? `<br><small>Edit: ${escapeHtml(r.edit_reason)}</small>` : ''}</td>
      <td>${first && isAdminOrOwner() && ['PUTAWAY','PICK','TRANSFER'].includes(r.transaction_type) && !rows.some((x) => x.transaction_id === r.transaction_id && x.shipper_box_id) ? `<button class="link-btn" data-edit-transaction="${r.transaction_id}">Correct</button>` : (first && r.shipper_box_id ? '<small>Shipper transaction protected</small>' : '')}</td></tr>`;
  }).join('')}</tbody></table>` : emptyState('No matching history.');
}

function auditEventRemarks(row) {
  const after = row?.after_data || {};
  const directNote = typeof after?.note === 'string' ? after.note : '';
  const nestedNote = typeof after?.transaction?.note === 'string' ? after.transaction.note : '';
  if (nestedNote.trim()) return nestedNote.trim();
  if (directNote.trim()) return directNote.trim();

  // Shipper Box put-away stores the entered Put-away remarks in the audit reason.
  if (String(row?.action || '').toUpperCase() === 'SHIPPER_BOX_PUTAWAY' && String(row?.reason || '').trim()) {
    return String(row.reason).trim();
  }
  return '';
}

function renderAuditHistory() {
  const rows = state.data.audit;
  $('audit-history-table').innerHTML = rows.length ? `<table><thead><tr><th>Time</th><th>Action</th><th>User</th><th>Entity</th><th>Remarks</th><th>Reason</th><th>Stored details</th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${fmtDateTime(r.created_at)}</td><td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.username || '—')}</td><td>${escapeHtml(r.entity_type)} ${escapeHtml(r.entity_id || '')}</td><td class="wrap">${escapeHtml(auditEventRemarks(r) || '—')}</td><td class="wrap">${escapeHtml(r.reason || '—')}</td>
    <td class="wrap"><details><summary>View JSON</summary><pre>${escapeHtml(JSON.stringify({ before: r.before_data, after: r.after_data }, null, 2))}</pre></details></td></tr>`).join('')}</tbody></table>` : emptyState('No audit events yet.');
}

async function openSupervisorEdit(transactionId) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required.', 'error');
  const { data, error } = await supabase.from('v_history_details').select('*').eq('transaction_id', transactionId).order('line_no');
  if (error) return toast(friendlyError(error), 'error');
  const rows = data || [];
  if (!rows.length) return;
  if (rows.some((r) => r.shipper_box_id)) return toast('Shipper Box transactions are protected from the generic correction screen so the physical-box status and contents cannot become inconsistent.', 'error');
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
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required.', 'error');
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


async function openFullResetDialog() {
  if (!isOwner()) return toast('Owner access is required.', 'error');

  const button = $('full-reset-open-btn');
  setBusy(button, true, 'Loading preview…');
  try {
    const { data, error } = await supabase.rpc('owner_full_reset_preview');
    if (error) throw error;
    const row = data?.[0] || {};

    $('full-reset-preview').innerHTML = `
      <strong>LIVE RESET PREVIEW</strong><br>
      Owner accounts preserved: <strong>${Number(row.owner_accounts || 0).toLocaleString()}</strong><br>
      Non-Owner Auth users removed: <strong>${Number(row.non_owner_auth_users || 0).toLocaleString()}</strong><br>
      SKU records removed: <strong>${Number(row.sku_records || 0).toLocaleString()}</strong><br>
      Stock lots removed: <strong>${Number(row.stock_lots || 0).toLocaleString()}</strong><br>
      Shipper boxes removed: <strong>${Number(row.shipper_boxes || 0).toLocaleString()}</strong><br>
      Transactions removed: <strong>${Number(row.transactions || 0).toLocaleString()}</strong><br>
      Transaction lines removed: <strong>${Number(row.transaction_lines || 0).toLocaleString()}</strong><br>
      System audit events removed: <strong>${Number(row.audit_events || 0).toLocaleString()}</strong><br>
      Non-FEFO detail rows removed: <strong>${Number(row.non_fefo_events || 0).toLocaleString()}</strong><br>
      Sales Orders removed: <strong>${Number(row.sales_orders || 0).toLocaleString()}</strong><br>
      Current location locks removed: <strong>${Number(row.active_location_locks || 0).toLocaleString()}</strong><br>
      Hidden/removed container records cleared: <strong>${Number(row.hidden_containers || 0).toLocaleString()}</strong>`;

    $('full-reset-pin').value = '';
    $('full-reset-understand').checked = false;
    $('full-reset-dialog').showModal();
    setTimeout(() => $('full-reset-pin').focus(), 50);
  } catch (error) {
    toast(friendlyError(error), 'error');
  } finally {
    setBusy(button, false);
  }
}

function clearClientAfterFullReset() {
  stopHeartbeat(state.pick);
  stopHeartbeat(state.transfer);

  state.putaway = { locationCode: null, cart: [], matchedSkuId: null, duplicateDetailsSkuId: null, lookupSequence: 0 };
  state.shipperPutaway = freshShipperPutawayState();
  state.pick = freshOperationState();
  state.transfer = freshOperationState();
  state.pickOrder = { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false };
  state.pickOrderLookupSequence = 0;
  state.pickOrderSummary = [];
  state.selectedQrLocations.clear();
  Object.keys(state.data).forEach((key) => { state.data[key] = []; });
}

async function submitFullReset(event) {
  event.preventDefault();
  if (!isOwner()) return toast('Owner access is required.', 'error');

  const pin = $('full-reset-pin').value;
  if (!pin) return toast('Enter the Full Reset confirmation PIN.', 'error');
  if (!$('full-reset-understand').checked) {
    return toast('Confirm that you understand the Full Reset is permanent.', 'error');
  }

  const finalConfirm = window.confirm(
    'FINAL CONFIRMATION\n\n' +
    'This will permanently clear the WMS SKU Masterlist, current inventory, containers, Shipper data, Sales Orders, ' +
    'Transaction History, System Audit Events, other operational reports, and every non-Owner user account.\n\n' +
    'Owner accounts, rack locations, system configuration, and database structure will remain.\n\n' +
    'Continue with FULL RESET?'
  );
  if (!finalConfirm) return;

  const button = $('full-reset-confirm-btn');
  setBusy(button, true, 'Resetting…');

  try {
    const { data, error } = await supabase.rpc('owner_full_reset_wms', {
      p_confirmation_pin: pin
    });
    if (error) throw error;

    const row = data?.[0] || {};
    if (row.result_status === 'INVALID_PIN') {
      $('full-reset-pin').value = '';
      return toast('Invalid Full Reset confirmation PIN. Nothing was reset.', 'error');
    }
    if (row.result_status === 'LOCKED_OUT') {
      $('full-reset-pin').value = '';
      return toast('Too many failed Full Reset PIN attempts. Try again after 10 minutes.', 'error');
    }
    if (row.result_status !== 'RESET_COMPLETE') {
      throw new Error(`Unexpected reset result: ${row.result_status || 'unknown'}`);
    }

    clearClientAfterFullReset();
    applyMode('ADMINISTRATIVE_PAUSE');
    $('full-reset-dialog').close();

    $('full-reset-result').innerHTML = `
      <strong>FULL WMS DATA RESET COMPLETED.</strong><br>
      Owner accounts preserved: ${Number(row.owner_accounts_preserved || 0).toLocaleString()}<br>
      Non-Owner users deleted: ${Number(row.non_owner_users_deleted || 0).toLocaleString()}<br>
      SKUs deleted: ${Number(row.skus_deleted || 0).toLocaleString()} ·
      Stock lots deleted: ${Number(row.stock_lots_deleted || 0).toLocaleString()} ·
      Shipper boxes deleted: ${Number(row.shipper_boxes_deleted || 0).toLocaleString()}<br>
      Transactions deleted: ${Number(row.transactions_deleted || 0).toLocaleString()} ·
      Transaction lines deleted: ${Number(row.transaction_lines_deleted || 0).toLocaleString()} ·
      Audit events deleted: ${Number(row.audit_events_deleted || 0).toLocaleString()}<br>
      Sales Orders deleted: ${Number(row.sales_orders_deleted || 0).toLocaleString()} ·
      Rack locks deleted: ${Number(row.location_locks_deleted || 0).toLocaleString()}<br>
      <strong>System remains in Administrative Pause.</strong> Inspect the blank system before Operational Resume.`;
    $('full-reset-result').classList.remove('hidden');

    toast('Full WMS data reset completed. Owner accounts and rack/system structure were preserved.', 'success');
  } catch (error) {
    toast(`Full Reset failed. No partial reset should be committed: ${friendlyError(error)}`, 'error');
  } finally {
    $('full-reset-pin').value = '';
    setBusy(button, false);
  }
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
  if (name === 'skumaster') rows = state.data.skuMaster;
  if (name === 'skuhealth') rows = state.data.skuHealth;
  if (name === 'containers') rows = state.data.containers;
  if (name === 'expiry') rows = state.data.expiry;
  if (name === 'nonfefo') rows = state.data.nonFefo;
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
  const text = isNoExpiryDate(value) ? 'N/A' : value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

renderPutawayCart();
renderShipperContents();
renderOperationCart('pick');
renderOperationCart('transfer');
clearPickBarcodeMatch();
renderPickSalesOrderSummary();
init();
