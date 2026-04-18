/* Cadence Control · Background Service Worker · v0.5.0
 *
 * Role: central authority on lockout state, contract-limit tier enforcement,
 * daily limit locks, per-account tier state, and extension-presence watchdog.
 *
 * Storage schema (chrome.storage.local):
 *   lockoutState: { kind, tier, reason, startedAt, expiresAt, blockMarketOrders,
 *                   blockNewEntries, blockSlWiden, blockSlWidenWhenProfit,
 *                   allowExits, allowSlTighten }
 *   cadenceHeartbeat: { lastSeen, bpm, sourceKind, connected, tier }
 *   monitorActivation: { activatedAt, sustainedSec, thresholdSec }
 *   debugMode: bool
 *   eventLog: [{ t, type, payload }]
 *
 *   === CONTRACT-LIMIT TIER SYSTEM (v0.2) ===
 *   tierLadder: [ { label, profitThreshold, maxMNQ, maxNQ, maxES, maxMES, maxYM, maxMYM, allowedInstruments } ]
 *   tierState: { currentTier, baselineEquity, currentEquity, lastEquityUpdate, tierHistory }
 *   tierLockEnabled: bool
 *
 *   === PER-ACCOUNT TIER STATE (v0.4) ===
 *   accountTiers: { [accountLabel]: { currentTier, baselineEquity, currentEquity, lastEquityUpdate, tierHistory } }
 *   activeAccount: { label: string, isPractice: bool } | null
 *   practiceTierTesting: bool  // default false — practice accounts stay at T0 unless enabled
 *
 *   === DAILY LIMIT LOCK (v0.3) ===
 *   dailyConfig: { date, limits, lockedAt, unlockedAt, accountId }
 *   extensionPresence: { lastPing: unixMs }
 */

/* ═══ Contract-Limit Tier Ladder Defaults ═══
 * Tier 0 is the starting tier. Each tier unlocks more contracts as profit grows.
 * profitThreshold = profit above baselineEquity required to reach this tier.
 * NO UI to disable or override — uninstalling the extension is the only way out.
 * This friction IS the feature. */
const DEFAULT_TIER_LADDER = [
  {
    label: 'Starter',
    profitThreshold: 0,        // Tier 0: starting position
    maxMNQ: 10, maxNQ: 0, maxES: 0, maxMES: 0, maxYM: 0, maxMYM: 0,
    allowedInstruments: ['MNQ'],
  },
  {
    label: 'Building',
    profitThreshold: 10000,    // Tier 1: $10K profit
    maxMNQ: 15, maxNQ: 1, maxES: 0, maxMES: 5, maxYM: 0, maxMYM: 5,
    allowedInstruments: ['MNQ', 'NQ', 'MES', 'MYM'],
  },
  {
    label: 'Established',
    profitThreshold: 25000,    // Tier 2: $25K profit
    maxMNQ: 20, maxNQ: 2, maxES: 1, maxMES: 10, maxYM: 1, maxMYM: 10,
    allowedInstruments: ['MNQ', 'NQ', 'ES', 'MES', 'YM', 'MYM'],
  },
  {
    label: 'Advanced',
    profitThreshold: 50000,    // Tier 3: $50K profit
    maxMNQ: 30, maxNQ: 4, maxES: 2, maxMES: 15, maxYM: 2, maxMYM: 15,
    allowedInstruments: ['MNQ', 'NQ', 'ES', 'MES', 'YM', 'MYM'],
  },
  {
    label: 'Uncapped',
    profitThreshold: 100000,   // Tier 4: $100K profit
    maxMNQ: 99, maxNQ: 10, maxES: 5, maxMES: 30, maxYM: 5, maxMYM: 30,
    allowedInstruments: ['MNQ', 'NQ', 'ES', 'MES', 'YM', 'MYM'],
  },
];

const DEFAULT_TIER_STATE = {
  currentTier: 0,
  baselineEquity: null,    // set on first equity reading
  currentEquity: null,
  lastEquityUpdate: 0,
  tierHistory: [],
};

/* ═══ Time Window Helpers (all ET) ═══ */
function getET() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now);
  const get = n => { const p = parts.find(x => x.type === n); return p ? p.value : ''; };
  const hr = parseInt(get('hour')) || 0;
  const mn = parseInt(get('minute')) || 0;
  const tMin = hr * 60 + mn;
  const wd = get('weekday');
  const isWeekday = ['Mon','Tue','Wed','Thu','Fri'].includes(wd);
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  return { hr, mn, tMin, wd, isWeekday, dateStr };
}

/** Trading hours: weekdays, any time before 4pm ET (when limits are locked) */
function isTradingHours(et) {
  return et.isWeekday && et.tMin < (16 * 60); // before 4:00 PM
}

/** Delete/uninstall window: weekdays 4-6pm ET, or any time on weekends */
function isDeleteWindow(et) {
  if (!et.isWeekday) return true; // weekends: always allowed
  return et.tMin >= (16 * 60) && et.tMin < (18 * 60); // 4:00-6:00 PM ET
}

/** Review window: 4-6pm ET on weekdays — can adjust limits */
function isReviewWindow(et) {
  return et.isWeekday && et.tMin >= (16 * 60) && et.tMin < (18 * 60);
}

/** Returns today's date string in ET timezone */
function todayET() { return getET().dateStr; }

const DEFAULT_DAILY_CONFIG = {
  date: '',
  limits: { maxMNQ: 10, maxNQ: 0, maxES: 0, maxMES: 0, maxYM: 0, maxMYM: 0,
            allowedInstruments: ['MNQ'] },
  lockedAt: null,
  unlockedAt: null,
  accountId: null,
};

/* ═══ Two-Stage PDLL Enforcement (v0.5) ═══
 * Soft breach: realized P&L ≤ −$soft → 30-min hard lockout, then resume with 1 remaining PDLL adjustment.
 * Hard breach: realized P&L ≤ −$hard → session-end lockout, all entries blocked until next day.
 * Values are independent of TopstepX's native PDLL — we run parallel enforcement. */
const DEFAULT_PDLL_CONFIG = {
  date: '',
  softLimit: 500,          // default $500
  hardLimit: 1500,         // default $1500
  lockedAt: null,          // timestamp when locked (null = not locked)
  unlockedAt: null,        // timestamp when unlocked (null = still locked)
  accountId: null,
  // Runtime state
  softBreached: false,     // has soft breach fired today?
  softBreachAt: null,      // timestamp of soft breach
  softCooldownEnds: null,  // when 30-min cooldown expires
  hardBreached: false,     // has hard breach fired today?
  hardBreachAt: null,      // timestamp of hard breach
  adjustCount: 0,          // how many times hard PDLL was adjusted post-soft (max 1)
  lastRPnL: null,          // last scraped RP&L value
  lastRPnLUpdate: 0,       // timestamp of last RP&L reading
};
const PDLL_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

const DEFAULT_LOCKOUT = {
  kind: 'none',
  tier: null,
  reason: '',
  startedAt: 0,
  expiresAt: null,
  blockMarketOrders: false,
  blockNewEntries: false,
  blockSlWiden: true,        // v0.1 default: ALWAYS block SL widening (user spec)
  blockSlWidenWhenProfit: true,
  allowExits: true,
  allowSlTighten: true,
};

chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.local.get(['lockoutState', 'tierLadder']);
  if (!st.lockoutState) {
    await chrome.storage.local.set({
      lockoutState: DEFAULT_LOCKOUT,
      cadenceHeartbeat: { lastSeen: 0, bpm: null, sourceKind: null, connected: false },
      monitorActivation: { activatedAt: null, sustainedSec: 0, thresholdSec: 900 },
      debugMode: true,
      eventLog: [],
    });
    logEvent('install', { version: chrome.runtime.getManifest().version });
  }
  // Initialize tier system if not present
  if (!st.tierLadder) {
    await chrome.storage.local.set({
      tierLadder: DEFAULT_TIER_LADDER,
      tierState: DEFAULT_TIER_STATE,
      tierLockEnabled: true,
    });
    logEvent('tier-init', { tiers: DEFAULT_TIER_LADDER.length });
  }
  // Initialize daily config if not present
  const dc = await chrome.storage.local.get(['dailyConfig', 'accountTiers']);
  if (!dc.dailyConfig) {
    await chrome.storage.local.set({
      dailyConfig: { ...DEFAULT_DAILY_CONFIG, date: todayET() },
      extensionPresence: { lastPing: Date.now() },
    });
  }
  // Initialize per-account tier state (v0.4)
  if (!dc.accountTiers) {
    await chrome.storage.local.set({
      accountTiers: {},
      activeAccount: null,
      practiceTierTesting: false,
    });
  }
  // Initialize PDLL config (v0.5)
  const pdll = await chrome.storage.local.get(['pdllConfig']);
  if (!pdll.pdllConfig) {
    await chrome.storage.local.set({
      pdllConfig: { ...DEFAULT_PDLL_CONFIG, date: todayET() },
    });
  }
});

async function logEvent(type, payload) {
  const st = await chrome.storage.local.get(['eventLog']);
  const log = st.eventLog || [];
  log.push({ t: Date.now(), type, payload });
  if (log.length > 200) log.splice(0, log.length - 200);
  await chrome.storage.local.set({ eventLog: log });
}

/* Message router */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'get-lockout': {
          const st = await chrome.storage.local.get(['lockoutState']);
          sendResponse({ ok: true, lockout: st.lockoutState || DEFAULT_LOCKOUT });
          break;
        }
        case 'set-lockout': {
          await chrome.storage.local.set({ lockoutState: msg.lockout });
          logEvent('lockout-set', msg.lockout);
          // Broadcast to any open platform tabs
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (!tab.url) continue;
            if (/topstepx\.com|wealthcharts\.com|projectx\.com/.test(tab.url)) {
              chrome.tabs.sendMessage(tab.id, { type: 'lockout-changed', lockout: msg.lockout }).catch(() => {});
            }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'heartbeat': {
          // From Cadence tab — update knowledge of current BPM / connection state
          await chrome.storage.local.set({ cadenceHeartbeat: msg.heartbeat });
          sendResponse({ ok: true });
          break;
        }
        case 'get-heartbeat': {
          const st = await chrome.storage.local.get(['cadenceHeartbeat']);
          sendResponse({ ok: true, heartbeat: st.cadenceHeartbeat || {} });
          break;
        }
        case 'log': {
          logEvent(msg.logType || 'platform', msg.payload || {});
          sendResponse({ ok: true });
          break;
        }
        case 'get-log': {
          const st = await chrome.storage.local.get(['eventLog']);
          sendResponse({ ok: true, log: st.eventLog || [] });
          break;
        }

        /* ═══ Tier system messages ═══ */
        case 'get-tier': {
          const st = await chrome.storage.local.get(['tierLadder', 'tierState', 'tierLockEnabled', 'activeAccount', 'accountTiers', 'practiceTierTesting']);
          const activeAcct = st.activeAccount;
          let effectiveState = st.tierState || DEFAULT_TIER_STATE;
          // If we have a per-account state, use that
          if (activeAcct && st.accountTiers && st.accountTiers[activeAcct.label]) {
            effectiveState = st.accountTiers[activeAcct.label];
          }
          // Practice guard: force T0 unless testing enabled
          if (activeAcct && activeAcct.isPractice && !st.practiceTierTesting) {
            effectiveState = { ...effectiveState, currentTier: 0 };
          }
          sendResponse({
            ok: true,
            ladder: st.tierLadder || DEFAULT_TIER_LADDER,
            state: effectiveState,
            enabled: st.tierLockEnabled !== false,
            activeAccount: activeAcct,
            practiceTierTesting: !!st.practiceTierTesting,
          });
          break;
        }
        case 'equity-update': {
          // Content script reports current equity + detected account from DOM scrape
          const equity = msg.equity;
          const account = msg.account; // { label, isPractice } or null
          if (typeof equity !== 'number' || isNaN(equity)) {
            sendResponse({ ok: false, error: 'invalid equity' });
            break;
          }
          const st = await chrome.storage.local.get([
            'tierLadder', 'tierState', 'tierLockEnabled',
            'accountTiers', 'activeAccount', 'practiceTierTesting'
          ]);
          const ladder = st.tierLadder || DEFAULT_TIER_LADDER;
          let accountTiers = st.accountTiers || {};
          let activeAccount = account || st.activeAccount || null;

          // Track account switch
          if (account && (!st.activeAccount || st.activeAccount.label !== account.label)) {
            logEvent('account-switch', { from: st.activeAccount?.label, to: account.label, isPractice: account.isPractice });
            await chrome.storage.local.set({ activeAccount: account });
          }

          // Get or create per-account state
          const acctKey = activeAccount ? activeAccount.label : '__default__';
          let state = accountTiers[acctKey] || { ...DEFAULT_TIER_STATE };

          // Set baseline on first reading for this account
          if (state.baselineEquity === null) {
            state.baselineEquity = equity;
            logEvent('tier-baseline-set', { equity, account: acctKey });
          }

          state.currentEquity = equity;
          state.lastEquityUpdate = Date.now();
          const profit = equity - state.baselineEquity;

          // Practice guard: don't advance tier on practice accounts unless testing enabled
          const isPractice = activeAccount && activeAccount.isPractice;
          const allowAdvance = !isPractice || st.practiceTierTesting;

          if (allowAdvance) {
            // Calculate tier based on profit (can only go UP, never down — ratchet)
            let newTier = state.currentTier;
            for (let i = ladder.length - 1; i >= 0; i--) {
              if (profit >= ladder[i].profitThreshold && i > newTier) {
                newTier = i;
                break;
              }
            }
            if (newTier !== state.currentTier) {
              state.tierHistory.push({
                t: Date.now(), fromTier: state.currentTier, toTier: newTier, equity, profit,
              });
              logEvent('tier-advance', { from: state.currentTier, to: newTier, equity, profit, account: acctKey });
              state.currentTier = newTier;
            }
          }

          // Save per-account state
          accountTiers[acctKey] = state;
          await chrome.storage.local.set({ accountTiers, tierState: state });

          // Effective tier for enforcement (practice = T0 unless testing)
          const effectiveTier = (isPractice && !st.practiceTierTesting) ? 0 : state.currentTier;

          // Broadcast tier to platform tabs
          const effState = { ...state, currentTier: effectiveTier };
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (!tab.url) continue;
            if (/topstepx\.com|wealthcharts\.com|projectx\.com/.test(tab.url)) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'tier-changed',
                ladder, state: effState, enabled: st.tierLockEnabled !== false,
              }).catch(() => {});
            }
          }

          sendResponse({
            ok: true,
            tier: effectiveTier,
            tierLabel: ladder[effectiveTier]?.label,
            profit,
            nextThreshold: ladder[effectiveTier + 1]?.profitThreshold || null,
            isPractice,
            account: acctKey,
          });
          break;
        }
        case 'check-order-size': {
          // Content script asks: "can I place N contracts of INSTRUMENT?"
          // Priority: daily locked limits > per-account tier > global tier
          const { instrument, qty } = msg;
          const inst = (instrument || '').toUpperCase();
          const st2 = await chrome.storage.local.get([
            'dailyConfig', 'tierLadder', 'tierState', 'tierLockEnabled',
            'activeAccount', 'accountTiers', 'practiceTierTesting'
          ]);
          const dc = st2.dailyConfig || DEFAULT_DAILY_CONFIG;
          const today = todayET();

          // Use daily limits if locked today, otherwise fall back to tier ladder
          let effectiveLimits = null;
          if (dc.date === today && dc.lockedAt && !dc.unlockedAt) {
            effectiveLimits = dc.limits;
          } else if (st2.tierLockEnabled !== false) {
            const ladder = st2.tierLadder || DEFAULT_TIER_LADDER;
            // Use per-account tier state if available
            const activeAcct = st2.activeAccount;
            const acctKey = activeAcct ? activeAcct.label : '__default__';
            const accountState = (st2.accountTiers && st2.accountTiers[acctKey]) || st2.tierState || DEFAULT_TIER_STATE;
            // Practice guard: force T0
            const isPractice = activeAcct && activeAcct.isPractice;
            const effectiveTier = (isPractice && !st2.practiceTierTesting) ? 0 : accountState.currentTier;
            effectiveLimits = ladder[effectiveTier];
          }

          if (!effectiveLimits) {
            sendResponse({ ok: true, allowed: true });
            break;
          }

          // Check allowed instruments
          if (effectiveLimits.allowedInstruments && !effectiveLimits.allowedInstruments.includes(inst)) {
            sendResponse({
              ok: true, allowed: false,
              reason: `${inst} is not in today's allowed instruments. Allowed: ${effectiveLimits.allowedInstruments.join(', ')}`,
            });
            logEvent('daily-block-instrument', { instrument: inst });
            break;
          }
          // Check max quantity
          const maxKey2 = 'max' + inst;
          const maxQty2 = effectiveLimits[maxKey2] !== undefined ? effectiveLimits[maxKey2] : 0;
          if (qty > maxQty2) {
            sendResponse({
              ok: true, allowed: false,
              reason: `Max ${maxQty2} ${inst} today. Requested: ${qty}.`,
            });
            logEvent('daily-block-qty', { instrument: inst, qty, max: maxQty2 });
            break;
          }
          sendResponse({ ok: true, allowed: true });
          break;
        }

        /* ═══ Daily limit lock messages (v0.3) ═══ */
        case 'get-daily-config': {
          const st = await chrome.storage.local.get(['dailyConfig']);
          const dc = st.dailyConfig || { ...DEFAULT_DAILY_CONFIG, date: todayET() };
          const et = getET();
          sendResponse({
            ok: true,
            config: dc,
            timeInfo: {
              currentET: `${String(et.hr).padStart(2,'0')}:${String(et.mn).padStart(2,'0')}`,
              isLocked: dc.date === todayET() && dc.lockedAt !== null && dc.unlockedAt === null,
              isReviewWindow: isReviewWindow(et),
              isDeleteWindow: isDeleteWindow(et),
              isTradingHours: isTradingHours(et),
              todayET: todayET(),
            }
          });
          break;
        }
        case 'set-daily-limits': {
          // Set today's limits — only allowed if NOT currently locked
          const et = getET();
          const today = todayET();
          const st = await chrome.storage.local.get(['dailyConfig']);
          const dc = st.dailyConfig || { ...DEFAULT_DAILY_CONFIG };

          // If locked today and not in review window, reject
          if (dc.date === today && dc.lockedAt && !dc.unlockedAt && !isReviewWindow(et)) {
            sendResponse({ ok: false, error: 'Limits are locked until 4:00 PM ET. No changes allowed.' });
            logEvent('daily-set-rejected', { reason: 'locked' });
            break;
          }

          const newConfig = {
            date: today,
            limits: msg.limits,
            lockedAt: null,    // not locked yet — user must explicitly lock
            unlockedAt: null,
            accountId: msg.accountId || dc.accountId || null,
          };
          await chrome.storage.local.set({ dailyConfig: newConfig });
          logEvent('daily-limits-set', { limits: msg.limits });
          sendResponse({ ok: true, config: newConfig });
          break;
        }
        case 'lock-daily-limits': {
          // Lock today's limits — irreversible until 4pm ET
          const today = todayET();
          const st = await chrome.storage.local.get(['dailyConfig']);
          const dc = st.dailyConfig || { ...DEFAULT_DAILY_CONFIG };

          if (dc.date !== today || !dc.limits) {
            sendResponse({ ok: false, error: 'Set limits first before locking.' });
            break;
          }
          if (dc.lockedAt && !dc.unlockedAt) {
            sendResponse({ ok: false, error: 'Already locked.' });
            break;
          }

          dc.lockedAt = Date.now();
          dc.unlockedAt = null;
          dc.date = today;
          await chrome.storage.local.set({ dailyConfig: dc });
          logEvent('daily-locked', { limits: dc.limits, accountId: dc.accountId });

          // Broadcast to platform tabs
          const tabs3 = await chrome.tabs.query({});
          for (const tab of tabs3) {
            if (!tab.url) continue;
            if (/topstepx\.com|wealthcharts\.com|projectx\.com/.test(tab.url)) {
              chrome.tabs.sendMessage(tab.id, { type: 'daily-lock-changed', config: dc }).catch(() => {});
            }
          }
          sendResponse({ ok: true, config: dc });
          break;
        }
        case 'reset-baseline': {
          // Reset baseline equity for a new account
          const st = await chrome.storage.local.get(['tierState', 'dailyConfig']);
          const state = st.tierState || { ...DEFAULT_TIER_STATE };
          const prevTier = state.currentTier;
          // Keep history for audit (capture BEFORE reset)
          state.tierHistory.push({ t: Date.now(), fromTier: prevTier, toTier: 0, equity: null, reason: 'account-reset' });
          state.baselineEquity = null;
          state.currentEquity = null;
          state.currentTier = 0;
          state.lastEquityUpdate = 0;
          await chrome.storage.local.set({ tierState: state });

          // Update accountId in daily config
          if (msg.accountId) {
            const dc = st.dailyConfig || { ...DEFAULT_DAILY_CONFIG };
            dc.accountId = msg.accountId;
            await chrome.storage.local.set({ dailyConfig: dc });
          }

          logEvent('baseline-reset', { accountId: msg.accountId || 'manual' });
          sendResponse({ ok: true });
          break;
        }
        case 'set-practice-tier-testing': {
          await chrome.storage.local.set({ practiceTierTesting: !!msg.enabled });
          logEvent('practice-tier-testing', { enabled: !!msg.enabled });
          sendResponse({ ok: true });
          break;
        }
        case 'get-practice-tier-testing': {
          const st = await chrome.storage.local.get(['practiceTierTesting']);
          sendResponse({ ok: true, enabled: !!st.practiceTierTesting });
          break;
        }
        /* ═══ PDLL messages (v0.5) ═══ */
        case 'get-pdll-config': {
          const st = await chrome.storage.local.get(['pdllConfig']);
          const pc = st.pdllConfig || { ...DEFAULT_PDLL_CONFIG, date: todayET() };
          const et = getET();
          // Check if soft cooldown has expired — persist the change
          if (pc.softBreached && pc.softCooldownEnds && Date.now() >= pc.softCooldownEnds && !pc.hardBreached) {
            pc.softCooldownEnds = null; // cooldown expired, trading resumes
            await chrome.storage.local.set({ pdllConfig: pc });
          }
          sendResponse({
            ok: true,
            config: pc,
            timeInfo: {
              currentET: `${String(et.hr).padStart(2,'0')}:${String(et.mn).padStart(2,'0')}`,
              isLocked: pc.date === todayET() && pc.lockedAt !== null && pc.unlockedAt === null,
              softCooldownActive: pc.softBreached && pc.softCooldownEnds && Date.now() < pc.softCooldownEnds,
              softCooldownRemaining: pc.softCooldownEnds ? Math.max(0, pc.softCooldownEnds - Date.now()) : 0,
            }
          });
          break;
        }
        case 'set-pdll-limits': {
          const et = getET();
          const today = todayET();
          const st = await chrome.storage.local.get(['pdllConfig']);
          const pc = st.pdllConfig || { ...DEFAULT_PDLL_CONFIG };

          // If locked today and not in review window, reject
          if (pc.date === today && pc.lockedAt && !pc.unlockedAt && !isReviewWindow(et)) {
            sendResponse({ ok: false, error: 'PDLL limits are locked until 4:00 PM ET.' });
            break;
          }

          const newConfig = {
            ...DEFAULT_PDLL_CONFIG,
            date: today,
            softLimit: msg.softLimit || 500,
            hardLimit: msg.hardLimit || 1500,
            lockedAt: null,
            unlockedAt: null,
            accountId: msg.accountId || pc.accountId || null,
          };
          await chrome.storage.local.set({ pdllConfig: newConfig });
          logEvent('pdll-limits-set', { soft: newConfig.softLimit, hard: newConfig.hardLimit });
          sendResponse({ ok: true, config: newConfig });
          break;
        }
        case 'lock-pdll-limits': {
          const today = todayET();
          const st = await chrome.storage.local.get(['pdllConfig']);
          const pc = st.pdllConfig || { ...DEFAULT_PDLL_CONFIG };

          if (pc.date !== today || !pc.softLimit || !pc.hardLimit) {
            sendResponse({ ok: false, error: 'Set PDLL limits first before locking.' });
            break;
          }
          if (pc.lockedAt && !pc.unlockedAt) {
            sendResponse({ ok: false, error: 'Already locked.' });
            break;
          }

          pc.lockedAt = Date.now();
          pc.unlockedAt = null;
          pc.date = today;
          await chrome.storage.local.set({ pdllConfig: pc });
          logEvent('pdll-locked', { soft: pc.softLimit, hard: pc.hardLimit, accountId: pc.accountId });
          sendResponse({ ok: true, config: pc });
          break;
        }
        case 'adjust-pdll-hard': {
          // Post-soft-breach: user may adjust hard PDLL ONCE
          const st = await chrome.storage.local.get(['pdllConfig']);
          const pc = st.pdllConfig || DEFAULT_PDLL_CONFIG;

          if (!pc.softBreached) {
            sendResponse({ ok: false, error: 'Can only adjust hard PDLL after a soft breach.' });
            break;
          }
          if (pc.adjustCount >= 1) {
            sendResponse({ ok: false, error: 'Already used your one post-soft adjustment.' });
            break;
          }
          if (pc.hardBreached) {
            sendResponse({ ok: false, error: 'Hard breach already triggered. No adjustments allowed.' });
            break;
          }

          const newHard = msg.newHardLimit;
          if (typeof newHard !== 'number' || newHard <= 0) {
            sendResponse({ ok: false, error: 'Invalid hard limit value.' });
            break;
          }

          pc.hardLimit = newHard;
          pc.adjustCount = 1;
          await chrome.storage.local.set({ pdllConfig: pc });
          logEvent('pdll-hard-adjusted', { newHard, adjustCount: 1 });
          sendResponse({ ok: true, config: pc });
          break;
        }
        case 'rpnl-update': {
          // Content script reports realized P&L from TopstepX header
          const rpnl = msg.rpnl;
          if (typeof rpnl !== 'number' || isNaN(rpnl)) {
            sendResponse({ ok: false, error: 'invalid rpnl' });
            break;
          }
          const st = await chrome.storage.local.get(['pdllConfig', 'lockoutState']);
          const pc = st.pdllConfig || DEFAULT_PDLL_CONFIG;
          const today = todayET();

          // Only enforce if PDLL is locked for today
          if (pc.date !== today || !pc.lockedAt || pc.unlockedAt) {
            pc.lastRPnL = rpnl;
            pc.lastRPnLUpdate = Date.now();
            await chrome.storage.local.set({ pdllConfig: pc });
            sendResponse({ ok: true, enforced: false });
            break;
          }

          pc.lastRPnL = rpnl;
          pc.lastRPnLUpdate = Date.now();

          let lockoutChanged = false;
          const curLockout = st.lockoutState || DEFAULT_LOCKOUT;

          // Check HARD breach first (takes priority)
          if (!pc.hardBreached && rpnl <= -pc.hardLimit) {
            pc.hardBreached = true;
            pc.hardBreachAt = Date.now();
            logEvent('pdll-hard-breach', { rpnl, hardLimit: pc.hardLimit });

            // Session-end lockout — block everything until next day
            const hardLockout = {
              ...DEFAULT_LOCKOUT,
              kind: 'pdll-hard',
              reason: `PDLL hard breach: $${Math.abs(rpnl).toFixed(0)} loss exceeds $${pc.hardLimit} limit. Session over.`,
              startedAt: Date.now(),
              blockMarketOrders: true,
              blockNewEntries: true,
              allowExits: true,
              allowSlTighten: true,
            };
            await chrome.storage.local.set({ lockoutState: hardLockout });
            lockoutChanged = true;
          }
          // Check SOFT breach (only if hard not triggered)
          else if (!pc.softBreached && !pc.hardBreached && rpnl <= -pc.softLimit) {
            pc.softBreached = true;
            pc.softBreachAt = Date.now();
            pc.softCooldownEnds = Date.now() + PDLL_COOLDOWN_MS;
            logEvent('pdll-soft-breach', { rpnl, softLimit: pc.softLimit, cooldownEnds: pc.softCooldownEnds });

            // 30-min hard lockout
            const softLockout = {
              ...DEFAULT_LOCKOUT,
              kind: 'pdll-soft',
              reason: `PDLL soft breach: $${Math.abs(rpnl).toFixed(0)} loss. 30-min mandatory pause.`,
              startedAt: Date.now(),
              expiresAt: pc.softCooldownEnds,
              blockMarketOrders: true,
              blockNewEntries: true,
              allowExits: true,
              allowSlTighten: true,
            };
            await chrome.storage.local.set({ lockoutState: softLockout });
            lockoutChanged = true;
          }
          // Check if soft cooldown has expired — clear lockout if it was pdll-soft
          else if (pc.softBreached && pc.softCooldownEnds && Date.now() >= pc.softCooldownEnds
                   && !pc.hardBreached && curLockout.kind === 'pdll-soft') {
            await chrome.storage.local.set({ lockoutState: DEFAULT_LOCKOUT });
            lockoutChanged = true;
            logEvent('pdll-soft-cooldown-expired', {});
          }

          await chrome.storage.local.set({ pdllConfig: pc });

          // Broadcast lockout change to platform tabs
          if (lockoutChanged) {
            const newLockout = (await chrome.storage.local.get(['lockoutState'])).lockoutState;
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
              if (!tab.url) continue;
              if (/topstepx\.com|wealthcharts\.com|projectx\.com/.test(tab.url)) {
                chrome.tabs.sendMessage(tab.id, { type: 'lockout-changed', lockout: newLockout }).catch(() => {});
              }
            }
          }

          sendResponse({ ok: true, enforced: true, softBreached: pc.softBreached, hardBreached: pc.hardBreached });
          break;
        }

        case 'watchdog-ping': {
          // Cadence content script pings to confirm extension is alive
          await chrome.storage.local.set({ extensionPresence: { lastPing: Date.now() } });
          const et = getET();
          sendResponse({
            ok: true,
            isDeleteWindow: isDeleteWindow(et),
            isTradingHours: isTradingHours(et),
          });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      console.error('[Cadence Control] router error', e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async response
});

/* Opening-range lockout automation — checks every minute, sets lockout
 * during 9:30-9:45 AM ET.
 * This is independent of Cadence heartbeat: opening-range restriction
 * applies to market orders regardless of HR state. */
async function checkOpeningRange() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now);
  const get = n => { const p = parts.find(x => x.type === n); return p ? p.value : ''; };
  const wd = get('weekday');
  const hr = parseInt(get('hour')) || 0;
  const mn = parseInt(get('minute')) || 0;
  const isWeekday = ['Mon','Tue','Wed','Thu','Fri'].includes(wd);
  const tMin = hr * 60 + mn;
  const inOpeningRange = isWeekday && tMin >= (9*60 + 30) && tMin < (9*60 + 45);

  const st = await chrome.storage.local.get(['lockoutState']);
  const cur = st.lockoutState || DEFAULT_LOCKOUT;

  if (inOpeningRange && cur.kind !== 'opening-range') {
    const next = {
      ...DEFAULT_LOCKOUT,
      kind: 'opening-range',
      reason: 'Opening range (9:30–9:45 ET) — limit orders only.',
      startedAt: Date.now(),
      expiresAt: null,
      blockMarketOrders: true,
      blockNewEntries: false,
      allowExits: true,
      allowSlTighten: true,
    };
    await chrome.storage.local.set({ lockoutState: next });
    logEvent('opening-range-enter', {});
  } else if (!inOpeningRange && cur.kind === 'opening-range') {
    await chrome.storage.local.set({ lockoutState: DEFAULT_LOCKOUT });
    logEvent('opening-range-exit', {});
  }
}

/* ═══ Auto-unlock daily limits at 4pm ET ═══ */
async function checkDailyUnlock() {
  const et = getET();
  const today = todayET();
  const st = await chrome.storage.local.get(['dailyConfig']);
  const dc = st.dailyConfig || DEFAULT_DAILY_CONFIG;

  // If today's limits are locked and we've hit 4pm, auto-unlock
  if (dc.date === today && dc.lockedAt && !dc.unlockedAt && isReviewWindow(et)) {
    dc.unlockedAt = Date.now();
    await chrome.storage.local.set({ dailyConfig: dc });
    logEvent('daily-auto-unlock', { time: `${et.hr}:${et.mn}` });

    // Broadcast
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url) continue;
      if (/topstepx\.com|wealthcharts\.com|projectx\.com/.test(tab.url)) {
        chrome.tabs.sendMessage(tab.id, { type: 'daily-lock-changed', config: dc }).catch(() => {});
      }
    }
  }

  // Also auto-unlock PDLL at 4pm ET
  const pdll = await chrome.storage.local.get(['pdllConfig']);
  const pc = pdll.pdllConfig || DEFAULT_PDLL_CONFIG;
  if (pc.date === today && pc.lockedAt && !pc.unlockedAt && isReviewWindow(et)) {
    pc.unlockedAt = Date.now();
    await chrome.storage.local.set({ pdllConfig: pc });
    logEvent('pdll-auto-unlock', { time: `${et.hr}:${et.mn}` });
    // If the current lockout is pdll-based, clear it
    const lockSt = await chrome.storage.local.get(['lockoutState']);
    const lo = lockSt.lockoutState || DEFAULT_LOCKOUT;
    if (lo.kind === 'pdll-soft' || lo.kind === 'pdll-hard') {
      await chrome.storage.local.set({ lockoutState: DEFAULT_LOCKOUT });
      logEvent('pdll-lockout-cleared-at-unlock', {});
    }
  }
}

/* ═══ Extension presence heartbeat ═══ */
async function updatePresence() {
  await chrome.storage.local.set({ extensionPresence: { lastPing: Date.now() } });
}

/* Set up alarms */
chrome.alarms.create('opening-range-check', { periodInMinutes: 1 });
chrome.alarms.create('daily-unlock-check', { periodInMinutes: 1 });
chrome.alarms.create('presence-heartbeat', { periodInMinutes: 0.5 }); // every 30s
chrome.alarms.create('pdll-cooldown-check', { periodInMinutes: 0.5 }); // every 30s
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'opening-range-check') checkOpeningRange();
  if (alarm.name === 'daily-unlock-check') checkDailyUnlock();
  if (alarm.name === 'presence-heartbeat') updatePresence();
  if (alarm.name === 'pdll-cooldown-check') checkPdllCooldown();
});

/* ═══ PDLL soft cooldown expiry check ═══ */
async function checkPdllCooldown() {
  const st = await chrome.storage.local.get(['pdllConfig', 'lockoutState']);
  const pc = st.pdllConfig || DEFAULT_PDLL_CONFIG;
  const lo = st.lockoutState || DEFAULT_LOCKOUT;

  // If soft cooldown has expired, clear the pdll-soft lockout
  if (pc.softBreached && pc.softCooldownEnds && Date.now() >= pc.softCooldownEnds
      && !pc.hardBreached && lo.kind === 'pdll-soft') {
    pc.softCooldownEnds = null;
    await chrome.storage.local.set({ pdllConfig: pc, lockoutState: DEFAULT_LOCKOUT });
    logEvent('pdll-soft-cooldown-expired-alarm', {});

    // Broadcast lockout clear to platform tabs
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url) continue;
      if (/topstepx\.com|wealthcharts\.com|projectx\.com/.test(tab.url)) {
        chrome.tabs.sendMessage(tab.id, { type: 'lockout-changed', lockout: DEFAULT_LOCKOUT }).catch(() => {});
      }
    }
  }
}
