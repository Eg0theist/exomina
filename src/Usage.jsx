import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { shownUsageProviders } from './usage-visibility.js';
import useDismiss from './useDismiss.js';
import { ExternalLink, Gauge, RefreshCw, X } from 'lucide-react';
import { percentageText, usageStale, USAGE_WARNING_PERCENT, usageWarnings } from '../desktop/usage.mjs';
import './usage.css';

const NAMES = { claude: 'Claude', codex: 'ChatGPT', 'muse-code': 'Muse Code' };
function resetLabel(value) {
  const ms = Date.parse(value || '') - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'reset';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.round(minutes / 6) / 10;
  if (hours < 24) return `resets in ${hours < 10 ? hours.toFixed(1).replace(/\.0$/, '') : Math.round(hours)} h`;
  return `resets ${new Date(value).toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}
const dateTime = value => new Date(value).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function creditTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : NaN;
  const result = Number.isFinite(numeric) ? numeric < 1e12 ? numeric * 1000 : numeric : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}
const creditDateTime = value => new Date(creditTime(value)).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
function untilLabel(value, now) {
  const remaining = creditTime(value) - now;
  if (remaining <= 0) return 'expired';
  const minutes = Math.max(1, Math.ceil(remaining / 60000));
  if (minutes < 60) return `${minutes} min remaining`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return `${hours} h${rest ? ` ${rest} min` : ''} remaining`;
  const days = Math.floor(hours / 24), remainingHours = hours % 24;
  return `${days} day${days === 1 ? '' : 's'}${remainingHours ? ` ${remainingHours} h` : ''} remaining`;
}
function creditUsable(item, now) {
  if (item?.usable !== true || item.status !== 'available' || item.resetType !== 'codexRateLimits' || typeof item.id !== 'string' || !item.id || item.expiryKnown !== true) return false;
  return item.expiresAt === null || creditTime(item.expiresAt) !== null && creditTime(item.expiresAt) > now;
}
function creditAvailability(item, now) {
  if (item.status === 'redeemed') return 'Used';
  if (item.status === 'redeeming') return 'Being redeemed';
  if (item.status !== 'available') return 'Availability unknown';
  if (item.resetType !== 'codexRateLimits') return 'Unavailable for Codex usage';
  if (item.expiryKnown !== true || item.expiresAt !== null && creditTime(item.expiresAt) === null) return 'Expiry unavailable';
  if (item.expiresAt !== null && creditTime(item.expiresAt) <= now) return 'Expired';
  return creditUsable(item, now) ? 'Available' : item.unavailableReason || 'Unavailable';
}
function readableError(error) { return (error?.message || 'The request could not be confirmed.').replace(/^Error invoking remote method ['"]studio:invoke['"]: (?:Error: )?/, ''); }
function useResetAction(onReset) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function reset(creditId) {
    if (!onReset) return;
    setBusy(true); setMessage('');
    try {
      const result = await onReset('codex', creditId);
      const refresh = result?.usageRefreshed === false ? ' Usage refresh failed; refresh to see the latest figures.' : ' Usage has been refreshed.';
      setMessage({ reset: 'Reset applied.' + refresh, alreadyRedeemed: 'This reset was already applied.' + refresh, nothingToReset: 'No current usage window is eligible for a reset.', noCredit: 'No usable reset credits are available.', cancelled: 'Reset cancelled.' }[result?.outcome] || 'The reset outcome was not confirmed. Refresh usage before trying again.');
    } catch (error) { setMessage(readableError(error)); }
    finally { setBusy(false); }
  }
  return { busy, message, reset };
}

/** The same explicit credit choice is offered in the sidebar and Settings. */
function ResetCredits({ entry, now, onReset, resetPending = false, busy = false, onDetails }) {
  const radioName = useId();
  const [selectedId, setSelectedId] = useState(''), [selectionNotice, setSelectionNotice] = useState('');
  const credits = entry.resetCredits;
  const detailed = Array.isArray(credits?.credits);
  const rows = (detailed ? credits.credits : []).filter(item => item && typeof item === 'object').map((item, index) => ({ ...item, originalIndex: index }));
  rows.sort((a, b) => Number(creditUsable(b, now)) - Number(creditUsable(a, now)) || (creditUsable(a, now) && creditUsable(b, now) ? (creditTime(a.expiresAt) ?? Infinity) - (creditTime(b.expiresAt) ?? Infinity) : 0) || a.originalIndex - b.originalIndex);
  const usable = rows.filter(item => creditUsable(item, now));
  const earliest = usable.find(item => item.expiresAt !== null);
  const partial = credits?.detailsPartial === true || credits?.detailsComplete === false || detailed && rows.length < (credits.availableCount || 0);
  const selected = rows.find(item => item.id === selectedId);
  const stale = usageStale(entry, now);
  useEffect(() => { if (!selectedId && usable.length) setSelectedId(usable[0].id); }, [selectedId, usable[0]?.id]);
  function useSelected() {
    if (!creditUsable(selected, Date.now())) { setSelectionNotice('This credit is no longer available. Refresh or choose another credit.'); return; }
    setSelectionNotice(''); onReset?.(selected.id);
  }
  return <div className="usage-credits usage-reset">
    <h4>Reset credits</h4>
    {credits ? <p>Provider reports {credits.availableCount} available reset credit{credits.availableCount === 1 ? '' : 's'}.</p> : <p>The account has not reported reset credits.</p>}
    {!detailed && <p>Credit details are unavailable. Refresh to choose a specific reset.</p>}
    {partial && <p className="usage-credit-detail-notice">Credit details are partial. Showing {rows.length} listed credit{rows.length === 1 ? '' : 's'}; Refresh may retrieve more.</p>}
    {earliest && <p className="usage-credit-earliest">Earliest {partial ? 'listed ' : ''}expiry: {creditDateTime(earliest.expiresAt)} <span>({untilLabel(earliest.expiresAt, now)})</span>.</p>}
    {rows.length > 0 && <ul className="usage-credit-list">{rows.map(item => {
      const available = creditUsable(item, now);
      const title = item.title || `Reset credit ${item.originalIndex + 1}`;
      return <li key={item.id || `unidentified-${item.originalIndex}`} data-credit-id={item.id || ''} className={`${available ? 'is-available' : 'is-unavailable'}${!resetPending && selectedId === item.id ? ' is-selected' : ''}${available && item.expiresAt !== null && creditTime(item.expiresAt) - now < 3 * 86400000 ? ' is-soon' : ''}`}>
        <label className="usage-credit-choice">
          <input type="radio" name={radioName} value={item.id || ''} aria-label={`Select ${title}`} checked={!resetPending && !!item.id && selectedId === item.id} disabled={!available || busy || resetPending || stale} onChange={() => { setSelectedId(item.id); setSelectionNotice(''); }} />
          <span><strong>{title}</strong>{item.description && <small>{item.description}</small>}<small className="usage-credit-status">{creditAvailability(item, now)}{earliest?.id === item.id ? partial ? ' · Earliest listed expiry' : ' · Expires first' : ''}</small>
            <span className="usage-credit-expiry">{item.expiryKnown !== true || item.expiresAt !== null && creditTime(item.expiresAt) === null ? 'Expiry not reported' : item.expiresAt === null ? 'No expiry' : <>Expires {creditDateTime(item.expiresAt)} <em>({untilLabel(item.expiresAt, now)})</em></>}</span>
          </span>
        </label>
      </li>;
    })}</ul>}
    {resetPending ? <>
      <p>The previous reset result is uncertain. Checking it retries the same saved credit. Choosing another credit is locked until the result is known.</p>
      {onReset && <button type="button" className="secondary-button small" disabled={busy} onClick={() => onReset()}>{busy ? 'Checking…' : 'Check previous reset…'}</button>}
    </> : <>
      {stale && (credits?.availableCount > 0 || rows.length > 0) && <p>Refresh usage before using a reset credit.</p>}
      {usable.length > 0 && onReset && <div className="usage-credit-action"><span>{selected && creditUsable(selected, now) ? `Selected: ${selected.title || 'Reset credit'}` : 'Choose an available reset credit.'}</span><button type="button" className="secondary-button small" disabled={busy || stale || !creditUsable(selected, now) || !credits?.availableCount} onClick={useSelected}>{busy ? 'Checking…' : 'Use selected reset…'}</button></div>}
      {!usable.length && credits?.availableCount > 0 && !detailed && onReset && <>
        <p>The provider can choose a credit when its details are unavailable.</p>
        <button type="button" className="secondary-button small" disabled={busy || stale} onClick={() => onReset()}>{busy ? 'Checking…' : 'Use provider-selected reset…'}</button>
      </>}
      {detailed && !usable.length && (rows.length > 0 || credits?.availableCount > 0) && <p>{rows.length ? 'No listed credit is currently usable for Codex usage.' : 'The provider listed no credit details. Refresh to try again.'}</p>}
    </>}
    {selectionNotice && <p className="usage-error" role="status">{selectionNotice}</p>}
    {onDetails && <button type="button" className="text-button usage-inline-link" onClick={onDetails}>All credit details</button>}
    {onReset && <small>Manual only. Requires your confirmation.</small>}
  </div>;
}
/** One line for the sidebar; the full chooser opens on demand and stays open while a reset is uncertain. */
function CreditSummary({ entry, now, resetPending, children }) {
  const credits = entry.resetCredits, rows = Array.isArray(credits?.credits) ? credits.credits : [];
  const usable = rows.filter(item => creditUsable(item, now)), count = credits?.availableCount ?? usable.length;
  const first = usable.filter(item => item.expiresAt !== null).sort((a, b) => creditTime(a.expiresAt) - creditTime(b.expiresAt))[0];
  const soon = first && creditTime(first.expiresAt) - now < 3 * 86400000;
  const label = resetPending ? 'Previous reset needs checking' : `${count} reset credit${count === 1 ? '' : 's'}${first ? ` · first expires in ${untilLabel(first.expiresAt, now).replace(/ remaining$/, '')}` : ''}`;
  if (!resetPending && !count) return null;
  return <details className={`usage-credits-compact${soon ? ' is-soon' : ''}`} open={resetPending || undefined}><summary>{label}</summary>{children}</details>;
}
const level = used => used >= USAGE_WARNING_PERCENT ? 'high' : used >= 70 ? 'mid' : 'low';

function Bar({ item, compact = false }) {
  return <div className={`usage-window level-${level(item.usedPercent)}`}>
    <div className="usage-window-head"><span>{item.label}</span><strong>{percentageText(100 - item.usedPercent)} left</strong></div>
    <div className="usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.usedPercent} aria-label={`${item.label}: ${percentageText(item.usedPercent)} used`}><span style={{ width: `${Math.min(100, item.usedPercent)}%` }} /></div>
    {item.resetsAt && <small>{compact ? resetLabel(item.resetsAt) : `${percentageText(item.usedPercent)} used · ${resetLabel(item.resetsAt)}`}</small>}
  </div>;
}

function updatedText(entries) {
  if (entries.some(entry => entry.fetchStatus === 'refreshing')) return 'Refreshing…';
  const times = entries.map(entry => Date.parse(entry.updatedAt || '')).filter(Number.isFinite);
  return times.length ? `Updated ${new Date(Math.min(...times)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'Usage';
}

/** Sidebar: remaining usage per subscription, most constrained window first. */
export function UsageSidebar({ usage = {}, connections = [], onRefresh, onReset, onManage, onDetails, resetPending = false }) {
  const [open, setOpen] = useState(false);
  const [popupHeight, setPopupHeight] = useState(null);
  const area = useRef(null), resultArea = useRef(null), close = useCallback(() => setOpen(false), []);
  const { busy: resetBusy, message: resetMessage, reset } = useResetAction(onReset);
  const [refreshBusy, setRefreshBusy] = useState(false), [refreshError, setRefreshError] = useState('');
  useDismiss(area, open, close);
  useEffect(() => {
    if (!open) return undefined;
    const measure = () => { const top = area.current?.getBoundingClientRect().top; if (Number.isFinite(top)) setPopupHeight(Math.max(40, Math.floor(top - 14))); };
    measure(); window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure); if (area.current) observer.observe(area.current);
    return () => { window.removeEventListener('resize', measure); observer.disconnect(); };
  }, [open]);
  useEffect(() => { if (open && resetMessage) resultArea.current?.scrollIntoView({ block: 'nearest' }); }, [open, resetMessage]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const ids = shownUsageProviders(connections, usage, NAMES);
  const entries = ids.map(provider => ({ ...(usage[provider] || { provider, windows: [] }), windows: (usage[provider]?.windows || []).filter(item => !item.resetsAt || Date.parse(item.resetsAt) > now) }));
  async function refresh() {
    setRefreshBusy(true); setRefreshError('');
    try { await onRefresh?.(); } catch (error) { setRefreshError(readableError(error)); }
    finally { setRefreshBusy(false); }
  }
  useEffect(() => { if (open) refresh(); }, [open]);
  if (!entries.length) return null;
  const tightest = entries.map(entry => ({ entry, item: [...entry.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0] }));
  return <div className={`usage-sidebar ${open ? 'open' : ''}`} ref={area}>
    <button type="button" className="usage-summary" onClick={() => setOpen(!open)} aria-expanded={open} title="Subscription usage">
      <Gauge size={14} />{tightest.map(({ entry, item }) => <span key={entry.provider} className={`usage-chip ${usageStale(entry, now) ? 'is-stale' : ''} level-${item ? level(item.usedPercent) : 'unknown'}`}>{NAMES[entry.provider] || entry.provider} <b>{entry.ordinaryUsageAllowed === false ? 'usage exhausted' : item ? `${percentageText(100 - item.usedPercent)} left${usageStale(entry, now) ? ' · stale' : ''}` : entry.fetchStatus === 'error' ? 'unavailable' : 'refreshing…'}</b></span>)}
    </button>
    {open && <div className="usage-details" role="dialog" aria-label="Subscription usage" style={popupHeight === null ? undefined : { maxHeight: `min(70vh, ${popupHeight}px)` }}>
      <div className="usage-refresh-row"><span title="Refreshes every minute">{updatedText(entries)}</span>{onDetails && <button type="button" onClick={() => { close(); onDetails(); }}>Details</button>}<button type="button" aria-label="Refresh usage" title="Refresh usage" disabled={refreshBusy || entries.some(entry => entry.fetchStatus === 'refreshing')} onClick={refresh}><RefreshCw size={12} className={refreshBusy ? 'spin' : ''} /></button></div>
      {entries.map(entry => <section key={entry.provider} className={usageStale(entry, now) ? 'is-stale' : ''}>
        <h3>{NAMES[entry.provider] || entry.provider}{entry.plan ? <small>{entry.plan}</small> : null}{usageStale(entry, now) && <small className="usage-stale-tag">stale</small>}{onManage && <button type="button" className="usage-manage-icon" aria-label={`View ${NAMES[entry.provider] || entry.provider} usage and offers`} title="Provider usage & offers" onClick={() => { close(); onManage(entry.provider); }}><ExternalLink size={12} /></button>}</h3>
        {entry.windows.map(item => <Bar key={item.id} item={item} compact />)}
        {entry.ordinaryUsageAllowed === false && <p className="usage-error">The provider reports that included usage is exhausted. Any separate model allowance is shown by the provider.</p>}
        {entry.fetchStatus === 'error' && <p className="usage-error" role="status">Refresh failed. {entry.error} {entry.windows.length ? 'These are the last reported figures.' : ''}</p>}
        {!entry.windows.length && entry.fetchStatus !== 'error' && <p>Fetching current subscription limits…</p>}
        {entry.overage && <p>Using extra usage.</p>}
        {entry.extraUsage?.enabled && <p>Extra usage enabled{entry.extraUsage.usedCredits !== null ? ` · ${new Intl.NumberFormat(undefined, { style: 'currency', currency: entry.extraUsage.currency }).format(entry.extraUsage.usedCredits / 100)} spent` : ''}.</p>}
        {entry.provider === 'muse-code' && <p>Muse reports these figures after a request. Last reported {entry.updatedAt ? dateTime(entry.updatedAt) : 'not yet'}. Refresh reads the current Muse runtime; it never sends a prompt.</p>}
        {entry.provider === 'codex' && (entry.resetCredits || resetPending) && <CreditSummary entry={entry} now={now} resetPending={resetPending}><ResetCredits entry={entry} now={now} onReset={onReset ? reset : null} resetPending={resetPending} busy={resetBusy || refreshBusy} onDetails={onDetails ? () => { close(); onDetails(); } : null} /></CreditSummary>}
      </section>)}
      {resetMessage && <p className="usage-reset-result" role="status" ref={resultArea}>{resetMessage}</p>}
      {refreshError && <p className="usage-error" role="status">{refreshError}</p>}
    </div>}
  </div>;
}

const dismissKey = (provider, item) => `${provider}:${item.id}:${item.resetsAt || ''}`;
function dismissedSet() { try { return new Set(JSON.parse(localStorage.getItem('exomina.usageDismissed') || '[]')); } catch { return new Set(); } }

/** In-chat warning once a window passes 90%, until dismissed or reset. */
export function UsageBanner({ provider, usage = {}, onSwitch }) {
  const [dismissed, setDismissed] = useState(dismissedSet);
  const warnings = usageWarnings(usage[provider]).filter(item => !dismissed.has(dismissKey(provider, item)));
  if (!warnings.length) return null;
  const worst = [...warnings].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const out = worst.usedPercent >= 100;
  function dismiss() {
    const next = new Set([...dismissed, ...warnings.map(item => dismissKey(provider, item))]);
    setDismissed(next); try { localStorage.setItem('exomina.usageDismissed', JSON.stringify([...next].slice(-100))); } catch { /* storage unavailable */ }
  }
  return <div className={`usage-banner ${out ? 'is-out' : ''}`} role="status">
    <Gauge size={16} />
    <div><strong>{out ? `${NAMES[provider] || 'This subscription'} has reached its ${worst.label.toLowerCase()} limit` : `${Math.round(worst.usedPercent)}% of your ${NAMES[provider] || ''} ${worst.label.toLowerCase()} is used`}</strong>
      <p>{worst.resetsAt ? `It ${resetLabel(worst.resetsAt)}. ` : ''}You can keep going right here: switch to another AI or model in the message box, and this chat continues with its context.</p></div>
    {onSwitch && <button type="button" className="secondary-button small" onClick={onSwitch}>Switch AI</button>}
    <button type="button" className="icon-button" aria-label="Dismiss usage warning" onClick={dismiss}><X size={15} /></button>
  </div>;
}

/** Settings: full usage view, including when each reset credit expires. Reads
 * credit details on open and on Refresh; background polls only fetch the count. */
export function UsageSettings({ usage = {}, connections = [], onRefresh, onManage, onReset, resetPending = false }) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [refreshError, setRefreshError] = useState('');
  const { busy: resetBusy, message: resetMessage, reset } = useResetAction(onReset);
  const refresh = useCallback(async () => { setBusy(true); setRefreshError(''); try { await onRefresh?.(); } catch (error) { setRefreshError(readableError(error)); } finally { setBusy(false); setNow(Date.now()); } }, [onRefresh]);
  useEffect(() => { refresh(); }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const ids = shownUsageProviders(connections, usage, NAMES);
  return <section className="settings-section usage-settings" id="settings-usage">
    <div className="section-title"><h2>Usage &amp; resets</h2><button type="button" className="text-button" disabled={busy} onClick={refresh} aria-label="Refresh usage"><RefreshCw size={14} className={busy ? 'spin' : ''} />Refresh</button></div>
    {!ids.length && <p className="cloud-description">Connect a supported subscription to see its usage here.</p>}
    {ids.map(provider => {
      const entry = usage[provider] || { provider, windows: [] };
      const windows = (entry.windows || []).filter(item => !item.resetsAt || Date.parse(item.resetsAt) > now);
      return <div key={provider} className="settings-row usage-settings-provider">
        <div className="usage-settings-head"><strong>{NAMES[provider]}{entry.plan ? <small>{entry.plan}</small> : null}</strong>{onManage && <button type="button" className="text-button" onClick={() => onManage(provider)}><ExternalLink size={13} />Provider usage &amp; offers</button>}</div>
        {windows.map(item => <div key={item.id} className="usage-settings-window"><Bar item={item} />{item.resetsAt && <small>Resets {dateTime(item.resetsAt)}</small>}</div>)}
        {!windows.length && <p>{entry.fetchStatus === 'error' ? `Usage unavailable. ${entry.error || ''}` : 'No current usage figures.'}</p>}
        {provider === 'codex' && <ResetCredits entry={entry} now={now} onReset={onReset ? reset : null} resetPending={resetPending} busy={resetBusy || busy} />}
        {provider === 'muse-code' && <p>These are the last percentages reported by Muse, updated after requests. Older figures are marked stale. Refresh never sends a prompt.</p>}
        {provider === 'claude' && <p>Claude subscriptions do not report reset credits.</p>}
      </div>;
    })}
    {refreshError && <p className="usage-error" role="status">{refreshError}</p>}
    {resetMessage && <p className="usage-reset-result" role="status">{resetMessage}</p>}
  </section>;
}
