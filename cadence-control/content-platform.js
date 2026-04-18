/* Cadence Control · Platform Content Script · v0.4.0
 *
 * Runs on TopstepX, WealthCharts, ProjectX. Two responsibilities:
 *
 * 1. DISCOVERY MODE (v0.1, active by default while debugMode=true):
 *    Scans the DOM for candidate order buttons (Buy / Sell / Market / Limit / Flatten),
 *    SL/TP input fields, and quantity controls. Logs what it finds to the event log
 *    and flashes a subtle amber outline so Justin can confirm the selectors.
 *
 * 2. ENFORCEMENT MODE (activates when lockout state fires):
 *    - Disables Buy/Sell buttons during lockout
 *    - Blocks market-order submissions during opening-range lockout
 *    - Prevents SL widening (blocks edits that move SL further from entry)
 *    - Rate-limits order submissions (1 market / 2-min window, 2 limit / 2-min window)
 *    - Shows a full-viewport overlay when any block is active
 */

(() => {
  const PLATFORM =
    /topstepx\.com/.test(location.hostname) ? 'topstepx' :
    /wealthcharts\.com/.test(location.hostname) ? 'wealthcharts' :
    /projectx\.com/.test(location.hostname) ? 'projectx' : 'unknown';

  console.log('[Cadence Control]', PLATFORM, 'content script loaded');

  /* ═══ State ═══ */
  let lockout = null;
  let overlayEl = null;
  let discoveryBadgeEl = null;
  let tierOverlayEl = null;
  let orderRateWindow = []; // [{ t, kind: 'market'|'limit' }]
  const ORDER_RATE_WINDOW_MS = 2 * 60 * 1000;
  const MAX_MARKET_PER_WINDOW = 1;
  const MAX_LIMIT_PER_WINDOW = 2;

  /* ═══ Tier enforcement state ═══ */
  let tierData = { ladder: [], state: { currentTier: 0 }, enabled: true };

  /* ═══ Daily lock state ═══ */
  let dailyConfig = null; // { date, limits, lockedAt, unlockedAt, accountId }
  let dailyLockBannerEl = null;

  /* ═══ v0.3.2 · Safe sendMessage wrapper ═══
   * Returns silently if the extension context has been invalidated
   * (common after extension reload while tabs remain open). Prevents
   * "Extension context invalidated" error spam in chrome://extensions errors. */
  function safeSend(msg, cb) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      if (cb) chrome.runtime.sendMessage(msg, cb);
      else chrome.runtime.sendMessage(msg);
    } catch (e) { /* post-reload context dead — ignore */ }
  }

  /* ═══ Boot ═══ */
  safeSend({ type: 'get-lockout' }, res => {
    if (res && res.ok) {
      lockout = res.lockout;
      applyLockoutUi();
    }
  });
  // Fetch daily config at boot
  safeSend({ type: 'get-daily-config' }, res => {
    if (res && res.ok) {
      dailyConfig = res.config;
      if (res.timeInfo.isLocked) showDailyLockBanner();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'lockout-changed') {
      lockout = msg.lockout;
      applyLockoutUi();
      sendResponse({ ok: true });
    }
    if (msg.type === 'daily-lock-changed') {
      dailyConfig = msg.config;
      if (msg.config.lockedAt && !msg.config.unlockedAt) {
        showDailyLockBanner();
      } else {
        removeDailyLockBanner();
      }
      sendResponse({ ok: true });
    }
  });

  /* ═══ Discovery (v0.4.0 — confirmed TopstepX data-testid selectors) ═══ */
  const SELECTOR_PATTERNS = {
    buy: ['button[data-testid="order-card-click-button-buy"]'],
    sell: ['button[data-testid="order-card-click-button-sell"]'],
    joinBid: ['button[data-testid="order-card-click-button-join-bid"]'],
    joinAsk: ['button[data-testid="order-card-click-button-join-ask"]'],
    flattenAll: ['button.flatten-button'],
  };

  function discover() {
    const found = {};
    for (const [kind, patterns] of Object.entries(SELECTOR_PATTERNS)) {
      found[kind] = [];
      for (const selector of patterns) {
        try {
          document.querySelectorAll(selector).forEach(el => {
            found[kind].push(describeEl(el));
          });
        } catch (e) { /* invalid selector — skip */ }
      }
    }
    safeSend({
      type: 'log',
      logType: 'discovery',
      payload: { platform: PLATFORM, url: location.href, found }
    });
    renderDiscoveryBadge(found);
    return found;
  }

  function describeEl(el) {
    const tag = el.tagName;
    const id = el.id || '';
    const cls = (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : '';
    const text = (el.innerText || '').slice(0, 40).trim();
    const rect = el.getBoundingClientRect();
    return { tag, id, cls, text, w: Math.round(rect.width), h: Math.round(rect.height) };
  }

  function renderDiscoveryBadge(found) {
    if (discoveryBadgeEl) discoveryBadgeEl.remove();
    const counts = Object.entries(found).map(([k, v]) => `${k}:${v.length}`).join(' · ');
    discoveryBadgeEl = document.createElement('div');
    discoveryBadgeEl.className = 'cc-discovery-badge';
    discoveryBadgeEl.textContent = `Cadence Control · ${PLATFORM} · ${counts}`;
    document.body.appendChild(discoveryBadgeEl);
  }

  /* ═══ Enforcement ═══ */
  function applyLockoutUi() {
    if (!lockout) return;
    removeOverlay();
    if (lockout.kind === 'none') return;

    if (lockout.blockNewEntries) {
      showOverlay(lockout);
    } else if (lockout.blockMarketOrders) {
      // Opening-range case: subtle top banner rather than full overlay
      showBanner(lockout);
    }

    // Hook submit handlers via capturing click listener on document
    // (content script installs one permanent listener; it checks lockout every click)
  }

  function showOverlay(lo) {
    if (overlayEl) overlayEl.remove();
    overlayEl = document.createElement('div');
    overlayEl.className = 'cc-overlay';
    overlayEl.innerHTML = `
      <div class="cc-overlay-card">
        <div class="cc-overlay-kind">${escapeHtml(lo.kind)}${lo.tier ? ` · T${lo.tier}` : ''}</div>
        <div class="cc-overlay-reason">${escapeHtml(lo.reason || '')}</div>
        <div class="cc-overlay-hint">Exits and SL tightening remain available. New entries are blocked.</div>
      </div>
    `;
    document.body.appendChild(overlayEl);
  }

  function showBanner(lo) {
    if (overlayEl) overlayEl.remove();
    overlayEl = document.createElement('div');
    overlayEl.className = 'cc-banner';
    overlayEl.textContent = `Cadence Control · ${lo.reason || lo.kind}`;
    document.body.appendChild(overlayEl);
  }

  function removeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ═══ Click interception (v0.4.0 — data-testid based) ═══
   * Captures clicks BEFORE the platform's handlers fire. Uses confirmed
   * TopstepX data-testid attributes for reliable detection.
   * Join Bid / Join Ask are treated as market orders for blocking purposes
   * (functionally market orders during fast tape). */
  document.addEventListener('click', (e) => {
    const el = e.target;
    if (!el || !el.closest) return;
    const btn = el.closest('button[data-testid]');
    if (!btn) return;
    const tid = btn.getAttribute('data-testid');

    const isBuy = tid === 'order-card-click-button-buy';
    const isSell = tid === 'order-card-click-button-sell';
    const isJoinBid = tid === 'order-card-click-button-join-bid';
    const isJoinAsk = tid === 'order-card-click-button-join-ask';
    const isEntry = isBuy || isSell || isJoinBid || isJoinAsk;
    const isMarketOrder = isBuy || isSell || isJoinBid || isJoinAsk;
    // BUY/SELL submit at Market; Join Bid/Ask are functionally market during fast tape

    // 1. Lockout-based blocking
    if (lockout && lockout.kind !== 'none') {
      if (lockout.blockNewEntries && isEntry) {
        e.preventDefault(); e.stopImmediatePropagation();
        flashBlockedFeedback(btn, 'New entries blocked · ' + lockout.reason);
        safeSend({ type: 'log', logType: 'block', payload: { reason: 'new-entries', tid } });
        return;
      }
      if (lockout.blockMarketOrders && isMarketOrder) {
        e.preventDefault(); e.stopImmediatePropagation();
        flashBlockedFeedback(btn, 'Market orders blocked · ' + lockout.reason);
        safeSend({ type: 'log', logType: 'block', payload: { reason: 'market-order', tid } });
        return;
      }
    }

    // 2. Contract-size enforcement on entry clicks
    if (isEntry) {
      const qty = getCurrentOrderQty();
      const instrument = getInstrumentFromDropdown();
      if (qty > 0 && instrument) {
        // Synchronous check against local tier/daily data first for instant feedback
        // Also fire async check to background for authoritative enforcement
        safeSend({ type: 'check-order-size', instrument, qty }, res => {
          if (res && res.ok && !res.allowed) {
            // Order already went through — log the violation for review
            safeSend({ type: 'log', logType: 'tier-violation-post', payload: { instrument, qty, reason: res.reason, tid } });
          }
        });

        // Pre-flight local check for instant blocking
        const maxQty = getLocalMaxQty(instrument);
        if (maxQty !== null && qty > maxQty) {
          e.preventDefault(); e.stopImmediatePropagation();
          flashBlockedFeedback(btn, `Max ${maxQty} ${instrument} · order of ${qty} blocked`);
          safeSend({ type: 'log', logType: 'tier-block-click', payload: { instrument, qty, max: maxQty, tid } });
          return;
        }
      }
    }
  }, true); // capture phase — run BEFORE any platform handler

  /** Get max allowed qty for an instrument from local state (daily lock > tier ladder) */
  function getLocalMaxQty(instrument) {
    const inst = (instrument || '').toUpperCase();
    const maxKey = 'max' + inst;

    // Daily locked limits take priority
    if (dailyConfig && dailyConfig.lockedAt && !dailyConfig.unlockedAt && dailyConfig.limits) {
      if (dailyConfig.limits.allowedInstruments && !dailyConfig.limits.allowedInstruments.includes(inst)) return 0;
      return dailyConfig.limits[maxKey] !== undefined ? dailyConfig.limits[maxKey] : null;
    }

    // Fall back to tier ladder
    if (tierData.enabled && tierData.ladder.length > 0) {
      const tier = tierData.ladder[tierData.state.currentTier] || {};
      if (tier.allowedInstruments && !tier.allowedInstruments.includes(inst)) return 0;
      return tier[maxKey] !== undefined ? tier[maxKey] : null;
    }

    return null; // no limit data available
  }

  function flashBlockedFeedback(el, msg) {
    const toast = document.createElement('div');
    toast.className = 'cc-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2400);
    try { el.classList.add('cc-blocked-flash'); setTimeout(() => el.classList.remove('cc-blocked-flash'), 900); } catch (e) {}
  }

  /* ═══ TopstepX DOM readers (v0.4.0) ═══ */

  /** Read "# of Contracts" input value */
  function getCurrentOrderQty() {
    if (PLATFORM !== 'topstepx') return 0;
    // Look for label text "# of Contracts" then find sibling/child input
    const allLabels = document.querySelectorAll('label, span, div, p');
    for (const el of allLabels) {
      const t = (el.textContent || '').trim();
      if (/^#\s*of\s*contracts$/i.test(t)) {
        // Search within parent for the input
        const scope = el.parentElement;
        if (!scope) continue;
        const input = scope.querySelector('input[type="text"], input[type="number"], input');
        if (input && input !== el) return parseInt(input.value) || 0;
        // Try next sibling
        const sib = el.nextElementSibling;
        if (sib) {
          const sibInput = sib.tagName === 'INPUT' ? sib : sib.querySelector('input');
          if (sibInput) return parseInt(sibInput.value) || 0;
        }
      }
    }
    // Fallback: look for quick-size chips container and find the active input nearby
    return 0;
  }

  /** Read instrument from Contract dropdown, strip month/year suffix (e.g. "NQH26" → "NQ") */
  function getInstrumentFromDropdown() {
    if (PLATFORM !== 'topstepx') return null;
    // Look for "Contract" label then read dropdown/select value
    const allLabels = document.querySelectorAll('label, span, div, p');
    for (const el of allLabels) {
      const t = (el.textContent || '').trim();
      if (/^contract$/i.test(t)) {
        const scope = el.parentElement;
        if (!scope) continue;
        // Could be a select, or a div acting as dropdown showing current value
        const select = scope.querySelector('select');
        if (select) return normalizeSym(select.value);
        // MUI-style: look for text in a sibling div
        const sib = el.nextElementSibling || scope.querySelector('[role="button"], [class*="select"], [class*="dropdown"]');
        if (sib) {
          const val = (sib.textContent || sib.value || '').trim();
          if (val) return normalizeSym(val);
        }
      }
    }
    // Broader fallback: any element with data-testid containing "contract"
    const contractEl = document.querySelector('[data-testid*="contract" i]');
    if (contractEl) {
      const val = (contractEl.textContent || contractEl.value || '').trim();
      if (val) return normalizeSym(val);
    }
    return null;
  }

  /** Normalize symbol: "NQH26" → "NQ", "MNQM26" → "MNQ", "ESZ25" → "ES" etc.
   *  Strips the month code + year suffix that TopstepX appends. */
  function normalizeSym(raw) {
    const s = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Known roots — match longest first
    const roots = ['MNQ', 'MES', 'MYM', 'NQ', 'ES', 'YM'];
    for (const r of roots) {
      if (s.startsWith(r)) return r;
    }
    // Fallback: strip trailing letter+digits (month code + year)
    const m = s.match(/^([A-Z]{1,4}?)[FGHJKMNQUVXZ]\d{2}$/);
    return m ? m[1] : s;
  }

  /** Detect selected account from Account dropdown.
   *  Returns { label, isPractice } or null. */
  function detectSelectedAccount() {
    if (PLATFORM !== 'topstepx') return null;
    // Account selector shows "$100K TRADING ..." or "$150K PRACTICE ..."
    const candidates = document.querySelectorAll(
      '[class*="account" i] [role="button"], [class*="account" i] select, ' +
      '[data-testid*="account" i], [class*="account-select" i], [class*="account-dropdown" i]'
    );
    for (const el of candidates) {
      const text = (el.textContent || el.value || '').trim();
      if (/\$([\d,]+K?)\s+(TRADING|PRACTICE|PAPER)/i.test(text)) {
        const isPractice = /PRACTICE|PAPER/i.test(text);
        return { label: text.replace(/\s+/g, ' ').slice(0, 60), isPractice };
      }
    }
    // Broader scan: any visible text matching the pattern
    const allEls = document.querySelectorAll('span, div, option');
    for (const el of allEls) {
      const t = (el.textContent || '').trim();
      if (/\$\d[\d,]*K?\s+(TRADING|PRACTICE|PAPER)/i.test(t) && t.length < 80) {
        const isPractice = /PRACTICE|PAPER/i.test(t);
        return { label: t.replace(/\s+/g, ' ').slice(0, 60), isPractice };
      }
    }
    return null;
  }

  /* ═══ Daily lock banner ═══ */
  function showDailyLockBanner() {
    if (dailyLockBannerEl) dailyLockBannerEl.remove();
    if (!dailyConfig || !dailyConfig.limits) return;
    const lim = dailyConfig.limits;
    const parts = [];
    if (lim.maxMNQ) parts.push(`MNQ:${lim.maxMNQ}`);
    if (lim.maxNQ) parts.push(`NQ:${lim.maxNQ}`);
    if (lim.maxES) parts.push(`ES:${lim.maxES}`);
    if (lim.maxMES) parts.push(`MES:${lim.maxMES}`);
    if (lim.maxYM) parts.push(`YM:${lim.maxYM}`);
    if (lim.maxMYM) parts.push(`MYM:${lim.maxMYM}`);
    dailyLockBannerEl = document.createElement('div');
    // v0.3.1 — centered floating pill instead of full-width top banner.
    // User feedback: full-width version covered critical account/P&L info in the platform top bar.
    dailyLockBannerEl.style.cssText = `
      position:fixed;top:4px;left:50%;transform:translateX(-50%);
      padding:5px 16px;max-width:60vw;
      background:rgba(209,31,63,0.92);color:#fff;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
      text-align:center;border-radius:4px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      z-index:2147483599;
      box-shadow:0 2px 10px rgba(0,0,0,0.4);
      pointer-events:none;
    `;
    dailyLockBannerEl.textContent = `DAILY LIMITS LOCKED · ${parts.join(' · ')} · unlocks 4:00 PM ET`;
    document.body.appendChild(dailyLockBannerEl);
  }

  function removeDailyLockBanner() {
    if (dailyLockBannerEl) { dailyLockBannerEl.remove(); dailyLockBannerEl = null; }
  }

  /* ═══ Tier system boot ═══ */
  chrome.runtime.sendMessage({ type: 'get-tier' }, res => {
    if (res && res.ok) {
      tierData = { ladder: res.ladder, state: res.state, enabled: res.enabled };
    }
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'tier-changed') {
      tierData = { ladder: msg.ladder, state: msg.state, enabled: msg.enabled };
      sendResponse({ ok: true });
    }
  });

  /* ═══ Risk Settings page interception (TopstepX only) ═══
   * When user navigates to Settings → Risk Settings, overlay the entire section
   * to prevent any changes. This catches the tilt-driven impulse to remove limits.
   * Detection: look for URL hash/path containing 'settings' or 'risk', or DOM elements
   * that contain risk-settings-related controls. */
  function checkForRiskSettingsPage() {
    if (PLATFORM !== 'topstepx') return;
    if (!tierData.enabled) return;

    // URL-based detection
    const url = location.href.toLowerCase();
    const hash = location.hash.toLowerCase();
    const isRiskUrl = /risk.?settings|\/settings.*risk/i.test(url + hash);

    // DOM-based detection: look for headings or labels mentioning risk settings / contract limits
    let isRiskDom = false;
    const headings = document.querySelectorAll('h1, h2, h3, h4, [class*="heading"], [class*="title"], [role="heading"]');
    headings.forEach(el => {
      const t = (el.textContent || '').toLowerCase();
      if (/risk\s*settings|contract\s*limit|position\s*limit|max\s*contracts/i.test(t)) {
        isRiskDom = true;
      }
    });

    // Also detect settings nav items that are currently active
    const navItems = document.querySelectorAll('[class*="active"], [aria-selected="true"], [class*="selected"]');
    navItems.forEach(el => {
      const t = (el.textContent || '').toLowerCase();
      if (/risk/i.test(t)) isRiskDom = true;
    });

    if ((isRiskUrl || isRiskDom) && !tierOverlayEl) {
      showTierLockOverlay();
    } else if (!isRiskUrl && !isRiskDom && tierOverlayEl) {
      removeTierOverlay();
    }
  }

  function showTierLockOverlay() {
    if (tierOverlayEl) tierOverlayEl.remove();
    const tier = tierData.ladder[tierData.state.currentTier] || {};
    const nextTier = tierData.ladder[tierData.state.currentTier + 1];
    const profit = tierData.state.currentEquity && tierData.state.baselineEquity
      ? tierData.state.currentEquity - tierData.state.baselineEquity : 0;
    const nextAt = nextTier ? `$${nextTier.profitThreshold.toLocaleString()}` : 'max tier';

    tierOverlayEl = document.createElement('div');
    tierOverlayEl.className = 'cc-overlay';
    tierOverlayEl.style.background = 'rgba(5, 6, 9, 0.96)';
    tierOverlayEl.innerHTML = `
      <div class="cc-overlay-card" style="border-color: #e8b95e; box-shadow: 0 20px 60px rgba(232,185,94,0.3);">
        <div style="font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:#e8b95e;font-weight:700;margin-bottom:6px;">
          CADENCE CONTROL · CONTRACT LIMITS LOCKED
        </div>
        <div style="font-size:22px;font-weight:700;color:#fff;margin-bottom:10px;">
          Tier ${tierData.state.currentTier}: ${escapeHtml(tier.label || 'Unknown')}
        </div>
        <div style="font-size:13px;color:#9ba5bc;line-height:1.7;margin-bottom:14px;">
          <div>MNQ: <b style="color:#fff">${tier.maxMNQ || 0}</b> · NQ: <b style="color:#fff">${tier.maxNQ || 0}</b> · ES: <b style="color:#fff">${tier.maxES || 0}</b> · MES: <b style="color:#fff">${tier.maxMES || 0}</b></div>
          <div>YM: <b style="color:#fff">${tier.maxYM || 0}</b> · MYM: <b style="color:#fff">${tier.maxMYM || 0}</b></div>
          <div style="margin-top:8px;color:#e8b95e;">Next unlock at ${escapeHtml(nextAt)} profit</div>
        </div>
        <div style="font-size:11px;color:#5c6878;line-height:1.5;">
          Risk settings cannot be modified while Cadence Control is installed.<br>
          This restriction exists to protect you from tilt-driven decisions.
        </div>
      </div>
    `;
    document.body.appendChild(tierOverlayEl);

    // Also disable all inputs/selects/buttons within the risk settings area
    disableRiskSettingsInputs();

    chrome.runtime.sendMessage({
      type: 'log', logType: 'tier-risk-block',
      payload: { tier: tierData.state.currentTier, url: location.href }
    });
  }

  function disableRiskSettingsInputs() {
    // Find and disable all form controls on the page that look like risk settings
    const inputs = document.querySelectorAll('input, select, textarea, [contenteditable="true"]');
    inputs.forEach(el => {
      const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').toLowerCase();
      const parentText = (el.parentElement?.textContent || '').toLowerCase();
      if (/contract|position|limit|max|risk|size/i.test(label + parentText)) {
        el.setAttribute('disabled', 'true');
        el.setAttribute('readonly', 'true');
        el.style.pointerEvents = 'none';
        el.style.opacity = '0.4';
        el.dataset.ccLocked = 'true';
      }
    });
  }

  function removeTierOverlay() {
    if (tierOverlayEl) { tierOverlayEl.remove(); tierOverlayEl = null; }
    // Re-enable any inputs we disabled
    document.querySelectorAll('[data-cc-locked="true"]').forEach(el => {
      el.removeAttribute('disabled');
      el.removeAttribute('readonly');
      el.style.pointerEvents = '';
      el.style.opacity = '';
      delete el.dataset.ccLocked;
    });
  }

  /* ═══ Equity scraping (TopstepX) ═══
   * Reads account equity from the TopstepX DOM and reports to background.
   * v0.4.0: also reports detected account info for per-account tier state. */
  function scrapeEquity() {
    if (PLATFORM !== 'topstepx') return;

    // Detect which account is selected
    const account = detectSelectedAccount();

    // Common patterns: look for text containing $ followed by numbers near
    // labels like "Equity", "Balance", "Account Value", "Net P&L"
    const candidates = document.querySelectorAll(
      '[class*="equity" i], [class*="balance" i], [class*="account-value" i], ' +
      '[class*="pnl" i], [class*="net-liq" i], [data-field*="equity" i], ' +
      '[data-field*="balance" i]'
    );
    for (const el of candidates) {
      const text = (el.textContent || '').replace(/[,\s]/g, '');
      const match = text.match(/\$?([\d]+\.?\d*)/);
      if (match) {
        const val = parseFloat(match[1]);
        if (val > 1000 && val < 10000000) {
          safeSend({ type: 'equity-update', equity: val, account });
          return;
        }
      }
    }

    // Fallback: scan all visible text for "Equity" / "Balance" / "Account Value" labels
    const allEls = document.querySelectorAll('span, div, td, p');
    for (const el of allEls) {
      const t = (el.textContent || '').trim();
      if (/^(equity|balance|account\s*value|net\s*liq)/i.test(t)) {
        const sibling = el.nextElementSibling;
        if (sibling) {
          const valText = (sibling.textContent || '').replace(/[,\s]/g, '');
          const m = valText.match(/\$?([\d]+\.?\d*)/);
          if (m) {
            const val = parseFloat(m[1]);
            if (val > 1000 && val < 10000000) {
              safeSend({ type: 'equity-update', equity: val, account });
              return;
            }
          }
        }
      }
    }
  }

  /* ═══ Periodic checks ═══ */
  // Risk settings detection — check every 2s for SPA navigation
  setInterval(checkForRiskSettingsPage, 2000);
  // Equity scraping — every 15s
  setInterval(scrapeEquity, 15000);
  setTimeout(scrapeEquity, 3000); // initial

  /* ═══ Start discovery ═══ */
  // Run discovery once on load, then every 10s for 60s (SPA re-renders)
  setTimeout(discover, 1500);
  setTimeout(discover, 5000);
  setTimeout(discover, 15000);
  setTimeout(discover, 30000);
})();
