import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { BrowserMultiFormatReader, BrowserCodeReader } from 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';

/*
IFTC WAREHOUSE LOCATOR SYSTEM (JPM)
Receiving / Delivery & Backload Return V1.1
LIVE Frontend Integration
TARGET ONLY:
  GitHub: jemagno1030/warehouse-wms
  Supabase: sqpxgwhhfxojzblitnni
*/

const EXPECTED_LIVE_URL = 'https://sqpxgwhhfxojzblitnni.supabase.co';
const cfg = window.WMS_CONFIG || {};
const configReady =
  cfg.SUPABASE_URL === EXPECTED_LIVE_URL &&
  Boolean(cfg.SUPABASE_ANON_KEY);

const supabase = configReady
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;

const $ = (id) => document.getElementById(id);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const fmtQty = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
const LEGACY_NO_EXPIRY_DATE = '9999-12-31';
const isNoExpiryDate = (value) => value === null || String(value || '').slice(0, 10) === LEGACY_NO_EXPIRY_DATE;
const fmtDate = (value) => isNoExpiryDate(value) ? 'N/A' : value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString() : '—';
const fmtDateTime = (value) => value ? new Date(value).toLocaleString() : '—';

const state = {
  session: null,
  profile: null,
  mode: 'ACTIVE',
  skus: [],
  profiles: [],
  cart: [],
  pendingRows: [],
  reportRows: [],
  selectedReceiptId: null,
  tab: 'ops',
  backloadDuplicate: false,
  modeChannel: null,
  profileChannel: null,
  navObserver: null,
  screenObserver: null,
  restoreTimer: null,
  scanner: { target: null, kind: null, reader: null, controls: null }
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function toast(message, type = '') {
  const root = $('toast-root');
  if (!root) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => node.remove(), 5200);
}

function friendlyError(error) {
  const message = error?.message || error?.details || String(error || 'Unknown error');
  return String(message)
    .replace(/^PGRST\d+:\s*/i, '')
    .replace(/^PostgrestError:\s*/i, '');
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function setBusy(button, busy, busyText = 'Working…') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.rcvOriginalText) button.dataset.rcvOriginalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    if (button.dataset.rcvOriginalText) button.textContent = button.dataset.rcvOriginalText;
    delete button.dataset.rcvOriginalText;
    button.disabled = false;
  }
}

function normalizeLocation(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function isViewer() {
  return String(state.profile?.role || '').toLowerCase() === 'viewer';
}

function isActiveAccount() {
  return Boolean(state.session && state.profile?.is_active);
}

function installStyles() {
  if ($('receiving-v1-style')) return;
  const style = document.createElement('style');
  style.id = 'receiving-v1-style';
  style.textContent = `
    #screen-receiving .rcv-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
    #screen-receiving .rcv-tab-btn.active{font-weight:800;box-shadow:inset 0 0 0 2px currentColor}
    #screen-receiving .rcv-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}
    #screen-receiving .rcv-grid>*{min-width:0}
    #screen-receiving .rcv-grid .card{min-width:0;max-width:100%}
    #screen-receiving .form-grid>* ,#screen-receiving .rcv-line-grid>* ,#screen-receiving .rcv-qty-grid>*{min-width:0}
    #screen-receiving input,#screen-receiving select,#screen-receiving textarea,#screen-receiving .scan-field{min-width:0;max-width:100%}
    #screen-receiving .rcv-line-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
    #screen-receiving .rcv-qty-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    #screen-receiving .rcv-table-actions{display:flex;gap:8px;flex-wrap:wrap}
    #screen-receiving .rcv-status-note{margin-top:8px}
    #screen-receiving .rcv-danger{color:#9f1239;font-weight:700}
    #screen-receiving .rcv-good{color:#166534;font-weight:700}
    #screen-receiving .rcv-pending-lines{min-width:0;max-width:100%;overflow:hidden}
    #screen-receiving .rcv-pending-lines label{display:flex;gap:8px;align-items:flex-start;margin:8px 0;min-width:0;max-width:100%}
    #screen-receiving .rcv-pending-lines label span{min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
    #screen-receiving .rcv-pending-lines input[type="checkbox"]{margin-top:4px;width:auto;flex:0 0 auto}
    #screen-receiving .rcv-allocation-row{border:1px solid #d7dee7;border-radius:10px;padding:10px;margin:10px 0;min-width:0}
    #screen-receiving .rcv-allocation-row>label{margin:0 0 8px}
    #screen-receiving .rcv-allocation-progress{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 10px}
    #screen-receiving .rcv-progress-chip{border:1px solid #d7dee7;border-radius:999px;padding:4px 8px;background:#fff;font-size:.8rem}
    #screen-receiving .rcv-allocation-history{display:grid;gap:4px}
    #screen-receiving .rcv-no-expiry{display:flex;align-items:center;gap:7px;margin-top:7px;font-size:.9rem}
    #screen-receiving .rcv-no-expiry input{width:auto;flex:0 0 auto}
    #screen-receiving .rcv-report-summary{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
    #screen-receiving .rcv-summary-chip{border:1px solid #d7dee7;border-radius:999px;padding:5px 10px;background:#fff;font-size:.85rem}
    #screen-receiving .rcv-test-badge{display:inline-block;border-radius:999px;padding:4px 9px;background:#fff3cd;color:#7a4b00;font-weight:800;font-size:.8rem}
    #screen-receiving .rcv-warning{color:#8a4b00;font-weight:700}
    body.receiving-v1-pinned #screen-receiving{display:block!important}
    body.receiving-v1-pinned #app-view .screen:not(#screen-receiving){display:none!important}
    @media(max-width:900px){#screen-receiving .rcv-grid,#screen-receiving .rcv-line-grid{grid-template-columns:1fr}}
    @media(max-width:620px){#screen-receiving .rcv-qty-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function installScannerDialog() {
  if ($('rcv-scanner-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'rcv-scanner-dialog';
  dialog.className = 'scanner-dialog';
  dialog.innerHTML = `
    <div class="scanner-head">
      <div><h3 id="rcv-scanner-title">Scan code</h3><p>Receiving V1.1 scanner.</p></div>
      <button id="rcv-scanner-close" class="icon-button" type="button" aria-label="Close">✕</button>
    </div>
    <video id="rcv-scanner-video" playsinline muted></video>
    <div class="scanner-line"></div>
    <div class="scanner-controls">
      <select id="rcv-camera-select"></select>
      <button id="rcv-camera-start" class="secondary" type="button">Start camera</button>
    </div>
    <form id="rcv-manual-scan-form" class="manual-scan">
      <input id="rcv-manual-scan-input" autocomplete="off" placeholder="Or type / use a USB scanner" />
      <button class="primary" type="submit">Use code</button>
    </form>
    <p id="rcv-scanner-status" class="hint">Camera access requires HTTPS and browser permission.</p>
  `;
  document.body.appendChild(dialog);

  $('rcv-scanner-close').addEventListener('click', closeScanner);
  $('rcv-camera-start').addEventListener('click', () => void startCamera());
  $('rcv-camera-select').addEventListener('change', () => void startCamera());
  $('rcv-manual-scan-form').addEventListener('submit', (event) => {
    event.preventDefault();
    acceptScannedValue($('rcv-manual-scan-input').value);
  });
  dialog.addEventListener('close', stopCamera);
}

function installUi() {
  if ($('screen-receiving')) return;
  installStyles();
  installScannerDialog();

  const putawayNav = document.querySelector('#main-nav [data-screen="putaway"]');
  if (putawayNav && !$('receiving-v1-nav')) {
    const btn = putawayNav.cloneNode(true);
    btn.id = 'receiving-v1-nav';
    btn.dataset.screen = 'receiving-v1-standalone';
    btn.removeAttribute('data-role-min');
    const label = btn.querySelector('span:last-child');
    if (label) label.textContent = 'Receiving'; else btn.textContent = 'Receiving';
    putawayNav.insertAdjacentElement('beforebegin', btn);
  }

  const screen = document.createElement('section');
  screen.id = 'screen-receiving';
  screen.className = 'screen';
  screen.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Receiving / Delivery & Backload Return V1.1</h3>
          <p>Record inbound documents first. Inventory changes only when received lines are put away through the protected existing Put-away engine.</p>
        </div>
      </div>
      <div class="info-box">
        Stock identity remains <strong>SKU + Container No. + Expiry / No Expiry + UOM</strong>. Receiving V1.1 does not add a manufacturer Lot/Batch field.
      </div>
      <div class="rcv-tabs">
        <button type="button" class="secondary rcv-tab-btn active" data-rcv-tab="ops">Receive / Put-away</button>
        <button type="button" class="secondary rcv-tab-btn" data-rcv-tab="report">Receiving Report</button>
      </div>
    </div>

    <div id="rcv-tab-ops">
      <div id="rcv-operational-panel" class="rcv-grid">
        <div class="card">
          <div class="card-head"><div><h3>1. Record received goods</h3><p>Only existing active STANDARD SKUs can be received.</p></div></div>
          <form id="rcv-receipt-form" class="stack">
            <div class="form-grid two">
              <label>Receiving type *
                <select id="rcv-type" required>
                  <option value="REGULAR_DELIVERY">Regular Delivery</option>
                  <option value="BACKLOAD_RETURN">Backload Return</option>
                </select>
              </label>
              <label>Source / Supplier
                <input id="rcv-source" maxlength="200" autocomplete="off" placeholder="Supplier, source, truck, or return origin" />
              </label>
            </div>

            <div class="form-grid two">
              <label>Document type
                <input id="rcv-doc-type" maxlength="100" autocomplete="off" placeholder="e.g. DR, Invoice, Customer DR" />
              </label>
              <label>Document number
                <input id="rcv-doc-number" maxlength="200" autocomplete="off" placeholder="Document reference" />
              </label>
            </div>

            <div id="rcv-backload-fields" class="form-grid two hidden">
              <label>Intended customer name *
                <input id="rcv-customer" maxlength="200" autocomplete="off" />
              </label>
              <label>Return reason *
                <textarea id="rcv-return-reason" maxlength="1000" rows="2"></textarea>
              </label>
            </div>

            <div id="rcv-duplicate-note" class="small-note rcv-status-note"></div>

            <label>Receiving remarks
              <textarea id="rcv-remarks" maxlength="2000" rows="2" placeholder="Optional receiving-level remarks"></textarea>
            </label>

            <div class="card" style="margin:0">
              <div class="card-head"><div><h4>Add SKU line</h4><p>Search item details or scan/type a registered CASE / PACK / PIECE barcode.</p></div></div>
              <div class="form-grid two">
                <label>SKU search / barcode
                  <div class="scan-field">
                    <input id="rcv-sku-search" autocomplete="off" placeholder="Search SKU or scan barcode" />
                    <button type="button" class="secondary" data-rcv-scan-target="rcv-sku-search" data-rcv-scan-kind="barcode">Scan</button>
                  </div>
                </label>
                <label>Matching active STANDARD SKU *
                  <select id="rcv-sku-select"><option value="">Load Receiving to view SKU master</option></select>
                </label>
              </div>

              <div id="rcv-sku-detail" class="small-note">Select an existing SKU.</div>

              <div class="rcv-line-grid">
                <label>Container No. *<input id="rcv-container" maxlength="200" autocomplete="off" /></label>
                <div>
                  <label>Expiry date *<input id="rcv-expiry" type="date" /></label>
                  <label class="rcv-no-expiry"><input id="rcv-no-expiry" type="checkbox" /> No expiry (N/A)</label>
                </div>
              </div>

              <div class="rcv-qty-grid">
                <label>CASE qty<input id="rcv-case-qty" type="number" min="0" step="1" inputmode="numeric" value="0" /></label>
                <label>PACK qty<input id="rcv-pack-qty" type="number" min="0" step="1" inputmode="numeric" value="0" /></label>
                <label>PIECE qty<input id="rcv-piece-qty" type="number" min="0" step="1" inputmode="numeric" value="0" /></label>
              </div>

              <label>Line remark<input id="rcv-line-remark" maxlength="1000" autocomplete="off" /></label>

              <div class="button-cluster">
                <button id="rcv-add-line-btn" type="button" class="secondary">Add line</button>
                <button id="rcv-clear-line-btn" type="button" class="ghost">Clear line</button>
              </div>
            </div>

            <div>
              <h4>Received lines</h4>
              <div id="rcv-cart"></div>
            </div>

            <div class="button-cluster">
              <button id="rcv-save-receipt-btn" type="submit">Save Receipt</button>
              <button id="rcv-reset-receipt-btn" type="button" class="ghost">Reset Receipt</button>
            </div>
          </form>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>2. Put away received quantities</h3><p>Allocate some or all remaining CASE / PACK / PIECE quantities to one destination rack. Each allocation invokes the existing protected Put-away engine atomically.</p></div></div>
          <form id="rcv-putaway-form" class="stack">
            <label>Pending receipt
              <select id="rcv-pending-receipt"><option value="">No pending receipts</option></select>
            </label>
            <div id="rcv-pending-meta" class="small-note"></div>
            <div id="rcv-pending-lines" class="rcv-pending-lines"></div>
            <div class="rcv-table-actions">
              <button id="rcv-select-all-lines" type="button" class="secondary">Select all pending</button>
              <button id="rcv-clear-line-selection" type="button" class="ghost">Clear selection</button>
            </div>
            <label>Destination rack *
              <div class="scan-field">
                <input id="rcv-destination-rack" autocomplete="off" placeholder="Scan or enter rack" />
                <button type="button" class="secondary" data-rcv-scan-target="rcv-destination-rack" data-rcv-scan-kind="location">Scan</button>
              </div>
            </label>
            <button id="rcv-putaway-btn" type="submit">Put-away allocated quantities</button>
          </form>
        </div>
      </div>

      <div id="rcv-viewer-note" class="card hidden">
        <div class="info-box">Viewer access does not include Receiving.</div>
      </div>
    </div>

    <div id="rcv-tab-report" class="hidden">
      <div class="card">
        <div class="card-head">
          <div><h3>Receiving Report</h3><p>Filter Regular Delivery / Backload records, received SKU lines, and Put-away destinations.</p></div>
          <div class="button-cluster">
            <button id="rcv-report-refresh" type="button" class="secondary">Apply filters</button>
            <button id="rcv-report-reset" type="button" class="ghost">Reset filters</button>
            <button id="rcv-report-export" type="button" class="secondary">Export filtered CSV</button>
            <button id="rcv-report-print" type="button" class="secondary">Print Report</button>
          </div>
        </div>

        <div class="form-grid three">
          <label>Type
            <select id="rcv-report-type">
              <option value="">All</option>
              <option value="REGULAR_DELIVERY">Regular Delivery</option>
              <option value="BACKLOAD_RETURN">Backload Return</option>
            </select>
          </label>
          <label>Receipt status
            <select id="rcv-report-status">
              <option value="">All</option>
              <option value="RECEIVED">Received</option>
              <option value="PUTAWAY_PARTIAL">Put-away Partial</option>
              <option value="PUTAWAY_COMPLETE">Put-away Complete</option>
            </select>
          </label>
          <label>Put-away status
            <select id="rcv-report-putaway-status">
              <option value="">All</option>
              <option value="NOT_PUTAWAY">Not Put-away</option>
              <option value="PUTAWAY_PARTIAL">Put-away Partial</option>
              <option value="PUTAWAY_COMPLETE">Put-away Complete</option>
            </select>
          </label>
          <label>Document search<input id="rcv-report-document" autocomplete="off" placeholder="Type or number" /></label>
          <label>Customer search<input id="rcv-report-customer" autocomplete="off" /></label>
          <label>SKU / barcode search<input id="rcv-report-sku" autocomplete="off" /></label>
          <label>Container search<input id="rcv-report-container" autocomplete="off" /></label>
          <label>Received date from<input id="rcv-report-received-from" type="date" /></label>
          <label>Received date to<input id="rcv-report-received-to" type="date" /></label>
          <label>Receiving user<select id="rcv-report-user"><option value="">All users</option></select></label>
          <label>Destination rack<input id="rcv-report-rack" autocomplete="off" /></label>
        </div>

        <div id="rcv-report-summary" class="rcv-report-summary"></div>
        <div id="rcv-report-table"></div>
      </div>
    </div>
  `;

  const putawayScreen = $('screen-putaway');
  if (putawayScreen) putawayScreen.insertAdjacentElement('beforebegin', screen);
  else document.querySelector('main')?.appendChild(screen);

  renderCart();
  syncType();
  syncReceivingNoExpiry();
}

function bindEvents() {
  $('receiving-v1-nav')?.addEventListener('click', (event) => {
    event.preventDefault();
    void openReceiving({ restoreScroll: true });
  });

  qsa('#screen-receiving [data-rcv-tab]').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.rcvTab)));
  qsa('#screen-receiving [data-rcv-scan-target]').forEach((btn) => btn.addEventListener('click', () => void openScanner(btn.dataset.rcvScanTarget, btn.dataset.rcvScanKind || 'barcode')));

  $('rcv-type')?.addEventListener('change', () => { syncType(); void checkBackloadDuplicate(false); });
  $('rcv-no-expiry')?.addEventListener('change', syncReceivingNoExpiry);
  $('rcv-doc-type')?.addEventListener('change', () => void checkBackloadDuplicate(false));
  $('rcv-doc-number')?.addEventListener('change', () => void checkBackloadDuplicate(false));
  $('rcv-sku-search')?.addEventListener('input', renderSkuOptions);
  $('rcv-sku-search')?.addEventListener('change', renderSkuOptions);
  $('rcv-sku-select')?.addEventListener('change', () => { renderSkuDetail(); syncRoleMode(); });
  $('rcv-add-line-btn')?.addEventListener('click', addLine);
  $('rcv-clear-line-btn')?.addEventListener('click', clearLineForm);

  $('rcv-cart')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-rcv-remove-line]');
    if (!btn) return;
    state.cart = state.cart.filter((line) => line.local_id !== btn.dataset.rcvRemoveLine);
    renderCart();
  });

  $('rcv-receipt-form')?.addEventListener('submit', submitReceipt);
  $('rcv-reset-receipt-btn')?.addEventListener('click', resetReceiptForm);
  $('rcv-pending-receipt')?.addEventListener('change', renderPendingLines);
  $('rcv-select-all-lines')?.addEventListener('click', () => qsa('#rcv-pending-lines [data-rcv-pending-line]').forEach((node) => { node.checked = true; }));
  $('rcv-clear-line-selection')?.addEventListener('click', () => qsa('#rcv-pending-lines [data-rcv-pending-line]').forEach((node) => { node.checked = false; }));
  $('rcv-putaway-form')?.addEventListener('submit', submitPutaway);
  $('rcv-report-refresh')?.addEventListener('click', () => void loadReport().catch((error) => toast(friendlyError(error), 'error')));
  $('rcv-report-reset')?.addEventListener('click', resetReportFilters);
  $('rcv-report-export')?.addEventListener('click', exportReport);
  $('rcv-report-print')?.addEventListener('click', () => void printReceivingReport());

  // Receiving V1 is additive and the base app does not know it as a native screen.
  // Clear the Receiving-active marker only when the user explicitly navigates to
  // another WMS module. This lets auth/token refreshes restore Receiving without
  // fighting intentional navigation.
  document.addEventListener('click', (event) => {
    const target = event.target.closest('#main-nav [data-screen], [data-jump]');
    if (!target || target.id === 'receiving-v1-nav') return;
    if ($('screen-receiving')?.classList.contains('active')) rememberReceivingScroll();
    markReceivingActive(false);
  }, true);

  // The base app does not know this additive screen. Capture the global Refresh
  // only while Receiving is active, then stop the older handler from refreshing
  // whichever base screen it last knew about.
  $('refresh-btn')?.addEventListener('click', (event) => {
    if (!$('screen-receiving')?.classList.contains('active')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void loadReceiving(true)
      .then(() => toast('Receiving refreshed.', 'success'))
      .catch((error) => toast(friendlyError(error), 'error'));
  }, true);
}

function markReceivingActive(active) {
  try {
    if (active) {
      sessionStorage.setItem('receiving-v1-active', '1');
      document.body?.classList.add('receiving-v1-pinned');
    } else {
      sessionStorage.removeItem('receiving-v1-active');
      document.body?.classList.remove('receiving-v1-pinned');
    }
  } catch (_) {}
}

function clearReceivingPersistence() {
  try {
    sessionStorage.removeItem('receiving-v1-active');
    sessionStorage.removeItem('receiving-v1-scroll-y');
    document.body?.classList.remove('receiving-v1-pinned');
  } catch (_) {}
}

function rememberReceivingScroll() {
  try {
    if ($('screen-receiving')?.classList.contains('active')) {
      sessionStorage.setItem('receiving-v1-scroll-y', String(Math.max(0, Math.round(window.scrollY || 0))));
    }
  } catch (_) {}
}

function savedReceivingScroll() {
  try {
    const value = Number(sessionStorage.getItem('receiving-v1-scroll-y') || 0);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch (_) {
    return 0;
  }
}

function receivingShouldStayActive() {
  try {
    return sessionStorage.getItem('receiving-v1-active') === '1'
      && Boolean(state.session)
      && Boolean(state.profile?.is_active)
      && !isViewer();
  } catch (_) {
    return false;
  }
}

function activateReceivingScreen({ restoreScroll = false } = {}) {
  const targetScroll = restoreScroll ? savedReceivingScroll() : 0;
  markReceivingActive(true);
  qsa('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === 'screen-receiving'));
  qsa('#main-nav [data-screen]').forEach((button) => button.classList.toggle('active', button.id === 'receiving-v1-nav'));
  if ($('screen-title')) $('screen-title').textContent = 'Receiving';
  if ($('screen-subtitle')) $('screen-subtitle').textContent = 'Regular Delivery and Backload Return with split-quantity controlled Put-away';
  $('sidebar')?.classList.remove('open');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => window.scrollTo({ top: targetScroll, behavior: 'auto' }));
  });
}

function scheduleReceivingRestore(delay = 40) {
  if (!receivingShouldStayActive()) return;
  clearTimeout(state.restoreTimer);
  state.restoreTimer = setTimeout(() => {
    if (!receivingShouldStayActive()) return;
    if (!$('screen-receiving')?.classList.contains('active')) activateReceivingScreen({ restoreScroll: true });
  }, delay);
}

function observeReceivingScreenState() {
  const screen = $('screen-receiving');
  if (!screen || state.screenObserver) return;
  state.screenObserver = new MutationObserver(() => {
    if (receivingShouldStayActive() && !screen.classList.contains('active')) {
      scheduleReceivingRestore(40);
    }
  });
  state.screenObserver.observe(screen, { attributes: true, attributeFilter: ['class'] });

  // Remember Receiving's vertical position while it is the active module.
  let scrollSaveQueued = false;
  window.addEventListener('scroll', () => {
    if (!$('screen-receiving')?.classList.contains('active') || scrollSaveQueued) return;
    scrollSaveQueued = true;
    requestAnimationFrame(() => {
      scrollSaveQueued = false;
      rememberReceivingScroll();
    });
  }, { passive: true });
  window.addEventListener('blur', rememberReceivingScroll);

  // Backup for browsers that refresh auth/session state when a tab/window returns.
  window.addEventListener('focus', () => scheduleReceivingRestore(80));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) rememberReceivingScroll();
    else scheduleReceivingRestore(80);
  });
}

function syncNavVisibility() {
  const nav = $('receiving-v1-nav');
  if (!nav) return;
  nav.classList.toggle('hidden', !isActiveAccount() || isViewer());
}

function observeNavVisibility() {
  const nav = $('receiving-v1-nav');
  if (!nav || state.navObserver) return;
  state.navObserver = new MutationObserver(() => {
    queueMicrotask(syncNavVisibility);
  });
  state.navObserver.observe(nav, { attributes: true, attributeFilter: ['class'] });
}

async function refreshAccess() {
  if (!supabase) return;
  const { data: { session } } = await supabase.auth.getSession();
  state.session = session;

  if (!session) {
    state.profile = null;
    syncRoleMode();
    syncNavVisibility();
    return;
  }

  const [profileRes, modeRes] = await Promise.all([
    supabase.from('profiles').select('id,username,role,is_active').eq('id', session.user.id).single(),
    supabase.from('app_settings').select('operational_mode').eq('id', 1).single()
  ]);

  if (profileRes.error) throw profileRes.error;
  if (modeRes.error) throw modeRes.error;
  state.profile = profileRes.data;
  state.mode = modeRes.data?.operational_mode || 'ACTIVE';
  syncRoleMode();
  syncNavVisibility();
}

function syncRoleMode() {
  const viewer = isViewer();

  if (viewer) {
    clearReceivingPersistence();
    if ($('screen-receiving')?.classList.contains('active')) {
      document.querySelector('#main-nav [data-screen="dashboard"]')?.click();
    }
  }

  const writable = isActiveAccount() && !viewer && state.mode === 'ACTIVE';
  if ($('rcv-add-line-btn')) $('rcv-add-line-btn').disabled = !writable;
  if ($('rcv-save-receipt-btn')) $('rcv-save-receipt-btn').disabled = !writable || !state.cart.length || Boolean($('rcv-sku-select')?.value);
  if ($('rcv-putaway-btn')) $('rcv-putaway-btn').disabled = !writable;
}

function setTab(tab) {
  const target = (tab === 'report' || (isViewer() && tab === 'ops')) ? 'report' : 'ops';
  state.tab = target;
  qsa('#screen-receiving [data-rcv-tab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.rcvTab === target));
  $('rcv-tab-ops')?.classList.toggle('hidden', target !== 'ops');
  $('rcv-tab-report')?.classList.toggle('hidden', target !== 'report');
  if (target === 'report' && state.session) void loadReport().catch((error) => toast(friendlyError(error), 'error'));
}

function syncType() {
  const backload = $('rcv-type')?.value === 'BACKLOAD_RETURN';
  $('rcv-backload-fields')?.classList.toggle('hidden', !backload);
  if ($('rcv-customer')) $('rcv-customer').required = backload;
  if ($('rcv-return-reason')) $('rcv-return-reason').required = backload;
  if ($('rcv-doc-type')) $('rcv-doc-type').required = backload;
  if ($('rcv-doc-number')) $('rcv-doc-number').required = backload;
  state.backloadDuplicate = false;

  if ($('rcv-duplicate-note')) {
    $('rcv-duplicate-note').textContent = backload
      ? 'Backload requires returned document type/number, intended customer, and return reason.'
      : 'Document fields are optional for Regular Delivery.';
  }
}

function skuLabel(sku) {
  const name = [sku.brand, sku.description, sku.variant, sku.size].filter(Boolean).join(' ');
  return `${name} · CASE ${sku.case_barcode || 'N/A'} · PACK ${sku.pack_barcode || 'N/A'} · PIECE ${sku.piece_barcode || 'N/A'}`;
}

function renderSkuOptions() {
  const select = $('rcv-sku-select');
  if (!select) return;
  const term = String($('rcv-sku-search')?.value || '').trim().toLowerCase();
  const previous = select.value;
  let rows = state.skus || [];

  if (term) {
    rows = rows.filter((sku) => [
      sku.brand, sku.description, sku.variant, sku.size,
      sku.case_barcode, sku.pack_barcode, sku.piece_barcode
    ].filter(Boolean).join(' ').toLowerCase().includes(term));
  }

  rows = rows.slice(0, 250);
  select.innerHTML = `<option value="">${rows.length ? 'Select matching SKU' : 'No matching active STANDARD SKU'}</option>` +
    rows.map((sku) => `<option value="${escapeHtml(sku.id)}">${escapeHtml(skuLabel(sku))}</option>`).join('');

  if (rows.some((sku) => sku.id === previous)) select.value = previous;
  if (term) {
    const exact = rows.find((sku) => [sku.case_barcode, sku.pack_barcode, sku.piece_barcode]
      .some((barcode) => String(barcode || '').trim().toLowerCase() === term));
    if (exact) select.value = exact.id;
  }
  renderSkuDetail();
}

function renderSkuDetail() {
  const sku = state.skus.find((row) => row.id === $('rcv-sku-select')?.value);
  const node = $('rcv-sku-detail');
  if (!node) return;

  node.innerHTML = sku
    ? `<strong>${escapeHtml([sku.brand, sku.description, sku.variant, sku.size].filter(Boolean).join(' '))}</strong><br>CASE: ${escapeHtml(sku.case_barcode || 'N/A')} · PACK: ${escapeHtml(sku.pack_barcode || 'N/A')} · PIECE: ${escapeHtml(sku.piece_barcode || 'N/A')}`
    : 'Select an existing active STANDARD SKU.';
  syncRoleMode();
}

function syncReceivingNoExpiry() {
  const noExpiry = Boolean($('rcv-no-expiry')?.checked);
  const input = $('rcv-expiry');
  if (!input) return;
  if (noExpiry) input.value = '';
  input.disabled = noExpiry;
  // Do not use native form-required validation here. This field belongs to
  // the temporary Add SKU Line editor, while Save Receipt submits the whole
  // receipt form after the editor is intentionally cleared. addLine() performs
  // the correct expiry / No expiry validation before a line enters the cart.
  input.required = false;
}

function clearLineForm() {
  if ($('rcv-sku-search')) $('rcv-sku-search').value = '';
  if ($('rcv-sku-select')) $('rcv-sku-select').value = '';
  if ($('rcv-container')) $('rcv-container').value = '';
  if ($('rcv-expiry')) $('rcv-expiry').value = '';
  if ($('rcv-no-expiry')) $('rcv-no-expiry').checked = false;
  syncReceivingNoExpiry();
  if ($('rcv-line-remark')) $('rcv-line-remark').value = '';
  ['rcv-case-qty', 'rcv-pack-qty', 'rcv-piece-qty'].forEach((id) => { if ($(id)) $(id).value = '0'; });
  renderSkuOptions();
}

function addLine() {
  if (isViewer()) return toast('Viewer access is read-only.', 'error');
  if (state.mode !== 'ACTIVE') return toast('Administrative Pause is active. Receiving changes are blocked.', 'error');

  const sku = state.skus.find((row) => row.id === $('rcv-sku-select')?.value);
  if (!sku) return toast('Select an existing active STANDARD SKU.', 'error');

  const container = String($('rcv-container')?.value || '').trim();
  const noExpiry = Boolean($('rcv-no-expiry')?.checked);
  const expiry = noExpiry ? null : ($('rcv-expiry')?.value || null);
  const lineRemark = String($('rcv-line-remark')?.value || '').trim();
  const caseQty = Number($('rcv-case-qty')?.value || 0);
  const packQty = Number($('rcv-pack-qty')?.value || 0);
  const pieceQty = Number($('rcv-piece-qty')?.value || 0);

  if (!container) return toast('Enter Container No.', 'error');
  if (!noExpiry && !expiry) return toast('Enter the expiry date, or select No expiry (N/A).', 'error');
  if (![caseQty, packQty, pieceQty].every((qty) => Number.isInteger(qty) && qty >= 0)) {
    return toast('CASE, PACK, and PIECE quantities must be whole numbers of zero or more.', 'error');
  }
  if (caseQty + packQty + pieceQty <= 0) return toast('Enter at least one received quantity.', 'error');

  const duplicate = state.cart.some((line) =>
    line.sku_id === sku.id &&
    String(line.container_no).trim().toLowerCase() === container.toLowerCase() &&
    line.expiry_date === expiry
  );
  if (duplicate) return toast('Combine repeated SKU + Container No. + Expiry into one Receiving line.', 'error');

  state.cart.push({
    local_id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    sku_id: sku.id,
    sku_label: skuLabel(sku),
    container_no: container,
    expiry_date: expiry,
    case_qty: caseQty,
    pack_qty: packQty,
    piece_qty: pieceQty,
    user_remark: lineRemark || null
  });

  renderCart();
  clearLineForm();
}

function qtyText(line) {
  return [
    Number(line.case_qty) ? `CASE ${fmtQty(line.case_qty)}` : '',
    Number(line.pack_qty) ? `PACK ${fmtQty(line.pack_qty)}` : '',
    Number(line.piece_qty) ? `PIECE ${fmtQty(line.piece_qty)}` : ''
  ].filter(Boolean).join(' · ');
}

function qtyTextByPrefix(line, prefix) {
  return [
    Number(line[`${prefix}case_qty`]) ? `CASE ${fmtQty(line[`${prefix}case_qty`])}` : '',
    Number(line[`${prefix}pack_qty`]) ? `PACK ${fmtQty(line[`${prefix}pack_qty`])}` : '',
    Number(line[`${prefix}piece_qty`]) ? `PIECE ${fmtQty(line[`${prefix}piece_qty`])}` : ''
  ].filter(Boolean).join(' · ') || '0';
}

function allocationHistoryRows(row) {
  return Array.isArray(row?.allocation_history) ? row.allocation_history : [];
}

function allocationHistoryHtml(row) {
  const allocations = allocationHistoryRows(row);
  if (!allocations.length) return '—';
  return `<div class="rcv-allocation-history">${allocations.map((allocation) => {
    const qty = [
      Number(allocation.case_qty) ? `CASE ${fmtQty(allocation.case_qty)}` : '',
      Number(allocation.pack_qty) ? `PACK ${fmtQty(allocation.pack_qty)}` : '',
      Number(allocation.piece_qty) ? `PIECE ${fmtQty(allocation.piece_qty)}` : ''
    ].filter(Boolean).join(' · ');
    return `<div><strong>${escapeHtml(allocation.destination_rack || '—')}</strong> · ${escapeHtml(qty || '0')}<br><small>${escapeHtml(allocation.putaway_transaction_no || '')}${allocation.putaway_by_username ? ` · ${escapeHtml(allocation.putaway_by_username)}` : ''}</small></div>`;
  }).join('')}</div>`;
}

function allocationHistoryCsv(row) {
  return allocationHistoryRows(row).map((allocation) => {
    const qty = [
      Number(allocation.case_qty) ? `CASE ${fmtQty(allocation.case_qty)}` : '',
      Number(allocation.pack_qty) ? `PACK ${fmtQty(allocation.pack_qty)}` : '',
      Number(allocation.piece_qty) ? `PIECE ${fmtQty(allocation.piece_qty)}` : ''
    ].filter(Boolean).join(' · ');
    return [allocation.destination_rack || '', qty, allocation.putaway_transaction_no || '', allocation.putaway_by_username || '']
      .filter(Boolean).join(' | ');
  }).join(' ; ');
}

function renderCart() {
  const node = $('rcv-cart');
  if (!node) return;

  if (!state.cart.length) {
    node.innerHTML = emptyState('No received SKU lines added yet.');
    syncRoleMode();
    return;
  }

  node.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>SKU</th><th>Container</th><th>Expiry</th><th>Quantity</th><th>Remark</th><th></th>
  </tr></thead><tbody>${state.cart.map((line) => `<tr>
    <td>${escapeHtml(line.sku_label)}</td>
    <td>${escapeHtml(line.container_no)}</td>
    <td>${escapeHtml(fmtDate(line.expiry_date))}</td>
    <td>${escapeHtml(qtyText(line))}</td>
    <td>${escapeHtml(line.user_remark || '')}</td>
    <td><button type="button" class="ghost" data-rcv-remove-line="${escapeHtml(line.local_id)}">Remove</button></td>
  </tr>`).join('')}</tbody></table></div>`;
  syncRoleMode();
}

function resetReceiptForm() {
  state.cart = [];
  state.backloadDuplicate = false;
  $('rcv-receipt-form')?.reset();
  if ($('rcv-type')) $('rcv-type').value = 'REGULAR_DELIVERY';
  syncType();
  clearLineForm();
  renderCart();
}

async function checkBackloadDuplicate(showToast = false) {
  if ($('rcv-type')?.value !== 'BACKLOAD_RETURN') {
    state.backloadDuplicate = false;
    return false;
  }

  const docType = String($('rcv-doc-type')?.value || '').trim();
  const docNo = String($('rcv-doc-number')?.value || '').trim();

  if (!docType || !docNo) {
    state.backloadDuplicate = false;
    if ($('rcv-duplicate-note')) $('rcv-duplicate-note').textContent = 'Enter returned document type and number to check duplicates.';
    return false;
  }

  const { data, error } = await supabase.rpc('check_backload_document_duplicate_v1', {
    p_document_type: docType,
    p_document_number: docNo
  });

  if (error) {
    if (showToast) toast(`Duplicate check failed: ${friendlyError(error)}`, 'error');
    return false;
  }

  const duplicate = Boolean(data?.length);
  state.backloadDuplicate = duplicate;
  if ($('rcv-duplicate-note')) {
    $('rcv-duplicate-note').innerHTML = duplicate
      ? `<span class="rcv-danger">Duplicate returned document found: ${escapeHtml(data[0]?.receipt_no || '')} · ${escapeHtml(data[0]?.status || '')}.</span>`
      : '<span class="rcv-good">No duplicate returned document found.</span>';
  }
  return duplicate;
}

async function submitReceipt(event) {
  event.preventDefault();
  await refreshAccess();
  if (isViewer()) return toast('Viewer access is read-only.', 'error');
  if (state.mode !== 'ACTIVE') return toast('Administrative Pause is active. Receiving changes are blocked.', 'error');
  if (!state.cart.length) return toast('Add at least one received SKU line.', 'error');
  if ($('rcv-sku-select')?.value) {
    return toast('Finish adding or clear the currently selected SKU line before saving the receipt.', 'error');
  }

  const type = $('rcv-type').value;
  const docType = $('rcv-doc-type').value.trim();
  const docNo = $('rcv-doc-number').value.trim();
  const customer = $('rcv-customer').value.trim();
  const returnReason = $('rcv-return-reason').value.trim();

  if (type === 'BACKLOAD_RETURN') {
    if (!docType || !docNo || !customer || !returnReason) {
      return toast('Backload requires returned document type/number, intended customer, and return reason.', 'error');
    }
    if (await checkBackloadDuplicate(true)) {
      return toast('This returned document was already received. Duplicate Backload was blocked.', 'error');
    }
  }

  const confirmation = `${type === 'BACKLOAD_RETURN' ? 'BACKLOAD RETURN' : 'REGULAR DELIVERY'}\n${state.cart.length} received SKU line(s)\n${docType || 'No document type'} ${docNo || ''}\n\nSaving this receipt does NOT change inventory. Inventory changes only during Put-away.\n\nContinue?`;
  if (!window.confirm(confirmation)) return;

  const button = event.submitter || $('rcv-save-receipt-btn');
  setBusy(button, true, 'Saving…');

  try {
    const { data, error } = await supabase.rpc('create_inbound_receipt_v1', {
      p_receipt_type: type,
      p_source_name: $('rcv-source').value.trim() || null,
      p_document_type: docType || null,
      p_document_number: docNo || null,
      p_intended_customer_name: customer || null,
      p_return_reason: returnReason || null,
      p_remarks: $('rcv-remarks').value.trim() || null,
      p_lines: state.cart.map((line) => ({
        sku_id: line.sku_id,
        container_no: line.container_no,
        expiry_date: line.expiry_date,
        case_qty: line.case_qty,
        pack_qty: line.pack_qty,
        piece_qty: line.piece_qty,
        user_remark: line.user_remark
      }))
    });

    if (error) return toast(friendlyError(error), 'error');

    const result = data?.[0] || {};
    toast(`Receiving saved: ${result.receipt_no || 'receipt created'} · ${result.line_count || state.cart.length} line(s). Inventory unchanged until Put-away.`, 'success');
    resetReceiptForm();
    await Promise.all([loadPending(), loadReport()]);
  } finally {
    setBusy(button, false);
    syncRoleMode();
  }
}

async function loadMasters(force = false) {
  if (force || !state.skus.length) {
    const { data, error } = await supabase
      .from('skus')
      .select('id,brand,description,variant,size,case_barcode,pack_barcode,piece_barcode,sku_type,is_active')
      .eq('is_active', true)
      .eq('sku_type', 'STANDARD')
      .order('brand')
      .order('description')
      .order('variant')
      .order('size')
      .limit(10000);

    if (error) throw error;
    state.skus = data || [];
    renderSkuOptions();
  }

  if (force || !state.profiles.length) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id,username,is_active')
      .eq('is_active', true)
      .order('username')
      .limit(10000);

    if (error) throw error;
    state.profiles = data || [];

    const select = $('rcv-report-user');
    if (select) {
      const prior = select.value;
      select.innerHTML = '<option value="">All users</option>' +
        state.profiles.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.username || profile.id)}</option>`).join('');
      if (state.profiles.some((profile) => profile.id === prior)) select.value = prior;
    }
  }
}

async function loadPending() {
  const { data, error } = await supabase
    .from('v_inbound_receiving_progress_v1_1')
    .select('*')
    .neq('receipt_status', 'PUTAWAY_COMPLETE')
    .order('received_at', { ascending: false })
    .order('line_no')
    .limit(10000);

  if (error) throw error;
  state.pendingRows = data || [];
  renderPending();
}

function pendingGroups() {
  const groups = new Map();

  for (const row of state.pendingRows || []) {
    if (row.putaway_status === 'PUTAWAY_COMPLETE') continue;

    if (!groups.has(row.receipt_id)) {
      groups.set(row.receipt_id, {
        receipt_id: row.receipt_id,
        receipt_no: row.receipt_no,
        receipt_type: row.receipt_type,
        document_type: row.document_type,
        document_number: row.document_number,
        intended_customer_name: row.intended_customer_name,
        received_at: row.received_at,
        rows: []
      });
    }

    groups.get(row.receipt_id).rows.push(row);
  }

  return [...groups.values()];
}

function renderPending() {
  const select = $('rcv-pending-receipt');
  if (!select) return;

  const groups = pendingGroups();
  const current = state.selectedReceiptId || select.value;

  select.innerHTML = groups.length
    ? '<option value="">Select pending receipt</option>' + groups.map((group) =>
      `<option value="${escapeHtml(group.receipt_id)}">${escapeHtml(group.receipt_no)} · ${escapeHtml(group.receipt_type === 'BACKLOAD_RETURN' ? 'Backload' : 'Regular')} · ${group.rows.length} pending line(s)</option>`
    ).join('')
    : '<option value="">No pending receipts</option>';

  const chosen = groups.some((group) => group.receipt_id === current)
    ? current
    : (groups[0]?.receipt_id || '');

  select.value = chosen;
  state.selectedReceiptId = chosen || null;
  renderPendingLines();
}

function renderPendingLines() {
  const receiptId = $('rcv-pending-receipt')?.value || '';
  state.selectedReceiptId = receiptId || null;
  const group = pendingGroups().find((item) => item.receipt_id === receiptId);

  if (!group) {
    if ($('rcv-pending-meta')) $('rcv-pending-meta').textContent = '';
    if ($('rcv-pending-lines')) $('rcv-pending-lines').innerHTML = emptyState('No pending Receiving quantities.');
    return;
  }

  if ($('rcv-pending-meta')) {
    $('rcv-pending-meta').textContent = [
      group.receipt_no,
      group.receipt_type === 'BACKLOAD_RETURN' ? 'Backload Return' : 'Regular Delivery',
      [group.document_type, group.document_number].filter(Boolean).join(' '),
      group.intended_customer_name
    ].filter(Boolean).join(' · ');
  }

  $('rcv-pending-lines').innerHTML = group.rows.map((row) => {
    const remainingCase = Number(row.remaining_case_qty || 0);
    const remainingPack = Number(row.remaining_pack_qty || 0);
    const remainingPiece = Number(row.remaining_piece_qty || 0);

    return `
      <div class="rcv-allocation-row" data-rcv-allocation-row="${escapeHtml(row.receipt_line_id)}">
        <label>
          <input type="checkbox" data-rcv-pending-line="${escapeHtml(row.receipt_line_id)}" checked />
          <span>
            <strong>${escapeHtml([row.brand, row.description, row.variant, row.size].filter(Boolean).join(' '))}</strong><br>
            ${escapeHtml(row.container_no)} · ${escapeHtml(fmtDate(row.expiry_date))}
          </span>
        </label>
        <div class="rcv-allocation-progress">
          <span class="rcv-progress-chip"><strong>Received:</strong> ${escapeHtml(qtyText(row))}</span>
          <span class="rcv-progress-chip"><strong>Put-away:</strong> ${escapeHtml(qtyTextByPrefix(row, 'putaway_'))}</span>
          <span class="rcv-progress-chip"><strong>Remaining:</strong> ${escapeHtml(qtyTextByPrefix(row, 'remaining_'))}</span>
          <span class="rcv-progress-chip">${Number(row.allocation_count || 0)} allocation(s)</span>
        </div>
        <div class="rcv-qty-grid">
          <label>CASE to rack
            <input type="number" min="0" max="${remainingCase}" step="1" inputmode="numeric"
              data-rcv-allocation-case value="${remainingCase}" ${remainingCase <= 0 ? 'disabled' : ''} />
          </label>
          <label>PACK to rack
            <input type="number" min="0" max="${remainingPack}" step="1" inputmode="numeric"
              data-rcv-allocation-pack value="${remainingPack}" ${remainingPack <= 0 ? 'disabled' : ''} />
          </label>
          <label>PIECE to rack
            <input type="number" min="0" max="${remainingPiece}" step="1" inputmode="numeric"
              data-rcv-allocation-piece value="${remainingPiece}" ${remainingPiece <= 0 ? 'disabled' : ''} />
          </label>
        </div>
      </div>
    `;
  }).join('');
}

async function submitPutaway(event) {
  event.preventDefault();
  await refreshAccess();

  if (isViewer()) return toast('Viewer access does not include Receiving.', 'error');
  if (state.mode !== 'ACTIVE') return toast('Administrative Pause is active. Put-away is blocked.', 'error');

  const receiptId = $('rcv-pending-receipt').value;
  const rack = normalizeLocation($('rcv-destination-rack').value);
  const checked = qsa('#rcv-pending-lines [data-rcv-pending-line]:checked');

  if (!receiptId) return toast('Select a pending receipt.', 'error');
  if (!checked.length) return toast('Select at least one pending Receiving line.', 'error');
  if (!rack) return toast('Scan or enter the destination rack.', 'error');

  const allocations = [];
  let totalCase = 0;
  let totalPack = 0;
  let totalPiece = 0;

  for (const checkbox of checked) {
    const row = checkbox.closest('[data-rcv-allocation-row]');
    if (!row) continue;

    const caseInput = row.querySelector('[data-rcv-allocation-case]');
    const packInput = row.querySelector('[data-rcv-allocation-pack]');
    const pieceInput = row.querySelector('[data-rcv-allocation-piece]');

    const values = {
      case_qty: Number(caseInput?.value || 0),
      pack_qty: Number(packInput?.value || 0),
      piece_qty: Number(pieceInput?.value || 0)
    };

    for (const [name, value] of Object.entries(values)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        return toast(`${name.replace('_qty','').toUpperCase()} allocation must be a whole number zero or greater.`, 'error');
      }
    }

    const maxCase = Number(caseInput?.max || 0);
    const maxPack = Number(packInput?.max || 0);
    const maxPiece = Number(pieceInput?.max || 0);
    if (values.case_qty > maxCase || values.pack_qty > maxPack || values.piece_qty > maxPiece) {
      return toast('One allocation exceeds the remaining received quantity. Refresh Receiving and try again.', 'error');
    }

    if (values.case_qty === 0 && values.pack_qty === 0 && values.piece_qty === 0) {
      return toast('Every selected line must allocate at least one CASE, PACK, or PIECE.', 'error');
    }

    allocations.push({
      receipt_line_id: checkbox.dataset.rcvPendingLine,
      ...values
    });
    totalCase += values.case_qty;
    totalPack += values.pack_qty;
    totalPiece += values.piece_qty;
  }

  if (!allocations.length) return toast('No valid Receiving allocations were selected.', 'error');

  $('rcv-destination-rack').value = rack;
  const group = pendingGroups().find((item) => item.receipt_id === receiptId);
  const allocationText = [
    totalCase ? `CASE ${fmtQty(totalCase)}` : '',
    totalPack ? `PACK ${fmtQty(totalPack)}` : '',
    totalPiece ? `PIECE ${fmtQty(totalPiece)}` : ''
  ].filter(Boolean).join(' · ');

  if (!window.confirm(
    `Put-away ${allocations.length} Receiving line allocation(s) from ${group?.receipt_no || 'this receipt'} to rack ${rack}?\n\n` +
    `${allocationText}\n\nThis WILL update inventory through the protected Put-away engine.`
  )) return;

  const button = event.submitter || $('rcv-putaway-btn');
  setBusy(button, true, 'Putting away…');

  try {
    const { data, error } = await supabase.rpc('putaway_inbound_receipt_v1_1', {
      p_receipt_id: receiptId,
      p_location_code: rack,
      p_allocations: allocations
    });

    if (error) return toast(friendlyError(error), 'error');

    const result = data?.[0] || {};
    const savedQty = [
      Number(result.allocated_case_qty) ? `CASE ${fmtQty(result.allocated_case_qty)}` : '',
      Number(result.allocated_pack_qty) ? `PACK ${fmtQty(result.allocated_pack_qty)}` : '',
      Number(result.allocated_piece_qty) ? `PIECE ${fmtQty(result.allocated_piece_qty)}` : ''
    ].filter(Boolean).join(' · ');

    const message =
      `Receiving Put-away completed: ${result.transaction_no || 'transaction saved'} · ` +
      `${savedQty || 'allocation saved'} · ${result.receipt_status || ''}.`;

    sessionStorage.setItem('receiving-v1-reopen-after-putaway', '1');
    sessionStorage.setItem('receiving-v1-success-message', message);
    window.location.reload();
  } finally {
    setBusy(button, false);
    syncRoleMode();
  }
}

function reportArgs() {
  const receivedFrom = $('rcv-report-received-from')?.value || '';
  const receivedTo = $('rcv-report-received-to')?.value || '';
  if (receivedFrom && receivedTo && receivedFrom > receivedTo) {
    throw new Error('Received date From cannot be later than Received date To.');
  }

  return {
    p_receipt_type: $('rcv-report-type')?.value || null,
    p_document_search: $('rcv-report-document')?.value.trim() || null,
    p_customer_search: $('rcv-report-customer')?.value.trim() || null,
    p_sku_search: $('rcv-report-sku')?.value.trim() || null,
    p_container_search: $('rcv-report-container')?.value.trim() || null,
    p_received_from: $('rcv-report-received-from')?.value || null,
    p_received_to: $('rcv-report-received-to')?.value || null,
    p_status: $('rcv-report-status')?.value || null,
    p_receiving_user: $('rcv-report-user')?.value || null,
    p_putaway_status: $('rcv-report-putaway-status')?.value || null,
    p_destination_rack: $('rcv-report-rack')?.value.trim() || null
  };
}

async function loadReport() {
  if (!state.session || !$('rcv-report-table')) return;

  const { data, error } = await supabase.rpc(
    'get_inbound_receiving_report_v1_2',
    reportArgs()
  );

  if (error) throw error;
  state.reportRows = data || [];
  renderReport();
}

function renderReport() {
  const rows = state.reportRows || [];
  if (!$('rcv-report-summary') || !$('rcv-report-table')) return;

  const receipts = new Set(rows.map((row) => row.receipt_id)).size;
  const backloads = new Set(
    rows.filter((row) => row.receipt_type === 'BACKLOAD_RETURN').map((row) => row.receipt_id)
  ).size;
  const pendingLines = rows.filter((row) => row.putaway_status !== 'PUTAWAY_COMPLETE').length;
  const allocationCount = rows.reduce((sum, row) => sum + Number(row.allocation_count || 0), 0);

  $('rcv-report-summary').innerHTML = `
    <span class="rcv-summary-chip">${receipts} receipt(s)</span>
    <span class="rcv-summary-chip">${rows.length} received line(s)</span>
    <span class="rcv-summary-chip">${allocationCount} Put-away allocation(s)</span>
    <span class="rcv-summary-chip">${backloads} Backload receipt(s)</span>
    <span class="rcv-summary-chip">${pendingLines} line(s) with remaining qty</span>
  `;

  if (!rows.length) {
    $('rcv-report-table').innerHTML = emptyState('No Receiving records match the current filters.');
    return;
  }

  const displayRows = rows.slice(0, 1000);

  $('rcv-report-table').innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>Receipt</th><th>Type / Status</th><th>Received</th><th>User</th><th>Document / Customer</th>
    <th>SKU</th><th>Container / Expiry</th><th>Quantity Progress</th><th>Put-away</th><th>Allocation History</th>
  </tr></thead><tbody>${displayRows.map((row) => `<tr>
    <td><strong>${escapeHtml(row.receipt_no || '')}</strong></td>
    <td>${escapeHtml(row.receipt_type === 'BACKLOAD_RETURN' ? 'Backload Return' : 'Regular Delivery')}<br><small>${escapeHtml(row.receipt_status || '')}</small></td>
    <td>${escapeHtml(fmtDateTime(row.received_at))}</td>
    <td>${escapeHtml(row.received_by_username || '')}</td>
    <td>${escapeHtml([row.document_type, row.document_number].filter(Boolean).join(' '))}${row.intended_customer_name ? `<br><small>${escapeHtml(row.intended_customer_name)}</small>` : ''}</td>
    <td>${escapeHtml([row.brand, row.description, row.variant, row.size].filter(Boolean).join(' '))}</td>
    <td>${escapeHtml(row.container_no || '')}<br><small>${escapeHtml(fmtDate(row.expiry_date))}</small></td>
    <td>
      <strong>Received:</strong> ${escapeHtml(qtyText(row))}<br>
      <strong>Put-away:</strong> ${escapeHtml(qtyTextByPrefix(row, 'putaway_'))}<br>
      <strong>Remaining:</strong> ${escapeHtml(qtyTextByPrefix(row, 'remaining_'))}
    </td>
    <td>${escapeHtml(row.putaway_status || '')}<br><small>${Number(row.allocation_count || 0)} allocation(s)</small></td>
    <td>${allocationHistoryHtml(row)}</td>
  </tr>`).join('')}</tbody></table></div>
  ${rows.length > displayRows.length ? `<div class="small-note">Showing first ${displayRows.length} of ${rows.length} rows. CSV export includes all filtered rows.</div>` : ''}`;
}

function resetReportFilters() {
  ['rcv-report-type', 'rcv-report-status', 'rcv-report-putaway-status', 'rcv-report-user']
    .forEach((id) => { if ($(id)) $(id).value = ''; });

  ['rcv-report-document', 'rcv-report-customer', 'rcv-report-sku', 'rcv-report-container',
   'rcv-report-received-from', 'rcv-report-received-to', 'rcv-report-rack']
    .forEach((id) => { if ($(id)) $(id).value = ''; });

  void loadReport().catch((error) => toast(friendlyError(error), 'error'));
}

function reportPrintFilterItems() {
  const items = [];
  const addSelect = (id, label) => {
    const node = $(id);
    if (!node?.value) return;
    const text = node.selectedOptions?.[0]?.textContent?.trim() || node.value;
    items.push(`${label}: ${text}`);
  };
  const addText = (id, label) => {
    const value = String($(id)?.value || '').trim();
    if (value) items.push(`${label}: ${value}`);
  };

  addSelect('rcv-report-type', 'Type');
  addSelect('rcv-report-status', 'Receipt status');
  addSelect('rcv-report-putaway-status', 'Put-away status');
  addText('rcv-report-document', 'Document');
  addText('rcv-report-customer', 'Customer');
  addText('rcv-report-sku', 'SKU / barcode');
  addText('rcv-report-container', 'Container');

  const receivedFrom = $('rcv-report-received-from')?.value || '';
  const receivedTo = $('rcv-report-received-to')?.value || '';
  if (receivedFrom || receivedTo) {
    items.push(`Received date: ${receivedFrom || 'Any'} to ${receivedTo || 'Any'}`);
  }

  addSelect('rcv-report-user', 'Receiving user');
  addText('rcv-report-rack', 'Destination rack');

  return items;
}

function receivingReportPrintSummary(rows) {
  const receipts = new Set(rows.map((row) => row.receipt_id)).size;
  const backloads = new Set(
    rows.filter((row) => row.receipt_type === 'BACKLOAD_RETURN').map((row) => row.receipt_id)
  ).size;
  const pendingLines = rows.filter((row) => row.putaway_status !== 'PUTAWAY_COMPLETE').length;
  const allocationCount = rows.reduce((sum, row) => sum + Number(row.allocation_count || 0), 0);
  return { receipts, backloads, pendingLines, allocationCount };
}

function allocationHistoryPrintHtml(row) {
  const allocations = allocationHistoryRows(row);
  if (!allocations.length) return '—';
  return allocations.map((allocation) => {
    const qty = [
      Number(allocation.case_qty) ? `CASE ${fmtQty(allocation.case_qty)}` : '',
      Number(allocation.pack_qty) ? `PACK ${fmtQty(allocation.pack_qty)}` : '',
      Number(allocation.piece_qty) ? `PIECE ${fmtQty(allocation.piece_qty)}` : ''
    ].filter(Boolean).join(' · ');
    const details = [allocation.putaway_transaction_no, allocation.putaway_by_username]
      .filter(Boolean).join(' · ');
    return `<div class="allocation"><strong>${escapeHtml(allocation.destination_rack || '—')}</strong> · ${escapeHtml(qty || '0')}${details ? `<br><span>${escapeHtml(details)}</span>` : ''}</div>`;
  }).join('');
}

async function printReceivingReport() {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    toast('Printer-friendly report could not open. Allow pop-ups for this WMS site and try again.', 'error');
    return;
  }

  try {
    printWindow.document.write('<!doctype html><title>Preparing Receiving Report…</title><p style="font-family:Arial,sans-serif">Preparing Receiving Report…</p>');
    printWindow.document.close();

    // Re-run the report first so the printout always reflects the filter fields
    // currently visible to the user, even if Apply filters was not clicked.
    await loadReport();

    const rows = state.reportRows || [];
    if (!rows.length) {
      printWindow.close();
      toast('There is no Receiving data to print for the current filters.', 'error');
      return;
    }

    const filters = reportPrintFilterItems();
    const summary = receivingReportPrintSummary(rows);
    const generatedAt = new Date().toLocaleString();
    const filterHtml = filters.length
      ? filters.map((item) => `<span class="filter-chip">${escapeHtml(item)}</span>`).join('')
      : '<span class="filter-chip">No filters — all Receiving records</span>';

    const bodyRows = rows.map((row) => {
      const documentText = [row.document_type, row.document_number].filter(Boolean).join(' ');
      const customerText = row.intended_customer_name || '';
      const sourceText = row.source_name || '';
      const receiptMeta = [sourceText, documentText, customerText].filter(Boolean).join(' · ');
      const skuText = [row.brand, row.description, row.variant, row.size].filter(Boolean).join(' ');
      const remark = row.user_remark || '';
      return `<tr>
        <td><strong>${escapeHtml(row.receipt_no || '')}</strong><br><span>${escapeHtml(row.receipt_type === 'BACKLOAD_RETURN' ? 'Backload Return' : 'Regular Delivery')}</span><br><span>${escapeHtml(row.receipt_status || '')}</span></td>
        <td>${escapeHtml(fmtDateTime(row.received_at))}<br><span>${escapeHtml(row.received_by_username || '')}</span></td>
        <td>${escapeHtml(receiptMeta || '—')}${row.return_reason ? `<br><span>Return: ${escapeHtml(row.return_reason)}</span>` : ''}</td>
        <td><strong>${escapeHtml(skuText || '—')}</strong></td>
        <td>${escapeHtml(row.container_no || '—')}<br><span>Expiry: ${escapeHtml(fmtDate(row.expiry_date))}</span></td>
        <td>${escapeHtml(qtyText(row) || '0')}</td>
        <td>${escapeHtml(qtyTextByPrefix(row, 'putaway_'))}</td>
        <td>${escapeHtml(qtyTextByPrefix(row, 'remaining_'))}</td>
        <td>${escapeHtml(row.putaway_status || '')}<br><span>${Number(row.allocation_count || 0)} allocation(s)</span></td>
        <td>${allocationHistoryPrintHtml(row)}</td>
        <td>${escapeHtml(remark || '—')}</td>
      </tr>`;
    }).join('');

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Receiving Report</title>
<style>
  @page { size: Letter landscape; margin: 9mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #111; font-family: Arial, Helvetica, sans-serif; font-size: 8px; line-height: 1.25; }
  h1 { margin: 0 0 2px; font-size: 16px; }
  .subtitle { margin: 0 0 7px; font-size: 9px; }
  .meta { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 6px; font-size: 8px; }
  .summary { display: flex; gap: 6px; flex-wrap: wrap; margin: 5px 0 6px; }
  .summary span, .filter-chip { border: 1px solid #777; border-radius: 3px; padding: 2px 5px; }
  .filters { display: flex; gap: 4px; flex-wrap: wrap; margin: 5px 0 8px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  th, td { border: 1px solid #777; padding: 3px 4px; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
  th { background: #eee; font-size: 7.5px; text-align: left; }
  td span, .allocation span { font-size: 7px; color: #333; }
  .allocation { margin-bottom: 3px; }
  .allocation:last-child { margin-bottom: 0; }
  .footer-note { margin-top: 6px; font-size: 7px; }
  th:nth-child(1), td:nth-child(1) { width: 9%; }
  th:nth-child(2), td:nth-child(2) { width: 8%; }
  th:nth-child(3), td:nth-child(3) { width: 12%; }
  th:nth-child(4), td:nth-child(4) { width: 12%; }
  th:nth-child(5), td:nth-child(5) { width: 8%; }
  th:nth-child(6), td:nth-child(6) { width: 8%; }
  th:nth-child(7), td:nth-child(7) { width: 8%; }
  th:nth-child(8), td:nth-child(8) { width: 8%; }
  th:nth-child(9), td:nth-child(9) { width: 8%; }
  th:nth-child(10), td:nth-child(10) { width: 11%; }
  th:nth-child(11), td:nth-child(11) { width: 8%; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <h1>IFTC Warehouse Locator System (JPM) — Receiving Report</h1>
  <div class="meta"><span>Generated: ${escapeHtml(generatedAt)}</span><span>Printed rows: ${rows.length}</span></div>
  <div class="summary">
    <span>${summary.receipts} receipt(s)</span>
    <span>${rows.length} received line(s)</span>
    <span>${summary.allocationCount} Put-away allocation(s)</span>
    <span>${summary.backloads} Backload receipt(s)</span>
    <span>${summary.pendingLines} line(s) with remaining qty</span>
  </div>
  <div class="filters">${filterHtml}</div>
  <table>
    <thead><tr>
      <th>Receipt / Type / Status</th>
      <th>Received / User</th>
      <th>Source / Document / Customer</th>
      <th>SKU</th>
      <th>Container / Expiry</th>
      <th>Received Qty</th>
      <th>Put-away Qty</th>
      <th>Remaining Qty</th>
      <th>Put-away Status</th>
      <th>Allocation History</th>
      <th>Line Remark</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <div class="footer-note">Printer-friendly Receiving Report · All rows matching the current report filters are included.</div>
<script>
  window.addEventListener('load', function () {
    setTimeout(function () { window.print(); }, 150);
  });
<\/script>
</body>
</html>`;

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
  } catch (error) {
    try { printWindow.close(); } catch (_) {}
    toast(`Receiving report print failed: ${friendlyError(error)}`, 'error');
  }
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportReport() {
  const rows = state.reportRows || [];
  if (!rows.length) return toast('There is no filtered Receiving data to export.', 'error');

  const columns = [
    ['Receipt No', (row) => row.receipt_no || ''],
    ['Receiving Type', (row) => row.receipt_type || ''],
    ['Receipt Status', (row) => row.receipt_status || ''],
    ['Received At', (row) => row.received_at || ''],
    ['Receiving User', (row) => row.received_by_username || ''],
    ['Source / Supplier', (row) => row.source_name || ''],
    ['Document Type', (row) => row.document_type || ''],
    ['Document Number', (row) => row.document_number || ''],
    ['Intended Customer', (row) => row.intended_customer_name || ''],
    ['Return Reason', (row) => row.return_reason || ''],
    ['SKU', (row) => [row.brand, row.description, row.variant, row.size].filter(Boolean).join(' ')],
    ['CASE Barcode', (row) => row.case_barcode || ''],
    ['PACK Barcode', (row) => row.pack_barcode || ''],
    ['PIECE Barcode', (row) => row.piece_barcode || ''],
    ['Container No', (row) => row.container_no || ''],
    ['Expiry', (row) => isNoExpiryDate(row.expiry_date) ? 'N/A' : (row.expiry_date || '')],
    ['Received CASE', (row) => row.case_qty || 0],
    ['Received PACK', (row) => row.pack_qty || 0],
    ['Received PIECE', (row) => row.piece_qty || 0],
    ['Put-away CASE', (row) => row.putaway_case_qty || 0],
    ['Put-away PACK', (row) => row.putaway_pack_qty || 0],
    ['Put-away PIECE', (row) => row.putaway_piece_qty || 0],
    ['Remaining CASE', (row) => row.remaining_case_qty || 0],
    ['Remaining PACK', (row) => row.remaining_pack_qty || 0],
    ['Remaining PIECE', (row) => row.remaining_piece_qty || 0],
    ['Allocation Count', (row) => row.allocation_count || 0],
    ['Line Remark', (row) => row.user_remark || ''],
    ['Put-away Status', (row) => row.putaway_status || ''],
    ['Allocation History', (row) => allocationHistoryCsv(row)]
  ];

  const csv = [
    columns.map(([label]) => csvCell(label)).join(','),
    ...rows.map((row) => columns.map(([, value]) => csvCell(value(row))).join(','))
  ].join('\n');

  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `receiving-v1-1-filtered-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadReceiving(force = false) {
  await refreshAccess();
  if (!state.session) throw new Error('Sign in first.');
  if (!state.profile?.is_active) throw new Error('This account is inactive.');
  if (isViewer()) throw new Error('Viewer access does not include Receiving.');

  syncType();
  await loadMasters(force);
  await Promise.all([loadPending(), loadReport()]);
  syncRoleMode();
}

async function openReceiving({ restoreScroll = false } = {}) {
  try {
    await refreshAccess();
    if (!state.session) return toast('Sign in first.', 'error');
    if (!state.profile?.is_active) return toast('This account is inactive.', 'error');
    if (isViewer()) {
      clearReceivingPersistence();
      return toast('Viewer access does not include Receiving.', 'error');
    }

    activateReceivingScreen({ restoreScroll });
    await loadReceiving(false);
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

async function listCameras() {
  try {
    const devices = await BrowserCodeReader.listVideoInputDevices();
    $('rcv-camera-select').innerHTML = devices.map((device, index) =>
      `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `Camera ${index + 1}`)}</option>`
    ).join('');
    const rearIndex = devices.findIndex((device) => /back|rear|environment/i.test(device.label));
    if (rearIndex >= 0) $('rcv-camera-select').selectedIndex = rearIndex;
  } catch (error) {
    $('rcv-scanner-status').textContent = `Camera list unavailable: ${friendlyError(error)}`;
  }
}

async function openScanner(targetId, kind) {
  state.scanner.target = targetId;
  state.scanner.kind = kind;
  $('rcv-scanner-title').textContent = kind === 'location' ? 'Scan rack QR' : 'Scan barcode';
  $('rcv-manual-scan-input').value = '';
  $('rcv-scanner-status').textContent = 'Choose a camera or use the manual / USB scanner field.';
  $('rcv-scanner-dialog').showModal();
  await listCameras();
  await startCamera();
}

async function startCamera() {
  stopCamera();

  try {
    state.scanner.reader = new BrowserMultiFormatReader();
    const deviceId = $('rcv-camera-select').value || undefined;
    $('rcv-scanner-status').textContent = 'Scanning…';

    state.scanner.controls = await state.scanner.reader.decodeFromVideoDevice(
      deviceId,
      $('rcv-scanner-video'),
      (result, error) => {
        if (result) acceptScannedValue(result.getText());
        else if (error && error.name !== 'NotFoundException') {
          $('rcv-scanner-status').textContent = friendlyError(error);
        }
      }
    );
  } catch (error) {
    $('rcv-scanner-status').textContent =
      `Camera could not start: ${friendlyError(error)}. Use HTTPS and allow camera permission, or type the code below.`;
  }
}

function stopCamera() {
  try { state.scanner.controls?.stop(); } catch (_) {}
  state.scanner.controls = null;

  const stream = $('rcv-scanner-video')?.srcObject;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if ($('rcv-scanner-video')) $('rcv-scanner-video').srcObject = null;
}

function closeScanner() {
  stopCamera();
  if ($('rcv-scanner-dialog')?.open) $('rcv-scanner-dialog').close();
}

function acceptScannedValue(rawValue) {
  const value = state.scanner.kind === 'location'
    ? normalizeLocation(rawValue)
    : String(rawValue || '').trim();

  if (!value) return;
  const target = $(state.scanner.target);
  if (!target) return;

  target.value = value;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  closeScanner();
  toast(`Scanned: ${value}`, 'success');
}

function subscribeModeAndProfile() {
  if (!state.session?.user?.id) return;

  if (state.modeChannel) supabase.removeChannel(state.modeChannel);
  if (state.profileChannel) supabase.removeChannel(state.profileChannel);

  state.modeChannel = supabase
    .channel('receiving-v1-mode')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'app_settings', filter: 'id=eq.1' },
      (payload) => {
        state.mode = payload.new?.operational_mode || state.mode;
        syncRoleMode();
      }
    )
    .subscribe();

  state.profileChannel = supabase
    .channel('receiving-v1-profile')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${state.session.user.id}` },
      () => {
        void refreshAccess().catch(() => {});
      }
    )
    .subscribe();
}

async function handleAuth(session) {
  state.session = session;
  if (!session) {
    clearReceivingPersistence();
    state.profile = null;
    state.cart = [];
    state.pendingRows = [];
    state.reportRows = [];
    syncRoleMode();
    syncNavVisibility();
    return;
  }

  try {
    await refreshAccess();
    subscribeModeAndProfile();
    scheduleReceivingRestore(120);
  } catch (_) {}
}

async function boot() {
  if (!configReady) {
    console.error('Receiving V1.1 refused to load: LIVE Supabase identity mismatch.');
    return;
  }

  installUi();
  bindEvents();
  observeNavVisibility();
  observeReceivingScreenState();

  // If Receiving was already the intended active module, pin it visually
  // before auth/session refreshes can flash the base app's last native screen.
  try {
    if (sessionStorage.getItem('receiving-v1-active') === '1') {
      document.body?.classList.add('receiving-v1-pinned');
    }
  } catch (_) {}

  const { data: { session } } = await supabase.auth.getSession();
  await handleAuth(session);

  supabase.auth.onAuthStateChange((_event, nextSession) => {
    setTimeout(() => { void handleAuth(nextSession); }, 0);
  });

  syncNavVisibility();

  // If Receiving was the active screen before a normal page reload or a browser
  // auth/session refresh, restore it just like a native WMS module.
  if (receivingShouldStayActive()) {
    setTimeout(() => { void openReceiving({ restoreScroll: true }); }, 250);
  }

  const reopen = sessionStorage.getItem('receiving-v1-reopen-after-putaway') === '1';
  if (reopen) {
    sessionStorage.removeItem('receiving-v1-reopen-after-putaway');
    const message = sessionStorage.getItem('receiving-v1-success-message');
    sessionStorage.removeItem('receiving-v1-success-message');

    setTimeout(() => {
      void openReceiving({ restoreScroll: true }).then(() => {
        if (message) toast(message, 'success');
      });
    }, 400);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void boot(); }, { once: true });
} else {
  void boot();
}
