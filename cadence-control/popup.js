/* Cadence Control · Popup · v0.5.0 */

function fmtAge(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function fmtMoney(n) {
  if (n === null || n === undefined) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function render(state) {
  const lo = state.lockoutState || {};
  const hb = state.cadenceHeartbeat || {};
  const dc = state.dailyConfig || {};
  const ladder = state.tierLadder || [];
  const ts = state.tierState || {};

  /* ═══ PDLL section ═══ */
  renderPdllSection();

  /* ═══ Daily limits section ═══ */
  renderDailySection(dc);

  /* ═══ Account ═══ */
  const acctInput = document.getElementById('accountId');
  if (dc.accountId && !acctInput.value) {
    acctInput.value = dc.accountId;
  }

  /* ═══ Lockout section ═══ */
  const tag = document.getElementById('lockoutTag');
  tag.textContent = (lo.kind || 'NONE').toUpperCase();
  tag.className = 'tag ' + (lo.kind === 'none' ? 'none' : (lo.kind === 'opening-range' ? 'warn' : 'active'));

  document.getElementById('lockoutReason').textContent = lo.reason || '—';
  document.getElementById('blockMarket').textContent = lo.blockMarketOrders ? 'BLOCKED' : 'allowed';
  document.getElementById('blockMarket').style.color = lo.blockMarketOrders ? '#d11f3f' : '#e6e7eb';
  document.getElementById('blockEntries').textContent = lo.blockNewEntries ? 'BLOCKED' : 'allowed';
  document.getElementById('blockEntries').style.color = lo.blockNewEntries ? '#d11f3f' : '#e6e7eb';
  document.getElementById('blockSl').textContent = lo.blockSlWiden ? 'BLOCKED' : 'allowed';

  /* ═══ Tier section ═══ */
  const activeAcct = state.activeAccount;
  const acctLabel = document.getElementById('activeAcctLabel');
  if (activeAcct) {
    acctLabel.textContent = activeAcct.label + (activeAcct.isPractice ? ' (PRACTICE)' : '');
    acctLabel.style.color = activeAcct.isPractice ? '#e8b95e' : '#34d399';
  } else {
    acctLabel.textContent = 'not detected';
  }

  // Use effective tier (practice guard may force T0)
  const isPractice = activeAcct && activeAcct.isPractice;
  const practiceTestingOn = !!state.practiceTierTesting;
  const curTier = (isPractice && !practiceTestingOn) ? 0 : (ts.currentTier || 0);
  const tier = ladder[curTier];
  const nextTier = ladder[curTier + 1];
  const profit = (ts.currentEquity && ts.baselineEquity) ? ts.currentEquity - ts.baselineEquity : null;

  let tierLabelText = tier ? `T${curTier}: ${tier.label}` : `T${curTier}`;
  if (isPractice && !practiceTestingOn) tierLabelText += ' (practice locked)';
  document.getElementById('tierLabel').textContent = tierLabelText;
  document.getElementById('tierLabel').style.color = (isPractice && !practiceTestingOn) ? '#e8b95e' : '#e6e7eb';
  document.getElementById('tierProfit').textContent = profit !== null ? fmtMoney(profit) : 'awaiting first read';
  document.getElementById('tierNext').textContent = nextTier
    ? `${fmtMoney(nextTier.profitThreshold)} → T${curTier + 1}: ${nextTier.label}` : 'max tier reached';
  if (tier) {
    const parts = [];
    if (tier.maxMNQ) parts.push(`MNQ:${tier.maxMNQ}`);
    if (tier.maxNQ) parts.push(`NQ:${tier.maxNQ}`);
    if (tier.maxES) parts.push(`ES:${tier.maxES}`);
    if (tier.maxMES) parts.push(`MES:${tier.maxMES}`);
    if (tier.maxYM) parts.push(`YM:${tier.maxYM}`);
    if (tier.maxMYM) parts.push(`MYM:${tier.maxMYM}`);
    document.getElementById('tierLimits').textContent = parts.join(' · ') || 'all blocked';
  }

  // Practice tier toggle
  const toggle = document.getElementById('practiceTierToggle');
  toggle.checked = practiceTestingOn;

  /* ═══ Heartbeat section ═══ */
  document.getElementById('hbBpm').textContent = hb.bpm || '—';
  document.getElementById('hbTier').textContent = hb.tier || '—';
  document.getElementById('hbSource').textContent = hb.sourceKind || 'none';
  document.getElementById('hbAge').textContent = fmtAge(hb.lastSeen);

  /* ═══ Event log ═══ */
  const logBox = document.getElementById('eventLog');
  const log = state.eventLog || [];
  if (!log.length) {
    logBox.textContent = 'No events yet.';
  } else {
    logBox.innerHTML = log.slice(-30).reverse().map(e => {
      const t = new Date(e.t);
      const hm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
      const pay = JSON.stringify(e.payload || {}).slice(0, 80);
      return '<div class="log-row"><span class="t">' + hm + '</span><b>' + e.type + '</b> ' + pay + '</div>';
    }).join('');
  }
}

function fmtCountdown(ms) {
  if (!ms || ms <= 0) return '—';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function renderPdllSection() {
  chrome.runtime.sendMessage({ type: 'get-pdll-config' }, res => {
    if (!res || !res.ok) return;
    const pc = res.config;
    const ti = res.timeInfo;

    const statusTag = document.getElementById('pdllStatusTag');
    const setupArea = document.getElementById('pdllSetupArea');
    const lockedArea = document.getElementById('pdllLockedArea');
    const rpnlEl = document.getElementById('pdllRPnL');

    // Show RP&L if available
    if (pc.lastRPnL !== null && pc.lastRPnL !== undefined) {
      const neg = pc.lastRPnL < 0;
      rpnlEl.textContent = `RP&L: ${neg ? '-' : ''}$${Math.abs(pc.lastRPnL).toFixed(0)}`;
      rpnlEl.style.color = neg ? '#d11f3f' : '#34d399';
    } else {
      rpnlEl.textContent = '';
    }

    if (ti.isLocked) {
      statusTag.textContent = pc.hardBreached ? 'HARD BREACH' : (pc.softBreached ? 'SOFT BREACH' : 'LOCKED');
      statusTag.className = 'tag ' + (pc.hardBreached ? 'active' : (pc.softBreached ? 'warn' : 'locked'));
      setupArea.style.display = 'none';
      lockedArea.style.display = 'block';

      document.getElementById('pdllLockedSoft').textContent = '-$' + pc.softLimit;
      document.getElementById('pdllLockedHard').textContent = '-$' + pc.hardLimit;

      // Soft status
      const softEl = document.getElementById('pdllSoftStatus');
      if (pc.softBreached) {
        softEl.textContent = 'SPENT';
        softEl.style.color = '#d11f3f';
      } else {
        softEl.textContent = 'armed';
        softEl.style.color = '#34d399';
      }

      // Hard status
      const hardEl = document.getElementById('pdllHardStatus');
      if (pc.hardBreached) {
        hardEl.textContent = 'BREACHED — session over';
        hardEl.style.color = '#d11f3f';
      } else {
        hardEl.textContent = 'armed';
        hardEl.style.color = '#34d399';
      }

      // Adjustments
      document.getElementById('pdllAdjustStatus').textContent =
        pc.softBreached ? `${pc.adjustCount}/1${pc.adjustCount >= 1 ? ' (used)' : ' remaining'}` : '0/1';

      // Cooldown
      const cooldownEl = document.getElementById('pdllCooldown');
      if (ti.softCooldownActive) {
        cooldownEl.textContent = fmtCountdown(ti.softCooldownRemaining) + ' remaining';
        cooldownEl.style.color = '#e8b95e';
      } else if (pc.softBreached && !pc.hardBreached) {
        cooldownEl.textContent = 'expired — trading resumed';
        cooldownEl.style.color = '#34d399';
      } else {
        cooldownEl.textContent = '—';
        cooldownEl.style.color = '';
      }

      // Show adjustment UI if: soft breached, cooldown expired, not hard breached, adjustCount < 1
      const adjustArea = document.getElementById('pdllAdjustArea');
      if (pc.softBreached && !ti.softCooldownActive && !pc.hardBreached && pc.adjustCount < 1) {
        adjustArea.style.display = 'block';
        document.getElementById('pdllNewHard').value = pc.hardLimit;
      } else {
        adjustArea.style.display = 'none';
      }

      // Status message
      const statusMsg = document.getElementById('pdllStatusMsg');
      if (pc.hardBreached) {
        statusMsg.textContent = 'Session over. All entries blocked until next day.';
        statusMsg.style.color = '#d11f3f';
        statusMsg.style.borderColor = 'rgba(209,31,63,0.3)';
        statusMsg.style.background = 'rgba(209,31,63,0.08)';
      } else if (ti.softCooldownActive) {
        statusMsg.textContent = `Soft breach — ${fmtCountdown(ti.softCooldownRemaining)} mandatory pause.`;
        statusMsg.style.color = '#e8b95e';
      } else if (pc.softBreached) {
        statusMsg.textContent = 'Soft breach spent. Trading resumed. 1 hard adjustment available.';
        statusMsg.style.color = '#e8b95e';
      } else {
        statusMsg.textContent = 'PDLL locked. Unlocks at 4:00 PM ET.';
        statusMsg.style.color = '#e8b95e';
      }

    } else {
      // Not locked — show setup
      statusTag.textContent = 'NOT SET';
      statusTag.className = 'tag unlocked';
      setupArea.style.display = 'block';
      lockedArea.style.display = 'none';

      // Pre-fill if already set today
      if (pc.softLimit) document.getElementById('pdllSoft').value = pc.softLimit;
      if (pc.hardLimit) document.getElementById('pdllHard').value = pc.hardLimit;
    }
  });
}

function renderDailySection(dc) {
  // Ask background for time info
  chrome.runtime.sendMessage({ type: 'get-daily-config' }, res => {
    if (!res || !res.ok) return;
    const config = res.config;
    const ti = res.timeInfo;

    document.getElementById('dailyTimeET').textContent = ti.currentET + ' ET';

    const statusTag = document.getElementById('dailyStatusTag');
    const setupArea = document.getElementById('dailySetupArea');
    const lockedArea = document.getElementById('dailyLockedArea');
    const deleteWindowBadge = document.getElementById('deleteWindowBadge');

    // Delete window badge
    if (ti.isDeleteWindow) {
      deleteWindowBadge.textContent = 'EXTENSION REMOVABLE (4-6PM)';
      deleteWindowBadge.className = 'delete-window-badge open';
    } else {
      deleteWindowBadge.textContent = 'EXTENSION LOCKED — NO REMOVAL';
      deleteWindowBadge.className = 'delete-window-badge closed';
    }

    if (ti.isLocked) {
      // LOCKED state
      statusTag.textContent = 'LOCKED';
      statusTag.className = 'tag locked';
      setupArea.style.display = 'none';
      lockedArea.style.display = 'block';

      const lim = config.limits || {};
      document.getElementById('lockedMNQ').textContent = lim.maxMNQ || 0;
      document.getElementById('lockedNQ').textContent = lim.maxNQ || 0;
      document.getElementById('lockedES').textContent = lim.maxES || 0;
      document.getElementById('lockedMES').textContent = lim.maxMES || 0;
      document.getElementById('lockedYM').textContent = lim.maxYM || 0;
      document.getElementById('lockedMYM').textContent = lim.maxMYM || 0;

      const lockStatus = document.getElementById('lockStatusMsg');
      lockStatus.textContent = 'Limits locked. Unlocks at 4:00 PM ET.';
      lockStatus.className = 'lock-status';

    } else if (ti.isReviewWindow) {
      // REVIEW state (4-6pm ET) — can modify
      statusTag.textContent = 'REVIEW WINDOW';
      statusTag.className = 'tag review';
      setupArea.style.display = 'block';
      lockedArea.style.display = 'none';

      // Pre-fill with current limits if set today
      if (config.date === ti.todayET && config.limits) {
        prefillInputs(config.limits);
      }
      enableInputs(true);

    } else {
      // UNLOCKED / not set — morning setup
      statusTag.textContent = config.date === ti.todayET && config.limits ? 'SET (UNLOCKED)' : 'NOT SET';
      statusTag.className = 'tag unlocked';
      setupArea.style.display = 'block';
      lockedArea.style.display = 'none';

      if (config.date === ti.todayET && config.limits) {
        prefillInputs(config.limits);
      }
      enableInputs(true);
    }
  });
}

function prefillInputs(limits) {
  const fields = ['MNQ', 'NQ', 'ES', 'MES', 'YM', 'MYM'];
  fields.forEach(f => {
    const el = document.getElementById('d' + f);
    if (el && limits['max' + f] !== undefined) {
      el.value = limits['max' + f];
    }
  });
}

function enableInputs(enabled) {
  const fields = ['MNQ', 'NQ', 'ES', 'MES', 'YM', 'MYM'];
  fields.forEach(f => {
    const el = document.getElementById('d' + f);
    if (el) el.disabled = !enabled;
  });
  document.getElementById('btnLock').disabled = !enabled;
}

function readInputLimits() {
  const fields = ['MNQ', 'NQ', 'ES', 'MES', 'YM', 'MYM'];
  const limits = {};
  const allowed = [];
  fields.forEach(f => {
    const val = parseInt(document.getElementById('d' + f).value) || 0;
    limits['max' + f] = val;
    if (val > 0) allowed.push(f);
  });
  limits.allowedInstruments = allowed;
  return limits;
}

/* ═══ Event handlers ═══ */

// LOCK button
document.getElementById('btnLock').addEventListener('click', () => {
  const limits = readInputLimits();
  if (limits.allowedInstruments.length === 0) {
    alert('Set at least one instrument with a contract limit > 0 before locking.');
    return;
  }

  const msg = `LOCK these limits until 4:00 PM ET?\n\n` +
    Object.entries(limits)
      .filter(([k]) => k.startsWith('max'))
      .map(([k, v]) => `  ${k.replace('max', '')}: ${v}`)
      .join('\n') +
    `\n\nAllowed: ${limits.allowedInstruments.join(', ')}` +
    `\n\nThis cannot be undone until 4:00 PM ET.`;

  if (!confirm(msg)) return;

  // Save limits first, then lock
  const accountId = document.getElementById('accountId').value.trim() || null;
  chrome.runtime.sendMessage({
    type: 'set-daily-limits',
    limits,
    accountId,
  }, res => {
    if (!res || !res.ok) {
      alert('Failed to set limits: ' + (res?.error || 'unknown'));
      return;
    }
    // Now lock
    chrome.runtime.sendMessage({ type: 'lock-daily-limits' }, res2 => {
      if (!res2 || !res2.ok) {
        alert('Failed to lock: ' + (res2?.error || 'unknown'));
        return;
      }
      refresh();
    });
  });
});

// LOCK PDLL button
document.getElementById('btnLockPdll').addEventListener('click', () => {
  const soft = parseInt(document.getElementById('pdllSoft').value) || 0;
  const hard = parseInt(document.getElementById('pdllHard').value) || 0;
  if (soft <= 0 || hard <= 0) {
    alert('Set both soft and hard PDLL values greater than $0.');
    return;
  }
  if (hard <= soft) {
    alert('Hard PDLL must be greater than soft PDLL.');
    return;
  }
  const msg = `LOCK PDLL limits until 4:00 PM ET?\n\n` +
    `  Soft: -$${soft} (30-min pause on breach)\n` +
    `  Hard: -$${hard} (session over on breach)\n\n` +
    `This cannot be undone until 4:00 PM ET.`;
  if (!confirm(msg)) return;

  const accountId = document.getElementById('accountId').value.trim() || null;
  chrome.runtime.sendMessage({
    type: 'set-pdll-limits',
    softLimit: soft,
    hardLimit: hard,
    accountId,
  }, res => {
    if (!res || !res.ok) {
      alert('Failed to set PDLL: ' + (res?.error || 'unknown'));
      return;
    }
    chrome.runtime.sendMessage({ type: 'lock-pdll-limits' }, res2 => {
      if (!res2 || !res2.ok) {
        alert('Failed to lock PDLL: ' + (res2?.error || 'unknown'));
        return;
      }
      refresh();
    });
  });
});

// Adjust hard PDLL (post-soft breach, one-time)
document.getElementById('btnAdjustHard').addEventListener('click', () => {
  const newHard = parseInt(document.getElementById('pdllNewHard').value) || 0;
  if (newHard <= 0) {
    alert('Enter a valid hard PDLL amount.');
    return;
  }
  if (!confirm(`Adjust hard PDLL to -$${newHard}?\n\nThis is your ONE allowed adjustment. It cannot be changed again.`)) return;
  chrome.runtime.sendMessage({ type: 'adjust-pdll-hard', newHardLimit: newHard }, res => {
    if (!res || !res.ok) {
      alert('Adjustment failed: ' + (res?.error || 'unknown'));
      return;
    }
    refresh();
  });
});

// Practice tier testing toggle
document.getElementById('practiceTierToggle').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  const msg = enabled
    ? 'Enable tier advancement on practice accounts?\n\nPractice equity will advance your tier as if it were real.'
    : 'Disable practice tier testing?\n\nPractice accounts will return to T0 (Starter).';
  if (!confirm(msg)) {
    e.target.checked = !enabled; // revert
    return;
  }
  chrome.runtime.sendMessage({ type: 'set-practice-tier-testing', enabled }, () => refresh());
});

// Reset baseline
document.getElementById('btnResetBaseline').addEventListener('click', () => {
  const accountId = document.getElementById('accountId').value.trim();
  if (!accountId) {
    alert('Enter an account ID first (e.g. TOPX5394).');
    return;
  }
  if (!confirm(`Reset equity baseline for account ${accountId}?\n\nThis resets your profit tier to T0 (Starter) and starts fresh equity tracking.`)) return;

  chrome.runtime.sendMessage({ type: 'reset-baseline', accountId }, res => {
    if (res && res.ok) {
      refresh();
    } else {
      alert('Reset failed: ' + (res?.error || 'unknown'));
    }
  });
});

// Refresh + clear log
document.getElementById('btnRefresh').addEventListener('click', refresh);
document.getElementById('btnClearLog').addEventListener('click', async () => {
  await chrome.storage.local.set({ eventLog: [] });
  refresh();
});

async function refresh() {
  const st = await chrome.storage.local.get([
    'lockoutState', 'cadenceHeartbeat', 'eventLog',
    'tierLadder', 'tierState', 'tierLockEnabled',
    'dailyConfig', 'activeAccount', 'accountTiers', 'practiceTierTesting',
    'pdllConfig'
  ]);
  render(st);
}

refresh();
setInterval(refresh, 2000);
