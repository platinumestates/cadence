/* Cadence Control · Platform Content Script · v0.5.0
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
  safeSend({ type: 'get-tier' }, res => {
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

  /* ═══ Surgical Risk Settings locking (v0.5.0) ═══
   * Instead of full-page overlay on /settings, we surgically lock ONLY specific
   * controls while leaving everything else (Layout, Display, Hotkeys, etc.) accessible.
   *
   * ALWAYS LOCKED (when extension is active):
   *   - "Symbol Contract Limits" section (entire container)
   *   - "Lock Risk Settings for Day" button (conflicts with our enforcement model)
   *
   * LOCKED WHEN DAILY LIMITS ARE LOCKED:
   *   - "Personal Daily Loss Limit (PDLL)" input + action dropdown
   *   - "PDLL Action" dropdown
   *   - "Personal Daily Profit Target (PDPT)" input + action dropdown
   *   - "PDPT Action" dropdown
   *
   * NEVER LOCKED:
   *   - All other Risk Settings controls (OCO Brackets, Trade Limits, Symbol Blocks, etc.)
   *   - All other settings tabs (Copy Trading, Charts & Data, Privacy, Hotkeys, Misc, API)
   */

  const CC_LOCK_ATTR = 'data-cc-locked';
  const CC_CHIP_CLASS = 'cc-lock-chip';
  const CC_SECTION_OVERLAY_CLASS = 'cc-section-overlay';

  /** Find an input/select near a label with matching text */
  function findControlNearLabel(labelText) {
    const targets = document.querySelectorAll('label, div, span');
    for (const el of targets) {
      const t = (el.textContent || '').trim();
      if (t.toLowerCase() === labelText.toLowerCase()) {
        // Input is typically within the same parent row/field container
        const container = el.closest('[class*="row"], [class*="field"], [class*="group"], [class*="setting"], [class*="form"], div');
        if (container) {
          const control = container.querySelector('input, select, [role="combobox"], [role="listbox"]');
          if (control && control !== el) return { control, container };
        }
        // Try sibling approach
        const sib = el.nextElementSibling;
        if (sib) {
          const sibControl = sib.matches('input, select') ? sib : sib.querySelector('input, select, [role="combobox"]');
          if (sibControl) return { control: sibControl, container: sib.parentElement || sib };
        }
      }
    }
    return null;
  }

  /** Find a section container by heading text */
  function findSectionByHeading(headingText) {
    const candidates = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [class*="heading"], [class*="title"], [role="heading"], label, span, div');
    for (const el of candidates) {
      const t = (el.textContent || '').trim();
      if (t.toLowerCase().includes(headingText.toLowerCase()) && t.length < 80) {
        // Walk up to find the section container
        let section = el.closest('section, [class*="section"], [class*="panel"], [class*="card"], [class*="block"], [class*="group"]');
        if (!section) section = el.parentElement;
        return section;
      }
    }
    return null;
  }

  /** Find a button by its text content */
  function findButtonByText(text) {
    const btns = document.querySelectorAll('button, [role="button"], a.btn, input[type="submit"]');
    for (const btn of btns) {
      const t = (btn.textContent || btn.value || '').trim();
      if (t.toLowerCase().includes(text.toLowerCase())) return btn;
    }
    return null;
  }

  /** Apply per-control lock: disable + amber padlock chip */
  function lockControl(control, container, reason) {
    if (!control || control.getAttribute(CC_LOCK_ATTR)) return;
    control.setAttribute('disabled', 'true');
    control.setAttribute('readonly', 'true');
    control.style.pointerEvents = 'none';
    control.style.opacity = '0.4';
    control.setAttribute(CC_LOCK_ATTR, reason);

    // Add amber padlock chip if not already present
    const wrap = container || control.parentElement;
    if (wrap && !wrap.querySelector('.' + CC_CHIP_CLASS)) {
      const chip = document.createElement('div');
      chip.className = CC_CHIP_CLASS;
      chip.title = reason;
      chip.style.cssText = `
        display:inline-flex;align-items:center;gap:3px;
        padding:2px 8px;margin-left:6px;margin-top:2px;
        background:rgba(232,185,94,0.15);color:#e8b95e;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        font-size:9px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;
        border-radius:3px;white-space:nowrap;
      `;
      chip.textContent = '\uD83D\uDD12 Locked by Cadence Control';
      wrap.style.position = wrap.style.position || 'relative';
      wrap.appendChild(chip);
    }
  }

  /** Apply section-level lock: dim container + amber banner strip */
  function lockSection(section, reason) {
    if (!section || section.getAttribute(CC_LOCK_ATTR)) return;
    section.setAttribute(CC_LOCK_ATTR, reason);
    section.style.position = section.style.position || 'relative';
    section.style.opacity = '0.4';
    section.style.pointerEvents = 'none';

    // Add amber banner strip at top of section
    const banner = document.createElement('div');
    banner.className = CC_SECTION_OVERLAY_CLASS;
    banner.style.cssText = `
      position:absolute;top:0;left:0;right:0;z-index:10;
      padding:6px 12px;
      background:rgba(232,185,94,0.92);color:#0a0d12;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
      text-align:center;border-radius:4px 4px 0 0;
    `;
    banner.textContent = reason;
    section.insertBefore(banner, section.firstChild);

    // Also disable all interactive elements within
    section.querySelectorAll('input, select, button, [role="combobox"], [role="button"]').forEach(el => {
      el.setAttribute('disabled', 'true');
      el.setAttribute(CC_LOCK_ATTR, 'section');
    });
  }

  /** Lock a button (click-block + visual) */
  function lockButton(btn, reason) {
    if (!btn || btn.getAttribute(CC_LOCK_ATTR)) return;
    btn.setAttribute(CC_LOCK_ATTR, reason);
    btn.setAttribute('disabled', 'true');
    btn.style.pointerEvents = 'none';
    btn.style.opacity = '0.4';
    btn.title = reason;
  }

  /** Remove ALL surgical locks */
  function removeAllSurgicalLocks() {
    // Re-enable locked controls
    document.querySelectorAll(`[${CC_LOCK_ATTR}]`).forEach(el => {
      el.removeAttribute('disabled');
      el.removeAttribute('readonly');
      el.style.pointerEvents = '';
      el.style.opacity = '';
      el.removeAttribute(CC_LOCK_ATTR);
      el.title = '';
    });
    // Remove chips and section banners
    document.querySelectorAll(`.${CC_CHIP_CLASS}, .${CC_SECTION_OVERLAY_CLASS}`).forEach(el => el.remove());
  }

  /** Main surgical lock scan — runs periodically on /settings pages */
  function applySurgicalSettingsLocks() {
    if (PLATFORM !== 'topstepx') return;

    // Detect if we're on a settings page
    const isSettingsPage = /settings/i.test(location.href);
    if (!isSettingsPage) {
      // Not on settings — clean up any leftover locks
      if (document.querySelector(`[${CC_LOCK_ATTR}]`)) removeAllSurgicalLocks();
      return;
    }

    // Detect if the Risk Settings tab is currently visible/active
    const isRiskTabActive = (() => {
      const tabs = document.querySelectorAll('[role="tab"], [class*="tab"], a[href*="risk"], button');
      for (const tab of tabs) {
        const t = (tab.textContent || '').trim().toLowerCase();
        if (/^risk\s*settings?$/i.test(t)) {
          // Check if this tab is active
          const isActive = tab.getAttribute('aria-selected') === 'true'
            || tab.classList.contains('active')
            || tab.classList.contains('selected')
            || tab.closest('[class*="active"]') !== null;
          return isActive;
        }
      }
      // Fallback: check if Risk Settings content is visible in DOM
      const riskHeading = findSectionByHeading('Risk Settings');
      return !!riskHeading;
    })();

    if (!isRiskTabActive) {
      // Non-risk tab — make sure nothing is locked
      if (document.querySelector(`[${CC_LOCK_ATTR}]`)) removeAllSurgicalLocks();
      return;
    }

    // === ALWAYS LOCKED (when extension is active on Risk Settings tab) ===

    // 1. Contract Limits section — entire section container
    const contractSection = findSectionByHeading('Symbol Contract Limits') || findSectionByHeading('Contract Limits');
    if (contractSection) {
      lockSection(contractSection, 'Contract limits managed by Cadence Control. Next unlock at 4:00 PM ET.');
    }

    // 2. "Lock Risk Settings for Day" button — conflicts with our model
    const lockRiskBtn = findButtonByText('Lock Risk Settings for Day') || findButtonByText('Lock Risk Settings');
    if (lockRiskBtn) {
      lockButton(lockRiskBtn, 'Blocked by Cadence Control — use the extension popup to lock limits.');
    }

    // === LOCKED WHEN DAILY LIMITS ARE LOCKED ===
    const isDailyLocked = dailyConfig && dailyConfig.lockedAt && !dailyConfig.unlockedAt;

    if (isDailyLocked) {
      const pdllLabels = [
        'Personal Daily Loss Limit (PDLL)',
        'PDLL Action',
        'Personal Daily Profit Target (PDPT)',
        'PDPT Action',
      ];
      for (const label of pdllLabels) {
        const found = findControlNearLabel(label);
        if (found) {
          lockControl(found.control, found.container, 'Unlocks 4:00 PM ET');
        }
      }
    }

    // Log first detection
    if (!tierOverlayEl) {
      tierOverlayEl = true; // reuse flag to track that we've logged
      safeSend({
        type: 'log', logType: 'surgical-risk-lock',
        payload: { contractSection: !!contractSection, lockBtn: !!lockRiskBtn, dailyLocked: isDailyLocked }
      });
    }
  }

  /** Remove tier overlay is now just removing surgical locks */
  function removeTierOverlay() {
    removeAllSurgicalLocks();
    tierOverlayEl = null;
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

  /* ═══ Realized P&L scraping (v0.5.0 — PDLL enforcement) ═══
   * Reads RP&L from TopstepX account bar header. Format: "RP&L: $123.45" or "RP&L: -$123.45"
   * Polls every 5-10 seconds and reports to background for threshold checking. */
  function scrapeRealizedPnl() {
    if (PLATFORM !== 'topstepx') return;
    const els = document.querySelectorAll('div, span');
    for (const el of els) {
      const t = (el.textContent || '').trim();
      // Match "RP&L: $123.45" or "RP&L: -$123.45" or "RP&L: ($123.45)"
      const m = t.match(/^RP&L:\s*(-?)\$?([\d,]+\.?\d*)/);
      if (m) {
        const neg = m[1] === '-';
        const val = parseFloat(m[2].replace(/,/g, ''));
        if (!isNaN(val)) {
          const rpnl = neg ? -val : val;
          safeSend({ type: 'rpnl-update', rpnl });
          return;
        }
      }
      // Also match parenthetical negative: "RP&L: ($123.45)"
      const m2 = t.match(/^RP&L:\s*\(\$?([\d,]+\.?\d*)\)/);
      if (m2) {
        const val = parseFloat(m2[1].replace(/,/g, ''));
        if (!isNaN(val)) {
          safeSend({ type: 'rpnl-update', rpnl: -val });
          return;
        }
      }
    }
  }

  /* ═══ Periodic checks ═══ */
  // Surgical settings locks — check every 2s for SPA navigation
  setInterval(applySurgicalSettingsLocks, 2000);
  // Equity scraping — every 15s
  setInterval(scrapeEquity, 15000);
  setTimeout(scrapeEquity, 3000); // initial
  // RP&L scraping for PDLL enforcement — every 7s
  setInterval(scrapeRealizedPnl, 7000);
  setTimeout(scrapeRealizedPnl, 4000); // initial (stagger from equity)

  /* ═══ Start discovery ═══ */
  // Run discovery once on load, then every 10s for 60s (SPA re-renders)
  setTimeout(discover, 1500);
  setTimeout(discover, 5000);
  setTimeout(discover, 15000);
  setTimeout(discover, 30000);
})();
