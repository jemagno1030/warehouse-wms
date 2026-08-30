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

function buildFefoOverrideConfirmMessage(lot, recommendation = null) {
  const selectedRack = lot?.location_code || state.pick?.locationCode || '—';
  const recommendedExpiry = recommendation?.earliestExpiry || lot?.earliestExpiry || null;
  const recommendedRack = recommendation?.earliestLocation || lot?.earliestLocation || '—';
  const recommendedContainer = recommendation?.earliestContainer || lot?.earliestContainer || '—';

  return [
    'FEFO WARNING',
    '',
    'You selected stock with a later expiry date.',
    '',
    'SELECTED STOCK',
    `SKU: ${lot?.sku_name || '—'}`,
    `Expiry: ${fmtDate(lot?.expiry_date)}`,
    `Rack: ${selectedRack}`,
    `Container: ${lot?.container_no || '—'}`,
    '',
    'FEFO RECOMMENDED STOCK',
    `Expiry: ${fmtDate(recommendedExpiry)}`,
    `Rack: ${recommendedRack}`,
    `Container: ${recommendedContainer}`,
    '',
    'FEFO recommends picking the earlier-expiring stock first.',
    '',
    'Are you sure you want to disregard FEFO? This action is being monitored.'
  ].join('\n');
}
const localDateKey = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const normalizeLocation = (value) => String(value || '').trim().replace(/^LOC:/i, '').toUpperCase();
const normalizeBarcode = (value) => String(value || '').trim().toUpperCase() === 'N/A' ? 'N/A' : String(value || '').trim();
const PICK_CONTAINER_SEQUENCE_RE = /^(\d{4})-(\d{2,3})$/;

function parsePickContainerSequence(value) {
  const text = String(value || '').trim();
  const match = text.match(PICK_CONTAINER_SEQUENCE_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const batch = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(batch)) return null;
  return {
    text,
    year,
    batch,
    // 1000 leaves room for a three-digit batch while preserving year priority.
    key: (year * 1000) + batch
  };
}

function pickExpiryKey(value) {
  return String(value || '').slice(0, 10);
}

function pickPriorityRecommendation(lot, rows, queuedByLot = new Map()) {
  if (!lot) return {
    earliestExpiry: null,
    earliestLocation: null,
    earliestContainer: null,
    containerSuggested: false,
    suggestedContainer: null,
    suggestedLocation: null
  };

  const selectedSku = lot.sku_id || null;
  const selectedUom = String(lot.uom || '').toUpperCase();

  const effectiveRows = (rows || []).filter((row) => {
    if (selectedSku && row.sku_id && row.sku_id !== selectedSku) return false;
    if (selectedUom && row.uom && String(row.uom).toUpperCase() !== selectedUom) return false;
    return Number(row.qty || 0) - Number(queuedByLot.get(row.lot_id) || 0) > 0;
  });

  if (!effectiveRows.length) {
    return {
      earliestExpiry: lot.expiry_date || null,
      earliestLocation: lot.location_code || null,
      earliestContainer: lot.container_no || null,
      containerSuggested: false,
      suggestedContainer: null,
      suggestedLocation: null
    };
  }

  // Priority 1: FEFO. We never let a container number outrank an earlier expiry.
  const earliestExpiry = effectiveRows
    .map((row) => pickExpiryKey(row.expiry_date))
    .filter(Boolean)
    .sort()[0] || pickExpiryKey(lot.expiry_date);

  const earliestExpiryRows = effectiveRows.filter(
    (row) => pickExpiryKey(row.expiry_date) === earliestExpiry
  );

  // Priority 2: only among rows tied on the best expiry, compare valid
  // YYYY-BB / YYYY-BBB containers numerically by year then batch.
  const sequencedRows = earliestExpiryRows
    .map((row) => ({ row, parsed: parsePickContainerSequence(row.container_no) }))
    .filter((entry) => entry.parsed)
    .sort((a, b) => a.parsed.key - b.parsed.key || String(a.row.location_code || '').localeCompare(String(b.row.location_code || '')));

  const suggestedEntry = sequencedRows[0] || null;
  const representativeRow = suggestedEntry?.row || earliestExpiryRows[0] || effectiveRows[0] || null;

  const selectedExpiry = pickExpiryKey(lot.expiry_date);
  const selectedContainer = parsePickContainerSequence(lot.container_no);
  const containerSuggested = Boolean(
    selectedExpiry &&
    earliestExpiry &&
    selectedExpiry === earliestExpiry &&
    selectedContainer &&
    suggestedEntry &&
    selectedContainer.key > suggestedEntry.parsed.key
  );

  return {
    earliestExpiry: earliestExpiry || lot.expiry_date || null,
    earliestLocation: representativeRow?.location_code || lot.location_code || null,
    earliestContainer: representativeRow?.container_no || lot.container_no || null,
    containerSuggested,
    suggestedContainer: containerSuggested ? suggestedEntry.parsed.text : null,
    suggestedLocation: containerSuggested ? (suggestedEntry.row.location_code || null) : null
  };
}


function pickContainerPriorityConfirmation(lot, priority) {
  const visibleSo = $('pick-so')?.value?.trim() || '';
  const suggestedContainer = priority?.suggestedContainer || lot?.suggestedContainer || null;
  const suggestedLocation = priority?.suggestedLocation || lot?.suggestedContainerLocation || null;
  const containerSuggested = Boolean(priority?.containerSuggested ?? lot?.containerPrioritySuggested);

  // SO 0 is Warehouse Stock Adjustment, not customer-order Picking.
  // Preserve its existing behavior and do not create container-priority audit events.
  if (isStockAdjustmentSalesOrder(visibleSo) || !containerSuggested || !suggestedContainer) {
    return { required: false, confirmed: false };
  }

  const selectedContainer = String(lot?.container_no || '').trim() || '—';
  const selectedLocation = state.pick.locationCode || lot?.location_code || 'current rack';
  const locationText = suggestedLocation ? ` at rack ${suggestedLocation}` : '';

  const confirmed = window.confirm(
    `CONTAINER PRIORITY OVERRIDE\n\n` +
    `Earlier shipment container ${suggestedContainer}${locationText} is still eligible for this SKU/UOM at the same FEFO expiry.\n\n` +
    `You selected later container ${selectedContainer} at rack ${selectedLocation}.\n\n` +
    `Continue with the later container?\n\n` +
    `If you click OK and the Pick is successfully saved, this override will be recorded in System Audit.`
  );

  return { required: true, confirmed };
}

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

function freshPutawayState() {
  return {
    locationCode: null,
    cart: [],
    matchedSkuId: null,
    duplicateDetailsSkuId: null,
    lookupSequence: 0,
    barcodeLessMode: null,
    barcodeLessSkuId: null,
    barcodeLessSkus: [],
    barcodeLessLoaded: false
  };
}

let stockCardSuggestionTimer = null;
let stockCardSuggestionRequest = 0;

const state = {
  session: null,
  profile: null,
  mode: 'ACTIVE',
  currentScreen: 'dashboard',
  realtimeChannel: null,
  scanner: { reader: null, controls: null, target: null, kind: null },
  putaway: freshPutawayState(),
  shipperPutaway: freshShipperPutawayState(),
  pick: freshOperationState(),
  pickOrder: { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false },
  pickOrderLookupSequence: 0,
  pickOrderSummary: [],
  pickOrderCorrections: [],
  pickRequestedCorrectionCount: 0,
  pickPendingReturnCount: 0,
  pickBlockingPendingReturnCount: 0,
  dashboardPendingPickReturns: [],
  transfer: freshOperationState(),
  pickRevertStatusByLine: new Map(),
  pickRevertStatusLoaded: false,
  data: { inventory: [], physicalCount: [], physicalCountRaw: [], physicalCountFiltered: [], physicalCountDetailedShipperFiltered: [], stockCard: [], stockCardExport: [], skuMaster: [], skuHealth: [], containers: [], expiry: [], nonFefo: [], users: [], history: [], audit: [], auditFiltered: [], locations: [], rackMap: [] },
  stockCardMeta: null,
  stockCardCandidates: [],
  selectedQrLocations: new Set(),
  accountAccessTimer: null,
  warehouseApproval: null,
  containerReport: { containerNo: null, rows: [], mode: 'rack' }
};

function freshOperationState() {
  return { lockToken: null, locationCode: null, heartbeat: null, cart: [], lots: [], rackLots: [], sku: null, naMode: false, adjustmentSessionKey: null, bulkTransactionRemark: null };
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
    duplicateContentSkuId: null,
    pendingBatchPayload: null
  };
}

const screenMeta = {
  dashboard: ['Dashboard', 'Live warehouse overview'],
  putaway: ['Put-away', 'Receive pallet contents into a rack location'],
  picking: ['Picking', 'FEFO-guided picking by source location'],
  transfer: ['Stock transfer', 'Move stock lots between rack locations'],
  inventory: ['Inventory', 'Stock by SKU, container, expiry, and location'],
  physicalcount: ['Physical Count', 'Printable read-only system stock sheet for manual warehouse verification'],
  stockcard: ['SKU Balance Stock Card', 'Read-only SKU movement ledger, rack movements, and running balances'],
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

const VIEWER_SCREENS = new Set(['dashboard','inventory','physicalcount','stockcard','containers','rackmap','expiry']);

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

function isViewer() {
  return state.profile?.role === 'viewer';
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
  $('refresh-btn').addEventListener('click', refreshCurrentScreen);

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
  $('pa-barcode-less-search').addEventListener('input', renderBarcodeLessSkuOptions);
  $('pa-barcode-less-select').addEventListener('change', selectBarcodeLessPutawaySku);
  $('pa-barcode-less-new-btn').addEventListener('click', startNewBarcodeLessPutawaySku);
  ['pa-brand', 'pa-description', 'pa-variant', 'pa-size'].forEach((id) => $(id).addEventListener('input', () => {
    clearTimeout(putawayDetailsTimer);
    putawayDetailsTimer = setTimeout(checkPutawayDuplicateDetails, 350);
    if (id === 'pa-brand' || id === 'pa-description') syncPutawayCompleteGuard();
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
  $('shipper-batch-approval-close').addEventListener('click', closeShipperBatchApprovalDialog);
  $('shipper-batch-approval-form').addEventListener('submit', submitShipperBatchApproval);
  $('shipper-batch-approval-dialog').addEventListener('close', () => {
    $('shipper-batch-approver-password').value = '';
    state.shipperPutaway.pendingBatchPayload = null;
  });
  $('warehouse-approval-close').addEventListener('click', cancelWarehouseApproval);
  $('warehouse-approval-form').addEventListener('submit', submitWarehouseApproval);
  $('warehouse-approval-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    cancelWarehouseApproval();
  });

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
  $('pick-so-reopen-request-btn').addEventListener('click', requestReopenCompletedSalesOrder);
  $('pick-barcode').addEventListener('input', () => syncOperationCompleteGuard('pick'));
  $('pick-barcode').addEventListener('change', () => {
    syncOperationCompleteGuard('pick');
    loadOperationLots('pick');
  });
  $('pick-lot').addEventListener('change', () => handleOperationLotChange('pick'));
  $('pick-qty').addEventListener('input', updatePickQtyNote);
  $('pick-add-btn').addEventListener('click', () => addOperationItem('pick'));
  $('pick-cancel-btn').addEventListener('click', () => cancelOperation('pick'));
  $('pick-cancel-order-btn').addEventListener('click', cancelEntirePicking);
  $('pick-complete-btn').addEventListener('click', completePicking);
  $('pick-finish-so-btn').addEventListener('click', finishPickSalesOrder);
  $('pick-summary-refresh-btn').addEventListener('click', loadPickSalesOrderSummary);
  $('saved-pick-correction-close').addEventListener('click', () => $('saved-pick-correction-dialog').close());
  $('saved-pick-correction-form').addEventListener('submit', submitSavedPickMistakeReport);
  $('saved-pick-review-close').addEventListener('click', () => $('saved-pick-review-dialog').close());
  $('saved-pick-review-form').addEventListener('submit', submitSavedPickReviewApproval);
  $('saved-pick-review-reject').addEventListener('click', submitSavedPickReviewRejection);
  $('saved-pick-return-close').addEventListener('click', () => $('saved-pick-return-dialog').close());
  $('saved-pick-return-form').addEventListener('submit', submitSavedPickReturn);

  $('tr-lock-btn').addEventListener('click', lockTransferLocation);
  $('tr-transfer-all').addEventListener('change', syncFullTransferMode);
  $('tr-transfer-all-note').addEventListener('click', (event) => {
    const button = event.target.closest('[data-transfer-all-transaction-remark]');
    if (!button) return;
    setTransferAllTransactionRemark();
  });
  $('tr-barcode').addEventListener('input', () => syncOperationCompleteGuard('transfer'));
  $('tr-barcode').addEventListener('change', () => {
    syncOperationCompleteGuard('transfer');
    loadOperationLots('transfer');
  });
  $('tr-lot').addEventListener('change', () => handleOperationLotChange('transfer'));
  $('tr-qty').addEventListener('input', updateTransferQtyNote);
  $('tr-add-btn').addEventListener('click', () => addOperationItem('transfer'));
  $('tr-cancel-btn').addEventListener('click', () => cancelOperation('transfer'));
  $('tr-complete-btn').addEventListener('click', completeTransfer);

  $('inventory-search').addEventListener('input', renderInventory);
  $('inventory-search').addEventListener('change', renderInventory); // Scanner writes the barcode then dispatches change.
  $('inventory-filter').addEventListener('input', renderInventory);
  $('inventory-search-exact-rack').addEventListener('click', () => toggleExactRackSearch('inventory-search-exact-rack', renderInventory));
  $('inventory-filter-exact-rack').addEventListener('click', () => toggleExactRackSearch('inventory-filter-exact-rack', renderInventory));
  $('inventory-summary-print-btn').addEventListener('click', printInventorySkuSummary);
  $('inventory-summary-export-btn').addEventListener('click', exportFilteredInventorySkuSummaryCsv);
  $('inventory-lots-print-btn').addEventListener('click', printInventoryDetailedLots);
  $('inventory-lots-export-btn').addEventListener('click', exportFilteredInventoryDetailedLotsCsv);

  ['physical-count-sku','physical-count-container','physical-count-racks']
    .forEach((id) => {
      $(id).addEventListener('input', renderPhysicalCount);
      $(id).addEventListener('change', renderPhysicalCount);
    });
  $('physical-count-sort-toggle').addEventListener('click', handlePhysicalCountSortToggle);
  $('physical-count-clear-btn').addEventListener('click', clearPhysicalCountFilters);
  $('physical-count-print-btn').addEventListener('click', printPhysicalCount);
  $('physical-count-detailed-shipper-btn').addEventListener('click', openPhysicalCountDetailedShipperView);
  $('physical-count-detailed-shipper-back-btn').addEventListener('click', closePhysicalCountDetailedShipperView);
  $('physical-count-detailed-shipper-print-btn').addEventListener('click', printPhysicalCountDetailedShipperView);

  $('stock-card-search-form').addEventListener('submit', findStockCardSkus);
  $('stock-card-search').addEventListener('input', scheduleStockCardSuggestions);
  $('stock-card-search').addEventListener('change', findStockCardSkus); // Scanner writes the barcode then dispatches change.
  $('stock-card-search').addEventListener('focus', () => {
    if (state.stockCardCandidates.length && $('stock-card-search').value.trim().length >= 2) renderStockCardSuggestions();
  });
  $('stock-card-suggestions').addEventListener('click', handleStockCardSuggestionClick);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#stock-card-search') && !event.target.closest('#stock-card-suggestions')) hideStockCardSuggestions();
  });
  $('stock-card-load-btn').addEventListener('click', () => loadStockCard(true));
  $('stock-card-clear-btn').addEventListener('click', clearStockCard);
  $('stock-card-uom').addEventListener('change', renderStockCard);
  $('stock-card-movement').addEventListener('change', renderStockCard);

  $('sku-master-search').addEventListener('input', renderSkuMaster);
  $('sku-master-search').addEventListener('change', renderSkuMaster); // Scanner writes the barcode then dispatches change.
  $('sku-health-search').addEventListener('input', renderSkuHealth);
  $('sku-health-filter').addEventListener('change', renderSkuHealth);
  $('container-search').addEventListener('input', renderContainers);
  $('history-search').addEventListener('input', renderHistory);
  $('history-exact-rack').addEventListener('click', () => toggleExactRackSearch('history-exact-rack', renderHistory));
  $('history-type').addEventListener('change', renderHistory);

  ['audit-user-filter','audit-remarks-filter','audit-reason-filter','audit-so-filter','audit-container-filter','audit-rack-filter']
    .forEach((id) => $(id).addEventListener('input', renderAuditHistory));
  ['audit-action-filter','audit-date-from','audit-date-to']
    .forEach((id) => $(id).addEventListener('change', renderAuditHistory));
  $('audit-clear-filters').addEventListener('click', clearAuditHistoryFilters);
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
  $('pending-location-rename-close').addEventListener('click', () => $('pending-location-rename-dialog').close());
  $('pending-location-rename-form').addEventListener('submit', submitPendingLocationRename);
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
  $('inventory-remarks-close').addEventListener('click', () => $('inventory-remarks-dialog').close());
  $('inventory-remarks-form').addEventListener('submit', submitInventoryRemarksEdit);
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
    const containerReportMode = event.target.closest('[data-container-report-mode]');
    if (containerReportMode) setContainerReportMode(containerReportMode.dataset.containerReportMode);
    const containerReportPrint = event.target.closest('[data-container-report-print]');
    if (containerReportPrint) printContainerDetailReport();
    const edit = event.target.closest('[data-edit-transaction]');
    if (edit) openSupervisorEdit(edit.dataset.editTransaction);
    const revertPickLine = event.target.closest('[data-revert-pick-line]');
    if (revertPickLine) revertHistoryPickLine(revertPickLine.dataset.revertPickLine);
    const inventoryEdit = event.target.closest('[data-inventory-edit]');
    if (inventoryEdit) openInventoryLotEdit(inventoryEdit.dataset.inventoryEdit);
    const inventoryRemarks = event.target.closest('[data-inventory-remarks]');
    if (inventoryRemarks) openInventoryRemarksEdit(inventoryRemarks.dataset.inventoryRemarks);
    const inventoryBreakdown = event.target.closest('[data-inventory-breakdown]');
    if (inventoryBreakdown) openInventoryBreakdownHelper(inventoryBreakdown.dataset.inventoryBreakdown);
    const inventoryDelete = event.target.closest('[data-inventory-delete]');
    if (inventoryDelete) deleteInventoryLot(inventoryDelete.dataset.inventoryDelete);
    const inventoryHold = event.target.closest('[data-inventory-hold]');
    if (inventoryHold) toggleInventoryLotHold(inventoryHold.dataset.inventoryHold, inventoryHold.dataset.holdState === 'freeze');
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
    const savedPickReport = event.target.closest('[data-saved-pick-report]');
    if (savedPickReport) openSavedPickMistakeReport(savedPickReport.dataset.savedPickReport);
    const savedPickReview = event.target.closest('[data-saved-pick-review]');
    if (savedPickReview) openSavedPickReview(savedPickReview.dataset.savedPickReview);
    const savedPickReturn = event.target.closest('[data-saved-pick-return]');
    if (savedPickReturn) openSavedPickReturn(savedPickReturn.dataset.savedPickReturn);
    const emergencyFinish = event.target.closest('[data-emergency-finish-saved-pick]');
    if (emergencyFinish) emergencyFinishSalesOrderWithPendingReturn();
    const pendingRename = event.target.closest('[data-pending-location-rename]');
    if (pendingRename) openPendingLocationRename(pendingRename.dataset.pendingLocationRename);
    const pendingDelete = event.target.closest('[data-pending-location-delete]');
    if (pendingDelete) deletePendingLocation(pendingDelete.dataset.pendingLocationDelete);
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
  $('current-role').textContent = userRoleLabel(profile?.role || 'user');

  qsa('[data-role-min="supervisor"]').forEach((node) => node.classList.toggle('hidden', !isSupervisor()));
  qsa('[data-role-min="admin"]').forEach((node) => node.classList.toggle('hidden', !isAdminOrOwner()));

  // Viewer navigation is deliberately limited to the six approved read-only modules.
  qsa('#main-nav [data-screen]').forEach((node) => {
    const target = node.dataset.screen;
    let visible = true;
    if (node.dataset.roleMin === 'supervisor') visible = isSupervisor();
    if (node.dataset.roleMin === 'admin') visible = isAdminOrOwner();
    if (target === 'control') visible = isOwner();
    if (isViewer()) visible = VIEWER_SCREENS.has(target);
    node.classList.toggle('hidden', !visible);
  });

  // Hide dashboard/report jump links that would lead Viewer into a disallowed module.
  qsa('[data-jump]').forEach((node) => {
    const target = node.dataset.jump;
    node.classList.toggle('hidden', isViewer() && !VIEWER_SCREENS.has(target));
  });

  const ownerFilterOption = $('users-role')?.querySelector('option[value="owner"]');
  if (ownerFilterOption) {
    ownerFilterOption.hidden = !isOwner();
    if (!isOwner() && $('users-role').value === 'owner') $('users-role').value = '';
  }
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

function putawayHasPendingSkuEntry() {
  return Boolean(
    String($('pa-brand')?.value || '').trim() ||
    String($('pa-description')?.value || '').trim()
  );
}

function syncPutawayCompleteGuard() {
  const button = $('pa-complete-btn');
  if (!button) return;

  const pending = putawayHasPendingSkuEntry();
  button.disabled = !state.putaway.cart.length || state.mode !== 'ACTIVE' || pending;
  button.title = pending
    ? 'Add the current SKU entry to the pallet, or clear Brand / Description before completing Put-away.'
    : '';
}

function operationHasPendingBarcode(operation) {
  const id = operation === 'pick' ? 'pick-barcode' : 'tr-barcode';
  return Boolean(String($(id)?.value || '').trim());
}

function syncOperationCompleteGuard(operation) {
  const pick = operation === 'pick';
  const button = $(pick ? 'pick-complete-btn' : 'tr-complete-btn');
  if (!button) return;

  const locked = Boolean(state[operation]?.lockToken);
  const pending = operationHasPendingBarcode(operation);

  button.disabled = !locked || state.mode !== 'ACTIVE' || pending;
  button.title = pending
    ? (pick
        ? 'Add the current barcode entry to the Picking cart, or clear it before completing this rack.'
        : 'Add the current barcode entry to the Transfer cart, or clear it before completing the transfer.')
    : '';
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

  // Extra unfinished-entry guards only. Existing operational-mode rules stay intact.
  syncPutawayCompleteGuard();
  syncOperationCompleteGuard('pick');
  syncOperationCompleteGuard('transfer');
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
  if (isViewer() && !VIEWER_SCREENS.has(name)) return false;
  if (name === 'locations' && !isSupervisor()) return false;
  if (name === 'skumaster' && !isSupervisor()) return false;
  if (name === 'nonfefo' && !isSupervisor()) return false;
  if ((name === 'users' || name === 'systemmanager' || name === 'skuhealth') && !isAdminOrOwner()) return false;
  if (name === 'control' && !isOwner()) return false;
  return true;
}

function showScreen(name) {
  if (!canOpenScreen(name)) {
    if (isViewer() && !VIEWER_SCREENS.has(name)) toast('Viewer access is read-only and limited to Dashboard, Inventory, Physical Count, Containers, Rack Map, Expiry Alerts, and SKU Balance Stock Card.', 'error');
    if ((name === 'locations' || name === 'skumaster' || name === 'nonfefo') && !isSupervisor() && !isViewer()) toast('Supervisor access is required.', 'error');
    if ((name === 'users' || name === 'systemmanager' || name === 'skuhealth') && !isAdminOrOwner() && !isViewer()) toast('Admin or Owner access is required.', 'error');
    if (name === 'control' && !isOwner() && !isViewer()) toast('Owner access is required.', 'error');
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

async function refreshCurrentScreen() {
  const button = $('refresh-btn');
  const screen = state.currentScreen;

  setBusy(button, true, 'Refreshing…');

  try {
    // Always refresh Administrative Pause / Operational state.
    // Use a throwing refresh-specific query so the global button never reports
    // success when this live-state refresh actually failed.
    const { data: modeData, error: modeError } = await supabase
      .from('app_settings')
      .select('operational_mode')
      .eq('id', 1)
      .single();
    if (modeError) throw modeError;
    applyMode(modeData.operational_mode);

    switch (screen) {
      case 'dashboard':
        await loadDashboard();
        break;

      case 'putaway':
        // Put-away barcode lookups already query live data when used.
        // Do not reset forms, pallet cart, Shipper contents, or remarks.
        break;

      case 'picking':
        // Preserve SO, lock, queued cart, barcode/lot selection and remarks.
        await refreshPickSalesOrderStatus();
        if (state.pick.lockToken && state.pick.locationCode) {
          await loadPickRackContents();
        }
        break;

      case 'transfer':
        // Preserve source lock, queued cart, destination, barcode/lot and remarks.
        if (state.transfer.lockToken && state.transfer.locationCode) {
          await loadTransferRackContents();
        }
        break;

      case 'inventory':
        await loadInventory(true);
        break;
      case 'physicalcount':
        await loadPhysicalCount(true);
        break;
      case 'stockcard':
        if ($('stock-card-sku')?.value) await loadStockCard(true);
        break;
      case 'skumaster':
        await loadSkuMaster(true);
        break;
      case 'skuhealth':
        await loadSkuHealth(true);
        break;
      case 'containers':
        await loadContainers(true);
        break;
      case 'rackmap':
        await loadRackMap(true);
        break;
      case 'expiry':
        await loadExpiry(true);
        break;
      case 'nonfefo':
        await loadNonFefoCompliance(true);
        break;
      case 'users':
        await loadUsers(true);
        break;
      case 'systemmanager':
        await loadSystemManager(true);
        break;
      case 'history':
        await loadHistory(true);
        break;
      case 'locations':
        await loadLocations(true);
        break;

      case 'control':
        // loadSystemMode() above refreshes the live control state.
        break;

      default:
        await loadScreen(screen, true);
        break;
    }

    toast('Current page refreshed. Unsaved warehouse work was preserved.', 'success');
  } catch (error) {
    toast(`Refresh failed: ${friendlyError(error)}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function loadScreen(name, force = false) {
  try {
    if (name === 'dashboard') await loadDashboard();
    if (name === 'picking') await refreshPickSalesOrderStatus();
    if (name === 'inventory') await loadInventory(force);
    if (name === 'physicalcount') await loadPhysicalCount(force);
    if (name === 'stockcard') await loadStockCard(force);
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
  const [inventoryRes, locationRes, historyRes, pendingSoRes, activeLocksRes, pendingReturnsRes] = await Promise.all([
    supabase.from('v_inventory_details').select('*').limit(10000),
    supabase.from('v_location_summary').select('*').limit(5000),
    supabase.from('v_history_details').select('*').order('created_at', { ascending: false }).limit(12),
    supabase.rpc('get_dashboard_pending_pick_sales_orders'),
    supabase.rpc('get_dashboard_active_location_locks'),
    supabase.rpc('get_saved_pick_action_queue')
  ]);
  [inventoryRes, locationRes, historyRes, pendingSoRes, activeLocksRes, pendingReturnsRes].forEach((r) => { if (r.error) throw r.error; });
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
  state.dashboardPendingPickReturns = pendingReturnsRes.data || [];
  renderDashboardPendingPickReturns(state.dashboardPendingPickReturns);
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

function renderDashboardPendingPickReturns(rows) {
  const container = $('dashboard-pending-pick-returns');
  const count = $('dashboard-pending-pick-returns-count');
  if (!container || !count) return;

  const reviewCount = rows.filter((r) => r.correction_status === 'REQUESTED').length;
  const returnCount = rows.filter((r) => r.correction_status === 'PENDING_RETURN').length;

  count.textContent = `${rows.length} open`;
  if (!rows.length) {
    container.innerHTML = emptyState('No Saved Pick correction request or physical return needs action.');
    return;
  }

  container.innerHTML = `<div class="info-box">
      <strong>${reviewCount} awaiting review</strong> · <strong>${returnCount} physical return${returnCount===1?'':'s'} pending</strong>.
      Reporting a mistake does not change Inventory. Stock changes only after Supervisor approval and, when required, rack/barcode return confirmation.
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>Status</th><th>Sales Order</th><th>Item / Qty</th><th>Rack / Container</th><th>Reported / assigned</th><th>Reason</th><th>Action</th>
    </tr></thead><tbody>${rows.map((r) => {
      const isRequest = r.correction_status === 'REQUESTED';
      const status = isRequest
        ? '<span class="pill override">CORRECTION REQUESTED</span><br><small>Awaiting Supervisor review</small>'
        : (r.finish_override_at
            ? `<span class="pill near">RETURN PENDING</span><br><span class="pill override">SO FINISH OVERRIDDEN</span>`
            : '<span class="pill near">RETURN PENDING</span>');

      const qty = isRequest
        ? `Reported: <strong>${fmtQtyUom(r.reported_qty,r.uom)}</strong>`
        : `Approved return: <strong>${fmtQtyUom(r.correction_qty,r.uom)}</strong>`;

      const actor = isRequest
        ? `Reported by ${escapeHtml(r.reported_by_username || '—')}<br><small>${fmtDateTime(r.reported_at)}</small>`
        : `Assigned to ${escapeHtml(r.assigned_to_username || 'Supervisor follow-up')}${r.reviewed_by_username ? `<br><small>Approved by ${escapeHtml(r.reviewed_by_username)} (${escapeHtml(String(r.reviewed_role || '').toUpperCase())})</small>` : ''}`;

      let action = '<small>Awaiting action</small>';
      if (isRequest && r.can_review) {
        action = `<button type="button" class="secondary" data-saved-pick-review="${escapeHtml(r.correction_id)}">Review</button>`;
      } else if (isRequest) {
        action = '<small>Awaiting Supervisor review</small>';
      } else if (r.can_complete_return) {
        action = `<button type="button" class="secondary" data-saved-pick-return="${escapeHtml(r.correction_id)}">Complete return</button>`;
      } else {
        action = '<small>Assigned picker / Supervisor+</small>';
      }

      return `<tr>
        <td>${status}</td>
        <td><strong>${escapeHtml(r.sales_order)}</strong></td>
        <td class="wrap"><strong>${escapeHtml(r.sku_name || '—')}</strong><br>${qty}<br><small>${escapeHtml((isRequest ? r.reported_physical_state : r.correction_mode) === 'STILL_IN_ORIGINAL_RACK' ? 'Reported/approved: still in original rack' : 'Physical return required')}</small></td>
        <td><strong>${escapeHtml(r.expected_location_code || '—')}</strong><br><small>${escapeHtml(r.container_no || '—')} · ${fmtDate(r.expiry_date)}</small></td>
        <td>${actor}</td>
        <td class="wrap">${escapeHtml(r.report_reason || '—')}${r.finish_override_reason ? `<br><small>Emergency finish: ${escapeHtml(r.finish_override_reason)}</small>` : ''}</td>
        <td>${action}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
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
  state.data.physicalCount = [];
  state.data.physicalCountRaw = [];
  state.data.physicalCountFiltered = [];
  state.data.physicalCountDetailedShipperFiltered = [];
  state.data.stockCard = [];
  state.data.stockCardExport = [];
  state.stockCardMeta = null;
  state.data.skuMaster = [];
  state.data.skuHealth = [];
  state.data.containers = [];
  state.data.expiry = [];
  state.data.nonFefo = [];
  state.data.history = [];
  state.data.audit = [];
  state.data.auditFiltered = [];
  state.pickRevertStatusByLine = new Map();
  state.pickRevertStatusLoaded = false;
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
  $('pa-still-add').disabled = false;
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


function putawayBarcodeValues() {
  return ['pa-case', 'pa-pack', 'pa-piece'].map((id) => normalizeBarcode($(id).value));
}

function isAllNaPutaway() {
  const codes = putawayBarcodeValues();
  return codes.length === 3 && codes.every((code) => code === 'N/A');
}

function barcodeLessSearchText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function barcodeLessCompactText(value) {
  return barcodeLessSearchText(value).replace(/[^a-z0-9]+/g, '');
}

function barcodeLessSkuLabel(sku) {
  return [sku?.brand, sku?.description, sku?.variant, sku?.size].filter(Boolean).join(' — ');
}

function clearBarcodeLessDetailFields() {
  ['pa-brand', 'pa-description', 'pa-variant', 'pa-size'].forEach((id) => { $(id).value = ''; });
  syncPutawayCompleteGuard();
}

function hideBarcodeLessPutawayPanel({ clearExistingDetails = false } = {}) {
  const wasExisting = state.putaway.barcodeLessMode === 'existing';
  state.putaway.barcodeLessMode = null;
  state.putaway.barcodeLessSkuId = null;
  if (wasExisting) state.putaway.matchedSkuId = null;
  if (clearExistingDetails && wasExisting) clearBarcodeLessDetailFields();
  $('pa-barcode-less-panel').classList.add('hidden');
  $('pa-barcode-less-search').value = '';
  $('pa-barcode-less-select').innerHTML = '<option value="">Select a previously recorded barcode-less SKU</option>';
  $('pa-barcode-less-selection-note').textContent = '';
}

function setBarcodeLessAwaitingSelection() {
  state.putaway.barcodeLessMode = 'select';
  state.putaway.barcodeLessSkuId = null;
  state.putaway.matchedSkuId = null;
  clearBarcodeLessDetailFields();
  setPutawayDetailsReadonly(true);
  hidePutawayDuplicateWarning();
  $('pa-match-note').classList.add('hidden');
  $('pa-barcode-less-selection-note').innerHTML =
    '<strong>Select an existing item first.</strong> If the item is genuinely new and is not in the list, use <strong>Create new barcode-less SKU</strong>.';
}

async function loadBarcodeLessPutawaySkus(force = false) {
  if (!force && state.putaway.barcodeLessLoaded) {
    renderBarcodeLessSkuOptions();
    return state.putaway.barcodeLessSkus;
  }

  $('pa-barcode-less-selection-note').textContent = 'Loading previously recorded barcode-less items…';
  const { data, error } = await supabase.rpc('find_barcode_less_standard_skus', { p_search: null });
  if (error) throw error;

  state.putaway.barcodeLessSkus = data || [];
  state.putaway.barcodeLessLoaded = true;
  renderBarcodeLessSkuOptions();

  if (!state.putaway.barcodeLessSkus.length) {
    $('pa-barcode-less-selection-note').innerHTML =
      '<strong>No previously recorded barcode-less STANDARD SKU was found.</strong> If this is a genuinely new item, use <strong>Create new barcode-less SKU</strong>.';
  }
  return state.putaway.barcodeLessSkus;
}

function renderBarcodeLessSkuOptions() {
  const select = $('pa-barcode-less-select');
  if (!select) return;

  const term = barcodeLessSearchText($('pa-barcode-less-search').value);
  const compactTerm = barcodeLessCompactText(term);
  const currentId = state.putaway.barcodeLessSkuId;

  let rows = state.putaway.barcodeLessSkus.filter((sku) => {
    if (!term) return true;
    const label = barcodeLessSearchText(barcodeLessSkuLabel(sku));
    const compact = barcodeLessCompactText(label);
    const words = term.split(/\s+/).filter(Boolean);
    return label.includes(term)
      || (compactTerm && compact.includes(compactTerm))
      || words.every((word) => label.includes(word) || compact.includes(barcodeLessCompactText(word)));
  });

  if (currentId && !rows.some((sku) => sku.id === currentId)) {
    const selected = state.putaway.barcodeLessSkus.find((sku) => sku.id === currentId);
    if (selected) rows = [selected, ...rows];
  }

  const first = state.putaway.barcodeLessSkus.length
    ? '<option value="">Select a previously recorded barcode-less SKU</option>'
    : '<option value="">No previously recorded barcode-less SKU</option>';

  select.innerHTML = first + rows.map((sku) =>
    `<option value="${escapeHtml(sku.id)}">${escapeHtml(barcodeLessSkuLabel(sku))}${sku.created_by_username ? ` · added by ${escapeHtml(sku.created_by_username)}` : ''}</option>`
  ).join('');

  if (currentId && rows.some((sku) => sku.id === currentId)) select.value = currentId;
}

function selectBarcodeLessPutawaySku() {
  const id = $('pa-barcode-less-select').value;
  if (!id) {
    if (state.putaway.barcodeLessMode !== 'new') setBarcodeLessAwaitingSelection();
    return;
  }

  const sku = state.putaway.barcodeLessSkus.find((row) => row.id === id);
  if (!sku) {
    setBarcodeLessAwaitingSelection();
    return toast('The selected barcode-less SKU is no longer in the loaded list. Refresh the selection.', 'error');
  }

  state.putaway.barcodeLessMode = 'existing';
  state.putaway.barcodeLessSkuId = sku.id;
  state.putaway.matchedSkuId = sku.id;
  $('pa-brand').value = sku.brand || '';
  $('pa-description').value = sku.description || '';
  $('pa-variant').value = sku.variant || '';
  $('pa-size').value = sku.size || '';
  syncPutawayCompleteGuard();
  setPutawayDetailsReadonly(true);
  hidePutawayDuplicateWarning();
  $('pa-match-note').innerHTML =
    `<strong>Existing barcode-less SKU selected.</strong> ${escapeHtml(barcodeLessSkuLabel(sku))}. The stored master details are locked; enter only the delivery-specific rack, container, expiry and quantities.`;
  $('pa-match-note').classList.remove('hidden');
  $('pa-barcode-less-selection-note').innerHTML =
    `<strong>Selected:</strong> ${escapeHtml(barcodeLessSkuLabel(sku))}`;
}

function startNewBarcodeLessPutawaySku() {
  if (!isAllNaPutaway()) return toast('Create-new barcode-less mode is available only when CASE, PACK, and PIECE are all N/A.', 'error');

  const ok = window.confirm(
    'Create a new permanent barcode-less SKU only if the physical item is not already listed above. Continue?'
  );
  if (!ok) return;

  state.putaway.barcodeLessMode = 'new';
  state.putaway.barcodeLessSkuId = null;
  state.putaway.matchedSkuId = null;
  $('pa-barcode-less-select').value = '';
  clearBarcodeLessDetailFields();
  setPutawayDetailsReadonly(false);
  hidePutawayDuplicateWarning();
  $('pa-match-note').innerHTML =
    '<strong>Creating a new barcode-less STANDARD SKU.</strong> Enter Brand, Description, Variant and Size carefully. The database will block an exact normalized duplicate.';
  $('pa-match-note').classList.remove('hidden');
  $('pa-barcode-less-selection-note').innerHTML =
    '<strong>New SKU mode:</strong> type the master details below. You may still choose an existing item from the list if you find a match.';
  $('pa-brand').focus();
}

async function enterBarcodeLessPutawayMode() {
  $('pa-barcode-less-panel').classList.remove('hidden');

  if (!state.putaway.barcodeLessMode) {
    state.putaway.barcodeLessMode = 'select';
    state.putaway.barcodeLessSkuId = null;
    state.putaway.matchedSkuId = null;
    clearBarcodeLessDetailFields();
    setPutawayDetailsReadonly(true);
    hidePutawayDuplicateWarning();
  }

  await loadBarcodeLessPutawaySkus();

  if (state.putaway.barcodeLessMode === 'existing' && state.putaway.barcodeLessSkuId) {
    const sku = state.putaway.barcodeLessSkus.find((row) => row.id === state.putaway.barcodeLessSkuId);
    if (!sku) {
      setBarcodeLessAwaitingSelection();
      return 'barcode-less-select';
    }
    setPutawayDetailsReadonly(true);
    return 'barcode-less-existing';
  }

  if (state.putaway.barcodeLessMode === 'new') {
    setPutawayDetailsReadonly(false);
    return 'barcode-less-new';
  }

  setBarcodeLessAwaitingSelection();
  return 'barcode-less-select';
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
  const allNa = entered.every((entry) => entry.value === 'N/A');

  if (allNa) {
    try {
      return await enterBarcodeLessPutawayMode();
    } catch (error) {
      toast(friendlyError(error), 'error');
      return 'error';
    }
  }

  if (state.putaway.barcodeLessMode) {
    hideBarcodeLessPutawayPanel({ clearExistingDetails: true });
  }

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
    syncPutawayCompleteGuard();
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
  if (isAllNaPutaway() && state.putaway.barcodeLessMode !== 'new') {
    hidePutawayDuplicateWarning();
    return null;
  }
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
        const archivedAllNa = [archived.case_barcode, archived.pack_barcode, archived.piece_barcode]
          .every((code) => normalizeBarcode(code) === 'N/A');

        if (isAllNaPutaway() && state.putaway.barcodeLessMode === 'new' && archivedAllNa) {
          $('pa-still-add').checked = false;
          $('pa-still-add').disabled = true;
          $('pa-duplicate-details').textContent =
            `A previously archived barcode-less SKU has these exact details: ${barcodeLessSkuLabel(archived)}. Do not create another master record. Ask Admin/Owner to review/reactivate the archived SKU in SKU Master Data Health.`;
        } else {
          $('pa-duplicate-details').textContent =
            `A previously deleted SKU has the same details. Archived barcodes — CASE: ${archived.case_barcode}; PACK: ${archived.pack_barcode}; PIECE: ${archived.piece_barcode}. ` +
            `If this is the same physical product, use its original barcode so Admin/Owner can reactivate the original record. Only use Still Add to Database when this is genuinely a different barcode family.`;
        }
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
  const matchAllNa = [match.case_barcode, match.pack_barcode, match.piece_barcode]
    .every((code) => normalizeBarcode(code) === 'N/A');

  if (isAllNaPutaway() && state.putaway.barcodeLessMode === 'new' && matchAllNa) {
    $('pa-still-add').checked = false;
    $('pa-still-add').disabled = true;
    $('pa-duplicate-details').textContent =
      `This exact barcode-less SKU already exists: ${barcodeLessSkuLabel(match)}. Return to the list above and select the existing item instead. Creating another exact all-N/A master record is blocked.`;
  } else {
    $('pa-still-add').disabled = false;
    $('pa-duplicate-details').textContent = `Existing barcodes — CASE: ${match.case_barcode}; PACK: ${match.pack_barcode}; PIECE: ${match.piece_barcode}. Added by: ${match.created_by_username || 'unknown user'}.`;
  }
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
    user_remark: $('pa-note').value.trim() || null,
    allow_duplicate_details: $('pa-still-add').checked,
    barcode_less_sku_id: state.putaway.barcodeLessMode === 'existing' ? state.putaway.barcodeLessSkuId : null,
    create_barcode_less_sku: state.putaway.barcodeLessMode === 'new'
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
    if (resolution === 'barcode-less-select') {
      return toast('Select a previously recorded barcode-less SKU, or choose Create new barcode-less SKU.', 'error');
    }
    if (!form.reportValidity()) return;

    const location = normalizeLocation($('pa-location').value);
    if (!location) return toast('Scan or enter a rack location.', 'error');

    const item = putawayLinePayload();
    const codes = [item.case_barcode, item.pack_barcode, item.piece_barcode];
    if (codes.some((code) => !code)) return toast('CASE, PACK, and PIECE barcode are all required. Enter N/A when unavailable.', 'error');
    const actualCodes = codes.filter((code) => code !== 'N/A').map((code) => code.toLowerCase());
    const allNa = actualCodes.length === 0;
    if (allNa && state.putaway.barcodeLessMode === 'existing' && !state.putaway.barcodeLessSkuId) {
      return toast('Select the existing barcode-less SKU before adding the line.', 'error');
    }
    if (allNa && !['existing', 'new'].includes(state.putaway.barcodeLessMode)) {
      return toast('For an item with no CASE/PACK/PIECE barcode, select an existing barcode-less SKU or explicitly create a new one.', 'error');
    }
    if ([item.case_qty, item.pack_qty, item.piece_qty].some((qty) => qty < 0)) return toast('Quantities cannot be negative.', 'error');
    if ([item.case_qty, item.pack_qty, item.piece_qty].some((qty) => !Number.isInteger(qty))) return toast('CASE, PACK, and PIECE quantities must be whole numbers only (0, 1, 2, 3, ...).', 'error');
    if (item.case_qty <= 0 && item.pack_qty <= 0 && item.piece_qty <= 0) return toast('Enter at least one CASE, PACK, or PIECE quantity.', 'error');

    if (!(allNa && state.putaway.barcodeLessMode === 'existing')) {
      const duplicateMatch = await checkPutawayDuplicateDetails();
      const duplicateIsAllNa = duplicateMatch && [duplicateMatch.case_barcode, duplicateMatch.pack_barcode, duplicateMatch.piece_barcode]
        .every((code) => normalizeBarcode(code) === 'N/A');

      if (allNa && state.putaway.barcodeLessMode === 'new' && duplicateIsAllNa) {
        return duplicateMatch.archived
          ? toast('A previously archived barcode-less SKU has these exact details. Ask Admin/Owner to review/reactivate it instead of creating a duplicate.', 'error')
          : toast('This exact barcode-less SKU already exists. Select it from the previously recorded items list instead.', 'error');
      }
      if (duplicateMatch && !$('pa-still-add').checked) {
        return toast('ITEM WITH THE SAME DETAILS EXISTED. Please check BARCODE, or select Still Add to Database.', 'error');
      }
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
  ['pa-piece','pa-pack','pa-case','pa-brand','pa-description','pa-variant','pa-size','pa-container','pa-expiry','pa-note'].forEach((id) => $(id).value = '');
  $('pa-no-expiry').checked = false;
  syncNoExpiryControl('pa-expiry', 'pa-no-expiry');
  ['pa-piece-qty','pa-pack-qty','pa-case-qty'].forEach((id) => $(id).value = '0');
  state.putaway.matchedSkuId = null;
  state.putaway.barcodeLessMode = null;
  state.putaway.barcodeLessSkuId = null;
  state.putaway.lookupSequence += 1;
  setPutawayDetailsReadonly(false);
  $('pa-match-note').classList.add('hidden');
  hidePutawayDuplicateWarning();
  $('pa-barcode-less-panel').classList.add('hidden');
  $('pa-barcode-less-search').value = '';
  renderBarcodeLessSkuOptions();
  $('pa-barcode-less-selection-note').textContent = '';
  syncPutawayCompleteGuard();
  $('pa-case').focus();
}

function renderPutawayCart() {
  const rows = state.putaway.cart;
  $('pa-cart').innerHTML = rows.length ? `<table><thead><tr><th>SKU</th><th>Barcodes</th><th>Container</th><th>Expiry</th><th>Quantities</th><th>Remarks</th><th></th></tr></thead><tbody>${rows.map((r, i) => `<tr>
    <td class="wrap">${escapeHtml([r.brand,r.description,r.variant,r.size].join(' '))}</td><td class="wrap">C: ${escapeHtml(r.case_barcode)}<br>Pk: ${escapeHtml(r.pack_barcode)}<br>P: ${escapeHtml(r.piece_barcode)}</td><td>${escapeHtml(r.container_no)}</td><td>${fmtDate(r.expiry_date)}</td><td>${putawayQuantityText(r)}</td><td class="wrap">${escapeHtml(r.user_remark || '—')}</td>
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
  syncPutawayCompleteGuard();
}

function resetPutawaySession() {
  state.putaway = freshPutawayState();
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
  $('pa-barcode-less-panel').classList.add('hidden');
  $('pa-barcode-less-search').value = '';
  $('pa-barcode-less-select').innerHTML = '<option value="">Select a previously recorded barcode-less SKU</option>';
  $('pa-barcode-less-selection-note').textContent = '';
  renderPutawayCart();
  syncPutawayCompleteGuard();
}

async function completePutaway() {
  if (putawayHasPendingSkuEntry()) {
    return toast('A Put-away SKU entry is still pending. Add it to the pallet, or clear Brand / Description before completing Put-away.', 'error');
  }
  if (!state.putaway.cart.length) return toast('Add at least one SKU line.', 'error');
  if (state.putaway.cart.some((item) => [item.case_qty, item.pack_qty, item.piece_qty].some((qty) => !Number.isInteger(Number(qty))))) {
    return toast('Put-away cannot continue: CASE, PACK, and PIECE quantities must be whole numbers.', 'error');
  }
  const button = $('pa-complete-btn');
  setBusy(button, true, 'Completing…');
  const { data, error } = await supabase.rpc('complete_putaway_with_user_remarks', {
    p_location_code: state.putaway.locationCode,
    p_items: state.putaway.cart
  });
  setBusy(button, false);
  syncPutawayCompleteGuard();
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
  const rawBoxCount = String($('sp-case-count').value || '').trim();
  const boxCount = Number(rawBoxCount);
  if (!location) return toast('Scan or enter the rack location.', 'error');
  if (!shipperCase || shipperCase === 'N/A') return toast('A Shipper Box requires an actual CASE barcode.', 'error');
  if (!container) return toast('Container number is required.', 'error');
  if (!/^\d+$/.test(rawBoxCount) || !Number.isSafeInteger(boxCount) || boxCount < 1 || boxCount > 500) {
    return toast('Number of identical Shipper cases must be a whole number from 1 to 500.', 'error');
  }
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

  const payload = {
    location,
    shipperCase,
    brand,
    description,
    variant,
    size,
    container,
    contents: state.shipperPutaway.contents.map((row) => ({ ...row })),
    boxCount,
    allowDuplicate: $('sp-still-add').checked,
    note: $('sp-note').value.trim() || null
  };

  if (boxCount > 1) {
    const confirmed = window.confirm(`Request approval to create ${boxCount} independent physical Shipper Boxes with EXACTLY the same encoded contents, quantities, expiries, container, and rack? Each CASE will receive its own SB ID.`);
    if (!confirmed) return;
    openShipperBatchApprovalDialog(payload);
    return;
  }

  await submitShipperPutawayBatch(payload, null, null);
}

function openShipperBatchApprovalDialog(payload) {
  state.shipperPutaway.pendingBatchPayload = payload;
  $('shipper-batch-approval-context').innerHTML = `<strong>${escapeHtml(payload.boxCount)} identical Shipper cases</strong><br>Shipper: ${escapeHtml(payload.shipperCase)} · Rack: ${escapeHtml(payload.location)} · Container: ${escapeHtml(payload.container)}<br><span class="small-note">Approval is valid only for this exact batch and expires after 5 minutes.</span>`;
  $('shipper-batch-approver-email').value = '';
  $('shipper-batch-approver-password').value = '';
  $('shipper-batch-approval-dialog').showModal();
  $('shipper-batch-approver-email').focus();
}

function closeShipperBatchApprovalDialog() {
  $('shipper-batch-approver-password').value = '';
  state.shipperPutaway.pendingBatchPayload = null;
  $('shipper-batch-approval-dialog').close();
}

async function submitShipperBatchApproval(event) {
  event.preventDefault();
  const payload = state.shipperPutaway.pendingBatchPayload;
  if (!payload || payload.boxCount <= 1) return toast('No batch Shipper approval request is pending.', 'error');
  if (!state.session?.user?.id) return toast('Your Picker session is no longer active. Sign in again.', 'error');

  const email = $('shipper-batch-approver-email').value.trim();
  const password = $('shipper-batch-approver-password').value;
  if (!email || !password) return toast('Enter the Supervisor/Admin/Owner login email and password.', 'error');

  const button = $('shipper-batch-approval-confirm');
  setBusy(button, true, 'Verifying approval…');
  let approvalClient = null;
  try {
    // Use an isolated, non-persistent Supabase Auth client so the approver can verify
    // with their normal WMS login password without replacing the Picker's live session.
    approvalClient = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });

    const { error: authError } = await approvalClient.auth.signInWithPassword({ email, password });
    if (authError) throw new Error('Approval failed: the approver email or login password is incorrect.');

    const { data, error } = await approvalClient.rpc('approve_shipper_batch_request', {
      p_requested_by: state.session.user.id,
      p_location_code: payload.location,
      p_shipper_case_barcode: payload.shipperCase,
      p_shipper_brand: payload.brand,
      p_shipper_description: payload.description,
      p_shipper_variant: payload.variant,
      p_shipper_size: payload.size,
      p_container_no: payload.container,
      p_contents: payload.contents,
      p_box_count: payload.boxCount,
      p_allow_duplicate_shipper_details: payload.allowDuplicate,
      p_note: payload.note
    });
    if (error) throw error;

    const approval = data?.[0];
    if (!approval?.approval_token) throw new Error('Supervisor approval could not be created.');

    $('shipper-batch-approver-password').value = '';
    $('shipper-batch-approval-dialog').close();
    state.shipperPutaway.pendingBatchPayload = null;
    toast(`Approved by ${approval.approver_username || 'Supervisor'} (${String(approval.approver_role || '').toUpperCase()}).`, 'success');

    await submitShipperPutawayBatch(payload, approval.approval_token, approval);
  } catch (error) {
    $('shipper-batch-approver-password').value = '';
    toast(friendlyError(error), 'error');
  } finally {
    if (approvalClient) {
      try { await approvalClient.auth.signOut({ scope: 'local' }); } catch (_) { /* isolated non-persistent session expires on its own */ }
    }
    setBusy(button, false);
  }
}

function requestWarehouseApproval({ title, contextHtml, rpcName, rpcArgs, confirmLabel = 'APPROVE ACTION' }) {
  if (state.warehouseApproval) {
    toast('Another approval request is already open.', 'error');
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    state.warehouseApproval = { resolve, rpcName, rpcArgs };
    $('warehouse-approval-title').textContent = title || 'Approve controlled action';
    $('warehouse-approval-context').innerHTML = contextHtml || '';
    $('warehouse-approver-email').value = '';
    $('warehouse-approver-password').value = '';
    $('warehouse-approval-confirm').textContent = confirmLabel;
    $('warehouse-approval-dialog').showModal();
    $('warehouse-approver-email').focus();
  });
}

function finishWarehouseApproval(result) {
  const pending = state.warehouseApproval;
  state.warehouseApproval = null;
  $('warehouse-approver-password').value = '';
  if ($('warehouse-approval-dialog').open) $('warehouse-approval-dialog').close();
  if (pending?.resolve) pending.resolve(result || null);
}

function cancelWarehouseApproval() {
  finishWarehouseApproval(null);
}

async function submitWarehouseApproval(event) {
  event.preventDefault();
  const pending = state.warehouseApproval;
  if (!pending) return toast('No controlled approval request is pending.', 'error');
  if (!state.session?.user?.id) return toast('Your warehouse session is no longer active. Sign in again.', 'error');

  const email = $('warehouse-approver-email').value.trim();
  const password = $('warehouse-approver-password').value;
  if (!email || !password) return toast('Enter the Supervisor/Admin/Owner login email and password.', 'error');

  const button = $('warehouse-approval-confirm');
  setBusy(button, true, 'Verifying approval…');
  let approvalClient = null;
  try {
    approvalClient = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });

    const { error: authError } = await approvalClient.auth.signInWithPassword({ email, password });
    if (authError) throw new Error('Approval failed: the approver email or login password is incorrect.');

    const { data, error } = await approvalClient.rpc(pending.rpcName, pending.rpcArgs);
    if (error) throw error;
    const approval = data?.[0];
    if (!approval?.approval_token) throw new Error('Supervisor/Admin/Owner approval could not be created.');

    toast(`Approved by ${approval.approver_username || 'Supervisor'} (${String(approval.approver_role || '').toUpperCase()}).`, 'success');
    finishWarehouseApproval(approval);
  } catch (error) {
    $('warehouse-approver-password').value = '';
    toast(friendlyError(error), 'error');
  } finally {
    if (approvalClient) {
      try { await approvalClient.auth.signOut({ scope: 'local' }); } catch (_) { /* isolated non-persistent session expires on its own */ }
    }
    setBusy(button, false);
  }
}

async function submitShipperPutawayBatch(payload, approvalToken = null, approval = null) {
  const button = $('sp-complete-btn');
  setBusy(button, true, payload.boxCount > 1 ? `Creating ${payload.boxCount} boxes…` : 'Completing…');
  const { data, error } = await supabase.rpc('complete_shipper_putaway_batch', {
    p_location_code: payload.location,
    p_shipper_case_barcode: payload.shipperCase,
    p_shipper_brand: payload.brand,
    p_shipper_description: payload.description,
    p_shipper_variant: payload.variant,
    p_shipper_size: payload.size,
    p_container_no: payload.container,
    p_contents: payload.contents,
    p_box_count: payload.boxCount,
    p_allow_duplicate_shipper_details: payload.allowDuplicate,
    p_note: payload.note,
    p_approval_token: approvalToken
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  const rows = data || [];
  const boxNos = rows.map((row) => row.shipper_box_no).filter(Boolean);
  const transactionNos = rows.map((row) => row.transaction_no).filter(Boolean);
  const createdCount = boxNos.length || payload.boxCount;
  toast(`${createdCount} physical Shipper ${createdCount === 1 ? 'box' : 'boxes'} created successfully.`, 'success');
  invalidateReports();
  resetShipperPutaway(true);

  const idsHtml = boxNos.length
    ? `<div class="small-note" style="margin-top:8px;word-break:break-word">${boxNos.map(escapeHtml).join(' · ')}</div>`
    : '';
  const txHtml = transactionNos.length
    ? `<div class="small-note" style="margin-top:6px">Put-away transactions: ${transactionNos.map(escapeHtml).join(' · ')}</div>`
    : '';
  const approvalHtml = approval && payload.boxCount > 1
    ? `<div class="small-note" style="margin-top:6px">Approved by: ${escapeHtml(approval.approver_username || 'Supervisor')} (${escapeHtml(String(approval.approver_role || '').toUpperCase())})</div>`
    : '';
  $('sp-result').innerHTML = `<strong>${createdCount} Physical Shipper ID${createdCount === 1 ? '' : 's'} created.</strong><br>Write or attach the correct SB number to each physical box. These boxes are independent even though this batch used identical contents.${approvalHtml}${idsHtml}${txHtml}`;
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

  const statusOk = await refreshPickSalesOrderStatus();
  if (!statusOk || !['NEW', 'OPEN', 'COMPLETED'].includes(state.pickOrder.status)) {
    return toast('The sales order status could not be verified. Please try again.', 'error');
  }

  if (state.pickOrder.status === 'COMPLETED') {
    const reopened = await requestReopenCompletedSalesOrder();
    if (!reopened) return;
  }

  const locked = await acquireOperationLock('pick', location, 'PICK', so);
  if (locked) {
    $('pick-so-override').checked = false;
    $('pick-so-override-reason').value = '';
    await refreshPickSalesOrderStatus();
  }
}


async function requestReopenCompletedSalesOrder() {
  const so = $('pick-so').value.trim();
  if (!so || isStockAdjustmentSalesOrder(so)) {
    toast('Enter a completed normal Sales Order number first.', 'error');
    return false;
  }
  if (state.pick.lockToken) {
    toast('Complete or cancel the current rack before reopening another Sales Order.', 'error');
    return false;
  }

  const statusOk = await refreshPickSalesOrderStatus();
  if (!statusOk) {
    toast('The Sales Order status could not be verified. Please try again.', 'error');
    return false;
  }
  if (state.pickOrder.status === 'OPEN') {
    return Boolean(state.pickOrder.isCurrentOwner);
  }
  if (state.pickOrder.status !== 'COMPLETED') {
    toast('This Sales Order is not currently completed, so reopening approval is not required.', 'error');
    return false;
  }

  const reopenReason = $('pick-so-override-reason').value.trim();
  if (!reopenReason) {
    $('pick-so-override-reason').focus();
    toast('Enter the reason for reopening this completed Sales Order.', 'error');
    return false;
  }
  if (!state.session?.user?.id) {
    toast('Your warehouse session is no longer active. Sign in again.', 'error');
    return false;
  }

  const requestButton = $('pick-so-reopen-request-btn');
  setBusy(requestButton, true, 'Awaiting approval…');

  try {
    const approval = await requestWarehouseApproval({
      title: 'Approve Sales Order Reopen',
      contextHtml: `<strong>Completed Sales Order: ${escapeHtml(so)}</strong><br>Requested by: ${escapeHtml(state.profile?.username || 'current warehouse user')}<br>Reason: ${escapeHtml(reopenReason)}<br><span class="small-note">A currently active Supervisor, Admin, or Owner must enter their normal WMS login email and password. The database checks the approver's current role again when the Sales Order is reopened.</span>`,
      rpcName: 'approve_sales_order_reopen_request',
      rpcArgs: {
        p_requested_by: state.session.user.id,
        p_sales_order: so,
        p_reason: reopenReason
      },
      confirmLabel: 'APPROVE REOPEN'
    });
    if (!approval) return false;

    const { data: reopened, error: reopenError } = await supabase.rpc('reopen_completed_sales_order_approved', {
      p_sales_order: so,
      p_reason: reopenReason,
      p_approval_token: approval.approval_token
    });
    if (reopenError) {
      toast(friendlyError(reopenError), 'error');
      return false;
    }

    const reopenedRow = reopened?.[0];
    $('pick-so-override').checked = false;
    $('pick-so-override-reason').value = '';

    const refreshed = await refreshPickSalesOrderStatus();
    if (!refreshed || state.pickOrder.status !== 'OPEN' || !state.pickOrder.isCurrentOwner) {
      toast('Sales Order was reopened, but its current ownership could not be verified. Refresh Picking before locking a rack.', 'error');
      return false;
    }

    toast(`Sales Order ${so} reopened · approved by ${reopenedRow?.approved_by_username || approval.approver_username || 'Supervisor'} (${String(reopenedRow?.approved_by_role || approval.approver_role || '').toUpperCase()}). You may now lock the source rack.`, 'success');
    return true;
  } finally {
    setBusy(requestButton, false);
    syncPickOverrideControls();
    updatePickSalesOrderControls();
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
  state.data.auditFiltered = [];

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
    p_override_completed: false,
    p_override_reason: null
  });
  setBusy(button, false);
  if (error) {
    const message = friendlyError(error);
    if (message.includes('SALES_ORDER_ALREADY_COMPLETED') || message.includes('SUPERVISOR_APPROVAL_REQUIRED')) {
      await refreshPickSalesOrderStatus();
      $('pick-so-override-reason').disabled = false;
      $('pick-so-override-reason').focus();
      toast('This Sales Order is completed. Enter a reopening reason, then click Request Supervisor/Admin/Owner approval.', 'error');
      return false;
    }
    toast(message, 'error');
    return false;
  }
  opState.lockToken = data[0].lock_token;
  state.data.rackMap = [];
  state.data.audit = [];
  state.data.auditFiltered = [];
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
    $('tr-transfer-all').disabled = !locked;
    syncFullTransferMode();
  }
  const chip = $(pick ? 'pick-lock-chip' : 'transfer-lock-chip');
  chip.textContent = locked ? `${state[operation].locationCode} locked by you` : 'No location locked';
  chip.className = `status-chip ${locked ? 'active' : 'neutral'}`;
  syncOperationCompleteGuard(operation);
}

function syncFullTransferMode() {
  const checkbox = $('tr-transfer-all');
  if (!checkbox) return;
  const locked = Boolean(state.transfer.lockToken);
  const bulk = locked && checkbox.checked;

  const manualIds = ['tr-barcode', 'tr-lot', 'tr-qty'];
  manualIds.forEach((id) => { $(id).disabled = !locked || bulk; });
  qsa('[data-scan-target="tr-barcode"]').forEach((b) => b.disabled = !locked || bulk);
  qsa('[data-na-target="tr-barcode"]').forEach((b) => b.disabled = !locked || bulk);
  $('tr-add-btn').disabled = !locked || bulk;

  // In Transfer ALL mode the ordinary item remark is intentionally unavailable.
  // A whole-rack transaction remark is separate and never overwrites item remarks.
  $('tr-note').disabled = bulk;
  if (bulk) $('tr-note').value = '';

  const note = $('tr-transfer-all-note');
  if (bulk) {
    if (state.transfer.cart.length) {
      state.transfer.cart = [];
      renderOperationCart('transfer');
    }
    $('tr-barcode').value = '';
    $('tr-lot').innerHTML = '<option value="">Whole-rack transfer selected</option>';
    $('tr-qty').value = '';
    $('tr-unit-label').textContent = 'all units';
    clearTransferBarcodeMatch();
    $('tr-qty-note').classList.add('hidden');
    const activeLots = (state.transfer.rackLots || []).filter((row) => Number(row.qty) > 0);
    const heldLots = activeLots.filter((row) => row.is_releasable === false);
    const shipperBoxes = new Set(activeLots.map((row) => row.shipper_box_no).filter(Boolean));
    const txRemark = String(state.transfer.bulkTransactionRemark || '').trim();
    const txRemarkHtml = heldLots.length ? '' : `<br><button type="button" class="secondary" data-transfer-all-transaction-remark="1">${txRemark ? 'Edit' : 'Add'} Transfer ALL transaction remark</button>${txRemark ? `<br><small><strong>Transaction remark:</strong> ${escapeHtml(txRemark)}</small>` : '<br><small>Optional. This explains the whole relocation only and does not replace any item Put-away/Stock-transfer remark.</small>'}`;

    note.innerHTML = heldLots.length
      ? `<strong>WHOLE-RACK TRANSFER BLOCKED BY ON-HOLD STOCK.</strong> ${heldLots.length.toLocaleString()} inventory line(s) in <strong>${escapeHtml(state.transfer.locationCode || 'this rack')}</strong> cannot be released. Unfreeze the held lot(s), or leave Whole Rack mode OFF and transfer only eligible lots.<br><small>Held stock remains physically visible in the rack but is excluded from normal item selection.</small>`
      : `<strong>WHOLE SOURCE-RACK / PALLET MODE ACTIVE.</strong> Completing this transfer will move every active stock balance from <strong>${escapeHtml(state.transfer.locationCode || 'the locked source')}</strong> to the destination: STANDARD stock plus all physical Shipper Boxes, while preserving each SB number and SEALED/OPEN status.<br><strong>${activeLots.length.toLocaleString()} active inventory lines · ${shipperBoxes.size.toLocaleString()} Shipper box${shipperBoxes.size === 1 ? '' : 'es'} currently detected.</strong><br><small>The system trace remains "Whole source-rack / pallet transfer". Existing individual human remarks are not replaced by that system trace.</small>${txRemarkHtml}<br><small>This is rack-level because the current WMS does not store a separate physical Pallet ID. If more than one pallet/container is stored in this rack, ALL active stock in the rack will move.</small>`;
    note.classList.remove('hidden');
  } else {
    $('tr-unit-label').textContent = 'matched unit';
    state.transfer.bulkTransactionRemark = null;
    note.classList.add('hidden');
    note.innerHTML = '';
    if (locked && $('tr-barcode').value.trim()) loadOperationLots('transfer');
  }

  syncOperationCompleteGuard('transfer');
}

function setTransferAllTransactionRemark() {
  if (!$('tr-transfer-all')?.checked || !state.transfer.lockToken) {
    return toast('Transfer ALL mode is not active.', 'error');
  }

  const existing = String(state.transfer.bulkTransactionRemark || '');
  const value = window.prompt(
    `TRANSFER ALL TRANSACTION REMARK\n\n` +
    `This optional remark explains the whole relocation only.\n\n` +
    `It WILL NOT overwrite any individual Put-away remark or Stock-transfer remark.\n` +
    `The WMS system trace "Whole source-rack / pallet transfer" remains separate.\n\n` +
    `Enter the transaction remark below. Leave it blank to remove the transaction remark.`,
    existing
  );

  if (value === null) return;
  const remark = value.trim();
  if (remark.length > 1000) return toast('Transfer ALL transaction remark is limited to 1,000 characters.', 'error');

  state.transfer.bulkTransactionRemark = remark || null;
  syncFullTransferMode();
  toast(remark ? 'Transfer ALL transaction remark saved for this unsaved session.' : 'Transfer ALL transaction remark cleared.', 'success');
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

  container.innerHTML = `<table><thead><tr><th>Item</th><th>Shipper box</th><th>Container</th><th>Expiry</th><th>Stock unit</th><th>Physical qty</th><th>Release status</th><th>Queued</th><th></th></tr></thead><tbody>${rows.map((lot) => {
    const queued = state.pick.cart.filter((x) => x.lot_id === lot.lot_id).reduce((sum, x) => sum + Number(x.qty), 0);
    const remaining = Math.max(Number(lot.qty) - queued, 0);
    const blocked = lot.is_releasable === false;
    const holdDetail = lot.is_on_hold
      ? escapeHtml(lot.hold_reason || 'Admin / Owner hold')
      : (blocked ? 'Blocked by an ON-HOLD lot in this physical Shipper Box' : '');
    const releaseStatus = blocked
      ? `<span class="pill expired">ON HOLD</span>${holdDetail ? `<br><small>${holdDetail}</small>` : ''}`
      : '<span class="pill">Available</span>';
    const bypassAction = blocked
      ? '<small>Release blocked</small>'
      : `<button class="link-btn" type="button" data-pick-bypass-lot="${lot.lot_id}">Request barcode bypass</button>`;
    return `<tr>
      <td class="wrap"><strong>${escapeHtml(lot.sku_name)}</strong></td>
      <td>${shipperBadge(lot)}</td>
      <td>${escapeHtml(lot.container_no)}</td>
      <td>${fmtDate(lot.expiry_date)} ${expiryPill(lot.expiry_status)}</td>
      <td><span class="pill">${escapeHtml(lot.uom)}</span></td>
      <td>${fmtQtyUom(remaining, lot.uom)}${queued ? `<br><small>Original: ${fmtQtyUom(lot.qty, lot.uom)}</small>` : ''}</td>
      <td class="wrap">${releaseStatus}</td>
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
  if ($('tr-transfer-all')?.checked) syncFullTransferMode();
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

  container.innerHTML = `<table><thead><tr><th>Item</th><th>Shipper box</th><th>Container</th><th>Expiry</th><th>Stock unit</th><th>Physical qty</th><th>Release status</th><th>Queued</th></tr></thead><tbody>${rows.map((lot) => {
    const queued = state.transfer.cart.filter((x) => x.lot_id === lot.lot_id).reduce((sum, x) => sum + Number(x.qty), 0);
    const remaining = Math.max(Number(lot.qty) - queued, 0);
    const blocked = lot.is_releasable === false;
    const holdDetail = lot.is_on_hold
      ? escapeHtml(lot.hold_reason || 'Admin / Owner hold')
      : (blocked ? 'Blocked by an ON-HOLD lot in this physical Shipper Box' : '');
    return `<tr>
      <td class="wrap"><strong>${escapeHtml(lot.sku_name)}</strong></td>
      <td>${shipperBadge(lot)}</td>
      <td>${escapeHtml(lot.container_no)}</td>
      <td>${fmtDate(lot.expiry_date)} ${expiryPill(lot.expiry_status)}</td>
      <td><span class="pill">${escapeHtml(lot.uom)}</span></td>
      <td>${fmtQtyUom(remaining, lot.uom)}${queued ? `<br><small>Original: ${fmtQtyUom(lot.qty, lot.uom)}</small>` : ''}</td>
      <td class="wrap">${blocked ? `<span class="pill expired">ON HOLD</span>${holdDetail ? `<br><small>${holdDetail}</small>` : ''}` : '<span class="pill">Available</span>'}</td>
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

    const allNaCandidates = (rackRows || []).filter(lotUsesNaBarcode);
    const candidates = allNaCandidates.filter((lot) => lot.is_releasable !== false);
    const skuIds = [...new Set(candidates.map((row) => row.sku_id).filter(Boolean))];
    let fefoRows = [];
    if (pick && skuIds.length) {
      const { data, error } = await supabase
        .from('v_inventory_details')
        .select('lot_id,sku_id,expiry_date,location_code,container_no,qty,uom')
        .in('sku_id', skuIds)
        .gt('qty', 0)
        .eq('is_releasable', true)
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
      const priority = pick ? pickPriorityRecommendation(lot, fefoRows, queuedByLot) : null;
      return {
        ...lot,
        effectiveQty,
        earliestExpiry: priority?.earliestExpiry || lot.expiry_date,
        earliestLocation: priority?.earliestLocation || opState.locationCode,
        earliestContainer: priority?.earliestContainer || lot.container_no,
        containerPrioritySuggested: Boolean(priority?.containerSuggested),
        suggestedContainer: priority?.suggestedContainer || null,
        suggestedContainerLocation: priority?.suggestedLocation || null,
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
      const heldMatches = allNaCandidates.filter((lot) => lot.is_releasable === false).length;
      note.textContent = heldMatches
        ? `${heldMatches} matching N/A stock lot(s) exist in ${opState.locationCode}, but they are ON HOLD and cannot be released.`
        : `No positive stock in ${opState.locationCode} has N/A recorded for the barcode corresponding to its CASE, PACK, or PIECE stock unit.`;
      return toast(heldMatches
        ? 'Matching N/A stock exists, but it is ON HOLD. Admin or Owner must unfreeze the lot before release.'
        : `No selectable N/A-barcode stock is available in ${opState.locationCode}.`, 'error');
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
      ? supabase.from('v_inventory_details').select('lot_id,sku_id,expiry_date,location_code,container_no,qty,uom,is_releasable').in('sku_id', skuIds).gt('qty', 0).eq('is_releasable', true).neq('expiry_status', 'EXPIRED').order('expiry_date')
      : Promise.resolve({ data: [], error: null })
  ]);
  if (rackError || fefoResult.error) return toast(friendlyError(rackError || fefoResult.error), 'error');

  const matchingRackRows = (rackRows || []).filter((lot) => pairKeys.has(`${lot.sku_id}|${String(lot.uom || '').toUpperCase()}`));
  const candidates = matchingRackRows.filter((lot) => lot.is_releasable !== false);
  const queuedByLot = new Map();
  opState.cart.forEach((line) => {
    queuedByLot.set(line.lot_id, (queuedByLot.get(line.lot_id) || 0) + Number(line.qty || 0));
  });

  opState.lots = candidates.map((lot) => {
    const effectiveQty = Math.max(Number(lot.qty || 0) - (queuedByLot.get(lot.lot_id) || 0), 0);
    const priority = pick ? pickPriorityRecommendation(lot, fefoResult.data || [], queuedByLot) : null;
    return {
      ...lot,
      effectiveQty,
      earliestExpiry: priority?.earliestExpiry || lot.expiry_date,
      earliestLocation: priority?.earliestLocation || opState.locationCode,
      earliestContainer: priority?.earliestContainer || lot.container_no,
      containerPrioritySuggested: Boolean(priority?.containerSuggested),
      suggestedContainer: priority?.suggestedContainer || null,
      suggestedContainerLocation: priority?.suggestedLocation || null,
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
          line.container_priority_suggested = Boolean(lot.containerPrioritySuggested);
          line.suggested_container = lot.suggestedContainer || null;
          line.suggested_container_location = lot.suggestedContainerLocation || null;
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
      const heldMatches = matchingRackRows.filter((lot) => lot.is_releasable === false).length;
      toast(heldMatches
        ? 'Matching stock exists in this rack, but it is ON HOLD. Admin or Owner must unfreeze the lot before release.'
        : `Barcode is valid, but no matching stock is available in ${opState.locationCode}.`, 'error');
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
  if (!state.pick.lockToken || !state.pick.locationCode) return toast('Lock the source rack first.', 'error');
  if (!state.session?.user?.id) return toast('Your warehouse session is no longer active. Sign in again.', 'error');
  const lot = state.pick.rackLots.find((row) => row.lot_id === lotId);
  if (!lot) return toast('The selected rack item is no longer available. Refresh the source rack.', 'error');
  if (lot.is_releasable === false) return toast('This inventory lot is ON HOLD and cannot be released or barcode-bypassed. Admin or Owner must unfreeze it first.', 'error');
  if (state.pick.cart.some((line) => line.lot_id === lotId && line.supervisor_bypass)) {
    return toast('An approved barcode bypass for this inventory lot is already queued. Remove it first if you need to change the quantity or reason.', 'error');
  }

  const reason = window.prompt(`Barcode bypass reason for ${lot.sku_name} (${lot.uom}). Explain why the barcode cannot be read:`);
  if (!reason?.trim()) return toast('A barcode bypass reason is required.', 'error');

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
    .eq('is_releasable', true)
    .neq('expiry_status', 'EXPIRED')
    .order('expiry_date');
  if (earliestError) return toast(friendlyError(earliestError), 'error');
  const queuedByLot = new Map();
  state.pick.cart.forEach((line) => {
    queuedByLot.set(line.lot_id, (queuedByLot.get(line.lot_id) || 0) + Number(line.qty || 0));
  });
  const priority = pickPriorityRecommendation(lot, fefoRows || [], queuedByLot);
  const earliestSameUnit = priority.earliestExpiry || lot.expiry_date;
  const fefoOverrideConfirmed = Boolean(earliestSameUnit && lot.expiry_date > earliestSameUnit);
  if (fefoOverrideConfirmed && !window.confirm(buildFefoOverrideConfirmMessage(lot, priority))) {
    return toast('Item was not added. The FEFO recommendation remains in effect.', 'error');
  }

  const containerPriorityDecision = fefoOverrideConfirmed
    ? { required: false, confirmed: false }
    : pickContainerPriorityConfirmation(lot, priority);
  if (containerPriorityDecision.required && !containerPriorityDecision.confirmed) {
    return toast('Item was not added. The earlier-container recommendation remains in effect.', 'error');
  }

  const visibleSo = $('pick-so').value.trim();
  const approvalSalesOrder = isStockAdjustmentSalesOrder(visibleSo) ? state.pick.adjustmentSessionKey : visibleSo;
  if (!approvalSalesOrder) return toast('The active Sales Order/session could not be identified. Cancel/restart the rack and try again.', 'error');

  const approval = await requestWarehouseApproval({
    title: 'Approve Unreadable Barcode Bypass',
    contextHtml: `<strong>${escapeHtml(lot.sku_name)}</strong><br>Sales Order: <strong>${escapeHtml(visibleSo || approvalSalesOrder)}</strong> · Rack: <strong>${escapeHtml(state.pick.locationCode)}</strong><br>Lot: ${escapeHtml(lot.container_no)} · ${fmtDate(lot.expiry_date)} · ${fmtQtyUom(qty, lot.uom)}<br>Reason: ${escapeHtml(reason.trim())}<br><span class="small-note">Approval is one-time, expires after 5 minutes, and is tied to this exact user, rack, Sales Order/session, inventory lot, quantity, and reason.</span>`,
    rpcName: 'approve_barcode_bypass_request',
    rpcArgs: {
      p_requested_by: state.session.user.id,
      p_sales_order: approvalSalesOrder,
      p_location_code: state.pick.locationCode,
      p_lot_id: lot.lot_id,
      p_qty: qty,
      p_reason: reason.trim()
    },
    confirmLabel: 'APPROVE BARCODE BYPASS'
  });
  if (!approval) return;

  state.pick.cart.push({
    lot_id: lot.lot_id,
    qty,
    barcode: null,
    supervisor_bypass: true,
    bypass_reason: reason.trim(),
    bypass_approval_token: approval.approval_token,
    bypass_approved_by: approval.approver_username || null,
    bypass_approved_role: approval.approver_role || null,
    sku_name: lot.sku_name,
    container_no: lot.container_no,
    expiry_date: lot.expiry_date,
    earliest_expiry: earliestSameUnit,
    earliest_location: priority.earliestLocation || state.pick.locationCode,
    earliest_container: priority.earliestContainer || lot.container_no,
    container_priority_suggested: Boolean(priority.containerSuggested),
    suggested_container: priority.suggestedContainer || null,
    suggested_container_location: priority.suggestedLocation || null,
    container_priority_override_confirmed: Boolean(containerPriorityDecision.confirmed),
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
  toast(`Barcode bypass approved by ${approval.approver_username || 'Supervisor'} (${String(approval.approver_role || '').toUpperCase()}) and queued for this rack.`, 'success');
}

function updatePickFefoNote() {
  const value = $('pick-lot').value;
  const note = $('pick-fefo-note');
  if (value === '') return note.classList.add('hidden');

  const index = Number(value);
  const lot = state.pick.lots[index];
  if (!lot) return note.classList.add('hidden');

  // Priority 1: existing FEFO rule. If a genuinely earlier expiry exists,
  // show FEFO only and do not distract the picker with container sequencing.
  if (lot.earliestExpiry && lot.expiry_date > lot.earliestExpiry) {
    const where = lot.earliestLocation
      ? ` at <strong>${escapeHtml(lot.earliestLocation)}</strong>${lot.earliestContainer ? ` / container <strong>${escapeHtml(lot.earliestContainer)}</strong>` : ''}`
      : '';
    note.innerHTML = `FEFO warning: selected expiry <strong>${fmtDate(lot.expiry_date)}</strong>, but the earliest CURRENT non-expired positive stock expires <strong>${fmtDate(lot.earliestExpiry)}</strong>${where}. Completing this line will be recorded as an override.`;
    note.classList.remove('hidden');
    return;
  }

  // Priority 2: only after expiry is tied, use the earliest valid
  // YYYY-BB / YYYY-BBB shipment container. Choosing a later eligible container
  // requires explicit confirmation for normal Sales Order Picking and is audited
  // only after the Pick is successfully saved.
  if (lot.containerPrioritySuggested && lot.suggestedContainer) {
    const where = lot.suggestedContainerLocation
      ? ` at <strong>${escapeHtml(lot.suggestedContainerLocation)}</strong>`
      : '';
    note.innerHTML = `<strong>Earlier shipment priority:</strong> selected container <strong>${escapeHtml(lot.container_no)}</strong>, but earlier container <strong>${escapeHtml(lot.suggestedContainer)}</strong>${where} has the same priority expiry <strong>${fmtDate(lot.expiry_date)}</strong>. Expiry / FEFO remains first priority; container sequencing is used only when expiry is tied. For a normal Sales Order, choosing the later container requires confirmation and the saved override is recorded in System Audit.`;
    note.classList.remove('hidden');
    return;
  }

  note.classList.add('hidden');
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
  if (lot.is_releasable === false) return toast('This inventory lot is ON HOLD and cannot be picked or transferred. Admin or Owner must unfreeze it first.', 'error');

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
  if (fefoOverrideConfirmed && !window.confirm(buildFefoOverrideConfirmMessage(lot))) {
    return toast('Item was not added. The FEFO recommendation remains in effect.', 'error');
  }

  const containerPriorityDecision = pick && !fefoOverrideConfirmed
    ? pickContainerPriorityConfirmation(lot, {
        containerSuggested: Boolean(lot.containerPrioritySuggested),
        suggestedContainer: lot.suggestedContainer || null,
        suggestedLocation: lot.suggestedContainerLocation || null
      })
    : { required: false, confirmed: false };
  if (containerPriorityDecision.required && !containerPriorityDecision.confirmed) {
    return toast('Item was not added. The earlier-container recommendation remains in effect.', 'error');
  }

  opState.cart.push({
    lot_id: lot.lot_id,
    qty,
    barcode: lot.scannedBarcode,
    user_remark: pick ? null : ($('tr-note').value.trim() || null),
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
    container_priority_suggested: Boolean(lot.containerPrioritySuggested),
    suggested_container: lot.suggestedContainer || null,
    suggested_container_location: lot.suggestedContainerLocation || null,
    container_priority_override_confirmed: Boolean(containerPriorityDecision.confirmed),
    fefo_override_confirmed: fefoOverrideConfirmed,
    available: Number(lot.qty),
    uom: lot.uom,
    shipper_box_id: lot.shipper_box_id || null,
    shipper_box_no: lot.shipper_box_no || null,
    shipper_status: lot.shipper_status || null,
    shipper_lot_role: lot.shipper_lot_role || null,
    supervisor_bypass: false,
    bypass_reason: null,
    bypass_approval_token: null,
    bypass_approved_by: null,
    bypass_approved_role: null
  });
  renderOperationCart(operation);
  if (pick) {
    renderPickRackContents();
    renderPickSalesOrderSummary();
  } else {
    renderTransferRackContents();
  }
  $(pick ? 'pick-qty' : 'tr-qty').value = '';

  const barcodeInput = $(pick ? 'pick-barcode' : 'tr-barcode');
  barcodeInput.value = '';
  if (pick) {
    clearPickBarcodeMatch('Item added. Scan or type the next barcode, or complete this rack.');
    updatePickQtyNote();
  } else {
    $('tr-note').value = '';
    clearTransferBarcodeMatch('Item added. Scan or type the next barcode, or complete the transfer.');
    updateTransferQtyNote();
  }
  syncOperationCompleteGuard(operation);

  toast(`${fmtQtyUom(qty, lot.uom)} added to the ${pick ? 'picking' : 'transfer'} session.`, 'success');
}

function pickContainerPriorityCartStatusHtml(row) {
  if (row?.fefo_override_confirmed) return '';
  if (row?.container_priority_override_confirmed && row?.suggested_container) {
    const where = row.suggested_container_location ? ` at ${escapeHtml(row.suggested_container_location)}` : '';
    return `<br><span class="pill override">Container-priority override confirmed</span><br><small>Earlier container ${escapeHtml(row.suggested_container)}${where} was available.</small>`;
  }
  if (row?.container_priority_suggested && row?.suggested_container) {
    return `<br><span class="pill near">Earlier container ${escapeHtml(row.suggested_container)} available</span>`;
  }
  return '';
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
  const transferHeader = pick ? '' : `<div class="info-box"><strong>Transfer summary:</strong> ${rows.length.toLocaleString()} line(s) queued from ${escapeHtml(state.transfer.locationCode || '—')} · ${formatBalances(totals)}. Review these items and their individual remarks before clicking Complete transfer.</div>`;

  container.innerHTML = `${transferHeader}<table><thead><tr>${pick ? '' : '<th>Item details</th>'}<th>SKU</th><th>Shipper box</th><th>Container</th><th>Expiry</th><th>Quantity</th>${pick ? '' : '<th>Remarks</th>'}<th>Barcode control</th><th></th></tr></thead><tbody>${rows.map((r, i) => `<tr>
    ${pick ? '' : `<td class="wrap"><strong>${escapeHtml([r.brand, r.description, r.variant, r.size].filter(Boolean).join(' '))}</strong><br><small>Source: ${escapeHtml(state.transfer.locationCode || '—')}</small></td>`}
    <td class="wrap">${escapeHtml(r.sku_name)}</td><td>${r.shipper_box_id ? `<span class="pill near">${escapeHtml(r.shipper_box_no || 'Shipper')} · ${escapeHtml(r.shipper_lot_role === 'HEADER' ? 'Complete' : 'Content')}</span>` : '<span class="pill">Loose</span>'}</td><td>${escapeHtml(r.container_no)}</td><td>${fmtDate(r.expiry_date)}</td><td>${fmtQtyUom(r.qty, r.uom)}</td>
    ${pick ? '' : `<td class="wrap">${escapeHtml(r.user_remark || '—')}</td>`}
    <td class="wrap">${pick
      ? (r.supervisor_bypass
        ? `<span class="pill override">Approved barcode bypass</span><br><small>${escapeHtml(r.bypass_reason || '')}</small>${r.bypass_approved_by ? `<br><small>Approved by ${escapeHtml(r.bypass_approved_by)} (${escapeHtml(String(r.bypass_approved_role || '').toUpperCase())})</small>` : ''}${pickContainerPriorityCartStatusHtml(r)}`
        : `${normalizeBarcode(r.barcode) === 'N/A'
          ? `<span class="pill near">N/A ${escapeHtml((r.uom || '').toUpperCase())} selected</span>`
          : `<span class="pill">${escapeHtml((r.uom || '').toUpperCase())} barcode verified</span>`}${r.fefo_override_confirmed ? '<br><span class="pill override">FEFO override confirmed</span>' : ''}${pickContainerPriorityCartStatusHtml(r)}`)
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
    $('tr-transfer-all').checked = false;
    $('tr-transfer-all').disabled = true;
    $('tr-transfer-all-note').classList.add('hidden');
    $('tr-transfer-all-note').innerHTML = '';
    $('tr-rack-title').textContent = 'Source rack contents';
    $('tr-rack-contents').innerHTML = emptyState('Lock a source rack to display its available items.');
    clearTransferBarcodeMatch();
    $('tr-qty-note').textContent = '';
    $('tr-qty-note').classList.add('hidden');
  }
  configureOperationUi(operation, false);
  renderOperationCart(operation);
}



function resetPickCorrectionReporting() {
  state.pickOrderSummary = [];
  state.pickOrderCorrections = [];
  state.pickRequestedCorrectionCount = 0;
  state.pickPendingReturnCount = 0;
  state.pickBlockingPendingReturnCount = 0;
}

async function loadPickSalesOrderSummary() {
  const so = $('pick-so').value.trim();
  if (isStockAdjustmentSalesOrder(so)) {
    resetPickCorrectionReporting();
    renderPickSalesOrderSummary();
    updatePickSalesOrderControls();
    return;
  }
  if (!so || state.pickOrder.status === 'NEW' || !state.pickOrder.status) {
    resetPickCorrectionReporting();
    renderPickSalesOrderSummary();
    updatePickSalesOrderControls();
    return;
  }

  const [summaryRes, correctionRes] = await Promise.all([
    supabase.rpc('get_pick_sales_order_summary_with_corrections', { p_sales_order: so }),
    supabase.rpc('get_saved_pick_corrections', { p_sales_order: so })
  ]);

  if (summaryRes.error || correctionRes.error) {
    state.pickOrderSummary = [];
    state.pickOrderCorrections = [];
    state.pickRequestedCorrectionCount = -1;
    state.pickPendingReturnCount = -1;
    state.pickBlockingPendingReturnCount = -1;
    $('pick-order-summary').innerHTML = `<div class="warning-box">${escapeHtml(friendlyError(summaryRes.error || correctionRes.error))}</div>`;
    updatePickSalesOrderControls();
    return;
  }

  state.pickOrderSummary = summaryRes.data || [];
  state.pickOrderCorrections = correctionRes.data || [];
  state.pickRequestedCorrectionCount = state.pickOrderCorrections.filter((r) => r.correction_status === 'REQUESTED').length;
  state.pickPendingReturnCount = state.pickOrderCorrections.filter((r) => r.correction_status === 'PENDING_RETURN').length;
  state.pickBlockingPendingReturnCount = state.pickOrderCorrections.filter((r) =>
    r.correction_status === 'PENDING_RETURN' && !r.finish_override_at
  ).length;

  renderPickSalesOrderSummary();
  updatePickSalesOrderControls();
}

function savedPickLineStatus(row) {
  if (row.line_status === 'QUEUED') return '<span class="pill near">QUEUED</span>';
  if (Number(row.requested_correction_qty || 0) > 0) return '<span class="pill override">CORRECTION REQUESTED</span>';
  if (Number(row.pending_return_qty || 0) > 0) return '<span class="pill near">RETURN PENDING</span>';
  if (Number(row.completed_correction_qty || 0) > 0) return '<span class="pill active">CORRECTED</span>';
  return '<span class="pill">SAVED</span>';
}

function savedPickPhysicalStateLabel(value) {
  return value === 'STILL_IN_ORIGINAL_RACK'
    ? 'Stock reported still in original rack'
    : 'Physical return required';
}

function renderSavedPickCorrections() {
  const rows = state.pickOrderCorrections || [];
  if (!rows.length) return '';

  const requested = rows.filter((r) => r.correction_status === 'REQUESTED');
  const pending = rows.filter((r) => r.correction_status === 'PENDING_RETURN');
  const blockingPending = pending.filter((r) => !r.finish_override_at);

  const canEmergencyFinish = state.mode === 'ACTIVE'
    && state.pickOrder.status === 'OPEN'
    && requested.length === 0
    && blockingPending.length > 0
    && !state.pick.lockToken;

  let warning = '';
  if (requested.length) {
    warning = `<div class="warning-box">
      <strong>${requested.length} Saved Pick mistake report${requested.length===1?' is':'s are'} awaiting Supervisor review.</strong>
      Finish Sales Order is blocked. Emergency Finish is intentionally unavailable until the reported quantity/status has been reviewed.
    </div>`;
  } else if (blockingPending.length) {
    warning = `<div class="warning-box">
      <strong>${blockingPending.length} approved physical return${blockingPending.length===1?'':'s'} must still be completed.</strong>
      Normal Finish Sales Order is blocked until rack/barcode return confirmation.
      ${canEmergencyFinish ? `<button type="button" class="danger" data-emergency-finish-saved-pick="1">Emergency finish with approval</button>` : ''}
    </div>`;
  } else if (pending.length) {
    warning = `<div class="warning-box">
      <strong>${pending.length} physical return${pending.length===1?'':'s'} remain unresolved after an approved Emergency Finish.</strong>
      The Sales Order may be closed, but these stock returns remain real warehouse obligations and stay on the Dashboard.
    </div>`;
  }

  return `${warning}
    <div class="card-head compact">
      <div><h4>Saved Pick mistake reports / corrections</h4>
      <p>Picker reports first. Supervisor/Admin/Owner reviews. Original SAVED rows remain immutable.</p></div>
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>Status</th><th>Item</th><th>Picker report</th><th>Supervisor review</th><th>Rack / container</th><th>People / time</th><th>Action</th>
    </tr></thead><tbody>${rows.map((r) => {
      let status = '<span class="pill">UNKNOWN</span>';
      if (r.correction_status === 'REQUESTED') status = '<span class="pill override">CORRECTION REQUESTED</span>';
      if (r.correction_status === 'REJECTED') status = '<span class="pill">REJECTED</span>';
      if (r.correction_status === 'PENDING_RETURN') status = `<span class="pill near">RETURN PENDING</span>${r.finish_override_at ? '<br><span class="pill override">SO FINISH OVERRIDDEN</span>' : ''}`;
      if (r.correction_status === 'COMPLETED') status = `<span class="pill active">COMPLETED</span>${r.correction_mode === 'STILL_IN_ORIGINAL_RACK' ? '<br><small>Supervisor confirmed stock never left rack</small>' : '<br><small>Physical return confirmed</small>'}`;

      const report = `${fmtQtyUom(r.reported_qty,r.uom)}<br><small>${escapeHtml(savedPickPhysicalStateLabel(r.reported_physical_state))}</small><br><span class="small-note">${escapeHtml(r.report_reason || '—')}</span>`;

      const review = r.correction_status === 'REQUESTED'
        ? '<small>Awaiting Supervisor review</small>'
        : (r.correction_status === 'REJECTED'
            ? `<strong>Rejected</strong>${r.review_note ? `<br><small>${escapeHtml(r.review_note)}</small>` : ''}`
            : `<strong>${fmtQtyUom(r.correction_qty || 0,r.uom)}</strong><br><small>${escapeHtml(savedPickPhysicalStateLabel(r.correction_mode))}</small>${r.review_note ? `<br><small>${escapeHtml(r.review_note)}</small>` : ''}`);

      const people = `Reported by ${escapeHtml(r.reported_by_username || '—')}<br><small>${fmtDateTime(r.reported_at)}</small>${r.reviewed_by_username ? `<br>Reviewed by ${escapeHtml(r.reviewed_by_username)} (${escapeHtml(String(r.reviewed_role || '').toUpperCase())})<br><small>${fmtDateTime(r.reviewed_at)}</small>` : ''}${r.returned_by_username ? `<br>Completed by ${escapeHtml(r.returned_by_username)}<br><small>${fmtDateTime(r.returned_at)}</small>` : ''}`;

      let action = '—';
      if (r.correction_status === 'REQUESTED' && r.can_review) {
        action = `<button type="button" class="secondary" data-saved-pick-review="${escapeHtml(r.correction_id)}">Review</button>`;
      } else if (r.correction_status === 'REQUESTED') {
        action = '<small>Awaiting Supervisor</small>';
      } else if (r.correction_status === 'PENDING_RETURN' && r.can_complete_return) {
        action = `<button type="button" class="secondary" data-saved-pick-return="${escapeHtml(r.correction_id)}">Complete return</button>`;
      }

      return `<tr>
        <td>${status}</td>
        <td class="wrap"><strong>${escapeHtml(r.sku_name || '—')}</strong><br><small>Original ${escapeHtml(r.original_transaction_no || '—')} · ${fmtDateTime(r.original_picked_at)}</small></td>
        <td>${report}</td>
        <td>${review}</td>
        <td><strong>${escapeHtml(r.expected_location_code || r.original_location_code || '—')}</strong><br><small>${escapeHtml(r.container_no || '—')} · ${fmtDate(r.expiry_date)}</small></td>
        <td>${people}${r.finish_override_reason ? `<br><small>Emergency finish: ${escapeHtml(r.finish_override_reason)}</small>` : ''}</td>
        <td>${action}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
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

  const saved = (state.pickOrderSummary || []).map((row) => ({
    ...row,
    line_status:'SAVED',
    summary_qty:Number(row.net_picked_qty ?? row.picked_qty)
  }));

  const queued = (state.pick.cart || []).map((row) => ({
    transaction_no:'Current rack',
    picked_at:null,
    location_code:state.pick.locationCode || '—',
    brand:row.brand || '',
    description:row.description || row.sku_name || '',
    variant:row.variant || '',
    size:row.size || '',
    container_no:row.container_no,
    expiry_date:row.expiry_date,
    uom:row.uom,
    picked_qty:row.qty,
    net_picked_qty:row.qty,
    summary_qty:row.qty,
    line_status:'QUEUED'
  }));

  const rows = [...saved,...queued];
  const correctionHtml = renderSavedPickCorrections();

  if (!rows.length) {
    container.innerHTML = emptyState(`No retained current-cycle pick lines are available for sales order ${so}.`) + correctionHtml;
    return;
  }

  const totals = sumByUom(rows,'summary_qty');
  const racks = new Set(rows.map((r) => r.location_code).filter(Boolean));
  const openIssues = Math.max(Number(state.pickRequestedCorrectionCount || 0),0) + Math.max(Number(state.pickPendingReturnCount || 0),0);
  const issueText = openIssues
    ? ` · ${openIssues} correction item${openIssues===1?'':'s'} open`
    : '';

  container.innerHTML = `<div class="info-box">
      <strong>${escapeHtml(so)} net progress:</strong> ${formatBalances(totals)} · ${racks.size.toLocaleString()} rack${racks.size===1?'':'s'} represented${issueText}.
      SAVED lines remain immutable. A reported mistake does not reduce the net until the approved stock is actually restored.
    </div>
    <table><thead><tr><th>Status</th><th>Rack</th><th>Item</th><th>Container</th><th>Expiry</th><th>Picked / correction / net</th><th>Transaction / time</th><th>Action</th></tr></thead><tbody>${rows.map((r) => {
      const item = [r.brand,r.description,r.variant,r.size].filter(Boolean).join(' ') || r.sku_name || '—';

      if (r.line_status === 'QUEUED') {
        return `<tr><td>${savedPickLineStatus(r)}</td><td>${escapeHtml(r.location_code || '—')}</td><td class="wrap"><strong>${escapeHtml(item)}</strong></td><td>${escapeHtml(r.container_no || '—')}</td><td>${fmtDate(r.expiry_date)}</td><td>${fmtQtyUom(r.picked_qty,r.uom)}</td><td>Current rack</td><td>—</td></tr>`;
      }

      const corrected = Number(r.completed_correction_qty || 0);
      const requestedQty = Number(r.requested_correction_qty || 0);
      const pending = Number(r.pending_return_qty || 0);
      const remaining = Number(r.remaining_reportable_qty || 0);
      const net = Number(r.net_picked_qty ?? r.picked_qty);

      const qtyText = `Original: ${fmtQtyUom(r.picked_qty,r.uom)}
        ${requestedQty ? `<br><span class="pill override">Reported ${fmtQtyUom(requestedQty,r.uom)} awaiting review</span>` : ''}
        ${pending ? `<br><span class="pill near">Approved return ${fmtQtyUom(pending,r.uom)} pending</span>` : ''}
        ${corrected ? `<br><strong>Completed correction: ${fmtQtyUom(corrected,r.uom)}</strong>` : ''}
        <br>Net saved pick: <strong>${fmtQtyUom(net,r.uom)}</strong>`;

      const actorMayReport = isSupervisor() || r.original_picker_id === state.session?.user?.id;
      const unresolved = Number(r.unresolved_request_count || 0) > 0;
      const canReport = state.mode === 'ACTIVE'
        && state.pickOrder.status === 'OPEN'
        && !state.pick.lockToken
        && Boolean(r.correction_eligible)
        && actorMayReport
        && remaining > 0
        && !unresolved;

      let action = '—';
      if (canReport) {
        action = `<button type="button" class="secondary" data-saved-pick-report="${escapeHtml(r.transaction_line_id)}">Report mistake</button>`;
      } else if (r.correction_eligible === false) {
        action = `<small>${escapeHtml(r.correction_block_reason || 'Protected line')}</small>`;
      } else if (unresolved) {
        action = '<small>Correction already open</small>';
      } else if (remaining <= 0) {
        action = '<small>Fully corrected</small>';
      } else if (!actorMayReport) {
        action = '<small>Original picker / Supervisor+ only</small>';
      } else if (state.pick.lockToken) {
        action = '<small>Finish current rack first</small>';
      }

      return `<tr>
        <td>${savedPickLineStatus(r)}</td>
        <td>${escapeHtml(r.location_code || '—')}</td>
        <td class="wrap"><strong>${escapeHtml(item)}</strong><br><small>Picked by ${escapeHtml(r.original_picker_username || '—')}</small></td>
        <td>${escapeHtml(r.container_no || '—')}</td>
        <td>${fmtDate(r.expiry_date)}</td>
        <td>${qtyText}</td>
        <td>${escapeHtml(r.transaction_no || '—')}${r.picked_at ? `<br><small>${fmtDateTime(r.picked_at)}</small>` : ''}</td>
        <td>${action}</td>
      </tr>`;
    }).join('')}</tbody></table>${correctionHtml}`;
}

function findSavedPickCorrection(correctionId) {
  return (state.pickOrderCorrections || []).find((r) => r.correction_id === correctionId)
    || (state.dashboardPendingPickReturns || []).find((r) => r.correction_id === correctionId)
    || null;
}

function openSavedPickMistakeReport(lineId) {
  const row = (state.pickOrderSummary || []).find((r) => r.transaction_line_id === lineId);
  if (!row) return toast('SAVED Pick line was not found. Refresh the Sales Order summary and try again.', 'error');
  if (state.mode !== 'ACTIVE') return toast('Administrative Pause is active.', 'error');
  if (state.pick.lockToken) return toast('Complete or cancel the current rack before reporting a SAVED Pick mistake.', 'error');
  if (state.pickOrder.status !== 'OPEN') return toast('Only an OPEN Sales Order can receive a new Saved Pick mistake report.', 'error');
  if (!row.correction_eligible) return toast(row.correction_block_reason || 'This SAVED line is protected from automatic correction.', 'error');

  const actorMayReport = isSupervisor() || row.original_picker_id === state.session?.user?.id;
  if (!actorMayReport) return toast('Only the original picker or Supervisor/Admin/Owner may report this SAVED Pick line.', 'error');

  if (Number(row.unresolved_request_count || 0) > 0) {
    return toast('This SAVED line already has an unresolved correction request/return.', 'error');
  }

  const remaining = Number(row.remaining_reportable_qty || 0);
  if (remaining <= 0) return toast('This SAVED line has no remaining correctable quantity.', 'error');

  const item = [row.brand,row.description,row.variant,row.size].filter(Boolean).join(' ') || 'SKU';
  $('saved-pick-correction-line-id').value = row.transaction_line_id;
  $('saved-pick-correction-context').innerHTML = `<strong>${escapeHtml(item)}</strong><br>
    Sales Order: <strong>${escapeHtml($('pick-so').value.trim())}</strong> · Original transaction: ${escapeHtml(row.transaction_no)}<br>
    Picker: ${escapeHtml(row.original_picker_username || '—')} · Rack: <strong>${escapeHtml(row.location_code)}</strong><br>
    Container: ${escapeHtml(row.container_no)} · Expiry: ${fmtDate(row.expiry_date)}<br>
    Original SAVED quantity: ${fmtQtyUom(row.picked_qty,row.uom)} · Remaining reportable: <strong>${fmtQtyUom(remaining,row.uom)}</strong>`;

  $('saved-pick-correction-qty').value = '';
  $('saved-pick-correction-qty').max = String(remaining);
  $('saved-pick-correction-qty').dataset.uom = row.uom;
  $('saved-pick-correction-mode').value = 'PHYSICAL_RETURN';
  $('saved-pick-correction-reason').value = '';
  $('saved-pick-correction-dialog').showModal();
  $('saved-pick-correction-qty').focus();
}

async function submitSavedPickMistakeReport(event) {
  event.preventDefault();
  const lineId = $('saved-pick-correction-line-id').value;
  const qty = Number($('saved-pick-correction-qty').value);
  const physicalState = $('saved-pick-correction-mode').value;
  const reason = $('saved-pick-correction-reason').value.trim();

  if (!Number.isInteger(qty) || qty <= 0) {
    return toast('Reported correction quantity must be a whole number greater than zero.', 'error');
  }
  if (!reason) return toast('Enter why the SAVED Pick is wrong.', 'error');

  if (!window.confirm('Report this SAVED Pick mistake for Supervisor review? No Inventory quantity will change yet.')) return;

  const button = event.submitter;
  setBusy(button,true,'Reporting mistake…');

  const { data,error } = await supabase.rpc('report_saved_pick_mistake', {
    p_transaction_line_id:lineId,
    p_reported_qty:qty,
    p_physical_state:physicalState,
    p_reason:reason
  });

  setBusy(button,false);
  if (error) return toast(friendlyError(error),'error');

  $('saved-pick-correction-dialog').close();
  const result = data?.[0];
  toast(`Correction request reported by ${result?.reported_by_username || 'warehouse user'}. Inventory was not changed; Supervisor review is now required.`, 'success');
  invalidateReports();
  await loadPickSalesOrderSummary();
}

function openSavedPickReview(correctionId) {
  if (!isSupervisor()) return toast('Supervisor/Admin/Owner access is required to review Saved Pick corrections.', 'error');

  const row = findSavedPickCorrection(correctionId);
  if (!row) return toast('Saved Pick correction request was not found. Refresh and try again.', 'error');
  if (row.correction_status !== 'REQUESTED') return toast('This correction request is no longer awaiting review.', 'error');
  if (row.can_review === false) return toast('Supervisor/Admin/Owner review is required.', 'error');

  $('saved-pick-review-id').value = correctionId;
  $('saved-pick-review-context').innerHTML = `<strong>${escapeHtml(row.sku_name || 'SKU')}</strong><br>
    Sales Order: <strong>${escapeHtml(row.sales_order)}</strong> · Original transaction: ${escapeHtml(row.original_transaction_no || '—')}<br>
    Original picker: ${escapeHtml(row.original_picker_username || '—')} · Reported by: ${escapeHtml(row.reported_by_username || '—')}<br>
    Original rack: <strong>${escapeHtml(row.expected_location_code || row.original_location_code || '—')}</strong> · Container: ${escapeHtml(row.container_no || '—')} · Expiry: ${fmtDate(row.expiry_date)}<br>
    Picker reported: <strong>${fmtQtyUom(row.reported_qty,row.uom)}</strong> · ${escapeHtml(savedPickPhysicalStateLabel(row.reported_physical_state))}<br>
    <span class="small-note">Reason: ${escapeHtml(row.report_reason || '—')}</span>`;

  $('saved-pick-review-qty').value = String(row.reported_qty || '');
  $('saved-pick-review-qty').min = '1';
  $('saved-pick-review-qty').max = String(row.original_picked_qty || row.reported_qty || '');
  $('saved-pick-review-qty').dataset.uom = row.uom;
  $('saved-pick-review-mode').value = row.reported_physical_state || 'PHYSICAL_RETURN';
  $('saved-pick-review-note').value = '';
  $('saved-pick-review-dialog').showModal();
  $('saved-pick-review-qty').focus();
}

async function submitSavedPickReviewApproval(event) {
  event.preventDefault();

  const correctionId = $('saved-pick-review-id').value;
  const row = findSavedPickCorrection(correctionId);
  if (!row) return toast('Correction request was not found. Refresh and try again.', 'error');

  const qty = Number($('saved-pick-review-qty').value);
  const mode = $('saved-pick-review-mode').value;
  const note = $('saved-pick-review-note').value.trim();

  if (!Number.isInteger(qty) || qty <= 0) {
    return toast('Approved correction quantity must be a whole number greater than zero.', 'error');
  }

  const changed = qty !== Number(row.reported_qty || 0) || mode !== row.reported_physical_state;
  if (changed && note.length < 3) {
    return toast('Enter a Supervisor review note because you changed the picker-reported quantity or physical status.', 'error');
  }

  if (mode === 'STILL_IN_ORIGINAL_RACK') {
    const ok = window.confirm(
      `Confirm that ${fmtQtyUom(qty,row.uom)} NEVER physically left rack ${row.expected_location_code || row.original_location_code}. ` +
      'Approval will restore this quantity to Inventory immediately without a return scan.'
    );
    if (!ok) return;
  } else {
    const ok = window.confirm(
      `Approve ${fmtQtyUom(qty,row.uom)} for physical return to rack ${row.expected_location_code || row.original_location_code}? ` +
      'Inventory will NOT be restored until the assigned picker or Supervisor confirms the rack and barcode.'
    );
    if (!ok) return;
  }

  const button = event.submitter;
  setBusy(button,true,mode === 'STILL_IN_ORIGINAL_RACK' ? 'Approving + restoring…' : 'Approving return…');

  const { data,error } = await supabase.rpc('review_saved_pick_correction', {
    p_correction_id:correctionId,
    p_decision:'APPROVE',
    p_correction_qty:qty,
    p_mode:mode,
    p_review_note:note || null
  });

  setBusy(button,false);
  if (error) return toast(friendlyError(error),'error');

  $('saved-pick-review-dialog').close();
  const result = data?.[0];
  toast(result?.correction_status === 'COMPLETED'
    ? 'Correction approved. Supervisor confirmed the excess never left the original rack, so stock was restored immediately.'
    : `Correction approved. Physical return of ${fmtQtyUom(result?.correction_qty || qty,row.uom)} is now assigned to ${result?.assigned_to_username || 'the original picker'}.`,
    'success');

  invalidateReports();
  if (state.currentScreen === 'dashboard') await loadDashboard();
  if ($('pick-so')?.value?.trim()) await loadPickSalesOrderSummary();
}

async function submitSavedPickReviewRejection() {
  const correctionId = $('saved-pick-review-id').value;
  const note = $('saved-pick-review-note').value.trim();
  if (note.length < 3) return toast('Enter the rejection reason in Supervisor review note.', 'error');
  if (!window.confirm('Reject this Saved Pick correction request? No Inventory quantity will change.')) return;

  const button = $('saved-pick-review-reject');
  setBusy(button,true,'Rejecting…');

  const { data,error } = await supabase.rpc('review_saved_pick_correction', {
    p_correction_id:correctionId,
    p_decision:'REJECT',
    p_correction_qty:null,
    p_mode:null,
    p_review_note:note
  });

  setBusy(button,false);
  if (error) return toast(friendlyError(error),'error');

  $('saved-pick-review-dialog').close();
  toast('Saved Pick correction request rejected. Inventory was not changed.', 'success');
  invalidateReports();
  if (state.currentScreen === 'dashboard') await loadDashboard();
  if ($('pick-so')?.value?.trim()) await loadPickSalesOrderSummary();
}

function openSavedPickReturn(correctionId) {
  const row = findSavedPickCorrection(correctionId);
  if (!row) return toast('Pending Saved Pick return was not found. Refresh and try again.', 'error');
  if (row.correction_status !== 'PENDING_RETURN') return toast('This correction is not waiting for a physical return.', 'error');
  if (row.can_complete_return === false) return toast('This return is assigned to the original picker. Supervisor/Admin/Owner may also complete it.', 'error');

  $('saved-pick-return-id').value = correctionId;
  $('saved-pick-return-context').innerHTML = `<strong>${escapeHtml(row.sku_name || 'SKU')}</strong><br>
    Sales Order: <strong>${escapeHtml(row.sales_order)}</strong> · Return ${fmtQtyUom(row.correction_qty,row.uom)}<br>
    Required rack: <strong>${escapeHtml(row.expected_location_code || '—')}</strong> · Container: ${escapeHtml(row.container_no || '—')} · Expiry: ${fmtDate(row.expiry_date)}<br>
    <span class="small-note">Picker report: ${escapeHtml(row.report_reason || '—')}</span>`;

  $('saved-pick-return-location').value = '';
  $('saved-pick-return-barcode').value = '';
  $('saved-pick-return-dialog').showModal();
  $('saved-pick-return-location').focus();
}

async function submitSavedPickReturn(event) {
  event.preventDefault();
  const correctionId = $('saved-pick-return-id').value;
  const location = $('saved-pick-return-location').value.trim();
  const barcode = $('saved-pick-return-barcode').value.trim();

  if (!location) return toast('Scan or enter the required original return rack.', 'error');
  if (!barcode) return toast('Scan the registered unit barcode, or use N/A only when that UOM is registered N/A.', 'error');

  const button = event.submitter;
  setBusy(button,true,'Confirming return…');

  const { data,error } = await supabase.rpc('complete_saved_pick_return', {
    p_correction_id:correctionId,
    p_location_code:location,
    p_barcode:barcode
  });

  setBusy(button,false);
  if (error) return toast(friendlyError(error),'error');

  $('saved-pick-return-dialog').close();
  const row = data?.[0];
  toast(`Return completed: ${fmtQtyUom(row?.restored_qty || 0,row?.uom)} restored to ${row?.returned_location_code || location}.`, 'success');

  invalidateReports();
  if (state.currentScreen === 'dashboard') await loadDashboard();
  if ($('pick-so')?.value?.trim()) await loadPickSalesOrderSummary();
}

async function emergencyFinishSalesOrderWithPendingReturn() {
  const so = $('pick-so').value.trim();

  if (!so || state.pickOrder.status !== 'OPEN') return toast('An OPEN Sales Order is required.', 'error');
  if (state.pick.lockToken) return toast('Complete or cancel the current rack first.', 'error');
  if (state.pickRequestedCorrectionCount > 0) return toast('Emergency Finish is unavailable while a Saved Pick mistake is awaiting Supervisor review.', 'error');
  if (state.pickBlockingPendingReturnCount <= 0) return toast('There is no approved unresolved physical return requiring Emergency Finish.', 'error');

  const reason = window.prompt('Emergency Finish reason (required). Explain why the Sales Order must close before the approved physical return is completed:');
  if (!reason?.trim()) return toast('Emergency Finish was cancelled because a reason is required.', 'error');

  const approval = await requestWarehouseApproval({
    title:'Approve Emergency Finish with Pending Saved Pick Return',
    contextHtml:`<strong>Sales Order ${escapeHtml(so)}</strong><br>
      ${state.pickBlockingPendingReturnCount} approved physical return${state.pickBlockingPendingReturnCount===1?'':'s'} will remain PENDING after the Sales Order closes.<br>
      <strong>This approval does NOT restore stock and does NOT mark any return complete.</strong><br>
      Reason: ${escapeHtml(reason.trim())}`,
    rpcName:'approve_saved_pick_emergency_finish',
    rpcArgs:{
      p_requested_by:state.session.user.id,
      p_sales_order:so,
      p_reason:reason.trim()
    },
    confirmLabel:'APPROVE EMERGENCY FINISH'
  });

  if (!approval?.approval_token) return;

  const { data,error } = await supabase.rpc('finish_pick_sales_order_with_pending_return_override', {
    p_sales_order:so,
    p_reason:reason.trim(),
    p_approval_token:approval.approval_token
  });

  if (error) return toast(friendlyError(error),'error');

  const row = data?.[0];
  toast(`Sales Order ${row?.result_sales_order || so} finished by approved exception. ${Number(row?.pending_return_count || 0)} physical return(s) remain unresolved and will stay on the Dashboard.`, 'success');

  $('pick-so').value = '';
  $('pick-location').value = '';
  if ($('pick-remarks')) $('pick-remarks').value = '';
  $('pick-so-override').checked = false;
  $('pick-so-override-reason').value = '';
  $('pick-so-override-reason').disabled = true;
  state.pickOrder = { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false };
  resetPickCorrectionReporting();
  invalidateReports();
  await refreshPickSalesOrderStatus();
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

  const normalRemarksPanel = $('pick-normal-remarks-panel');
  const normalRemarks = $('pick-remarks');
  if (normalRemarksPanel && normalRemarks) {
    normalRemarksPanel.classList.toggle('hidden', adjustmentMode);
    normalRemarks.disabled = adjustmentMode || state.mode !== 'ACTIVE';
    if (adjustmentMode) normalRemarks.value = '';
  }

  const adjustmentRemarksPanel = $('pick-adjustment-remarks-panel');
  const adjustmentRemarks = $('pick-adjustment-remarks');
  if (adjustmentRemarksPanel && adjustmentRemarks) {
    adjustmentRemarksPanel.classList.toggle('hidden', !adjustmentMode);
    adjustmentRemarks.disabled = !(adjustmentMode && state.mode === 'ACTIVE');
    if (!adjustmentMode) adjustmentRemarks.value = '';
  }
  const orderOpen = state.pickOrder.status === 'OPEN';
  const orderCompleted = state.pickOrder.status === 'COMPLETED';
  const orderNew = state.pickOrder.status === 'NEW';
  const hasSavedPick = Number(state.pickOrder.pickCount || 0) > 0;
  const unlocked = !state.pick.lockToken;
  const soLocked = isPickSalesOrderInputLocked();

  $('pick-so').disabled = soLocked;
  $('pick-so').title = soLocked
    ? (adjustmentMode
        ? 'Sales Order 0 is locked only while this Stock Adjustment rack is active.'
        : 'Sales Order is locked while this picking order is in progress. Finish the Sales Order to release it.')
    : '';

  const correctionStatusKnown = state.pickBlockingPendingReturnCount >= 0 && state.pickRequestedCorrectionCount >= 0;
  const noBlockingCorrection = state.pickBlockingPendingReturnCount === 0 && state.pickRequestedCorrectionCount === 0;
  $('pick-finish-so-btn').disabled = adjustmentMode || !(state.mode === 'ACTIVE' && hasSo && orderOpen && hasSavedPick && unlocked && correctionStatusKnown && noBlockingCorrection);
  $('pick-finish-so-btn').title = adjustmentMode
    ? 'Sales Order 0 is reusable Stock Adjustment mode and does not need to be finished.'
    : (state.pickRequestedCorrectionCount > 0
        ? 'A Saved Pick mistake is awaiting Supervisor review. Review or reject it before finishing this Sales Order.'
        : (state.pickBlockingPendingReturnCount > 0
            ? 'Complete the approved Saved Pick physical return before finishing this Sales Order. Emergency finish requires Supervisor/Admin/Owner approval.'
            : (!correctionStatusKnown ? 'Checking Saved Pick correction status…' : '')));

  // "Cancel picking" has two safe meanings:
  // 1) NEW or COMPLETED Sales Order with no active rack: clear only this screen.
  //    No database Sales Order/history record is changed.
  // 2) OPEN empty Sales Order owned by this user: use the existing database
  //    cancellation RPC so the Sales Order number is released properly.
  // Sales Order 0 continues to use this button as Exit stock adjustment.
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

      if (orderCompleted && unlocked && hasSo) {
        cancelWhole.disabled = false;
        cancelWhole.title = 'Leave this completed Sales Order without reopening it. This only clears the Picking screen; the completed Sales Order is not changed.';
      } else if (orderNew && unlocked && hasSo) {
        cancelWhole.disabled = false;
        cancelWhole.title = 'Clear this not-yet-opened Sales Order from the Picking screen. No database record is changed.';
      } else {
        cancelWhole.disabled = !(state.mode === 'ACTIVE' && hasSo && orderOpen && !hasSavedPick && Boolean(state.pickOrder.isCurrentOwner));
        cancelWhole.title = hasSavedPick
          ? 'This Sales Order already has a saved pick and can no longer be cancelled as an empty picking session.'
          : 'Cancel the entire empty picking session and release this Sales Order number for reuse.';
      }
    }
  }
}

function syncPickOverrideControls() {
  const panel = $('pick-so-override-panel');
  const legacyFlag = $('pick-so-override');
  const reason = $('pick-so-override-reason');
  const requestButton = $('pick-so-reopen-request-btn');
  if (!panel || !legacyFlag || !reason || !requestButton) return;

  const completed = state.pickOrder.status === 'COMPLETED';
  const adjustmentMode = isStockAdjustmentSalesOrder($('pick-so').value);
  const available = state.mode === 'ACTIVE' && !adjustmentMode && completed && !state.pick.lockToken;

  panel.classList.toggle('hidden', !completed || adjustmentMode);

  // Keep the old hidden compatibility flag false. Reopening is now driven by
  // the explicit Request approval button, which is clearer for warehouse users.
  legacyFlag.checked = false;
  legacyFlag.disabled = true;

  if (!completed) {
    reason.value = '';
  }

  reason.disabled = !available;
  requestButton.disabled = !available;
}

async function refreshPickSalesOrderStatus() {
  const so = $('pick-so').value.trim();
  const box = $('pick-so-status');
  const requestNo = ++state.pickOrderLookupSequence;
  state.pickRequestedCorrectionCount = (so && !isStockAdjustmentSalesOrder(so)) ? -1 : 0;
  state.pickBlockingPendingReturnCount = (so && !isStockAdjustmentSalesOrder(so)) ? -1 : 0;

  if (!so) {
    state.pickOrder = { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false };
    box.innerHTML = '<strong>Sales order status:</strong> enter a sales order number. A completed Sales Order requires Supervisor/Admin/Owner login-password approval before reuse.';
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
    resetPickCorrectionReporting();
    updatePickSalesOrderControls();
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
      box.innerHTML = `<strong>Sales order status:</strong> <strong>${escapeHtml(row.order_number)}</strong> was completed ${row.completed_at ? `on ${escapeHtml(fmtDateTime(row.completed_at))}` : ''}. It can be reopened only after a currently active Supervisor, Admin, or Owner approves with their normal WMS login password.`;
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
    if ($('pick-adjustment-remarks')) $('pick-adjustment-remarks').value = '';
    if ($('pick-remarks')) $('pick-remarks').value = '';
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
    resetPickCorrectionReporting();

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


async function clearUnstartedPickingScreen(message) {
  // This is intentionally LOCAL-ONLY. It is used when a Sales Order was merely
  // typed into the screen but no active/open picking session needs to be cancelled.
  // It never changes pick_sales_orders, transactions, inventory, or rack locks.
  stopHeartbeat(state.pick);
  state.pick = freshOperationState();

  $('pick-so').value = '';
  $('pick-location').value = '';
  $('pick-barcode').value = '';
  $('pick-lot').innerHTML = '<option value="">Scan a barcode first</option>';
  $('pick-qty').value = '';
  if ($('pick-adjustment-remarks')) $('pick-adjustment-remarks').value = '';
  if ($('pick-remarks')) $('pick-remarks').value = '';
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
  resetPickCorrectionReporting();

  configureOperationUi('pick', false);
  renderOperationCart('pick');
  await refreshPickSalesOrderStatus();

  toast(message || 'Picking entry cleared. No warehouse records were changed.', 'success');
  return true;
}

async function cancelEntirePicking() {
  const so = $('pick-so').value.trim();
  if (!so) return toast('Enter the sales order number.', 'error');
  if (isStockAdjustmentSalesOrder(so)) {
    return exitStockAdjustmentMode();
  }

  // Refresh immediately before cancellation so an older client status cannot
  // accidentally release or alter a Sales Order whose state has changed.
  const statusOk = await refreshPickSalesOrderStatus();
  if (!statusOk) return toast('The sales order status could not be verified. Please try again.', 'error');

  // A COMPLETED Sales Order has not been reopened yet, so "Cancel picking"
  // simply lets the user back out of the mistaken entry. Nothing in the DB changes.
  if (state.pickOrder.status === 'COMPLETED') {
    if (state.pick.lockToken) {
      return toast('A completed Sales Order should not have an active rack lock. Refresh Picking before continuing.', 'error');
    }
    if (!window.confirm(`Leave completed Sales Order ${so} without reopening it?\n\nThis only clears the Picking screen. The completed Sales Order, inventory, and history will NOT be changed.`)) return;
    return clearUnstartedPickingScreen(`Sales Order ${so} was left closed. No warehouse records were changed.`);
  }

  // A NEW Sales Order has not been opened in the database yet. Clearing it is local-only.
  if (state.pickOrder.status === 'NEW') {
    if (state.pick.lockToken) {
      return toast('Cancel/restart the current rack before clearing this Sales Order.', 'error');
    }
    return clearUnstartedPickingScreen('Picking entry cleared. The Sales Order was never opened, so no warehouse records were changed.');
  }

  if (state.pickOrder.status !== 'OPEN') return toast('Only an OPEN, NEW, or completed-but-not-reopened Sales Order can be cancelled from this screen.', 'error');
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
  if ($('pick-adjustment-remarks')) $('pick-adjustment-remarks').value = '';
  if ($('pick-remarks')) $('pick-remarks').value = '';
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
  resetPickCorrectionReporting();
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
  if (state.pickRequestedCorrectionCount > 0) return toast('Finish Sales Order is blocked because a Saved Pick mistake is awaiting Supervisor review. Review or reject it first.', 'error');
  if (state.pickBlockingPendingReturnCount > 0) return toast('Finish Sales Order is blocked until the approved Saved Pick physical return is completed. Use Emergency Finish only for a genuine operational exception.', 'error');
  if (state.pickBlockingPendingReturnCount < 0 || state.pickRequestedCorrectionCount < 0) return toast('Saved Pick correction status is still loading. Refresh the summary and try again.', 'error');
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
  if ($('pick-remarks')) $('pick-remarks').value = '';
  $('pick-so-override').checked = false;
  $('pick-so-override-reason').value = '';
  $('pick-so-override-reason').disabled = true;
  state.pickOrder = { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false };
  resetPickCorrectionReporting();
  await refreshPickSalesOrderStatus();
  invalidateReports();
}

async function completePicking() {
  if (operationHasPendingBarcode('pick')) {
    return toast('A Picking barcode entry is still pending. Add that item, or clear the barcode field before completing this rack.', 'error');
  }
  if (!state.pick.cart.length) return toast('Add at least one item.', 'error');
  const so = $('pick-so').value.trim();
  const adjustmentMode = isStockAdjustmentSalesOrder(so);
  const pickingRemarks = adjustmentMode ? '' : ($('pick-remarks')?.value || '').trim();
  const adjustmentRemarks = adjustmentMode ? ($('pick-adjustment-remarks')?.value || '').trim() : '';

  if (pickingRemarks.length > 500) return toast('Picking remarks are limited to 500 characters.', 'error');
  if (adjustmentMode && !adjustmentRemarks) {
    return toast('Enter the Stock Adjustment reason / remarks before completing this rack.', 'error');
  }

  const requiresOverride = state.pick.cart.some((x) => x.expiry_date > x.earliest_expiry);
  const containerOverrideCount = adjustmentMode
    ? 0
    : state.pick.cart.filter((x) => x.container_priority_override_confirmed).length;
  let reason = null;
  if (requiresOverride) {
    reason = window.prompt('FEFO override reason (required):');
    if (!reason?.trim()) return toast('Picking was not completed because an override reason is required.', 'error');
  }
  const button = $('pick-complete-btn');

  if (adjustmentMode && !state.pick.adjustmentSessionKey) {
    return toast('The Stock Adjustment session key is missing. Cancel/restart the rack and lock it again.', 'error');
  }

  const items = state.pick.cart.map(({ lot_id, qty, barcode, supervisor_bypass, bypass_reason, bypass_approval_token, fefo_override_confirmed, container_priority_override_confirmed }) => ({
    lot_id, qty, barcode, supervisor_bypass: Boolean(supervisor_bypass), bypass_reason: bypass_reason || null,
    bypass_approval_token: bypass_approval_token || null,
    fefo_override_confirmed: Boolean(fefo_override_confirmed),
    container_priority_override_confirmed: Boolean(container_priority_override_confirmed)
  }));

  setBusy(button, true, adjustmentMode ? 'Saving adjustment…' : 'Completing…');

  const rpcName = adjustmentMode ? 'complete_stock_adjustment_picking_with_remarks' : 'complete_picking_with_approvals_and_container_audit';
  const rpcArgs = adjustmentMode
    ? {
        p_location_code: state.pick.locationCode,
        p_lock_token: state.pick.lockToken,
        p_adjustment_session_key: state.pick.adjustmentSessionKey,
        p_items: items,
        p_adjustment_remarks: adjustmentRemarks,
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
        p_note: pickingRemarks || null
      };

  const { data, error } = await supabase.rpc(rpcName, rpcArgs);
  setBusy(button, false);
  syncOperationCompleteGuard('pick');
  if (error) return toast(friendlyError(error), 'error');

  if (adjustmentMode) {
    toast(`Stock Adjustment OUT saved: ${data?.[0]?.transaction_no || 'completed'} · Sales Order 0 remains reusable.${requiresOverride ? ' FEFO override recorded.' : ''} Put-away the remaining usable units as needed.`, 'success');
  } else {
    toast(`Rack pick saved: ${data?.[0]?.transaction_no || 'completed'}${requiresOverride ? ' · FEFO override recorded' : ''}${containerOverrideCount ? ` · ${containerOverrideCount} container-priority override${containerOverrideCount === 1 ? '' : 's'} audited` : ''}. Scan the next source rack, or finish the sales order when all items are complete.`, 'success');
  }

  invalidateReports();
  resetOperation('pick');
  $('pick-so').value = so;
  if (adjustmentMode && $('pick-adjustment-remarks')) $('pick-adjustment-remarks').value = '';
  if (!adjustmentMode && $('pick-remarks')) $('pick-remarks').value = '';
  await refreshPickSalesOrderStatus();
}

async function completeTransfer() {
  if (operationHasPendingBarcode('transfer')) {
    return toast('A Stock Transfer barcode entry is still pending. Add that item, or clear the barcode field before completing the transfer.', 'error');
  }

  const destination = normalizeLocation($('tr-destination').value);
  if (!destination) return toast('Scan the destination location.', 'error');

  const bulk = Boolean($('tr-transfer-all')?.checked);
  const button = $('tr-complete-btn');

  if (bulk) {
    if (!state.transfer.lockToken || !state.transfer.locationCode) return toast('Lock the source rack first.', 'error');
    const activeLots = (state.transfer.rackLots || []).filter((row) => Number(row.qty) > 0);
    if (!activeLots.length) return toast('The locked source rack has no active stock to transfer.', 'error');
    const heldLots = activeLots.filter((row) => row.is_releasable === false);
    if (heldLots.length) return toast(`Whole-rack transfer blocked: ${heldLots.length} inventory line(s) are ON HOLD. Unfreeze them first, or transfer only eligible lots individually.`, 'error');
    const shipperBoxes = new Set(activeLots.map((row) => row.shipper_box_no).filter(Boolean));
    const confirmed = window.confirm(`WHOLE SOURCE-RACK / PALLET TRANSFER\n\nMove ALL active stock from ${state.transfer.locationCode} to ${destination}?\n\nDetected: ${activeLots.length} active inventory lines and ${shipperBoxes.size} physical Shipper box(es).\n\nThis includes every STANDARD lot and every Shipper Box currently stored in the source rack. This cannot be limited to one pallet because the current WMS has no separate Pallet ID.`);
    if (!confirmed) return;

    setBusy(button, true, 'Moving whole rack…');
    const { data, error } = await supabase.rpc('complete_full_location_transfer_with_transaction_remark', {
      p_source_code: state.transfer.locationCode,
      p_destination_code: destination,
      p_lock_token: state.transfer.lockToken,
      p_transaction_remark: state.transfer.bulkTransactionRemark || null
    });
    setBusy(button, false);
    syncOperationCompleteGuard('transfer');
    if (error) return toast(friendlyError(error), 'error');
    const row = data?.[0] || {};
    toast(`Whole-rack transfer saved: ${row.transaction_no || 'completed'} · ${Number(row.moved_stock_lot_count || 0).toLocaleString()} stock lines · ${Number(row.moved_shipper_box_count || 0).toLocaleString()} Shipper boxes.`, 'success');
    invalidateReports();
    resetOperation('transfer');
    return;
  }

  if (!state.transfer.cart.length) return toast('Add at least one item, or select Transfer ALL stock in this source rack.', 'error');
  if (state.transfer.cart.some((item) => !Number.isInteger(Number(item.qty)))) return toast('Transfer cannot continue: CASE, PACK, and PIECE quantities must be whole numbers.', 'error');

  setBusy(button, true, 'Completing…');
  const { data, error } = await supabase.rpc('complete_transfer_with_user_remarks', {
    p_source_code: state.transfer.locationCode,
    p_destination_code: destination,
    p_lock_token: state.transfer.lockToken,
    p_items: state.transfer.cart.map(({ lot_id, qty, barcode, user_remark }) => ({ lot_id, qty, barcode, user_remark }))
  });
  setBusy(button, false);
  syncOperationCompleteGuard('transfer');
  if (error) return toast(friendlyError(error), 'error');
  toast(`Transfer saved: ${data?.[0]?.transaction_no || 'completed'}`, 'success');
  invalidateReports();
  resetOperation('transfer');
}


function physicalCountRackParts(value) {
  const code = normalizeLocation(value);
  const match = code.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;

  let rowOrdinal = 0;
  for (const char of match[1]) {
    rowOrdinal = (rowOrdinal * 26) + (char.charCodeAt(0) - 64);
  }

  return {
    code,
    row: match[1],
    number: Number(match[2]),
    ordinal: (rowOrdinal * 100000) + Number(match[2])
  };
}

function comparePhysicalCountRackCodes(a, b) {
  const aCode = normalizeLocation(a);
  const bCode = normalizeLocation(b);

  if (aCode === bCode) return 0;
  if (aCode === 'PENDING') return 1;
  if (bCode === 'PENDING') return -1;

  const ap = physicalCountRackParts(aCode);
  const bp = physicalCountRackParts(bCode);

  if (ap && bp) {
    if (ap.ordinal !== bp.ordinal) return ap.ordinal - bp.ordinal;
    return ap.code.localeCompare(bp.code, undefined, { numeric: true });
  }
  if (ap) return -1;
  if (bp) return 1;
  return aCode.localeCompare(bCode, undefined, { numeric: true });
}

function parsePhysicalCountContainer(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2,3})$/);

  if (!match) {
    return {
      text,
      structured: false,
      year: null,
      batch: null
    };
  }

  return {
    text,
    structured: true,
    year: Number(match[1]),
    batch: Number(match[2])
  };
}

function comparePhysicalCountContainers(a, b) {
  const ap = parsePhysicalCountContainer(a);
  const bp = parsePhysicalCountContainer(b);

  // Recognized shipment container numbers sort chronologically/numerically.
  if (ap.structured && bp.structured) {
    if (ap.year !== bp.year) return ap.year - bp.year;
    if (ap.batch !== bp.batch) return ap.batch - bp.batch;
    return ap.text.localeCompare(bp.text, undefined, { numeric: true, sensitivity: 'base' });
  }

  // Keep valid shipment containers together and predictable, then naturally
  // sort any legacy/nonstandard container labels rather than discarding them.
  if (ap.structured && !bp.structured) return -1;
  if (!ap.structured && bp.structured) return 1;

  return ap.text.localeCompare(bp.text, undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function getPhysicalCountSortMode() {
  const active = document.querySelector('[data-physical-count-sort][aria-pressed="true"]');
  return active?.dataset.physicalCountSort || 'auto';
}

function physicalCountSortLabel(mode = getPhysicalCountSortMode()) {
  const labels = {
    auto: 'Auto',
    alpha: 'Alphabetical SKU',
    container: 'Container number',
    rack: 'Rack order',
    'rack-container': 'Rack + Container'
  };
  return labels[mode] || labels.auto;
}

function handlePhysicalCountSortToggle(event) {
  const button = event.target.closest('[data-physical-count-sort]');
  if (!button) return;

  document.querySelectorAll('[data-physical-count-sort]').forEach((node) => {
    const active = node === button;
    node.setAttribute('aria-pressed', active ? 'true' : 'false');
    node.classList.toggle('active', active);
  });

  renderPhysicalCount();
}

function physicalCountRackMatches(code, rawFilter) {
  const rack = normalizeLocation(code);
  const raw = String(rawFilter || '').trim();
  if (!raw) return true;

  const tokens = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (!tokens.length) return true;

  return tokens.some((token) => {
    const normalized = normalizeLocation(token);

    // Exact rack, including PENDING.
    if (normalized === rack) return true;

    // Inclusive range such as A1-A10 or A70-B10.
    const range = normalized.match(/^([A-Z]+\d+)\s*-\s*([A-Z]+\d+)$/);
    if (!range) return false;

    const start = physicalCountRackParts(range[1]);
    const end = physicalCountRackParts(range[2]);
    const current = physicalCountRackParts(rack);
    if (!start || !end || !current) return false;

    const low = Math.min(start.ordinal, end.ordinal);
    const high = Math.max(start.ordinal, end.ordinal);
    return current.ordinal >= low && current.ordinal <= high;
  });
}

function physicalCountSkuSearchText(row) {
  return [
    row.brand,
    row.description,
    row.variant,
    row.size,
    row.sku_name,
    row.case_barcode,
    row.pack_barcode,
    row.piece_barcode
  ].join(' ').toLowerCase();
}

function aggregatePhysicalCountRows(rows) {
  const grouped = new Map();

  (rows || []).forEach((row) => {
    const key = [
      row.location_code || '',
      row.sku_id || '',
      row.uom || '',
      row.expiry_date || '',
      row.container_no || ''
    ].join('|');

    const existing = grouped.get(key);
    if (existing) {
      existing.qty += Number(row.qty || 0);
      return;
    }

    grouped.set(key, {
      location_code: row.location_code || '',
      location_sort_order: row.location_sort_order ?? null,
      sku_id: row.sku_id || '',
      brand: row.brand || '',
      description: row.description || '',
      variant: row.variant || '',
      size: row.size || '',
      sku_name: row.sku_name || [row.brand, row.description, row.variant, row.size].filter(Boolean).join(' '),
      case_barcode: row.case_barcode || '',
      pack_barcode: row.pack_barcode || '',
      piece_barcode: row.piece_barcode || '',
      uom: String(row.uom || '').toUpperCase(),
      qty: Number(row.qty || 0),
      expiry_date: row.expiry_date || null,
      container_no: row.container_no || ''
    });
  });

  return [...grouped.values()].filter((row) => Number(row.qty || 0) > 0);
}

async function loadPhysicalCount(force = false) {
  if (!force && state.data.physicalCount.length) {
    return renderPhysicalCount();
  }

  const pageSize = 1000;
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('v_inventory_search')
      .select('*')
      .order('location_sort_order', { ascending: true, nullsFirst: false })
      .order('location_code')
      .order('sku_name')
      .range(offset, offset + pageSize - 1);

    if (error) throw error;

    const page = data || [];
    rows.push(...page);

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  state.data.physicalCountRaw = rows.filter((row) => Number(row.qty || 0) > 0);
  state.data.physicalCount = aggregatePhysicalCountRows(rows);
  renderPhysicalCount();
  if (!$('physical-count-detailed-shipper-panel').classList.contains('hidden')) {
    renderPhysicalCountDetailedShipperView();
  }
}

function filteredPhysicalCountRows() {
  const sku = $('physical-count-sku').value.trim().toLowerCase();
  const containerRaw = $('physical-count-container').value.trim();
  const rackRaw = $('physical-count-racks').value.trim();

  const exactContainers = containerRaw
    ? containerRaw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
    : [];

  const rows = (state.data.physicalCount || []).filter((row) => {
    if (sku && !physicalCountSkuSearchText(row).includes(sku)) return false;

    if (exactContainers.length) {
      const current = String(row.container_no || '').trim().toLowerCase();
      if (!exactContainers.includes(current)) return false;
    }

    if (!physicalCountRackMatches(row.location_code, rackRaw)) return false;

    return true;
  });

  const alphaCompare = (a, b) => {
    const fields = ['brand', 'description', 'variant', 'size'];
    for (const field of fields) {
      const result = String(a[field] || '').localeCompare(String(b[field] || ''), undefined, {
        numeric: true,
        sensitivity: 'base'
      });
      if (result) return result;
    }

    const containerCompare = comparePhysicalCountContainers(a.container_no, b.container_no);
    if (containerCompare) return containerCompare;

    const rackCompare = comparePhysicalCountRackCodes(a.location_code, b.location_code);
    if (rackCompare) return rackCompare;

    const expiryCompare = String(a.expiry_date || '').localeCompare(String(b.expiry_date || ''));
    if (expiryCompare) return expiryCompare;

    return String(a.uom || '').localeCompare(String(b.uom || ''));
  };

  const containerCompare = (a, b) => {
    const result = comparePhysicalCountContainers(a.container_no, b.container_no);
    if (result) return result;

    const alphaResult = alphaCompare(a, b);
    if (alphaResult) return alphaResult;

    return comparePhysicalCountRackCodes(a.location_code, b.location_code);
  };

  const rackCompare = (a, b) => {
    const rackResult = comparePhysicalCountRackCodes(a.location_code, b.location_code);
    if (rackResult) return rackResult;
    return alphaCompare(a, b);
  };

  const rackContainerCompare = (a, b) => {
    const rackResult = comparePhysicalCountRackCodes(a.location_code, b.location_code);
    if (rackResult) return rackResult;

    const containerResult = comparePhysicalCountContainers(a.container_no, b.container_no);
    if (containerResult) return containerResult;

    return alphaCompare(a, b);
  };

  let mode = getPhysicalCountSortMode();

  // "Auto" preserves the exact behavior of the already-working Physical Count:
  // Rack filter -> rack order; otherwise alphabetical.
  if (mode === 'auto') {
    mode = rackRaw ? 'rack' : 'alpha';
  }

  if (mode === 'container') rows.sort(containerCompare);
  else if (mode === 'rack') rows.sort(rackCompare);
  else if (mode === 'rack-container') rows.sort(rackContainerCompare);
  else rows.sort(alphaCompare);

  return rows;
}

function physicalCountSkuDisplay(row) {
  return [row.brand, row.description, row.variant].filter(Boolean).join(' ');
}

function renderPhysicalCount() {
  const rows = filteredPhysicalCountRows();
  state.data.physicalCountFiltered = rows;

  const selectedMode = getPhysicalCountSortMode();
  const rackFiltered = Boolean($('physical-count-racks').value.trim());
  const resolvedMode = selectedMode === 'auto'
    ? (rackFiltered ? 'rack' : 'alpha')
    : selectedMode;
  const sortLabel = selectedMode === 'auto'
    ? `Auto → ${physicalCountSortLabel(resolvedMode)}`
    : physicalCountSortLabel(resolvedMode);

  $('physical-count-count').innerHTML =
    `Showing <strong>${rows.length.toLocaleString()}</strong> printable line(s) · Sorted by <strong>${escapeHtml(sortLabel)}</strong>.`;

  $('physical-count-table-body').innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.location_code || '—')}</strong></td>
      <td class="wrap">${escapeHtml(physicalCountSkuDisplay(row) || row.sku_name || '—')}</td>
      <td>${escapeHtml(row.size || '—')}</td>
      <td>${escapeHtml(row.uom || '—')}</td>
      <td>${fmtQty(row.qty)}</td>
      <td>${isNoExpiryDate(row.expiry_date) ? 'N/A' : fmtDate(row.expiry_date)}</td>
      <td>${escapeHtml(row.container_no || '—')}</td>
      <td class="physical-count-remarks-cell">&nbsp;</td>
    </tr>
  `).join('') : `<tr><td colspan="8">${emptyState('No current inventory matches the Physical Count filters.')}</td></tr>`;
}

function clearPhysicalCountFilters() {
  $('physical-count-sku').value = '';
  $('physical-count-container').value = '';
  $('physical-count-racks').value = '';
  renderPhysicalCount();
  $('physical-count-sku').focus();
}

function physicalCountFilterSummary() {
  const filters = [];
  const sku = $('physical-count-sku').value.trim();
  const container = $('physical-count-container').value.trim();
  const racks = $('physical-count-racks').value.trim();

  if (sku) filters.push(`SKU: ${sku}`);
  if (container) filters.push(`Container: ${container}`);
  if (racks) filters.push(`Rack(s): ${racks}`);

  return filters.length ? filters.join(' · ') : 'All current positive inventory';
}

function physicalCountDetailedSearchText(row) {
  return [
    physicalCountSkuSearchText(row),
    row.shipper_box_no,
    row.shipper_status,
    row.shipper_lot_role
  ].join(' ').toLowerCase();
}

function aggregatePhysicalCountDetailedRows(rows, shipperAware = false) {
  const grouped = new Map();

  (rows || []).forEach((row) => {
    const isShipper = Boolean(row.shipper_box_id || row.shipper_box_no);
    const role = String(row.shipper_lot_role || '').toUpperCase();
    const key = [
      row.location_code || '',
      row.sku_id || '',
      row.uom || '',
      row.expiry_date || '',
      row.container_no || '',
      shipperAware && isShipper ? (row.shipper_box_id || row.shipper_box_no || '') : '',
      shipperAware && isShipper ? role : ''
    ].join('|');

    const existing = grouped.get(key);
    if (existing) {
      existing.qty += Number(row.qty || 0);
      return;
    }

    grouped.set(key, {
      ...row,
      location_code: row.location_code || '',
      location_sort_order: row.location_sort_order ?? null,
      sku_id: row.sku_id || '',
      brand: row.brand || '',
      description: row.description || '',
      variant: row.variant || '',
      size: row.size || '',
      sku_name: row.sku_name || [row.brand, row.description, row.variant, row.size].filter(Boolean).join(' '),
      case_barcode: row.case_barcode || '',
      pack_barcode: row.pack_barcode || '',
      piece_barcode: row.piece_barcode || '',
      uom: String(row.uom || '').toUpperCase(),
      qty: Number(row.qty || 0),
      expiry_date: row.expiry_date || null,
      container_no: row.container_no || '',
      shipper_box_id: row.shipper_box_id || null,
      shipper_box_no: row.shipper_box_no || '',
      shipper_status: row.shipper_status || '',
      shipper_lot_role: role
    });
  });

  return [...grouped.values()].filter((row) => Number(row.qty || 0) > 0);
}

function physicalCountDetailedUnitComparators() {
  const alphaCompare = (a, b) => {
    const fields = ['brand', 'description', 'variant', 'size'];
    for (const field of fields) {
      const result = String(a[field] || '').localeCompare(String(b[field] || ''), undefined, {
        numeric: true,
        sensitivity: 'base'
      });
      if (result) return result;
    }

    const containerResult = comparePhysicalCountContainers(a.container_no, b.container_no);
    if (containerResult) return containerResult;

    const rackResult = comparePhysicalCountRackCodes(a.location_code, b.location_code);
    if (rackResult) return rackResult;

    const expiryResult = String(a.expiry_date || '').localeCompare(String(b.expiry_date || ''));
    if (expiryResult) return expiryResult;

    return String(a.uom || '').localeCompare(String(b.uom || ''));
  };

  const containerCompare = (a, b) => {
    const result = comparePhysicalCountContainers(a.container_no, b.container_no);
    if (result) return result;
    const alphaResult = alphaCompare(a, b);
    if (alphaResult) return alphaResult;
    return comparePhysicalCountRackCodes(a.location_code, b.location_code);
  };

  const rackCompare = (a, b) => {
    const rackResult = comparePhysicalCountRackCodes(a.location_code, b.location_code);
    if (rackResult) return rackResult;
    return alphaCompare(a, b);
  };

  const rackContainerCompare = (a, b) => {
    const rackResult = comparePhysicalCountRackCodes(a.location_code, b.location_code);
    if (rackResult) return rackResult;
    const containerResult = comparePhysicalCountContainers(a.container_no, b.container_no);
    if (containerResult) return containerResult;
    return alphaCompare(a, b);
  };

  return { alphaCompare, containerCompare, rackCompare, rackContainerCompare };
}

function buildPhysicalCountDetailedShipperRows() {
  const sku = $('physical-count-sku').value.trim().toLowerCase();
  const containerRaw = $('physical-count-container').value.trim();
  const rackRaw = $('physical-count-racks').value.trim();
  const exactContainers = containerRaw
    ? containerRaw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
    : [];

  const rawRows = (state.data.physicalCountRaw || []).filter((row) => Number(row.qty || 0) > 0);
  const physicallyScopedRows = rawRows.filter((row) => {
    if (exactContainers.length) {
      const current = String(row.container_no || '').trim().toLowerCase();
      if (!exactContainers.includes(current)) return false;
    }
    return physicalCountRackMatches(row.location_code, rackRaw);
  });

  // Regular stock keeps the current Physical Count consolidation rule.
  const regularRows = aggregatePhysicalCountDetailedRows(
    physicallyScopedRows.filter((row) => !(row.shipper_box_id || row.shipper_box_no))
  ).filter((row) => !sku || physicalCountSkuSearchText(row).includes(sku));

  // Shipper-linked stock stays separated by exact physical SB identity. If the SKU
  // filter matches any row in an SB, keep that whole SB block together so the checker
  // never loses the parent/content relationship while counting.
  const shipperGroups = new Map();
  physicallyScopedRows
    .filter((row) => Boolean(row.shipper_box_id || row.shipper_box_no))
    .forEach((row) => {
      const key = String(row.shipper_box_id || row.shipper_box_no || 'UNKNOWN');
      if (!shipperGroups.has(key)) shipperGroups.set(key, []);
      shipperGroups.get(key).push(row);
    });

  const units = regularRows.map((row) => ({
    anchor: row,
    shipper: false,
    rows: [{ ...row, detailed_type: 'REGULAR', detailed_group_start: false }]
  }));

  for (const groupRows of shipperGroups.values()) {
    if (sku && !groupRows.some((row) => physicalCountDetailedSearchText(row).includes(sku))) continue;

    const exactRows = aggregatePhysicalCountDetailedRows(groupRows, true);
    exactRows.sort((a, b) => {
      const roleA = String(a.shipper_lot_role || '').toUpperCase() === 'HEADER' ? 0 : 1;
      const roleB = String(b.shipper_lot_role || '').toUpperCase() === 'HEADER' ? 0 : 1;
      if (roleA !== roleB) return roleA - roleB;

      const nameA = [a.brand, a.description, a.variant, a.size].filter(Boolean).join(' ');
      const nameB = [b.brand, b.description, b.variant, b.size].filter(Boolean).join(' ');
      const nameResult = nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
      if (nameResult) return nameResult;

      const expiryResult = String(a.expiry_date || '').localeCompare(String(b.expiry_date || ''));
      if (expiryResult) return expiryResult;
      return String(a.uom || '').localeCompare(String(b.uom || ''));
    });

    const header = exactRows.find((row) => String(row.shipper_lot_role || '').toUpperCase() === 'HEADER');
    const anchorRow = header || exactRows[0];
    if (!anchorRow) continue;

    units.push({
      anchor: anchorRow,
      shipper: true,
      rows: exactRows.map((row, index) => ({
        ...row,
        detailed_type: String(row.shipper_lot_role || '').toUpperCase() === 'HEADER' ? 'SHIPPER' : 'CONTENT',
        detailed_group_start: index === 0
      }))
    });
  }

  const comparators = physicalCountDetailedUnitComparators();
  let mode = getPhysicalCountSortMode();
  if (mode === 'auto') mode = rackRaw ? 'rack' : 'alpha';

  const compareUnits = (a, b) => {
    if (mode === 'container') return comparators.containerCompare(a.anchor, b.anchor);
    if (mode === 'rack') return comparators.rackCompare(a.anchor, b.anchor);
    if (mode === 'rack-container') return comparators.rackContainerCompare(a.anchor, b.anchor);
    return comparators.alphaCompare(a.anchor, b.anchor);
  };

  units.sort(compareUnits);
  return units.flatMap((unit) => unit.rows);
}

function physicalCountDetailedSkuDisplay(row) {
  return [row.brand, row.description, row.variant, row.size].filter(Boolean).join(' ') || row.sku_name || '—';
}

function renderPhysicalCountDetailedShipperView() {
  const rows = buildPhysicalCountDetailedShipperRows();
  state.data.physicalCountDetailedShipperFiltered = rows;

  const shipperBoxes = new Set(rows.map((row) => row.shipper_box_no).filter(Boolean));
  const regularLines = rows.filter((row) => row.detailed_type === 'REGULAR').length;
  const selectedMode = getPhysicalCountSortMode();
  const rackFiltered = Boolean($('physical-count-racks').value.trim());
  const resolvedMode = selectedMode === 'auto' ? (rackFiltered ? 'rack' : 'alpha') : selectedMode;
  const sortLabel = selectedMode === 'auto'
    ? `Auto → ${physicalCountSortLabel(resolvedMode)}`
    : physicalCountSortLabel(resolvedMode);

  $('physical-count-detailed-shipper-count').innerHTML = rows.length
    ? `Showing <strong>${rows.length.toLocaleString()}</strong> count line(s) · <strong>${shipperBoxes.size.toLocaleString()}</strong> physical Shipper box group(s) · <strong>${regularLines.toLocaleString()}</strong> regular line(s) · Sorted by <strong>${escapeHtml(sortLabel)}</strong>.`
    : 'No current inventory matches the Physical Count filters.';

  $('physical-count-detailed-shipper-table-body').innerHTML = rows.length ? rows.map((row) => {
    const type = row.detailed_type || 'REGULAR';
    const isContent = type === 'CONTENT';
    const isShipperHeader = type === 'SHIPPER';
    const rowClass = [
      isShipperHeader ? 'physical-count-detailed-shipper-header' : '',
      isContent ? 'physical-count-detailed-shipper-content' : '',
      row.detailed_group_start ? 'physical-count-detailed-group-start' : ''
    ].filter(Boolean).join(' ');
    const shipperCell = row.shipper_box_no
      ? `<strong>${escapeHtml(row.shipper_box_no)}</strong>${row.shipper_status ? `<br><small>${escapeHtml(row.shipper_status)}</small>` : ''}`
      : '—';
    const skuText = `${isContent ? '<span class="physical-count-detailed-indent">↳</span> ' : ''}${escapeHtml(physicalCountDetailedSkuDisplay(row))}`;

    return `<tr class="${rowClass}">
      <td><strong>${escapeHtml(row.location_code || '—')}</strong></td>
      <td><strong>${escapeHtml(type)}</strong></td>
      <td>${shipperCell}</td>
      <td class="wrap">${isShipperHeader ? `<strong>${skuText}</strong>` : skuText}</td>
      <td>${escapeHtml(row.uom || '—')}</td>
      <td>${fmtQty(row.qty)}</td>
      <td>${isNoExpiryDate(row.expiry_date) ? 'N/A' : fmtDate(row.expiry_date)}</td>
      <td>${escapeHtml(row.container_no || '—')}</td>
      <td class="physical-count-remarks-cell">&nbsp;</td>
    </tr>`;
  }).join('') : `<tr><td colspan="9">${emptyState('No current inventory matches the Physical Count filters.')}</td></tr>`;
}

async function openPhysicalCountDetailedShipperView() {
  if (!state.data.physicalCount.length || !state.data.physicalCountRaw.length) {
    await loadPhysicalCount(true);
  }

  renderPhysicalCountDetailedShipperView();
  $('physical-count-standard-panel').classList.add('hidden');
  $('physical-count-detailed-shipper-panel').classList.remove('hidden');
  $('physical-count-detailed-shipper-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closePhysicalCountDetailedShipperView() {
  $('physical-count-detailed-shipper-panel').classList.add('hidden');
  $('physical-count-standard-panel').classList.remove('hidden');
  $('physical-count-standard-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function printPhysicalCountDetailedShipperView() {
  const rows = state.data.physicalCountDetailedShipperFiltered || [];
  if (!state.data.physicalCountRaw.length) {
    return toast('Physical Count data is not loaded yet. Refresh the module and try again.', 'error');
  }
  if (!rows.length) {
    return toast('No Detailed Shipper View rows match the current Physical Count filters.', 'error');
  }

  const printArea = document.createElement('section');
  printArea.id = 'print-area';
  printArea.className = 'physical-count-print physical-count-detailed-shipper-print';

  const generatedAt = new Date().toLocaleString();
  const selectedMode = getPhysicalCountSortMode();
  const resolvedMode = selectedMode === 'auto'
    ? ($('physical-count-racks').value.trim() ? 'rack' : 'alpha')
    : selectedMode;
  const sortLabel = selectedMode === 'auto'
    ? `Auto → ${physicalCountSortLabel(resolvedMode)}`
    : physicalCountSortLabel(resolvedMode);
  const shipperBoxes = new Set(rows.map((row) => row.shipper_box_no).filter(Boolean));

  printArea.innerHTML = `
    <div class="physical-count-print-header">
      <h1>IFTC WAREHOUSE LOCATOR SYSTEM (JPM)</h1>
      <p class="physical-count-print-subtitle">PHYSICAL COUNT — DETAILED SHIPPER VIEW</p>

      <div class="physical-count-print-meta">
        <div><strong>Generated:</strong> ${escapeHtml(generatedAt)}</div>
        <div><strong>Count lines:</strong> ${rows.length.toLocaleString()}</div>
        <div><strong>Filters:</strong> ${escapeHtml(physicalCountFilterSummary())}</div>
        <div><strong>Sort:</strong> ${escapeHtml(sortLabel)}</div>
        <div><strong>Physical Shipper boxes:</strong> ${shipperBoxes.size.toLocaleString()}</div>
        <div><strong>Rule:</strong> Each SB stays together: SHIPPER first, then CONTENT.</div>
      </div>

      <div class="physical-count-check-lines">
        <div class="physical-count-check-line"><strong>Checker:</strong></div>
        <div class="physical-count-check-line"><strong>Date / Time Checked:</strong></div>
        <div class="physical-count-check-line"><strong>Verified By:</strong></div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th class="pcd-rack">Rack #</th>
          <th class="pcd-type">Type</th>
          <th class="pcd-shipper">Shipper Box</th>
          <th class="pcd-sku">SKU / Description / Size</th>
          <th class="pcd-uom">UOM</th>
          <th class="pcd-qty">System Qty</th>
          <th class="pcd-expiry">Expiry</th>
          <th class="pcd-container">Container #</th>
          <th class="pcd-remarks">Checker’s Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => {
          const type = row.detailed_type || 'REGULAR';
          const isContent = type === 'CONTENT';
          const isShipperHeader = type === 'SHIPPER';
          const rowClass = [
            isShipperHeader ? 'pcd-shipper-header' : '',
            isContent ? 'pcd-shipper-content' : '',
            row.detailed_group_start ? 'pcd-group-start' : ''
          ].filter(Boolean).join(' ');
          const shipperLabel = row.shipper_box_no
            ? `${escapeHtml(row.shipper_box_no)}${row.shipper_status ? `<br><small>${escapeHtml(row.shipper_status)}</small>` : ''}`
            : '—';
          const skuLabel = `${isContent ? '<span class="pcd-indent">↳</span> ' : ''}${escapeHtml(physicalCountDetailedSkuDisplay(row))}`;
          return `<tr class="${rowClass}">
            <td class="pcd-rack"><strong>${escapeHtml(row.location_code || '—')}</strong></td>
            <td class="pcd-type"><strong>${escapeHtml(type)}</strong></td>
            <td class="pcd-shipper">${shipperLabel}</td>
            <td class="pcd-sku">${isShipperHeader ? `<strong>${skuLabel}</strong>` : skuLabel}</td>
            <td class="pcd-uom">${escapeHtml(row.uom || '—')}</td>
            <td class="pcd-qty">${fmtQty(row.qty)}</td>
            <td class="pcd-expiry">${isNoExpiryDate(row.expiry_date) ? 'N/A' : fmtDate(row.expiry_date)}</td>
            <td class="pcd-container">${escapeHtml(row.container_no || '—')}</td>
            <td class="pcd-remarks">&nbsp;</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>

    <div class="physical-count-print-footer">
      <strong>Read-only system reference.</strong> REGULAR rows keep the current Physical Count consolidation rule. Shipper-linked rows remain separated by exact SB identity so each physical box can be checked with its own contents. No inventory is changed by this report.
    </div>
  `;

  document.body.appendChild(printArea);
  try {
    window.print();
  } finally {
    setTimeout(() => printArea.remove(), 1000);
  }
}

function printPhysicalCount() {
  const rows = state.data.physicalCountFiltered || [];

  if (!state.data.physicalCount.length) {
    return toast('Physical Count data is not loaded yet. Refresh the module and try again.', 'error');
  }
  if (!rows.length) {
    return toast('No Physical Count rows match the current filters.', 'error');
  }

  const printArea = document.createElement('section');
  printArea.id = 'print-area';
  printArea.className = 'physical-count-print';

  const generatedAt = new Date().toLocaleString();
  const selectedMode = getPhysicalCountSortMode();
  const resolvedMode = selectedMode === 'auto'
    ? ($('physical-count-racks').value.trim() ? 'rack' : 'alpha')
    : selectedMode;
  const sortLabel = selectedMode === 'auto'
    ? `Auto → ${physicalCountSortLabel(resolvedMode)}`
    : physicalCountSortLabel(resolvedMode);

  printArea.innerHTML = `
    <div class="physical-count-print-header">
      <h1>IFTC WAREHOUSE LOCATOR SYSTEM (JPM)</h1>
      <p class="physical-count-print-subtitle">PHYSICAL COUNT SHEET</p>

      <div class="physical-count-print-meta">
        <div><strong>Generated:</strong> ${escapeHtml(generatedAt)}</div>
        <div><strong>System lines:</strong> ${rows.length.toLocaleString()}</div>
        <div><strong>Filters:</strong> ${escapeHtml(physicalCountFilterSummary())}</div>
        <div><strong>Sort:</strong> ${escapeHtml(sortLabel)}</div>
      </div>

      <div class="physical-count-check-lines">
        <div class="physical-count-check-line"><strong>Checker:</strong></div>
        <div class="physical-count-check-line"><strong>Date / Time Checked:</strong></div>
        <div class="physical-count-check-line"><strong>Verified By:</strong></div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th class="pc-rack">Rack #</th>
          <th class="pc-sku">SKU — Brand / Description / Variant</th>
          <th class="pc-size">Size</th>
          <th class="pc-uom">UOM</th>
          <th class="pc-qty">System Qty</th>
          <th class="pc-expiry">Expiry</th>
          <th class="pc-container">Container #</th>
          <th class="pc-remarks">Checker’s Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td class="pc-rack"><strong>${escapeHtml(row.location_code || '—')}</strong></td>
            <td class="pc-sku">${escapeHtml(physicalCountSkuDisplay(row) || row.sku_name || '—')}</td>
            <td class="pc-size">${escapeHtml(row.size || '—')}</td>
            <td class="pc-uom">${escapeHtml(row.uom || '—')}</td>
            <td class="pc-qty">${fmtQty(row.qty)}</td>
            <td class="pc-expiry">${isNoExpiryDate(row.expiry_date) ? 'N/A' : fmtDate(row.expiry_date)}</td>
            <td class="pc-container">${escapeHtml(row.container_no || '—')}</td>
            <td class="pc-remarks">&nbsp;</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="physical-count-print-footer">
      <strong>System reference only.</strong> Differences found during physical checking must be processed through the authorized WMS adjustment/correction workflow; this printed sheet does not modify inventory.
    </div>
  `;

  document.body.appendChild(printArea);

  try {
    window.print();
  } finally {
    setTimeout(() => printArea.remove(), 1000);
  }
}

async function loadInventory(force = false) {
  if (!force && state.data.inventory.length) return renderInventory();

  // Load the complete Inventory dataset in the same safe paged manner used by
  // Physical Count. A single large .limit(...) request can still be capped by
  // the Supabase/PostgREST API row limit and silently omit later inventory rows.
  const pageSize = 1000;
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('v_inventory_search')
      .select('*')
      .order('location_sort_order', { ascending: true, nullsFirst: false })
      .order('location_code')
      .order('sku_name')
      .range(offset, offset + pageSize - 1);

    if (error) throw error;

    const page = data || [];
    rows.push(...page);

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  state.data.inventory = rows;
  renderInventory();
}

function inventoryHoldStatus(row) {
  if (row.is_on_hold) {
    return `<span class="pill expired">ON HOLD</span>${row.hold_reason ? `<br><small>${escapeHtml(row.hold_reason)}</small>` : ''}`;
  }
  if (row.is_releasable === false && row.shipper_header_on_hold) {
    return '<span class="pill expired">BOX ON HOLD</span><br><small>The Shipper HEADER is frozen.</small>';
  }
  if (row.is_releasable === false && row.shipper_box_has_hold) {
    return '<span class="pill expired">BOX HAS HELD CONTENT</span><br><small>Whole-box release is blocked.</small>';
  }
  return '';
}

function inventoryLotActions(row) {
  if (!isSupervisor()) return '';
  const lotId = escapeHtml(row.lot_id);
  const remarks = `<button class="link-btn" data-inventory-remarks="${lotId}">Edit remarks</button>`;
  const breakdown = `<button class="link-btn" data-inventory-breakdown="${lotId}">Breakdown</button>`;
  const remarkActions = `${remarks} ${breakdown}`;
  const blocked = row.is_releasable === false;
  if (row.is_on_hold) {
    return isAdminOrOwner()
      ? `<td>${remarkActions} <button class="link-btn" data-inventory-hold="${lotId}" data-hold-state="release">Unfreeze lot</button><br><small>Remarks may be updated while ON HOLD · Unfreeze reason required</small></td>`
      : `<td>${remarkActions}<br><small>ON HOLD · Admin / Owner must unfreeze</small></td>`;
  }
  if (blocked) {
    return `<td>${remarkActions}<br><small>Structural correction blocked by Shipper hold. Remarks remain editable.</small></td>`;
  }
  const freeze = isAdminOrOwner() ? ` <button class="link-btn" data-inventory-hold="${lotId}" data-hold-state="freeze">Freeze lot</button>` : '';
  if (row.shipper_box_id) {
    return `<td><button class="link-btn" data-inventory-edit="${lotId}">Edit</button> ${remarkActions}${freeze}<br><small>Shipper-safe correction · ${escapeHtml(row.shipper_box_no || '')}</small></td>`;
  }
  return `<td><button class="link-btn" data-inventory-edit="${lotId}">Edit</button> ${remarkActions}${isAdminOrOwner() ? ` <button class="link-btn" data-inventory-delete="${lotId}">Delete</button>${freeze}` : '<br><small>Delete / Freeze: Admin / Owner only</small>'}</td>`;
}

function exactRackSearchEnabled(buttonId) {
  return $(buttonId)?.getAttribute('aria-pressed') === 'true';
}

function exactRackLocationMatches(locationCode, searchValue) {
  const wanted = normalizeLocation(searchValue);
  if (!wanted) return true;
  return normalizeLocation(locationCode || '') === wanted;
}

function toggleExactRackSearch(buttonId, renderFn) {
  const button = $(buttonId);
  if (!button) return;
  const active = !exactRackSearchEnabled(buttonId);
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  button.textContent = active ? 'Exact rack ✓' : 'Exact rack';
  button.classList.toggle('primary', active);
  button.classList.toggle('secondary', !active);
  renderFn();
}

function inventorySearchText(r) {
  // IMPORTANT: This is the exact field set used by the original Inventory search.
  // Filter 2 deliberately reuses the same text so it only narrows Search 1 results.
  return [
    r.sku_name, r.brand, r.description, r.variant, r.size,
    r.case_barcode, r.pack_barcode, r.piece_barcode,
    r.container_no, r.location_code, isNoExpiryDate(r.expiry_date) ? 'N/A no expiry' : r.expiry_date,
    r.uom, r.putaway_remarks, r.transfer_remarks,
    r.shipper_box_no, r.shipper_status, r.shipper_lot_role,
    r.is_pending ? 'PENDING pending location awaiting rack vacancy' : '',
    r.is_on_hold ? 'on hold frozen freeze' : '', r.hold_reason
  ].join(' ').toLowerCase();
}

function filteredInventoryRows() {
  const term = $('inventory-search').value.trim().toLowerCase();
  const filterTerm = $('inventory-filter').value.trim().toLowerCase();
  const search1ExactRack = exactRackSearchEnabled('inventory-search-exact-rack');
  const filter2ExactRack = exactRackSearchEnabled('inventory-filter-exact-rack');

  // This is intentionally the same filtering rule used by the existing Inventory screen.
  const primaryRows = state.data.inventory.filter((r) => {
    if (!term) return true;
    return search1ExactRack
      ? exactRackLocationMatches(r.location_code, term)
      : inventorySearchText(r).includes(term);
  });

  return filterTerm
    ? primaryRows.filter((r) => filter2ExactRack
      ? exactRackLocationMatches(r.location_code, filterTerm)
      : inventorySearchText(r).includes(filterTerm))
    : primaryRows;
}

function buildInventorySummaryRows(rows) {
  const grouped = new Map();

  (rows || []).forEach((r) => {
    const item = grouped.get(r.sku_id) || {
      sku_id: r.sku_id,
      sku_name: r.sku_name,
      balances: { PIECE: 0, PACK: 0, CASE: 0 },
      containers: new Set(),
      locations: new Set(),
      earliest: r.expiry_date,
      heldLots: 0
    };

    item.balances[r.uom] = (item.balances[r.uom] || 0) + Number(r.qty);
    item.containers.add(r.container_no);
    item.locations.add(r.location_code);

    if (r.expiry_date < item.earliest) item.earliest = r.expiry_date;
    if (r.is_on_hold) item.heldLots += 1;

    grouped.set(r.sku_id, item);
  });

  return [...grouped.values()].sort((a, b) =>
    String(a.sku_name || '').localeCompare(String(b.sku_name || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  );
}

function inventoryFilterReportText() {
  const parts = [];
  const search1 = $('inventory-search').value.trim();
  const filter2 = $('inventory-filter').value.trim();

  if (search1) {
    parts.push(`Search 1: ${search1}${exactRackSearchEnabled('inventory-search-exact-rack') ? ' [Exact rack]' : ''}`);
  }
  if (filter2) {
    parts.push(`Filter 2: ${filter2}${exactRackSearchEnabled('inventory-filter-exact-rack') ? ' [Exact rack]' : ''}`);
  }

  return parts.length ? parts.join(' · ') : 'No filters — all currently loaded positive inventory';
}

function inventoryDetailedStatusText(row) {
  const parts = [];

  if (isNoExpiryDate(row.expiry_date)) parts.push('Expiry N/A');
  else if (row.expiry_status) parts.push(String(row.expiry_status).replaceAll('_', ' '));

  if (row.is_on_hold) {
    parts.push(`ON HOLD${row.hold_reason ? `: ${row.hold_reason}` : ''}`);
  }

  if (row.is_pending) parts.push('PENDING');

  return parts.join(' · ') || 'Active';
}

function inventoryDetailedShipperText(row) {
  if (!row.shipper_box_no) return '';
  const bits = [row.shipper_box_no, row.shipper_status, row.shipper_lot_role].filter(Boolean);
  return bits.join(' · ');
}

function downloadCsvRows(filename, columns, rows) {
  if (!rows.length) {
    return toast('There is no filtered data to export.', 'error');
  }

  const csv = [
    columns.map((column) => csvCell(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(','))
  ].join('\n');

  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFilteredInventorySkuSummaryCsv() {
  const rows = buildInventorySummaryRows(filteredInventoryRows());
  const date = new Date().toISOString().slice(0, 10);

  downloadCsvRows(
    `inventory-sku-summary-filtered-${date}.csv`,
    [
      { label: 'SKU', value: (r) => r.sku_name || '' },
      { label: 'CASE Qty', value: (r) => Number(r.balances?.CASE || 0) },
      { label: 'PACK Qty', value: (r) => Number(r.balances?.PACK || 0) },
      { label: 'PIECE Qty', value: (r) => Number(r.balances?.PIECE || 0) },
      { label: 'Container Count', value: (r) => r.containers.size },
      { label: 'Location Count', value: (r) => r.locations.size },
      { label: 'Held Lot Count', value: (r) => r.heldLots || 0 },
      { label: 'Earliest Expiry', value: (r) => isNoExpiryDate(r.earliest) ? 'N/A' : (r.earliest || '') }
    ],
    rows
  );
}

function exportFilteredInventoryDetailedLotsCsv() {
  const rows = filteredInventoryRows();
  const date = new Date().toISOString().slice(0, 10);

  downloadCsvRows(
    `inventory-detailed-lots-filtered-${date}.csv`,
    [
      { label: 'Location', value: (r) => r.location_code || '' },
      { label: 'SKU', value: (r) => r.sku_name || '' },
      { label: 'Shipper Box', value: inventoryDetailedShipperText },
      { label: 'Container', value: (r) => r.container_no || '' },
      { label: 'Expiry', value: (r) => isNoExpiryDate(r.expiry_date) ? 'N/A' : (r.expiry_date || '') },
      { label: 'Status', value: inventoryDetailedStatusText },
      { label: 'UOM', value: (r) => String(r.uom || '').toUpperCase() },
      { label: 'Quantity', value: (r) => Number(r.qty || 0) },
      { label: 'Put-away Remarks', value: (r) => r.putaway_remarks || '' },
      { label: 'Stock Transfer Remarks', value: (r) => r.transfer_remarks || '' }
    ],
    rows
  );
}

function printInventorySection(kind) {
  const filteredRows = filteredInventoryRows();
  const isSummary = kind === 'summary';
  const rows = isSummary ? buildInventorySummaryRows(filteredRows) : filteredRows;

  if (!rows.length) {
    return toast('There is no filtered Inventory data to print.', 'error');
  }

  const printArea = document.createElement('section');
  printArea.id = 'print-area';
  printArea.className = 'inventory-section-print';

  const generatedAt = new Date().toLocaleString();
  const subtitle = isSummary ? 'INVENTORY — SKU SUMMARY' : 'INVENTORY — DETAILED LOTS';

  const table = isSummary
    ? `<table>
        <thead><tr>
          <th class="invp-sku">SKU</th>
          <th class="invp-balances">Balances</th>
          <th class="invp-count">Containers</th>
          <th class="invp-count">Locations</th>
          <th class="invp-held">Held Lots</th>
          <th class="invp-expiry">Earliest Expiry</th>
        </tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="invp-sku">${escapeHtml(r.sku_name || '—')}</td>
          <td class="invp-balances">${escapeHtml(formatBalances(r.balances))}</td>
          <td class="invp-count">${r.containers.size.toLocaleString()}</td>
          <td class="invp-count">${r.locations.size.toLocaleString()}</td>
          <td class="invp-held">${r.heldLots ? `${r.heldLots.toLocaleString()} ON HOLD` : '—'}</td>
          <td class="invp-expiry">${isNoExpiryDate(r.earliest) ? 'N/A' : fmtDate(r.earliest)}</td>
        </tr>`).join('')}</tbody>
      </table>`
    : `<table>
        <thead><tr>
          <th class="invl-location">Location</th>
          <th class="invl-sku">SKU</th>
          <th class="invl-shipper">Shipper Box</th>
          <th class="invl-container">Container</th>
          <th class="invl-expiry">Expiry</th>
          <th class="invl-status">Status</th>
          <th class="invl-qty">Quantity</th>
          <th class="invl-remarks">Put-away Remarks</th>
          <th class="invl-remarks">Transfer Remarks</th>
        </tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="invl-location"><strong>${escapeHtml(r.location_code || '—')}</strong></td>
          <td class="invl-sku">${escapeHtml(r.sku_name || '—')}</td>
          <td class="invl-shipper">${escapeHtml(inventoryDetailedShipperText(r) || '—')}</td>
          <td class="invl-container">${escapeHtml(r.container_no || '—')}</td>
          <td class="invl-expiry">${isNoExpiryDate(r.expiry_date) ? 'N/A' : fmtDate(r.expiry_date)}</td>
          <td class="invl-status">${escapeHtml(inventoryDetailedStatusText(r))}</td>
          <td class="invl-qty">${escapeHtml(fmtQtyUom(r.qty, r.uom))}</td>
          <td class="invl-remarks">${escapeHtml(r.putaway_remarks || '—')}</td>
          <td class="invl-remarks">${escapeHtml(r.transfer_remarks || '—')}</td>
        </tr>`).join('')}</tbody>
      </table>`;

  printArea.innerHTML = `
    <div class="inventory-print-header">
      <h1>IFTC WAREHOUSE LOCATOR SYSTEM (JPM)</h1>
      <p class="inventory-print-subtitle">${escapeHtml(subtitle)}</p>
      <div class="inventory-print-meta">
        <div><strong>Generated:</strong> ${escapeHtml(generatedAt)}</div>
        <div><strong>Report lines:</strong> ${rows.length.toLocaleString()}</div>
        <div><strong>Filters:</strong> ${escapeHtml(inventoryFilterReportText())}</div>
        <div><strong>Source:</strong> Current positive Inventory</div>
      </div>
    </div>
    ${table}
    <div class="inventory-print-footer">
      <strong>Read-only report.</strong> This printout reflects the current filtered Inventory view and does not modify warehouse stock.
    </div>`;

  document.body.appendChild(printArea);

  try {
    window.print();
  } finally {
    setTimeout(() => printArea.remove(), 1000);
  }
}

function printInventorySkuSummary() {
  printInventorySection('summary');
}

function printInventoryDetailedLots() {
  printInventorySection('lots');
}

function renderInventory() {
  const rows = filteredInventoryRows();
  const summaryRows = buildInventorySummaryRows(rows);
  $('inventory-summary-table').innerHTML = summaryRows.length ? `<table><thead><tr><th>SKU</th><th>Balances</th><th>Containers</th><th>Locations</th><th>Held lots</th><th>Earliest expiry</th></tr></thead><tbody>${summaryRows.map((r) => `<tr><td class="wrap">${escapeHtml(r.sku_name)}</td><td>${formatBalances(r.balances)}</td><td>${r.containers.size}</td><td>${r.locations.size}</td><td>${r.heldLots ? `<span class="pill expired">${r.heldLots} ON HOLD</span>` : '—'}</td><td>${fmtDate(r.earliest)}</td></tr>`).join('')}</tbody></table>` : emptyState('No matching SKU summary.');
  const actionHeader = isSupervisor() ? '<th>Actions</th>' : '';
  $('inventory-table').innerHTML = rows.length ? `<table><thead><tr><th>Location</th><th>SKU</th><th>Shipper box</th><th>Container</th><th>Expiry</th><th>Status</th><th>Quantity</th><th>Put-away remarks</th><th>Stock transfer remarks</th>${actionHeader}</tr></thead><tbody>${rows.map((r) => {
    const expiry = isNoExpiryDate(r.expiry_date) ? '<span class="pill">N/A</span>' : expiryPill(r.expiry_status);
    const hold = inventoryHoldStatus(r);
    const locationDisplay = r.is_pending
      ? `<strong>${escapeHtml(r.location_code || 'PENDING')}</strong><br><span class="pill near">PENDING</span>`
      : escapeHtml(r.location_code);
    const putawayEdited = r.putaway_remarks_overridden ? '<br><small>Current remark edited · original History preserved</small>' : '';
    const transferEdited = r.transfer_remarks_overridden ? '<br><small>Current remark edited · original History preserved</small>' : '';
    return `<tr>
      <td>${locationDisplay}</td><td class="wrap">${escapeHtml(r.sku_name)}</td><td>${shipperBadge(r)}</td><td>${escapeHtml(r.container_no)}</td><td>${fmtDate(r.expiry_date)}</td><td class="wrap">${expiry}${hold ? `<br>${hold}` : ''}</td><td>${fmtQtyUom(r.qty, r.uom)}</td><td class="wrap">${escapeHtml(r.putaway_remarks || '—')}${putawayEdited}</td><td class="wrap">${escapeHtml(r.transfer_remarks || '—')}${transferEdited}</td>
      ${inventoryLotActions(r)}
    </tr>`;
  }).join('')}</tbody></table>` : emptyState('No matching inventory.');
}

const INVENTORY_REMARK_BREAKDOWN_MAX_ROWS = 20;

function inventoryRemarkBreakdownUomAbbrev(uom) {
  return ({ CASE: 'CS', PACK: 'PK', PIECE: 'PC' })[String(uom || '').toUpperCase()] || String(uom || '').toUpperCase();
}

function inventoryRemarkBreakdownAcceptedUnits(uom) {
  const normalized = String(uom || '').toUpperCase();
  if (normalized === 'CASE') return new Set(['CS', 'CASE', 'CASES']);
  if (normalized === 'PACK') return new Set(['PK', 'PACK', 'PACKS']);
  if (normalized === 'PIECE') return new Set(['PC', 'PCS', 'PIECE', 'PIECES']);
  return new Set([normalized]);
}

function parseInventoryRemarkBreakdown(text, uom) {
  const raw = String(text || '').trim();
  if (!raw) return { structured: true, entries: [] };

  const acceptedUnits = inventoryRemarkBreakdownAcceptedUnits(uom);
  const parts = raw.split(/\s*(?:\||;)\s*/).filter(Boolean);
  const entries = [];
  const seen = new Set();

  for (const part of parts) {
    const match = part.match(/^(.+?)\s*=\s*(\d+)\s*([A-Za-z]+)?\s*$/);
    if (!match) return { structured: false, entries: [] };

    const category = match[1].trim();
    const qty = Number(match[2]);
    const unit = String(match[3] || '').toUpperCase();
    const key = category.toLowerCase().replace(/\s+/g, ' ');

    if (!category || category.includes('|') || category.includes('=') || !Number.isInteger(qty) || qty <= 0) {
      return { structured: false, entries: [] };
    }
    if (unit && !acceptedUnits.has(unit)) return { structured: false, entries: [] };
    if (seen.has(key)) return { structured: false, entries: [] };

    seen.add(key);
    entries.push({ category, qty });
  }

  return { structured: true, entries };
}

function formatInventoryRemarkBreakdown(entries, uom) {
  const suffix = inventoryRemarkBreakdownUomAbbrev(uom);
  return entries
    .map((entry) => `${String(entry.category || '').trim().replace(/\s+/g, ' ').toUpperCase()}=${Number(entry.qty)}${suffix}`)
    .join(' | ');
}

function ensureInventoryRemarkBreakdownUi() {
  const form = $('inventory-remarks-form');
  if (!form) return;

  const launchers = [
    { textareaId: 'inventory-remarks-putaway', kind: 'PUTAWAY', label: 'Open Put-away breakdown' },
    { textareaId: 'inventory-remarks-transfer', kind: 'TRANSFER', label: 'Open Stock Transfer breakdown' }
  ];

  launchers.forEach(({ textareaId, kind, label }) => {
    const textarea = $(textareaId);
    const fieldLabel = textarea?.closest('label');
    if (!textarea || !fieldLabel || form.querySelector(`[data-inventory-remark-breakdown-launch="${kind}"]`)) return;

    const controls = document.createElement('div');
    controls.className = 'small-note';
    controls.innerHTML = `<button type="button" class="link-btn" data-inventory-remark-breakdown-launch="${kind}">${escapeHtml(label)}</button> · Optional helper only; actual stock quantity is not changed.`;
    fieldLabel.insertAdjacentElement('afterend', controls);
    controls.querySelector('button').addEventListener('click', () => openInventoryRemarkBreakdown(kind));
  });

  if ($('inventory-remark-breakdown-panel')) return;

  const reasonLabel = $('inventory-remarks-reason')?.closest('label');
  if (!reasonLabel) return;

  const panel = document.createElement('div');
  panel.id = 'inventory-remark-breakdown-panel';
  panel.className = 'info-box hidden';
  panel.innerHTML = `
    <div><strong id="inventory-remark-breakdown-title">Remark quantity breakdown</strong></div>
    <div id="inventory-remark-breakdown-context" class="small-note"></div>
    <div id="inventory-remark-breakdown-notice" class="small-note"></div>
    <div id="inventory-remark-breakdown-rows" class="stack"></div>
    <div>
      <button id="inventory-remark-breakdown-add" type="button" class="link-btn">+ Add category</button>
    </div>
    <div id="inventory-remark-breakdown-total" class="small-note"></div>
    <p class="small-note">Only exceptional categories need to be listed. Any remaining quantity is shown as Unspecified / normal. A category may contain combined wording such as DENTED + FADED LABEL.</p>
    <div>
      <button id="inventory-remark-breakdown-apply" type="button" class="primary">Apply breakdown to remark field</button>
      <button id="inventory-remark-breakdown-cancel" type="button" class="link-btn">Cancel</button>
    </div>`;
  reasonLabel.insertAdjacentElement('beforebegin', panel);

  $('inventory-remark-breakdown-add').addEventListener('click', () => addInventoryRemarkBreakdownRow());
  $('inventory-remark-breakdown-apply').addEventListener('click', applyInventoryRemarkBreakdown);
  $('inventory-remark-breakdown-cancel').addEventListener('click', closeInventoryRemarkBreakdown);
  $('inventory-remark-breakdown-rows').addEventListener('input', updateInventoryRemarkBreakdownTotals);
  $('inventory-remark-breakdown-rows').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-inventory-breakdown-row]');
    if (!remove) return;
    remove.closest('[data-inventory-breakdown-row]')?.remove();
    if (!$('inventory-remark-breakdown-rows').children.length) addInventoryRemarkBreakdownRow();
    updateInventoryRemarkBreakdownTotals();
  });
}

function closeInventoryRemarkBreakdown() {
  const panel = $('inventory-remark-breakdown-panel');
  if (!panel) return;
  panel.classList.add('hidden');
  panel.dataset.kind = '';
  panel.dataset.lotId = '';
}

function addInventoryRemarkBreakdownRow(entry = {}) {
  const rows = $('inventory-remark-breakdown-rows');
  if (!rows) return;
  if (rows.children.length >= INVENTORY_REMARK_BREAKDOWN_MAX_ROWS) {
    return toast(`A maximum of ${INVENTORY_REMARK_BREAKDOWN_MAX_ROWS} breakdown categories is allowed.`, 'error');
  }

  const row = document.createElement('div');
  row.className = 'info-box';
  row.setAttribute('data-inventory-breakdown-row', '');
  row.innerHTML = `
    <div class="form-grid two">
      <label>Category<input data-breakdown-category maxlength="80" placeholder="Example: DENTED" value="${escapeHtml(entry.category || '')}" /></label>
      <label>Quantity<input data-breakdown-qty type="number" min="1" step="1" inputmode="numeric" placeholder="0" value="${entry.qty ? escapeHtml(String(entry.qty)) : ''}" /></label>
    </div>
    <button type="button" class="link-btn" data-remove-inventory-breakdown-row>Remove</button>`;
  rows.appendChild(row);
}

function collectInventoryRemarkBreakdownEntries() {
  const rows = [...($('inventory-remark-breakdown-rows')?.querySelectorAll('[data-inventory-breakdown-row]') || [])];
  const entries = [];
  const seen = new Set();
  let error = '';

  for (const row of rows) {
    const categoryRaw = row.querySelector('[data-breakdown-category]')?.value || '';
    const qtyRaw = row.querySelector('[data-breakdown-qty]')?.value || '';
    const category = categoryRaw.trim().replace(/\s+/g, ' ');
    const qty = Number(qtyRaw);

    if (!category && !qtyRaw) continue;
    if (!category) { error = 'Every quantity needs a category.'; break; }
    if (category.includes('|') || category.includes('=')) { error = 'Category names cannot contain | or =.'; break; }
    if (!Number.isInteger(qty) || qty <= 0) { error = 'Every category quantity must be a whole number greater than zero.'; break; }

    const key = category.toLowerCase();
    if (seen.has(key)) { error = `Duplicate category: ${category}. Combine it into one row.`; break; }
    seen.add(key);
    entries.push({ category, qty });
  }

  return { entries, error };
}

function updateInventoryRemarkBreakdownTotals() {
  const panel = $('inventory-remark-breakdown-panel');
  const totalBox = $('inventory-remark-breakdown-total');
  const applyButton = $('inventory-remark-breakdown-apply');
  if (!panel || !totalBox || !applyButton) return;

  const row = state.data.inventory.find((item) => item.lot_id === panel.dataset.lotId);
  if (!row) {
    totalBox.innerHTML = '<strong>Lot is no longer available. Close and refresh Inventory.</strong>';
    applyButton.disabled = true;
    return;
  }

  const { entries, error } = collectInventoryRemarkBreakdownEntries();
  const tracked = entries.reduce((sum, entry) => sum + entry.qty, 0);
  const stockQty = Number(row.qty || 0);
  const uom = inventoryRemarkBreakdownUomAbbrev(row.uom);
  const unspecified = stockQty - tracked;
  const formatted = formatInventoryRemarkBreakdown(entries, row.uom);

  if (error) {
    totalBox.innerHTML = `<strong>⚠ ${escapeHtml(error)}</strong>`;
    applyButton.disabled = true;
    return;
  }
  if (!entries.length) {
    totalBox.innerHTML = `Inventory quantity: <strong>${escapeHtml(String(stockQty))} ${escapeHtml(uom)}</strong><br>Add at least one exceptional category to use the breakdown helper.`;
    applyButton.disabled = true;
    return;
  }
  if (tracked > stockQty) {
    totalBox.innerHTML = `<strong>⚠ INVALID BREAKDOWN</strong><br>Tracked categories: ${escapeHtml(String(tracked))} ${escapeHtml(uom)}<br>Inventory quantity: ${escapeHtml(String(stockQty))} ${escapeHtml(uom)}<br>Over by: ${escapeHtml(String(tracked - stockQty))} ${escapeHtml(uom)}`;
    applyButton.disabled = true;
    return;
  }
  if (formatted.length > 1000) {
    totalBox.innerHTML = '<strong>⚠ The formatted remark exceeds the existing 1,000-character remark limit.</strong>';
    applyButton.disabled = true;
    return;
  }

  totalBox.innerHTML = tracked === stockQty
    ? `<strong>✓ FULLY CATEGORIZED</strong><br>Tracked categories: ${escapeHtml(String(tracked))} ${escapeHtml(uom)}<br>Inventory quantity: ${escapeHtml(String(stockQty))} ${escapeHtml(uom)}`
    : `<strong>✓ VALID</strong><br>Tracked exceptional categories: ${escapeHtml(String(tracked))} ${escapeHtml(uom)}<br>Unspecified / normal: ${escapeHtml(String(unspecified))} ${escapeHtml(uom)}<br>Inventory quantity: ${escapeHtml(String(stockQty))} ${escapeHtml(uom)}`;
  applyButton.disabled = false;
}

function openInventoryRemarkBreakdown(kind) {
  ensureInventoryRemarkBreakdownUi();
  const lotId = $('inventory-remarks-lot-id')?.value;
  const row = state.data.inventory.find((item) => item.lot_id === lotId);
  if (!row) return toast('Inventory lot is no longer available. Refresh Inventory and try again.', 'error');

  const normalizedKind = kind === 'TRANSFER' ? 'TRANSFER' : 'PUTAWAY';
  const textarea = $(normalizedKind === 'PUTAWAY' ? 'inventory-remarks-putaway' : 'inventory-remarks-transfer');
  const panel = $('inventory-remark-breakdown-panel');
  const rows = $('inventory-remark-breakdown-rows');
  if (!textarea || !panel || !rows) return;

  const parsed = parseInventoryRemarkBreakdown(textarea.value, row.uom);
  rows.innerHTML = '';
  if (parsed.structured && parsed.entries.length) {
    parsed.entries.forEach((entry) => addInventoryRemarkBreakdownRow(entry));
  } else {
    addInventoryRemarkBreakdownRow();
  }

  panel.dataset.kind = normalizedKind;
  panel.dataset.lotId = lotId;
  $('inventory-remark-breakdown-title').textContent = `${normalizedKind === 'PUTAWAY' ? 'Put-away' : 'Stock Transfer'} remark quantity breakdown`;
  $('inventory-remark-breakdown-context').innerHTML = `${escapeHtml(row.sku_name)} · ${escapeHtml(row.location_code)} · ${escapeHtml(row.container_no)} · ${fmtDate(row.expiry_date)} · Current stock ${fmtQtyUom(row.qty, row.uom)}`;
  $('inventory-remark-breakdown-notice').innerHTML = parsed.structured
    ? (parsed.entries.length ? 'Existing structured remark detected and loaded below.' : 'No structured remark is currently saved. Add only the exceptional categories you want to track.')
    : `<strong>Current remark is free text and was not changed:</strong> ${escapeHtml(textarea.value.trim())}<br>Using this helper will replace that current remark only after you click “Apply breakdown to remark field,” then save the main Remarks form with a reason.`;
  panel.classList.remove('hidden');
  updateInventoryRemarkBreakdownTotals();
}

function applyInventoryRemarkBreakdown() {
  const panel = $('inventory-remark-breakdown-panel');
  if (!panel) return;
  const row = state.data.inventory.find((item) => item.lot_id === panel.dataset.lotId);
  if (!row) return toast('Inventory lot is no longer available. Refresh Inventory and try again.', 'error');

  const { entries, error } = collectInventoryRemarkBreakdownEntries();
  const tracked = entries.reduce((sum, entry) => sum + entry.qty, 0);
  const stockQty = Number(row.qty || 0);
  if (error) return toast(error, 'error');
  if (!entries.length) return toast('Add at least one category.', 'error');
  if (tracked > stockQty) return toast('Breakdown quantity cannot exceed the current Inventory quantity.', 'error');

  const formatted = formatInventoryRemarkBreakdown(entries, row.uom);
  if (formatted.length > 1000) return toast('The formatted remark exceeds the 1,000-character limit.', 'error');

  const textarea = $(panel.dataset.kind === 'TRANSFER' ? 'inventory-remarks-transfer' : 'inventory-remarks-putaway');
  if (!textarea) return;
  textarea.value = formatted;
  closeInventoryRemarkBreakdown();
  toast('Breakdown applied to the current remark field. Enter the required reason and Save current remarks to commit it.', 'success');
}


async function openInventoryBreakdownHelper(lotId) {
  await openInventoryRemarksEdit(lotId);
  const dialog = $('inventory-remarks-dialog');
  if (!dialog?.open) return;
  const firstLauncher = dialog.querySelector('[data-inventory-remark-breakdown-launch="PUTAWAY"]');
  firstLauncher?.scrollIntoView({ block: 'center' });
  toast('Breakdown helper opened. Choose Put-away or Stock Transfer breakdown; normal free-text remark editing is still available in the same dialog.');
}

async function openInventoryRemarksEdit(lotId) {
  if (!isSupervisor()) return toast('Supervisor, Admin, or Owner access is required.', 'error');
  const row = state.data.inventory.find((r) => r.lot_id === lotId);
  if (!row) return toast('Inventory lot is no longer available. Refresh Inventory and try again.', 'error');

  ensureInventoryRemarkBreakdownUi();
  closeInventoryRemarkBreakdown();
  $('inventory-remarks-lot-id').value = lotId;
  $('inventory-remarks-current').innerHTML = `<strong>Current lot:</strong> ${escapeHtml(row.sku_name)} · ${escapeHtml(row.location_code)} · ${escapeHtml(row.container_no)} · ${fmtDate(row.expiry_date)} · ${fmtQtyUom(row.qty, row.uom)}${row.is_on_hold ? '<br><span class="pill expired">ON HOLD</span> Remarks may be updated without releasing the hold.' : ''}`;
  $('inventory-remarks-putaway').value = row.putaway_remarks || '';
  $('inventory-remarks-transfer').value = row.transfer_remarks || '';
  $('inventory-remarks-history').innerHTML = `<strong>Original transaction remarks are never rewritten.</strong><br>
    Historical Put-away remarks: ${escapeHtml(row.historical_putaway_remarks || '—')}<br>
    Historical Stock transfer remarks: ${escapeHtml(row.historical_transfer_remarks || '—')}<br>
    <small>Saving below changes only the current Inventory/Detailed-Lots remark shown and searched for this lot. Audit History records the change.</small>`;
  $('inventory-remarks-reason').value = '';
  $('inventory-remarks-dialog').showModal();
}

async function submitInventoryRemarksEdit(event) {
  event.preventDefault();
  if (!isSupervisor()) return toast('Supervisor, Admin, or Owner access is required.', 'error');

  const lotId = $('inventory-remarks-lot-id').value;
  const row = state.data.inventory.find((r) => r.lot_id === lotId);
  if (!row) return toast('Inventory lot is no longer available. Refresh Inventory and try again.', 'error');

  const putaway = $('inventory-remarks-putaway').value.trim();
  const transfer = $('inventory-remarks-transfer').value.trim();
  const reason = $('inventory-remarks-reason').value.trim();

  if (!reason) return toast('Enter the reason for changing the current remarks.', 'error');
  if (reason.length > 500) return toast('Remark-change reason is limited to 500 characters.', 'error');
  if (putaway.length > 1000 || transfer.length > 1000) return toast('Each current remark is limited to 1000 characters.', 'error');

  const button = event.submitter;
  setBusy(button, true, 'Saving…');
  const { error } = await supabase.rpc('supervisor_set_inventory_lot_remarks', {
    p_lot_id: lotId,
    p_putaway_remarks: putaway || null,
    p_transfer_remarks: transfer || null,
    p_reason: reason
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  $('inventory-remarks-dialog').close();
  invalidateReports();
  await loadInventory(true);
  toast('Current Detailed-Lot remarks updated. Original transaction History was preserved and an Audit record was saved.', 'success');
}

async function toggleInventoryLotHold(lotId, shouldHold) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required to freeze or unfreeze an inventory lot.', 'error');
  const row = state.data.inventory.find((r) => r.lot_id === lotId);
  if (!row) return toast('Inventory lot is no longer available. Refresh Inventory and try again.', 'error');

  const action = shouldHold ? 'FREEZE / PLACE ON HOLD' : 'UNFREEZE / RELEASE HOLD';
  const reason = window.prompt(`${action} reason (required):\n\n${row.sku_name}\n${row.location_code} · ${row.container_no} · ${fmtDate(row.expiry_date)} · ${fmtQtyUom(row.qty, row.uom)}`);
  if (!reason?.trim()) return toast('A reason is required.', 'error');
  if (reason.trim().length > 500) return toast('Hold/release reason is limited to 500 characters.', 'error');

  const warning = shouldHold
    ? 'This exact lot will remain visible in Inventory but cannot be Picked, Stock Transferred, barcode-bypassed, or reduced/moved by Detailed-Lot correction until Admin/Owner unfreezes it. For a SEALED Shipper HEADER, the whole physical box is held; holding a Shipper CONTENT lot also blocks whole-box release.'
    : 'This lot will become eligible for Picking/Transfer again, subject to the normal barcode, FEFO, Shipper, rack-lock, and stock rules.';
  if (!window.confirm(`${action} this inventory lot?\n\n${row.sku_name}\n${row.location_code} · ${row.container_no} · ${fmtQtyUom(row.qty, row.uom)}\n\n${warning}`)) return;

  const { data, error } = await supabase.rpc('admin_set_inventory_lot_hold', {
    p_lot_id: lotId,
    p_hold: Boolean(shouldHold),
    p_reason: reason.trim()
  });
  if (error) return toast(friendlyError(error), 'error');

  invalidateReports();
  await loadInventory(true);
  const result = data?.[0];
  toast(result?.is_on_hold ? 'Inventory lot placed ON HOLD. Release is now blocked.' : 'Inventory lot hold released. Normal eligibility restored.', 'success');
}

async function openInventoryLotEdit(lotId) {
  if (!isSupervisor()) return toast('Supervisor, Admin, or Owner access is required.', 'error');
  const row = state.data.inventory.find((r) => r.lot_id === lotId);
  if (!row) return toast('Inventory lot is no longer available. Refresh Inventory and try again.', 'error');
  if (row.is_releasable === false) return toast('This lot is ON HOLD or blocked by a Shipper hold. Admin/Owner must unfreeze the held lot before it can be corrected.', 'error');

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
  if (!isSupervisor()) return toast('Supervisor, Admin, or Owner access is required.', 'error');

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
      const hasCase = Boolean(skuHealthActual(r.case_barcode));
      const hasPack = Boolean(skuHealthActual(r.pack_barcode));
      const hasPiece = Boolean(skuHealthActual(r.piece_barcode));
      if (!hasCase && !hasPack && !hasPiece) return false; // intentional barcode-less STANDARD SKU
      return !hasCase || !hasPack || !hasPiece;
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


function stockCardBalancesObject(value) {
  const source = value || {};
  return {
    CASE: Number(source.CASE || source.case || 0),
    PACK: Number(source.PACK || source.pack || 0),
    PIECE: Number(source.PIECE || source.piece || 0)
  };
}

function stockCardMovementGroup(eventType) {
  const type = String(eventType || '').toUpperCase();
  if (type.includes('PUT-AWAY')) return 'PUTAWAY';
  if (type.includes('TRANSFER')) return 'TRANSFER';
  if (type.includes('PICKING')) return 'PICK';
  if (type.includes('SO 0')) return 'ADJUSTMENT';
  if (type.includes('ADJUSTMENT') || type.includes('CORRECTION') || type.includes('DELETE')) return 'ADJUSTMENT';
  return type;
}

function stockCardSkuLabel(row) {
  const name = [row.brand, row.description, row.variant, row.size].filter(Boolean).join(' ');
  const status = row.is_active === false ? 'ARCHIVED' : 'ACTIVE';
  const balances = formatBalances({
    CASE: row.current_case_qty,
    PACK: row.current_pack_qty,
    PIECE: row.current_piece_qty
  });
  return `${name} · ${row.sku_type || 'STANDARD'} · ${status} · ${balances}`;
}

function scheduleStockCardSuggestions() {
  clearTimeout(stockCardSuggestionTimer);
  const term = $('stock-card-search').value.trim();
  if (term.length < 2) {
    stockCardSuggestionRequest += 1;
    state.stockCardCandidates = [];
    $('stock-card-sku').innerHTML = '<option value="">Search or scan a SKU first</option>';
    hideStockCardSuggestions();
    return;
  }
  stockCardSuggestionTimer = setTimeout(() => fetchStockCardCandidates(term, { live: true }), 250);
}

function hideStockCardSuggestions() {
  const box = $('stock-card-suggestions');
  if (!box) return;
  box.classList.add('hidden');
  $('stock-card-search')?.setAttribute('aria-expanded', 'false');
}

function stockCardSuggestionDetails(row) {
  const balances = formatBalances({ CASE: row.current_case_qty, PACK: row.current_pack_qty, PIECE: row.current_piece_qty });
  return [
    `${row.sku_type || 'STANDARD'} · ${row.is_active === false ? 'ARCHIVED' : 'ACTIVE'}`,
    `CASE ${row.case_barcode || 'N/A'}`, `PACK ${row.pack_barcode || 'N/A'}`, `PIECE ${row.piece_barcode || 'N/A'}`,
    `Current: ${balances}`
  ].join(' · ');
}

function renderStockCardSuggestions() {
  const box = $('stock-card-suggestions');
  if (!box) return;
  const candidates = state.stockCardCandidates || [];
  if (!candidates.length) {
    box.innerHTML = '<div class="stock-card-suggestion-empty">No matching SKU found.</div>';
    box.classList.remove('hidden');
    $('stock-card-search').setAttribute('aria-expanded', 'true');
    return;
  }
  const visible = candidates.slice(0, 15);
  box.innerHTML = visible.map((row) => `
    <button type="button" class="stock-card-suggestion" role="option" data-stock-card-sku-id="${escapeHtml(row.sku_id)}">
      <strong>${escapeHtml([row.brand,row.description,row.variant,row.size].filter(Boolean).join(' '))}</strong>
      <span class="stock-card-suggestion-meta">${escapeHtml(stockCardSuggestionDetails(row))}</span>
    </button>`).join('') + (candidates.length > visible.length
      ? `<div class="stock-card-suggestion-empty">${(candidates.length-visible.length).toLocaleString()} more match(es). Continue typing to narrow the list.</div>` : '');
  box.classList.remove('hidden');
  $('stock-card-search').setAttribute('aria-expanded','true');
}

async function fetchStockCardCandidates(term, options = {}) {
  const cleanTerm = String(term || '').trim();
  if (!cleanTerm) return [];
  const requestId = ++stockCardSuggestionRequest;
  const { data, error } = await supabase.rpc('stock_card_find_skus', { p_search: cleanTerm });
  if (requestId !== stockCardSuggestionRequest) return null;
  if (error) {
    if (!options.live) toast(friendlyError(error), 'error');
    hideStockCardSuggestions();
    return null;
  }
  state.stockCardCandidates = data || [];
  $('stock-card-sku').innerHTML = state.stockCardCandidates.length
    ? '<option value="">Select the exact SKU</option>' + state.stockCardCandidates.map((row) =>
      `<option value="${escapeHtml(row.sku_id)}">${escapeHtml(stockCardSkuLabel(row))}</option>`).join('')
    : '<option value="">No matching SKU found</option>';
  if (options.live) renderStockCardSuggestions();
  return state.stockCardCandidates;
}

async function findStockCardSkus(event) {
  if (event?.preventDefault) event.preventDefault();
  clearTimeout(stockCardSuggestionTimer);
  const term = $('stock-card-search').value.trim();
  if (!term) {
    state.stockCardCandidates = [];
    $('stock-card-sku').innerHTML = '<option value="">Enter or scan a SKU / barcode first</option>';
    hideStockCardSuggestions();
    return toast('Enter or scan a SKU / barcode first.', 'error');
  }
  const button = event?.submitter || $('stock-card-find-btn');
  setBusy(button, true, 'Finding…');
  const candidates = await fetchStockCardCandidates(term, { live: true });
  setBusy(button, false);
  if (candidates === null) return;
  if (!candidates.length) return toast('No SKU matched that search or barcode.', 'warning');
  if (candidates.length === 1) $('stock-card-sku').value = candidates[0].sku_id;
  toast(`${candidates.length.toLocaleString()} matching SKU record(s) found. Select the exact SKU from the suggestions.`, 'success');
}

async function handleStockCardSuggestionClick(event) {
  const button = event.target.closest('[data-stock-card-sku-id]');
  if (!button) return;
  const skuId = button.dataset.stockCardSkuId;
  const row = state.stockCardCandidates.find((candidate) => candidate.sku_id === skuId);
  if (!row) return;
  $('stock-card-sku').value = skuId;
  $('stock-card-search').value = [row.brand,row.description,row.variant,row.size].filter(Boolean).join(' ');
  hideStockCardSuggestions();
  await loadStockCard(true);
}


async function loadStockCard(force = false) {
  const skuId = $('stock-card-sku')?.value || '';
  if (!skuId) {
    if (force) toast('Search/scan and select the exact SKU first.', 'error');
    return renderStockCard();
  }

  if (!force && state.stockCardMeta?.sku?.sku_id === skuId) {
    return renderStockCard();
  }

  const fromDate = $('stock-card-from').value || null;
  const toDate = $('stock-card-to').value || null;
  const rack = normalizeLocation($('stock-card-rack').value);

  if (fromDate && toDate && toDate < fromDate) {
    return toast('Stock Card end date cannot be earlier than the start date.', 'error');
  }

  const button = $('stock-card-load-btn');
  setBusy(button, true, 'Loading…');

  const { data, error } = await supabase.rpc('get_sku_balance_stock_card', {
    p_sku_id: skuId,
    p_from_date: fromDate,
    p_to_date: toDate,
    p_location_code: rack || null
  });

  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  state.stockCardMeta = data || null;
  state.data.stockCard = Array.isArray(data?.events) ? data.events : [];
  renderStockCard();
}

function clearStockCard() {
  $('stock-card-search-form').reset();
  $('stock-card-sku').innerHTML = '<option value="">Search or scan a SKU first</option>';
  $('stock-card-uom').value = '';
  $('stock-card-movement').value = '';
  clearTimeout(stockCardSuggestionTimer);
  stockCardSuggestionRequest += 1;
  state.stockCardCandidates = [];
  hideStockCardSuggestions();
  state.data.stockCard = [];
  state.data.stockCardExport = [];
  state.stockCardMeta = null;
  renderStockCard();
  $('stock-card-search').focus();
}

function renderStockCard() {
  const meta = state.stockCardMeta;
  const info = $('stock-card-selected-info');
  const summary = $('stock-card-balance-summary');
  const table = $('stock-card-table');
  const count = $('stock-card-count');
  const retention = $('stock-card-retention-note');

  if (!meta?.sku) {
    info.classList.add('hidden');
    summary.classList.add('hidden');
    retention.textContent = 'Search/scan a SKU and load its Stock Card.';
    count.textContent = 'Select a SKU to load its stock card.';
    table.innerHTML = emptyState('No Stock Card loaded.');
    state.data.stockCardExport = [];
    return;
  }

  const selectedUom = $('stock-card-uom').value;
  const selectedMovement = $('stock-card-movement').value;
  const allRows = state.data.stockCard || [];
  const rows = allRows.filter((row) => {
    const uomMatches = !selectedUom || row.uom === selectedUom;
    const movementMatches = !selectedMovement || stockCardMovementGroup(row.event_type) === selectedMovement;
    return uomMatches && movementMatches;
  });

  const sku = meta.sku;
  const rackMode = meta.filters?.rack_code
    ? `<strong>Exact rack mode:</strong> ${escapeHtml(meta.filters.rack_code)}`
    : '<strong>Mode:</strong> Overall SKU balance across all rack locations';

  info.innerHTML = `<strong>${escapeHtml(sku.sku_name)}</strong><br>
    Type: ${escapeHtml(sku.sku_type || 'STANDARD')} ·
    CASE: ${escapeHtml(sku.case_barcode || 'N/A')} ·
    PACK: ${escapeHtml(sku.pack_barcode || 'N/A')} ·
    PIECE: ${escapeHtml(sku.piece_barcode || 'N/A')}<br>${rackMode}`;
  info.classList.remove('hidden');

  const opening = stockCardBalancesObject(meta.opening_balances);
  const closing = stockCardBalancesObject(meta.closing_balances);
  const current = stockCardBalancesObject(meta.current_balances);

  summary.innerHTML = `<strong>Balance reconciliation</strong><br>
    Opening for selected period: <strong>${escapeHtml(formatBalances(opening))}</strong><br>
    Closing for selected period: <strong>${escapeHtml(formatBalances(closing))}</strong><br>
    Current live balance now: <strong>${escapeHtml(formatBalances(current))}</strong>`;
  summary.classList.remove('hidden');

  retention.textContent = meta.retention_note || '';

  count.textContent = `${rows.length.toLocaleString()} of ${allRows.length.toLocaleString()} retained movement event(s) shown`;

  state.data.stockCardExport = rows.map((row) => ({
    event_at: row.event_at,
    movement: row.event_type,
    reference: row.reference_no,
    sales_order: row.sales_order,
    source_rack: row.source_location_code,
    destination_rack: row.destination_location_code,
    container: row.container_no,
    expiry: row.expiry_date,
    uom: row.uom,
    movement_qty: row.movement_qty,
    qty_in: row.qty_in,
    qty_out: row.qty_out,
    balance_after: row.running_balance,
    user: row.username,
    remarks: row.remarks,
    flags: row.flags
  }));

  table.innerHTML = rows.length ? `<table>
    <thead><tr>
      <th>Date / time</th>
      <th>Movement</th>
      <th>Reference / SO</th>
      <th>Rack movement</th>
      <th>Container / expiry</th>
      <th>UOM</th>
      <th>Moved</th>
      <th>IN</th>
      <th>OUT</th>
      <th>Balance</th>
      <th>User</th>
      <th>Remarks / flags</th>
    </tr></thead>
    <tbody>${rows.map((row) => {
      const from = row.source_location_code || '';
      const to = row.destination_location_code || '';
      const rackText = from && to
        ? (from === to ? escapeHtml(from) : `${escapeHtml(from)} → ${escapeHtml(to)}`)
        : escapeHtml(from || to || '—');
      const ref = [row.reference_no, row.sales_order ? `SO ${row.sales_order}` : ''].filter(Boolean).join(' · ') || '—';
      const expiry = row.expiry_date ? fmtDate(row.expiry_date) : '—';
      const notes = row.remarks
        ? `${escapeHtml(row.remarks)}${row.flags ? `<br><small>${escapeHtml(row.flags)}</small>` : ''}`
        : (row.flags ? `<small>${escapeHtml(row.flags)}</small>` : '');
      return `<tr>
        <td>${fmtDateTime(row.event_at)}</td>
        <td><strong>${escapeHtml(row.event_type || 'Movement')}</strong></td>
        <td>${escapeHtml(ref)}</td>
        <td>${rackText}</td>
        <td>${escapeHtml(row.container_no || '—')}<br><small>${expiry}</small></td>
        <td><span class="pill">${escapeHtml(row.uom || '')}</span></td>
        <td>${Number(row.movement_qty || 0) ? fmtQty(row.movement_qty) : '—'}</td>
        <td>${Number(row.qty_in || 0) ? fmtQty(row.qty_in) : '—'}</td>
        <td>${Number(row.qty_out || 0) ? fmtQty(row.qty_out) : '—'}</td>
        <td><strong>${fmtQty(row.running_balance)}</strong></td>
        <td>${escapeHtml(row.username || '—')}</td>
        <td class="wrap">${notes || '—'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>` : emptyState('No retained movements match the selected Stock Card filters.');
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

function containerReportSkuCompare(a, b) {
  const fields = ['brand', 'description', 'variant', 'size'];
  for (const field of fields) {
    const result = String(a?.[field] || '').localeCompare(String(b?.[field] || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
    if (result) return result;
  }

  const expiryCompare = String(a?.expiry_date || '').localeCompare(String(b?.expiry_date || ''));
  if (expiryCompare) return expiryCompare;

  return String(a?.uom || '').localeCompare(String(b?.uom || ''), undefined, {
    sensitivity: 'base'
  });
}

function containerReportRackRows() {
  return [...(state.containerReport.rows || [])].sort((a, b) => {
    const rackCompare = comparePhysicalCountRackCodes(a.location_code, b.location_code);
    if (rackCompare) return rackCompare;

    const skuCompare = containerReportSkuCompare(a, b);
    if (skuCompare) return skuCompare;

    const shipperCompare = String(a.shipper_box_no || '').localeCompare(String(b.shipper_box_no || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
    if (shipperCompare) return shipperCompare;

    return String(a.lot_id || '').localeCompare(String(b.lot_id || ''));
  });
}

function containerReportSkuTotalRows() {
  const grouped = new Map();

  (state.containerReport.rows || []).forEach((row) => {
    // User rule: rack detail is disregarded in SKU-total mode.
    // UOM and expiry remain part of the identity so unlike stock is never mixed.
    const key = [
      row.sku_id || '',
      String(row.uom || '').toUpperCase(),
      row.expiry_date || ''
    ].join('|');

    const existing = grouped.get(key);
    if (existing) {
      existing.qty += Number(row.qty || 0);
      return;
    }

    grouped.set(key, {
      sku_id: row.sku_id || '',
      brand: row.brand || '',
      description: row.description || '',
      variant: row.variant || '',
      size: row.size || '',
      sku_name: row.sku_name || [row.brand, row.description, row.variant, row.size].filter(Boolean).join(' '),
      uom: String(row.uom || '').toUpperCase(),
      qty: Number(row.qty || 0),
      expiry_date: row.expiry_date || null
    });
  });

  return [...grouped.values()]
    .filter((row) => Number(row.qty || 0) > 0)
    .sort(containerReportSkuCompare);
}

function containerReportModeLabel(mode = state.containerReport.mode) {
  return mode === 'sku' ? 'By SKU Total' : 'By Rack';
}

function containerReportShipperText(row) {
  if (!row?.shipper_box_no) return '—';
  const role = String(row.shipper_lot_role || '').trim();
  return role ? `${row.shipper_box_no} (${role})` : row.shipper_box_no;
}

function renderContainerDetailReport() {
  const panel = $('container-detail');
  if (!panel) return;

  const containerNo = state.containerReport.containerNo;
  const mode = state.containerReport.mode === 'sku' ? 'sku' : 'rack';
  const rows = mode === 'sku'
    ? containerReportSkuTotalRows()
    : containerReportRackRows();

  const controls = `
    <div class="container-report-toolbar">
      <div class="container-report-mode-toggle" role="group" aria-label="Container report mode">
        <button type="button"
          class="secondary container-report-mode-btn ${mode === 'rack' ? 'active' : ''}"
          data-container-report-mode="rack"
          aria-pressed="${mode === 'rack' ? 'true' : 'false'}">By Rack</button>
        <button type="button"
          class="secondary container-report-mode-btn ${mode === 'sku' ? 'active' : ''}"
          data-container-report-mode="sku"
          aria-pressed="${mode === 'sku' ? 'true' : 'false'}">By SKU Total</button>
      </div>
      <button type="button" class="primary" data-container-report-print ${rows.length ? '' : 'disabled'}>
        Print / Save PDF
      </button>
    </div>
    <p class="small-note">
      ${mode === 'rack'
        ? 'Natural rack order: A1, A2, A3 … A9, A10, A11 …; then SKU.'
        : 'Same SKU + expiry + UOM is totaled across racks. Rack and Shipper-box detail are intentionally disregarded.'}
    </p>`;

  let table = '';

  if (!rows.length) {
    table = emptyState('This container has no remaining stock. It has been fully consumed or never received.');
  } else if (mode === 'sku') {
    table = `<div class="table-wrap"><table class="container-report-preview"><thead><tr>
      <th>SKU — Brand / Description / Variant</th><th>Size</th><th>UOM</th><th>Expiry</th><th>Total Qty</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td class="wrap">${escapeHtml(physicalCountSkuDisplay(r) || r.sku_name || '—')}</td>
      <td>${escapeHtml(r.size || '—')}</td>
      <td>${escapeHtml(r.uom || '—')}</td>
      <td>${isNoExpiryDate(r.expiry_date) ? 'N/A' : fmtDate(r.expiry_date)}</td>
      <td><strong>${fmtQty(r.qty)}</strong></td>
    </tr>`).join('')}</tbody></table></div>`;
  } else {
    table = `<div class="table-wrap"><table class="container-report-preview"><thead><tr>
      <th>Rack #</th><th>SKU — Brand / Description / Variant</th><th>Size</th><th>UOM</th><th>Qty</th><th>Expiry</th><th>Shipper Box</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td><strong>${escapeHtml(r.location_code || '—')}</strong></td>
      <td class="wrap">${escapeHtml(physicalCountSkuDisplay(r) || r.sku_name || '—')}</td>
      <td>${escapeHtml(r.size || '—')}</td>
      <td>${escapeHtml(String(r.uom || '').toUpperCase() || '—')}</td>
      <td>${fmtQty(r.qty)}</td>
      <td>${isNoExpiryDate(r.expiry_date) ? 'N/A' : fmtDate(r.expiry_date)}</td>
      <td>${escapeHtml(containerReportShipperText(r))}</td>
    </tr>`).join('')}</tbody></table></div>`;
  }

  panel.innerHTML = `
    <div class="card-head container-detail-head">
      <div>
        <h3>Container ${escapeHtml(containerNo || '—')}</h3>
        <p>Current remaining contents · ${escapeHtml(containerReportModeLabel(mode))}</p>
      </div>
    </div>
    ${controls}
    ${table}`;
}

function setContainerReportMode(mode) {
  if (!state.containerReport.containerNo) return;
  if (!['rack', 'sku'].includes(mode)) return;

  state.containerReport.mode = mode;
  renderContainerDetailReport();
}

function printContainerDetailReport() {
  const containerNo = state.containerReport.containerNo;
  if (!containerNo) return toast('Open a container Details report first.', 'error');

  const mode = state.containerReport.mode === 'sku' ? 'sku' : 'rack';
  const rows = mode === 'sku'
    ? containerReportSkuTotalRows()
    : containerReportRackRows();

  if (!rows.length) {
    return toast('This container has no remaining stock to print.', 'error');
  }

  const printArea = document.createElement('section');
  printArea.id = 'print-area';
  printArea.className = 'container-detail-print';

  const generatedAt = new Date().toLocaleString();

  const table = mode === 'sku'
    ? `<table>
        <thead><tr>
          <th class="cr-sku">SKU — Brand / Description / Variant</th>
          <th class="cr-size">Size</th>
          <th class="cr-uom">UOM</th>
          <th class="cr-expiry">Expiry</th>
          <th class="cr-qty">Total Qty</th>
        </tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="cr-sku">${escapeHtml(physicalCountSkuDisplay(r) || r.sku_name || '—')}</td>
          <td class="cr-size">${escapeHtml(r.size || '—')}</td>
          <td class="cr-uom">${escapeHtml(r.uom || '—')}</td>
          <td class="cr-expiry">${isNoExpiryDate(r.expiry_date) ? 'N/A' : fmtDate(r.expiry_date)}</td>
          <td class="cr-qty">${fmtQty(r.qty)}</td>
        </tr>`).join('')}</tbody>
      </table>`
    : `<table>
        <thead><tr>
          <th class="cr-rack">Rack #</th>
          <th class="cr-sku">SKU — Brand / Description / Variant</th>
          <th class="cr-size">Size</th>
          <th class="cr-uom">UOM</th>
          <th class="cr-qty">Qty</th>
          <th class="cr-expiry">Expiry</th>
          <th class="cr-shipper">Shipper Box</th>
        </tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="cr-rack"><strong>${escapeHtml(r.location_code || '—')}</strong></td>
          <td class="cr-sku">${escapeHtml(physicalCountSkuDisplay(r) || r.sku_name || '—')}</td>
          <td class="cr-size">${escapeHtml(r.size || '—')}</td>
          <td class="cr-uom">${escapeHtml(String(r.uom || '').toUpperCase() || '—')}</td>
          <td class="cr-qty">${fmtQty(r.qty)}</td>
          <td class="cr-expiry">${isNoExpiryDate(r.expiry_date) ? 'N/A' : fmtDate(r.expiry_date)}</td>
          <td class="cr-shipper">${escapeHtml(containerReportShipperText(r))}</td>
        </tr>`).join('')}</tbody>
      </table>`;

  printArea.innerHTML = `
    <div class="container-report-print-header">
      <h1>IFTC WAREHOUSE LOCATOR SYSTEM (JPM)</h1>
      <p class="container-report-print-subtitle">CONTAINER CONTENT REPORT</p>
      <div class="container-report-print-meta">
        <div><strong>Container #:</strong> ${escapeHtml(containerNo)}</div>
        <div><strong>Report mode:</strong> ${escapeHtml(containerReportModeLabel(mode))}</div>
        <div><strong>Generated:</strong> ${escapeHtml(generatedAt)}</div>
        <div><strong>Report lines:</strong> ${rows.length.toLocaleString()}</div>
      </div>
    </div>
    ${table}
    <div class="container-report-print-footer">
      <strong>Read-only current-stock report.</strong>
      ${mode === 'sku'
        ? 'Quantities are totaled by SKU + expiry + UOM across all racks in this container.'
        : 'Rows are arranged in natural rack order, then by SKU.'}
    </div>`;

  document.body.appendChild(printArea);

  try {
    window.print();
  } finally {
    setTimeout(() => printArea.remove(), 1000);
  }
}

async function showContainerDetail(containerNo) {
  const panel = $('container-detail');
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="empty-state">Loading container details…</div>';

  const { data, error } = await supabase
    .from('v_inventory_details')
    .select('*')
    .eq('container_no', containerNo)
    .order('location_sort_order', { ascending: true, nullsFirst: false })
    .order('location_code')
    .order('expiry_date');

  if (error) {
    state.containerReport = { containerNo: null, rows: [], mode: 'rack' };
    panel.innerHTML = `<div class="warning-box">${escapeHtml(friendlyError(error))}</div>`;
    return;
  }

  state.containerReport = {
    containerNo,
    rows: data || [],
    mode: 'rack'
  };

  renderContainerDetailReport();
}

async function loadRackMap(force = false) {
  if (!force && state.data.rackMap.length) return renderRackMap();
  const { data, error } = await supabase
    .from('v_location_summary')
    .select('*')
    .eq('is_active', true)
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
  return ({ owner: 5, admin: 4, supervisor: 3, user: 2, viewer: 1 })[String(role || '').toLowerCase()] || 0;
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
  const roleCounts = ['owner','admin','supervisor','user','viewer']
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
    ? ['viewer','user','supervisor','admin','owner']
    : ['viewer','user','supervisor','admin'];
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

  const viewerWarning = newRole === 'viewer'
    ? '\n\nVIEWER is read-only. Before continuing, make sure this employee has finished/cancelled any unsaved Put-away/Picking/Transfer work on their device. The database will refuse the change if they still own an active rack lock or OPEN Sales Order.'
    : '';
  if (!window.confirm(`Change ${row.username} from ${userRoleLabel(row.role)} to ${userRoleLabel(newRole)}?${viewerWarning}`)) return;

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
  state.data.auditFiltered = [];
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
  state.data.auditFiltered = [];
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
  state.data.auditFiltered = [];
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

async function loadPagedHistoryDataset(table, columns, orderColumns = []) {
  const pageSize = 1000;
  const rows = [];
  let offset = 0;

  while (true) {
    let query = supabase.from(table).select(columns);
    for (const order of orderColumns) {
      query = query.order(order.column, { ascending: order.ascending !== false });
    }

    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) return { data: null, error };

    const page = data || [];
    rows.push(...page);

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return { data: rows, error: null };
}

async function loadHistory(force = false) {
  ensureAuditCoverageDefaults();

  const revertStatusReady = !isAdminOrOwner() || state.pickRevertStatusLoaded;
  if (!force && state.data.history.length && state.data.audit.length && revertStatusReady) {
    populateAuditActionFilter();
    renderHistory();
    return renderAuditHistory();
  }

  // Transaction History is loaded in complete 1,000-row pages so PostgREST's
  // per-request row ceiling cannot silently cut off older retained transactions.
  // The V4 historical remark overlays use the same paged read-only loader so they
  // remain complete even when retained history grows beyond one large request.
  // System Audit keeps its existing independent 90-day paged loader.
  //
  // Admin/Owner also receives one lightweight, read-only line-status snapshot for
  // the PICK-line Revert controls. Failure of that optional status RPC must never
  // stop normal History/Audit from loading.
  const revertStatusPromise = isAdminOrOwner()
    ? supabase.rpc('admin_get_history_pick_revert_statuses')
    : Promise.resolve({ data: [], error: null });

  const [historyRes, auditRows, revertStatusRes, lineRemarkRes, transactionRemarkRes, repairRes] = await Promise.all([
    loadPagedHistoryDataset('v_history_details', '*', [
      { column: 'created_at', ascending: false },
      { column: 'line_no', ascending: true },
      { column: 'transaction_id', ascending: true },
      { column: 'line_id', ascending: true }
    ]),
    loadAuditHistory90Days(),
    revertStatusPromise,
    loadPagedHistoryDataset('transaction_line_user_remarks', 'transaction_line_id,remark,remark_context,remark_source', [
      { column: 'transaction_line_id', ascending: true }
    ]),
    loadPagedHistoryDataset('transaction_user_remarks', 'transaction_id,remark,remark_context', [
      { column: 'transaction_id', ascending: true }
    ]),
    loadPagedHistoryDataset('transaction_remark_scope_repairs', 'transaction_id,suppress_legacy_parent_note,suppress_legacy_line_note,repair_type', [
      { column: 'transaction_id', ascending: true }
    ])
  ]);

  if (historyRes.error) throw historyRes.error;

  if (lineRemarkRes?.error) console.warn('Per-line user remarks unavailable:', lineRemarkRes.error);
  if (transactionRemarkRes?.error) console.warn('Transaction user remarks unavailable:', transactionRemarkRes.error);
  if (repairRes?.error) console.warn('Remark-scope repair overlays unavailable:', repairRes.error);

  const lineRemarkById = new Map((lineRemarkRes?.data || []).map((row) => [String(row.transaction_line_id), row]));
  const transactionRemarkById = new Map((transactionRemarkRes?.data || []).map((row) => [String(row.transaction_id), row]));
  const repairByTransactionId = new Map((repairRes?.data || []).map((row) => [String(row.transaction_id), row]));

  state.data.history = (historyRes.data || []).map((row) => {
    const lineRemark = lineRemarkById.get(String(row.line_id));
    const transactionRemark = transactionRemarkById.get(String(row.transaction_id));
    const repair = repairByTransactionId.get(String(row.transaction_id));
    return {
      ...row,
      user_line_remark: lineRemark?.remark || null,
      user_line_remark_context: lineRemark?.remark_context || null,
      user_line_remark_source: lineRemark?.remark_source || null,
      user_transaction_remark: transactionRemark?.remark || null,
      user_transaction_remark_context: transactionRemark?.remark_context || null,
      remark_scope_repair_type: repair?.repair_type || null,
      suppress_legacy_parent_note: Boolean(repair?.suppress_legacy_parent_note),
      suppress_legacy_line_note: Boolean(repair?.suppress_legacy_line_note)
    };
  });
  state.data.audit = auditRows || [];

  if (isAdminOrOwner()) {
    if (revertStatusRes?.error) {
      console.warn('History PICK-line Revert status unavailable:', revertStatusRes.error);
      state.pickRevertStatusByLine = new Map();
    } else {
      state.pickRevertStatusByLine = new Map(
        (revertStatusRes?.data || []).map((row) => [String(row.transaction_line_id), row])
      );
    }
    state.pickRevertStatusLoaded = true;
  } else {
    state.pickRevertStatusByLine = new Map();
    state.pickRevertStatusLoaded = true;
  }

  populateAuditActionFilter();
  renderHistory();
  renderAuditHistory();
}

function auditCoverageBounds() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const earliest = new Date(today);
  earliest.setDate(earliest.getDate() - 89); // today + previous 89 dates = 90 calendar days

  const endExclusive = new Date(today);
  endExclusive.setDate(endExclusive.getDate() + 1);

  return {
    minDate: localDateKey(earliest),
    maxDate: localDateKey(today),
    fromIso: earliest.toISOString(),
    toIsoExclusive: endExclusive.toISOString()
  };
}

function ensureAuditCoverageDefaults() {
  const bounds = auditCoverageBounds();
  const from = $('audit-date-from');
  const to = $('audit-date-to');
  if (!from || !to) return bounds;

  from.min = bounds.minDate;
  from.max = bounds.maxDate;
  to.min = bounds.minDate;
  to.max = bounds.maxDate;

  if (!from.value || from.value < bounds.minDate || from.value > bounds.maxDate) {
    from.value = bounds.minDate;
  }
  if (!to.value || to.value < bounds.minDate || to.value > bounds.maxDate) {
    to.value = bounds.maxDate;
  }
  if (from.value > to.value) {
    from.value = bounds.minDate;
    to.value = bounds.maxDate;
  }
  return bounds;
}

async function loadAuditHistory90Days() {
  const bounds = auditCoverageBounds();
  const pageSize = 1000;
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('v_audit_history')
      .select('*')
      .gte('created_at', bounds.fromIso)
      .lt('created_at', bounds.toIsoExclusive)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) throw error;

    const page = data || [];
    rows.push(...page);

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

function populateAuditActionFilter() {
  const select = $('audit-action-filter');
  if (!select) return;

  const current = select.value;
  const actions = [...new Set(
    (state.data.audit || [])
      .map((row) => String(row.action || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  select.innerHTML = '<option value="">All actions</option>' +
    actions.map((action) => `<option value="${escapeHtml(action)}">${escapeHtml(action)}</option>`).join('');

  if (actions.includes(current)) select.value = current;
}

function collectAuditJsonValues(value, keyMatcher, output = []) {
  if (value == null) return output;

  if (Array.isArray(value)) {
    value.forEach((item) => collectAuditJsonValues(item, keyMatcher, output));
    return output;
  }

  if (typeof value !== 'object') return output;

  Object.entries(value).forEach(([key, child]) => {
    const normalizedKey = String(key || '').toLowerCase();

    if (keyMatcher(normalizedKey)) {
      if (child == null) {
        // nothing
      } else if (typeof child === 'object') {
        try { output.push(JSON.stringify(child)); } catch {}
      } else {
        output.push(String(child));
      }
    }

    if (typeof child === 'object' && child !== null) {
      collectAuditJsonValues(child, keyMatcher, output);
    }
  });

  return output;
}

function auditJsonSources(row) {
  return [row?.before_data || null, row?.after_data || null];
}

function auditValuesByMatcher(row, matcher) {
  const values = [];
  auditJsonSources(row).forEach((source) => collectAuditJsonValues(source, matcher, values));
  return values;
}

function auditRemarkSearchText(row) {
  const values = auditValuesByMatcher(row, (key) =>
    key.includes('remark') ||
    key === 'note' ||
    key.endsWith('_note')
  );
  values.unshift(auditEventRemarks(row) || '');
  return values.join(' ').toLowerCase();
}

function auditUserSearchText(row) {
  const values = auditValuesByMatcher(row, (key) =>
    key === 'username' ||
    key.endsWith('_username') ||
    key.includes('approved_by') ||
    key.includes('changed_by')
  );
  values.unshift(row?.username || '');
  return values.join(' ').toLowerCase();
}

function auditSalesOrderValues(row) {
  const values = auditValuesByMatcher(row, (key) =>
    key === 'sales_order' ||
    key === 'order_number' ||
    key === 'order_key' ||
    key === 'salesorder'
  );

  if (String(row?.entity_type || '').toLowerCase() === 'sales_order' && row?.entity_id) {
    values.push(String(row.entity_id));
  }
  return values;
}

function auditContainerValues(row) {
  return auditValuesByMatcher(row, (key) =>
    key === 'container_no' ||
    key === 'container_number' ||
    key === 'container'
  );
}

function auditRackValues(row) {
  return auditValuesByMatcher(row, (key) =>
    key === 'location_code' ||
    key === 'source_location_code' ||
    key === 'destination_location_code' ||
    key === 'rack_code' ||
    key === 'rack'
  );
}

function auditDateKey(value) {
  return localDateKey(value);
}

function filteredAuditHistoryRows() {
  ensureAuditCoverageDefaults();

  const action = $('audit-action-filter').value;
  const user = $('audit-user-filter').value.trim().toLowerCase();
  const remarks = $('audit-remarks-filter').value.trim().toLowerCase();
  const reason = $('audit-reason-filter').value.trim().toLowerCase();
  const so = $('audit-so-filter').value.trim().toLowerCase();
  const container = $('audit-container-filter').value.trim().toLowerCase();
  const rack = normalizeLocation($('audit-rack-filter').value);
  const fromDate = $('audit-date-from').value;
  const toDate = $('audit-date-to').value;

  return (state.data.audit || []).filter((row) => {
    const dateKey = auditDateKey(row.created_at);
    if (fromDate && dateKey && dateKey < fromDate) return false;
    if (toDate && dateKey && dateKey > toDate) return false;

    if (action && row.action !== action) return false;
    if (user && !auditUserSearchText(row).includes(user)) return false;
    if (remarks && !auditRemarkSearchText(row).includes(remarks)) return false;
    if (reason && !String(row.reason || '').toLowerCase().includes(reason)) return false;

    if (so) {
      const values = auditSalesOrderValues(row).map((value) => String(value).toLowerCase());
      if (!values.some((value) => value.includes(so))) return false;
    }

    if (container) {
      const values = auditContainerValues(row).map((value) => String(value).toLowerCase());
      if (!values.some((value) => value.includes(container))) return false;
    }

    if (rack) {
      const values = auditRackValues(row)
        .map((value) => normalizeLocation(value))
        .filter(Boolean);
      if (!values.includes(rack)) return false;
    }

    return true;
  });
}

function clearAuditHistoryFilters() {
  const bounds = ensureAuditCoverageDefaults();

  $('audit-action-filter').value = '';
  $('audit-user-filter').value = '';
  $('audit-remarks-filter').value = '';
  $('audit-reason-filter').value = '';
  $('audit-so-filter').value = '';
  $('audit-container-filter').value = '';
  $('audit-rack-filter').value = '';
  $('audit-date-from').value = bounds.minDate;
  $('audit-date-to').value = bounds.maxDate;

  renderAuditHistory();
}

function historyPickRevertActionHtml(row, transactionHasShipper) {
  if (!isAdminOrOwner()) return '';
  if (row.transaction_type !== 'PICK' || Number(row.signed_qty) >= 0) return '';
  if (transactionHasShipper.has(row.transaction_id)) return '';

  const status = state.pickRevertStatusByLine.get(String(row.line_id));
  if (!status) return '';

  if (status.can_revert) {
    const label = Number(status.completed_correction_qty || 0) > 0 ? 'Revert remaining' : 'Revert';
    return `<button class="link-btn" data-revert-pick-line="${row.line_id}" title="Completed Sales Order only: restore the remaining reversible quantity of this exact Standard PICK line to its original rack.">${label}</button>`;
  }

  if (status.revert_state === 'FULLY_RESTORED') {
    return '<span class="pill">Reverted</span>';
  }
  if (status.revert_state === 'CORRECTION_PENDING') {
    return '<small>Correction pending</small>';
  }
  return '';
}

function renderHistory() {
  const term = $('history-search').value.trim().toLowerCase();
  const type = $('history-type').value;
  const exactRack = exactRackSearchEnabled('history-exact-rack');
  const rows = state.data.history.filter((r) => {
    const haystack = [r.tx_no, r.created_by_username, r.sales_order, r.sku_name, r.container_no, r.location_code, r.transaction_note, r.user_transaction_remark, r.user_line_remark, r.override_reason, r.edit_reason, r.line_note, r.shipper_box_no, r.shipper_status, r.shipper_action].join(' ').toLowerCase();
    const searchMatches = !term || (exactRack
      ? exactRackLocationMatches(r.location_code, term)
      : haystack.includes(term));
    return (!type || r.transaction_type === type) && searchMatches;
  });

  // Use the complete loaded History, not only the currently filtered rows, when
  // deciding whether a transaction contains Shipper lines. This avoids exposing
  // generic correction/revert controls merely because a filter hid the Shipper row.
  const transactionHasShipper = new Set(
    (state.data.history || []).filter((r) => r.shipper_box_id).map((r) => r.transaction_id)
  );
  const transactionHasSavedPickCorrection = new Set(
    (state.data.history || [])
      .filter((r) => {
        if (r.transaction_type !== 'PICK') return false;
        const status = state.pickRevertStatusByLine.get(String(r.line_id));
        return Boolean(status && (Number(status.completed_correction_qty || 0) > 0 || Number(status.unresolved_correction_count || 0) > 0));
      })
      .map((r) => r.transaction_id)
  );
  const transferAllTransactions = new Set(
    (state.data.history || [])
      .filter((r) => r.transaction_type === 'TRANSFER' && (
        String(r.transaction_note || '').trim() === 'Whole source-rack / pallet transfer'
        || String(r.line_note || '').startsWith('Whole source-rack / pallet transfer')
        || String(r.shipper_action || '') === 'WHOLE_RACK_SHIPPER_TRANSFER'
      ))
      .map((r) => r.transaction_id)
  );

  const firstLineByTx = new Set();
  $('history-table').innerHTML = rows.length ? `<table><thead><tr><th>Transaction</th><th>Action</th><th>User / time</th><th>SO</th><th>Location</th><th>SKU / container</th><th>Qty</th><th>Remarks</th><th>Flags</th><th></th></tr></thead><tbody>${rows.map((r) => {
    const first = !firstLineByTx.has(r.transaction_id); firstLineByTx.add(r.transaction_id);
    const flags = [
      r.fefo_overridden ? '<span class="pill override">FEFO override</span>' : '',
      r.barcode_bypassed ? '<span class="pill override">Supervisor barcode bypass</span>' : '',
      r.edited_at ? '<span class="pill">Corrected</span>' : ''
    ].filter(Boolean).join(' ');

    const transactionProtected = transactionHasShipper.has(r.transaction_id);
    const savedPickCorrectionProtected = r.transaction_type === 'PICK' && transactionHasSavedPickCorrection.has(r.transaction_id);
    const transferAllSystemTrace = transferAllTransactions.has(r.transaction_id);
    const rawTransactionNote = String(r.transaction_note || '').trim();
    const visibleLegacyLineNote = r.suppress_legacy_line_note ? '' : String(r.line_note || '').trim();
    const legacyTransferAllTransactionRemark = transferAllSystemTrace
      && rawTransactionNote
      && rawTransactionNote !== 'Whole source-rack / pallet transfer'
      ? rawTransactionNote
      : '';
    const visibleLegacyTransactionRemark = r.suppress_legacy_parent_note
      ? ''
      : (transferAllSystemTrace ? legacyTransferAllTransactionRemark : rawTransactionNote);
    const humanRemark = String(r.user_line_remark || '').trim()
      || (first ? (String(r.user_transaction_remark || '').trim() || visibleLegacyTransactionRemark) : '');
    const lineTraceHtml = visibleLegacyLineNote
      ? `<br><small>${r.shipper_action || transferAllSystemTrace ? '<strong>System:</strong> ' : ''}${escapeHtml(visibleLegacyLineNote)}</small>`
      : '';
    const transactionTraceHtml = first && transferAllSystemTrace
      ? `<br><small><strong>System:</strong> Whole source-rack / pallet transfer</small>`
      : '';
    const repairHtml = first && r.remark_scope_repair_type
      ? `<br><span class="pill active">Remark scope repaired</span>`
      : '';
    const correctAction = first && isAdminOrOwner() && ['PUTAWAY','PICK','TRANSFER'].includes(r.transaction_type) && !transactionProtected && !savedPickCorrectionProtected
      ? `<button class="link-btn" data-edit-transaction="${r.transaction_id}">Correct</button>`
      : (first && transactionProtected
        ? '<small>Shipper transaction protected</small>'
        : (first && savedPickCorrectionProtected ? '<small>Saved Pick correction protected</small>' : ''));
    const revertAction = historyPickRevertActionHtml(r, transactionHasShipper);
    const actions = [correctAction, revertAction].filter(Boolean).join(' ');

    return `<tr><td><strong>${escapeHtml(r.tx_no)}</strong></td><td>${escapeHtml(r.transaction_type)}</td>
      <td>${escapeHtml(r.created_by_username)}<br><small>${fmtDateTime(r.created_at)}</small></td><td>${escapeHtml(r.sales_order || '—')}</td><td>${escapeHtml(r.location_code || '—')}</td>
      <td class="wrap">${escapeHtml(r.sku_name || 'System action')}<br><small>${escapeHtml(r.container_no || '')} ${r.expiry_date ? `· ${fmtDate(r.expiry_date)}` : ''}${r.shipper_box_no ? ` · ${escapeHtml(r.shipper_box_no)}` : ''}</small>${lineTraceHtml}</td>
      <td>${r.signed_qty == null ? '—' : fmtQtyUom(r.signed_qty, r.uom)}</td><td class="wrap">${escapeHtml(humanRemark || '—')}</td><td class="wrap">${flags}${transactionTraceHtml}${repairHtml}${r.shipper_action ? `<br><span class="pill near">${escapeHtml(r.shipper_action)}</span>` : ''}${r.barcode_bypassed ? `<br><small>Bypass by ${escapeHtml(r.bypassed_by_username || r.created_by_username)}: ${escapeHtml(r.bypass_reason || '')}</small>` : ''}${first && r.override_reason ? `<br><small>${escapeHtml(r.override_reason)}</small>` : ''}${first && r.edit_reason ? `<br><small>Edit: ${escapeHtml(r.edit_reason)}</small>` : ''}</td>
      <td>${actions}</td></tr>`;
  }).join('')}</tbody></table>` : emptyState('No matching history.');
}

async function revertHistoryPickLine(transactionLineId) {
  if (!isAdminOrOwner()) return toast('Admin or Owner access is required to Revert a saved PICK line.', 'error');

  const row = (state.data.history || []).find((item) => String(item.line_id) === String(transactionLineId));
  const status = state.pickRevertStatusByLine.get(String(transactionLineId));

  if (!row || !status) {
    return toast('This PICK line could not be verified for Revert. Refresh Transaction History and try again.', 'error');
  }
  if (!status.can_revert) {
    return toast(status.block_reason || 'This PICK line is not eligible for Revert.', 'error');
  }

  const reversibleQty = Number(status.remaining_revert_qty || 0);
  if (!Number.isFinite(reversibleQty) || reversibleQty <= 0) {
    return toast('This PICK line has no remaining quantity available to Revert.', 'error');
  }

  const reason = window.prompt(
    `Reason for reverting this PICK line (required):\n\n` +
    `${row.tx_no} · SO ${row.sales_order || '—'}\n` +
    `${row.sku_name || 'SKU'}\n` +
    `${fmtQtyUom(reversibleQty, row.uom)} → ${row.location_code || 'original rack'}`
  );
  if (reason === null) return;
  if (reason.trim().length < 3 || reason.trim().length > 500) {
    return toast('Revert reason must be between 3 and 500 characters.', 'error');
  }

  const confirmed = window.confirm(
    `REVERT THIS PICK LINE FROM A COMPLETED SALES ORDER?\n\n` +
    `Transaction: ${row.tx_no}\n` +
    `Sales Order: ${row.sales_order || '—'}\n` +
    `SKU: ${row.sku_name || '—'}\n` +
    `Restore: ${fmtQtyUom(reversibleQty, row.uom)}\n` +
    `Original rack: ${row.location_code || '—'}\n` +
    `Container: ${row.container_no || '—'}\n` +
    `Expiry: ${fmtDate(row.expiry_date)}\n\n` +
    `This immediately increases LIVE Inventory at the original rack. ` +
    `The original PICK line will remain unchanged in Transaction History; a separate audited correction and Stock Card adjustment will record the restoration.\n\n` +
    `Use Revert only when the physical stock is actually back / available at that original rack. ` +
    `If the item physically left the rack and still needs to be returned, use the existing Saved Pick Correction physical-return workflow instead.\n\n` +
    `Continue?`
  );
  if (!confirmed) return;

  const button = document.querySelector(`[data-revert-pick-line="${CSS.escape(String(transactionLineId))}"]`);
  if (button) setBusy(button, true, 'Reverting…');

  const { data, error } = await supabase.rpc('admin_revert_history_pick_line', {
    p_transaction_line_id: transactionLineId,
    p_reason: reason.trim()
  });

  if (button) setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  const result = data?.[0] || {};
  invalidateReports();
  await loadHistory(true);
  toast(
    `PICK line reverted: ${fmtQtyUom(result.reverted_qty || reversibleQty, result.uom || row.uom)} restored to ${result.restored_location_code || row.location_code}. Original PICK history preserved; audit recorded.`,
    'success'
  );
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
  const rows = filteredAuditHistoryRows();
  state.data.auditFiltered = rows;

  const bounds = ensureAuditCoverageDefaults();
  const loaded = state.data.audit.length;
  const fromDate = $('audit-date-from').value || bounds.minDate;
  const toDate = $('audit-date-to').value || bounds.maxDate;

  $('audit-history-count').innerHTML =
    `Showing <strong>${rows.length.toLocaleString()}</strong> of <strong>${loaded.toLocaleString()}</strong> retained audit event(s) loaded for the last 90 calendar days · Coverage filter: <strong>${escapeHtml(fromDate)}</strong> to <strong>${escapeHtml(toDate)}</strong>.`;

  $('audit-history-table').innerHTML = rows.length ? `<table><thead><tr><th>Time</th><th>Action</th><th>User</th><th>Entity</th><th>Remarks</th><th>Reason</th><th>Stored details</th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${fmtDateTime(r.created_at)}</td><td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.username || '—')}</td><td>${escapeHtml(r.entity_type)} ${escapeHtml(r.entity_id || '')}</td><td class="wrap">${escapeHtml(auditEventRemarks(r) || '—')}</td><td class="wrap">${escapeHtml(r.reason || '—')}</td>
    <td class="wrap"><details><summary>View JSON</summary><pre>${escapeHtml(JSON.stringify({ before: r.before_data, after: r.after_data }, null, 2))}</pre></details></td></tr>`).join('')}</tbody></table>` : emptyState('No System audit events match the selected filters.');
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
    .eq('is_active', true)
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
  $('locations-table').innerHTML = rows.length ? `<table><thead><tr><th></th><th>Code</th><th>Row</th><th>Position</th><th>Name</th><th>Zone</th><th>Type</th><th>Virtual location manager</th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td><input type="checkbox" data-qr-location="${escapeHtml(r.code)}" ${state.selectedQrLocations.has(r.code) ? 'checked' : ''}></td><td><strong>${escapeHtml(r.code)}</strong></td><td>${escapeHtml(r.row_label || '')}</td><td>${escapeHtml(r.bay_label || '')}</td><td class="wrap">${escapeHtml(r.display_name || '')}</td><td>${escapeHtml(r.zone || '')}</td><td>${r.is_pending ? '<span class="pill near">Pending</span>' : 'Rack'}</td>
    <td>${r.is_pending ? `<button class="link-btn" type="button" data-pending-location-rename="${escapeHtml(r.id)}">Rename</button> <button class="link-btn" type="button" data-pending-location-delete="${escapeHtml(r.id)}">Delete</button>` : '<small>Physical rack protected</small>'}</td>
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
  state.data.auditFiltered = [];
  toast('Location added.', 'success');
  await loadLocations(true);
}

function openPendingLocationRename(locationId) {
  if (!isSupervisor()) return toast('Supervisor access is required.', 'error');
  if (state.mode !== 'ADMINISTRATIVE_PAUSE') return toast('Activate Administrative Pause before renaming a virtual location.', 'error');
  const row = state.data.locations.find((location) => location.id === locationId);
  if (!row) return toast('Virtual location not found. Refresh Locations & QR and try again.', 'error');
  if (!row.is_pending) return toast('Only virtual/pending locations can be renamed here.', 'error');

  $('pending-location-rename-id').value = row.id;
  $('pending-location-rename-current').innerHTML = `<strong>Current virtual location:</strong> ${escapeHtml(row.code)}${row.display_name ? ` · ${escapeHtml(row.display_name)}` : ''}<br><small>The same internal location ID is preserved. If the code changes, reprint the QR label because the old QR code will no longer be valid.</small>`;
  $('pending-location-rename-code').value = row.code || '';
  $('pending-location-rename-name').value = row.display_name || row.code || '';
  $('pending-location-rename-reason').value = '';
  $('pending-location-rename-dialog').showModal();
  $('pending-location-rename-code').focus();
}

async function submitPendingLocationRename(event) {
  event.preventDefault();
  if (!isSupervisor()) return toast('Supervisor access is required.', 'error');
  if (state.mode !== 'ADMINISTRATIVE_PAUSE') return toast('Administrative Pause is required for virtual-location maintenance.', 'error');

  const locationId = $('pending-location-rename-id').value;
  const oldRow = state.data.locations.find((location) => location.id === locationId);
  const newCode = $('pending-location-rename-code').value.trim();
  const newName = $('pending-location-rename-name').value.trim();
  const reason = $('pending-location-rename-reason').value.trim();
  if (!newCode) return toast('New virtual location code is required.', 'error');
  if (!reason) return toast('Reason for renaming is required.', 'error');

  const button = event.submitter;
  setBusy(button, true, 'Renaming…');
  const { data, error } = await supabase.rpc('supervisor_rename_pending_location', {
    p_location_id: locationId,
    p_new_code: newCode,
    p_new_display_name: newName || null,
    p_reason: reason
  });
  setBusy(button, false);
  if (error) return toast(friendlyError(error), 'error');

  $('pending-location-rename-dialog').close();
  if (oldRow?.code) state.selectedQrLocations.delete(oldRow.code);
  state.data.locations = [];
  invalidateReports();
  const row = data?.[0] || {};
  toast(`Virtual location renamed: ${row.old_code || oldRow?.code || 'location'} → ${row.new_code || newCode}. Reprint its QR label.`, 'success');
  await loadLocations(true);
}

async function deletePendingLocation(locationId) {
  if (!isSupervisor()) return toast('Supervisor access is required.', 'error');
  if (state.mode !== 'ADMINISTRATIVE_PAUSE') return toast('Activate Administrative Pause before deleting a virtual location.', 'error');
  const row = state.data.locations.find((location) => location.id === locationId);
  if (!row) return toast('Virtual location not found. Refresh Locations & QR and try again.', 'error');
  if (!row.is_pending) return toast('Physical rack locations are protected. Only virtual/pending locations can be deleted here.', 'error');

  const reason = window.prompt(`Reason for deleting virtual location ${row.code} (required):`);
  if (!reason?.trim()) return toast('Virtual location was not deleted because a reason is required.', 'error');
  const confirmed = window.confirm(`Delete ${row.code} from active warehouse locations?\n\nSafety rules:\n• It must contain ZERO remaining stock.\n• It must have no active Picking/Transfer lock.\n• Confirm nobody has an unsaved Put-away session targeting it.\n• Historical transactions are preserved.\n• The old location code remains reserved and cannot be silently reused.\n\nContinue?`);
  if (!confirmed) return;

  const { data, error } = await supabase.rpc('supervisor_delete_pending_location', {
    p_location_id: locationId,
    p_reason: reason.trim()
  });
  if (error) return toast(friendlyError(error), 'error');

  state.selectedQrLocations.delete(row.code);
  state.data.locations = [];
  invalidateReports();
  toast(`Virtual location ${data?.[0]?.result_location_code || row.code} removed from active warehouse use. History was preserved.`, 'success');
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
  state.data.auditFiltered = [];
  $('control-result').textContent = `${row.new_mode === 'ACTIVE' ? 'Operations resumed' : 'Administrative Pause activated'} · ${row.transaction_no}`;
  $('control-result').classList.remove('hidden');
  toast('Global system mode changed across connected devices.', 'success');
}


async function openFullResetDialog() {
  if (!isOwner()) return toast('Owner access is required.', 'error');

  const button = $('full-reset-open-btn');
  setBusy(button, true, 'Loading preview…');
  try {
    const { data, error } = await supabase.rpc('owner_full_reset_preview_vnext');
    if (error) throw error;
    const row = data?.[0] || {};

    $('full-reset-preview').innerHTML = `
      <strong>LIVE RESET PREVIEW — VNEXT SAFETY COVERAGE</strong><br>
      <small>The established Full Reset core is unchanged. VNext explicitly previews newer operational tables and verifies the reset atomically before success is returned.</small><br><br>

      <strong>Preserved</strong><br>
      Owner accounts preserved: <strong>${Number(row.owner_accounts || 0).toLocaleString()}</strong><br>
      Rack/location master, System Control configuration, System Manager/Cron, database schema/functions/views/RLS/indexes: <strong>PRESERVED</strong><br><br>

      <strong>Core WMS data removed</strong><br>
      Non-Owner Auth users: <strong>${Number(row.non_owner_auth_users || 0).toLocaleString()}</strong><br>
      Non-Owner profiles: <strong>${Number(row.non_owner_profiles || 0).toLocaleString()}</strong><br>
      SKU records: <strong>${Number(row.sku_records || 0).toLocaleString()}</strong><br>
      Stock lots: <strong>${Number(row.stock_lots || 0).toLocaleString()}</strong><br>
      Shipper boxes: <strong>${Number(row.shipper_boxes || 0).toLocaleString()}</strong><br>
      Transactions: <strong>${Number(row.transactions || 0).toLocaleString()}</strong><br>
      Transaction lines: <strong>${Number(row.transaction_lines || 0).toLocaleString()}</strong><br>
      System audit events: <strong>${Number(row.audit_events || 0).toLocaleString()}</strong><br>
      Non-FEFO detail rows: <strong>${Number(row.non_fefo_events || 0).toLocaleString()}</strong><br>
      Sales Orders: <strong>${Number(row.sales_orders || 0).toLocaleString()}</strong><br>
      Location locks: <strong>${Number(row.location_locks_total || 0).toLocaleString()}</strong> total (${Number(row.active_location_locks || 0).toLocaleString()} active)<br>
      Hidden/removed container records: <strong>${Number(row.hidden_containers || 0).toLocaleString()}</strong><br>
      Inventory lot holds: <strong>${Number(row.inventory_lot_holds || 0).toLocaleString()}</strong><br><br>

      <strong>Current-generation dependent/control rows removed</strong><br>
      Current Detailed-Lot remark overrides: <strong>${Number(row.inventory_lot_remark_overrides || 0).toLocaleString()}</strong><br>
      Saved Pick corrections: <strong>${Number(row.saved_pick_corrections || 0).toLocaleString()}</strong><br>
      Saved Pick emergency-finish approvals: <strong>${Number(row.saved_pick_finish_approvals || 0).toLocaleString()}</strong><br>
      V4 per-line remarks: <strong>${Number(row.transaction_line_user_remarks || 0).toLocaleString()}</strong><br>
      V4 Transfer ALL transaction remarks: <strong>${Number(row.transaction_user_remarks || 0).toLocaleString()}</strong><br>
      V4 historical remark repairs: <strong>${Number(row.transaction_remark_scope_repairs || 0).toLocaleString()}</strong><br>
      Warehouse action approvals: <strong>${Number(row.warehouse_action_approvals || 0).toLocaleString()}</strong><br>
      Shipper batch approvals: <strong>${Number(row.shipper_batch_approvals || 0).toLocaleString()}</strong><br>
      Barcode-bypass execution contexts: <strong>${Number(row.barcode_bypass_execution_contexts || 0).toLocaleString()}</strong><br>
      Barcode-bypass execution lines: <strong>${Number(row.barcode_bypass_execution_lines || 0).toLocaleString()}</strong><br>
      Administrative / Full Reset attempt rows: <strong>${Number(row.control_code_attempts || 0).toLocaleString()}</strong><br><br>

      <strong>VNext atomic safety:</strong> RESET_COMPLETE is returned only after all expected operational tables are verified empty, Owner/rack/system structure is verified preserved, and mode is verified as ADMINISTRATIVE_PAUSE.`;

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

  state.putaway = freshPutawayState();
  state.shipperPutaway = freshShipperPutawayState();
  state.pick = freshOperationState();
  state.transfer = freshOperationState();
  state.pickOrder = { salesOrder: null, status: null, pickCount: 0, openedBy: null, isCurrentOwner: false };
  state.pickOrderLookupSequence = 0;
  resetPickCorrectionReporting();
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
    const { data, error } = await supabase.rpc('owner_full_reset_wms_vnext', {
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
      <strong>VNext post-reset integrity verification: PASSED.</strong><br>
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
  if (name === 'stockcard') {
    rows = state.data.stockCardExport;
    filename = `sku-balance-stock-card-${new Date().toISOString().slice(0, 10)}.csv`;
  }
  if (name === 'skumaster') rows = state.data.skuMaster;
  if (name === 'skuhealth') rows = state.data.skuHealth;
  if (name === 'containers') rows = state.data.containers;
  if (name === 'expiry') rows = state.data.expiry;
  if (name === 'nonfefo') rows = state.data.nonFefo;
  if (name === 'history') rows = state.data.history;
  if (name === 'audit') {
    rows = state.data.auditFiltered;
    filename = `system-audit-filtered-${new Date().toISOString().slice(0, 10)}.csv`;
  }
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
renderStockCard();
init();
